/**
 * The ordered extraction pass: every session with pending work, across every
 * source, oldest first.
 *
 * An item supersedes only an older one, so a newer statement stored before an
 * older retelling of it could never be replaced by it, and the older one,
 * stored later, could not replace the newer. The worker takes the most
 * recently received sessions first, which for a backfill is not event time.
 * So the server holds extraction (ENGRAM_EXTRACTION=hold) while this pass
 * runs, and the pass orders every pending session by its earliest pending
 * work:
 * - an extraction window (an anchor no succeeded run extracted at any
 *   extractor version), the first of the session's pending anchors;
 * - a salvage window of the old rows, the first row of its first pending
 *   window.
 *
 * Per session the salvage windows run first, then its extraction windows
 * through the per-session driver (gap fill). A session the driver finds live
 * is listed and left to the worker. A window that fails on its own stops its
 * session and the pass goes on; a provider or store outage stops the pass.
 *
 * Every model call counts against --max-calls. At the cap the pass stops with
 * exit code 3 and a re-run resumes: succeeded windows are not taken again.
 */
import {
  EXTRACTION_WINDOW_SUBJECTS_MAX,
  EXTRACTOR_VERSION,
  RECENT_LISTING_LIMIT,
  SESSION_IDLE_MS,
  buildWindow,
  renderUserMessage,
  type CompleteJsonRequest,
  type IntelligenceAdapter,
  type SessionAnchor,
} from '@engram-mem/core'
import { extractionHeldFromEnv } from '../server-core.js'
import { EXIT_CAPPED, runExtract, type ExtractStore } from '../ingest/extract-lib.js'
import { refuseUnsettled, type LegacyUtteranceStore } from './legacy-utterances.js'
import {
  planSession,
  salvageSession,
  salvageSessions,
  type SalvageRunStore,
  type SalvageSessionResult,
  type SalvageStore,
} from './salvage.js'

export const EXTRACT_EXIT_OK = 0
export const EXTRACT_EXIT_FAILED = 1
export const EXTRACT_EXIT_CAPPED = 3

/** The earliest time the session listing reads from; every utterance is later. */
const LISTING_SINCE = new Date(0)

export class ExtractRefused extends Error {}

/** Thrown in place of a model call the cap does not allow; the call is never made. */
class CallCapReached extends Error {}

export interface ExtractPassDeps {
  env: Record<string, string | undefined>
  guards: Pick<LegacyUtteranceStore, 'unsettledCaptureEvents' | 'legacyStepWithWork' | 'unforgottenLegacyItems'>
  extraction: ExtractStore
  salvage: SalvageStore
  runs: SalvageRunStore
  /** Required with apply. */
  intelligence: IntelligenceAdapter | null
  model: string | null
  now: () => Date
  log: (line: string) => void
}

export interface ExtractPassOptions {
  apply: boolean
  /** Required with apply. */
  maxCalls: number | null
}

export interface PassWindow {
  kind: string
  chars: number
}

export interface PassSession {
  session: string
  /** The earliest pending work, ISO. */
  at: string
  salvage: boolean
  /** Pending extraction anchors. */
  anchors: number
  /** Dry run only: the session's pending windows, salvage first. */
  windows?: PassWindow[]
  /** Apply only: what the salvage windows came to, by status. */
  salvaged?: Record<string, number>
  /** Apply only: what the extraction windows came to, by status. */
  extracted?: Record<string, number>
  /** The driver found the session live; the worker extracts it once extraction is on again. */
  leftToWorker?: boolean
}

export interface ExtractPassSummary {
  command: 'extract'
  apply: boolean
  maxCalls: number | null
  calls: number
  capped: boolean
  failed: boolean
  /** Why the pass stopped before its last session, or null. */
  stopped: string | null
  sessions: PassSession[]
}

interface PendingSession {
  session: string
  at: number
  salvage: boolean
  anchors: SessionAnchor[]
}

export async function runExtractPass(opts: ExtractPassOptions, deps: ExtractPassDeps): Promise<{ exitCode: number; summary: ExtractPassSummary }> {
  if (!extractionHeldFromEnv(deps.env)) {
    throw new ExtractRefused(
      'ENGRAM_EXTRACTION is not hold: the server would extract live sessions first; set ENGRAM_EXTRACTION=hold for the server and this run',
    )
  }
  await refuseUnsettled(deps.guards)
  if (opts.apply && (opts.maxCalls === null || deps.intelligence === null)) {
    throw new Error('extract --apply needs --max-calls and a chat model')
  }

  const sessions = await pendingSessions(deps)
  const summary: ExtractPassSummary = {
    command: 'extract',
    apply: opts.apply,
    maxCalls: opts.maxCalls,
    calls: 0,
    capped: false,
    failed: false,
    stopped: null,
    sessions: [],
  }
  if (!opts.apply) {
    for (const s of sessions) summary.sessions.push({ ...listed(s), windows: await dryWindows(s, deps) })
    return { exitCode: EXTRACT_EXIT_OK, summary }
  }

  const max = opts.maxCalls!
  const counted = countedIntelligence(deps.intelligence!, max, summary)
  for (const s of sessions) {
    const entry: PassSession = listed(s)
    summary.sessions.push(entry)
    if (summary.calls >= max) return capped(summary)
    if (s.salvage) {
      let result: SalvageSessionResult
      try {
        result = await salvageSession(s.session, { store: deps.salvage, runs: deps.runs, intelligence: counted, model: deps.model })
      } catch (err) {
        if (err instanceof CallCapReached) return capped(summary)
        throw err
      }
      entry.salvaged = tally(result.windows.map((w) => w.status))
      if (result.windows.some((w) => w.status === 'failed' || w.status === 'refused')) summary.failed = true
    }
    if (s.anchors.length === 0) continue
    if (summary.calls >= max) return capped(summary)
    const statuses: string[] = []
    const outcome = await runExtract(
      { sessionId: s.session, since: null, maxCalls: max - summary.calls, version: null, dryRun: false, replace: false, reportPath: null },
      {
        store: deps.extraction,
        intelligence: deps.intelligence!,
        model: deps.model,
        now: deps.now,
        emit: (line) => {
          if (typeof line.skipped === 'string') entry.leftToWorker = true
          else if (typeof line.status === 'string') statuses.push(line.status)
        },
        log: deps.log,
        report: null,
      },
    )
    summary.calls += outcome.calls
    entry.extracted = tally(statuses)
    if (outcome.exitCode === EXIT_CAPPED) return capped(summary)
    if (statuses.includes('aborted')) {
      summary.failed = true
      summary.stopped = `session ${s.session}: the provider or the store failed without an answer`
      return { exitCode: EXTRACT_EXIT_FAILED, summary }
    }
    if (outcome.exitCode !== EXTRACT_EXIT_OK) summary.failed = true
  }
  return { exitCode: summary.failed ? EXTRACT_EXIT_FAILED : EXTRACT_EXIT_OK, summary }
}

/**
 * Every session with pending work, by its earliest pending time, then id.
 * The session listing is read oldest first and paged by its first time, so
 * a response cut at the server's row cap loses no session.
 */
async function pendingSessions(deps: ExtractPassDeps): Promise<PendingSession[]> {
  const byId = new Map<string, PendingSession>()
  for (const ref of await salvageSessions(deps.salvage)) {
    byId.set(ref.sessionId, { session: ref.sessionId, at: Date.parse(ref.firstAt), salvage: true, anchors: [] })
  }
  const listed = new Set<string>()
  let since = LISTING_SINCE
  for (;;) {
    const page = await deps.extraction.extractionSessions({ sessionId: null, since, idleMs: SESSION_IDLE_MS, now: deps.now() })
    const fresh = page.filter((s) => !listed.has(s.sessionId))
    if (fresh.length === 0) break
    for (const s of fresh) {
      listed.add(s.sessionId)
      const anchors = (await deps.extraction.extractionSessionAnchors(EXTRACTOR_VERSION, s.sessionId, 'any_version')).filter(
        (a) => !a.succeeded,
      )
      if (anchors.length === 0) continue
      const first = Math.min(...anchors.map((a) => a.occurredAt.getTime()))
      const known = byId.get(s.sessionId)
      byId.set(s.sessionId, {
        session: s.sessionId,
        at: known === undefined ? first : Math.min(known.at, first),
        salvage: known?.salvage ?? false,
        anchors,
      })
    }
    const times = page.flatMap((s) => (s.firstAt === null ? [] : [s.firstAt.getTime()]))
    if (times.length === 0) break
    since = new Date(Math.max(...times))
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0))
}

function listed(s: PendingSession): PassSession {
  return { session: s.session, at: new Date(s.at).toISOString(), salvage: s.salvage, anchors: s.anchors.length }
}

/** The session's pending windows with their sizes, read only; no model is called. */
async function dryWindows(s: PendingSession, deps: ExtractPassDeps): Promise<PassWindow[]> {
  const windows: PassWindow[] = []
  if (s.salvage) {
    const plan = planSession(s.session, await deps.salvage.sessionRows(s.session))
    const done = plan.windows.length === 0 ? new Set<string>() : await deps.salvage.completedWindowKeys(plan.windows.map((w) => w.key))
    for (const w of plan.windows) if (!done.has(w.key)) windows.push({ kind: 'salvage', chars: w.text.length })
  }
  for (const a of s.anchors) {
    const raw = await deps.extraction.extractionWindow(
      a.anchorId,
      EXTRACTION_WINDOW_SUBJECTS_MAX,
      RECENT_LISTING_LIMIT,
      EXTRACTOR_VERSION,
      'any_version',
    )
    if (raw !== null) windows.push({ kind: a.anchorKind, chars: renderUserMessage(buildWindow(raw)).length })
  }
  return windows
}

/** The salvage's model adapter, counting each call and refusing one past the cap before it is made. */
function countedIntelligence(
  intelligence: IntelligenceAdapter,
  max: number,
  summary: ExtractPassSummary,
): Pick<IntelligenceAdapter, 'completeJson'> {
  const completeJson = intelligence.completeJson
  if (!completeJson) throw new Error('extract needs an intelligence adapter with completeJson')
  return {
    completeJson: async (req: CompleteJsonRequest) => {
      if (summary.calls >= max) throw new CallCapReached(`the call cap ${max} was reached`)
      summary.calls += 1
      return completeJson.call(intelligence, req)
    },
  }
}

function capped(summary: ExtractPassSummary): { exitCode: number; summary: ExtractPassSummary } {
  summary.capped = true
  summary.stopped = `--max-calls ${summary.maxCalls} reached after ${summary.calls} model calls; run again to resume`
  return { exitCode: EXTRACT_EXIT_CAPPED, summary }
}

function tally(statuses: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1
  return out
}
