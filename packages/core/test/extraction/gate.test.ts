import { describe, it, expect } from 'vitest'

import { gateWindow, type GateResult } from '../../src/extraction/gate.js'
import { parseReply } from '../../src/extraction/reply.js'
import { buildWindow, type RawExtractionWindow, type RawWindowUtterance } from '../../src/extraction/window.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const QUESTION = 'Which store should the capture route use?'

const TURN: RawWindowUtterance = {
  id: uuid(10),
  kind: 'assistant_turn',
  session_id: 'tst-session-1',
  project_id: 'tst-repo',
  workspace_id: 'tst-ws',
  content: 'The capture route writes to Postgres.\nShould the capture route keep Postgres as its only store?',
  occurred_at: '2026-10-01T09:00:00Z',
  source: {
    event_key: 'tst-key-10',
    tools: [
      { name: 'Bash', ref: 'abc1234' },
      { name: 'Read', ref: '/home/u/engram/packages/core/src/a.ts' },
      { name: 'Bash', ref: 'https://github.com/tst-org/tst-repo/pull/7' },
      { name: 'TodoWrite', ref: null },
    ],
  },
}

const LISTINGS: Pick<RawExtractionWindow, 'subjects' | 'statements' | 'observations'> = {
  subjects: [{ id: uuid(21), label: 'capture route', project_id: 'tst-repo', last_used_at: '2026-09-01T00:00:00Z' }],
  statements: [
    { id: uuid(31), kind: 'ruling', subject_id: uuid(21), content: 'No ORM here.', occurred_at: '2026-09-20T10:00:00Z' },
  ],
  observations: [
    { id: uuid(41), kind: 'fact', subject_id: uuid(21), content: 'Bodies cap at 1 MiB.', occurred_at: '2026-09-21T10:00:00Z' },
  ],
}

const PROMPT: RawExtractionWindow = {
  anchor: {
    id: uuid(11),
    kind: 'user_prompt',
    session_id: 'tst-session-1',
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    content: 'Yes, keep Postgres for the capture route. No SQLite fallback.',
    occurred_at: '2026-10-01T09:00:05Z',
    source: { event_key: 'tst-key-11' },
  },
  anchor_event: { payload: {}, plan_dirs: ['Active/tst-plan'] },
  turns: [TURN],
  ...LISTINGS,
}

const DIALOG: RawExtractionWindow = {
  anchor: {
    id: uuid(12),
    kind: 'user_answer',
    session_id: 'tst-session-1',
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    content: 'Postgres only\nno SQLite anywhere',
    context: `${QUESTION}\n- Postgres only: drop the fallback\n- Keep SQLite: as a fallback`,
    occurred_at: '2026-10-01T09:01:00Z',
    source: { event_key: 'tst-key-12' },
  },
  anchor_event: {
    payload: {
      questions: [
        {
          question: QUESTION,
          header: 'Store',
          options: [
            { label: 'Postgres only', description: 'drop the fallback' },
            { label: 'Keep SQLite', description: 'as a fallback' },
          ],
          multiSelect: false,
        },
      ],
      answers: { [QUESTION]: 'Postgres only' },
      notes: { [QUESTION]: 'no SQLite anywhere' },
    },
    plan_dirs: [],
  },
  ...LISTINGS,
}

const TRAILING: RawExtractionWindow = {
  anchor: TURN,
  anchor_event: { plan_dirs: ['Active/tst-plan'] },
  turns: [TURN],
  ...LISTINGS,
}

const withAnchor = (raw: RawExtractionWindow, anchor: Partial<RawWindowUtterance>): RawExtractionWindow => ({
  ...raw,
  anchor: { ...raw.anchor, ...anchor },
})

const stmt = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  utterance_id: 'utt-1',
  quote: 'keep Postgres for the capture route',
  question: null,
  kind: 'ruling',
  standing: false,
  scope: 'project',
  subject: { id: 'subj-1' },
  applies_to: [],
  supersedes: [],
  restates: [],
  corrects: [],
  ...overrides,
})

const obs = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  assistant_utterance_id: 'turn-1',
  claim: 'The capture route writes to Postgres.',
  kind: 'fact',
  subject: { id: 'subj-1' },
  evidence: [],
  valid_at: null,
  supersedes: [],
  ...overrides,
})

function gate(raw: RawExtractionWindow, statements: unknown[] = [], observations: unknown[] = []): GateResult {
  const parsed = parseReply(JSON.stringify({ statements, observations }))
  if (!parsed.ok) throw new Error(parsed.reason)
  return gateWindow(buildWindow(raw), parsed)
}

const rules = (result: GateResult): string[] => result.rejected.map((r) => `${r.item}:${r.index}:${r.rule}`)

describe('gateWindow: rules', () => {
  it('carries the parser schema rejections and rejects an empty claim as schema', () => {
    const result = gate(PROMPT, [{ quote: 'x' }], [obs({ claim: '  ' })])
    expect(rules(result)).toEqual(['statement:0:schema', 'observation:0:schema'])
  })

  it('rejects the 21st statement and the 21st observation as over_limit', () => {
    const statements = Array.from({ length: 21 }, () => stmt())
    const observations = Array.from({ length: 21 }, (_, i) => obs({ claim: `Claim number ${i + 1} holds.` }))
    const result = gate(PROMPT, statements, observations)
    expect(result.statements).toHaveLength(1)
    expect(result.observations).toHaveLength(20)
    expect(result.rejected.filter((r) => r.rule === 'over_limit')).toEqual([
      { item: 'statement', index: 20, rule: 'over_limit' },
      { item: 'observation', index: 20, rule: 'over_limit' },
    ])
  })

  it('rejects an alias the window did not show as unknown_id', () => {
    const result = gate(
      PROMPT,
      [
        stmt({ utterance_id: 'utt-2' }),
        stmt({ subject: { id: 'subj-9' } }),
        stmt({ supersedes: ['stmt-9'] }),
        stmt({ supersedes: ['obs-1'] }),
        stmt({ restates: ['obs-1'] }),
        stmt({ corrects: ['stmt-2'] }),
      ],
      [obs({ assistant_utterance_id: 'turn-2' }), obs({ supersedes: ['stmt-1'] }), obs({ subject: { id: 'subj-2' } })],
    )
    expect(result.statements).toEqual([])
    expect(result.observations).toEqual([])
    expect(new Set(result.rejected.map((r) => r.rule))).toEqual(new Set(['unknown_id']))
    expect(result.rejected).toHaveLength(9)
  })

  it('rejects an observation of an already observed turn or a window with no turn', () => {
    expect(rules(gate({ ...PROMPT, turns: [{ ...TURN, observed: true }] }, [], [obs()]))).toEqual(['observation:0:unknown_id'])
    expect(rules(gate({ ...PROMPT, turns: [] }, [], [obs()]))).toEqual(['observation:0:unknown_id'])
  })

  it('takes an observation\'s lineage, project and time from the turn it names, and refuses an alias outside the window', () => {
    const earlier = {
      ...TURN,
      id: uuid(9),
      project_id: 'tst-other',
      occurred_at: '2026-10-01T08:58:00Z',
      source: { event_key: 'tst-key-9', tools: [] },
    }
    const raw = { ...PROMPT, turns: [earlier, TURN] }
    const result = gate(raw, [], [
      obs({ assistant_utterance_id: 'turn-1' }),
      obs({ assistant_utterance_id: 'turn-2', claim: 'The capture route caps bodies at 1 MiB.' }),
      obs({ assistant_utterance_id: 'turn-3', claim: 'The capture route has no SQLite fallback.' }),
    ])
    expect(result.observations.map((o) => [o.turnId, o.projectId, o.occurredAt])).toEqual([
      [uuid(9), 'tst-other', '2026-10-01T08:58:00.000Z'],
      [uuid(10), 'tst-repo', '2026-10-01T09:00:00.000Z'],
    ])
    expect(rules(result)).toEqual(['observation:2:unknown_id'])
    expect(rules(gate({ ...raw, turns: [{ ...earlier, observed: true }, TURN] }, [], [obs()]))).toEqual([
      'observation:0:unknown_id',
    ])
  })

  it('rejects any statement in a trailing window, which has no utt-1', () => {
    const result = gate(TRAILING, [stmt({ quote: 'The capture route writes to Postgres.' })], [obs()])
    expect(rules(result)).toEqual(['statement:0:unknown_id'])
    expect(result.observations).toHaveLength(1)
  })

  it('rejects a paraphrase as quote_not_found', () => {
    expect(rules(gate(PROMPT, [stmt({ quote: 'use Postgres for the capture route' })]))).toEqual([
      'statement:0:quote_not_found',
    ])
  })

  it('rejects a question that is not in turn-1, or any question when there is no turn', () => {
    expect(rules(gate(PROMPT, [stmt({ question: 'Should we drop the cache?' })]))).toEqual([
      'statement:0:question_not_found',
    ])
    expect(rules(gate({ ...PROMPT, turns: [] }, [stmt({ question: 'Should the capture route keep Postgres' })]))).toEqual(
      ['statement:0:question_not_found'],
    )
  })

  it('rejects a new subject label shorter than 2 or longer than 80 characters after trimming', () => {
    const result = gate(
      PROMPT,
      [stmt({ subject: { new: '  x  ' } }), stmt({ quote: 'No SQLite fallback', subject: { new: 'a'.repeat(81) } })],
      [obs({ subject: { new: ` ${'b'.repeat(80)} ` } })],
    )
    expect(rules(result)).toEqual(['statement:0:bad_subject', 'statement:1:bad_subject'])
    expect(result.observations[0]!.subject).toEqual({ kind: 'new', label: 'b'.repeat(80), projectId: 'tst-repo' })
  })

  it('rejects a valid_at that is neither null, a date nor ISO 8601 as bad_date', () => {
    const bad = ['2026-13-01', '2026-02-30', 'yesterday', '2026-10-01T25:00', '2026-9-1', '']
    const result = gate(
      PROMPT,
      [],
      bad.map((valid_at, i) => obs({ claim: `Claim ${i} holds.`, valid_at })),
    )
    expect(result.rejected.map((r) => r.rule)).toEqual(bad.map(() => 'bad_date'))
  })

  it('rejects a repeat of an earlier accepted item of the same reply as duplicate', () => {
    const result = gate(
      { ...PROMPT, anchor: { ...PROMPT.anchor, content: 'don\u2019t ship it, I said don\'t ship it' } },
      [stmt({ quote: "don't ship it" }), stmt({ quote: 'don\u2019t  ship it' })],
      [obs(), obs({ claim: 'The capture route writes  to Postgres.' })],
    )
    expect(rules(result)).toEqual(['statement:1:duplicate', 'observation:1:duplicate'])
  })

  it('applies the rules in order: the first failing rule names the rejection', () => {
    const result = gate(PROMPT, [stmt({ subject: { id: 'subj-9' }, quote: 'not said', question: 'not asked' })])
    expect(rules(result)).toEqual(['statement:0:unknown_id'])
  })
})

describe('gateWindow: exact characters', () => {
  it('stores the utterance characters for a quote that differs in apostrophe and spacing', () => {
    const raw = withAnchor(PROMPT, { content: 'don\u2019t  ship it' })
    const [statement] = gate(raw, [stmt({ quote: "don't ship it" })]).statements
    expect(statement!.content).toBe('don\u2019t  ship it')
  })

  it("accepts a quote of a non-NFC utterance and stores the model's string", () => {
    const raw = withAnchor(PROMPT, { content: 'the cafe\u0301 route stays' })
    const result = gate(raw, [stmt({ quote: 'caf\u00e9 route' })])
    expect(result.rejected).toEqual([])
    expect(result.statements[0]!.content).toBe('caf\u00e9 route')
  })

  it('stores a question copied from turn-1 with different spacing with the turn characters', () => {
    const question = 'Should  the capture route keep\nPostgres as its only store?'
    const [statement] = gate(PROMPT, [stmt({ quote: 'Yes', question })]).statements
    expect(statement!.context).toBe('Should the capture route keep Postgres as its only store?')
    expect(statement!.content).toBe('Yes')
  })
})

describe('gateWindow: dialog answers', () => {
  it('refuses a quote taken from the QUESTION line and accepts one from the NOTES', () => {
    const result = gate(DIALOG, [
      stmt({ quote: QUESTION }),
      stmt({ quote: 'no SQLite anywhere', question: QUESTION, kind: 'fact' }),
    ])
    expect(rules(result)).toEqual(['statement:0:quote_not_found'])
    expect(result.statements[0]).toMatchObject({ index: 1, content: 'no SQLite anywhere', context: QUESTION })
  })

  it('takes the question from a dialog question, never from turn-1 text', () => {
    const result = gate(DIALOG, [stmt({ quote: 'Postgres only', question: 'drop the fallback' })])
    expect(rules(result)).toEqual(['statement:0:question_not_found'])
  })
})

describe('gateWindow: attribution', () => {
  it.each([
    'MK decided to keep Postgres',
    'The user wants bullet points',
    'user decided to wait',
    'We decided to drop the cache',
    "We've agreed on one spool.",
    'Per MK, the route stays.',
  ])('rejects "%s" as attributed_to_user', (claim) => {
    expect(rules(gate(PROMPT, [], [obs({ claim })]))).toEqual(['observation:0:attributed_to_user'])
  })

  it.each(['The users table has three columns', 'The capture route refuses bodies over 1 MiB'])(
    'accepts "%s"',
    (claim) => {
      expect(gate(PROMPT, [], [obs({ claim })]).observations).toHaveLength(1)
    },
  )
})

describe('gateWindow: evidence and trust', () => {
  const trustOf = (evidence: unknown[]): number => gate(PROMPT, [], [obs({ evidence })]).observations[0]!.trust

  it('gives trust 2 when every evidence entry matches a ref of the turn tools', () => {
    expect(trustOf([{ type: 'commit', ref: 'abc1234def' }])).toBe(2)
    expect(trustOf([{ type: 'file', ref: 'packages/core/src/a.ts' }])).toBe(2)
    expect(trustOf([{ type: 'pr', ref: 'https://github.com/tst-org/tst-repo/pull/7' }])).toBe(2)
    expect(
      trustOf([
        { type: 'commit', ref: 'ABC1234' },
        { type: 'file', ref: '/home/u/engram/packages/core/src/a.ts' },
      ]),
    ).toBe(2)
  })

  it('gives trust 3 for an unmatched ref, no evidence, a short sha prefix or a partly matched list', () => {
    expect(trustOf([{ type: 'commit', ref: 'fff9999' }])).toBe(3)
    expect(trustOf([])).toBe(3)
    expect(trustOf([{ type: 'commit', ref: 'abc123' }])).toBe(3)
    expect(trustOf([{ type: 'file', ref: 'core/src/a.t' }])).toBe(3)
    expect(trustOf([{ type: 'url', ref: 'https://github.com/tst-org/tst-repo/pull' }])).toBe(3)
    expect(
      trustOf([
        { type: 'commit', ref: 'abc1234' },
        { type: 'file', ref: 'packages/core/src/b.ts' },
      ]),
    ).toBe(3)
  })

  it('keeps the evidence list on the observation', () => {
    const evidence = [{ type: 'commit', ref: 'abc1234def' }]
    expect(gate(PROMPT, [], [obs({ evidence })]).observations[0]!.evidence).toEqual(evidence)
  })
})

describe('gateWindow: subjects', () => {
  it('reuses a listed subject for a new label that matches it ignoring case', () => {
    const [statement] = gate(PROMPT, [stmt({ subject: { new: 'Capture Route' } })]).statements
    expect(statement!.subject).toEqual({ kind: 'listed', id: uuid(21), label: 'capture route' })
  })

  it('reuses a listed subject for a new label that differs only in runs of whitespace', () => {
    const [statement] = gate(PROMPT, [stmt({ subject: { new: '  Capture \t ROUTE ' } })]).statements
    expect(statement!.subject).toEqual({ kind: 'listed', id: uuid(21), label: 'capture route' })
  })

  it('stores a new label with its inner whitespace collapsed and its case kept', () => {
    const [statement] = gate(PROMPT, [stmt({ subject: { new: 'Event   Spool' } })]).statements
    expect(statement!.subject).toEqual({ kind: 'new', label: 'Event Spool', projectId: 'tst-repo' })
  })

  it("asks for a new subject under the item's stored project", () => {
    const result = gate(
      PROMPT,
      [stmt({ subject: { new: ' Spool ' } }), stmt({ quote: 'No SQLite fallback', scope: 'global', subject: { new: 'Store' } })],
    )
    expect(result.statements.map((s) => s.subject)).toEqual([
      { kind: 'new', label: 'Spool', projectId: 'tst-repo' },
      { kind: 'new', label: 'Store', projectId: null },
    ])
  })
})

describe('gateWindow: scope and columns', () => {
  it('stores plan with no plan context as project and counts it', () => {
    const result = gate({ ...PROMPT, anchor_event: { plan_dirs: [] } }, [stmt({ scope: 'plan' })])
    expect(result.statements[0]).toMatchObject({ scope: 'project', scopeDowngraded: true, planSlug: null })
    expect(result.scopeDowngraded).toBe(1)
  })

  it('downgrades project without a project and workspace without a workspace', () => {
    const raw = withAnchor({ ...PROMPT, anchor_event: { plan_dirs: [] } }, { project_id: null, workspace_id: null })
    const result = gate(raw, [stmt({ scope: 'plan' }), stmt({ quote: 'No SQLite fallback', scope: 'workspace' })])
    expect(result.statements.map((s) => s.scope)).toEqual(['global', 'global'])
    expect(result.scopeDowngraded).toBe(2)
  })

  it('sets the columns by stored scope', () => {
    const scopes = ['global', 'workspace', 'project', 'plan', 'session']
    const quotes = ['Yes', 'keep Postgres', 'the capture route', 'No SQLite', 'fallback']
    const result = gate(
      PROMPT,
      scopes.map((scope, i) => stmt({ scope, quote: quotes[i] })),
    )
    expect(result.statements.map((s) => [s.scope, s.projectId, s.workspaceId, s.planSlug])).toEqual([
      ['global', null, null, null],
      ['workspace', null, 'tst-ws', null],
      ['project', 'tst-repo', 'tst-ws', null],
      ['plan', 'tst-repo', 'tst-ws', 'tst-plan'],
      ['session', 'tst-repo', 'tst-ws', 'tst-plan'],
    ])
    expect(result.scopeDowngraded).toBe(0)
  })

  it("gives a statement the utterance's session and time, and an observation the turn's and the plan context", () => {
    const result = gate(PROMPT, [stmt()], [obs()])
    expect(result.statements[0]).toMatchObject({
      utteranceId: uuid(11),
      sessionId: 'tst-session-1',
      occurredAt: '2026-10-01T09:00:05.000Z',
    })
    expect(result.observations[0]).toMatchObject({
      turnId: uuid(10),
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: 'tst-plan',
      sessionId: 'tst-session-1',
      occurredAt: '2026-10-01T09:00:00.000Z',
      validAtClamped: false,
    })
  })
})

describe('gateWindow: valid_at', () => {
  const occurredAt = (valid_at: string): string => gate(PROMPT, [], [obs({ valid_at })]).observations[0]!.occurredAt

  it('reads a date as UTC midnight and a date-time with its offset', () => {
    expect(occurredAt('2026-09-30')).toBe('2026-09-30T00:00:00.000Z')
    expect(occurredAt('2026-09-30T08:00:00+02:00')).toBe('2026-09-30T06:00:00.000Z')
    expect(occurredAt('2026-09-30T08:00:00.5-0130')).toBe('2026-09-30T09:30:00.500Z')
    expect(occurredAt('2026-09-30T08:00')).toBe('2026-09-30T08:00:00.000Z')
  })

  it("clamps a valid_at after the turn to the turn's time and counts it", () => {
    const result = gate(PROMPT, [], [obs({ valid_at: '2026-12-01' })])
    expect(result.observations[0]).toMatchObject({ occurredAt: '2026-10-01T09:00:00.000Z', validAtClamped: true })
    expect(result.validAtClamped).toBe(1)
  })
})

describe('gateWindow: resolved references', () => {
  it('carries supersedes, restates and corrects as listed item ids', () => {
    const result = gate(
      PROMPT,
      [stmt({ kind: 'correction', supersedes: ['stmt-1'], restates: ['stmt-1', 'stmt-1'], corrects: ['obs-1', 'stmt-1'] })],
      [obs({ supersedes: ['obs-1'] })],
    )
    expect(result.statements[0]).toMatchObject({
      supersedes: [uuid(31)],
      restates: [uuid(31)],
      corrects: [uuid(41), uuid(31)],
    })
    expect(result.observations[0]!.supersedes).toEqual([uuid(41)])
  })

  it('accepts a reply with nothing to propose', () => {
    expect(gate(PROMPT)).toEqual({
      statements: [],
      observations: [],
      rejected: [],
      scopeDowngraded: 0,
      validAtClamped: 0,
    })
  })
})

describe('gateWindow: shown items', () => {
  const SHOWN: RawExtractionWindow = {
    ...PROMPT,
    shown: [
      {
        id: uuid(51),
        class: 'observation',
        kind: 'fact',
        subject_id: uuid(22),
        project_id: 'tst-far',
        workspace_id: null,
        content: 'The importer runs nightly.',
        occurred_at: '2026-09-25T10:00:00Z',
      },
    ],
  }

  it('resolves a shown alias in corrects', () => {
    const result = gate(SHOWN, [stmt({ kind: 'correction', corrects: ['shown-1'] })])
    expect(result.statements[0]!.corrects).toEqual([uuid(51)])
  })

  it('refuses a shown alias in supersedes as an unknown id', () => {
    expect(rules(gate(SHOWN, [stmt({ supersedes: ['shown-1'] })]))).toEqual(['statement:0:unknown_id'])
  })
})
