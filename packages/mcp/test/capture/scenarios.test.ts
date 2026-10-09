/**
 * Capture end to end: a synthetic transcript under a temporary HOME, the
 * worker a hook starts, and a stand-in capture route. Every assertion reads
 * what reached the route (the request bodies), or what the spool holds on disk.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureEvent } from '../../src/capture/events.js'
import { CAPTURE_CLIENT_NAME } from '../../src/capture/events.js'
import { type ForwardedInput, HOOK_AT_ENV, type WorkerKind } from '../../src/capture/hook-input.js'
import { spoolRoot } from '../../src/capture/spool.js'
import { DRAIN_BACKOFF_BASE_MS, loadSpoolState } from '../../src/capture/spool-drain.js'
import { cursorRoot, loadCursor } from '../../src/capture/transcript-cursor.js'
import { runWorker, SWEEP_IDLE_MS, type WorkerResult } from '../../src/capture/worker.js'
import { runGitCommitCapture } from '../../src/hooks/git-commit.js'
import { type CaptureStub, type CaptureStubRequest, startCaptureStub } from './stub-server.js'
import {
  appendEntries,
  askCall,
  askResult,
  assistantText,
  at,
  compactBoundary,
  compactSummary,
  type Entry,
  humanPrompt,
  notification,
  queuedPrompt,
  slashCommand,
  systemEntry,
  toolResult,
  toolUse,
  turnEnd,
  userEntry,
  uuid,
  writeTranscript,
} from './transcripts.js'

const SESSION = '00000000-0000-4000-8000-000000007710'
const CRASHED = '00000000-0000-4000-8000-000000007711'
const HOOK_AT = '2026-10-05T11:30:00.000Z'
const TOKEN = 'scenario-capture-token'
const SECRET = 'kq-scenario-fixture-secret-value-8812'
const TRANSCRIPT_TYPES: ReadonlySet<string> = new Set(['user_prompt', 'user_answer', 'assistant_turn'])

// The secret registry is built once per process from process.env, on the first scrub.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-scenarios-registry-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({ SCENARIO_SECRET: SECRET }))
  writeFileSync(join(registryDir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
  process.env.ENGRAM_SECRET_SOURCES_FILE = join(registryDir, 'sources.json')
  process.env.XDG_CACHE_HOME = join(registryDir, 'cache')
})

afterAll(() => {
  if (savedEnv.SOURCES === undefined) delete process.env.ENGRAM_SECRET_SOURCES_FILE
  else process.env.ENGRAM_SECRET_SOURCES_FILE = savedEnv.SOURCES
  if (savedEnv.CACHE === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = savedEnv.CACHE
  rmSync(registryDir, { recursive: true, force: true })
})

let home: string
let projectDir: string
let stub: CaptureStub
let env: Record<string, string>

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'engram-scenarios-')))
  projectDir = join(home, '.claude', 'projects', '-home-tester-work-sample-repo')
  mkdirSync(projectDir, { recursive: true })
  const tokenFile = join(home, 'capture-token')
  writeFileSync(tokenFile, `${TOKEN}\n`)
  stub = await startCaptureStub()
  env = { HOME: home, ENGRAM_SERVER_URL: stub.url, ENGRAM_CAPTURE_TOKEN_FILE: tokenFile }
})

afterEach(async () => {
  vi.useRealTimers()
  await stub.close()
  rmSync(home, { recursive: true, force: true })
})

/** Runs the worker one hook starts, at the hook time given; no step may fail. */
async function hook(kind: WorkerKind, input: ForwardedInput, hookAt = HOOK_AT, runEnv: Record<string, string> = env): Promise<WorkerResult> {
  const result = await runWorker(kind, input, { ...runEnv, [HOOK_AT_ENV]: hookAt })
  expect(result.failures).toEqual([])
  return result
}

function input(path: string, extra: ForwardedInput = {}, sessionId = SESSION): ForwardedInput {
  return { session_id: sessionId, transcript_path: path, cwd: home, ...extra }
}

function eventsOf(requests: readonly CaptureStubRequest[]): CaptureEvent[] {
  return requests.flatMap((r) => r.body.events as unknown as CaptureEvent[])
}

/** Every event the route received, in the order received. */
function sent(): CaptureEvent[] {
  return eventsOf(stub.received)
}

function sentFromTranscript(): CaptureEvent[] {
  return sent().filter((e) => TRANSCRIPT_TYPES.has(e.type))
}

function typesAndUuids(events: readonly CaptureEvent[]): Array<[string, string]> {
  return events.map((e) => [e.type, e.event_uuid])
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

/** The batch files waiting in the spool, dead letters and spool state excluded. */
function batchFiles(): string[] {
  return filesUnder(spoolRoot(env)).filter((p) => p.endsWith('.jsonl') && !p.includes('/.dead/'))
}

function spooledUuids(): string[] {
  return batchFiles().flatMap((p) =>
    readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as CaptureEvent).event_uuid),
  )
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1
  return counts
}

describe('what a session sends', () => {
  it('a single-select and a multi-select dialog arrive as two answers with the questions, options and answers verbatim', async () => {
    const single = [
      {
        question: 'Which store should the worker read?',
        header: 'Store',
        options: [
          { label: 'Postgres', description: 'the item store' },
          { label: 'Files', description: 'plain files under the home directory' },
        ],
        multiSelect: false,
      },
    ]
    const multi = [
      {
        question: 'Which checks should run before the merge?',
        header: 'Checks',
        options: [
          { label: 'Lint', description: 'style and imports' },
          { label: 'Tests', description: 'the unit suite' },
          { label: 'Types', description: 'the compiler without emit' },
        ],
        multiSelect: true,
      },
    ]
    const path = writeTranscript(projectDir, SESSION, [
      humanPrompt(uuid(1), at(1), 'set up the worker'),
      askCall(uuid(2), at(2), 'toolu_single', single),
      askResult(uuid(3), at(3), 'toolu_single', single, { answers: { 'Which store should the worker read?': 'Postgres' } }),
      askCall(uuid(4), at(4), 'toolu_multi', multi),
      askResult(uuid(5), at(5), 'toolu_multi', multi, {
        answers: { 'Which checks should run before the merge?': 'Lint, Tests' },
        annotations: { 'Which checks should run before the merge?': { notes: 'run the tests first, then lint' } },
      }),
      assistantText(uuid(6), at(6), 'Both checks are wired.'),
      turnEnd(uuid(7), at(7)),
    ])

    await hook('stop', input(path))

    expect(stub.received.length).toBeGreaterThan(0)
    for (const request of stub.received) {
      expect(request).toMatchObject({ method: 'POST', path: '/capture/events', authorization: `Bearer ${TOKEN}` })
      expect(request.body.client.name).toBe(CAPTURE_CLIENT_NAME)
    }
    const answers = sent().filter((e) => e.type === 'user_answer')
    expect(answers.map((e) => [e.session_id, e.event_uuid, e.occurred_at])).toEqual([
      [SESSION, uuid(3), at(3)],
      [SESSION, uuid(5), at(5)],
    ])
    expect(answers[0].payload).toEqual({
      questions: single,
      answers: { 'Which store should the worker read?': 'Postgres' },
      transcript_line: 3,
    })
    expect(answers[1].payload).toEqual({
      questions: multi,
      answers: { 'Which checks should run before the merge?': 'Lint, Tests' },
      notes: { 'Which checks should run before the merge?': 'run the tests first, then lint' },
      transcript_line: 5,
    })
  })

  it('task notifications and a queued notification send nothing', async () => {
    const path = writeTranscript(projectDir, SESSION, [
      humanPrompt(uuid(1), at(1), 'start the build in the background'),
      assistantText(uuid(2), at(2), 'The build is running.'),
      turnEnd(uuid(3), at(3)),
      notification(uuid(4), at(4), '<task-notification>build finished with exit code 0</task-notification>'),
      queuedPrompt(uuid(5), at(5), '<task-notification>lint finished</task-notification>', {
        commandMode: 'task-notification',
        origin: null,
      }),
    ])

    await hook('stop', input(path))
    await hook('session-end', input(path, { reason: 'other' }), at(10))

    expect(typesAndUuids(sentFromTranscript())).toEqual([
      ['user_prompt', uuid(1)],
      ['assistant_turn', uuid(2)],
    ])
    expect(sent().map((e) => e.event_uuid)).not.toContain(uuid(4))
    expect(sent().map((e) => e.event_uuid)).not.toContain(uuid(5))
  })

  it('an "ok" to the question "Ship it now?" arrives as a prompt with its own uuid and timestamp', async () => {
    const path = writeTranscript(projectDir, SESSION, [
      humanPrompt(uuid(1), at(1), 'prepare the release'),
      assistantText(uuid(2), at(2), 'The release notes are ready. Ship it now?'),
      turnEnd(uuid(3), at(3)),
      humanPrompt(uuid(4), at(4), 'ok'),
      assistantText(uuid(5), at(5), 'Shipped.'),
      turnEnd(uuid(6), at(6)),
    ])

    await hook('stop', input(path))

    const reply = sent().filter((e) => e.type === 'user_prompt' && e.event_uuid === uuid(4))
    expect(reply).toHaveLength(1)
    expect(reply[0]).toMatchObject({ session_id: SESSION, occurred_at: at(4), payload: { text: 'ok', transcript_line: 4 } })
    expect(sent().find((e) => e.event_uuid === uuid(2))?.payload).toMatchObject({
      text: 'The release notes are ready. Ship it now?',
    })
  })

  it('a slash command arrives as its name and arguments, and its local command output sends nothing', async () => {
    const path = writeTranscript(projectDir, SESSION, [
      slashCommand(uuid(1), at(1), '/plan-run', 'tst-plan'),
      userEntry(uuid(2), at(2), '<local-command-stdout>Running tst-plan</local-command-stdout>'),
      assistantText(uuid(3), at(3), 'The first task is done.'),
      turnEnd(uuid(4), at(4)),
    ])

    await hook('stop', input(path))

    const prompts = sent().filter((e) => e.type === 'user_prompt')
    expect(prompts.map((e) => [e.event_uuid, e.payload])).toEqual([[uuid(1), { text: '/plan-run tst-plan', transcript_line: 1 }]])
    expect(sent().map((e) => e.event_uuid)).not.toContain(uuid(2))
  })

  it('an interrupted turn arrives once with the text written before the marker, and the marker sends nothing', async () => {
    const path = writeTranscript(projectDir, SESSION, [
      humanPrompt(uuid(1), at(1), 'run the suite'),
      assistantText(uuid(2), at(2), 'Running the suite now.'),
      toolUse(uuid(3), at(3), 'toolu_bash', 'Bash', { command: 'npm test' }),
      toolResult(uuid(4), at(4), 'toolu_bash', 'Interrupted by user', { isError: true }),
      userEntry(uuid(5), at(5), [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      humanPrompt(uuid(6), at(6), 'run only the reader tests'),
    ])

    await hook('stop', input(path))
    await hook('session-end', input(path, { reason: 'prompt_input_exit' }), at(10))

    const turns = sent().filter((e) => e.type === 'assistant_turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ event_uuid: uuid(2), payload: { text: 'Running the suite now.', transcript_line: 2 } })
    expect(typesAndUuids(sentFromTranscript())).toEqual([
      ['user_prompt', uuid(1)],
      ['assistant_turn', uuid(2)],
      ['user_prompt', uuid(6)],
    ])
  })

  it('a compaction mid-session sends the events on each side of the boundary exactly once', async () => {
    const path = writeTranscript(projectDir, SESSION, [
      humanPrompt(uuid(1), at(1), 'read the reader module'),
      assistantText(uuid(2), at(2), 'The reader keeps a cursor per session.'),
      turnEnd(uuid(3), at(3)),
      humanPrompt(uuid(4), at(4), 'and the spool?'),
      assistantText(uuid(5), at(5), 'The spool writes one file per batch.'),
    ])
    await hook('stop', input(path))
    await hook('pre-compact', input(path, { trigger: 'auto' }), at(6))

    appendEntries(path, SESSION, [
      compactBoundary(uuid(7), at(7)),
      compactSummary(uuid(8), at(8), 'Summary: the user asked about the reader and the spool.'),
      humanPrompt(uuid(9), at(9), 'now trace the drain'),
      assistantText(uuid(10), at(10), 'The drain posts one request per file.'),
      turnEnd(uuid(11), at(11)),
    ])
    await hook('stop', input(path))
    await hook('session-end', input(path, { reason: 'other' }), at(20))

    expect(countBy(sentFromTranscript().map((e) => e.event_uuid))).toEqual({
      [uuid(1)]: 1,
      [uuid(2)]: 1,
      [uuid(4)]: 1,
      [uuid(5)]: 1,
      [uuid(9)]: 1,
      [uuid(10)]: 1,
    })
    expect(sent().filter((e) => e.type === 'pre_compact').map((e) => [e.occurred_at, e.payload])).toEqual([[at(6), { reason: 'auto' }]])
  })

  it('a Stop that runs before the final text is written sends no turn; the next Stop sends it exactly once', async () => {
    const path = writeTranscript(projectDir, SESSION, [
      humanPrompt(uuid(1), at(1), 'check the build'),
      toolUse(uuid(2), at(2), 'toolu_bash', 'Bash', { command: 'npm run build' }),
      toolResult(uuid(3), at(3), 'toolu_bash', 'built'),
    ])
    await hook('stop', input(path))
    expect(typesAndUuids(sentFromTranscript())).toEqual([['user_prompt', uuid(1)]])

    appendEntries(path, SESSION, [
      assistantText(uuid(4), at(4), 'The build is green.'),
      systemEntry(uuid(5), at(5), 'stop_hook_summary'),
      turnEnd(uuid(6), at(6)),
      humanPrompt(uuid(7), at(7), 'ship it'),
      toolUse(uuid(8), at(8), 'toolu_bash', 'Bash', { command: 'npm publish' }),
    ])
    await hook('stop', input(path))
    await hook('stop', input(path))

    const turns = sent().filter((e) => e.type === 'assistant_turn')
    expect(turns.map((e) => [e.event_uuid, (e.payload as { text: string }).text])).toEqual([[uuid(4), 'The build is green.']])
    expect(countBy(sentFromTranscript().map((e) => e.event_uuid))).toEqual({ [uuid(1)]: 1, [uuid(4)]: 1, [uuid(7)]: 1 })
  })

  it('a session that crashed without a SessionEnd has its open turn sent by the next session-start sweep', async () => {
    const crashed = writeTranscript(projectDir, CRASHED, [
      humanPrompt(uuid(1), at(1), 'rename the field'),
      assistantText(uuid(2), at(2), 'Renamed.'),
      turnEnd(uuid(3), at(3)),
      humanPrompt(uuid(4), at(4), 'update the callers'),
      assistantText(uuid(5), at(5), 'Updated every caller.'),
    ])
    await hook('stop', input(crashed, {}, CRASHED))
    expect(typesAndUuids(sentFromTranscript())).toEqual([
      ['user_prompt', uuid(1)],
      ['assistant_turn', uuid(2)],
      ['user_prompt', uuid(4)],
    ])

    // The sweep reads files modified since its first run, which happened before the crash.
    const now = Date.now()
    mkdirSync(cursorRoot(env), { recursive: true })
    writeFileSync(join(cursorRoot(env), '.since'), `${new Date(now - 2 * SWEEP_IDLE_MS).toISOString()}\n`)
    const idle = (now - SWEEP_IDLE_MS - 60_000) / 1000
    utimesSync(crashed, idle, idle)
    const before = stub.received.length

    // An interactive start has no transcript file until its first message.
    const own = join(projectDir, `${SESSION}.jsonl`)
    await hook('session-start', input(own, { source: 'startup' }))
    expect(existsSync(own)).toBe(false)
    expect(await loadCursor(cursorRoot(env), CRASHED)).not.toBeNull()

    const fromSweep = eventsOf(stub.received.slice(before))
    expect(fromSweep.filter((e) => TRANSCRIPT_TYPES.has(e.type)).map((e) => [e.session_id, e.type, e.event_uuid])).toEqual([
      [CRASHED, 'assistant_turn', uuid(5)],
    ])
    expect(fromSweep.filter((e) => e.type === 'session_start').map((e) => e.session_id)).toEqual([SESSION])
    expect(countBy(sentFromTranscript().map((e) => e.event_uuid))[uuid(5)]).toBe(1)
  })

  it('every transcript event carries the timestamp of its entry as occurred_at', async () => {
    const question = [{ question: 'Proceed with the rename?', header: 'Rename', options: [{ label: 'Yes', description: '' }], multiSelect: false }]
    const entries: Entry[] = [
      humanPrompt(uuid(1), at(1.237), 'rename the cursor field'),
      askCall(uuid(2), at(2.5), 'toolu_ask', question),
      askResult(uuid(3), at(3.901), 'toolu_ask', question, { answers: { 'Proceed with the rename?': 'Yes' } }),
      toolUse(uuid(4), at(4.004), 'toolu_bash', 'Bash', { command: 'npm test' }),
      queuedPrompt(uuid(5), at(5.75), 'also check the index'),
      toolResult(uuid(6), at(6.1), 'toolu_bash', 'passed'),
      assistantText(uuid(7), at(7.333), 'Renamed it and the tests pass.'),
      turnEnd(uuid(8), at(8.2)),
      slashCommand(uuid(9), at(61.009), '/plan-run', 'tst-plan'),
      assistantText(uuid(10), at(62.5), 'Started the run.'),
    ]
    const timestampOf = new Map(entries.map((e) => [e.uuid as string, e.timestamp as string]))
    const path = writeTranscript(projectDir, SESSION, entries)

    await hook('stop', input(path))
    await hook('session-end', input(path, { reason: 'logout' }), at(120))

    const events = sentFromTranscript()
    expect(typesAndUuids(events)).toEqual([
      ['user_prompt', uuid(1)],
      ['user_answer', uuid(3)],
      ['user_prompt', uuid(5)],
      ['assistant_turn', uuid(7)],
      ['user_prompt', uuid(9)],
      ['assistant_turn', uuid(10)],
    ])
    for (const event of events) expect(event.occurred_at, event.event_uuid).toBe(timestampOf.get(event.event_uuid))
  })
})

describe('secrets', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd,
      encoding: 'utf8',
    })
  }

  it('a registered secret in a prompt and in a commit message is masked in every spool file and every request body', async () => {
    const offline = { HOME: home }
    const path = writeTranscript(projectDir, SESSION, [
      humanPrompt(uuid(1), at(1), `connect the replica with ${SECRET} and report back`),
      assistantText(uuid(2), at(2), 'Connected.'),
      turnEnd(uuid(3), at(3)),
    ])
    const spooled = await hook('stop', input(path), HOOK_AT, offline)
    expect(spooled.redactions).toBeGreaterThan(0)

    const repo = join(home, 'sample-repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'replica.conf'), 'host=replica\n')
    git(repo, 'add', '--', 'replica.conf')
    git(repo, 'commit', '-q', '-m', `chore: point the replica at the new host\n\nThe old key ${SECRET} is retired.`)
    const commit = await runGitCommitCapture(repo, offline)
    expect(commit).toMatchObject({ events: 1, skipped: null, failures: [] })
    expect(commit.redactions).toBeGreaterThan(0)

    const files = [...filesUnder(spoolRoot(env)), ...filesUnder(cursorRoot(env))]
    expect(batchFiles().length).toBeGreaterThanOrEqual(2)
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toContain(SECRET)

    await hook('drain', {})

    expect(batchFiles()).toEqual([])
    const bodies = stub.received.map((r) => JSON.stringify(r.body))
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) expect(body).not.toContain(SECRET)
    const prompt = sent().find((e) => e.event_uuid === uuid(1))?.payload as { text: string }
    expect(prompt.text.startsWith('connect the replica with ')).toBe(true)
    expect(prompt.text.endsWith(' and report back')).toBe(true)
    const commitEvent = sent().find((e) => e.type === 'git_commit')
    expect(commitEvent?.session_id).toBe('git:sample-repo')
    const message = (commitEvent?.payload as { message: string }).message
    expect(message.startsWith('chore: point the replica at the new host\n\nThe old key ')).toBe(true)
    expect(message.endsWith(' is retired.')).toBe(true)
    for (const file of filesUnder(spoolRoot(env))) expect(readFileSync(file, 'utf8'), file).not.toContain(SECRET)
  })
})

describe('the server is down', () => {
  it('keeps the files and backs off, then delivers every event once the server is up, counting repeats as duplicates', async () => {
    // A route that stores each event once. While the backend is down the
    // proxy answers 502; `storeThenFail` is a backend that stored a batch and
    // died before its answer left, so that batch is sent again later.
    const stored = new Set<string>()
    let mode: 'up' | 'down' | 'storeThenFail' = 'storeThenFail'
    stub.reply = (request) => {
      const uuids = request.body.events.map((e) => String(e.event_uuid))
      if (mode === 'down') return { status: 502, body: { error: 'backend unavailable' } }
      const fresh = uuids.filter((id) => !stored.has(id))
      for (const id of uuids) stored.add(id)
      if (mode === 'storeThenFail') return { status: 502, body: { error: 'backend unavailable' } }
      return { status: 200, body: { accepted: fresh.length, duplicates: uuids.length - fresh.length, rejected: [] } }
    }
    const path = writeTranscript(projectDir, SESSION, [
      humanPrompt(uuid(1), at(1), 'migrate the cursor store'),
      assistantText(uuid(2), at(2), 'Migrated.'),
      turnEnd(uuid(3), at(3)),
      humanPrompt(uuid(4), at(4), 'now drop the old table'),
      assistantText(uuid(5), at(5), 'Dropped it.'),
    ])

    const first = await hook('stop', input(path))
    expect(first.drain).toMatchObject({ files_sent: 0, remaining: 1, stopped: 'retry_later' })
    const storedFirst = [...stored]
    expect(storedFirst.length).toBe(first.events)
    mode = 'down'
    // One failed send says nothing about the server: only that file backs off.
    const afterFirst = await loadSpoolState(spoolRoot(env))
    expect(afterFirst).toMatchObject({ failures: 0, next_attempt_at: null, last_error: 'backend unavailable' })
    const firstBackoffs = Object.values(afterFirst.files)
    expect(firstBackoffs).toHaveLength(1)
    expect(firstBackoffs[0]).toMatchObject({ attempts: 1, alone: false })
    expect(Date.parse(firstBackoffs[0]!.next_attempt_at)).toBeGreaterThan(Date.now())

    // The session end writes two files and sends them while the first waits
    // out its own backoff. Both fail in a row and neither file is known to fail
    // alone, so the server backs off as a whole and holds every file.
    const requestsBefore = stub.received.length
    const beforeSecond = Date.now()
    const second = await hook('session-end', input(path, { reason: 'logout' }), at(30))
    const afterSecondAt = Date.now()
    expect(second.drain).toMatchObject({ files_sent: 0, remaining: 3, stopped: 'retry_later' })
    expect(stub.received.length).toBe(requestsBefore + 2)
    const afterSecond = await loadSpoolState(spoolRoot(env))
    expect(afterSecond.failures).toBe(1)
    const serverDue = Date.parse(afterSecond.next_attempt_at ?? '')
    expect(serverDue).toBeGreaterThanOrEqual(beforeSecond + DRAIN_BACKOFF_BASE_MS)
    expect(serverDue).toBeLessThanOrEqual(afterSecondAt + DRAIN_BACKOFF_BASE_MS)
    expect(Object.values(afterSecond.files).map((f) => f.attempts)).toEqual([1, 1, 1])
    // A fresh file, which never failed and has no backoff of its own, is
    // held by the server's backoff alone.
    appendEntries(path, SESSION, [humanPrompt(uuid(6), at(40), 'vacuum it too')])
    const heldAt = stub.received.length
    const held = await hook('stop', input(path))
    expect(held.drain).toMatchObject({ files_sent: 0, remaining: 4, stopped: 'backoff' })
    expect(stub.received.length).toBe(heldAt)
    expect(Object.keys((await loadSpoolState(spoolRoot(env))).files)).toHaveLength(3)

    // Once everything is due, the fresh file goes first, having never failed,
    // then the oldest; both fail in a row, so the server's backoff doubles and
    // the other two files are not reached.
    vi.useFakeTimers({ toFake: ['Date'] })
    const dueAfterSecond = Object.values(afterSecond.files).map((f) => Date.parse(f.next_attempt_at))
    vi.setSystemTime(Math.max(Date.parse(afterSecond.next_attempt_at ?? ''), ...dueAfterSecond) + 1_000)
    const third = await hook('drain', {})
    expect(third.drain).toMatchObject({ files_sent: 0, stopped: 'retry_later' })
    const afterThird = await loadSpoolState(spoolRoot(env))
    expect(afterThird.failures).toBe(2)
    expect(Date.parse(afterThird.next_attempt_at ?? '') - Date.now()).toBe(2 * DRAIN_BACKOFF_BASE_MS)
    // Batch file names start with their write time, so key order is age order.
    const attemptsByAge = Object.keys(afterThird.files).sort().map((k) => afterThird.files[k]!.attempts)
    expect(attemptsByAge).toEqual([2, 1, 1, 1])
    expect(stored.size).toBe(storedFirst.length)

    const waiting = spooledUuids()
    mode = 'up'
    const fileDue = Object.values(afterThird.files).map((f) => Date.parse(f.next_attempt_at))
    vi.setSystemTime(Math.max(Date.parse(afterThird.next_attempt_at ?? ''), ...fileDue) + 1_000)
    const fourth = await hook('drain', {})

    expect(fourth.drain).toMatchObject({ remaining: 0, rejected: 0, dead: 0, stopped: null })
    expect(fourth.drain?.duplicates).toBe(storedFirst.length)
    expect(fourth.drain?.accepted).toBe(waiting.length - storedFirst.length)
    expect([...stored].sort()).toEqual([...new Set(waiting)].sort())
    expect(new Set(waiting)).toEqual(new Set([uuid(1), uuid(2), uuid(4), uuid(5), uuid(6), ...sent().filter((e) => e.type === 'session_end').map((e) => e.event_uuid)]))
    expect(batchFiles()).toEqual([])
    expect(await loadSpoolState(spoolRoot(env))).toMatchObject({ failures: 0, next_attempt_at: null, files: {} })
  })
})
