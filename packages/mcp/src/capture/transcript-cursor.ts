/**
 * Where a session's transcript was read up to, and the lock that keeps two
 * readers of one transcript (a Stop hook and a SessionEnd hook, say) from
 * emitting the same lines at once.
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AnswerQuestion } from '../capture-events/contract.js'
import { ensurePrivateDir, openPrivateHandle } from '../ingest/private-files.js'
import { sessionFileName } from './events.js'

/** The kinds of ref a Bash call's result can carry. */
export type RefKind = 'commit' | 'pr'

/**
 * A tool call of a force-closed turn that had no result yet. It keeps what the
 * result's event needs: a dialog's questions, and which refs a Bash result yields.
 */
export interface PendingCall {
  id: string
  name: string
  questions?: AnswerQuestion[]
  ref_kinds?: RefKind[]
}

export interface TranscriptCursor {
  v: 1
  transcript_path: string
  /** Byte offset of the first line after the last closed turn. */
  offset: number
  /** Lines before `offset`; the next line read is line `line + 1`. */
  line: number
  /** The uuid of the last line before `offset` that has one, and that line's byte offset. */
  last_uuid: string | null
  last_line_start: number | null
  /** Event uuids already emitted from lines at or after `offset` (an open turn's prompt and answers). */
  open_turn_emitted: string[]
  /** The session's plan folders as of `offset`, most recent first. */
  plan_dirs: string[]
  /**
   * Calls of force-closed turns still waiting for a result as of `offset`, oldest first, so a
   * result written after an idle sweep (a dialog answered later) still finds its call.
   */
  pending_calls: PendingCall[]
}

export const READER_LOCK_STALE_MS = 60_000
export const READER_LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MIN_MS = 5
const LOCK_RETRY_MAX_MS = 50

export interface FileLockOptions {
  /** A lock whose file is older than this is taken over. */
  staleMs: number
  /** How long to keep retrying a held lock; 0 tries once. */
  waitMs: number
}

type Env = Record<string, string | undefined>

/** `~/.engram/cursors`, under the env's HOME. */
export function cursorRoot(env: Env): string {
  return join(env.HOME || homedir(), '.engram', 'cursors')
}

export function emptyCursor(transcriptPath: string): TranscriptCursor {
  return {
    v: 1,
    transcript_path: transcriptPath,
    offset: 0,
    line: 0,
    last_uuid: null,
    last_line_start: null,
    open_turn_emitted: [],
    plan_dirs: [],
    pending_calls: [],
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function isQuestion(v: unknown): v is AnswerQuestion {
  return (
    isRecord(v) &&
    typeof v.question === 'string' &&
    typeof v.header === 'string' &&
    typeof v.multiSelect === 'boolean' &&
    Array.isArray(v.options) &&
    v.options.every((o) => isRecord(o) && typeof o.label === 'string' && typeof o.description === 'string')
  )
}

function isPendingCall(v: unknown): v is PendingCall {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.questions === undefined || (Array.isArray(v.questions) && v.questions.every(isQuestion))) &&
    (v.ref_kinds === undefined || (Array.isArray(v.ref_kinds) && v.ref_kinds.every((k) => k === 'commit' || k === 'pr')))
  )
}

function parseCursor(value: unknown): TranscriptCursor | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const c = value as Record<string, unknown>
  const lastStart = c.last_line_start
  const valid =
    c.v === 1 &&
    typeof c.transcript_path === 'string' &&
    isCount(c.offset) &&
    isCount(c.line) &&
    (c.last_uuid === null || typeof c.last_uuid === 'string') &&
    (lastStart === null || (isCount(lastStart) && lastStart < c.offset)) &&
    (c.last_uuid === null) === (lastStart === null) &&
    isStringArray(c.open_turn_emitted) &&
    isStringArray(c.plan_dirs) &&
    // A cursor written before calls were carried has none waiting.
    (c.pending_calls === undefined || (Array.isArray(c.pending_calls) && c.pending_calls.every(isPendingCall)))
  if (!valid) return null
  return {
    v: 1,
    transcript_path: c.transcript_path as string,
    offset: c.offset as number,
    line: c.line as number,
    last_uuid: c.last_uuid as string | null,
    last_line_start: lastStart as number | null,
    open_turn_emitted: [...(c.open_turn_emitted as string[])],
    plan_dirs: [...(c.plan_dirs as string[])],
    pending_calls: [...((c.pending_calls as PendingCall[] | undefined) ?? [])],
  }
}

/** The saved cursor, or null when there is none or it cannot be used (the reader then starts at 0). */
export async function loadCursor(root: string, sessionId: string): Promise<TranscriptCursor | null> {
  try {
    return parseCursor(JSON.parse(await fs.readFile(join(root, `${sessionFileName(sessionId)}.json`), 'utf8')))
  } catch {
    return null
  }
}

/** Writes `data` to a sibling temp file with mode 0600 and renames it over `path`. */
export async function writePrivateFileAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    const handle = await openPrivateHandle(tmp, 'wx')
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

export async function saveCursor(root: string, sessionId: string, cursor: TranscriptCursor): Promise<void> {
  ensurePrivateDir(root)
  await writePrivateFileAtomic(join(root, `${sessionFileName(sessionId)}.json`), `${JSON.stringify(cursor)}\n`)
}

// ── Locks ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function tryRename(from: string, to: string): Promise<boolean> {
  try {
    await fs.rename(from, to)
    return true
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false
    throw err
  }
}

/** `O_CREAT|O_EXCL`: false when another holder has the lock. */
async function tryCreateLock(path: string, token: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await openPrivateHandle(path, 'wx')
  } catch (err) {
    if (isErrno(err, 'EEXIST')) return false
    throw err
  }
  try {
    await handle.writeFile(`${token}\n`)
  } finally {
    await handle.close()
  }
  return true
}

/**
 * Removes a lock older than `staleMs`; true when it did. The lock is renamed
 * aside first so that of two processes that both found it stale only one
 * removes it; if the file moved aside is fresh, its holder retook the lock
 * between the stat and the rename, and it is linked back unless a newer lock
 * already exists.
 */
async function removeStaleLock(path: string, staleMs: number): Promise<boolean> {
  let mtimeMs: number
  try {
    mtimeMs = (await fs.stat(path)).mtimeMs
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return true
    throw err
  }
  if (Date.now() - mtimeMs <= staleMs) return false
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString('hex')}`
  if (!(await tryRename(path, aside))) return true
  try {
    if (Date.now() - (await fs.stat(aside)).mtimeMs <= staleMs) {
      await fs.link(aside, path).catch((err: unknown) => {
        if (!isErrno(err, 'EEXIST')) throw err
      })
      return false
    }
    return true
  } finally {
    await fs.rm(aside, { force: true })
  }
}

/** The lock's token, or undefined when another holder kept it for `waitMs`. */
async function acquireFileLock(path: string, opts: FileLockOptions): Promise<string | undefined> {
  const token = `${process.pid} ${Date.now()} ${randomBytes(6).toString('hex')}`
  const deadline = Date.now() + opts.waitMs
  let backoffMs = LOCK_RETRY_MIN_MS
  for (;;) {
    if (await tryCreateLock(path, token)) return token
    if (await removeStaleLock(path, opts.staleMs)) continue
    const leftMs = deadline - Date.now()
    if (leftMs <= 0) return undefined
    await sleep(Math.min(leftMs, backoffMs / 2 + Math.random() * (backoffMs / 2)))
    backoffMs = Math.min(backoffMs * 2, LOCK_RETRY_MAX_MS)
  }
}

/** Removes the lock only while it still carries this holder's token. */
async function releaseFileLock(path: string, token: string): Promise<void> {
  try {
    if ((await fs.readFile(path, 'utf8')).trim() === token) await fs.rm(path, { force: true })
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err
  }
}

/** Marks the lock fresh while it still carries this holder's token; false when it is gone or another holder's. */
async function refreshFileLock(path: string, token: string): Promise<boolean> {
  try {
    if ((await fs.readFile(path, 'utf8')).trim() !== token) return false
    const now = new Date()
    await fs.utimes(path, now, now)
    return true
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false
    throw err
  }
}

/** A held lock that renews itself; see `acquireFileLease`. */
export interface FileLease {
  /** True once a renewal found the lock gone or another holder's: the holder must stop before its next write. */
  readonly lost: boolean
  /** Renews the lock now; false, and lost from then on, when it is no longer this holder's. */
  renew(): Promise<boolean>
  /** Stops renewing and removes the lock while it still carries this holder's token. */
  release(): Promise<void>
}

class RenewingLease implements FileLease {
  private isLost = false
  private renewing: Promise<boolean> | null = null
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly path: string,
    private readonly token: string,
    staleMs: number,
  ) {
    this.timer = setInterval(() => void this.renew(), Math.max(1, Math.floor(staleMs / 3)))
    this.timer.unref?.()
  }

  get lost(): boolean {
    return this.isLost
  }

  renew(): Promise<boolean> {
    if (this.isLost) return Promise.resolve(false)
    // A timer tick and an explicit renewal share one in-flight check.
    this.renewing ??= this.refresh().finally(() => {
      this.renewing = null
    })
    return this.renewing
  }

  async release(): Promise<void> {
    clearInterval(this.timer)
    await this.renewing
    await releaseFileLock(this.path, this.token)
  }

  /** Never rejects: a lock whose file cannot be checked cannot be shown to be held, so it counts as lost. */
  private async refresh(): Promise<boolean> {
    let held: boolean
    try {
      held = await refreshFileLock(this.path, this.token)
    } catch {
      held = false
    }
    if (!held) {
      this.isLost = true
      clearInterval(this.timer)
    }
    return held
  }
}

/**
 * Takes `path` as a lease: the lock file's mtime is renewed every third of
 * `staleMs` while held, so a holder working longer than `staleMs` is not
 * taken over as stale. Undefined when another holder kept the lock for
 * `waitMs`. A renewal that finds the lock gone or another holder's marks the
 * lease lost; the holder checks `lost` (or `renew()`) before each write that
 * another holder's work could contradict.
 */
export async function acquireFileLease(path: string, opts: FileLockOptions): Promise<FileLease | undefined> {
  const token = await acquireFileLock(path, opts)
  return token === undefined ? undefined : new RenewingLease(path, token, opts.staleMs)
}

/** What a read is asked to do. A close request is the stronger one: it also closes a turn still open at EOF. */
export interface ReadRequest {
  forceClose: boolean
}

const CLOSE_REQUEST = 'close'
const READ_REQUEST = 'read'

/** Removes `path`; true when it existed. */
async function consume(path: string): Promise<boolean> {
  try {
    await fs.rm(path)
    return true
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false
    throw err
  }
}

/**
 * `<dir>.again/`, one file per waiting request. A directory of its own,
 * because a name prefix in the shared root could also match the files of a
 * session whose id starts with this one's followed by `.again.`.
 */
function requestDir(root: string, name: string): string {
  return join(root, `${name}.again`)
}

/**
 * Leaves a request for the holder as a file of its own. It is written under
 * a `.`-prefixed temp name and renamed into place, so the holder never reads
 * a request half written, and no waiter writes into another's file.
 */
async function leaveRequest(dir: string, request: ReadRequest): Promise<void> {
  ensurePrivateDir(dir)
  const path = join(dir, `${process.pid}-${randomBytes(4).toString('hex')}`)
  await writePrivateFileAtomic(path, `${request.forceClose ? CLOSE_REQUEST : READ_REQUEST}\n`)
}

/**
 * Takes every request waiting in `dir`, or null when none is. Only renamed
 * request files are listed (a temp name starts with `.`), and each one is
 * read whole before it is removed; a request published after the listing is
 * found by the next take.
 */
async function takeRequests(dir: string): Promise<ReadRequest | null> {
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((n) => !n.startsWith('.'))
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  let taken = false
  let forceClose = false
  for (const n of names) {
    const path = join(dir, n)
    let text: string
    try {
      text = await fs.readFile(path, 'utf8')
    } catch (err) {
      if (isErrno(err, 'ENOENT')) continue
      throw err
    }
    await consume(path)
    taken = true
    if (text.split('\n').includes(CLOSE_REQUEST)) forceClose = true
  }
  return taken ? { forceClose } : null
}

/**
 * Runs `fn` holding `<root>/<dir>.lock` as a lease, so a read longer than the
 * lock's stale age keeps it. A reader that cannot take the lock within the
 * wait leaves its request as a file in `<dir>.again/` and returns undefined:
 * the holder takes those files after its read and reads once more before it releases the
 * lock, so the lines that reader came for are not left unread. Every read is
 * asked for the strongest request among the caller's and the ones waiting, so
 * a session end that found the lock busy still closes the final turn. `fn`
 * gets the lease and must not save a cursor once it is lost, since the holder
 * that took the lock over may already have saved a later one; a lost lease
 * reads no more and leaves the waiting requests to that holder.
 */
export async function withReaderLock<T>(
  root: string,
  sessionId: string,
  fn: (lease: FileLease, read: ReadRequest) => Promise<T>,
  opts: Partial<FileLockOptions> & { forceClose?: boolean } = {},
): Promise<T | undefined> {
  ensurePrivateDir(root)
  const name = sessionFileName(sessionId)
  const lockPath = join(root, `${name}.lock`)
  const requests = requestDir(root, name)
  const own: ReadRequest = { forceClose: opts.forceClose === true }
  const lease = await acquireFileLease(lockPath, {
    staleMs: opts.staleMs ?? READER_LOCK_STALE_MS,
    waitMs: opts.waitMs ?? READER_LOCK_WAIT_MS,
  })
  if (lease === undefined) {
    await leaveRequest(requests, own)
    return undefined
  }
  const strongest = (waiting: ReadRequest | null): ReadRequest => ({
    forceClose: own.forceClose || waiting?.forceClose === true,
  })
  try {
    // A leftover from an earlier holder is covered by this first read.
    let result = await fn(lease, strongest(await takeRequests(requests)))
    while (!lease.lost) {
      const waiting = await takeRequests(requests)
      if (waiting === null) break
      result = await fn(lease, strongest(waiting))
    }
    return result
  } finally {
    await lease.release()
  }
}
