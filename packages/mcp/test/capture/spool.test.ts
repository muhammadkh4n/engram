import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { captureClientInfo, type CaptureEvent } from '../../src/capture/events.js'
import { spoolRoot, writeSpoolBatch } from '../../src/capture/spool.js'
import {
  DRAIN_BACKOFF_BASE_MS,
  DRAIN_LOCK_STALE_MS,
  drainSpool,
  loadSpoolState,
  type SpoolState,
} from '../../src/capture/spool-drain.js'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../src/ingest/private-files.js'
import { captureLogPath } from '../../src/capture/log.js'
import { CAPTURE_FREE_TEXT_MAX_CHARS, USER_PROMPT_TEXT_MAX_CHARS } from '../../src/capture-events/contract.js'
import { acceptAll, type CaptureStub, startCaptureStub } from './stub-server.js'
import { at, TEST_BRANCH, TEST_CWD, uuid } from './transcripts.js'

const PERMISSION_BITS = constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO
const SESSION = '00000000-0000-4000-8000-000000009100'
const TOKEN = 'test-capture-token'
const SECRET = 'zr4-dead-letter-secret-8812'
// A quote, a backslash and a tab: inside a JSON line the value appears only in its escaped spelling.
const ESCAPED_SECRET = 'qk7"dead\\letter\tvalue-3390'
const UNREGISTERED_TOKEN = 'Zq7madeupNotReal91xAbc'
// Eight characters, so its placeholder is longer than the value it masks.
const SHORT_SECRET = 'Kq7wZ3xP'

// The secret registry is built once per process from process.env, on the
// first scrub, so its source must be in place before any test runs.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-spool-registry-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET: SECRET, FIXTURE_ESCAPED_SECRET: ESCAPED_SECRET, FIXTURE_SHORT_SECRET: SHORT_SECRET }))
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

/** The capture log's drain-stop lines. */
function stopLines(): string[] {
  const path = captureLogPath(env)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.includes('spool drain stopped'))
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not met')
}

const sentUuids = (request: CaptureStub['received'][number]) => request.body.events.map((e) => e.event_uuid)

/** A batch file's key in the drainer's state: `<session dir>/<file name>`. */
function fileKey(path: string): string {
  return `${basename(dirname(path))}/${basename(path)}`
}

/** Rewrites the state as it reads `ms` later: every backoff time moves `ms` earlier. */
async function elapse(ms: number): Promise<void> {
  const state = await loadSpoolState(root)
  const earlier = (time: string) => new Date(Date.parse(time) - ms).toISOString()
  const files = Object.fromEntries(
    Object.entries(state.files).map(([key, entry]) => [key, { ...entry, next_attempt_at: earlier(entry.next_attempt_at) }]),
  )
  const next = state.next_attempt_at === null ? null : earlier(state.next_attempt_at)
  writeFileSync(join(root, '.state.json'), JSON.stringify({ ...state, next_attempt_at: next, files }))
}

/** Rewrites the state so the file's own backoff ended a moment ago. */
function expireFileBackoff(state: SpoolState, key: string): void {
  const files = { ...state.files, [key]: { ...state.files[key]!, next_attempt_at: new Date(Date.now() - 1).toISOString() } }
  writeFileSync(join(root, '.state.json'), JSON.stringify({ ...state, files }))
}

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

  it('keeps a file answered 500, doubles its own backoff over two failures and sends nothing inside it', async () => {
    const [path] = await writeSpoolBatch(SESSION, prompts(1, 1), { root })
    const key = fileKey(path!)
    stub.reply = { status: 500, body: { error: 'capture failed', retryable: true } }

    const t1 = Date.now()
    expect((await drainSpool({ env })).stopped).toBe('retry_later')
    const first = await loadSpoolState(root)
    expect(first.failures).toBe(0)
    expect(first.next_attempt_at).toBeNull()
    expect(first.files[key]!.attempts).toBe(1)
    const firstDelay = Date.parse(first.files[key]!.next_attempt_at) - t1
    expect(firstDelay).toBeGreaterThanOrEqual(DRAIN_BACKOFF_BASE_MS)
    expect(firstDelay).toBeLessThan(DRAIN_BACKOFF_BASE_MS + 5_000)

    expect((await drainSpool({ env })).stopped).toBe('backoff')
    expect(stub.received).toHaveLength(1)

    expireFileBackoff(first, key)
    const t2 = Date.now()
    expect((await drainSpool({ env })).stopped).toBe('retry_later')
    const second = await loadSpoolState(root)
    expect(second.files[key]!.attempts).toBe(2)
    const secondDelay = Date.parse(second.files[key]!.next_attempt_at) - t2
    expect(secondDelay).toBeGreaterThanOrEqual(2 * DRAIN_BACKOFF_BASE_MS)
    expect(secondDelay).toBeLessThan(2 * DRAIN_BACKOFF_BASE_MS + 5_000)
    expect(stub.received).toHaveLength(2)
    expect(batchFiles(sessionDir())).toHaveLength(1)
  })

  it('backs off one file a proxy keeps refusing with an HTML 403 and drains the others', async () => {
    const [a] = await writeSpoolBatch(SESSION, [prompt(1)], { root })
    const [b] = await writeSpoolBatch(SESSION, [prompt(2)], { root })
    const [c] = await writeSpoolBatch(SESSION, [prompt(3)], { root })
    stub.reply = (request) =>
      sentUuids(request).includes(uuid(2))
        ? { status: 403, body: null, html: '<html><body><h1>403 Forbidden</h1></body></html>' }
        : acceptAll(request)

    const before = Date.now()
    const result = await drainSpool({ env })
    expect(stub.received.map(sentUuids)).toEqual([[uuid(1)], [uuid(2)], [uuid(3)]])
    expect(result).toMatchObject({ files_sent: 2, accepted: 2, dead: 0, remaining: 1, stopped: 'retry_later' })
    expect(batchFiles(sessionDir())).toEqual([fileKey(b!).split('/')[1]])
    expect(deadLetters()).toEqual([])
    const state = await loadSpoolState(root)
    expect(state.failures).toBe(0)
    expect(state.next_attempt_at).toBeNull()
    expect(Object.keys(state.files)).toEqual([fileKey(b!)])
    expect(state.files[fileKey(b!)]!.attempts).toBe(1)
    expect(Date.parse(state.files[fileKey(b!)]!.next_attempt_at)).toBeGreaterThanOrEqual(before + DRAIN_BACKOFF_BASE_MS)
    expect([a, c].every((p) => !existsSync(p!))).toBe(true)

    // A file inside its own backoff is skipped; once the backoff is over, it is sent and forgotten.
    await writeSpoolBatch(SESSION, [prompt(4)], { root })
    expect(await drainSpool({ env })).toMatchObject({ files_sent: 1, remaining: 1, stopped: null })
    expect(stub.received.slice(3).map(sentUuids)).toEqual([[uuid(4)]])
    expireFileBackoff(await loadSpoolState(root), fileKey(b!))
    stub.reply = acceptAll
    expect(await drainSpool({ env })).toMatchObject({ files_sent: 1, remaining: 0, stopped: null })
    expect((await loadSpoolState(root)).files).toEqual({})
  })

  it('stops after two files with the global backoff when every file is answered 502, keeping both files\' backoffs', async () => {
    const paths: string[] = []
    for (let n = 1; n <= 4; n++) paths.push(...(await writeSpoolBatch(SESSION, [prompt(n)], { root })))
    stub.reply = { status: 502, body: null, html: '<html><body><h1>502 Bad Gateway</h1></body></html>' }

    const before = Date.now()
    const result = await drainSpool({ env })
    expect(stub.received.map(sentUuids)).toEqual([[uuid(1)], [uuid(2)]])
    expect(result).toMatchObject({ files_sent: 0, dead: 0, remaining: 4, stopped: 'retry_later' })
    const state = await loadSpoolState(root)
    expect(state.failures).toBe(1)
    expect(Date.parse(state.next_attempt_at!)).toBeGreaterThanOrEqual(before + DRAIN_BACKOFF_BASE_MS)
    expect(Object.keys(state.files).sort()).toEqual([fileKey(paths[0]!), fileKey(paths[1]!)].sort())

    expect((await drainSpool({ env })).stopped).toBe('backoff')
    expect(stub.received).toHaveLength(2)

    // Once the server's backoff is over, a drain still sends at most two requests.
    await elapse(DRAIN_BACKOFF_BASE_MS + 1_000)
    expect((await drainSpool({ env })).stopped).toBe('retry_later')
    expect(stub.received.slice(2).map(sentUuids)).toEqual([[uuid(3)], [uuid(4)]])
    expect(Object.keys((await loadSpoolState(root)).files)).toHaveLength(4)
  })

  it('sends the good files behind three adjacent files a proxy keeps refusing, and never undoes a file\'s backoff', async () => {
    const paths: string[] = []
    for (let n = 1; n <= 5; n++) paths.push(...(await writeSpoolBatch(SESSION, [prompt(n)], { root })))
    const refused = new Set([uuid(1), uuid(2), uuid(3)])
    stub.reply = (request) =>
      sentUuids(request).some((u) => refused.has(u as string))
        ? { status: 403, body: null, html: '<html><body><h1>403 Forbidden</h1></body></html>' }
        : acceptAll(request)
    const refusedKeys = paths.slice(0, 3).map(fileKey).sort()

    expect((await drainSpool({ env })).stopped).toBe('retry_later')
    expect(stub.received.map(sentUuids)).toEqual([[uuid(1)], [uuid(2)]])
    const first = await loadSpoolState(root)
    expect(first.failures).toBe(1)
    expect(Object.keys(first.files).sort()).toEqual(refusedKeys.slice(0, 2))

    for (let drain = 2; drain <= 3; drain++) {
      await elapse(DRAIN_BACKOFF_BASE_MS + 1_000)
      await drainSpool({ env })
    }

    const sent = stub.received.flatMap(sentUuids)
    expect(sent).toEqual(expect.arrayContaining([uuid(4), uuid(5)]))
    expect(batchFiles(sessionDir())).toEqual(paths.slice(0, 3).map((p) => basename(p)))
    const last = await loadSpoolState(root)
    expect(Object.keys(last.files).sort()).toEqual(refusedKeys)
    expect(last.files[fileKey(paths[0]!)]!.attempts).toBe(2)
    expect(deadLetters()).toEqual([])
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

  it.each([408, 425, 499])('keeps the file and backs off on a %i, which only a proxy answers', async (status) => {
    await writeSpoolBatch(SESSION, prompts(1, 2), { root })
    stub.reply = { status, body: { error: 'upstream timed out' } }
    const result = await drainSpool({ env })
    expect(result).toMatchObject({ files_sent: 0, dead: 0, remaining: 1, stopped: 'retry_later' })
    expect(deadLetters()).toEqual([])
    const state = await loadSpoolState(root)
    expect(state.failures).toBe(0)
    expect(Object.values(state.files).map((f) => f.attempts)).toEqual([1])
  })

  it('keeps the file on a 400 that is not the route\'s JSON error', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 2), { root })
    stub.reply = { status: 400, body: null, html: '<html><body><h1>400 Bad Request</h1></body></html>' }
    expect(await drainSpool({ env })).toMatchObject({ dead: 0, remaining: 1, stopped: 'retry_later' })

    writeFileSync(join(root, '.state.json'), JSON.stringify({ ...(await loadSpoolState(root)), files: {} }))
    stub.reply = { status: 400, body: { message: 'bad request' } }
    expect(await drainSpool({ env })).toMatchObject({ dead: 0, remaining: 1, stopped: 'retry_later' })
    expect(deadLetters()).toEqual([])
    expect(batchFiles(sessionDir())).toHaveLength(1)
  })

  it('keeps a one-event file answered 413 by a proxy page', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    stub.reply = { status: 413, body: null, html: '<html><body><h1>413 Request Entity Too Large</h1></body></html>' }
    expect(await drainSpool({ env })).toMatchObject({ dead: 0, remaining: 1, stopped: 'retry_later' })
    expect(deadLetters()).toEqual([])
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

  it('stops with bad_url on a server URL without a scheme, keeps the files and records no URL text', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    for (const serverUrl of ['rexvps:3850', 'tst-user:tst-pass@rexvps:3850/mcp', 'not a url']) {
      const result = await drainSpool({ env: { ...env, ENGRAM_SERVER_URL: serverUrl } })
      expect(result).toMatchObject({ stopped: 'bad_url', remaining: 1 })
      expect(stub.received).toHaveLength(0)
      const state = await loadSpoolState(root)
      expect(state.last_error).toBe('bad_url')
      expect(state.next_attempt_at).toBeNull()
      const raw = readFileSync(join(root, '.state.json'), 'utf8')
      expect(raw).not.toContain('rexvps')
      expect(raw).not.toContain('tst-pass')
    }
  })

  it('logs a repeated bad_url stop once and writes its state once', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    const badEnv = { ...env, ENGRAM_SERVER_URL: 'rexvps:3850' }
    await drainSpool({ env: badEnv })
    const firstState = readFileSync(join(root, '.state.json'), 'utf8')
    await drainSpool({ env: badEnv })
    const result = await drainSpool({ env: badEnv })
    expect(result).toMatchObject({ stopped: 'bad_url', remaining: 1 })
    expect(stopLines()).toHaveLength(1)
    expect(readFileSync(join(root, '.state.json'), 'utf8')).toBe(firstState)
  })

  it('logs a stop again after a drain gets through', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    const badEnv = { ...env, ENGRAM_SERVER_URL: 'rexvps:3850' }
    await drainSpool({ env: badEnv })
    expect(await drainSpool({ env })).toMatchObject({ files_sent: 1, remaining: 0 })
    await writeSpoolBatch(SESSION, [prompt(2)], { root })
    await drainSpool({ env: badEnv })
    expect(stopLines()).toHaveLength(2)
  })

  it('logs a stop again when a different condition came between', async () => {
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    const badEnv = { ...env, ENGRAM_SERVER_URL: 'rexvps:3850' }
    await drainSpool({ env: badEnv })
    stub.reply = { status: 200, body: { accepted: 0, duplicates: 0, rejected: [] } }
    expect((await drainSpool({ env })).stopped).toBe('ack_mismatch')
    await drainSpool({ env: badEnv })
    expect(stopLines().map((l) => l.replace(/^\S+ /, ''))).toEqual([
      'spool drain stopped: bad_url',
      'spool drain stopped: ack_mismatch',
      'spool drain stopped: bad_url',
    ])
  })

  it('keeps a standing stop through a drain that only dead-letters locally', async () => {
    mkdirSync(sessionDir(), { recursive: true })
    writeFileSync(join(sessionDir(), '0000000000001-1-00000000.jsonl'), '{not json\n')
    const badEnv = { ...env, ENGRAM_SERVER_URL: 'rexvps:3850' }
    await drainSpool({ env: badEnv })
    expect(await drainSpool({ env })).toMatchObject({ dead: 1, remaining: 0 })
    expect(stub.received).toHaveLength(0)
    await writeSpoolBatch(SESSION, [prompt(1)], { root })
    expect((await drainSpool({ env: badEnv })).stopped).toBe('bad_url')
    expect(stopLines()).toHaveLength(1)
  })

  it('logs a repeated ack_mismatch once', async () => {
    await writeSpoolBatch(SESSION, prompts(1, 2), { root })
    stub.reply = { status: 200, body: { accepted: 1, duplicates: 0, rejected: [] } }
    for (let i = 0; i < 3; i++) expect((await drainSpool({ env })).stopped).toBe('ack_mismatch')
    expect(stopLines()).toHaveLength(1)
  })

  it('re-fits a cap-length prompt whose value the drain masks into a longer placeholder', async () => {
    const text = `${'a'.repeat(USER_PROMPT_TEXT_MAX_CHARS - SHORT_SECRET.length)}${SHORT_SECRET}`
    await writeSpoolBatch(SESSION, [{ ...prompt(1), payload: { text, transcript_line: 1 } }], { root })
    const result = await drainSpool({ env })
    expect(result).toMatchObject({ files_sent: 1, accepted: 1, dead: 0, remaining: 0 })
    const sent = stub.received[0]!.body.events[0]!.payload as { text: string; truncated?: boolean }
    expect(sent.text.length).toBeLessThanOrEqual(USER_PROMPT_TEXT_MAX_CHARS)
    expect(sent.text).toBe('a'.repeat(USER_PROMPT_TEXT_MAX_CHARS - SHORT_SECRET.length))
    expect(sent.truncated).toBe(true)
  })

  it('re-fits a cap-length assistant text whose value the drain masks into a longer placeholder', async () => {
    const text = `${SHORT_SECRET}${'a'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS - SHORT_SECRET.length)}`
    const turn: CaptureEvent = { ...prompt(1), type: 'assistant_turn', payload: { text, transcript_line: 1, tools: [] } }
    await writeSpoolBatch(SESSION, [turn], { root })
    const result = await drainSpool({ env })
    expect(result).toMatchObject({ files_sent: 1, accepted: 1, dead: 0, remaining: 0 })
    const sent = stub.received[0]!.body.events[0]!.payload as { text: string }
    expect(sent.text.length).toBe(CAPTURE_FREE_TEXT_MAX_CHARS)
    expect(sent.text.startsWith('[REDACTED:')).toBe(true)
    expect(sent.text).not.toContain(SHORT_SECRET)
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

  it.each([
    ['too-deep', (): unknown => {
      let deep: unknown = `leaf ${SECRET}`
      for (let i = 0; i < 200; i++) deep = [deep]
      return { cwd: '/home/tester', deep }
    }],
    ['key-collision', (): unknown => ({ cwd: '/home/tester', [SECRET]: 'a', '[REDACTED:FIXTURE_SECRET]': 'b' })],
    // A made-up bearer token that is not registered: only the whole-text pass reads it beside its header name.
    ['missed-by-walk', (): unknown => ({ cwd: '/home/tester', headers: [['Authorization', `Bearer ${UNREGISTERED_TOKEN}`]], note: SECRET })],
  ])('keeps only the length and sha256 of a parseable line the walk refuses (%s)', async (_reason, build) => {
    const [path] = await writeSpoolBatch(SESSION, [prompt(2)], { root })
    const malformed = JSON.stringify(build())
    writeFileSync(path!, `${malformed}\n${readFileSync(path!, 'utf8')}`)

    const result = await drainSpool({ env })

    expect(result).toMatchObject({ files_sent: 1, accepted: 1, dead: 1, remaining: 0 })
    const [letter] = deadLetters() as unknown as Array<Record<string, unknown>>
    expect(letter).toEqual({
      at: expect.any(String),
      reason: 'unscrubbable_event',
      length: malformed.length,
      sha256: createHash('sha256').update(malformed, 'utf8').digest('hex'),
    })
    const written = readFileSync(join(root, '.dead', `${SESSION}.jsonl`), 'utf8')
    expect(written).not.toContain(SECRET)
    expect(written).not.toContain(UNREGISTERED_TOKEN)
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
