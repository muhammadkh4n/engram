/**
 * The drain over the spool's batch files, and the state it keeps in
 * `.state.json`: the server's backoff, each failing file's own backoff, and
 * the last error. One drainer runs at a time, holding `.drain.lock`.
 */

import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { ensurePrivateDir } from '../ingest/private-files.js'
import { captureEventsEndpoint, readCaptureToken } from './endpoint.js'
import { captureClientInfo, type CaptureClient } from './events.js'
import { appendCaptureLog } from './log.js'
import {
  type Batch,
  batchKey,
  clip,
  type Env,
  isCount,
  listBatches,
  removeStaleTmp,
  type SendContext,
  sendBatch,
  spoolRoot,
} from './spool.js'
import { acquireFileLease, type FileLease, writePrivateFileAtomic } from './transcript-cursor.js'

export const DRAIN_LOCK_STALE_MS = 120_000
export const DRAIN_BACKOFF_BASE_MS = 30_000
export const DRAIN_BACKOFF_MAX_MS = 30 * 60_000
export const DRAIN_MAX_PASSES = 3

const STATE_FILE = '.state.json'
const LOCK_FILE = '.drain.lock'

// ── State ────────────────────────────────────────────────────────────────

/** One batch file that failed without the route's verdict, backing off on its own. */
export interface FileBackoff {
  /** Failed sends since the file last got an answer that settled it. */
  attempts: number
  /** The file is skipped until then. */
  next_attempt_at: string
  /**
   * Known to fail alone: it failed in a drain in which the server settled
   * another file's send, so its failures say nothing about the server.
   */
  alone: boolean
}

/** The drainer's health, read by capture health checks. Times are ISO 8601. */
export interface SpoolState {
  v: 1
  last_ack_at: string | null
  last_error_at: string | null
  /** Clipped to 300 characters; never carries event text. */
  last_error: string | null
  /** Failures of the server as a whole; its backoff, `next_attempt_at`, holds back every file. */
  failures: number
  next_attempt_at: string | null
  /** Files backing off alone, by `<session dir>/<file name>`; only files still in the spool. */
  files: Record<string, FileBackoff>
  /**
   * A stop that sets no backoff (`bad_url`, `ack_mismatch`) as last logged.
   * Each drain would hit it again, so a repeat is neither logged nor saved;
   * another failure or a send the server settles clears it.
   */
  standing_stop: string | null
}

const INITIAL_STATE: SpoolState = {
  v: 1,
  last_ack_at: null,
  last_error_at: null,
  last_error: null,
  failures: 0,
  next_attempt_at: null,
  files: {},
  standing_stop: null,
}

const isTimeOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)))

/** An entry saved before `alone` existed has none; it reads as `false`. */
type SavedFileBackoff = Omit<FileBackoff, 'alone'> & { alone?: boolean }

function isFileBackoff(v: unknown): v is SavedFileBackoff {
  if (v === null || typeof v !== 'object') return false
  const f = v as Record<string, unknown>
  return (
    isCount(f.attempts) &&
    typeof f.next_attempt_at === 'string' &&
    !Number.isNaN(Date.parse(f.next_attempt_at)) &&
    (f.alone === undefined || typeof f.alone === 'boolean')
  )
}

/** A state file written before files backed off alone has no `files`; that reads as none. */
function isFileBackoffs(v: unknown): v is Record<string, SavedFileBackoff> | undefined {
  if (v === undefined) return true
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isFileBackoff)
}

function withAloneRead(files: Record<string, SavedFileBackoff> | undefined): Record<string, FileBackoff> {
  const read = ([key, f]: [string, SavedFileBackoff]) =>
    [key, { attempts: f.attempts, next_attempt_at: f.next_attempt_at, alone: f.alone ?? false }] as const
  return Object.fromEntries(Object.entries(files ?? {}).map(read))
}

/** The saved state, or the initial state when there is none or it cannot be used. */
export async function loadSpoolState(root: string): Promise<SpoolState> {
  try {
    const s = JSON.parse(await fs.readFile(join(root, STATE_FILE), 'utf8')) as Record<string, unknown>
    const valid =
      s.v === 1 &&
      isTimeOrNull(s.last_ack_at) &&
      isTimeOrNull(s.last_error_at) &&
      (s.last_error === null || typeof s.last_error === 'string') &&
      isCount(s.failures) &&
      isTimeOrNull(s.next_attempt_at) &&
      isFileBackoffs(s.files) &&
      (s.standing_stop === undefined || s.standing_stop === null || typeof s.standing_stop === 'string')
    if (!valid) return { ...INITIAL_STATE }
    const files = withAloneRead(s.files as Record<string, SavedFileBackoff> | undefined)
    return { ...s, files, standing_stop: s.standing_stop ?? null } as unknown as SpoolState
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

/** `files` with `key` set to `entry`, or without `key` when `entry` is undefined. */
function withEntry(
  files: Record<string, FileBackoff>,
  key: string,
  entry: FileBackoff | undefined,
): Record<string, FileBackoff> {
  const { [key]: _old, ...rest } = files
  return entry === undefined ? rest : { ...rest, [key]: entry }
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

/**
 * `lock_lost`: another drainer took the lock over mid-drain, so this one stopped before its next file.
 * `bad_url`: `ENGRAM_SERVER_URL` is not an http(s) URL; recorded in `.state.json` without the URL.
 */
export type DrainStop =
  | 'locked'
  | 'lock_lost'
  | 'backoff'
  | 'no_url'
  | 'bad_url'
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
  /** The file whose send just failed without the route's verdict; a second failure in a row ends the drain. */
  private lastFailedKey: string | null = null
  /** The server settled a send (an ack or its own refusal) in this drain. */
  private settledSend = false
  /** Files that failed in this drain; a settled send marks them known to fail alone. */
  private readonly failedHere = new Set<string>()
  private keptForRetry = false
  private sends = 0
  private skipped = 0

  constructor(
    private readonly root: string,
    private readonly opts: DrainOptions,
    private readonly lease: FileLease,
  ) {}

  async run(): Promise<DrainStop | null> {
    const first = await listBatches(this.root)
    if (first.length === 0) return null
    const serverUrl = this.opts.env.ENGRAM_SERVER_URL
    if (!this.opts.endpoint && !serverUrl) return 'no_url'
    this.state = await loadSpoolState(this.root)
    this.forgetGoneFiles(first)
    let endpoint: string
    try {
      endpoint = this.opts.endpoint ?? captureEventsEndpoint(serverUrl as string)
    } catch {
      // A configuration error, not a transient one: no backoff, and no URL
      // text in the state file or the log, since a URL can carry credentials.
      await this.stop('bad_url')
      return 'bad_url'
    }
    const next = this.state.next_attempt_at
    if (next !== null && Date.parse(next) > Date.now()) return 'backoff'
    let token: string
    try {
      token = await readCaptureToken(this.opts.env, this.opts.tokenFile)
    } catch (err) {
      await this.fail(`no_token: ${err instanceof Error ? err.message : 'unreadable'}`)
      return 'no_token'
    }
    const ctx: SendContext = {
      root: this.root,
      endpoint,
      token,
      client: this.opts.client ?? captureClientInfo(),
      log: (line) => appendCaptureLog(this.opts.env, line),
    }
    for (let pass = 0; pass < DRAIN_MAX_PASSES; pass++) {
      const batches = pass === 0 ? first : await listBatches(this.root)
      if (batches.length === 0) break
      const stop = await this.pass(ctx, batches)
      if (stop !== null) return stop
    }
    if (this.keptForRetry) return 'retry_later'
    // Every file is waiting out a backoff of its own.
    return this.sends === 0 && this.skipped > 0 ? 'backoff' : null
  }

  private async pass(ctx: SendContext, batches: Batch[]): Promise<DrainStop | null> {
    const queue = this.sendOrder(batches)
    for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
      if (this.opts.deadlineMs !== undefined && Date.now() >= this.opts.deadlineMs) return 'deadline'
      // The lease renews itself while a request is in flight; checking it
      // before each file stops this drainer once another has taken over.
      if (!(await this.lease.renew())) return 'lock_lost'
      const key = batchKey(batch)
      this.sends++
      const outcome = await sendBatch(ctx, batch)
      switch (outcome.kind) {
        case 'acked':
          this.lastFailedKey = null
          this.tally.files_sent++
          this.tally.accepted += outcome.accepted
          this.tally.duplicates += outcome.duplicates
          this.tally.rejected += outcome.rejected
          this.tally.dead += outcome.dead
          await this.acked(key)
          break
        case 'split':
          this.lastFailedKey = null
          this.tally.dead += outcome.dead
          await this.forget(key)
          queue.unshift(...outcome.batches)
          break
        case 'dead':
          this.lastFailedKey = null
          this.tally.dead += outcome.dead
          await this.refused(key)
          break
        case 'dropped':
          // No request was made, so this says nothing about the server.
          this.tally.dead += outcome.dead
          await this.forget(key)
          break
        case 'mismatch':
          await this.stop('ack_mismatch')
          return 'ack_mismatch'
        case 'retry': {
          this.keptForRetry = true
          await this.backOffFile(key, outcome.error)
          const previous = this.lastFailedKey
          this.lastFailedKey = key
          if (previous === null) break
          // Two sends in a row failed, so the drain ends. Only failures no
          // file's own record explains blame the server: a file known to
          // fail alone says nothing about it, and a drain in which the server
          // settled a send has marked every failing file so.
          if (!this.isAlone(previous) && !this.isAlone(key)) await this.fail(outcome.error)
          return 'retry_later'
        }
      }
    }
    return null
  }

  /**
   * Each file by its own record: files that never failed, then files whose
   * backoff is over and that are not known to fail alone, then files known to
   * fail alone; within a group the fewest attempts first and the oldest file
   * on a tie. Files inside their own backoff are skipped. A file goes back
   * behind the files that failed less often each time it fails, so a run of
   * failing files cannot keep a good file behind them from being sent, and
   * files known to fail alone go last, where they cannot end a drain before
   * the files that can show whether the server is back.
   */
  private sendOrder(batches: readonly Batch[]): Batch[] {
    const now = Date.now()
    const ranked: Array<{ batch: Batch; group: number; attempts: number; name: string }> = []
    for (const batch of batches) {
      const entry = this.state.files[batchKey(batch)]
      if (entry !== undefined && Date.parse(entry.next_attempt_at) > now) {
        this.skipped++
        continue
      }
      const group = entry === undefined ? 0 : entry.alone ? 2 : 1
      ranked.push({ batch, group, attempts: entry?.attempts ?? 0, name: basename(batch.path) })
    }
    // Batch file names start with their 13-digit write time, so name order is age order.
    ranked.sort((a, b) => a.group - b.group || a.attempts - b.attempts || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return ranked.map((r) => r.batch)
  }

  private isAlone(key: string): boolean {
    return this.state.files[key]?.alone === true
  }

  /** Drops backoff entries of files no longer in the spool, so the state never outgrows it. */
  private forgetGoneFiles(batches: readonly Batch[]): void {
    const present = new Set(batches.map(batchKey))
    const kept = Object.entries(this.state.files).filter(([key]) => present.has(key))
    this.state = { ...this.state, files: Object.fromEntries(kept) }
  }

  /** The file left the spool; it no longer backs off. */
  private async forget(key: string): Promise<void> {
    if (this.state.files[key] === undefined) return
    this.state = { ...this.state, files: withEntry(this.state.files, key, undefined) }
    await saveSpoolState(this.root, this.state)
  }

  /** The server accepted the file: every backoff and a standing stop end. */
  private async acked(key: string): Promise<void> {
    this.state = {
      ...this.state,
      last_ack_at: new Date().toISOString(),
      failures: 0,
      next_attempt_at: null,
      files: this.settled(key),
      standing_stop: null,
    }
    await saveSpoolState(this.root, this.state)
  }

  /** The route refused the file, which settles it: a standing stop no longer holds. */
  private async refused(key: string): Promise<void> {
    const files = this.settled(key)
    const unchanged =
      this.state.standing_stop === null &&
      Object.keys(files).length === Object.keys(this.state.files).length &&
      Object.entries(files).every(([k, f]) => f === this.state.files[k])
    if (unchanged) return
    this.state = { ...this.state, files, standing_stop: null }
    await saveSpoolState(this.root, this.state)
  }

  /**
   * `files` once the server settled `key`'s send: `key` leaves, and every
   * file that failed earlier in this drain is known to fail alone.
   */
  private settled(key: string): Record<string, FileBackoff> {
    this.settledSend = true
    const files = withEntry(this.state.files, key, undefined)
    return Object.fromEntries(
      Object.entries(files).map(([k, f]) => [k, this.failedHere.has(k) && !f.alone ? { ...f, alone: true } : f]),
    )
  }

  /**
   * The file failed without the route's verdict: it waits out a backoff of
   * its own, and is known to fail alone once the server settled another send
   * in this drain.
   */
  private async backOffFile(key: string, message: string): Promise<void> {
    const previous = this.state.files[key]
    const attempts = (previous?.attempts ?? 0) + 1
    const entry: FileBackoff = {
      attempts,
      next_attempt_at: nextAttemptAt(attempts, Date.now()),
      alone: previous?.alone === true || this.settledSend,
    }
    this.failedHere.add(key)
    this.state = {
      ...this.state,
      last_error: clip(message),
      last_error_at: new Date().toISOString(),
      files: withEntry(this.state.files, key, entry),
      standing_stop: null,
    }
    await saveSpoolState(this.root, this.state)
    appendCaptureLog(this.opts.env, `spool file backed off after ${attempts} failed send(s): ${clip(message)}`)
  }

  /** A stop with no backoff, recorded and logged once while its text holds. */
  private async stop(message: string): Promise<void> {
    const text = clip(message)
    if (this.state.standing_stop === text) return
    this.state = { ...this.state, standing_stop: text }
    await this.error(message)
  }

  private async error(message: string): Promise<void> {
    this.state = { ...this.state, last_error: clip(message), last_error_at: new Date().toISOString() }
    await saveSpoolState(this.root, this.state)
    appendCaptureLog(this.opts.env, `spool drain stopped: ${clip(message)}`)
  }

  /** A retryable failure of the server: every batch stays and the next attempt backs off. */
  private async fail(message: string): Promise<void> {
    const failures = this.state.failures + 1
    this.state = { ...this.state, failures, next_attempt_at: nextAttemptAt(failures, Date.now()), standing_stop: null }
    await this.error(message)
  }
}

/**
 * Sends the spool's batch files to the capture route. One drainer runs at a
 * time; a second returns `locked` at once, and a drainer whose lock was taken
 * over returns `lock_lost` before its next file.
 *
 * A file that fails for any reason but the route's own refusal is kept and
 * backs off alone (`attempts + 1`, its own `next_attempt_at`), and the drain
 * goes on. A file that fails in a drain in which the server settles another
 * file's send, before or after it, becomes known to fail alone. A second
 * failure in a row ends the drain; it raises the server's backoff only when
 * neither file is known to fail alone, so a drain that settles any send
 * never raises it.
 *
 * Files go out by their own record: files that never failed, then files
 * whose backoff is over and that are not known to fail alone, then files
 * known to fail alone; the fewest attempts first within each, the oldest
 * file on a tie. A file inside its own backoff is skipped. `retry_later`
 * means some file was kept for a later retry.
 */
export async function drainSpool(opts: DrainOptions): Promise<DrainResult> {
  const root = opts.root ?? spoolRoot(opts.env)
  ensurePrivateDir(root)
  const lockPath = join(root, LOCK_FILE)
  const lease = await acquireFileLease(lockPath, { staleMs: DRAIN_LOCK_STALE_MS, waitMs: 0 })
  const empty: Tally = { files_sent: 0, accepted: 0, duplicates: 0, rejected: 0, dead: 0 }
  if (lease === undefined) {
    return { ...empty, remaining: (await listBatches(root)).length, stopped: 'locked' }
  }
  try {
    await removeStaleTmp(root)
    const drain = new Drain(root, opts, lease)
    const stopped = await drain.run()
    if (drain.tally.dead > 0) appendCaptureLog(opts.env, `spool drain dead-lettered ${drain.tally.dead} event(s)`)
    return { ...drain.tally, remaining: (await listBatches(root)).length, stopped }
  } finally {
    await lease.release()
  }
}
