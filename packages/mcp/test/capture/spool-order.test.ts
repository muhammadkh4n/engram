import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { CaptureEvent } from '../../src/capture/events.js'
import { spoolRoot, writeSpoolBatch } from '../../src/capture/spool.js'
import {
  DRAIN_BACKOFF_BASE_MS,
  DRAIN_BACKOFF_MAX_MS,
  drainSpool,
  loadSpoolState,
  type SpoolState,
} from '../../src/capture/spool-drain.js'
import {
  acceptAll,
  type CaptureStub,
  type CaptureStubReply,
  type CaptureStubResponder,
  startCaptureStub,
} from './stub-server.js'
import { at, TEST_BRANCH, TEST_CWD, uuid } from './transcripts.js'

const SESSION = '00000000-0000-4000-8000-000000009500'
const TOKEN = 'test-capture-token'
const PROXY_403: CaptureStubReply = { status: 403, body: null, html: '<html><body><h1>403 Forbidden</h1></body></html>' }
const PROXY_502: CaptureStubReply = { status: 502, body: null, html: '<html><body><h1>502 Bad Gateway</h1></body></html>' }
/** Longer than the longest backoff, so every window, the server's and each file's, is over. */
const PAST_EVERY_WINDOW_MS = DRAIN_BACKOFF_MAX_MS + 1_000

// The secret registry is built once per process from process.env, on the
// first scrub; pointing it at an empty source keeps the caller's own
// registry out of these tests.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-spool-order-registry-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({}))
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
  home = mkdtempSync(join(tmpdir(), 'engram-spool-order-'))
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

function prompt(n: number): CaptureEvent {
  return {
    session_id: SESSION,
    event_uuid: uuid(n),
    type: 'user_prompt',
    occurred_at: at(n),
    cwd: TEST_CWD,
    project: { id: 'sample-repo', workspace: null, repo_root: TEST_CWD, branch: TEST_BRANCH, worktree: null },
    plan_dirs: [],
    payload: { text: `prompt number ${n}`, transcript_line: n },
  }
}

/** One one-event batch file per prompt number, written in that order. */
async function writeOneEventFiles(numbers: readonly number[]): Promise<string[]> {
  const paths: string[] = []
  for (const n of numbers) paths.push(...(await writeSpoolBatch(SESSION, [prompt(n)], { root })))
  return paths
}

/** A batch file's key in the drainer's state: `<session dir>/<file name>`. */
function fileKey(path: string): string {
  return `${basename(dirname(path))}/${basename(path)}`
}

const sentUuids = (request: CaptureStub['received'][number]) => request.body.events.map((e) => e.event_uuid)

/** A proxy refusing every request that carries one of `refused` with an HTML 403; the route accepts the rest. */
function refusing(refused: ReadonlySet<string>): CaptureStubResponder {
  return (request) => (sentUuids(request).some((u) => refused.has(u as string)) ? PROXY_403 : acceptAll(request))
}

function deadLetterCount(): number {
  const path = join(root, '.dead', `${SESSION}.jsonl`)
  return existsSync(path) ? readFileSync(path, 'utf8').trimEnd().split('\n').length : 0
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

/**
 * Two files a proxy refuses, then a good file the route accepts, listed
 * in that order. Each has a backoff entry that ended a moment ago. Without
 * `alone`, the entries are written as a state file from before that field
 * existed.
 */
async function refusedRefusedGood(
  attempts: readonly [number, number, number],
  alone?: readonly [boolean, boolean, boolean],
): Promise<{ p1: string; g: string }> {
  const paths = await writeOneEventFiles([1, 2, 3])
  const expired = new Date(Date.now() - 1).toISOString()
  const entry = (i: number) =>
    alone === undefined
      ? { attempts: attempts[i], next_attempt_at: expired }
      : { attempts: attempts[i], next_attempt_at: expired, alone: alone[i] }
  const files = Object.fromEntries(paths.map((p, i) => [fileKey(p), entry(i)]))
  const state = {
    v: 1,
    last_ack_at: null,
    last_error_at: null,
    last_error: null,
    failures: 0,
    next_attempt_at: null,
    files,
    standing_stop: null,
  }
  writeFileSync(join(root, '.state.json'), JSON.stringify(state))
  stub.reply = refusing(new Set([uuid(1), uuid(2)]))
  return { p1: paths[0]!, g: paths[2]! }
}

describe('drainSpool send order', () => {
  it('reads a backoff entry without `alone` as not known to fail alone', async () => {
    const { p1 } = await refusedRefusedGood([1, 1, 1])
    const state = await loadSpoolState(root)
    expect(state.files[fileKey(p1)]).toEqual({ attempts: 1, next_attempt_at: expect.any(String), alone: false })
  })

  it('acks a good file listed behind two refused files that failed more often, without raising the server\'s backoff', async () => {
    const { g } = await refusedRefusedGood([2, 2, 1])

    const result = await drainSpool({ env })

    expect(existsSync(g)).toBe(false)
    expect(stub.received.map(sentUuids)[0]).toEqual([uuid(3)])
    expect(result).toMatchObject({ files_sent: 1, dead: 0, remaining: 2, stopped: 'retry_later' })
    const state = await loadSpoolState(root)
    expect(state.failures).toBe(0)
    expect(state.next_attempt_at).toBeNull()
    expect(Object.values(state.files).map((f) => f.alone)).toEqual([true, true])
  })

  it('acks a good file listed behind two refused files with equal attempts by the second drain', async () => {
    const { g } = await refusedRefusedGood([1, 1, 1])

    await drainSpool({ env })
    await elapse(PAST_EVERY_WINDOW_MS)
    await drainSpool({ env })

    expect(existsSync(g)).toBe(false)
    expect(deadLetterCount()).toBe(0)
  })

  it('acks a good file known to fail alone behind two refused files never marked so, then stops raising the server\'s backoff', async () => {
    const { g } = await refusedRefusedGood([2, 2, 1], [false, false, true])

    for (let drain = 0; drain < 2 && existsSync(g); drain++) {
      await elapse(PAST_EVERY_WINDOW_MS)
      await drainSpool({ env })
    }

    expect(existsSync(g)).toBe(false)
    expect(deadLetterCount()).toBe(0)
    const failuresAtAck = (await loadSpoolState(root)).failures
    for (let drain = 0; drain < 3; drain++) {
      await elapse(PAST_EVERY_WINDOW_MS)
      await drainSpool({ env })
      expect((await loadSpoolState(root)).failures).toBeLessThanOrEqual(failuresAtAck)
    }
  })

  it('never raises the server\'s backoff over two refused files known to fail alone', async () => {
    await refusedRefusedGood([2, 2, 1])
    await drainSpool({ env })

    for (let drain = 0; drain < 3; drain++) {
      await elapse(PAST_EVERY_WINDOW_MS)
      const sentBefore = stub.received.length
      expect((await drainSpool({ env })).stopped).toBe('retry_later')
      expect(stub.received.length - sentBefore).toBe(2)
      const state = await loadSpoolState(root)
      expect(state.failures).toBe(0)
      expect(state.next_attempt_at).toBeNull()
    }
  })
})

// ── Generated outages and refused files ──────────────────────────────────

/** mulberry32: a small seeded generator, so a failing scenario replays from its seed. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type FileKind = 'good' | 'refused' | 'flaky'

/**
 * The route accepts good files and a proxy refuses refused ones with an
 * HTML 403. A flaky file is refused once, on its first send that follows
 * another file's ack in the same drain, so that failure makes it known to
 * fail alone; every other send of it is accepted. `drainStarts` resets the
 * per-drain ack.
 */
function scenarioResponder(kinds: ReadonlyMap<string, FileKind>): { reply: CaptureStubResponder; drainStarts: () => void } {
  const flakyFailed = new Set<string>()
  let ackedThisDrain = false
  const reply: CaptureStubResponder = (request) => {
    const uuids = sentUuids(request) as string[]
    if (uuids.some((u) => kinds.get(u) === 'refused')) return PROXY_403
    const flaky = uuids.find((u) => kinds.get(u) === 'flaky' && !flakyFailed.has(u))
    if (flaky !== undefined && ackedThisDrain) {
      flakyFailed.add(flaky)
      return PROXY_403
    }
    ackedThisDrain = true
    return acceptAll(request)
  }
  return { reply, drainStarts: () => (ackedThisDrain = false) }
}

/**
 * Two to seven one-event files, each good, refused by a proxy or flaky, at
 * least one good; zero to four drains during an outage answered 502, at
 * random gaps; then drains spaced past every window until each good and
 * flaky file must have been acked.
 *
 * The bound on spaced drains, with R refused files, F flaky files and O
 * outage drains: an outage drain sends at most two requests, so a file has
 * at most O attempts when the outage ends, and a flaky file at most O + 1
 * after its one failure. Files go out by attempts, so a refused file stays
 * ahead of a pending file only while its attempts do not exceed that file's,
 * which is at most O + 2 failures. A drain that ends before reaching the
 * pending file ends on two failures of files ahead of it, and a flaky file
 * fails at most once, so at most (R × (O + 2) + F) / 2 drains end before it,
 * one more is a flaky file's own failure, and the next reaches and acks it.
 */
async function runScenario(seed: number): Promise<void> {
  const random = seededRandom(seed)
  const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1))
  const label = `seed ${seed}`

  const count = int(2, 7)
  const pick = (): FileKind => {
    const r = random()
    return r < 0.4 ? 'refused' : r < 0.65 ? 'flaky' : 'good'
  }
  const fileKinds = Array.from({ length: count }, pick)
  if (!fileKinds.includes('good')) fileKinds[int(0, count - 1)] = 'good'
  const numbers = Array.from({ length: count }, (_, i) => i + 1)
  const paths = await writeOneEventFiles(numbers)
  const kinds = new Map(numbers.map((n, i) => [uuid(n), fileKinds[i]!]))
  const toAck = paths.filter((_, i) => fileKinds[i] !== 'refused')
  const refusedCount = fileKinds.filter((k) => k === 'refused').length
  const flakyCount = fileKinds.filter((k) => k === 'flaky').length
  const outageDrains = int(0, 4)
  const responder = scenarioResponder(kinds)

  let before: SpoolState = await loadSpoolState(root)
  const checkedDrain = async (duringOutage: boolean, step: string): Promise<void> => {
    const sentBefore = stub.received.length
    responder.drainStarts()
    const result = await drainSpool({ env })
    const after = await loadSpoolState(root)
    const where = `${label}, ${step}`
    if (duringOutage) expect(stub.received.length - sentBefore, `${where}: requests in an outage drain`).toBeLessThanOrEqual(2)
    for (const [key, entry] of Object.entries(before.files)) {
      if (!existsSync(join(root, key))) continue
      expect(after.files[key]?.attempts ?? -1, `${where}: attempts of ${key}`).toBeGreaterThanOrEqual(entry.attempts)
    }
    if (result.files_sent > 0) expect(after.failures, `${where}: failures after a settled send`).toBeLessThanOrEqual(before.failures)
    expect(result.dead, `${where}: dead letters`).toBe(0)
    before = after
  }

  stub.reply = PROXY_502
  for (let drain = 0; drain < outageDrains; drain++) {
    const gap = random() < 0.25 ? PAST_EVERY_WINDOW_MS : Math.floor(random() * 2 * DRAIN_BACKOFF_BASE_MS)
    if (gap > 0) await elapse(gap)
    await checkedDrain(true, `outage drain ${drain + 1} after ${gap} ms`)
  }

  stub.reply = responder.reply
  const spacedDrains = Math.floor((refusedCount * (outageDrains + 2) + flakyCount) / 2) + 2
  for (let drain = 0; drain < spacedDrains; drain++) {
    await elapse(PAST_EVERY_WINDOW_MS)
    await checkedDrain(false, `spaced drain ${drain + 1} of ${spacedDrains}`)
  }

  const scenario = `${label}: ${count} files ${JSON.stringify(fileKinds)}, ${outageDrains} outage drain(s)`
  expect(toAck.filter((p) => existsSync(p)), `${scenario}: good and flaky files still spooled`).toEqual([])
  expect(deadLetterCount(), `${scenario}: dead letters`).toBe(0)
}

describe('drainSpool over generated outages, refused and flaky files', () => {
  it.each(Array.from({ length: 50 }, (_, i) => i + 1))('keeps every rule for seed %i', async (seed) => {
    await runScenario(seed)
  })
})
