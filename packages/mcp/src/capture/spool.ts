/**
 * The local transport from this machine to the capture route.
 *
 * Producers write batch files, one directory per session under
 * `~/.engram/spool/`; a file is written under a `.`-prefixed temp name and
 * renamed, so a reader never sees a partial batch, and it never changes after
 * the rename. The drainer posts one request per file and deletes the file
 * only when a 200 response accounts for every event in it, so an event is
 * lost neither to a crash nor to a server that answered for part of a batch.
 * Every event is scrubbed just before it is sent, so producers need no
 * scrubber of their own. The transport talks only to the server.
 *
 * Names that start with `.` belong to the spool itself: `.dead/` (refused
 * events), `.state.json` (the drainer's health), `.drain.lock` and temp files.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { scrubSecrets, scrubStructured } from '@engram-mem/core'
import { CAPTURE_EVENTS_MAX } from '../capture-events/contract.js'
import { scrubEvent } from '../capture-events/scrub.js'
import { appendPrivateFile, ensurePrivateDir, openPrivateHandle } from '../ingest/private-files.js'
import { captureEventsEndpoint, readCaptureToken } from './endpoint.js'
import { captureClientInfo, sessionFileName, type CaptureClient, type CaptureEvent } from './events.js'
import { appendCaptureLog } from './log.js'
import { BATCH_BYTES_MAX } from './route-fit.js'
import { acquireFileLock, refreshFileLock, releaseFileLock, writePrivateFileAtomic } from './transcript-cursor.js'

type Env = Record<string, string | undefined>

export const DRAIN_LOCK_STALE_MS = 120_000
export const DRAIN_REQUEST_TIMEOUT_MS = 30_000
export const DRAIN_BACKOFF_BASE_MS = 30_000
export const DRAIN_BACKOFF_MAX_MS = 30 * 60_000
export const DRAIN_MAX_PASSES = 3
/** A temp file this old was left by a writer that crashed before its rename. */
export const SPOOL_TMP_STALE_MS = 10 * 60_000
const STATE_MESSAGE_MAX_CHARS = 300

const DEAD_DIR = '.dead'
const STATE_FILE = '.state.json'
const LOCK_FILE = '.drain.lock'
const BATCH_SUFFIX = '.jsonl'
const TMP_SUFFIX = '.tmp'

/** `~/.engram/spool`, under the env's HOME. */
export function spoolRoot(env: Env): string {
  return join(env.HOME || homedir(), '.engram', 'spool')
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code
}

function clip(message: string): string {
  return message.length > STATE_MESSAGE_MAX_CHARS ? message.slice(0, STATE_MESSAGE_MAX_CHARS) : message
}

// ── Writing ──────────────────────────────────────────────────────────────

let lastBatchMs = 0

/**
 * `<13-digit unix ms>-<pid>-<8 hex>.jsonl`. The millisecond never repeats
 * within a process, so the files of one write sort in the order written.
 */
function batchFileName(): string {
  const ms = Math.max(Date.now(), lastBatchMs + 1)
  lastBatchMs = ms
  return `${String(ms).padStart(13, '0')}-${process.pid}-${randomBytes(4).toString('hex')}${BATCH_SUFFIX}`
}

/** Splits serialized events into batches within the route's event limit and body cap. */
function chunkLines(lines: readonly string[]): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let bytes = 0
  for (const line of lines) {
    // One byte for the comma that separates events in the request body.
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (current.length > 0 && (current.length >= CAPTURE_EVENTS_MAX || bytes + size > BATCH_BYTES_MAX)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(line)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Writes `.<name>.tmp` beside the final name, then renames it into place. */
async function writeBatchFile(dir: string, lines: readonly string[]): Promise<string> {
  const name = batchFileName()
  const path = join(dir, name)
  const tmp = join(dir, `.${name}${TMP_SUFFIX}`)
  try {
    const handle = await openPrivateHandle(tmp, 'wx')
    try {
      await handle.writeFile(lines.map((line) => `${line}\n`).join(''))
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
  return path
}

/** Writes `events` as batch files in the session's spool directory; returns the paths written. */
export async function writeSpoolBatch(
  sessionId: string,
  events: readonly CaptureEvent[],
  opts: { root: string },
): Promise<string[]> {
  if (events.length === 0) return []
  ensurePrivateDir(opts.root)
  const dir = join(opts.root, sessionFileName(sessionId))
  ensurePrivateDir(dir)
  const paths: string[] = []
  for (const chunk of chunkLines(events.map((event) => JSON.stringify(event)))) {
    paths.push(await writeBatchFile(dir, chunk))
  }
  return paths
}

// ── Listing ──────────────────────────────────────────────────────────────

interface Batch {
  /** The session directory's name. */
  dir: string
  path: string
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return []
    throw err
  }
}

async function sessionDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return []
    throw err
  }
}

/** Every batch file, session by session, the oldest first within each session. */
async function listBatches(root: string): Promise<Batch[]> {
  const batches: Batch[] = []
  for (const dir of await sessionDirs(root)) {
    const names = (await listNames(join(root, dir)))
      .filter((n) => !n.startsWith('.') && n.endsWith(BATCH_SUFFIX))
      .sort()
    for (const name of names) batches.push({ dir, path: join(root, dir, name) })
  }
  return batches
}

async function removeStaleTmp(root: string): Promise<void> {
  const dirs = [root, ...(await sessionDirs(root)).map((d) => join(root, d))]
  for (const dir of dirs) {
    for (const name of await listNames(dir)) {
      if (!name.startsWith('.') || !name.endsWith(TMP_SUFFIX)) continue
      const path = join(dir, name)
      try {
        if (Date.now() - (await fs.stat(path)).mtimeMs > SPOOL_TMP_STALE_MS) await fs.rm(path, { force: true })
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) throw err
      }
    }
  }
}

// ── State and dead letters ───────────────────────────────────────────────

/** The drainer's health, read by capture health checks. Times are ISO 8601. */
export interface SpoolState {
  v: 1
  last_ack_at: string | null
  last_error_at: string | null
  /** Clipped to 300 characters; never carries event text. */
  last_error: string | null
  failures: number
  next_attempt_at: string | null
}

const INITIAL_STATE: SpoolState = {
  v: 1,
  last_ack_at: null,
  last_error_at: null,
  last_error: null,
  failures: 0,
  next_attempt_at: null,
}

const isTimeOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)))

/** The saved state, or the initial state when there is none or it cannot be used. */
export async function loadSpoolState(root: string): Promise<SpoolState> {
  try {
    const s = JSON.parse(await fs.readFile(join(root, STATE_FILE), 'utf8')) as Record<string, unknown>
    const valid =
      s.v === 1 &&
      isTimeOrNull(s.last_ack_at) &&
      isTimeOrNull(s.last_error_at) &&
      (s.last_error === null || typeof s.last_error === 'string') &&
      typeof s.failures === 'number' &&
      Number.isSafeInteger(s.failures) &&
      s.failures >= 0 &&
      isTimeOrNull(s.next_attempt_at)
    return valid ? (s as unknown as SpoolState) : { ...INITIAL_STATE }
  } catch {
    return { ...INITIAL_STATE }
  }
}

async function saveSpoolState(root: string, state: SpoolState): Promise<void> {
  await writePrivateFileAtomic(join(root, STATE_FILE), `${JSON.stringify(state)}\n`)
}

/** `min(base × 2^(failures−1), max)` ms after `now`. */
function nextAttemptAt(failures: number, now: number): string {
  const delay = Math.min(DRAIN_BACKOFF_BASE_MS * 2 ** Math.max(failures - 1, 0), DRAIN_BACKOFF_MAX_MS)
  return new Date(now + delay).toISOString()
}

interface DeadLetter {
  at: string
  status?: number
  reason: string
  /** Absent only when a line could not be masked; `length` and `sha256` stand in for it. */
  event?: unknown
  length?: number
  sha256?: string
}

function appendDeadLetters(root: string, dir: string, letters: readonly DeadLetter[]): void {
  if (letters.length === 0) return
  const deadDir = join(root, DEAD_DIR)
  ensurePrivateDir(deadDir)
  appendPrivateFile(join(deadDir, `${dir}${BATCH_SUFFIX}`), letters.map((l) => `${JSON.stringify(l)}\n`).join(''))
}

/**
 * Records events a producer could not spool because the route would refuse
 * them, in the session's dead-letter file beside the drainer's own.
 */
export function writeDeadLetters(
  sessionId: string,
  letters: ReadonlyArray<{ reason: string; event: unknown }>,
  opts: { root: string },
): void {
  if (letters.length === 0) return
  ensurePrivateDir(opts.root)
  const at = new Date().toISOString()
  appendDeadLetters(
    opts.root,
    sessionFileName(sessionId),
    letters.map((l) => ({ at, reason: clip(l.reason), event: l.event })),
  )
}

// ── Sending one batch ────────────────────────────────────────────────────

interface SendContext {
  root: string
  endpoint: string
  token: string
  client: CaptureClient
}

type Outcome =
  | { kind: 'acked'; accepted: number; duplicates: number; rejected: number; dead: number }
  | { kind: 'split'; batches: Batch[]; dead: number }
  | { kind: 'dead'; dead: number }
  | { kind: 'mismatch' }
  | { kind: 'retry'; error: string }

interface Prepared {
  lines: string[]
  events: CaptureEvent[]
  /** Lines that can never be sent: unparsable JSON, or a value scrubbing cannot walk. */
  unsendable: DeadLetter[]
}

/**
 * The line with its secrets masked. A line that parses passes every scrub view
 * (scrubStructured) and is serialized again: scrubbing only the serialized
 * text would read each string escaped (a newline as `\n`, hiding a token at a
 * line start) and miss an env or JSON block held inside a value. Only an
 * unparsable line is scrubbed as text. A refusal throws, like a scrub that
 * fails, so the dead letter keeps the line's length and sha256 alone.
 */
async function maskedLine(line: string): Promise<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return (await scrubSecrets(line)).text
  }
  const walked = await scrubStructured(parsed)
  if (!walked.ok) throw new Error(`spool line not masked: ${walked.reason}`)
  return JSON.stringify(walked.value)
}

/**
 * A spool line that can never be sent, as its dead letter. The line was
 * written by a producer that may not have scrubbed it, so the dead letter
 * holds the line masked; a line that cannot be masked is recorded by its
 * length and sha256 alone.
 */
async function unsendableLine(line: string, reason: string, at: string): Promise<DeadLetter> {
  try {
    return { at, reason, event: await maskedLine(line) }
  } catch {
    return { at, reason, length: line.length, sha256: createHash('sha256').update(line, 'utf8').digest('hex') }
  }
}

/**
 * Parses and scrubs a batch. Scrubbing is pure and the secret registry never
 * throws, so an event that makes `scrubEvent` throw is malformed and would be
 * refused by the route; it is dead-lettered rather than sent unscrubbed.
 */
async function prepareBatch(raw: string, at: string): Promise<Prepared> {
  const prepared: Prepared = { lines: [], events: [], unsendable: [] }
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      prepared.unsendable.push(await unsendableLine(line, 'invalid_json', at))
      continue
    }
    try {
      prepared.events.push((await scrubEvent(parsed as CaptureEvent)).event)
      prepared.lines.push(line)
    } catch {
      prepared.unsendable.push(await unsendableLine(line, 'unscrubbable_event', at))
    }
  }
  return prepared
}

interface Ack {
  accepted: number
  duplicates: number
  rejected: Array<{ index: unknown; reason: unknown }>
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function parseAck(body: unknown): Ack | null {
  if (body === null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (!isCount(b.accepted) || !isCount(b.duplicates) || !Array.isArray(b.rejected)) return null
  if (!b.rejected.every((r) => r !== null && typeof r === 'object')) return null
  return { accepted: b.accepted, duplicates: b.duplicates, rejected: b.rejected as Ack['rejected'] }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function errorOf(body: unknown, status: number): string {
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' && error.length > 0 ? clip(error) : `http_${status}`
}

/** 401, 403, 404 and 429 mean the server or its token is not ready yet, not that the batch is bad. */
function isRefusal(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 404, 429].includes(status)
}

async function post(ctx: SendContext, events: CaptureEvent[]): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const response = await fetch(ctx.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ client: ctx.client, events }),
      signal: AbortSignal.timeout(DRAIN_REQUEST_TIMEOUT_MS),
    })
    return { status: response.status, body: parseBody(await response.text()) }
  } catch (err) {
    const e = err as Error & { cause?: { code?: unknown } }
    const code = typeof e?.cause?.code === 'string' ? ` ${e.cause.code}` : ''
    return { error: clip(`network: ${e?.name ?? 'Error'}${code}`) }
  }
}

/** Removes a batch whose every event has been answered for, recording the dead letters first. */
async function settle(ctx: SendContext, batch: Batch, letters: readonly DeadLetter[]): Promise<void> {
  appendDeadLetters(ctx.root, batch.dir, letters)
  await fs.rm(batch.path, { force: true })
}

/** A 200 settles the batch only when its counts account for every event sent. */
async function settleAck(
  ctx: SendContext,
  batch: Batch,
  sent: Pick<Prepared, 'events' | 'unsendable'>,
  ack: Ack | null,
  at: string,
): Promise<Outcome> {
  const { events, unsendable } = sent
  if (!ack || ack.accepted + ack.duplicates + ack.rejected.length !== events.length) return { kind: 'mismatch' }
  const rejected: DeadLetter[] = ack.rejected.map((r) => ({
    at,
    reason: typeof r.reason === 'string' ? clip(r.reason) : 'rejected',
    event: (typeof r.index === 'number' ? events[r.index] : undefined) ?? null,
  }))
  await settle(ctx, batch, [...unsendable, ...rejected])
  return {
    kind: 'acked',
    accepted: ack.accepted,
    duplicates: ack.duplicates,
    rejected: rejected.length,
    dead: unsendable.length + rejected.length,
  }
}

async function sendBatch(ctx: SendContext, batch: Batch): Promise<Outcome> {
  let raw: string
  try {
    raw = await fs.readFile(batch.path, 'utf8')
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { kind: 'dead', dead: 0 }
    throw err
  }
  const at = new Date().toISOString()
  const { lines, events, unsendable } = await prepareBatch(raw, at)
  if (events.length === 0) {
    await settle(ctx, batch, unsendable)
    return { kind: 'dead', dead: unsendable.length }
  }

  const reply = await post(ctx, events)
  if ('error' in reply) return { kind: 'retry', error: reply.error }
  const { status, body } = reply

  if (status === 200) return settleAck(ctx, batch, { events, unsendable }, parseAck(body), at)

  if (status === 413 && events.length > 1) {
    const half = Math.ceil(lines.length / 2)
    const halves: Batch[] = []
    for (const part of [lines.slice(0, half), lines.slice(half)]) {
      halves.push({ dir: batch.dir, path: await writeBatchFile(join(ctx.root, batch.dir), part) })
    }
    await settle(ctx, batch, unsendable)
    return { kind: 'split', batches: halves, dead: unsendable.length }
  }

  if (status === 413 || isRefusal(status)) {
    const reason = errorOf(body, status)
    await settle(ctx, batch, [...unsendable, ...events.map((event) => ({ at, status, reason, event }))])
    return { kind: 'dead', dead: unsendable.length + events.length }
  }

  return { kind: 'retry', error: errorOf(body, status) }
}

// ── The drain ────────────────────────────────────────────────────────────

export interface DrainOptions {
  env: Env
  /** Defaults to `spoolRoot(env)`. */
  root?: string
  /** Defaults to `captureEventsEndpoint(env.ENGRAM_SERVER_URL)`. */
  endpoint?: string
  /** Defaults to the file `ENGRAM_CAPTURE_TOKEN_FILE` names. */
  tokenFile?: string
  /** Unix ms after which no further request is started. */
  deadlineMs?: number
  /** Defaults to `captureClientInfo()`. */
  client?: CaptureClient
}

/** `lock_lost`: another drainer took the lock over mid-drain, so this one stopped before its next file. */
export type DrainStop =
  | 'locked'
  | 'lock_lost'
  | 'backoff'
  | 'no_url'
  | 'no_token'
  | 'ack_mismatch'
  | 'retry_later'
  | 'deadline'

export interface DrainResult {
  /** Batch files deleted after a 200 response covered them. */
  files_sent: number
  accepted: number
  duplicates: number
  rejected: number
  /** Events written to `.dead/`, the rejected ones included. */
  dead: number
  /** Batch files left in the spool. */
  remaining: number
  stopped: DrainStop | null
}

interface Tally {
  files_sent: number
  accepted: number
  duplicates: number
  rejected: number
  dead: number
}

class Drain {
  private state: SpoolState = { ...INITIAL_STATE }
  readonly tally: Tally = { files_sent: 0, accepted: 0, duplicates: 0, rejected: 0, dead: 0 }

  constructor(
    private readonly root: string,
    private readonly opts: DrainOptions,
    private readonly lock: { path: string; token: string },
  ) {}

  async run(): Promise<DrainStop | null> {
    const first = await listBatches(this.root)
    if (first.length === 0) return null
    const serverUrl = this.opts.env.ENGRAM_SERVER_URL
    const endpoint = this.opts.endpoint ?? (serverUrl ? captureEventsEndpoint(serverUrl) : undefined)
    if (!endpoint) return 'no_url'
    this.state = await loadSpoolState(this.root)
    const next = this.state.next_attempt_at
    if (next !== null && Date.parse(next) > Date.now()) return 'backoff'
    let token: string
    try {
      token = await readCaptureToken(this.opts.env, this.opts.tokenFile)
    } catch (err) {
      await this.fail(`no_token: ${err instanceof Error ? err.message : 'unreadable'}`)
      return 'no_token'
    }
    const ctx: SendContext = { root: this.root, endpoint, token, client: this.opts.client ?? captureClientInfo() }
    for (let pass = 0; pass < DRAIN_MAX_PASSES; pass++) {
      const batches = pass === 0 ? first : await listBatches(this.root)
      if (batches.length === 0) break
      const stop = await this.pass(ctx, batches)
      if (stop !== null) return stop
    }
    return null
  }

  private async pass(ctx: SendContext, batches: Batch[]): Promise<DrainStop | null> {
    const queue = [...batches]
    for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
      if (this.opts.deadlineMs !== undefined && Date.now() >= this.opts.deadlineMs) return 'deadline'
      // A drain with no deadline can outlive the lock's stale age; refreshing
      // it before each file keeps a second drainer from joining, and a lock
      // that is no longer ours means one already has.
      if (!(await refreshFileLock(this.lock.path, this.lock.token))) return 'lock_lost'
      const outcome = await sendBatch(ctx, batch)
      switch (outcome.kind) {
        case 'acked':
          this.tally.files_sent++
          this.tally.accepted += outcome.accepted
          this.tally.duplicates += outcome.duplicates
          this.tally.rejected += outcome.rejected
          this.tally.dead += outcome.dead
          await this.acked()
          break
        case 'split':
          this.tally.dead += outcome.dead
          queue.unshift(...outcome.batches)
          break
        case 'dead':
          this.tally.dead += outcome.dead
          break
        case 'mismatch':
          await this.error('ack_mismatch')
          return 'ack_mismatch'
        case 'retry':
          await this.fail(outcome.error)
          return 'retry_later'
      }
    }
    return null
  }

  private async acked(): Promise<void> {
    this.state = { ...this.state, last_ack_at: new Date().toISOString(), failures: 0, next_attempt_at: null }
    await saveSpoolState(this.root, this.state)
  }

  private async error(message: string): Promise<void> {
    this.state = { ...this.state, last_error: clip(message), last_error_at: new Date().toISOString() }
    await saveSpoolState(this.root, this.state)
    appendCaptureLog(this.opts.env, `spool drain stopped: ${clip(message)}`)
  }

  /** A retryable failure: the batch stays and the next attempt backs off. */
  private async fail(message: string): Promise<void> {
    const failures = this.state.failures + 1
    this.state = { ...this.state, failures, next_attempt_at: nextAttemptAt(failures, Date.now()) }
    await this.error(message)
  }
}

/**
 * Sends the spool's batch files to the capture route. One drainer runs at a
 * time; a second returns `locked` at once, and a drainer whose lock was taken
 * over returns `lock_lost` before its next file. Nothing is sent before the backoff
 * set by the last retryable failure has passed.
 */
export async function drainSpool(opts: DrainOptions): Promise<DrainResult> {
  const root = opts.root ?? spoolRoot(opts.env)
  ensurePrivateDir(root)
  const lockPath = join(root, LOCK_FILE)
  const lock = await acquireFileLock(lockPath, { staleMs: DRAIN_LOCK_STALE_MS, waitMs: 0 })
  const empty: Tally = { files_sent: 0, accepted: 0, duplicates: 0, rejected: 0, dead: 0 }
  if (lock === undefined) {
    return { ...empty, remaining: (await listBatches(root)).length, stopped: 'locked' }
  }
  try {
    await removeStaleTmp(root)
    const drain = new Drain(root, opts, { path: lockPath, token: lock })
    const stopped = await drain.run()
    if (drain.tally.dead > 0) appendCaptureLog(opts.env, `spool drain dead-lettered ${drain.tally.dead} event(s)`)
    return { ...drain.tally, remaining: (await listBatches(root)).length, stopped }
  } finally {
    await releaseFileLock(lockPath, lock)
  }
}
