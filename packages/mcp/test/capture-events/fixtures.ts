/**
 * One valid capture event per type, with invented ids. Each call returns a
 * fresh object, so a test may modify its copy freely.
 */

import type { CaptureEventType } from '@engram-mem/core'

export const RECEIVED_AT = new Date('2026-10-05T12:00:00Z')
export const OCCURRED_AT = '2026-10-05T11:30:00Z'
export const OCCURRED_AT_MS = Date.parse(OCCURRED_AT)

export const SAMPLE_ITEM_ID = '00000000-0000-4000-8000-0000000000a1'
export const SAMPLE_LEGACY_ITEM_ID = '00000000-0000-4000-8000-0000000000b2'
export const SAMPLE_SHA = '0123456789abcdef0123456789abcdef01234567'

export type FixtureEvent = Record<string, unknown> & { payload: Record<string, unknown> }

const PAYLOADS: { [T in CaptureEventType]: () => Record<string, unknown> } = {
  user_prompt: () => ({ text: 'move the ingest worker to a systemd timer', transcript_line: 12 }),
  user_answer: () => ({
    questions: [
      {
        question: 'Which store should the worker read?',
        header: 'Store',
        options: [
          { label: 'Postgres', description: 'the item store' },
          { label: 'Files', description: '' },
        ],
        multiSelect: false,
      },
    ],
    answers: { 'Which store should the worker read?': 'Postgres' },
    notes: { 'Which store should the worker read?': 'keep the old table frozen' },
    response: 'and log every skipped row',
    transcript_line: 40,
  }),
  assistant_turn: () => ({
    text: 'The worker now runs from a systemd timer.',
    transcript_line: 41,
    tools: [
      { name: 'Edit', ref: 'src/worker.ts' },
      { name: 'Bash', ref: null },
    ],
  }),
  session_start: () => ({ reason: 'startup' }),
  session_end: () => ({ reason: 'exit' }),
  pre_compact: () => ({}),
  git_commit: () => ({
    repo: 'sample-repo',
    sha: SAMPLE_SHA,
    message: 'feat: run the ingest worker from a timer',
    files: ['src/worker.ts', 'deploy/worker.timer'],
    authored_at: '2026-10-05T13:29:00+02:00',
  }),
  ledger_decision: () => ({
    plan: 'sample-plan',
    id: 'TST-DEC',
    class: 'A',
    trigger: 'any worker schedule change',
    ruling: 'The worker runs from a systemd timer.',
    by: 'mk',
    quote: 'use a timer, not cron',
    source: 'session 2026-10-04',
    said_as: 'words',
    question: null,
  }),
  ledger_ruling: () => ({
    plan: 'sample-plan',
    phase: '7',
    task: '7.3',
    ruling: 'Batches of 32 rows.',
    why: 'one embedding call per batch',
  }),
  briefing_shown: () => ({ item_ids: [SAMPLE_ITEM_ID], channel: 'prompt', prompt_event_uuid: 'evt-prompt-1' }),
  register_entry: () => ({
    id: 'R-TST-1',
    status: 'active',
    subject: 'worker schedule',
    said_at: '2026-10-04T09:00:00Z',
    quote: 'use a timer, not cron',
    said_as: 'words',
    question: null,
    verified: 'session transcript',
    applies_to: ['sample-repo'],
    triggers: ['schedule'],
    supersedes: [],
    restated: [],
    scope: 'project:sample-repo',
    file: 'Registers/sample-repo.md',
  }),
  candidate_status: () => ({ item_id: SAMPLE_ITEM_ID, status: 'recorded', register_id: 'R-TST-1' }),
}

export function validEvent<T extends CaptureEventType>(type: T, n = 1): FixtureEvent {
  return {
    session_id: 'sess-a1',
    event_uuid: `evt-${type}-${n}`,
    type,
    occurred_at: OCCURRED_AT,
    cwd: '/home/dev/sample-repo',
    project: { id: 'sample-repo', workspace: 'ws-test', repo_root: '/home/dev/sample-repo', branch: 'main', worktree: null },
    plan_dirs: ['/home/dev/plans/sample-plan'],
    payload: PAYLOADS[type](),
  }
}

export function envelope(events: unknown[]): Record<string, unknown> {
  return { client: { name: 'sample-client', version: '1.0.0' }, events }
}
