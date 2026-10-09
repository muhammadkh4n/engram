import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCaptureEventsRequest } from '../../src/capture-events/validate.js'
import { captureClientInfo, type EventProject, type TranscriptEvent } from '../../src/capture/events.js'
import { humanPromptText, readTranscriptEvents } from '../../src/capture/transcript-reader.js'
import type { TranscriptCursor } from '../../src/capture/transcript-cursor.js'
import {
  appendEntries,
  askCall,
  askResult,
  assistantText,
  at,
  compactBoundary,
  compactSummary,
  type AskQuestionInput,
  type Entry,
  humanPrompt,
  notification,
  queuedPrompt,
  slashCommand,
  systemEntry,
  TEST_CWD,
  toolResult,
  toolUse,
  turnEnd,
  userEntry,
  uuid,
  writeTranscript,
} from './transcripts.js'

const SESSION = '00000000-0000-4000-8000-000000009000'
const RECEIVED_AT = new Date('2026-10-05T12:00:00Z')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-reader-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function stubProject(cwd: string | null, gitBranch: string | null): EventProject {
  return { id: 'sample-repo', workspace: null, repo_root: cwd, branch: gitBranch || null, worktree: null }
}

/** Every event must pass the route's own validator: a refused event is lost for good. */
function expectAccepted(events: TranscriptEvent[]): void {
  if (events.length === 0) return
  const parsed = parseCaptureEventsRequest({ client: captureClientInfo(), events }, RECEIVED_AT)
  expect(parsed).not.toHaveProperty('error')
  if (!('error' in parsed)) expect(parsed.rejected).toEqual([])
}

async function read(path: string, cursor: TranscriptCursor | null = null, forceClose = false) {
  const result = await readTranscriptEvents(path, cursor, { resolveProject: stubProject, forceClose })
  expectAccepted(result.events)
  return result
}

async function eventsOf(entries: Entry[], forceClose = false): Promise<TranscriptEvent[]> {
  return (await read(writeTranscript(dir, SESSION, entries), null, forceClose)).events
}

function prompts(events: TranscriptEvent[]): unknown[] {
  return events.filter((e) => e.type === 'user_prompt').map((e) => e.payload)
}

describe('prompts', () => {
  it('captures a two-character reply verbatim with its entry fields', async () => {
    const events = await eventsOf([humanPrompt(uuid(1), at(1), 'ok')])
    expect(events).toEqual([
      {
        session_id: SESSION,
        event_uuid: uuid(1),
        type: 'user_prompt',
        occurred_at: at(1),
        cwd: TEST_CWD,
        project: { id: 'sample-repo', workspace: null, repo_root: TEST_CWD, branch: 'main', worktree: null },
        plan_dirs: [],
        payload: { text: 'ok', transcript_line: 1 },
      },
    ])
  })

  it('never trims a prompt and joins its text blocks with a newline', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), '  keep the spaces \n'),
      humanPrompt(uuid(2), at(2), [
        { type: 'text', text: 'first part' },
        { type: 'image', source: { type: 'base64', data: '' } },
        { type: 'text', text: 'second part' },
      ]),
    ])
    expect(prompts(events)).toEqual([
      { text: '  keep the spaces \n', transcript_line: 1 },
      { text: 'first part\nsecond part', transcript_line: 2 },
    ])
  })

  it('captures a prompt queued mid-turn under the attachment entry uuid', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'start the migration'),
      toolUse(uuid(2), at(2), 'toolu_bash', 'Bash', { command: 'ls' }),
      queuedPrompt(uuid(3), at(3), 'also check the index'),
      toolResult(uuid(4), at(4), 'toolu_bash', 'README.md'),
    ])
    expect(events.map((e) => [e.event_uuid, e.type, e.payload])).toEqual([
      [uuid(1), 'user_prompt', { text: 'start the migration', transcript_line: 1 }],
      [uuid(3), 'user_prompt', { text: 'also check the index', transcript_line: 3 }],
    ])
  })

  it('writes a tagged slash command as its name and arguments, and a plain one verbatim', async () => {
    const events = await eventsOf([
      slashCommand(uuid(1), at(1), '/plan-run', 'tst-plan'),
      slashCommand(uuid(2), at(2), '/clear', '  '),
      slashCommand(uuid(3), at(3), '/plan-run', 'tst-plan', { body: 'Expanded command body. '.repeat(2000) }),
      slashCommand(uuid(4), at(4), '/review', 'the diff', { origin: { kind: 'human' } }),
      userEntry(uuid(5), at(5), '/compact keep the open questions'),
      userEntry(uuid(6), at(6), '/compact'),
    ])
    expect(prompts(events).map((p) => (p as { text: string }).text)).toEqual([
      '/plan-run tst-plan',
      '/clear',
      '/plan-run tst-plan',
      '/review the diff',
      '/compact keep the open questions',
      '/compact',
    ])
  })

  it('captures a typed prompt that quotes a command tag whole, and a tagged command only at the start', async () => {
    const quoted =
      'why did the reader drop this line?\n<command-name>/plan-run</command-name>\n<command-args>tst-plan</command-args>'
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), quoted),
      userEntry(uuid(2), at(2), `look at this: ${quoted}`),
      humanPrompt(uuid(3), at(3), '  \n<command-name>/review</command-name>\n<command-args>the diff</command-args>'),
      slashCommand(uuid(4), at(4), '/plan-run', 'tst-plan'),
    ])
    expect(prompts(events).map((p) => (p as { text: string }).text)).toEqual([
      quoted,
      '/review the diff',
      '/plan-run tst-plan',
    ])
  })

  it('keeps a prompt over the route cap whole, since a cut before scrubbing could split a secret', async () => {
    const long = 'a'.repeat(1_000_005)
    const events = await eventsOf([humanPrompt(uuid(1), at(1), long)])
    expect(events[0].payload).toEqual({ text: long, transcript_line: 1 })
  })

  it('yields no event for CLI-written and model-written user entries', async () => {
    const events = await eventsOf([
      notification(uuid(1), at(1), '<task-notification>build finished</task-notification>'),
      queuedPrompt(uuid(2), at(2), 'build finished', { commandMode: 'task-notification', origin: null }),
      queuedPrompt(uuid(3), at(3), 'message from a peer', { isMeta: true, origin: { kind: 'peer' } }),
      userEntry(uuid(4), at(4), '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>', {
        extra: { isMeta: true },
      }),
      userEntry(uuid(5), at(5), '<local-command-stdout>Compacted</local-command-stdout>'),
      humanPrompt(uuid(6), at(6), '<local-command-stdout>done</local-command-stdout>'),
      userEntry(uuid(7), at(7), '<bash-input>git status</bash-input>'),
      humanPrompt(uuid(8), at(8), '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'),
      compactBoundary(uuid(9), at(9)),
      compactSummary(uuid(10), at(10), 'Summary: the user ran <command-name>/plan-run</command-name> earlier.'),
      userEntry(uuid(11), at(11), [{ type: 'text', text: '[Request interrupted by user]' }], {
        extra: { interruptedMessageId: 'msg_interrupted' },
      }),
      humanPrompt(uuid(12), at(12), [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      systemEntry(uuid(13), at(13), 'local_command', { extra: { content: '/model' } }),
    ])
    expect(events).toEqual([])
  })

  it('reads nothing from an SDK-driven session or a sidechain', async () => {
    const sdk = { extra: { entrypoint: 'sdk-cli', promptSource: 'sdk' } }
    expect(
      await eventsOf([
        humanPrompt(uuid(1), at(1), 'scripted prompt', sdk),
        assistantText(uuid(2), at(2), 'scripted answer', sdk),
        turnEnd(uuid(3), at(3), sdk),
      ]),
    ).toEqual([])
    expect(await eventsOf([humanPrompt(uuid(4), at(4), 'subagent prompt', { extra: { isSidechain: true } })])).toEqual([])
  })

  it('humanPromptText applies the prompt rules without the length cap', () => {
    const long = 'd'.repeat(1_000_001)
    expect(humanPromptText(humanPrompt(uuid(1), at(1), long))).toBe(long)
    expect(humanPromptText(slashCommand(uuid(2), at(2), '/plan-run', 'tst-plan'))).toBe('/plan-run tst-plan')
    expect(humanPromptText(queuedPrompt(uuid(3), at(3), [{ type: 'text', text: 'queued' }]))).toBe('queued')
    expect(humanPromptText(humanPrompt(uuid(4), at(4), '   '))).toBeNull()
    expect(humanPromptText(humanPrompt(uuid(5), at(5), 'x', { extra: { promptSource: 'sdk' } }))).toBeNull()
    expect(humanPromptText(notification(uuid(6), at(6), 'done'))).toBeNull()
    expect(humanPromptText(assistantText(uuid(7), at(7), 'hello'))).toBeNull()
  })
})

const SINGLE = [
  {
    question: 'Which store should the worker read?',
    header: 'Store',
    options: [{ label: 'Postgres', description: 'the item store' }, { label: 'Files' }],
  },
]
const MULTI = [
  {
    question: 'Which checks should run?',
    header: 'Checks',
    options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }],
    multiSelect: true,
  },
]
const SINGLE_QUESTIONS = [
  {
    question: 'Which store should the worker read?',
    header: 'Store',
    options: [
      { label: 'Postgres', description: 'the item store' },
      { label: 'Files', description: '' },
    ],
    multiSelect: false,
  },
]

describe('answers', () => {
  async function answerOf(result: Entry, questions = SINGLE, extra: Entry[] = []): Promise<TranscriptEvent[]> {
    return eventsOf([
      humanPrompt(uuid(1), at(1), 'set up the worker'),
      askCall(uuid(2), at(2), 'toolu_ask', questions),
      askResult(uuid(3), at(3), 'toolu_ask', questions, result),
      ...extra,
    ]).then((events) => events.filter((e) => e.type === 'user_answer'))
  }

  it('captures a single-select answer with the questions from the call', async () => {
    const events = await answerOf({ answers: { 'Which store should the worker read?': 'Postgres' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event_uuid: uuid(3), occurred_at: at(3), type: 'user_answer' })
    expect(events[0].payload).toEqual({
      questions: SINGLE_QUESTIONS,
      answers: { 'Which store should the worker read?': 'Postgres' },
      transcript_line: 3,
    })
  })

  it('keeps a multi-select answer comma-joined, with its notes', async () => {
    const events = await answerOf(
      {
        answers: { 'Which checks should run?': 'Lint, Tests' },
        annotations: { 'Which checks should run?': { notes: 'tests first' } },
      },
      MULTI,
    )
    expect(events[0].payload).toMatchObject({
      answers: { 'Which checks should run?': 'Lint, Tests' },
      notes: { 'Which checks should run?': 'tests first' },
    })
    expect((events[0].payload as { questions: { multiSelect: boolean }[] }).questions[0].multiSelect).toBe(true)
  })

  it('keeps a typed response when no option was chosen', async () => {
    const events = await answerOf({ answers: {}, response: 'neither, use the queue table' })
    expect(events[0].payload).toMatchObject({ answers: {}, response: 'neither, use the queue table' })
  })

  it('drops the notes-only answer and keeps the note', async () => {
    const events = await answerOf({
      answers: { 'Which store should the worker read?': '(notes only)' },
      annotations: { 'Which store should the worker read?': { notes: 'ask again after the dump' } },
    })
    expect(events[0].payload).toMatchObject({
      answers: {},
      notes: { 'Which store should the worker read?': 'ask again after the dump' },
    })
  })

  it('emits nothing for a dialog that timed out or that holds no answer', async () => {
    expect(await answerOf({ answers: { 'Which store should the worker read?': 'Postgres' }, afkTimeoutMs: 60_000 })).toEqual([])
    expect(await answerOf({ answers: {} })).toEqual([])
  })

  it('turns the response of an answered dialog with no parsable question into a prompt', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'set up the worker'),
      askResult(uuid(2), at(2), 'toolu_gone', [{ header: 'no question text' } as unknown as AskQuestionInput], {
        answers: {},
        response: 'read from the replica instead',
      }),
    ])
    expect(events.filter((e) => e.type === 'user_answer')).toEqual([])
    expect(prompts(events)).toEqual([
      { text: 'set up the worker', transcript_line: 1 },
      { text: 'read from the replica instead', transcript_line: 2 },
    ])
  })

  it('emits nothing for an answered dialog with no parsable question and a blank response', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'set up the worker'),
      askResult(uuid(2), at(2), 'toolu_gone', [], { answers: {}, response: '  ' }),
    ])
    expect(prompts(events)).toEqual([{ text: 'set up the worker', transcript_line: 1 }])
  })

  it('turns the feedback typed into a rejected dialog into an answer', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'set up the worker'),
      askCall(uuid(2), at(2), 'toolu_ask', SINGLE),
      toolResult(uuid(3), at(3), 'toolu_ask', 'The user does not want to proceed.', {
        isError: true,
        toolUseResult: 'User rejected tool use',
        toolDenialKind: 'user-rejected',
        userFeedback: 'stop asking, use Postgres',
      }),
    ])
    expect(events[1]).toMatchObject({ event_uuid: uuid(3), type: 'user_answer' })
    expect(events[1].payload).toEqual({
      questions: SINGLE_QUESTIONS,
      answers: {},
      response: 'stop asking, use Postgres',
      transcript_line: 3,
    })
  })

  it('turns the feedback typed into any other rejected call into a prompt', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'clean the build'),
      toolUse(uuid(2), at(2), 'toolu_bash', 'Bash', { command: 'rm -rf dist' }),
      toolResult(uuid(3), at(3), 'toolu_bash', 'The user does not want to proceed.', {
        isError: true,
        toolDenialKind: 'user-rejected',
        userFeedback: 'no, keep dist',
      }),
      toolResult(uuid(4), at(4), 'toolu_other', 'rejected', { isError: true, toolDenialKind: 'user-rejected' }),
    ])
    expect(prompts(events)).toEqual([
      { text: 'clean the build', transcript_line: 1 },
      { text: 'no, keep dist', transcript_line: 3 },
    ])
  })
})

describe('turns', () => {
  it('emits the text after the last tool_use, with the commits, PRs and paths of the turn', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'ship it'),
      assistantText(uuid(2), at(2), 'Writing the file.'),
      toolUse(uuid(3), at(3), 'toolu_write', 'Write', { file_path: '/repo/src/a.ts', content: 'x' }),
      toolResult(uuid(4), at(4), 'toolu_write', 'ok'),
      toolUse(uuid(5), at(5), 'toolu_commit', 'Bash', { command: 'git add -A && git commit -m "x"' }),
      toolResult(uuid(6), at(6), 'toolu_commit', '[main abc1234] x\n 1 file changed'),
      toolUse(uuid(7), at(7), 'toolu_pr', 'Bash', { command: 'gh pr create --fill' }),
      toolResult(uuid(8), at(8), 'toolu_pr', [{ type: 'text', text: 'https://github.com/tester/sample-repo/pull/12\n' }]),
      toolUse(uuid(9), at(9), 'toolu_log', 'Bash', { command: 'git log -1' }),
      toolResult(uuid(10), at(10), 'toolu_log', '[main bcd2345] not a commit call'),
      assistantText(uuid(11), at(11), 'Done.'),
      assistantText(uuid(12), at(12), 'The PR is open.'),
      systemEntry(uuid(13), at(13), 'stop_hook_summary'),
      turnEnd(uuid(14), at(14)),
    ])
    const turn = events.find((e) => e.type === 'assistant_turn')
    expect(turn).toMatchObject({ event_uuid: uuid(11), occurred_at: at(11) })
    expect(turn?.payload).toEqual({
      text: 'Done.\n\nThe PR is open.',
      transcript_line: 11,
      tools: [
        { name: 'Bash', ref: 'abc1234' },
        { name: 'Bash', ref: 'https://github.com/tester/sample-repo/pull/12' },
        { name: 'Write', ref: '/repo/src/a.ts' },
      ],
    })
  })

  it('takes the last text block before an interruption marker', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'run the suite'),
      assistantText(uuid(2), at(2), 'Running the suite now.'),
      toolUse(uuid(3), at(3), 'toolu_bash', 'Bash', { command: 'npm test' }),
      toolResult(uuid(4), at(4), 'toolu_bash', 'Interrupted by user', { isError: true }),
      userEntry(uuid(5), at(5), [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      humanPrompt(uuid(6), at(6), 'run only the reader tests'),
    ])
    expect(events.map((e) => [e.type, e.event_uuid])).toEqual([
      ['user_prompt', uuid(1)],
      ['assistant_turn', uuid(2)],
      ['user_prompt', uuid(6)],
    ])
    expect(events[1].payload).toMatchObject({ text: 'Running the suite now.', transcript_line: 2 })
  })

  it('emits nothing for a turn without text, and a blank text block is no text', async () => {
    expect(
      await eventsOf([
        humanPrompt(uuid(1), at(1), 'list files'),
        assistantText(uuid(2), at(2), '\n\n'),
        toolUse(uuid(3), at(3), 'toolu_bash', 'Bash', { command: 'ls' }),
        toolResult(uuid(4), at(4), 'toolu_bash', 'a.ts'),
        turnEnd(uuid(5), at(5)),
      ]).then((events) => events.map((e) => e.type)),
    ).toEqual(['user_prompt'])
  })

  it('keeps a final text over the free-text cap whole for the scrubber to see', async () => {
    const path = writeTranscript(dir, SESSION, [
      humanPrompt(uuid(1), at(1), 'dump it'),
      assistantText(uuid(2), at(2), 'e'.repeat(200_010)),
      turnEnd(uuid(3), at(3)),
    ])
    // Read without the route check: the cap is applied after scrubbing, not here.
    const { events } = await readTranscriptEvents(path, null, { resolveProject: stubProject })
    expect((events[1].payload as { text: string }).text.length).toBe(200_010)
  })

  it('emits a turn open at EOF only once it closes, and never repeats what the open turn emitted', async () => {
    const question = [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }]
    const path = writeTranscript(dir, SESSION, [
      humanPrompt(uuid(1), at(1), 'migrate'),
      askCall(uuid(2), at(2), 'toolu_ask', question),
      askResult(uuid(3), at(3), 'toolu_ask', question, { answers: { 'Proceed?': 'Yes' } }),
      assistantText(uuid(4), at(4), 'Migrated.'),
      systemEntry(uuid(5), at(5), 'stop_hook_summary'),
    ])
    const first = await read(path)
    expect(first.events.map((e) => e.type)).toEqual(['user_prompt', 'user_answer'])
    expect(first.cursor).toMatchObject({ offset: 0, line: 0, open_turn_emitted: [uuid(1), uuid(3)] })

    appendEntries(path, SESSION, [turnEnd(uuid(6), at(6))])
    const second = await read(path, first.cursor)
    expect(second.events.map((e) => [e.type, e.event_uuid])).toEqual([['assistant_turn', uuid(4)]])
    expect(second.cursor).toMatchObject({ line: 6, open_turn_emitted: [], last_uuid: uuid(6) })

    const third = await read(path, second.cursor)
    expect(third.events).toEqual([])
    expect(third.cursor).toEqual(second.cursor)
  })

  it('closes a turn at the next prompt, and at EOF only when asked', async () => {
    const path = writeTranscript(dir, SESSION, [
      humanPrompt(uuid(1), at(1), 'first'),
      assistantText(uuid(2), at(2), 'First answer.'),
      humanPrompt(uuid(3), at(3), 'second'),
      assistantText(uuid(4), at(4), 'Second answer.'),
    ])
    const open = await read(path)
    expect(open.events.map((e) => [e.type, e.event_uuid])).toEqual([
      ['user_prompt', uuid(1)],
      ['assistant_turn', uuid(2)],
      ['user_prompt', uuid(3)],
    ])
    expect(open.cursor).toMatchObject({ line: 2, open_turn_emitted: [uuid(3)] })

    const closed = await read(path, open.cursor, true)
    expect(closed.events.map((e) => [e.type, e.event_uuid])).toEqual([['assistant_turn', uuid(4)]])
    expect(closed.cursor).toMatchObject({ line: 4, open_turn_emitted: [] })
  })
})

describe('calls still waiting when a turn is force-closed', () => {
  const PICK = [{ question: 'Which option?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }]
  const PICK_QUESTIONS = [
    {
      question: 'Which option?',
      header: 'Pick',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      multiSelect: false,
    },
  ]

  /** A turn that asks a dialog and is swept while the dialog waits for the user. */
  async function sweptDialog() {
    const path = writeTranscript(dir, SESSION, [
      humanPrompt(uuid(1), at(1), 'choose for me'),
      assistantText(uuid(2), at(2), 'Asking first.'),
      askCall(uuid(3), at(3), 'toolu_ask', PICK),
    ])
    const swept = await read(path, null, true)
    expect(swept.events.map((e) => [e.type, e.event_uuid])).toEqual([
      ['user_prompt', uuid(1)],
      ['assistant_turn', uuid(2)],
    ])
    return { path, swept }
  }

  it('captures a dialog answered after the idle sweep, once, with the question from the call', async () => {
    const { path, swept } = await sweptDialog()
    expect(swept.cursor.pending_calls).toEqual([{ id: 'toolu_ask', name: 'AskUserQuestion', questions: PICK_QUESTIONS }])

    appendEntries(path, SESSION, [
      askResult(uuid(4), at(4), 'toolu_ask', PICK, { answers: { 'Which option?': 'B' } }),
      assistantText(uuid(5), at(5), 'Going with B.'),
    ])
    const open = await read(path, swept.cursor)
    expect(open.events.map((e) => [e.type, e.event_uuid])).toEqual([['user_answer', uuid(4)]])

    appendEntries(path, SESSION, [turnEnd(uuid(6), at(6))])
    const closed = await read(path, open.cursor)
    expect(closed.events.map((e) => [e.type, e.event_uuid])).toEqual([['assistant_turn', uuid(5)]])
    expect(open.events[0].payload).toEqual({
      questions: PICK_QUESTIONS,
      answers: { 'Which option?': 'B' },
      transcript_line: 4,
    })
    expect(closed.cursor.pending_calls).toEqual([])
  })

  it('turns feedback typed into a dialog rejected after the sweep into an answer with the response', async () => {
    const { path, swept } = await sweptDialog()
    appendEntries(path, SESSION, [
      toolResult(uuid(4), at(4), 'toolu_ask', 'The user does not want to proceed.', {
        isError: true,
        toolUseResult: 'User rejected tool use',
        toolDenialKind: 'user-rejected',
        userFeedback: 'neither, keep both',
      }),
      assistantText(uuid(5), at(5), 'Keeping both.'),
      turnEnd(uuid(6), at(6)),
    ])
    const next = await read(path, swept.cursor)
    expect(next.events.map((e) => [e.type, e.event_uuid])).toEqual([
      ['user_answer', uuid(4)],
      ['assistant_turn', uuid(5)],
    ])
    expect(next.events[0].payload).toEqual({
      questions: PICK_QUESTIONS,
      answers: {},
      response: 'neither, keep both',
      transcript_line: 4,
    })
  })

  it('reports a commit whose result lands after the sweep with the next assistant turn', async () => {
    const path = writeTranscript(dir, SESSION, [
      humanPrompt(uuid(1), at(1), 'commit it'),
      assistantText(uuid(2), at(2), 'Committing.'),
      toolUse(uuid(3), at(3), 'toolu_commit', 'Bash', { command: 'git commit -m "x"' }),
    ])
    const swept = await read(path, null, true)
    expect(swept.events.find((e) => e.type === 'assistant_turn')?.payload).toMatchObject({ text: 'Committing.', tools: [] })

    appendEntries(path, SESSION, [
      toolResult(uuid(4), at(4), 'toolu_commit', '[main abc1234] x\n 1 file changed'),
      assistantText(uuid(5), at(5), 'Committed.'),
      turnEnd(uuid(6), at(6)),
    ])
    const next = await read(path, swept.cursor)
    expect(next.events.map((e) => [e.type, e.event_uuid])).toEqual([['assistant_turn', uuid(5)]])
    expect(next.events[0].payload).toEqual({
      text: 'Committed.',
      transcript_line: 5,
      tools: [{ name: 'Bash', ref: 'abc1234' }],
    })
  })

  it('builds the answer from the dialog result when the call is no longer known', async () => {
    const { path, swept } = await sweptDialog()
    appendEntries(path, SESSION, [
      askResult(uuid(4), at(4), 'toolu_ask', PICK, { answers: { 'Which option?': 'A' } }),
      turnEnd(uuid(5), at(5)),
    ])
    const lost = { ...swept.cursor, pending_calls: [] }
    const next = await read(path, lost)
    expect(next.events.map((e) => [e.type, e.event_uuid])).toEqual([['user_answer', uuid(4)]])
    expect(next.events[0].payload).toEqual({
      questions: PICK_QUESTIONS,
      answers: { 'Which option?': 'A' },
      transcript_line: 4,
    })
  })

  it('keeps the newest waiting calls that fit 200 calls and 64 KiB', async () => {
    const calls = Array.from({ length: 205 }, (_, i) =>
      toolUse(uuid(10 + i), at(10 + i), `toolu_${i}`, 'Bash', { command: `sleep ${i}` }),
    )
    const huge = [{ question: 'q'.repeat(70 * 1024), options: [{ label: 'A' }] }]
    const path = writeTranscript(dir, SESSION, [
      humanPrompt(uuid(1), at(1), 'run them all'),
      ...calls,
      askCall(uuid(2), at(2), 'toolu_huge', huge),
    ])
    const swept = await read(path, null, true)
    const ids = swept.cursor.pending_calls.map((c) => c.id)
    expect(ids).toEqual(Array.from({ length: 200 }, (_, i) => `toolu_${i + 5}`))
    expect(Buffer.byteLength(JSON.stringify(swept.cursor.pending_calls))).toBeLessThanOrEqual(64 * 1024)
  })
})

describe('plans', () => {
  it('adds the plan a tool call touched to later events, but not a plan named in text', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'read Plans/Active/tst-other/status.md'),
      toolUse(uuid(2), at(2), 'toolu_edit', 'Edit', {
        file_path: '/notes/Sample/Plans/Active/tst-plan/status.md',
        old_string: 'a',
        new_string: 'see Plans/Delivered/tst-third',
      }),
      toolResult(uuid(3), at(3), 'toolu_edit', 'ok'),
      assistantText(uuid(4), at(4), 'Updated.'),
      turnEnd(uuid(5), at(5)),
      humanPrompt(uuid(6), at(6), 'thanks'),
    ])
    expect(events.map((e) => [e.event_uuid, e.plan_dirs])).toEqual([
      [uuid(1), []],
      [uuid(4), ['Active/tst-plan']],
      [uuid(6), ['Active/tst-plan']],
    ])
    expect(events[1].payload).toMatchObject({ tools: [{ name: 'Edit', ref: '/notes/Sample/Plans/Active/tst-plan/status.md' }] })
  })

  it('carries the plan folders in the cursor across reads', async () => {
    const path = writeTranscript(dir, SESSION, [
      humanPrompt(uuid(1), at(1), 'go'),
      toolUse(uuid(2), at(2), 'toolu_read', 'Read', { file_path: '/notes/Sample/Plans/Active/tst-plan/README.md' }),
      toolResult(uuid(3), at(3), 'toolu_read', 'x'),
      assistantText(uuid(4), at(4), 'Read it.'),
      turnEnd(uuid(5), at(5)),
    ])
    const first = await read(path)
    expect(first.cursor.plan_dirs).toEqual(['Active/tst-plan'])
    appendEntries(path, SESSION, [humanPrompt(uuid(6), at(6), 'next')])
    expect((await read(path, first.cursor)).events[0].plan_dirs).toEqual(['Active/tst-plan'])
  })
})

describe('cursor', () => {
  it('leaves a last line without a newline for the next read', async () => {
    const path = writeTranscript(dir, SESSION, [humanPrompt(uuid(1), at(1), 'one')])
    appendFileSync(path, JSON.stringify(humanPrompt(uuid(2), at(2), 'two')))
    const first = await read(path)
    expect(first.events.map((e) => e.event_uuid)).toEqual([uuid(1)])
    expect(first.cursor.line).toBe(0)
    appendFileSync(path, '\n')
    const second = await read(path, first.cursor)
    expect(second.events.map((e) => [e.event_uuid, e.payload.transcript_line])).toEqual([[uuid(2), 2]])
  })

  it('advances past lines outside any turn and skips lines that are not JSON', async () => {
    const path = writeTranscript(dir, SESSION, [systemEntry(uuid(1), at(1), 'informational')])
    appendFileSync(path, 'not json\n')
    const first = await read(path)
    expect(first.cursor).toMatchObject({ line: 2, last_uuid: uuid(1), last_line_start: 0 })
    appendEntries(path, SESSION, [humanPrompt(uuid(3), at(3), 'after the noise')])
    expect((await read(path, first.cursor)).events[0].payload).toEqual({ text: 'after the noise', transcript_line: 3 })
  })

  it('re-reads from 0 when the line at the cursor changed, the file shrank or the path differs', async () => {
    const entries = [humanPrompt(uuid(1), at(1), 'one'), assistantText(uuid(2), at(2), 'One.'), turnEnd(uuid(3), at(3))]
    const path = writeTranscript(dir, SESSION, entries)
    const { cursor } = await read(path)
    expect(cursor.line).toBe(3)

    writeTranscript(dir, SESSION, [humanPrompt(uuid(7), at(7), 'rewritten'), ...entries.slice(1)])
    expect((await read(path, cursor)).events.map((e) => e.event_uuid)).toEqual([uuid(7), uuid(2)])

    writeFileSync(path, `${JSON.stringify(humanPrompt(uuid(8), at(8), 'short'))}\n`)
    expect((await read(path, cursor)).events.map((e) => e.event_uuid)).toEqual([uuid(8)])

    const other = writeTranscript(dir, '00000000-0000-4000-8000-000000009001', entries)
    expect((await read(other, cursor)).events.map((e) => e.event_uuid)).toEqual([uuid(1), uuid(2)])
  })
})

describe('a command compaction replays', () => {
  // Real compactions stamp the boundary minutes after the command, the summary just before the
  // boundary, and the replay (caveat and tagged command) with the command's own time.
  const COMMAND_AT = 100
  const BOUNDARY_AT = 200
  const ms = (n: number): string => new Date(Date.parse(at(n)) + 3).toISOString()
  const pid = (promptId: string): { extra: Entry } => ({ extra: { promptId } })
  const texts = (events: TranscriptEvent[]): string[] => prompts(events).map((p) => (p as { text: string }).text)

  function caveat(id: string, timestamp: string, promptId: string): Entry {
    return userEntry(id, timestamp, '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>', {
      extra: { isMeta: true, promptId },
    })
  }

  function tagged(id: string, timestamp: string, name: string, args: string, promptId: string): Entry {
    const content = `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>`
    return userEntry(id, timestamp, content, pid(promptId))
  }

  /** An earlier closed turn, then the plain line the CLI writes when the user runs `command`. */
  function beforeCompaction(command: string, commandPid = 'prompt-compact'): Entry[] {
    return [
      humanPrompt(uuid(1), at(1), 'start', pid('prompt-start')),
      assistantText(uuid(2), at(2), 'Started.'),
      turnEnd(uuid(3), at(3)),
      userEntry(uuid(4), at(COMMAND_AT), command, pid(commandPid)),
    ]
  }

  /** The boundary and summary, then the command's replay stamped at its own time, then its output. */
  function afterCompaction(args: string, replayPid = 'prompt-compact'): Entry[] {
    return [
      compactBoundary(uuid(5), at(BOUNDARY_AT)),
      compactSummary(uuid(6), at(BOUNDARY_AT - 1), 'This session is being continued from a previous conversation.', pid(replayPid)),
      caveat(uuid(7), ms(COMMAND_AT), replayPid),
      tagged(uuid(8), ms(COMMAND_AT), '/compact', args, replayPid),
      userEntry(uuid(9), at(BOUNDARY_AT + 1), '<local-command-stdout>Compacted</local-command-stdout>', pid(replayPid)),
    ]
  }

  it('captures /compact once: the replay after the boundary is no prompt', async () => {
    const events = await eventsOf([...beforeCompaction('/compact'), ...afterCompaction('')])
    expect(prompts(events)).toEqual([
      { text: 'start', transcript_line: 1 },
      { text: '/compact', transcript_line: 4 },
    ])
    expect(events.find((e) => e.payload.transcript_line === 4)?.event_uuid).toBe(uuid(4))
  })

  it('keeps the typed line of /compact with arguments', async () => {
    const events = await eventsOf([...beforeCompaction('/compact keep the plan'), ...afterCompaction('keep the plan')])
    expect(texts(events)).toEqual(['start', '/compact keep the plan'])
  })

  it('drops the replay when it carries a different promptId than the typed line', async () => {
    const events = await eventsOf([...beforeCompaction('/compact', 'prompt-typed'), ...afterCompaction('', 'prompt-replay')])
    expect(texts(events)).toEqual(['start', '/compact'])
  })

  it('keeps a prompt typed during compaction that shares the replay promptId', async () => {
    const events = await eventsOf([
      ...beforeCompaction('/compact'),
      ...afterCompaction(''),
      caveat(uuid(10), at(BOUNDARY_AT + 2), 'prompt-compact'),
      tagged(uuid(11), at(BOUNDARY_AT + 2), '/reload-plugins', '--force', 'prompt-compact'),
      humanPrompt(uuid(12), at(BOUNDARY_AT + 30), 'launch now', pid('prompt-compact')),
    ])
    expect(texts(events)).toEqual(['start', '/compact', '/reload-plugins --force', 'launch now'])
  })

  it('keeps every prompt after a compaction that still carries its promptId', async () => {
    const events = await eventsOf([
      ...beforeCompaction('/compact'),
      ...afterCompaction(''),
      humanPrompt(uuid(10), at(BOUNDARY_AT + 300), 'fix the remaining issues', pid('prompt-compact')),
      assistantText(uuid(11), at(BOUNDARY_AT + 301), 'Fixed.'),
      turnEnd(uuid(12), at(BOUNDARY_AT + 302)),
      queuedPrompt(uuid(13), at(BOUNDARY_AT + 303), 'also the docs'),
      humanPrompt(uuid(14), at(BOUNDARY_AT + 400), 'continue', pid('prompt-compact')),
    ])
    expect(texts(events)).toEqual(['start', '/compact', 'fix the remaining issues', 'also the docs', 'continue'])
  })

  it('keeps /clear and the first prompt after it, which shares its promptId', async () => {
    const events = await eventsOf([
      caveat(uuid(1), ms(10), 'prompt-clear'),
      tagged(uuid(2), at(10), '/clear', '', 'prompt-clear'),
      systemEntry(uuid(3), at(10), 'local_command', { extra: { content: '<local-command-stdout></local-command-stdout>' } }),
      humanPrompt(uuid(4), at(15), 'Continue the plan', pid('prompt-clear')),
    ])
    expect(texts(events)).toEqual(['/clear', 'Continue the plan'])
  })

  it('keeps every prompt around a compaction the CLI ran on its own', async () => {
    const events = await eventsOf([
      humanPrompt(uuid(1), at(1), 'start', pid('prompt-a')),
      assistantText(uuid(2), at(2), 'Started.'),
      compactBoundary(uuid(3), at(50), { extra: { compactMetadata: { trigger: 'auto' } } }),
      compactSummary(uuid(4), at(49), 'This session is being continued.'),
      humanPrompt(uuid(5), at(60), 'go on', pid('prompt-b')),
    ])
    expect(texts(events)).toEqual(['start', 'go on'])
  })

  it('reads no prompt from a continued file that opens with a boundary and a replay', async () => {
    const events = await eventsOf([
      compactBoundary(uuid(1), at(BOUNDARY_AT)),
      compactSummary(uuid(2), at(BOUNDARY_AT - 1), 'This session is being continued.'),
      caveat(uuid(3), ms(COMMAND_AT), 'prompt-model'),
      tagged(uuid(4), ms(COMMAND_AT), '/model', 'fable', 'prompt-model'),
      humanPrompt(uuid(5), at(BOUNDARY_AT + 10), 'next', pid('prompt-next')),
    ])
    expect(texts(events)).toEqual(['next'])
  })

  it('captures /compact once when the replay is read after the read that saw the boundary', async () => {
    const path = writeTranscript(dir, SESSION, [...beforeCompaction('/compact'), ...afterCompaction('').slice(0, 2)])
    const first = await read(path, null, true)
    expect(texts(first.events)).toEqual(['start', '/compact'])
    expect(first.cursor).toMatchObject({ line: 6, compact_boundary_at: at(BOUNDARY_AT) })

    appendEntries(path, SESSION, afterCompaction('').slice(2))
    const second = await read(path, first.cursor, true)
    expect(texts(second.events)).toEqual([])
  })

  it('captures /compact once when its open turn is read again from the mark', async () => {
    const path = writeTranscript(dir, SESSION, beforeCompaction('/compact'))
    const first = await read(path)
    expect(texts(first.events)).toEqual(['start', '/compact'])
    expect(first.cursor).toMatchObject({ line: 3, compact_boundary_at: null })

    appendEntries(path, SESSION, afterCompaction('').slice(0, 2))
    const second = await read(path, first.cursor)
    expect(texts(second.events)).toEqual([])
    // The turn is still open, so the mark and the boundary it saves stay before the command.
    expect(second.cursor).toMatchObject({ line: 3, compact_boundary_at: null })

    appendEntries(path, SESSION, afterCompaction('').slice(2, 4))
    const third = await read(path, second.cursor)
    expect(texts(third.events)).toEqual([])
    // The replay opened a turn: the mark rests before it, past the boundary, so the next read
    // reads the replay again and finds the boundary in the cursor.
    expect(third.cursor).toMatchObject({ line: 7, compact_boundary_at: at(BOUNDARY_AT) })

    appendEntries(path, SESSION, [
      ...afterCompaction('').slice(4),
      humanPrompt(uuid(10), at(BOUNDARY_AT + 5), 'next', pid('prompt-compact')),
    ])
    const fourth = await read(path, third.cursor)
    expect(texts(fourth.events)).toEqual(['next'])
    expect(texts((await read(path, fourth.cursor, true)).events)).toEqual([])
  })

  it('captures a tagged-only command once', async () => {
    const events = await eventsOf([
      caveat(uuid(1), at(1), 'prompt-exit'),
      slashCommand(uuid(2), at(1), '/exit', '', pid('prompt-exit')),
      userEntry(uuid(3), at(2), '<local-command-stdout>Bye!</local-command-stdout>', pid('prompt-exit')),
    ])
    expect(texts(events)).toEqual(['/exit'])
  })
})
