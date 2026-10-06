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
 * scrubber of their own. The transport talks only to the server. This
 * module writes, lists and sends batch files; `spool-drain.ts` runs the
 * drain over them and keeps its state.
 *
 * Names that start with `.` belong to the spool itself: `.dead/` (refused
 * events), `.state.json` (the drainer's health), `.drain.lock` and temp files.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { scrubSecrets } from '@engram-mem/core'
import { CAPTURE_EVENTS_MAX } from '../capture-events/contract.js'
import { scrubEvent } from '../capture-events/scrub.js'
import { appendPrivateFile, ensurePrivateDir, openPrivateHandle } from '../ingest/private-files.js'
import { sessionFileName, type CaptureClient, type CaptureEvent } from './events.js'
import { BATCH_BYTES_MAX, readyForRoute } from './route-fit.js'

export type Env = Record<string, string | undefined>

export const DRAIN_REQUEST_TIMEOUT_MS = 30_000
/** A temp file this old was left by a writer that crashed before its rename. */
export const SPOOL_TMP_STALE_MS = 10 * 60_000
const STATE_MESSAGE_MAX_CHARS = 300

const DEAD_DIR = '.dead'
const BATCH_SUFFIX = '.jsonl'
const TMP_SUFFIX = '.tmp'

/** `~/.engram/spool`, under the env's HOME. */
export function spoolRoot(env: Env): string {
  return join(env.HOME || homedir(), '.engram', 'spool')
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code
}

/** A message as `.state.json` and the dead letters keep it: at most 300 characters. */
export function clip(message: string): string {
  return message.length > STATE_MESSAGE_MAX_CHARS ? message.slice(0, STATE_MESSAGE_MAX_CHARS) : message
}

export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0


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

export interface Batch {
  /** The session directory's name. */
  dir: string
  path: string
}

/** A batch file's key in `.state.json`: `<session dir>/<file name>`. */
export function batchKey(batch: Batch): string {
  return `${batch.dir}/${basename(batch.path)}`
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
export async function listBatches(root: string): Promise<Batch[]> {
  const batches: Batch[] = []
  for (const dir of await sessionDirs(root)) {
    const names = (await listNames(join(root, dir)))
      .filter((n) => !n.startsWith('.') && n.endsWith(BATCH_SUFFIX))
      .sort()
    for (const name of names) batches.push({ dir, path: join(root, dir, name) })
  }
  return batches
}

export async function removeStaleTmp(root: string): Promise<void> {
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

// ── Dead letters ─────────────────────────────────────────────────────────

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

export interface SendContext {
  root: string
  endpoint: string
  token: string
  client: CaptureClient
  /** Receives the route parser's line for a defect; it names no value. */
  log: (line: string) => void
}

/**
 * `dead`: the route refused the batch and its events were dead-lettered.
 * `dropped`: settled without a request, because the file was gone or none of
 * its events could be sent; nothing was learnt about the server.
 */
export type Outcome =
  | { kind: 'acked'; accepted: number; duplicates: number; rejected: number; dead: number }
  | { kind: 'split'; batches: Batch[]; dead: number }
  | { kind: 'dead'; dead: number }
  | { kind: 'dropped'; dead: number }
  | { kind: 'mismatch' }
  | { kind: 'retry'; error: string }

interface Prepared {
  lines: string[]
  events: CaptureEvent[]
  /** Lines that can never be sent: unparsable JSON, or a value scrubbing cannot walk. */
  unsendable: DeadLetter[]
}

/**
 * A spool line that can never be sent, as its dead letter. The line was
 * written by a producer that may not have scrubbed it, so the dead letter
 * holds the line with every registered value masked; a line that cannot be
 * masked is recorded by its length and sha256 alone.
 */
async function unsendableLine(line: string, reason: string, at: string): Promise<DeadLetter> {
  try {
    return { at, reason, event: (await scrubSecrets(line)).text }
  } catch {
    return { at, reason, length: line.length, sha256: createHash('sha256').update(line, 'utf8').digest('hex') }
  }
}

/**
 * Parses, scrubs and fits a batch. Scrubbing is pure and the secret registry
 * never throws, so an event that makes `scrubEvent` throw is malformed and
 * would be refused by the route; it is dead-lettered rather than sent
 * unscrubbed. The producer fitted each event to the route's caps after its
 * own scrub, but this scrub may mask more (a registry that gained a value),
 * and a placeholder longer than its value can push a capped text over its
 * cap; the event is fitted again so the route never refuses it for that.
 */
async function prepareBatch(raw: string, at: string, log: (line: string) => void): Promise<Prepared> {
  const now = new Date()
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
    let scrubbed: CaptureEvent
    try {
      scrubbed = (await scrubEvent(parsed as CaptureEvent)).event
    } catch {
      prepared.unsendable.push(await unsendableLine(line, 'unscrubbable_event', at))
      continue
    }
    const check = readyForRoute(scrubbed, { now, log })
    if (check.ok) {
      prepared.events.push(check.event)
      prepared.lines.push(line)
    } else {
      prepared.unsendable.push({ at, reason: clip(check.reason), event: scrubbed })
    }
  }
  return prepared
}

interface Ack {
  accepted: number
  duplicates: number
  rejected: Array<{ index: unknown; reason: unknown }>
}

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

/**
 * The capture route answers a request it will never accept with a JSON body
 * `{error: string}`. A status alone proves nothing: a proxy or load balancer
 * in front of it answers 4xx pages of its own (408, 499, an HTML 400) for
 * requests the route never saw, and a batch dead-lettered on one of those
 * would be lost for a transient fault.
 */
function isRouteError(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const error = (body as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0
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

export async function sendBatch(ctx: SendContext, batch: Batch): Promise<Outcome> {
  let raw: string
  try {
    raw = await fs.readFile(batch.path, 'utf8')
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { kind: 'dropped', dead: 0 }
    throw err
  }
  const at = new Date().toISOString()
  const { lines, events, unsendable } = await prepareBatch(raw, at, ctx.log)
  if (events.length === 0) {
    await settle(ctx, batch, unsendable)
    return { kind: 'dropped', dead: unsendable.length }
  }

  const reply = await post(ctx, events)
  if ('error' in reply) return { kind: 'retry', error: reply.error }
  const { status, body } = reply

  if (status === 200) return settleAck(ctx, batch, { events, unsendable }, parseAck(body), at)

  // A 413 from anything in the path means smaller requests may pass, so a
  // file of several events is split whoever answered it.
  if (status === 413 && events.length > 1) {
    const half = Math.ceil(lines.length / 2)
    const halves: Batch[] = []
    for (const part of [lines.slice(0, half), lines.slice(half)]) {
      halves.push({ dir: batch.dir, path: await writeBatchFile(join(ctx.root, batch.dir), part) })
    }
    await settle(ctx, batch, unsendable)
    return { kind: 'split', batches: halves, dead: unsendable.length }
  }

  // The route's own refusal: a 400, or a 413 for one event that cannot be
  // split further. Every other answer leaves the file for a retry.
  if ((status === 400 || status === 413) && isRouteError(body)) {
    const reason = errorOf(body, status)
    await settle(ctx, batch, [...unsendable, ...events.map((event) => ({ at, status, reason, event }))])
    return { kind: 'dead', dead: unsendable.length + events.length }
  }

  return { kind: 'retry', error: errorOf(body, status) }
}
