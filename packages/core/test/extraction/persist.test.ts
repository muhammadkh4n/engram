import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'

import { gateWindow, type GateResult } from '../../src/extraction/gate.js'
import { buildCommitPayload, extractionEventKey } from '../../src/extraction/persist.js'
import { EXTRACTOR_VERSION } from '../../src/extraction/prompt.js'
import { parseReply } from '../../src/extraction/reply.js'
import { buildWindow, type ExtractionWindow, type RawExtractionWindow } from '../../src/extraction/window.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RUN = uuid(90)

const QUESTION = 'Should the capture route keep Postgres as its only store?'
const ANSWER = 'Yes, keep Postgres for the capture route. Track it in TST-77.'

const RAW: RawExtractionWindow = {
  anchor: {
    id: uuid(11),
    kind: 'user_prompt',
    session_id: 'tst-session-1',
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    content: ANSWER,
    occurred_at: '2026-10-01T09:00:05Z',
    source: { event_key: 'tst-key-11' },
  },
  anchor_event: { payload: {}, plan_dirs: ['Active/tst-plan'] },
  turn: {
    id: uuid(10),
    kind: 'assistant_turn',
    session_id: 'tst-session-1',
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    content: `The capture route writes to Postgres in packages/core/src/a.ts.\n${QUESTION}`,
    occurred_at: '2026-10-01T09:00:00Z',
    source: { event_key: 'tst-key-10', tools: [{ name: 'Bash', ref: 'abc1234' }] },
  },
  observed: false,
  subjects: [{ id: uuid(21), label: 'capture route', project_id: 'tst-repo', last_used_at: '2026-09-01T00:00:00Z' }],
  statements: [],
  observations: [],
  projects: [{ id: 'tst-repo', kind: 'project' }],
}

function statement(over: Record<string, unknown>): Record<string, unknown> {
  return {
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
    ...over,
  }
}

function observation(over: Record<string, unknown>): Record<string, unknown> {
  return {
    assistant_utterance_id: 'turn-1',
    claim: 'The engram capture route writes to Postgres.',
    kind: 'fact',
    subject: { id: 'subj-1' },
    evidence: [],
    valid_at: null,
    supersedes: [],
    ...over,
  }
}

function gated(window: ExtractionWindow, reply: Record<string, unknown>): GateResult {
  const parsed = parseReply(JSON.stringify(reply))
  if (!parsed.ok) throw new Error(parsed.reason)
  return gateWindow(window, parsed)
}

describe('buildCommitPayload', () => {
  const window = buildWindow(RAW)

  it('maps a standing statement with its question to an mk_statement row', () => {
    const reply = {
      statements: [statement({ quote: 'keep Postgres', question: QUESTION, standing: true, applies_to: ['postgres'] })],
      observations: [],
    }
    const { items } = buildCommitPayload(window, gated(window, reply), RUN)

    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.id).toMatch(UUID_V7)
    expect(item).toMatchObject({
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: 'tst-session-1',
      subjectId: uuid(21),
      subjectKey: null,
      content: 'keep Postgres',
      context: QUESTION,
      searchText: `${QUESTION} — keep Postgres`,
      standing: true,
      registerStatus: 'candidate',
      lineage: [uuid(11)],
    })
    expect(item.occurredAt.toISOString()).toBe('2026-10-01T09:00:05.000Z')
    expect(item.source).toEqual({
      type: 'extraction',
      utterance_id: uuid(11),
      run_id: RUN,
      event_key: extractionEventKey(uuid(11), 'mk_statement', 'keep Postgres'),
      scope: 'project',
      applies_to: ['postgres'],
    })
    expect(item).not.toHaveProperty('contentHash')
    expect(item).not.toHaveProperty('content_hash')
  })

  it('stores a one-off statement without a question as its quote, with no register status', () => {
    const { items } = buildCommitPayload(window, gated(window, { statements: [statement({})], observations: [] }), RUN)
    expect(items[0]).toMatchObject({
      searchText: 'keep Postgres for the capture route',
      context: null,
      standing: false,
      registerStatus: null,
    })
  })

  it('maps an evidenced observation to a trust-2 assistant row under the plan context', () => {
    const reply = {
      statements: [],
      observations: [observation({ evidence: [{ type: 'commit', ref: 'abc1234' }], kind: 'finding' })],
    }
    const { items } = buildCommitPayload(window, gated(window, reply), RUN)
    expect(items[0]).toMatchObject({
      class: 'observation',
      kind: 'finding',
      speaker: 'assistant',
      trust: 2,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: 'tst-plan',
      sessionId: 'tst-session-1',
      content: 'The engram capture route writes to Postgres.',
      context: null,
      searchText: 'capture route: The engram capture route writes to Postgres.',
      standing: null,
      registerStatus: null,
      lineage: [uuid(10)],
    })
    expect(items[0]!.occurredAt.toISOString()).toBe('2026-10-01T09:00:00.000Z')
    expect(items[0]!.source).toEqual({
      type: 'extraction',
      utterance_id: uuid(10),
      run_id: RUN,
      event_key: extractionEventKey(uuid(11), 'observation', 'The engram capture route writes to Postgres.'),
      evidence: [{ type: 'commit', ref: 'abc1234' }],
    })
    expect(items[0]!.entities).toContainEqual({ entity: 'abc1234', entityType: 'sha' })
  })

  it('keys the event on version, anchor, class and the normalized content', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify([EXTRACTOR_VERSION, uuid(11), 'mk_statement', 'keep Postgres']))
      .digest('hex')
    expect(extractionEventKey(uuid(11), 'mk_statement', '  keep  Postgres ')).toBe(`x:${expected}`)
    expect(extractionEventKey(uuid(11), 'observation', 'keep Postgres')).not.toBe(`x:${expected}`)
  })

  it('gives a re-run of the same reply the same event keys and fresh row ids', () => {
    const reply = { statements: [statement({})], observations: [observation({})] }
    const first = buildCommitPayload(window, gated(window, reply), RUN)
    const second = buildCommitPayload(window, gated(window, reply), uuid(91))
    expect(second.items.map((i) => i.source.event_key)).toEqual(first.items.map((i) => i.source.event_key))
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id)
  })

  it('creates one new subject for every item naming the same new label', () => {
    const reply = {
      statements: [statement({ subject: { new: 'Store Choice' } })],
      observations: [observation({ subject: { new: 'store  choice' } })],
    }
    const commit = buildCommitPayload(window, gated(window, reply), RUN)
    expect(commit.subjects).toEqual([{ key: 'new-1', projectId: 'tst-repo', label: 'Store Choice' }])
    expect(commit.items.map((i) => [i.subjectId, i.subjectKey])).toEqual([
      [null, 'new-1'],
      [null, 'new-1'],
    ])
    expect(commit.items[1]!.searchText).toBe('store choice: The engram capture route writes to Postgres.')
  })

  it('tags a statement naming TST-77 with a ticket entity', () => {
    const reply = { statements: [statement({ quote: 'Track it in TST-77.' })], observations: [] }
    const { items } = buildCommitPayload(window, gated(window, reply), RUN)
    expect(items[0]!.entities).toContainEqual({ entity: 'TST-77', entityType: 'ticket' })
  })

  it('replaces text PostgreSQL cannot hold in model-written claims and labels', () => {
    const reply = {
      statements: [],
      observations: [observation({ claim: 'The route drops \u0000 bytes.', subject: { new: 'nul \ud800 bytes' } })],
    }
    const commit = buildCommitPayload(window, gated(window, reply), RUN)
    expect(commit.items[0]!.content).toBe('The route drops � bytes.')
    expect(commit.subjects[0]!.label).toBe('nul � bytes')
  })

  it('counts proposals, stores and rejections per side, never text', () => {
    const reply = {
      statements: [statement({}), statement({ quote: 'words MK never wrote' })],
      observations: [observation({}), observation({ claim: 'MK decided to keep Postgres.' }), { claim: 1 }],
    }
    const { stats } = buildCommitPayload(window, gated(window, reply), RUN)
    expect(stats).toEqual({
      statements: { proposed: 2, stored: 1, rejected: 1 },
      observations: { proposed: 3, stored: 1, rejected: 2, trust2: 0, trust3: 1 },
      rejected: [
        { item: 'statement', index: 1, rule: 'quote_not_found' },
        { item: 'observation', index: 1, rule: 'attributed_to_user' },
        { item: 'observation', index: 2, rule: 'schema' },
      ],
      scope_downgraded: 0,
      valid_at_clamped: 0,
    })
  })
})
