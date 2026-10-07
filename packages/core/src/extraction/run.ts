/**
 * Extraction runs: one model call per window, recorded as one run row per
 * anchor and extractor version.
 *
 * A tick takes the due anchors the store hands out (each session's earliest
 * pending anchor, oldest first, backoff already applied in SQL), opens a run
 * on each, calls the model, gates the reply and commits the accepted items
 * with the run's close in one transaction. A run that does not commit is
 * closed as failed with its class:
 * - `transient` (an empty or moderated reply, a provider or network fault);
 * - `held` (a reply cut off at its cap, an unreadable reply, a window that
 *   cannot be built, a commit the store refused).
 * Every failure backs its anchor off (60 s doubled per earlier failure,
 * counted or not, capped at 6 h), so a window that keeps failing never stays
 * at the head of the oldest-first queue.
 *
 * A failure counts toward the anchor's limit (EXTRACTION_HELD_FAILURES_MAX
 * held, EXTRACTION_TRANSIENT_FAILURES_MAX transient) only on direct proof that
 * the service at fault is up, never by what other windows did:
 * - the model call was answered (an empty, moderated, cut-off or unreadable
 *   reply, or an HTTP status the provider refused the request with), so the
 *   failure is the window's own;
 * - the model call went unanswered (5xx, 408, 429, 404, 409, 401-403, a
 *   network fault, an open circuit, an error with no status), and one minimal
 *   probe sent at once to the same adapter and model was answered: it
 *   resolved, or the provider refused it with an HTTP status;
 * - the store refused this window's data (a SQLSTATE in class 22 or 23) when
 *   reading the window or committing it.
 * When the probe goes unanswered too, the provider is down: the failure backs
 * the anchor off uncounted and the tick ends, so an outage tick makes two
 * calls and an outage of any length exhausts no anchor. Any other store
 * failure (no SQLSTATE, a PostgREST code, a timeout) is the store being down
 * or slow: it is not counted either, and the tick ends. An exhausted anchor no
 * longer holds its session's later anchors back.
 *
 * Log lines carry id prefixes, statuses, counts and durations, never text.
 */
import {
  classifyExtractionError,
  isProviderRefusal,
  type CompleteJsonRequest,
  type CompleteJsonResult,
  type ExtractionErrorClass,
  type IntelligenceAdapter,
} from '../adapters/intelligence.js'
import {
  EXTRACTION_WINDOW_SUBJECTS_MAX,
  isDataRefusal,
  type CaptureStore,
  type ExtractionCommit,
  type ExtractionCommitResult,
  type PendingAnchor,
} from '../items/capture-store.js'
import { gateWindow, type GateResult } from './gate.js'
import { buildCommitPayload } from './persist.js'
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTOR_VERSION } from './prompt.js'
import { parseReply } from './reply.js'
import {
  buildWindow,
  extractionMaxTokens,
  RECENT_LISTING_LIMIT,
  renderUserMessage,
  type ExtractionWindow,
  type RawExtractionWindow,
} from './window.js'

/** A session with no capture event for this long has ended. */
export const SESSION_IDLE_MS = 30 * 60_000
/** Windows one tick runs at most. */
export const EXTRACTION_WINDOWS_PER_TICK = 20
/** A run still `running` after this long was abandoned by its process. */
export const EXTRACTION_STALE_RUN_MS = 10 * 60_000
/** Held failures after which an anchor is no longer pending (the pending RPC holds the same number). */
export const EXTRACTION_HELD_FAILURES_MAX = 3
/** Transient failures after which an anchor is no longer pending (the pending RPC holds the same number). */
export const EXTRACTION_TRANSIENT_FAILURES_MAX = 6
/** Names the probe call in logs; a probe never carries window text. */
export const EXTRACTION_PROBE_LABEL = 'extraction-probe'
/**
 * The smallest JSON-mode call: any reply, whatever its content or finish
 * reason, shows the provider answers.
 */
const PROBE_REQUEST: CompleteJsonRequest = {
  label: EXTRACTION_PROBE_LABEL,
  system: 'Reply with the JSON object {"ok":true}.',
  user: 'ping',
  maxTokens: 16,
}
/** Longest error message a run row or a log line keeps. */
const ERROR_MESSAGE_MAX_CHARS = 500
const ID_PREFIX_CHARS = 8

/** What one model call cost and returned; counts only. */
export interface ExtractionCall {
  promptChars: number
  replyChars: number
  finishReason: string | null
  replyModel: string | null
  modelMs: number
}

export interface ExtractWindowResult extends GateResult {
  call: ExtractionCall
}

export type ExtractionReplyFault = 'empty' | 'length' | 'parse'

/**
 * The model answered, but the answer cannot be used. An empty reply is
 * transient (the same window can succeed on the next call); a reply cut off
 * at its cap or not readable as the reply schema is held against the anchor.
 * The message never carries reply text.
 */
export class ExtractionReplyError extends Error {
  readonly fault: ExtractionReplyFault
  readonly failure: ExtractionErrorClass
  readonly call: ExtractionCall

  constructor(fault: ExtractionReplyFault, message: string, call: ExtractionCall) {
    super(message)
    this.name = 'ExtractionReplyError'
    this.fault = fault
    this.failure = fault === 'empty' ? 'transient' : 'held'
    this.call = call
  }
}

export function isExtractionReplyError(err: unknown): err is ExtractionReplyError {
  return err instanceof ExtractionReplyError || (err instanceof Error && err.name === 'ExtractionReplyError')
}

/** The failure class of anything a window's model call or reply check threw. */
export function extractionFailureClass(err: unknown): ExtractionErrorClass {
  if (isExtractionReplyError(err)) return err.failure
  return classifyExtractionError(err)
}

export interface ExtractWindowDeps {
  intelligence: IntelligenceAdapter
}

/**
 * Renders the window, asks the model once in JSON mode, and gates the reply.
 * Throws ExtractionReplyError for an empty, cut-off or unreadable reply; a
 * failed call rejects with the adapter's own error.
 */
export async function extractWindow(window: ExtractionWindow, deps: ExtractWindowDeps): Promise<ExtractWindowResult> {
  const completeJson = deps.intelligence.completeJson
  if (!completeJson) throw new Error('extraction needs an intelligence adapter with completeJson')
  const user = renderUserMessage(window)
  const started = Date.now()
  const reply: CompleteJsonResult = await completeJson.call(deps.intelligence, {
    label: 'extraction',
    system: EXTRACTION_SYSTEM_PROMPT,
    user,
    maxTokens: extractionMaxTokens(user),
  })
  const call: ExtractionCall = {
    promptChars: user.length,
    replyChars: reply.text.length,
    finishReason: reply.finishReason,
    replyModel: reply.model || null,
    modelMs: Date.now() - started,
  }
  if (reply.text.trim() === '') {
    throw new ExtractionReplyError('empty', 'the model returned an empty reply', call)
  }
  if (reply.finishReason === 'length') {
    throw new ExtractionReplyError('length', `the reply was cut off at its token cap (${call.replyChars} chars)`, call)
  }
  const parsed = parseReply(reply.text)
  if (!parsed.ok) {
    throw new ExtractionReplyError('parse', `the reply is not the extraction reply object: ${parsed.reason}`, call)
  }
  return { ...gateWindow(window, parsed), call }
}

export type ExtractionStore = Pick<
  CaptureStore,
  'extractionPending' | 'extractionWindow' | 'extractionBegin' | 'extractionFail' | 'extractionCommit'
>

export interface ExtractionTickDeps {
  store: ExtractionStore
  intelligence: IntelligenceAdapter | undefined
  /** The configured chat model, recorded on each run. */
  model: string | null
  /** The clock due-ness, idleness and staleness are judged by. */
  now?: () => Date
  log: (line: string) => void
}

export interface ExtractionTickResult {
  /** Runs opened (each counts against the tick's budget). */
  windows: number
  succeeded: number
  held: number
  transient: number
  /** The budget ran out, so more windows are likely due. */
  full: boolean
}

/**
 * `outage`: the provider (an unanswered call and probe) or the store (a read
 * or commit it did not refuse for the window's data) is down; the failure is
 * not counted and the tick ends.
 */
type WindowStatus = 'succeeded' | 'held' | 'transient' | 'outage' | 'gone' | 'skipped'

type TickDeps = ExtractionTickDeps & { intelligence: IntelligenceAdapter }
type WindowLine = (status: string, detail: string) => void

const EMPTY_TICK: ExtractionTickResult = { windows: 0, succeeded: 0, held: 0, transient: 0, full: false }

let reportedNoCompleteJson = false

/**
 * Runs up to EXTRACTION_WINDOWS_PER_TICK windows. Never throws: a store
 * failure outside a run ends the tick with a log line.
 */
export async function runExtractionTick(deps: ExtractionTickDeps): Promise<ExtractionTickResult> {
  const { intelligence, log } = deps
  if (!intelligence?.completeJson) {
    if (!reportedNoCompleteJson) {
      reportedNoCompleteJson = true
      log('extraction: the chat adapter has no completeJson, so no window is extracted')
    }
    return { ...EMPTY_TICK }
  }
  const counts = { ...EMPTY_TICK }
  try {
    await runWindows({ ...deps, intelligence }, counts)
  } catch (err) {
    log(`extraction: tick stopped: ${describeError(err)}`)
  }
  return { ...counts, full: counts.windows >= EXTRACTION_WINDOWS_PER_TICK }
}

async function runWindows(deps: TickDeps, counts: ExtractionTickResult): Promise<void> {
  const now = deps.now ?? (() => new Date())
  // An anchor handed out twice in one tick (held by another process, gone)
  // is not retried here; a fetch that brings nothing new ends the tick.
  const seen = new Set<string>()
  while (counts.windows < EXTRACTION_WINDOWS_PER_TICK) {
    const pending = await deps.store.extractionPending({
      version: EXTRACTOR_VERSION,
      limit: EXTRACTION_WINDOWS_PER_TICK - counts.windows,
      idleMs: SESSION_IDLE_MS,
      now: now(),
    })
    const fresh = pending.filter((anchor) => !seen.has(anchor.anchorId))
    if (fresh.length === 0) return
    for (const anchor of fresh) {
      seen.add(anchor.anchorId)
      const status = await runWindow(deps, anchor, now)
      if (status === 'skipped') continue
      counts.windows += 1
      if (status === 'succeeded') counts.succeeded += 1
      else if (status === 'held') counts.held += 1
      else if (status === 'transient' || status === 'outage') counts.transient += 1
      if (status === 'outage') return
      if (counts.windows >= EXTRACTION_WINDOWS_PER_TICK) return
    }
  }
}

async function runWindow(deps: TickDeps, anchor: PendingAnchor, now: () => Date): Promise<WindowStatus> {
  const { store, log } = deps
  const started = Date.now()
  const line: WindowLine = (status, detail) =>
    log(
      `extraction: session=${prefix(anchor.sessionId)} anchor=${prefix(anchor.anchorId)} status=${status}` +
        `${detail} ms=${Date.now() - started}`,
    )

  if (anchor.runningRunId !== null) {
    if (isStale(anchor, now())) await closeStale(deps, anchor, anchor.runningRunId, line)
    return 'skipped'
  }

  const runId = await store.extractionBegin({
    anchorId: anchor.anchorId,
    sessionId: anchor.sessionId,
    version: EXTRACTOR_VERSION,
    model: deps.model,
  })
  if (runId === null) return 'skipped'

  let raw: RawExtractionWindow | null
  try {
    raw = await store.extractionWindow(anchor.anchorId, EXTRACTION_WINDOW_SUBJECTS_MAX, RECENT_LISTING_LIMIT)
  } catch (err) {
    return failStore(deps, anchor, runId, err, {}, line)
  }
  if (raw === null) {
    // Forgotten or deleted since it was handed out: nothing to extract, and
    // the pending read no longer returns it.
    await store.extractionFail(runId, {
      error: 'the anchor is gone',
      failure: 'transient',
      counted: false,
      stats: { anchor_kind: anchor.anchorKind },
    })
    line('gone', '')
    return 'gone'
  }

  let window: ExtractionWindow
  try {
    window = buildWindow(raw)
  } catch (err) {
    // What the store returned for this anchor cannot be read as a window, and
    // reading it again returns the same: the window's own failure.
    return failHeld(deps, anchor, runId, err, {}, line)
  }

  let result: ExtractWindowResult
  try {
    result = await extractWindow(window, { intelligence: deps.intelligence })
  } catch (err) {
    return failCall(deps, anchor, runId, err, line)
  }
  return commitWindow(deps, anchor, runId, window, result, line)
}

/**
 * A run still open after EXTRACTION_STALE_RUN_MS lost its worker mid-run. It
 * is closed as a counted transient failure, so the anchor waits out the
 * backoff it sets, and a window that kills its worker every time is left
 * after EXTRACTION_TRANSIENT_FAILURES_MAX tries instead of blocking its
 * session for ever.
 */
async function closeStale(deps: TickDeps, anchor: PendingAnchor, runId: string, line: WindowLine): Promise<void> {
  const closed = await deps.store.extractionFail(runId, {
    error: `the run was still running after ${EXTRACTION_STALE_RUN_MS} ms`,
    failure: 'transient',
    counted: true,
    stats: { anchor_kind: anchor.anchorKind },
  })
  line('stale_closed', '')
  if (closed) logIfExhausted(deps.log, anchor, 'transient')
}

/**
 * A store call for this window (the read or the commit) failed. It counts as
 * held only when the store refused the window's data; anything else (no
 * SQLSTATE, a PostgREST code, a timeout, a closed run) says nothing about the
 * window, so it is not counted and the tick ends.
 */
async function failStore(
  deps: TickDeps,
  anchor: PendingAnchor,
  runId: string,
  err: unknown,
  stats: Record<string, unknown>,
  line: WindowLine,
): Promise<WindowStatus> {
  if (isDataRefusal(err)) return failHeld(deps, anchor, runId, err, stats, line)
  await deps.store.extractionFail(runId, {
    error: describeError(err),
    failure: 'transient',
    counted: false,
    stats: { anchor_kind: anchor.anchorKind, ...stats },
  })
  line('transient', ` error=${errorLabel(err)} counted=false`)
  deps.log('extraction: a store call for a window failed without refusing its data, so the tick ends')
  return 'outage'
}

/** Closes the run as a counted held failure: the window's own, no probe. */
async function failHeld(
  deps: TickDeps,
  anchor: PendingAnchor,
  runId: string,
  err: unknown,
  stats: Record<string, unknown>,
  line: WindowLine,
): Promise<WindowStatus> {
  const closed = await deps.store.extractionFail(runId, {
    error: describeError(err),
    failure: 'held',
    counted: true,
    stats: { anchor_kind: anchor.anchorKind, ...stats },
  })
  line('held', ` error=${errorLabel(err)} counted=true`)
  if (closed) logIfExhausted(deps.log, anchor, 'held')
  return 'held'
}

/**
 * The model call failed. A failure the provider answered (a reply that cannot
 * be used, a request refused with an HTTP status) counts. Any other one,
 * including an error with no status, counts only when a probe sent at once is
 * answered; otherwise the provider is down, nothing is counted and the tick
 * ends.
 */
async function failCall(
  deps: TickDeps,
  anchor: PendingAnchor,
  runId: string,
  err: unknown,
  line: WindowLine,
): Promise<WindowStatus> {
  const failure = extractionFailureClass(err)
  const answered = isExtractionReplyError(err) || isProviderRefusal(err)
  const counted = answered || (await providerAnswers(deps.intelligence))
  const call = isExtractionReplyError(err) ? err.call : null
  const closed = await deps.store.extractionFail(runId, {
    error: describeError(err),
    failure,
    counted,
    stats: { anchor_kind: anchor.anchorKind, ...callStats(call) },
  })
  line(failure, ` error=${errorLabel(err)} counted=${counted}`)
  if (!counted) {
    deps.log('extraction: a window call and the probe after it went unanswered, so the tick ends; the provider is down')
    return 'outage'
  }
  if (closed) logIfExhausted(deps.log, anchor, failure)
  return failure
}

/**
 * Sends the probe; true when the provider answered it: the call resolved,
 * whatever its content, or the provider refused it with an HTTP status.
 */
async function providerAnswers(intelligence: IntelligenceAdapter): Promise<boolean> {
  const completeJson = intelligence.completeJson
  if (!completeJson) return false
  try {
    await completeJson.call(intelligence, PROBE_REQUEST)
    return true
  } catch (err) {
    return isProviderRefusal(err)
  }
}

async function commitWindow(
  deps: TickDeps,
  anchor: PendingAnchor,
  runId: string,
  window: ExtractionWindow,
  result: ExtractWindowResult,
  line: WindowLine,
): Promise<WindowStatus> {
  let commit: ExtractionCommit
  try {
    const payload = buildCommitPayload(window, result, runId)
    commit = {
      ...payload,
      stats: { anchor_kind: anchor.anchorKind, ...callStats(result.call), ...payload.stats },
    }
  } catch (err) {
    // The reply cannot be turned into a payload; the same reply fails the same way.
    return failHeld(deps, anchor, runId, err, callStats(result.call), line)
  }
  let stored: ExtractionCommitResult
  try {
    stored = await deps.store.extractionCommit(runId, commit)
  } catch (err) {
    return failStore(deps, anchor, runId, err, commit.stats, line)
  }
  line(
    'succeeded',
    ` statements=${result.statements.length} observations=${result.observations.length}` +
      ` rejected=${result.rejected.length} duplicates=${stored.duplicates} subjects_created=${stored.subjectsCreated}`,
  )
  return 'succeeded'
}

/**
 * Names the anchor when the counted failure just recorded is its last: the
 * pending read no longer hands it out, and its session's later anchors run.
 * Only called for a counted failure that closed the run; an uncounted one, or
 * one whose run was already closed elsewhere, never exhausts.
 */
function logIfExhausted(log: (line: string) => void, anchor: PendingAnchor, failure: ExtractionErrorClass): void {
  const held = anchor.heldFailures + (failure === 'held' ? 1 : 0)
  const transient = anchor.transientFailures + (failure === 'transient' ? 1 : 0)
  if (held < EXTRACTION_HELD_FAILURES_MAX && transient < EXTRACTION_TRANSIENT_FAILURES_MAX) return
  log(
    `extraction: session=${prefix(anchor.sessionId)} anchor=${prefix(anchor.anchorId)} exhausted` +
      ` held=${held} transient=${transient}; it is not tried again at this extractor version`,
  )
}

function isStale(anchor: PendingAnchor, now: Date): boolean {
  const startedAt = anchor.runningStartedAt
  return startedAt !== null && now.getTime() - startedAt.getTime() >= EXTRACTION_STALE_RUN_MS
}

function callStats(call: ExtractionCall | null): Record<string, unknown> {
  if (call === null) return {}
  return {
    prompt_chars: call.promptChars,
    reply_chars: call.replyChars,
    finish_reason: call.finishReason,
    reply_model: call.replyModel,
    model_ms: call.modelMs,
  }
}

function prefix(id: string): string {
  return id.slice(0, ID_PREFIX_CHARS)
}

/** The error's code or name, never its message: a log line carries no text. */
function errorLabel(err: unknown): string {
  if (isExtractionReplyError(err)) return err.fault
  if (!(err instanceof Error)) return 'unknown'
  const code = (err as { code?: unknown }).code
  const status = (err as { status?: unknown }).status
  if (typeof code === 'string' || typeof code === 'number') return String(code)
  if (typeof status === 'number') return `HTTP_${status}`
  return err.name
}

/** `<code or name>: <message>`, the message capped; never a stack or a row. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error'
  return `${errorLabel(err)}: ${err.message.slice(0, ERROR_MESSAGE_MAX_CHARS)}`
}
