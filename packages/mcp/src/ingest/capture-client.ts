/**
 * Client side of the HTTP server's `POST /capture` route: post one capture,
 * keep what could not be sent in an append-only spool under `~/.engram/`, and
 * resend it on the next successful run.
 *
 * Files (all mode 0600):
 * - `spool.jsonl`: one `{"v":1,"at":ISO,"attempts":n,"payload":{…}}` line per
 *   unsent capture; `attempts` counts the posts the server answered with a
 *   retryable failure (the first one included).
 * - `spool.flushing.<pid>.<claimedAtMs>.<rand>.jsonl`: a flush claims the spool
 *   by renaming it. Only one process wins a rename, so two hooks firing at once
 *   never send the same entry twice. A claim older than ten minutes belongs to
 *   a flusher that died and is taken over by the next flush.
 * - `spool.dead.jsonl`: captures the server refused as invalid, and spooled
 *   ones that failed `SPOOL_MAX_ATTEMPTS` times, with the last message.
 * - `capture-state.json`: per-source last success / last error, rewritten
 *   atomically after every attempt.
 * - `spool.lock`: advisory lock held for the file operations on the three
 *   files above (never across a post). Without it an append that opened
 *   `spool.jsonl` before a flush renamed it would land in a claim the flusher
 *   has already read and is about to delete, and two state rewrites would
 *   drop each other's update.
 *
 * This module must stay free of model and store clients: hooks load it on
 * every commit and prompt, and the server owns the pipeline.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CaptureOutcome } from './capture.js'
import { ensurePrivateDir, openPrivateHandle } from './private-files.js'

export type CaptureMetaKey = 'transcriptPath' | 'trigger' | 'cwd' | 'capturedAt'

/** The JSON body of `POST /capture`. */
export interface CapturePayload {
  content: string
  source: string
  role?: 'user' | 'assistant' | 'system'
  session_id?: string
  project_id?: string | null
  gate?: boolean
  dedup?: boolean
  derive?: 'session-summary' | 'pre-compact'
  dry_run?: boolean
  key?: string
  meta?: Partial<Record<CaptureMetaKey, string>>
}

export type CaptureEnv = Readonly<Record<string, string | undefined>>

export type PostResult =
  | { ok: true; status: number; outcome: CaptureOutcome }
  | {
      ok: false
      /** false = resending the same capture cannot succeed; it is dead-lettered. */
      retryable: boolean
      /**
       * The request never reached the server (connection error, no token).
       * Says nothing about this capture, so a spooled entry is not charged an attempt.
       */
      unreachable?: true
      status?: number
      message: string
      outcome?: CaptureOutcome
    }

export type CaptureDisposition = 'sent' | 'spooled' | 'dead'

export interface SendResult {
  /** The result of posting this run's own capture. */
  result: PostResult
  disposition: CaptureDisposition
  /** Spooled entries delivered by this run. */
  flushed: number
  /** Entries (own or spooled) moved to the dead-letter file by this run. */
  dead: number
  /** Entries left in `spool.jsonl` when the run finished. */
  spooled: number
  /** One summary line for `hook.log`. */
  line: string
}

export interface PostOptions {
  /** Defaults to 60 s for a turn and 180 s for a derive capture. */
  timeoutMs?: number
}

export interface SendOptions extends PostOptions {
  /**
   * Upper bound on the time spent flushing the spool after a successful post.
   * Defaults to just under the claim window, so a live claim is never
   * mistaken for a dead flusher's. Pass 0 to skip the flush.
   */
  flushBudgetMs?: number
  /** Prefix of the summary line. */
  label?: string
}

/**
 * The server keeps running a capture after the client gives up, and the
 * capture key is not enforced by a unique constraint, so a client that
 * retries too early can store twice. Derive captures run a digest model call
 * before the classifier, hence the longer floor.
 */
export const TURN_TIMEOUT_MS = 60_000
export const DERIVE_TIMEOUT_MS = 180_000
export const SPOOL_FLUSH_MAX = 20
/**
 * A spooled capture the server keeps failing (an answer or a timeout, never a
 * connection error) is dead-lettered on this attempt, so it cannot hold the
 * head of the backlog forever.
 */
export const SPOOL_MAX_ATTEMPTS = 8
export const CLAIM_STALE_MS = 10 * 60_000
const CLAIM_SAFETY_MS = 30_000
/** Holders keep the lock for a few file operations; one this old was left by a dead process. */
export const LOCK_STALE_MS = 30_000
/** How long a writer waits for the lock before going ahead without it. */
export const LOCK_WAIT_MS = 2_000
const LOCK_RETRY_MIN_MS = 5
const LOCK_RETRY_MAX_MS = 50
const MESSAGE_MAX_CHARS = 300

const SPOOL_FILE = 'spool.jsonl'
const DEAD_FILE = 'spool.dead.jsonl'
const STATE_FILE = 'capture-state.json'
const LOCK_FILE = 'spool.lock'
const LOG_FILE = 'hook.log'
const CLAIM_NAME = /^spool\.flushing\..+\.jsonl$/
const OWN_CLAIM_NAME = /^spool\.flushing\.\d+\.(\d+)\.[0-9a-f]+\.jsonl$/
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422])
const OUTCOMES: ReadonlySet<string> = new Set(['stored', 'rejected', 'deduped', 'replayed', 'dry_run', 'error'])

interface SpoolEntry {
  v: 1
  at: string
  /** Absent on lines written before attempts were counted; read as 1. */
  attempts?: number
  payload: CapturePayload
}

interface SourceState {
  lastOkAt?: string
  lastStoredAt?: string
  lastErrorAt?: string
  lastError?: string
}

interface CaptureState {
  v: 1
  createdAt: string
  sources: Record<string, SourceState>
}

interface Attempt {
  source: string
  result: PostResult
}

function homeDir(env: CaptureEnv): string {
  return env['HOME'] || homedir()
}

export function engramDir(env: CaptureEnv): string {
  return join(homeDir(env), '.engram')
}

function expandHome(path: string, env: CaptureEnv): string {
  return path.startsWith('~/') ? join(homeDir(env), path.slice(2)) : path
}

function clip(message: string): string {
  return message.length > MESSAGE_MAX_CHARS ? `${message.slice(0, MESSAGE_MAX_CHARS)}…` : message
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `ENGRAM_SERVER_URL` is the server's MCP endpoint (`…/mcp`), shared with the
 * MCP client config; the capture route is its sibling path.
 */
export function captureEndpoint(serverUrl: string): string {
  const url = new URL(serverUrl)
  const base = url.pathname.replace(/\/+$/, '').replace(/\/(mcp|capture)$/, '')
  url.pathname = `${base}/capture`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** `ENGRAM_SERVER_TOKEN_FILE` (trimmed; `~/` expands) wins over `ENGRAM_SERVER_TOKEN`. */
export async function readServerToken(env: CaptureEnv): Promise<string> {
  const file = env['ENGRAM_SERVER_TOKEN_FILE']
  if (file) {
    const token = (await fs.readFile(expandHome(file, env), 'utf8')).trim()
    if (!token) throw new Error(`token file ${file} is empty`)
    return token
  }
  const token = env['ENGRAM_SERVER_TOKEN']?.trim()
  if (!token) throw new Error('neither ENGRAM_SERVER_TOKEN_FILE nor ENGRAM_SERVER_TOKEN is set')
  return token
}

/**
 * Stable across reruns of the same hook: a transcript turn is identified by
 * its entry uuid, anything else by its text. The server honours the key only
 * within the same session id.
 */
export function captureKey(source: string, sessionId: string | null, identity: string): string {
  return createHash('sha256').update(JSON.stringify([source, sessionId ?? '', identity])).digest('hex')
}

export function defaultTimeoutMs(payload: CapturePayload): number {
  return payload.derive ? DERIVE_TIMEOUT_MS : TURN_TIMEOUT_MS
}

function parseOutcome(text: string): CaptureOutcome | undefined {
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
    const outcome = (body as Record<string, unknown>)['outcome']
    return typeof outcome === 'string' && OUTCOMES.has(outcome) ? (body as CaptureOutcome) : undefined
  } catch {
    return undefined
  }
}

/**
 * Only a refusal of the capture itself is permanent. Auth, routing and
 * server failures are retryable: they are fixed on the client or the server,
 * and the capture must survive until they are.
 */
function classify(status: number, text: string): PostResult {
  const outcome = parseOutcome(text)
  const isPermanent = PERMANENT_STATUSES.has(status) || outcome?.retryable === false
  if (outcome && status >= 200 && status < 300 && outcome.outcome !== 'error') {
    return { ok: true, status, outcome }
  }
  const message = clip(outcome?.message ?? outcome?.reason ?? `HTTP ${status}: ${text.trim() || 'empty body'}`)
  return { ok: false, retryable: !isPermanent, status, message, ...(outcome ? { outcome } : {}) }
}

export async function postCapture(
  payload: CapturePayload,
  env: CaptureEnv,
  options: PostOptions = {},
): Promise<PostResult> {
  const serverUrl = env['ENGRAM_SERVER_URL']
  if (!serverUrl) throw new Error('postCapture needs ENGRAM_SERVER_URL')
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs(payload)
  let token: string
  try {
    token = await readServerToken(env)
  } catch (err) {
    return { ok: false, retryable: true, unreachable: true, message: clip(`no server token: ${errorMessage(err)}`) }
  }
  try {
    const response = await fetch(captureEndpoint(serverUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return classify(response.status, await response.text())
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
    const message = isTimeout ? `timeout after ${timeoutMs} ms` : `${errorMessage(err)}${cause}`
    // A timeout reached the server, which may still be working on this
    // capture; only a request that never got there is unreachable.
    return { ok: false, retryable: true, ...(isTimeout ? {} : { unreachable: true as const }), message: clip(message) }
  }
}

async function ensureDir(dir: string): Promise<void> {
  ensurePrivateDir(dir)
}

/** Opens, writes and closes inside the caller's lock, so no descriptor outlives it. */
async function appendLines(path: string, lines: readonly unknown[]): Promise<void> {
  if (lines.length === 0) return
  const data = lines.map((l) => `${JSON.stringify(l)}\n`).join('')
  const handle = await openPrivateHandle(path, 'a')
  try {
    await handle.appendFile(data)
  } finally {
    await handle.close()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code
}

/** `O_CREAT|O_EXCL`: false when another holder has the lock. */
async function tryCreateLock(path: string, token: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(path, 'wx', 0o600)
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
 * Removes a lock older than LOCK_STALE_MS. It is renamed aside first so that
 * of two processes that both found it stale only one removes it; if the file
 * moved aside is fresh, its holder retook the lock between the stat and the
 * rename, and it is linked back unless a newer lock already exists.
 */
async function removeStaleLock(path: string): Promise<void> {
  let mtimeMs: number
  try {
    mtimeMs = (await fs.stat(path)).mtimeMs
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return
    throw err
  }
  if (Date.now() - mtimeMs <= LOCK_STALE_MS) return
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString('hex')}`
  if (!(await tryRename(path, aside))) return
  try {
    if (Date.now() - (await fs.stat(aside)).mtimeMs <= LOCK_STALE_MS) {
      await fs.link(aside, path).catch((err: unknown) => {
        if (!isErrno(err, 'EEXIST')) throw err
      })
    }
  } finally {
    await fs.rm(aside, { force: true })
  }
}

/** The lock's token, or undefined when it stayed held for LOCK_WAIT_MS. */
async function acquireLock(dir: string): Promise<string | undefined> {
  const path = join(dir, LOCK_FILE)
  const token = `${process.pid} ${Date.now()} ${randomBytes(6).toString('hex')}`
  const deadline = Date.now() + LOCK_WAIT_MS
  let backoffMs = LOCK_RETRY_MIN_MS
  for (;;) {
    if (await tryCreateLock(path, token)) return token
    await removeStaleLock(path)
    const leftMs = deadline - Date.now()
    if (leftMs <= 0) return undefined
    await sleep(Math.min(leftMs, backoffMs / 2 + Math.random() * (backoffMs / 2)))
    backoffMs = Math.min(backoffMs * 2, LOCK_RETRY_MAX_MS)
  }
}

/** Removes the lock only while it still carries this holder's token. */
async function releaseLock(dir: string, token: string): Promise<void> {
  const path = join(dir, LOCK_FILE)
  try {
    if ((await fs.readFile(path, 'utf8')).trim() === token) await fs.rm(path, { force: true })
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err
  }
}

async function logEvent(dir: string, line: string): Promise<void> {
  try {
    const handle = await openPrivateHandle(join(dir, LOG_FILE), 'a')
    try {
      await handle.appendFile(`${line}\n`)
    } finally {
      await handle.close()
    }
  } catch (err) {
    process.stderr.write(`${line} (hook.log unwritable: ${errorMessage(err)})\n`)
  }
}

/**
 * Runs `fn` holding `spool.lock`. When the lock stays held for LOCK_WAIT_MS,
 * `fn` still runs with `locked` false and the event goes to `hook.log`: a
 * lost capture is worse than a rare interleave. `unlocked` says what that run
 * did, for the log line.
 */
async function withSpoolLock<T>(dir: string, unlocked: string, fn: (locked: boolean) => Promise<T>): Promise<T> {
  const token = await acquireLock(dir)
  if (token === undefined) {
    await logEvent(dir, `[capture-client] ${LOCK_FILE} held for over ${LOCK_WAIT_MS} ms; ${unlocked}`)
    return fn(false)
  }
  try {
    return await fn(true)
  } finally {
    await releaseLock(dir, token)
  }
}

function deadLetter(
  payload: unknown,
  result: PostResult & { ok: false },
  at: string,
  attempts?: number,
): Record<string, unknown> {
  const status = result.status ? { status: result.status } : {}
  return { v: 1, at, ...status, message: result.message, ...(attempts ? { attempts } : {}), payload }
}

function attemptsOf(entry: SpoolEntry): number {
  const { attempts } = entry
  return typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 1 ? attempts : 1
}

function newClaimName(nowMs: number): string {
  return `spool.flushing.${process.pid}.${nowMs}.${randomBytes(4).toString('hex')}.jsonl`
}

/**
 * The claim time is part of a claim's name because `rename` keeps the old
 * mtime: a spool last appended an hour ago would otherwise look abandoned the
 * moment it was claimed. Claims named by other writers fall back to mtime.
 */
async function claimAgeMs(dir: string, name: string, nowMs: number): Promise<number | undefined> {
  const match = OWN_CLAIM_NAME.exec(name)
  if (match) return nowMs - Number(match[1])
  try {
    return nowMs - (await fs.stat(join(dir, name))).mtimeMs
  } catch {
    return undefined
  }
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

/** Takes the spool and every abandoned claim; returns the claim files now owned. */
async function claimSpool(dir: string, nowMs: number): Promise<string[]> {
  const owned: string[] = []
  for (const name of await fs.readdir(dir)) {
    if (!CLAIM_NAME.test(name)) continue
    const age = await claimAgeMs(dir, name, nowMs)
    if (age === undefined || age <= CLAIM_STALE_MS) continue
    const target = join(dir, newClaimName(nowMs))
    if (await tryRename(join(dir, name), target)) owned.push(target)
  }
  const target = join(dir, newClaimName(nowMs))
  if (await tryRename(join(dir, SPOOL_FILE), target)) owned.push(target)
  return owned
}

type ClaimedLine = { entry: SpoolEntry } | { raw: string }

function parseSpoolLine(raw: string): ClaimedLine {
  try {
    const entry: unknown = JSON.parse(raw)
    if (typeof entry === 'object' && entry !== null) {
      const { at, payload } = entry as Record<string, unknown>
      if (typeof at === 'string' && typeof payload === 'object' && payload !== null) {
        return { entry: entry as SpoolEntry }
      }
    }
  } catch {
    // An unreadable line is dead-lettered as raw text below.
  }
  return { raw }
}

async function readClaims(paths: readonly string[]): Promise<ClaimedLine[]> {
  const lines: ClaimedLine[] = []
  for (const path of paths) {
    const text = await fs.readFile(path, 'utf8')
    for (const raw of text.split('\n')) if (raw.trim()) lines.push(parseSpoolLine(raw))
  }
  return lines
}

interface FlushResult {
  attempts: Attempt[]
  flushed: number
  dead: number
}

async function flushSpool(dir: string, env: CaptureEnv, budgetMs: number, nowIso: () => string): Promise<FlushResult> {
  if (budgetMs <= 0) return { attempts: [], flushed: 0, dead: 0 }
  const startMs = Date.now()
  // A claim taken without the lock could rename a spool an append still has
  // open, so a busy lock skips this flush; the backlog waits for the next run.
  const claims = await withSpoolLock(dir, 'skipped the flush', (locked) =>
    locked ? claimSpool(dir, startMs) : Promise.resolve([]),
  )
  if (claims.length === 0) return { attempts: [], flushed: 0, dead: 0 }

  const lines = await readClaims(claims)
  const unreadable = lines.filter((l): l is { raw: string } => 'raw' in l)
  // Stable sort: entries from one file keep their order when stamps tie.
  const entries = lines
    .filter((l): l is { entry: SpoolEntry } => 'entry' in l)
    .map((l) => l.entry)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  const attempts: Attempt[] = []
  const deadLines: unknown[] = unreadable.map((l) => ({ v: 1, at: nowIso(), message: 'unreadable spool line', raw: l.raw }))
  let sent = 0
  let index = 0
  let requeued: SpoolEntry | undefined
  for (; index < entries.length && sent < SPOOL_FLUSH_MAX; index++) {
    const entry = entries[index]
    if (Date.now() - startMs + defaultTimeoutMs(entry.payload) > budgetMs) break
    const result = await postCapture(entry.payload, env)
    attempts.push({ source: entry.payload.source, result })
    if (result.ok) {
      sent++
    } else if (!result.retryable) {
      deadLines.push(deadLetter(entry.payload, result, nowIso()))
    } else if (result.unreachable) {
      break
    } else {
      const count = attemptsOf(entry) + 1
      if (count >= SPOOL_MAX_ATTEMPTS) {
        deadLines.push(deadLetter(entry.payload, result, nowIso(), count))
        continue
      }
      requeued = { ...entry, attempts: count }
      break
    }
  }
  const unsent = requeued ? [requeued, ...entries.slice(index + 1)] : entries.slice(index)

  // Remaining entries go back before the claims are removed: a crash in
  // between resends a capture (the key makes that a replay) instead of losing it.
  await withSpoolLock(dir, `returned unsent entries to ${SPOOL_FILE} without it`, async () => {
    await appendLines(join(dir, SPOOL_FILE), unsent)
    await appendLines(join(dir, DEAD_FILE), deadLines)
  })
  await Promise.all(claims.map((path) => fs.rm(path, { force: true })))
  return { attempts, flushed: sent, dead: deadLines.length }
}

async function readState(dir: string, nowIso: string): Promise<CaptureState> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(dir, STATE_FILE), 'utf8')) as Partial<CaptureState>
    if (parsed.v === 1 && typeof parsed.createdAt === 'string' && typeof parsed.sources === 'object') {
      return { v: 1, createdAt: parsed.createdAt, sources: { ...parsed.sources } }
    }
  } catch {
    // Missing or unreadable: start a fresh state file.
  }
  return { v: 1, createdAt: nowIso, sources: {} }
}

function applyAttempt(state: SourceState, attempt: Attempt, at: string): SourceState {
  const { result } = attempt
  if (!result.ok) return { ...state, lastErrorAt: at, lastError: result.message }
  return { ...state, lastOkAt: at, ...(result.outcome.outcome === 'stored' ? { lastStoredAt: at } : {}) }
}

async function writeState(dir: string, attempts: readonly Attempt[], at: string): Promise<void> {
  await withSpoolLock(dir, `rewrote ${STATE_FILE} without it`, () => rewriteState(dir, attempts, at))
}

async function rewriteState(dir: string, attempts: readonly Attempt[], at: string): Promise<void> {
  const current = await readState(dir, at)
  const sources = attempts.reduce<Record<string, SourceState>>(
    (acc, attempt) => ({ ...acc, [attempt.source]: applyAttempt(acc[attempt.source] ?? {}, attempt, at) }),
    current.sources,
  )
  const path = join(dir, STATE_FILE)
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(temp, `${JSON.stringify({ ...current, sources }, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, path)
}

async function countSpooled(dir: string): Promise<number> {
  try {
    const text = await fs.readFile(join(dir, SPOOL_FILE), 'utf8')
    return text.split('\n').filter((l) => l.trim()).length
  } catch {
    return 0
  }
}

function dispositionOf(result: PostResult): CaptureDisposition {
  if (result.ok) return 'sent'
  return result.retryable ? 'spooled' : 'dead'
}

function summaryLine(label: string, payload: CapturePayload, r: Omit<SendResult, 'line'>, ms: number): string {
  const outcome = r.result.ok ? r.result.outcome.outcome : r.disposition
  const parts = [`[${label}] mode=server source=${payload.source} outcome=${outcome} ms=${ms} spool=${r.spooled}`]
  if (r.flushed > 0) parts.push(`flushed=${r.flushed}`)
  if (r.dead > 0) parts.push(`dead=${r.dead}`)
  if (!r.result.ok) parts.push(`error=${JSON.stringify(r.result.message)}`)
  return parts.join(' ')
}

/**
 * Posts this run's capture first, so a backlog never delays the newest one.
 * On success the spool is flushed oldest first; on a retryable failure the
 * capture is spooled and the backlog left alone, because the server is
 * unreachable for it too.
 */
export async function sendCapture(
  payload: CapturePayload,
  env: CaptureEnv,
  options: SendOptions = {},
): Promise<SendResult> {
  const startMs = Date.now()
  const nowIso = () => new Date().toISOString()
  const dir = engramDir(env)
  await ensureDir(dir)

  const result = await postCapture(payload, env, options)
  const attempts: Attempt[] = [{ source: payload.source, result }]
  let flushed = 0
  let dead = 0
  if (result.ok) {
    const budgetMs = options.flushBudgetMs ?? CLAIM_STALE_MS - CLAIM_SAFETY_MS
    const flush = await flushSpool(dir, env, budgetMs, nowIso)
    attempts.push(...flush.attempts)
    flushed = flush.flushed
    dead = flush.dead
  } else if (result.retryable) {
    const entry: SpoolEntry = { v: 1, at: nowIso(), attempts: 1, payload }
    await withSpoolLock(dir, `appended to ${SPOOL_FILE} without it`, () =>
      appendLines(join(dir, SPOOL_FILE), [entry]),
    )
  } else {
    const line = deadLetter(payload, result, nowIso())
    await withSpoolLock(dir, `appended to ${DEAD_FILE} without it`, () => appendLines(join(dir, DEAD_FILE), [line]))
    dead = 1
  }

  await writeState(dir, attempts, nowIso())
  const summary = { result, disposition: dispositionOf(result), flushed, dead, spooled: await countSpooled(dir) }
  return { ...summary, line: summaryLine(options.label ?? 'engram-ingest', payload, summary, Date.now() - startMs) }
}
