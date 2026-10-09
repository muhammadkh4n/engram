#!/usr/bin/env node
/**
 * The detached capture worker a hook starts: `worker.js --hook <kind>`.
 * It spools the session's transcript and session events, then drains the
 * spool to the capture route. It calls no model and writes to no database.
 * One capture-log line per run carries the kind, the session id's first 8
 * characters and counts, never text, headers or tokens.
 */

import { exitWhenFlushed } from '../cli-exit.js'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { CaptureEvent } from '../capture-events/contract.js'
import { SESSION_REASON_MAX_CHARS } from '../capture-events/contract.js'
import { isEntryPoint } from '../ingest/entry-point.js'
import { ensurePrivateDir } from '../ingest/private-files.js'
import { type ForwardedInput, forwardedInput, HOOK_AT_ENV, HOOK_INPUT_ENV, type WorkerKind } from './hook-input.js'
import { readyForRoute } from './route-fit.js'
import {
  appendCaptureLog,
  cursorRoot,
  type DrainResult,
  drainSpool,
  eventUuidFromParts,
  loadCaptureRegistry,
  loadCursor,
  resolveEventProject,
  scrubEvent,
  spoolRoot,
  spoolTranscript,
  writeDeadLetters,
  writeSpoolBatch,
} from './index.js'

type Env = Record<string, string | undefined>

export const WORKER_WATCHDOG_MS = 120_000
/** No drain request starts after this; one request may take 30 s, which still ends inside the watchdog. */
export const WORKER_DRAIN_BUDGET_MS = 90_000
export const SWEEP_MAX_FILES = 20
export const SWEEP_IDLE_MS = 30 * 60_000
const SINCE_FILE = '.since'

const WORKER_KINDS: readonly WorkerKind[] = ['stop', 'pre-compact', 'session-end', 'session-start', 'drain']

type SessionEventType = 'session_start' | 'pre_compact' | 'session_end'

export interface WorkerResult {
  events: number
  files: number
  redactions: number
  drain: DrainResult | null
  /** Steps that threw, by step name; the error's code or name only. */
  failures: string[]
  /** A session-start that had no directory to sweep: none named by transcript_path or found by session id, or one not created yet. */
  noSweepDirectory?: true
}

interface Counts {
  events: number
  files: number
  redactions: number
}

function addCounts(total: Counts, more: Counts): void {
  total.events += more.events
  total.files += more.files
  total.redactions += more.redactions
}

function errorLabel(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string') return code
  return err instanceof Error ? err.name : 'error'
}

/** The hook's start time from the env, or now when it is missing or not a date. */
function hookTime(env: Env): string {
  const raw = env[HOOK_AT_ENV]
  if (raw && !Number.isNaN(Date.parse(raw))) return new Date(Date.parse(raw)).toISOString()
  return new Date().toISOString()
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

/** A session id that names one file, never a path out of its directory. */
function isPlainFileName(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId !== '.' && sessionId !== '..' && basename(sessionId) === sessionId && !sessionId.includes('\\')
}

/**
 * The session's transcript: the hook's `transcript_path` when that file
 * exists, else `~/.claude/projects/<any>/<session_id>.jsonl`, else null. Never
 * another session's file, and never the newest file on the machine.
 */
export async function resolveTranscriptPath(input: ForwardedInput, env: Env): Promise<string | null> {
  if (input.transcript_path && (await isFile(input.transcript_path))) return resolve(input.transcript_path)
  const sessionId = input.session_id
  if (!sessionId || !isPlainFileName(sessionId)) return null
  const projects = join(env.HOME || homedir(), '.claude', 'projects')
  let dirs: string[]
  try {
    dirs = (await fs.readdir(projects, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return null
  }
  for (const dir of dirs.sort()) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`)
    if (await isFile(candidate)) return candidate
  }
  return null
}

/** The session event's reason: the hook input field each kind carries, clipped to the route's cap. */
function eventReason(kind: WorkerKind, input: ForwardedInput): string | undefined {
  const value = kind === 'session-start' ? input.source : kind === 'pre-compact' ? input.trigger : kind === 'session-end' ? input.reason : undefined
  return value === undefined ? undefined : value.slice(0, SESSION_REASON_MAX_CHARS)
}

/** Writes one session marker event, scrubbed and fitted to the route, to the spool. */
async function spoolSessionEvent(
  type: SessionEventType,
  kind: WorkerKind,
  input: ForwardedInput,
  env: Env,
  occurredAt: string,
): Promise<Counts> {
  const sessionId = input.session_id
  if (!sessionId) return { events: 0, files: 0, redactions: 0 }
  const cwd = input.cwd ?? null
  const cursor = await loadCursor(cursorRoot(env), sessionId)
  const reason = eventReason(kind, input)
  const event = {
    session_id: sessionId,
    event_uuid: eventUuidFromParts(sessionId, type, occurredAt),
    type,
    occurred_at: occurredAt,
    cwd,
    project: resolveEventProject(cwd, null, loadCaptureRegistry(env)),
    plan_dirs: cursor?.plan_dirs ?? [],
    payload: reason === undefined ? {} : { reason },
  } as CaptureEvent
  const scrubbed = await scrubEvent(event)
  const check = readyForRoute(scrubbed.event, { now: new Date(), log: (line) => appendCaptureLog(env, line) })
  const root = spoolRoot(env)
  if (!check.ok) {
    writeDeadLetters(sessionId, [{ reason: check.reason, event: scrubbed.event }], { root })
    appendCaptureLog(env, `worker dead-lettered a ${type} event the capture route refuses: ${check.reason.slice(0, 300)}`)
    return { events: 0, files: 0, redactions: scrubbed.masked.length }
  }
  const files = await writeSpoolBatch(sessionId, [check.event], { root })
  return { events: 1, files: files.length, redactions: scrubbed.masked.length }
}

/** The sweep's lower mtime bound: `~/.engram/cursors/.since`, written with the current time on the first run. */
async function sweepSince(env: Env): Promise<number> {
  const root = cursorRoot(env)
  const path = join(root, SINCE_FILE)
  try {
    const parsed = Date.parse((await fs.readFile(path, 'utf8')).trim())
    if (!Number.isNaN(parsed)) return parsed
  } catch {
    // Absent: written below.
  }
  const now = Date.now()
  ensurePrivateDir(root)
  try {
    await fs.writeFile(path, `${new Date(now).toISOString()}\n`, { flag: 'wx', mode: 0o600 })
  } catch (err) {
    // A concurrent first run wrote it first; that run's time stands.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return sweepSince(env)
    throw err
  }
  return now
}

interface SweepCandidate {
  path: string
  mtimeMs: number
}

/**
 * Catches up the sessions in the transcript's directory that ended without
 * a SessionEnd: the top-level `*.jsonl` files modified at or after `.since`
 * whose size passes their cursor, newest first, at most SWEEP_MAX_FILES. A
 * file idle for SWEEP_IDLE_MS or more has its open turn closed. Null when
 * `dir` does not exist: a project's first session can start before Claude
 * Code creates its transcript folder, and then no session there can need
 * catching up. Any other read error throws.
 */
export async function sweepTranscripts(dir: string, env: Env, now = Date.now()): Promise<Counts | null> {
  // .since is taken first so the first run fixes the bound even when it finds no folder.
  const since = await sweepSince(env)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const cursors = cursorRoot(env)
  const candidates: SweepCandidate[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const path = join(dir, entry.name)
    let stat
    try {
      stat = await fs.stat(path)
    } catch {
      continue
    }
    if (stat.mtimeMs < since) continue
    const cursor = await loadCursor(cursors, entry.name.slice(0, -'.jsonl'.length))
    if (stat.size <= (cursor?.offset ?? 0)) continue
    candidates.push({ path, mtimeMs: stat.mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const total: Counts = { events: 0, files: 0, redactions: 0 }
  for (const c of candidates.slice(0, SWEEP_MAX_FILES)) {
    addCounts(total, await spoolTranscript(c.path, { env, forceClose: now - c.mtimeMs >= SWEEP_IDLE_MS }))
  }
  return total
}

/**
 * The directory session-start sweeps: that of the hook's `transcript_path`
 * whether or not the file exists yet (Claude Code writes it at the session's
 * first message), else that of the file found by session id, else null.
 */
function sweepDirectory(input: ForwardedInput, transcript: string | null): string | null {
  if (input.transcript_path) return dirname(resolve(input.transcript_path))
  return transcript === null ? null : dirname(transcript)
}

const SESSION_EVENT: Partial<Record<WorkerKind, SessionEventType>> = {
  'pre-compact': 'pre_compact',
  'session-end': 'session_end',
  'session-start': 'session_start',
}

/**
 * Runs one hook's capture. Each step runs even when an earlier one threw, so
 * a transcript that could not be read still lets the spool drain. A hook that
 * fired inside a subagent (`agent_id` set) spools nothing.
 */
export async function runWorker(kind: WorkerKind, input: ForwardedInput, env: Env): Promise<WorkerResult> {
  const started = Date.now()
  const occurredAt = hookTime(env)
  const total: Counts = { events: 0, files: 0, redactions: 0 }
  const failures: string[] = []
  let noSweepDirectory = false
  const step = async (name: string, run: () => Promise<Counts | void>): Promise<void> => {
    try {
      const counts = await run()
      if (counts) addCounts(total, counts)
    } catch (err) {
      failures.push(`${name}:${errorLabel(err)}`)
    }
  }

  if (kind !== 'drain' && input.agent_id === undefined) {
    const transcript = await resolveTranscriptPath(input, env)
    if (transcript !== null && kind !== 'session-start') {
      await step('transcript', () => spoolTranscript(transcript, { env, forceClose: kind === 'session-end' }))
    }
    const type = SESSION_EVENT[kind]
    if (type !== undefined) await step('event', () => spoolSessionEvent(type, kind, input, env, occurredAt))
    if (kind === 'session-start') {
      const dir = sweepDirectory(input, transcript)
      if (dir === null) noSweepDirectory = true
      else
        await step('sweep', async () => {
          const counts = await sweepTranscripts(dir, env)
          if (counts === null) noSweepDirectory = true
          return counts ?? undefined
        })
    }
  }

  let drain: DrainResult | null = null
  await step('drain', async () => {
    drain = await drainSpool({ env, deadlineMs: started + WORKER_DRAIN_BUDGET_MS })
  })
  return { ...total, drain, failures, ...(noSweepDirectory ? { noSweepDirectory: true as const } : {}) }
}

function drainSummary(drain: DrainResult | null): string {
  if (drain === null) return 'drain=failed'
  return (
    `sent=${drain.files_sent} accepted=${drain.accepted} duplicates=${drain.duplicates} rejected=${drain.rejected} ` +
    `dead=${drain.dead} remaining=${drain.remaining} stopped=${drain.stopped ?? 'none'}`
  )
}

/** The run's capture-log line: kind, session prefix and counts only. */
export function workerLogLine(kind: WorkerKind, input: ForwardedInput, result: WorkerResult, ms: number): string {
  const session = (input.session_id ?? '-').slice(0, 8)
  const failed = result.failures.length > 0 ? ` failed=${result.failures.join(',')}` : ''
  const sweep = result.noSweepDirectory ? ' sweep: no directory' : ''
  return (
    `worker ${kind} session=${session} events=${result.events} files=${result.files} ` +
    `redactions=${result.redactions} ${drainSummary(result.drain)} ms=${ms}${failed}${sweep}`
  )
}

function parseKind(argv: readonly string[]): WorkerKind | null {
  const i = argv.indexOf('--hook')
  const value = i >= 0 ? argv[i + 1] : undefined
  return WORKER_KINDS.find((k) => k === value) ?? null
}

async function main(): Promise<void> {
  const env = process.env
  const kind = parseKind(process.argv.slice(2))
  if (kind === null) {
    appendCaptureLog(env, 'worker started without a valid --hook kind')
    return
  }
  const input = forwardedInput(env[HOOK_INPUT_ENV] ?? '')?.input ?? {}
  const started = Date.now()
  const result = await runWorker(kind, input, env)
  appendCaptureLog(env, workerLogLine(kind, input, result, Date.now() - started))
}

if (isEntryPoint(import.meta.url)) {
  const watchdog = setTimeout(() => {
    appendCaptureLog(process.env, `worker watchdog fired after ${WORKER_WATCHDOG_MS} ms`)
    // Exits at once: the watchdog bounds the worker's lifetime, so it must not
    // wait on a stdout/stderr reader, and it writes nothing to either first.
    process.exit(0)
  }, WORKER_WATCHDOG_MS)
  watchdog.unref()
  main()
    .catch((err: unknown) => appendCaptureLog(process.env, `worker failed: ${errorLabel(err)}`))
    .finally(() => exitWhenFlushed(0))
}
