import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBackfillCli } from '../../src/backfill/engram-backfill-cli.js'
import { drainSpool } from '../../src/capture/spool-drain.js'
import { spoolTranscript } from '../../src/capture/spool-transcript.js'
import { type CaptureStub, type CaptureStubReply, type CaptureStubRequest, startCaptureStub } from '../capture/stub-server.js'
import { assistantText, at, humanPrompt, turnEnd, uuid, writeTranscript } from '../capture/transcripts.js'

const SESSION = uuid(9101)
const TOKEN = 'test-backfill-capture-token'
const HOUR_MS = 60 * 60_000
const GONE_CWD = '/home/u/work/acme/acme-web-fix-login'

// The secret registry is built once per process from process.env, on the
// first scrub, so its source must be in place before any test runs.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-backfill-secrets-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET: 'kv8-backfill-fixture-secret-4417' }))
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
let projectsDir: string
let sessionDir: string
let stateDir: string
let tokenFile: string
let registryFile: string
let stub: CaptureStub
let held: Set<string>

/** Accepts each (session, event uuid) once and reports a resend as a duplicate, as the route does. */
function dedupe(request: CaptureStubRequest): CaptureStubReply {
  let accepted = 0
  let duplicates = 0
  for (const event of request.body.events) {
    const key = `${String(event.session_id)}\u0000${String(event.event_uuid)}`
    if (held.has(key)) duplicates++
    else {
      held.add(key)
      accepted++
    }
  }
  return { status: 200, body: { accepted, duplicates, rejected: [] } }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'engram-backfill-transcripts-'))
  projectsDir = join(home, '.claude', 'projects')
  sessionDir = join(projectsDir, '-home-u-work-acme')
  mkdirSync(sessionDir, { recursive: true })
  stateDir = join(home, 'backfill-state')
  tokenFile = join(home, 'capture-token')
  writeFileSync(tokenFile, `${TOKEN}\n`)
  registryFile = join(home, 'registry.json')
  writeFileSync(
    registryFile,
    JSON.stringify({
      version: 1,
      workspaces: { acme: { root: '/home/u/work/acme', vault_folder: null, register_prefix: null } },
      projects: { 'acme-web': { workspace: 'acme', vault_folder: null, register_prefix: null } },
    }),
  )
  held = new Set()
  stub = await startCaptureStub()
  stub.reply = dedupe
})

afterEach(async () => {
  await stub.close()
  rmSync(home, { recursive: true, force: true })
})

/** Two closed turns: two prompts and two assistant turns. */
function writeSession(dir: string, sessionId: string, ageMs = 2 * HOUR_MS): string {
  const opts = { cwd: GONE_CWD }
  const path = writeTranscript(dir, sessionId, [
    humanPrompt(uuid(1), at(0), 'Rename the login form fields for TST-1', opts),
    assistantText(uuid(2), at(5), 'Renamed both fields.', opts),
    turnEnd(uuid(3), at(6), opts),
    humanPrompt(uuid(4), at(60), 'ok', opts),
    assistantText(uuid(5), at(65), 'Done.', opts),
    turnEnd(uuid(6), at(66), opts),
  ])
  const mtime = (Date.now() - ageMs) / 1000
  utimesSync(path, mtime, mtime)
  return path
}

async function backfill(...extra: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const argv = [
    'transcripts',
    '--projects-dir',
    projectsDir,
    '--target',
    stub.url,
    '--token-file',
    tokenFile,
    '--registry',
    registryFile,
    '--state-dir',
    stateDir,
    '--json',
    ...extra,
  ]
  const code = await runBackfillCli(argv, { HOME: home }, { out: (t) => (out += t), err: (t) => (err += t) })
  return { code, out, err }
}

function sentEvents(): Array<Record<string, unknown>> {
  return stub.received.flatMap((r) => r.body.events)
}

describe('engram-backfill transcripts', () => {
  it('reads only the main-session file beside a subagent transcript', async () => {
    writeSession(sessionDir, SESSION)
    const subagents = join(sessionDir, SESSION, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeSession(subagents, 'agent-1')

    const run = await backfill('--apply')

    expect(run.code).toBe(0)
    expect(JSON.parse(run.out).files).toMatchObject({ found: 1, read: 1 })
    expect(new Set(sentEvents().map((e) => e.session_id))).toEqual(new Set([SESSION]))
  })

  it('sends every event once, framed by session markers, and nothing on a second run', async () => {
    writeSession(sessionDir, SESSION)

    const first = await backfill('--apply')
    const summary = JSON.parse(first.out)
    const types = sentEvents().map((e) => e.type)

    expect(first.code).toBe(0)
    expect(types).toEqual(['session_start', 'user_prompt', 'assistant_turn', 'user_prompt', 'assistant_turn', 'session_end'])
    expect(summary).toMatchObject({ accepted: 6, duplicates: 0, rejected: {}, stopped: null })
    expect(summary.events).toEqual({ session_start: 1, user_prompt: 2, assistant_turn: 2, session_end: 1 })
    expect(stub.received.every((r) => r.body.client.name === 'engram-backfill')).toBe(true)
    expect(stub.received.every((r) => r.path === '/capture/events' && r.authorization === `Bearer ${TOKEN}`)).toBe(true)

    const sentBefore = stub.received.length
    const second = await backfill('--apply')

    expect(second.code).toBe(0)
    expect(stub.received.length).toBe(sentBefore)
    expect(JSON.parse(second.out)).toMatchObject({ accepted: 0, duplicates: 0, events: {}, files: { skipped_unchanged: 1 } })
  })

  it('resolves the project of a working directory that no longer exists', async () => {
    writeSession(sessionDir, SESSION)

    await backfill('--apply')

    for (const event of sentEvents()) {
      expect(event.project).toMatchObject({ id: 'acme-web', workspace: 'acme', repo_root: null, worktree: null })
    }
  })

  it('reports a session live capture already sent as duplicates', async () => {
    const path = writeSession(sessionDir, SESSION)
    const liveEnv = { HOME: join(home, 'live'), ENGRAM_SERVER_URL: stub.url, ENGRAM_CAPTURE_TOKEN_FILE: tokenFile }
    await spoolTranscript(path, { env: liveEnv, forceClose: true })
    const live = await drainSpool({ env: liveEnv })
    expect(live.accepted).toBe(4)
    expect(stub.received.every((r) => r.body.client.name === 'engram-capture')).toBe(true)
    const liveRequests = stub.received.length

    const run = await backfill('--apply')

    expect(JSON.parse(run.out)).toMatchObject({ duplicates: live.accepted, accepted: 2 })
    expect(stub.received.slice(liveRequests).every((r) => r.body.client.name === 'engram-backfill')).toBe(true)
  })

  it('makes no request and writes no state on a dry run', async () => {
    writeSession(sessionDir, SESSION)

    const run = await backfill()

    expect(run.code).toBe(0)
    expect(stub.received).toHaveLength(0)
    expect(existsSync(stateDir)).toBe(false)
    expect(JSON.parse(run.out)).toMatchObject({
      apply: false,
      accepted: 0,
      events: { session_start: 1, user_prompt: 2, assistant_turn: 2, session_end: 1 },
    })
  })

  it('skips a file modified within the last hour', async () => {
    writeSession(sessionDir, SESSION, 300_000)

    const run = await backfill('--apply')

    expect(stub.received).toHaveLength(0)
    expect(JSON.parse(run.out).files).toMatchObject({ found: 1, read: 0, skipped_recent: 1 })
  })

  it('keeps the cursor when the server does not acknowledge', async () => {
    writeSession(sessionDir, SESSION)
    stub.reply = { status: 503, body: { error: 'unavailable' } }

    const failed = await backfill('--apply')

    expect(failed.code).toBe(1)
    expect(JSON.parse(failed.out).stopped).toBe('retry_later')
    expect(readdirSync(join(stateDir, 'cursors')).filter((n) => n.endsWith('.json'))).toEqual([])
  })

  it('exits 2 on an unknown command or flag', async () => {
    let err = ''
    const io = { out: () => {}, err: (t: string) => (err += t) }
    expect(await runBackfillCli(['replay'], {}, io)).toBe(2)
    expect(await runBackfillCli(['transcripts', '--everything'], {}, io)).toBe(2)
    expect(err).toContain('unknown command "replay"')
    expect(err).toContain('unknown flag "--everything"')
  })
})
