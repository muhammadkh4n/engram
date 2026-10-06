/**
 * The detached capture worker: session events, transcript lookup, the
 * catch-up sweep, and the drain CLI. No server URL is set, so every batch
 * stays in the spool where the test reads it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CaptureEvent } from '../../src/capture/events.js'
import { eventUuidFromParts } from '../../src/capture/event-uuid.js'
import { HOOK_AT_ENV, HOOK_INPUT_ENV } from '../../src/capture/hook-input.js'
import { spoolRoot } from '../../src/capture/spool.js'
import { cursorRoot, loadCursor } from '../../src/capture/transcript-cursor.js'
import { runWorker, sweepTranscripts, SWEEP_IDLE_MS, SWEEP_MAX_FILES, workerLogLine } from '../../src/capture/worker.js'
import { runDrainCli } from '../../src/capture/drain-cli.js'
import { startCaptureStub } from './stub-server.js'
import { assistantText, at, humanPrompt, turnEnd, uuid, writeTranscript } from './transcripts.js'

const PKG_DIR = resolve(import.meta.dirname, '..', '..')
const SESSION = '00000000-0000-4000-8000-000000005520'
const OTHER = '00000000-0000-4000-8000-000000005521'
const AT = '2026-10-05T11:30:00.000Z'

// The secret registry is built once per process from process.env, on the first scrub.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-worker-registry-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET: 'zz9-worker-fixture-secret-4471' }))
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
let env: Record<string, string>
let projects: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'engram-worker-'))
  projects = join(home, '.claude', 'projects')
  mkdirSync(join(projects, '-work-a'), { recursive: true })
  mkdirSync(join(projects, '-work-b'), { recursive: true })
  env = { HOME: home, [HOOK_AT_ENV]: AT }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function batchFiles(): string[] {
  return filesUnder(spoolRoot(env)).filter((p) => p.endsWith('.jsonl') && !p.includes('/.dead/'))
}

function spooled(): CaptureEvent[] {
  return batchFiles().flatMap((p) =>
    readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CaptureEvent),
  )
}

/** A closed turn followed by an open one: a prompt and an answer with no turn end yet. */
function sessionTranscript(dir: string, sessionId: string, base = 0): string {
  return writeTranscript(dir, sessionId, [
    humanPrompt(uuid(base + 1), at(base + 1), 'rename the cursor field'),
    assistantText(uuid(base + 2), at(base + 2), 'Renamed it.'),
    turnEnd(uuid(base + 3), at(base + 3)),
    humanPrompt(uuid(base + 4), at(base + 4), 'now update the tests'),
    assistantText(uuid(base + 5), at(base + 5), 'Updated them.'),
  ])
}

describe('session events', () => {
  it.each([
    ['session-start', 'session_start', { source: 'resume' }, 'resume'],
    ['pre-compact', 'pre_compact', { trigger: 'auto' }, 'auto'],
    ['session-end', 'session_end', { reason: 'logout' }, 'logout'],
  ] as const)('%s writes a %s event with the deterministic uuid and the reason', async (kind, type, extra, reason) => {
    const result = await runWorker(kind, { session_id: SESSION, cwd: home, ...extra }, env)

    expect(result.failures).toEqual([])
    const events = spooled().filter((e) => e.type === type)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      session_id: SESSION,
      event_uuid: eventUuidFromParts(SESSION, type, AT),
      occurred_at: AT,
      cwd: home,
      plan_dirs: [],
      payload: { reason },
    })
    expect(result.drain?.stopped).toBe('no_url')
  })

  it('leaves the reason out when the input has none', async () => {
    await runWorker('session-end', { session_id: SESSION, cwd: home }, env)
    expect(spooled().find((e) => e.type === 'session_end')?.payload).toEqual({})
  })

  it('a hook fired inside a subagent writes no batch file', async () => {
    const path = sessionTranscript(join(projects, '-work-a'), SESSION)
    for (const kind of ['stop', 'pre-compact', 'session-end', 'session-start'] as const) {
      await runWorker(kind, { session_id: SESSION, transcript_path: path, cwd: home, agent_id: 'agent-7' }, env)
    }
    expect(batchFiles()).toEqual([])
  })
})

describe('transcript lookup', () => {
  it('session-end spools the transcript found by session id and closes its open turn', async () => {
    sessionTranscript(join(projects, '-work-b'), SESSION)
    const result = await runWorker('session-end', { session_id: SESSION, cwd: home }, env)

    expect(result.failures).toEqual([])
    const turns = spooled().filter((e) => e.type === 'assistant_turn')
    expect(turns.map((e) => e.session_id)).toEqual([SESSION, SESSION])
  })

  it('never reads another session file when its own is missing', async () => {
    sessionTranscript(join(projects, '-work-a'), OTHER)
    await runWorker('stop', { session_id: SESSION, cwd: home }, env)

    expect(spooled()).toEqual([])
    expect(await loadCursor(cursorRoot(env), OTHER)).toBeNull()
  })

  it('treats a session id that is a path as unknown', async () => {
    sessionTranscript(join(projects, '-work-a'), OTHER)
    await runWorker('stop', { session_id: `../-work-a/${OTHER}`, cwd: home }, env)
    expect(spooled()).toEqual([])
  })

  it('stop spools only the closed turn of the hook transcript', async () => {
    const path = sessionTranscript(join(projects, '-work-a'), SESSION)
    sessionTranscript(join(projects, '-work-a'), OTHER, 100)
    await runWorker('stop', { session_id: SESSION, transcript_path: path, cwd: home }, env)

    const events = spooled()
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set([SESSION]))
    expect(events.filter((e) => e.type === 'assistant_turn')).toHaveLength(1)
  })
})

describe('the sweep', () => {
  const dir = (): string => join(projects, '-work-a')

  function setSince(ms: number): void {
    mkdirSync(cursorRoot(env), { recursive: true })
    writeFileSync(join(cursorRoot(env), '.since'), `${new Date(ms).toISOString()}\n`)
  }

  function touch(path: string, ms: number): void {
    utimesSync(path, ms / 1000, ms / 1000)
  }

  it('writes .since on the first run and skips files modified before it', async () => {
    const path = sessionTranscript(dir(), OTHER)
    touch(path, Date.now() - 60_000)

    await sweepTranscripts(dir(), env)

    expect(Date.parse(readFileSync(join(cursorRoot(env), '.since'), 'utf8').trim())).toBeGreaterThan(Date.now() - 10_000)
    expect(await loadCursor(cursorRoot(env), OTHER)).toBeNull()
  })

  it('takes at most 20 files, newest first', async () => {
    const now = Date.now()
    setSince(now - 3_600_000)
    const ids = Array.from({ length: SWEEP_MAX_FILES + 2 }, (_, i) => `00000000-0000-4000-8000-0000000061${String(i).padStart(2, '0')}`)
    ids.forEach((id, i) => touch(sessionTranscript(dir(), id), now - (i + 1) * 1000))

    await sweepTranscripts(dir(), env, now)

    const read = await Promise.all(ids.map(async (id) => (await loadCursor(cursorRoot(env), id)) !== null))
    expect(read).toEqual(ids.map((_, i) => i < SWEEP_MAX_FILES))
  })

  it('skips a file its cursor has read to the end', async () => {
    const now = Date.now()
    setSince(now - 3_600_000)
    const path = writeTranscript(dir(), OTHER, [
      humanPrompt(uuid(1), at(1), 'rename the cursor field'),
      assistantText(uuid(2), at(2), 'Renamed it.'),
      turnEnd(uuid(3), at(3)),
    ])
    await sweepTranscripts(dir(), env, now)
    const first = spooled().length
    touch(path, now)

    await sweepTranscripts(dir(), env, now)

    expect(first).toBeGreaterThan(0)
    expect(spooled()).toHaveLength(first)
  })

  it('closes the open turn of an idle file only', async () => {
    const now = Date.now()
    setSince(now - 3 * SWEEP_IDLE_MS)
    touch(sessionTranscript(dir(), SESSION), now - SWEEP_IDLE_MS)
    touch(sessionTranscript(dir(), OTHER, 100), now - SWEEP_IDLE_MS + 60_000)

    await sweepTranscripts(dir(), env, now)

    const turns = (id: string): number => spooled().filter((e) => e.session_id === id && e.type === 'assistant_turn').length
    expect(turns(SESSION)).toBe(2)
    expect(turns(OTHER)).toBe(1)
  })

  it('session-start sweeps the directory of its own transcript', async () => {
    setSince(Date.now() - 3_600_000)
    sessionTranscript(dir(), OTHER)
    const own = writeTranscript(dir(), SESSION, [])
    await runWorker('session-start', { session_id: SESSION, transcript_path: own, cwd: home, source: 'startup' }, env)

    expect(spooled().some((e) => e.session_id === OTHER && e.type === 'assistant_turn')).toBe(true)
  })

  it('session-start sweeps the directory of its transcript_path before that file exists', async () => {
    const now = Date.now()
    setSince(now - 3 * SWEEP_IDLE_MS)
    touch(sessionTranscript(dir(), OTHER), now - SWEEP_IDLE_MS - 60_000)
    const own = join(dir(), `${SESSION}.jsonl`)

    const result = await runWorker('session-start', { session_id: SESSION, transcript_path: own, cwd: home, source: 'startup' }, env)

    expect(existsSync(own)).toBe(false)
    expect(result.failures).toEqual([])
    expect(spooled().filter((e) => e.session_id === OTHER && e.type === 'assistant_turn')).toHaveLength(2)
    expect(await loadCursor(cursorRoot(env), OTHER)).not.toBeNull()
    expect(workerLogLine('session-start', { session_id: SESSION }, result, 1)).not.toContain('sweep: no directory')
  })

  it('session-start with neither a transcript_path nor a file found by session id logs that it had no directory', async () => {
    const now = Date.now()
    setSince(now - 3 * SWEEP_IDLE_MS)
    touch(sessionTranscript(dir(), OTHER), now - SWEEP_IDLE_MS - 60_000)
    const input = { session_id: SESSION, cwd: home, source: 'startup' }

    const result = await runWorker('session-start', input, env)

    expect(result.failures).toEqual([])
    expect(await loadCursor(cursorRoot(env), OTHER)).toBeNull()
    expect(workerLogLine('session-start', input, result, 1)).toMatch(/ sweep: no directory$/)
  })
})

describe('the worker process', () => {
  it('prints nothing and logs one line of counts', async () => {
    const path = sessionTranscript(join(projects, '-work-a'), SESSION)
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, 'cache') }
    delete childEnv.ENGRAM_SERVER_URL
    childEnv[HOOK_INPUT_ENV] = JSON.stringify({ session_id: SESSION, transcript_path: path, cwd: home })
    childEnv[HOOK_AT_ENV] = AT
    const child = spawn(process.execPath, ['--import', 'tsx', join(PKG_DIR, 'src', 'capture', 'worker.ts'), '--hook', 'session-end'], {
      cwd: PKG_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    const code = await new Promise<number | null>((done) => child.on('close', done))

    expect(code).toBe(0)
    expect(stdout).toBe('')
    const log = readFileSync(join(home, '.engram', 'capture.log'), 'utf8')
    const line = log.split('\n').find((l) => l.includes(' worker '))
    expect(line).toMatch(/ worker session-end session=00000000 events=\d+ files=\d+ redactions=0 sent=0 .* stopped=no_url ms=\d+$/)
    expect(log).not.toContain('rename the cursor field')
  }, 20_000)
})

describe('the drain CLI', () => {
  it('exits 0 with nothing to send', async () => {
    const lines: string[] = []
    expect(await runDrainCli({ HOME: home }, (l) => lines.push(l))).toBe(0)
    expect(lines).toEqual(['sent=0 accepted=0 duplicates=0 rejected=0 dead=0 remaining=0 stopped=none\n'])
  })

  it('prints counts and exits 1 when the drain stops on an error', async () => {
    await runWorker('session-end', { session_id: SESSION, cwd: home }, env)
    const lines: string[] = []
    expect(await runDrainCli({ HOME: home }, (l) => lines.push(l))).toBe(1)
    expect(lines).toEqual(['sent=0 accepted=0 duplicates=0 rejected=0 dead=0 remaining=1 stopped=no_url\n'])
  })

  it('exits 0 after sending the spool', async () => {
    await runWorker('session-end', { session_id: SESSION, cwd: home, reason: 'logout' }, env)
    const stub = await startCaptureStub()
    try {
      const tokenFile = join(home, 'capture-token')
      writeFileSync(tokenFile, 'fixture-capture-token\n')
      const lines: string[] = []
      const code = await runDrainCli({ HOME: home, ENGRAM_SERVER_URL: stub.url, ENGRAM_CAPTURE_TOKEN_FILE: tokenFile }, (l) => lines.push(l))

      expect(code).toBe(0)
      expect(lines).toEqual(['sent=1 accepted=1 duplicates=0 rejected=0 dead=0 remaining=0 stopped=none\n'])
    } finally {
      await stub.close()
    }
  })
})
