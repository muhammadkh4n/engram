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
 * - `held` (a reply cut off at its cap, an unreadable reply, a refused
 *   commit).
 * Every failure backs its anchor off (60 s doubled per earlier failure of
 * either class, capped at 6 h), so a window that keeps failing never stays at
 * the head of the oldest-first queue. An anchor is left after
 * EXTRACTION_HELD_FAILURES_MAX held or EXTRACTION_TRANSIENT_FAILURES_MAX
 * transient failures, and its session's later anchors run.
 *
 * One failing window never ends a tick: a single transient failure goes on to
 * the next anchor. Two transient failures in a row end it, since the provider
 * itself is then most likely down and every further call would fail too.
 *
 * Log lines carry id prefixes, statuses, counts and durations, never text.
 */
import {
  classifyExtractionError,
  type CompleteJsonResult,
  type ExtractionErrorClass,
  type IntelligenceAdapter,
} from '../adapters/intelligence.js'
import {
  EXTRACTION_WINDOW_SUBJECTS_MAX,
  type CaptureStore,
  type ExtractionCommit,
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
/** Transient failures in a row that end a tick. */
const TRANSIENT_FAILURES_IN_A_ROW_MAX = 2
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

/** The failure class of anything a window's read, call or gate threw. */
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

type WindowStatus = 'succeeded' | 'held' | 'transient' | 'gone' | 'skipped'

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

async function runWindows(
  deps: ExtractionTickDeps & { intelligence: IntelligenceAdapter },
  counts: ExtractionTickResult,
): Promise<void> {
  const now = deps.now ?? (() => new Date())
  // An anchor handed out twice in one tick (held by another process, gone)
  // is not retried here; a fetch that brings nothing new ends the tick.
  const seen = new Set<string>()
  let transientInARow = 0
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
      else if (status === 'transient') counts.transient += 1
      if (status === 'transient') transientInARow += 1
      else if (status !== 'gone') transientInARow = 0
      if (transientInARow >= TRANSIENT_FAILURES_IN_A_ROW_MAX) {
        deps.log('extraction: two transient failures in a row, so the tick ends; the provider may be down')
        return
      }
      if (counts.windows >= EXTRACTION_WINDOWS_PER_TICK) return
    }
  }
}

async function runWindow(
  deps: ExtractionTickDeps & { intelligence: IntelligenceAdapter },
  anchor: PendingAnchor,
  now: () => Date,
): Promise<WindowStatus> {
  const { store, log } = deps
  const started = Date.now()
  const line = (status: string, detail: string): void =>
    log(
      `extraction: session=${prefix(anchor.sessionId)} anchor=${prefix(anchor.anchorId)} status=${status}` +
        `${detail} ms=${Date.now() - started}`,
    )

  if (anchor.runningRunId !== null) {
    if (!isStale(anchor, now())) return 'skipped'
    // The closed run is a transient failure like any other, so the anchor now
    // waits out the backoff it sets; a window that kills its worker every
    // time is left after EXTRACTION_TRANSIENT_FAILURES_MAX tries.
    const closed = await store.extractionFail(anchor.runningRunId, {
      error: `the run was still running after ${EXTRACTION_STALE_RUN_MS} ms`,
      failure: 'transient',
      stats: { anchor_kind: anchor.anchorKind },
    })
    line('stale_closed', '')
    if (closed) logIfExhausted(log, anchor, 'transient')
    return 'skipped'
  }

  const runId = await store.extractionBegin({
    anchorId: anchor.anchorId,
    sessionId: anchor.sessionId,
    version: EXTRACTOR_VERSION,
    model: deps.model,
  })
  if (runId === null) return 'skipped'

  let window: ExtractionWindow
  let result: ExtractWindowResult
  try {
    const raw = await store.extractionWindow(anchor.anchorId, EXTRACTION_WINDOW_SUBJECTS_MAX, RECENT_LISTING_LIMIT)
    if (raw === null) {
      // Forgotten or deleted since it was handed out: nothing to extract, and
      // the pending read no longer returns it.
      await store.extractionFail(runId, {
        error: 'the anchor is gone',
        failure: 'transient',
        stats: { anchor_kind: anchor.anchorKind },
      })
      line('gone', '')
      return 'gone'
    }
    window = buildWindow(raw)
    result = await extractWindow(window, { intelligence: deps.intelligence })
  } catch (err) {
    const failure = extractionFailureClass(err)
    const call = isExtractionReplyError(err) ? err.call : null
    await store.extractionFail(runId, {
      error: describeError(err),
      failure,
      stats: { anchor_kind: anchor.anchorKind, ...callStats(call) },
    })
    line(failure, ` error=${errorLabel(err)}`)
    logIfExhausted(log, anchor, failure)
    return failure
  }

  let commit: ExtractionCommit | null = null
  try {
    const payload = buildCommitPayload(window, result, runId)
    commit = {
      ...payload,
      stats: { anchor_kind: anchor.anchorKind, ...callStats(result.call), ...payload.stats },
    }
    const stored = await store.extractionCommit(runId, commit)
    line(
      'succeeded',
      ` statements=${result.statements.length} observations=${result.observations.length}` +
        ` rejected=${result.rejected.length} duplicates=${stored.duplicates} subjects_created=${stored.subjectsCreated}`,
    )
    return 'succeeded'
  } catch (err) {
    await store.extractionFail(runId, {
      error: describeError(err),
      failure: 'held',
      stats: commit?.stats ?? { anchor_kind: anchor.anchorKind, ...callStats(result.call) },
    })
    line('held', ` error=${errorLabel(err)}`)
    logIfExhausted(log, anchor, 'held')
    return 'held'
  }
}

/**
 * Names the anchor when the failure just recorded is its last: the pending
 * read no longer hands it out, and its session's later anchors run.
 */
function logIfExhausted(log: (line: string) => void, anchor: PendingAnchor, failure: ExtractionErrorClass): void {
  const held = anchor.heldFailures + (failure === 'held' ? 1 : 0)
  const transient = anchor.failures - anchor.heldFailures + (failure === 'transient' ? 1 : 0)
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
