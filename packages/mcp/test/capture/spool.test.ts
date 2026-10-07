import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureClientInfo, type CaptureEvent } from '../../src/capture/events.js'
import {
  DRAIN_BACKOFF_BASE_MS,
  DRAIN_LOCK_STALE_MS,
  drainSpool,
  loadSpoolState,
  spoolRoot,
  writeSpoolBatch,
} from '../../src/capture/spool.js'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../src/ingest/private-files.js'
import { acceptAll, type CaptureStub, startCaptureStub } from './stub-server.js'
import { at, TEST_BRANCH, TEST_CWD, uuid } from './transcripts.js'

const PERMISSION_BITS = constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO
const SESSION = '00000000-0000-4000-8000-000000009100'
const TOKEN = 'test-capture-token'
const SECRET = 'zr4-dead-letter-secret-8812'
// A quote, a backslash and a tab: inside a JSON line the value appears only in its escaped spelling.
const ESCAPED_SECRET = 'qk7"dead\\letter\tvalue-3390'

// The secret registry is built once per process from process.env, on the
// first scrub, so its source must be in place before any test runs.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-spool-registry-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET: SECRET, FIXTURE_ESCAPED_SECRET: ESCAPED_SECRET }))
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
let stub: CaptureStub
let env: Record<string, string>
let root: string

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'engram-spool-'))
  stub = await startCaptureStub()
  mkdirSync(join(home, 'secrets'))
  writeFileSync(join(home, 'secrets', 'capture-token'), `${TOKEN}\n`)
  env = { HOME: home, ENGRAM_SERVER_URL: stub.url, ENGRAM_CAPTURE_TOKEN_FILE: '~/secrets/capture-token' }
  root = spoolRoot(env)
})

afterEach(async () => {
  await stub.close()
  rmSync(home, { recursive: true, force: true })
})

function prompt(n: number, sessionId = SESSION): CaptureEvent {
  return {
    session_id: sessionId,
    event_uuid: uuid(n),
    type: 'user_prompt',
    occurred_at: at(n),
    cwd: TEST_CWD,
    project: { id: 'sample-repo', workspace: null, repo_root: TEST_CWD, branch: TEST_BRANCH, worktree: null },
    plan_dirs: [],
    payload: { text: `prompt number ${n}`, transcript_line: n },
  }
}

function prompts(from: number, count: number, sessionId = SESSION): CaptureEvent[] {
  return Array.from({ length: count }, (_, i) => prompt(from + i, sessionId))
}

function batchFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : []
}

function sessionDir(): string {
  return join(root, SESSION)
}

function deadLetters(): Array<{ at: string; status?: number; reason: string; event: CaptureEvent }> {
  const path = join(root, '.dead', `${SESSION}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not met')
}

const sentUuids = (request: CaptureStub['received'][number]) => request.body.events.map((e) => e.event_uuid)

describe('writeSpoolBatch', () => {
  it('writes owner-only batch files of at most 500 events, named by time, pid and random hex', async () => {
    const paths = await writeSpoolBatch(SESSION, prompts(1, 600), { root })
    expect(paths).toHaveLength(2)
    const names = batchFiles(sessionDir())
    expect(names).toHaveLength(2)
    for (const name of names) expect(name).toMatch(/^\d{13}-\d+-[0-9a-f]{8}\.jsonl$/)
    const counts = names.map((n) => readFileSync(join(sessionDir(), n), 'utf8').trimEnd().split('\n').length)
    expect(counts).toEqual([500, 100])
    const first = JSON.parse(readFileSync(join(sessionDir(), names[0]!), 'utf8').split('\n')[0]!)
    expect(first.event_uuid).toBe(uuid(1))
    expect(statSync(root).mode & PERMISSION_BITS).toBe(PRIVATE_DIR_MODE)
    expect(statSync(sessionDir()).mode & PERMISSION_BITS).toBe(PRIVATE_DIR_MODE)
    for (const path of paths) expect(statSync(path).mode & PERMISSION_BITS).toBe(PRIVATE_FILE_MODE)
    expect(readdirSync(sessionDir()).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('writes a session id that starts with a dot under a %2E directory', async () => {
    await writeSpoolBatch('.x', [prompt(1, '.x')], { root })
    expect(readdirSync(root)).toEqual(['%2Ex'])
  })

  it('writes nothing for no events', async () => {
    expect(await writeSpoolBatch(SESSION, [], { root })).toEqual([])
    expect(existsSync(root)).toBe(false)
  })
})

describe('drainSpool', () => {
  it('sends the capture token and the client, and deletes a fully acknowledged file', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 2), { root })
    const result = await drainSpool({ env })
    expect(stub.received).toHaveLength(1)
    const [request] = stub.received
    expect(request!.method).toBe('POST')
    expect(request!.path).toBe('/capture/events')
    expect(request!.authorization).toBe(`Bearer ${TOKEN}`)
    expect(request!.body.client).toEqual(captureClientInfo())
    expect(sentUuids(request!)).toEqual([uuid(1), uuid(2)])
    expect(result).toEqual({ files_sent: 1, accepted: 2, duplicates: 0, rejected: 0, dead: 0, remaining: 0, stopped: null })
    expect(batchFiles(sessionDir())).toEqual([])
    const state = await loadSpoolState(root)
    expect(state.failures).toBe(0)
    expect(state.last_ack_at).not.toBeNull()
  })

  it('sends nothing without a token file and records the backoff', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 1), { root })
    const before = Date.now()
    const { ENGRAM_CAPTURE_TOKEN_FILE: _unused, ...noToken } = env
    const result = await drainSpool({ env: noToken })
    expect(stub.received).toHaveLength(0)
    expect(result.stopped).toBe('no_token')
    expect(result.remaining).toBe(1)
    const state = await loadSpoolState(root)
    expect(state.failures).toBe(1)
    expect(state.last_error).toMatch(/^no_token/)
    expect(Date.parse(state.next_attempt_at!)).toBeGreaterThanOrEqual(before + DRAIN_BACKOFF_BASE_MS)
  })

  it('sends a caller-named client and reads only the root it is given', async () => {
    const backfillRoot = join(home, 'backfill-spool')
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    await writeSpoolBatch(SESSION, [prompt(2)], { root: backfillRoot })
    const result = await drainSpool({ env, root: backfillRoot, client: { name: 'engram-backfill', version: '9.9.9' } })
    expect(result.files_sent).toBe(1)
    expect(stub.received).toHaveLength(1)
    expect(stub.received[0]!.body.client).toEqual({ name: 'engram-backfill', version: '9.9.9' })
    expect(sentUuids(stub.received[0]!)).toEqual([uuid(2)])
    expect(batchFiles(sessionDir())).toHaveLength(1)
  })

  it('deletes a file whose accepted, duplicate and rejected counts cover it, dead-lettering the rejected event', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 3), { root })
    stub.reply = {
      status: 200,
      body: {
        accepted: 1,
        duplicates: 1,
        rejected: [{ index: 2, session_id: SESSION, event_uuid: uuid(3), reason: 'payload.text: must not be blank' }],
      },
    }
    const result = await drainSpool({ env })
    expect(result).toMatchObject({ files_sent: 1, accepted: 1, duplicates: 1, rejected: 1, dead: 1, remaining: 0 })
    expect(batchFiles(sessionDir())).toEqual([])
    const dead = deadLetters()
    expect(dead).toHaveLength(1)
    expect(dead[0]!.reason).toBe('payload.text: must not be blank')
    expect(dead[0]!.event.event_uuid).toBe(uuid(3))
    expect(dead[0]!.status).toBeUndefined()
  })

  it('keeps a file whose counts fall short and records ack_mismatch', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 2), { root })
    stub.reply = { status: 200, body: { accepted: 1, duplicates: 0, rejected: [] } }
    const result = await drainSpool({ env })
    expect(result.stopped).toBe('ack_mismatch')
    expect(result.remaining).toBe(1)
    expect(batchFiles(sessionDir())).toHaveLength(1)
    expect((await loadSpoolState(root)).last_error).toBe('ack_mismatch')
  })

  it('keeps the file on a 500, doubles the backoff over two failures and sends nothing inside it', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 1), { root })
    stub.reply = { status: 500, body: { error: 'capture failed', retryable: true } }

    const t1 = Date.now()
    expect((await drainSpool({ env })).stopped).toBe('retry_later')
    const first = await loadSpoolState(root)
    expect(first.failures).toBe(1)
    const firstDelay = Date.parse(first.next_attempt_at!) - t1
    expect(firstDelay).toBeGreaterThanOrEqual(DRAIN_BACKOFF_BASE_MS)
    expect(firstDelay).toBeLessThan(DRAIN_BACKOFF_BASE_MS + 5_000)

    expect((await drainSpool({ env })).stopped).toBe('backoff')
    expect(stub.received).toHaveLength(1)

    writeFileSync(join(root, '.state.json'), JSON.stringify({ ...first, next_attempt_at: new Date(Date.now() - 1).toISOString() }))
    const t2 = Date.now()
    expect((await drainSpool({ env })).stopped).toBe('retry_later')
    const second = await loadSpoolState(root)
    expect(second.failures).toBe(2)
    const secondDelay = Date.parse(second.next_attempt_at!) - t2
    expect(secondDelay).toBeGreaterThanOrEqual(2 * DRAIN_BACKOFF_BASE_MS)
    expect(secondDelay).toBeLessThan(2 * DRAIN_BACKOFF_BASE_MS + 5_000)
    expect(stub.received).toHaveLength(2)
    expect(batchFiles(sessionDir())).toHaveLength(1)
  })

  it('dead-letters every event of a file answered 400, with the status and the error', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 2), { root })
    stub.reply = { status: 400, body: { error: 'events: must hold 1 to 500 items' } }
    const result = await drainSpool({ env })
    expect(result).toMatchObject({ files_sent: 0, dead: 2, remaining: 0, stopped: null })
    expect(batchFiles(sessionDir())).toEqual([])
    const dead = deadLetters()
    expect(dead.map((d) => d.event.event_uuid)).toEqual([uuid(1), uuid(2)])
    expect(dead.every((d) => d.status === 400 && d.reason === 'events: must hold 1 to 500 items')).toBe(true)
  })

  it('splits a file answered 413 into two halves and sends both', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 4), { root })
    stub.reply = (request) => (request.body.events.length > 2 ? { status: 413, body: { error: 'too large' } } : acceptAll(request))
    const result = await drainSpool({ env })
    expect(stub.received.map((r) => r.body.events.length)).toEqual([4, 2, 2])
    expect(stub.received.slice(1).flatMap(sentUuids)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)])
    expect(result).toMatchObject({ files_sent: 2, accepted: 4, dead: 0, remaining: 0, stopped: null })
    expect(readdirSync(sessionDir())).toEqual([])
  })

  it('dead-letters a one-event file answered 413 with status 413', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    stub.reply = { status: 413, body: { error: 'too large' } }
    const result = await drainSpool({ env })
    expect(result).toMatchObject({ dead: 1, remaining: 0, stopped: null })
    expect(deadLetters()).toMatchObject([{ status: 413, reason: 'too large', event: { event_uuid: uuid(1) } }])
  })

  it('lets one drainer send while a concurrent one returns locked', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    stub.hold = true
    const first = drainSpool({ env })
    await until(() => stub.received.length === 1)
    const second = await drainSpool({ env })
    expect(second.stopped).toBe('locked')
    expect(second.remaining).toBe(1)
    stub.release()
    expect((await first).files_sent).toBe(1)
    expect(stub.received).toHaveLength(1)
  })

  it('sends a file written during the drain in a second pass', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    stub.hold = true
    const drain = drainSpool({ env })
    await until(() => stub.received.length === 1)
    await writeSpoolBatch(SESSION, [prompt(2)], { root })
    stub.release()
    const result = await drain
    expect(stub.received.map(sentUuids)).toEqual([[uuid(1)], [uuid(2)]])
    expect(result).toMatchObject({ files_sent: 2, remaining: 0, stopped: null })
  })

  it('deletes a temp file a crashed writer left long ago and leaves a fresh one alone', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    const stale = join(sessionDir(), '.0000000000001-1-aaaaaaaa.jsonl.tmp')
    const fresh = join(sessionDir(), '.0000000000002-1-bbbbbbbb.jsonl.tmp')
    writeFileSync(stale, `${JSON.stringify(prompt(8))}\n`)
    writeFileSync(fresh, `${JSON.stringify(prompt(9))}\n`)
    const longAgo = (Date.now() - 11 * 60_000) / 1000
    utimesSync(stale, longAgo, longAgo)
    const result = await drainSpool({ env })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(stub.received.flatMap(sentUuids)).toEqual([uuid(1)])
    expect(result.remaining).toBe(0)
  })

  it('sends nothing and keeps the files when no server URL is set', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    const { ENGRAM_SERVER_URL: _unused, ...noUrl } = env
    const result = await drainSpool({ env: noUrl })
    expect(result).toMatchObject({ stopped: 'no_url', remaining: 1 })
    expect(stub.received).toHaveLength(0)
  })

  it('starts no request once the deadline has passed', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    const result = await drainSpool({ env, deadlineMs: Date.now() - 1 })
    expect(result).toMatchObject({ stopped: 'deadline', remaining: 1 })
    expect(stub.received).toHaveLength(0)
  })

  it('dead-letters a line that is not JSON and sends the rest', async () => {
    const [path] = await writeSpoolBatch(SESSION, [prompt(1)], { root })
    writeFileSync(path!, `{not json\n${readFileSync(path!, 'utf8')}`)
    const result = await drainSpool({ env })
    expect(result).toMatchObject({ files_sent: 1, accepted: 1, dead: 1, remaining: 0 })
    expect(deadLetters()).toMatchObject([{ reason: 'invalid_json', event: '{not json' }])
  })

  it('masks a registered value in a truncated line before dead-lettering it', async () => {
    const line = JSON.stringify({ ...prompt(1), payload: { text: `use the key ${SECRET} for the replica`, transcript_line: 1 } })
    const cut = line.slice(0, line.indexOf(SECRET) + SECRET.length + 5)
    const [path] = await writeSpoolBatch(SESSION, [prompt(2)], { root })
    writeFileSync(path!, `${cut}\n${readFileSync(path!, 'utf8')}`)

    const result = await drainSpool({ env })

    expect(result).toMatchObject({ files_sent: 1, accepted: 1, dead: 1, remaining: 0 })
    const [letter] = deadLetters() as unknown as Array<{ reason: string; event: string }>
    expect(letter!.reason).toBe('invalid_json')
    expect(letter!.event).toContain('use the key [')
    expect(letter!.event).not.toContain(SECRET)
    expect(readFileSync(join(root, '.dead', `${SESSION}.jsonl`), 'utf8')).not.toContain(SECRET)
  })

  it('masks a registered value holding a quote, a backslash and a tab in a truncated line', async () => {
    const line = JSON.stringify({ ...prompt(1), payload: { text: `the replica key is ${ESCAPED_SECRET} today`, transcript_line: 1 } })
    const escaped = JSON.stringify(ESCAPED_SECRET).slice(1, -1)
    expect(line).toContain(escaped)
    const cut = line.slice(0, line.indexOf(escaped) + escaped.length + 3)
    const [path] = await writeSpoolBatch(SESSION, [prompt(2)], { root })
    writeFileSync(path!, `${cut}\n${readFileSync(path!, 'utf8')}`)

    const result = await drainSpool({ env })

    expect(result).toMatchObject({ files_sent: 1, accepted: 1, dead: 1, remaining: 0 })
    const [letter] = deadLetters() as unknown as Array<{ reason: string; event: string }>
    expect(letter!.reason).toBe('invalid_json')
    expect(letter!.event).toContain('the replica key is [')
    expect(letter!.event).not.toContain(escaped)
    const written = readFileSync(join(root, '.dead', `${SESSION}.jsonl`), 'utf8')
    expect(written).not.toContain(JSON.stringify(escaped).slice(1, -1))
  })

  it('masks a registered value in a line scrubbing cannot walk before dead-lettering it', async () => {
    const [path] = await writeSpoolBatch(SESSION, [prompt(2)], { root })
    const malformed = JSON.stringify({ cwd: `/home/tester/${SECRET}` })
    writeFileSync(path!, `${malformed}\n${readFileSync(path!, 'utf8')}`)

    const result = await drainSpool({ env })

    expect(result).toMatchObject({ files_sent: 1, accepted: 1, dead: 1, remaining: 0 })
    const [letter] = deadLetters() as unknown as Array<{ reason: string; event: string }>
    expect(letter!.reason).toBe('unscrubbable_event')
    expect(typeof letter!.event).toBe('string')
    expect(letter!.event).not.toContain(SECRET)
    expect(readFileSync(join(root, '.dead', `${SESSION}.jsonl`), 'utf8')).not.toContain(SECRET)
  })

  it('masks a token after an escaped newline in a parseable line before dead-lettering it', async () => {
    const token = 'sk-ant-oat01-' + 'Q7xk2Lm9Vp4Rt8Wz'.repeat(4)
    const [path] = await writeSpoolBatch(SESSION, [prompt(2)], { root })
    const malformed = JSON.stringify({ cwd: '/home/tester', text: `run this first\n${token}` })
    expect(malformed).toContain(`\\n${token}`)
    writeFileSync(path!, `${malformed}\n${readFileSync(path!, 'utf8')}`)

    const result = await drainSpool({ env })

    expect(result).toMatchObject({ files_sent: 1, accepted: 1, dead: 1, remaining: 0 })
    const [letter] = deadLetters() as unknown as Array<{ reason: string; event: string }>
    expect(letter!.reason).toBe('unscrubbable_event')
    expect(JSON.parse(letter!.event)).toEqual({ cwd: '/home/tester', text: 'run this first\n[REDACTED:anthropic-key]' })
    expect(readFileSync(join(root, '.dead', `${SESSION}.jsonl`), 'utf8')).not.toContain(token)
  })

  it('refreshes its lock before each file, so a drain past the stale age keeps it', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    await writeSpoolBatch(SESSION, [prompt(2)], { root })
    const lockPath = join(root, '.drain.lock')
    stub.hold = true
    const first = drainSpool({ env })
    await until(() => stub.received.length === 1)
    // The first request has taken longer than the lock's stale age.
    const longAgo = new Date(Date.now() - DRAIN_LOCK_STALE_MS - 1_000)
    utimesSync(lockPath, longAgo, longAgo)
    stub.release()
    stub.hold = true
    await until(() => stub.received.length === 2)
    expect(Date.now() - statSync(lockPath).mtimeMs).toBeLessThan(DRAIN_LOCK_STALE_MS)

    stub.hold = false
    const second = await drainSpool({ env })

    expect(second.stopped).toBe('locked')
    stub.release()
    expect(await first).toMatchObject({ files_sent: 2, remaining: 0, stopped: null })
    expect(stub.received).toHaveLength(2)
  })

  it('stops before its next file once another drainer has taken its lock over', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    await writeSpoolBatch(SESSION, [prompt(2)], { root })
    await writeSpoolBatch(SESSION, [prompt(3)], { root })
    const lockPath = join(root, '.drain.lock')
    stub.hold = true
    const first = drainSpool({ env })
    await until(() => stub.received.length === 1)
    writeFileSync(lockPath, 'another-holder\n')
    stub.release()

    const result = await first

    expect(result).toMatchObject({ files_sent: 1, remaining: 2, stopped: 'lock_lost' })
    expect(stub.received).toHaveLength(1)
    expect(readFileSync(lockPath, 'utf8')).toBe('another-holder\n')
  })
})
