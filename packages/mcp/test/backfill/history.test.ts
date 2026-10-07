import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBackfillCli } from '../../src/backfill/engram-backfill-cli.js'
import { readHistoryEvents } from '../../src/backfill/history.js'
import { createProjectResolver, loadResolverRegistry } from '../../src/backfill/project-resolver.js'
import { parseCaptureEvent } from '../../src/capture-events/validate.js'
import { eventUuidFromParts } from '../../src/capture/event-uuid.js'
import { readTranscriptEvents } from '../../src/capture/transcript-reader.js'
import { type CaptureStub, type CaptureStubReply, type CaptureStubRequest, startCaptureStub } from '../capture/stub-server.js'
import { assistantText, at, slashCommand, turnEnd, userEntry, uuid, writeTranscript } from '../capture/transcripts.js'

const TOKEN = 'test-backfill-capture-token'
const COVERED = uuid(9201)
const TYPED = uuid(9202)
const PROJECT_DIR = '/home/u/work/acme/acme-web'
const DAY_MS = Date.UTC(2026, 6, 1, 9, 0, 0)
const MISSING_HASH = 'feedfacecafebeef'
const CACHED_HASH = 'cafebabedeadbeef'

// The secret registry is built once per process from process.env, on the
// first scrub, so its source must be in place before any test runs.
const secretsDir = mkdtempSync(join(tmpdir(), 'engram-backfill-history-secrets-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(secretsDir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET: 'kv8-history-fixture-secret-5521' }))
  writeFileSync(join(secretsDir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
  process.env.ENGRAM_SECRET_SOURCES_FILE = join(secretsDir, 'sources.json')
  process.env.XDG_CACHE_HOME = join(secretsDir, 'cache')
})

afterAll(() => {
  if (savedEnv.SOURCES === undefined) delete process.env.ENGRAM_SECRET_SOURCES_FILE
  else process.env.ENGRAM_SECRET_SOURCES_FILE = savedEnv.SOURCES
  if (savedEnv.CACHE === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = savedEnv.CACHE
  rmSync(secretsDir, { recursive: true, force: true })
})

let home: string
let claudeDir: string
let projectsDir: string
let historyFile: string
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
  home = mkdtempSync(join(tmpdir(), 'engram-backfill-history-'))
  claudeDir = join(home, '.claude')
  projectsDir = join(claudeDir, 'projects')
  mkdirSync(join(projectsDir, '-home-u-work-acme-acme-web'), { recursive: true })
  historyFile = join(claudeDir, 'history.jsonl')
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

interface HistoryLine {
  display: string
  pastedContents?: Record<string, unknown>
  project?: string
  sessionId?: string
  timestamp: number
}

function line(n: number, display: string, extra: Partial<HistoryLine> = {}): HistoryLine {
  return { display, pastedContents: {}, project: PROJECT_DIR, sessionId: TYPED, timestamp: DAY_MS + n * 60_000, ...extra }
}

function writeHistory(lines: HistoryLine[]): void {
  writeFileSync(historyFile, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
}

/** A transcript for `sessionId`: its prompts are the transcript source's to send. */
function writeCoveredTranscript(sessionId: string): void {
  writeTranscript(join(projectsDir, '-home-u-work-acme-acme-web'), sessionId, [userEntry(uuid(1), at(0), 'covered')])
}

const INLINE_PASTE = 'first pasted line\nsecond pasted line'

function standardHistory(): HistoryLine[] {
  return [
    line(0, 'Rename the login form fields', { sessionId: COVERED }),
    line(1, '/clear'),
    line(2, '!ls'),
    line(3, 'Review this [Pasted text #1 +2 lines] before TST-7 ships', {
      pastedContents: { '1': { id: 1, type: 'text', content: INLINE_PASTE } },
    }),
    line(4, 'Compare with [Pasted text #2 +40 lines]', {
      pastedContents: { '2': { id: 2, type: 'text', contentHash: MISSING_HASH } },
    }),
    line(5, 'ok', { sessionId: undefined }),
  ]
}

async function backfill(...extra: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const argv = [
    'history',
    '--history-file',
    historyFile,
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

function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  return event.payload as Record<string, unknown>
}

describe('engram-backfill history', () => {
  it('sends the prompts no transcript covers, with pastes expanded and missing pastes flagged', async () => {
    writeCoveredTranscript(COVERED)
    writeHistory(standardHistory())

    const run = await backfill('--apply')
    const summary = JSON.parse(run.out)
    const events = sentEvents()

    expect(run.code).toBe(0)
    expect(events.map((e) => payloadOf(e).text)).toEqual([
      '/clear',
      `Review this ${INLINE_PASTE} before TST-7 ships`,
      'Compare with [Pasted text #2 +40 lines]',
      'ok',
    ])
    expect(events.map((e) => (payloadOf(e).origin as Record<string, unknown>).paste_missing)).toEqual([false, false, true, false])
    expect(summary.entries).toEqual({ read: 6, covered: 1, slash: 1, bang: 1, invalid: 0, sent: 4 })
    expect(summary).toMatchObject({ accepted: 4, duplicates: 0, rejected: {}, stopped: null })
    expect(stub.received.every((r) => r.body.client.name === 'engram-backfill')).toBe(true)
  })

  it('shapes each event as a history-origin prompt the route accepts', async () => {
    writeCoveredTranscript(COVERED)
    writeHistory(standardHistory())

    await backfill('--apply')
    const events = sentEvents()
    const clear = events[0]!
    const ok = events[3]!

    for (const event of events) expect(() => parseCaptureEvent(event, new Date())).not.toThrow()
    expect(clear).toMatchObject({
      session_id: TYPED,
      event_uuid: eventUuidFromParts('history', String(DAY_MS + 60_000), '/clear'),
      type: 'user_prompt',
      occurred_at: new Date(DAY_MS + 60_000).toISOString(),
      cwd: PROJECT_DIR,
      project: { id: 'acme-web', workspace: 'acme', repo_root: null, branch: null, worktree: null },
      plan_dirs: [],
      payload: {
        text: '/clear',
        transcript_line: null,
        origin: { type: 'history', timestamp_ms: DAY_MS + 60_000, line: 2, paste_missing: false },
      },
    })
    expect(ok.session_id).toBe('history:acme-web:2026-07-01')
    expect(payloadOf(ok).text).toBe('ok')
  })

  it('reads a paste stored only by hash from the paste cache', async () => {
    mkdirSync(join(claudeDir, 'paste-cache'), { recursive: true })
    writeFileSync(join(claudeDir, 'paste-cache', `${CACHED_HASH}.txt`), 'cached paste body')
    writeHistory([
      line(0, 'Diff [Pasted text #1 +9 lines] now', { pastedContents: { '1': { id: 1, type: 'text', contentHash: CACHED_HASH } } }),
    ])

    await backfill('--apply')
    const [event] = sentEvents()

    expect(payloadOf(event!).text).toBe('Diff cached paste body now')
    expect((payloadOf(event!).origin as Record<string, unknown>).paste_missing).toBe(false)
  })

  it('reports only duplicates on a second run', async () => {
    writeCoveredTranscript(COVERED)
    writeHistory(standardHistory())

    await backfill('--apply')
    const second = await backfill('--apply')

    expect(second.code).toBe(0)
    expect(JSON.parse(second.out)).toMatchObject({ accepted: 0, duplicates: 4, rejected: {}, stopped: null })
  })

  it('makes no request and writes no state on a dry run', async () => {
    writeCoveredTranscript(COVERED)
    writeHistory(standardHistory())

    const run = await backfill()

    expect(run.code).toBe(0)
    expect(stub.received).toHaveLength(0)
    expect(JSON.parse(run.out)).toMatchObject({ apply: false, accepted: 0, events: { user_prompt: 4 } })
  })

  it('treats a slash command and a bang command as the transcript reader does', async () => {
    const dir = join(projectsDir, '-home-u-work-acme-acme-web')
    const transcript = writeTranscript(dir, uuid(9203), [
      slashCommand(uuid(11), at(0), '/plan-run', 'x'),
      assistantText(uuid(12), at(5), 'Started.'),
      turnEnd(uuid(13), at(6)),
      userEntry(uuid(14), at(10), '<bash-input>ls</bash-input>'),
      userEntry(uuid(15), at(11), '<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>'),
    ])
    const emptyProject = { id: null, workspace: null, repo_root: null, branch: null, worktree: null }
    const fromTranscript = await readTranscriptEvents(transcript, null, { resolveProject: () => emptyProject, forceClose: true })
    rmSync(transcript)
    writeHistory([line(0, '/plan-run x'), line(1, '!ls')])
    const registry = loadResolverRegistry(registryFile, { HOME: home })

    const fromHistory = await readHistoryEvents({
      historyFile,
      projectsDir,
      resolver: createProjectResolver({ registry, overrides: new Map() }, { HOME: home }),
    })

    const prompts = (events: ReadonlyArray<{ type: string; payload: unknown }>): unknown[] =>
      events.filter((e) => e.type === 'user_prompt').map((e) => (e.payload as { text: string }).text)
    expect(prompts(fromHistory.events)).toEqual(prompts(fromTranscript.events))
    expect(prompts(fromHistory.events)).toEqual(['/plan-run x'])
    expect(fromHistory.counts).toMatchObject({ read: 2, slash: 1, bang: 1, sent: 1 })
  })

  it('fails when the projects directory is missing, since coverage cannot be decided', async () => {
    writeHistory(standardHistory())
    rmSync(projectsDir, { recursive: true, force: true })

    const run = await backfill('--apply')

    expect(run.code).toBe(1)
    expect(stub.received).toHaveLength(0)
  })
})
