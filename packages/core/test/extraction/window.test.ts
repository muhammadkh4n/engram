import { describe, it, expect } from 'vitest'

import {
  buildWindow,
  extractionMaxTokens,
  renderUserMessage,
  type RawExtractionWindow,
  type RawWindowSubject,
} from '../../src/extraction/window.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const PROMPT_WINDOW: RawExtractionWindow = {
  anchor: {
    id: uuid(11),
    kind: 'user_prompt',
    session_id: 'tst-session-1',
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    content: 'Keep the capture route on Postgres.\nNo SQLite fallback.',
    occurred_at: '2026-10-01T09:00:05Z',
    source: { type: 'transcript', event_key: 'tst-key-11' },
  },
  anchor_event: { payload: { text: 'ignored' }, plan_dirs: ['Active/tst-plan', 'Active/tst-other'] },
  turn: {
    id: uuid(10),
    kind: 'assistant_turn',
    session_id: 'tst-session-1',
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    content: 'The capture route writes to Postgres through PostgREST. Should it keep a SQLite fallback?',
    occurred_at: '2026-10-01T09:00:00.000Z',
    source: {
      type: 'transcript',
      event_key: 'tst-key-10',
      tools: [
        { name: 'Read', ref: 'packages/mcp/src/capture-route.ts' },
        { name: 'Bash', ref: null },
      ],
    },
  },
  observed: false,
  subjects: [
    { id: uuid(21), label: 'capture route', project_id: 'tst-repo', last_used_at: '2026-09-01T00:00:00Z' },
    { id: uuid(22), label: 'deploy steps', project_id: null, last_used_at: '2026-09-30T00:00:00Z' },
    { id: uuid(23), label: 'ci', project_id: 'tst-repo', last_used_at: null },
  ],
  statements: [
    {
      id: uuid(31),
      kind: 'ruling',
      subject_id: uuid(21),
      content: 'No ORM in the capture route.',
      occurred_at: '2026-09-20T10:00:00Z',
    },
    {
      id: uuid(32),
      kind: 'fact',
      subject_id: uuid(22),
      subject_label: 'deploy steps',
      content: 'Deploys run by hand\non the server.',
      occurred_at: '2026-09-25T10:00:00Z',
    },
  ],
  observations: [
    {
      id: uuid(41),
      kind: 'finding',
      subject_id: uuid(99),
      content: 'The capture route answers 413 above the body limit.',
      occurred_at: '2026-09-28T08:00:00Z',
    },
  ],
  projects: [{ id: 'tst-repo', kind: 'project' }],
}

const PROMPT_MESSAGE = [
  'PROJECT: tst-repo',
  'WORKSPACE: tst-ws',
  'PLAN: tst-plan',
  '',
  'SUBJECTS:',
  'subj-1 capture route',
  'subj-2 deploy steps',
  'subj-3 ci',
  '',
  'CURRENT STATEMENTS:',
  'stmt-1 [fact, deploy steps, 2026-09-25] Deploys run by hand on the server.',
  'stmt-2 [ruling, capture route, 2026-09-20] No ORM in the capture route.',
  '',
  'CURRENT OBSERVATIONS:',
  'obs-1 [finding, none, 2026-09-28] The capture route answers 413 above the body limit.',
  '',
  'turn-1 (ASSISTANT, 2026-10-01T09:00:00.000Z):',
  'The capture route writes to Postgres through PostgREST. Should it keep a SQLite fallback?',
  '',
  'TOOLS OF turn-1:',
  '- Read: packages/mcp/src/capture-route.ts',
  '- Bash',
  '',
  'utt-1 (MK, 2026-10-01T09:00:05.000Z):',
  'Keep the capture route on Postgres.',
  'No SQLite fallback.',
].join('\n')

const Q1 = 'Which store backs capture?'
const Q2 = 'Run the backfill now?'

const DIALOG_WINDOW: RawExtractionWindow = {
  anchor: {
    id: uuid(12),
    kind: 'user_answer',
    session_id: 'tst-session-2',
    project_id: null,
    workspace_id: 'tst-ws',
    content: 'Postgres only\nNo SQLite anywhere.\n\nLater\n\nShip it.',
    context: `[Store] ${Q1}\n- Postgres only: One store, no fallback\n- Postgres and SQLite\n\n${Q2}\n- Yes\n- Later: After the deploy`,
    occurred_at: '2026-10-02T12:30:00Z',
    source: { type: 'transcript', event_key: 'tst-key-12' },
  },
  anchor_event: {
    payload: {
      questions: [
        {
          question: Q1,
          header: 'Store',
          options: [
            { label: 'Postgres only', description: 'One store, no fallback' },
            { label: 'Postgres and SQLite', description: '' },
          ],
          multiSelect: false,
        },
        {
          question: Q2,
          header: '',
          options: [{ label: 'Yes' }, { label: 'Later', description: 'After the deploy' }],
          multiSelect: false,
        },
      ],
      answers: { [Q1]: 'Postgres only', [Q2]: 'Later' },
      notes: { [Q1]: 'No SQLite anywhere.' },
      response: 'Ship it.',
    },
    plan_dirs: [],
  },
  // A dialog carries its own question: the assistant turn before it is not shown.
  turn: {
    id: uuid(9),
    kind: 'assistant_turn',
    session_id: 'tst-session-2',
    project_id: null,
    workspace_id: 'tst-ws',
    content: 'Asking two questions.',
    occurred_at: '2026-10-02T12:29:00Z',
  },
  observed: false,
  subjects: [],
  statements: [],
  observations: [],
  projects: [],
}

const DIALOG_MESSAGE = [
  'PROJECT: none',
  'WORKSPACE: tst-ws',
  'PLAN: none',
  '',
  'SUBJECTS:',
  'none',
  '',
  'CURRENT STATEMENTS:',
  'none',
  '',
  'CURRENT OBSERVATIONS:',
  'none',
  '',
  'turn-1:',
  'none',
  '',
  'TOOLS OF turn-1:',
  'none',
  '',
  'utt-1 (MK, 2026-10-02T12:30:00.000Z):',
  `QUESTION q-1: ${Q1}`,
  'OPTION: Postgres only — One store, no fallback',
  'OPTION: Postgres and SQLite',
  'ANSWER: Postgres only',
  'NOTES: No SQLite anywhere.',
  '',
  `QUESTION q-2: ${Q2}`,
  'OPTION: Yes',
  'OPTION: Later — After the deploy',
  'ANSWER: Later',
  '',
  'RESPONSE: Ship it.',
].join('\n')

const TRAILING_WINDOW: RawExtractionWindow = {
  anchor: {
    id: uuid(13),
    kind: 'assistant_turn',
    session_id: 'tst-session-3',
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    content: 'Merged the fix in commit abc1234 on tst-repo.',
    occurred_at: '2026-10-03T18:00:00Z',
    source: { type: 'transcript', event_key: 'tst-key-13', tools: [{ name: 'Bash', ref: 'abc1234' }] },
  },
  anchor_event: { payload: { text: 'ignored' }, plan_dirs: ['Active/tst-plan/'] },
  turn: null,
  observed: false,
  subjects: [{ id: uuid(24), label: 'merge flow', project_id: 'tst-repo', last_used_at: '2026-10-01T00:00:00Z' }],
  statements: [],
  observations: [],
  projects: [{ id: 'tst-repo', kind: 'project' }],
}

const TRAILING_MESSAGE = [
  'PROJECT: tst-repo',
  'WORKSPACE: tst-ws',
  'PLAN: tst-plan',
  '',
  'SUBJECTS:',
  'subj-1 merge flow',
  '',
  'CURRENT STATEMENTS:',
  'none',
  '',
  'CURRENT OBSERVATIONS:',
  'none',
  '',
  'turn-1 (ASSISTANT, 2026-10-03T18:00:00.000Z):',
  'Merged the fix in commit abc1234 on tst-repo.',
  '',
  'TOOLS OF turn-1:',
  '- Bash: abc1234',
  '',
  'utt-1:',
  'none',
].join('\n')

const OBSERVED_WINDOW: RawExtractionWindow = {
  anchor: {
    id: uuid(15),
    kind: 'user_prompt',
    session_id: 'tst-session-4',
    project_id: 'tst-repo',
    workspace_id: null,
    content: 'thanks, next',
    occurred_at: '2026-10-04T08:01:00Z',
  },
  anchor_event: null,
  turn: {
    id: uuid(14),
    kind: 'assistant_turn',
    session_id: 'tst-session-4',
    project_id: 'tst-repo',
    workspace_id: null,
    content: 'Done.',
    occurred_at: '2026-10-04T08:00:00Z',
    source: { type: 'transcript', tools: [] },
  },
  observed: true,
}

const OBSERVED_MESSAGE = [
  'PROJECT: tst-repo',
  'WORKSPACE: none',
  'PLAN: none',
  '',
  'SUBJECTS:',
  'none',
  '',
  'CURRENT STATEMENTS:',
  'none',
  '',
  'CURRENT OBSERVATIONS:',
  'none',
  '',
  'turn-1 (ASSISTANT, 2026-10-04T08:00:00.000Z): (already observed)',
  'Done.',
  '',
  'TOOLS OF turn-1:',
  'none',
  '',
  'utt-1 (MK, 2026-10-04T08:01:00.000Z):',
  'thanks, next',
].join('\n')

describe('renderUserMessage', () => {
  it.each([
    ['a prompt', PROMPT_WINDOW, PROMPT_MESSAGE],
    ['a dialog with notes', DIALOG_WINDOW, DIALOG_MESSAGE],
    ['a trailing turn', TRAILING_WINDOW, TRAILING_MESSAGE],
    ['a window whose turn is already observed', OBSERVED_WINDOW, OBSERVED_MESSAGE],
  ])('renders %s byte for byte', (_label, raw, expected) => {
    expect(renderUserMessage(buildWindow(raw))).toBe(expected)
  })

  it('renders the same message for the same input every time', () => {
    expect(renderUserMessage(buildWindow(PROMPT_WINDOW))).toBe(renderUserMessage(buildWindow(PROMPT_WINDOW)))
  })
})

describe('buildWindow', () => {
  it('maps a prompt anchor to utt-1 and the turn before it to turn-1', () => {
    const w = buildWindow(PROMPT_WINDOW)

    expect(w.anchorKind).toBe('user_prompt')
    expect(w.utterance).toMatchObject({ alias: 'utt-1', id: uuid(11), eventKey: 'tst-key-11', dialog: null })
    expect(w.turn).toMatchObject({ alias: 'turn-1', id: uuid(10), alreadyObserved: false })
    expect(w.turn!.tools).toEqual([
      { name: 'Read', ref: 'packages/mcp/src/capture-route.ts' },
      { name: 'Bash', ref: null },
    ])
    expect(w.planSlug).toBe('tst-plan')
    expect(w.statements.map((s) => [s.alias, s.id, s.subjectLabel])).toEqual([
      ['stmt-1', uuid(32), 'deploy steps'],
      ['stmt-2', uuid(31), 'capture route'],
    ])
  })

  it('gives a dialog answer no turn and aliases its questions in order', () => {
    const w = buildWindow(DIALOG_WINDOW)

    expect(w.turn).toBeNull()
    expect(w.utterance!.content).toBe('Postgres only\nNo SQLite anywhere.\n\nLater\n\nShip it.')
    expect(w.utterance!.dialog!.questions.map((q) => [q.alias, q.question, q.notes])).toEqual([
      ['q-1', Q1, 'No SQLite anywhere.'],
      ['q-2', Q2, null],
    ])
  })

  it('makes a trailing anchor its own turn-1 with no utt-1', () => {
    const w = buildWindow(TRAILING_WINDOW)

    expect(w.anchorKind).toBe('trailing')
    expect(w.utterance).toBeNull()
    expect(w.turn).toMatchObject({ id: uuid(13), eventKey: 'tst-key-13' })
  })

  it('refuses an anchor that is not an utterance', () => {
    const raw = { ...PROMPT_WINDOW, anchor: { ...PROMPT_WINDOW.anchor, kind: 'commit' } } as unknown as RawExtractionWindow

    expect(() => buildWindow(raw)).toThrow(/not an utterance/)
  })
})

describe('subject listing order', () => {
  const withSubjects = (subjects: RawWindowSubject[]): RawExtractionWindow => ({ ...PROMPT_WINDOW, subjects })
  const labels = (raw: RawExtractionWindow): string[] => buildWindow(raw).subjects.map((s) => s.label)

  it('puts a label sharing a word with the window ahead of a more recent one', () => {
    const raw = withSubjects([
      { id: uuid(51), label: 'release notes', last_used_at: '2026-10-01T00:00:00Z' },
      { id: uuid(52), label: 'sqlite removal', last_used_at: '2026-01-01T00:00:00Z' },
    ])

    expect(labels(raw)).toEqual(['sqlite removal', 'release notes'])
  })

  it('ignores shared words shorter than four letters', () => {
    const raw = withSubjects([
      { id: uuid(51), label: 'the orm', last_used_at: '2026-01-01T00:00:00Z' },
      { id: uuid(52), label: 'release notes', last_used_at: '2026-10-01T00:00:00Z' },
    ])

    expect(labels(raw)).toEqual(['release notes', 'the orm'])
  })

  it('breaks ties by label', () => {
    const at = '2026-09-01T00:00:00Z'
    const raw = withSubjects([
      { id: uuid(51), label: 'route timeouts', last_used_at: at },
      { id: uuid(52), label: 'beta flags', last_used_at: at },
      { id: uuid(53), label: 'capture limits', last_used_at: at },
      { id: uuid(54), label: 'alpha flags', last_used_at: at },
    ])

    expect(labels(raw)).toEqual(['capture limits', 'route timeouts', 'alpha flags', 'beta flags'])
  })

  it('lists at most 150 subjects', () => {
    const many = Array.from({ length: 160 }, (_, i) => ({
      id: uuid(1000 + i),
      label: `label ${String(i).padStart(3, '0')}`,
      last_used_at: null,
    }))

    const subjects = buildWindow(withSubjects(many)).subjects
    expect(subjects).toHaveLength(150)
    expect(subjects[149]).toMatchObject({ alias: 'subj-150', label: 'label 149' })
  })
})

describe('listings and text limits', () => {
  it('lists the 40 most recent items, each cut at 500 characters', () => {
    const items = Array.from({ length: 45 }, (_, i) => ({
      id: uuid(2000 + i),
      kind: 'fact',
      subject_id: null,
      content: 'z'.repeat(600),
      occurred_at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    }))

    const w = buildWindow({ ...PROMPT_WINDOW, statements: items })
    expect(w.statements).toHaveLength(40)
    expect(w.statements[0]!.id).toBe(uuid(2044))
    expect(w.statements[0]!.content).toBe('z'.repeat(500))
  })

  it('shows the last 24,000 characters of a 30,000-character turn after the marker', () => {
    const content = 'w'.repeat(6000) + 'y'.repeat(24_000)
    const raw = { ...PROMPT_WINDOW, turn: { ...PROMPT_WINDOW.turn!, content } }

    const message = renderUserMessage(buildWindow(raw))
    expect(message).toContain(
      `turn-1 (ASSISTANT, 2026-10-01T09:00:00.000Z):\n[earlier text not shown]\n${'y'.repeat(24_000)}\n\nTOOLS OF turn-1:`,
    )
    expect(message).not.toContain('ww')
    expect(buildWindow(raw).turn!.content).toBe(content)
  })

  it('shows a turn of exactly 24,000 characters whole', () => {
    const content = 'y'.repeat(24_000)
    const raw = { ...PROMPT_WINDOW, turn: { ...PROMPT_WINDOW.turn!, content } }

    expect(renderUserMessage(buildWindow(raw))).not.toContain('[earlier text not shown]')
  })

  it('never cuts the MK utterance', () => {
    const content = 'm'.repeat(30_000)
    const raw = { ...PROMPT_WINDOW, anchor: { ...PROMPT_WINDOW.anchor, content } }

    expect(renderUserMessage(buildWindow(raw)).endsWith(`\n${content}`)).toBe(true)
  })
})

describe('extractionMaxTokens', () => {
  it.each([
    [0, 800],
    [1, 920],
    [1000, 920],
    [1001, 1040],
    [43_000, 5960],
    [44_000, 6000],
    [200_000, 6000],
  ])('caps a reply to a %i-character message at %i tokens', (chars, expected) => {
    expect(extractionMaxTokens('a'.repeat(chars))).toBe(expected)
  })
})
