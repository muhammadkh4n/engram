/**
 * engram-extract: re-runs extraction for one session or every session with an
 * MK utterance since a time, oldest first, so supersession runs forward in
 * event time. Each window goes through the worker's own steps (window read,
 * model call, gate, decision pass, commit) under the worker's claim: a run
 * row per window and extractor version, which the unique index on
 * (anchor_item_id, extractor_version) for running and succeeded runs allows
 * once, so the CLI takes no lock of its own.
 *
 * - Default (gap fill): the windows the worker would take, those no succeeded
 *   run at any extractor version extracted. A version bump re-extracts
 *   nothing by itself.
 * - --replace: also the windows other versions extracted and this one has
 *   not, all committed through engram_extraction_replace, which first
 *   retires what other versions stored for the window and the new run does
 *   not reproduce (never an item MK recorded in a register), hands back what
 *   those items superseded, removes their restatement times and makes the
 *   sessions of what it retired or handed back due for a new index.
 * - --dry-run: calls the model and the gate and writes nothing, run rows
 *   included.
 *
 * A live session (not ended, still receiving events) is skipped: its windows
 * belong to the worker. A session stops at its first window that does not
 * succeed, since later windows build on it. Stdout carries one JSON summary
 * per window, ids and counts only; memory text goes only to the report sink.
 */
import {
  EXTRACTION_WINDOW_SUBJECTS_MAX,
  EXTRACTOR_VERSION,
  DECISION_CANDIDATES_MAX,
  RECENT_LISTING_LIMIT,
  SESSION_IDLE_MS,
  askDecisions,
  buildWindow,
  candidateQueries,
  decisionsOf,
  draftCommit,
  extractWindow,
  finishCommit,
  generateId,
  isDataRefusal,
  isExtractionReplyError,
  planDecisions,
  type CaptureStore,
  type CommitDecisions,
  type ExtractedBy,
  type ExtractionCommit,
  type ExtractionCommitResult,
  type ExtractionReplaceResult,
  type ExtractionRerunStore,
  type ExtractWindowResult,
  type IntelligenceAdapter,
  type SessionAnchor,
} from '@engram-mem/core'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_VERSION = 2
export const EXIT_CAPPED = 3

export class UsageError extends Error {}

export interface ExtractOptions {
  sessionId: string | null
  since: Date | null
  maxCalls: number
  version: string | null
  dryRun: boolean
  replace: boolean
  reportPath: string | null
}

export const USAGE =
  'engram-extract (--session <id> | --since <iso>) --max-calls <n> [--version <v>] [--dry-run] [--replace] [--report <path>]'

const FLAGS_WITH_VALUE = new Set(['--session', '--since', '--max-calls', '--version', '--report'])

export function parseExtractArgs(argv: readonly string[]): ExtractOptions {
  const values = new Map<string, string>()
  let dryRun = false
  let replace = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--replace') replace = true
    else if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      if (values.has(arg)) throw new UsageError(`${arg} is given twice`)
      values.set(arg, value)
      i += 1
    } else throw new UsageError(`unknown argument ${arg}`)
  }
  const sessionId = values.get('--session') ?? null
  const sinceText = values.get('--since') ?? null
  if ((sessionId === null) === (sinceText === null)) throw new UsageError('give exactly one of --session and --since')
  if (sessionId !== null && (sessionId.trim() === '' || sessionId.length > 256)) {
    throw new UsageError('--session must hold 1 to 256 characters')
  }
  const since = sinceText === null ? null : new Date(sinceText)
  if (since !== null && (!/^\d{4}-\d{2}-\d{2}/.test(sinceText!) || Number.isNaN(since.getTime()))) {
    throw new UsageError('--since must be an ISO 8601 time')
  }
  const maxCallsText = values.get('--max-calls')
  if (maxCallsText === undefined) throw new UsageError('--max-calls is required: every window is a paid model call')
  const maxCalls = Number(maxCallsText)
  if (!/^\d+$/.test(maxCallsText) || !Number.isSafeInteger(maxCalls) || maxCalls < 1) {
    throw new UsageError('--max-calls must be a whole number, at least 1')
  }
  return { sessionId, since, maxCalls, version: values.get('--version') ?? null, dryRun, replace, reportPath: values.get('--report') ?? null }
}

/** Null when the build runs `version` (or none was asked for), else the refusal. */
export function versionMismatch(version: string | null): string | null {
  return version === null || version === EXTRACTOR_VERSION ? null : `this build runs extractor ${EXTRACTOR_VERSION}`
}

export type ExtractStore = Pick<
  CaptureStore,
  'extractionWindow' | 'extractionCandidates' | 'extractionBegin' | 'extractionFail' | 'extractionCommit'
> &
  ExtractionRerunStore

export interface ExtractDeps {
  store: ExtractStore
  intelligence: IntelligenceAdapter
  /** The configured chat model, recorded on each run. */
  model: string | null
  now: () => Date
  /** One JSON line per window or skipped session; ids and counts only. */
  emit: (summary: Record<string, unknown>) => void
  /** Progress and failure lines; never memory text. */
  log: (line: string) => void
  /** Receives memory text; null when no --report was given. */
  report: ((entry: Record<string, unknown>) => void) | null
}

export interface ExtractOutcome {
  exitCode: number
  windows: number
  calls: number
  capped: boolean
}

type WindowStatus = 'succeeded' | 'dry_run' | 'held' | 'transient' | 'gone' | 'claimed' | 'capped' | 'aborted'

interface Run {
  opts: ExtractOptions
  deps: ExtractDeps
  calls: number
  windows: number
  failed: boolean
}

export async function runExtract(opts: ExtractOptions, deps: ExtractDeps): Promise<ExtractOutcome> {
  const run: Run = { opts, deps, calls: 0, windows: 0, failed: false }
  const sessions = await deps.store.extractionSessions({
    sessionId: opts.sessionId,
    since: opts.since,
    idleMs: SESSION_IDLE_MS,
    now: deps.now(),
  })
  if (opts.sessionId !== null && sessions.length === 0) {
    deps.log(`session ${opts.sessionId} has no capture events`)
    return outcome(run, false, EXIT_FAILED)
  }
  for (const session of sessions) {
    if (!session.due) {
      deps.emit({ session: session.sessionId, skipped: 'live: the worker extracts a session until it ends or goes idle' })
      continue
    }
    const stop = await runSession(run, session.sessionId)
    if (stop === 'capped') {
      deps.log(`stopped at --max-calls ${opts.maxCalls}: ${run.calls} model calls made`)
      return outcome(run, true, EXIT_CAPPED)
    }
    if (stop === 'aborted') return outcome(run, false, EXIT_FAILED)
  }
  return outcome(run, false, run.failed ? EXIT_FAILED : EXIT_OK)
}

/**
 * A gap fill takes what no version extracted, as the worker does; a replace
 * re-runs what only other versions extracted, so it counts this version's
 * runs alone. The window read follows the same rule as the anchor read, so
 * both see the same turn groups.
 */
function extractedBy(opts: ExtractOptions): ExtractedBy {
  return opts.replace ? 'this_version' : 'any_version'
}

function outcome(run: Run, capped: boolean, exitCode: number): ExtractOutcome {
  return { exitCode, windows: run.windows, calls: run.calls, capped }
}

/** Runs the session's windows in order; stops at one that does not succeed. */
async function runSession(run: Run, sessionId: string): Promise<'done' | 'capped' | 'aborted'> {
  const seen = new Set<string>()
  for (;;) {
    const anchors = await run.deps.store.extractionSessionAnchors(EXTRACTOR_VERSION, sessionId, extractedBy(run.opts))
    const next = anchors.find((a) => !a.succeeded && !seen.has(a.anchorId))
    if (next === undefined) return 'done'
    seen.add(next.anchorId)
    if (next.runningRunId !== null) {
      run.deps.emit({ session: sessionId, anchor: next.anchorId, status: 'claimed', detail: 'a run is open on this window' })
      return 'done'
    }
    if (run.calls >= run.opts.maxCalls) return 'capped'
    const status = await runWindow(run, sessionId, next)
    if (status === 'capped' || status === 'aborted') return status
    if (status !== 'succeeded' && status !== 'dry_run' && status !== 'gone') return 'done'
  }
}

async function runWindow(run: Run, sessionId: string, anchor: SessionAnchor): Promise<WindowStatus> {
  const { store } = run.deps
  run.windows += 1
  const base = { session: sessionId, anchor: anchor.anchorId, kind: anchor.anchorKind }
  const callsBefore = run.calls
  const done = (status: WindowStatus, fields: Record<string, unknown> = {}): WindowStatus => {
    run.deps.emit({ ...base, status, ...fields, calls: run.calls - callsBefore })
    if (status === 'held' || status === 'transient' || status === 'aborted') run.failed = true
    return status
  }
  let runId: string | null = null
  if (!run.opts.dryRun) {
    runId = await store.extractionBegin({ anchorId: anchor.anchorId, sessionId, version: EXTRACTOR_VERSION, model: run.deps.model })
    if (runId === null) return done('claimed', { detail: 'another process holds or finished this window' })
  }
  const fail = async (status: 'held' | 'transient' | 'aborted', err: unknown, counted: boolean): Promise<WindowStatus> => {
    if (runId !== null) {
      await store.extractionFail(runId, {
        error: errorText(err),
        failure: status === 'held' ? 'held' : 'transient',
        counted,
        stats: { anchor_kind: anchor.anchorKind, operator_rerun: true },
      })
    }
    return done(status, { error: errorLabel(err) })
  }

  let result: ExtractWindowResult
  let commit: ExtractionCommit
  try {
    const raw = await store.extractionWindow(
      anchor.anchorId,
      EXTRACTION_WINDOW_SUBJECTS_MAX,
      RECENT_LISTING_LIMIT,
      EXTRACTOR_VERSION,
      extractedBy(run.opts),
    )
    if (raw === null) {
      if (runId !== null) {
        await store.extractionFail(runId, { error: 'the anchor is gone', failure: 'transient', counted: false, stats: {} })
      }
      return done('gone')
    }
    const window = buildWindow(raw)
    run.calls += 1
    result = await extractWindow(window, { intelligence: run.deps.intelligence })
    const draft = draftCommit(window, result, runId ?? generateId())
    const queries = candidateQueries(draft)
    const reads = queries.queries.length === 0 ? [] : await store.extractionCandidates(anchor.anchorId, queries.queries, DECISION_CANDIDATES_MAX)
    if (reads === null) return await fail('transient', new Error('the anchor is gone'), false)
    const plan = planDecisions(draft, queries, reads)
    let decisions: CommitDecisions
    if (plan.asked.length === 0) decisions = decisionsOf(plan, null, 0)
    else if (run.calls >= run.opts.maxCalls) {
      await fail('transient', new Error('the call cap was reached before the decision call'), false)
      return 'capped'
    } else {
      run.calls += 1
      decisions = decisionsOf(plan, (await askDecisions(plan, { intelligence: run.deps.intelligence })).parsed, 1)
    }
    const payload = finishCommit(draft, decisions)
    commit = { ...payload, stats: { anchor_kind: anchor.anchorKind, model_calls: run.calls - callsBefore, operator_rerun: true, ...payload.stats } }
  } catch (err) {
    // A reply the model gave but that cannot be used is the window's own
    // failure; anything else (provider down, store fault) stops the re-run
    // without counting against the window.
    if (isExtractionReplyError(err)) return fail(err.failure, err, true)
    if (isDataRefusal(err)) return fail('held', err, true)
    run.deps.log(`window ${anchor.anchorId.slice(0, 8)} failed without an answer (${errorLabel(err)}); the re-run stops`)
    return fail('aborted', err, false)
  }
  writeReport(run, base, result, commit)
  const summary = windowSummary(result, commit)
  if (runId === null) return done('dry_run', { ...summary, stored: null, retired: null, restored: null })
  let stored: ExtractionCommitResult | ExtractionReplaceResult
  try {
    stored = run.opts.replace ? await store.extractionReplace(runId, commit) : await store.extractionCommit(runId, commit)
  } catch (err) {
    if (isDataRefusal(err)) return fail('held', err, true)
    run.deps.log(`window ${anchor.anchorId.slice(0, 8)} commit failed (${errorLabel(err)}); the re-run stops`)
    return fail('aborted', err, false)
  }
  return done('succeeded', { ...summary, ...storedSummary(stored) })
}

function windowSummary(result: ExtractWindowResult, commit: ExtractionCommit): Record<string, unknown> {
  const gate: Record<string, number> = {}
  for (const r of result.rejected) gate[r.rule] = (gate[r.rule] ?? 0) + 1
  const links: Record<string, number> = {}
  const rejectedLinks = [...commit.items.flatMap((i) => i.linksRejected ?? []), ...(commit.retractions ?? []).flatMap((r) => r.rejected)]
  for (const l of rejectedLinks) links[l.reason] = (links[l.reason] ?? 0) + 1
  return {
    proposed: result.statements.length + result.observations.length + result.rejected.length,
    accepted: commit.items.length,
    links_proposed: commit.items.reduce((n, i) => n + (i.links?.length ?? 0), 0) +
      (commit.retractions ?? []).reduce((n, r) => n + r.targets.length, 0),
    rejected: { gate, links },
  }
}

function storedSummary(stored: ExtractionCommitResult | ExtractionReplaceResult): Record<string, unknown> {
  const replaced = 'retired' in stored
  return {
    stored: stored.itemIds.length - stored.duplicates - stored.restatements,
    duplicates: stored.duplicates,
    restatements: stored.restatements,
    linked: stored.linksApplied ?? null,
    retired: replaced ? stored.retired : null,
    restored: replaced ? stored.restored : null,
    kept_recorded: replaced ? stored.keptRecorded : null,
    unrestated: replaced ? stored.unrestated : null,
  }
}

function writeReport(run: Run, base: Record<string, unknown>, result: ExtractWindowResult, commit: ExtractionCommit): void {
  if (run.deps.report === null) return
  run.deps.report({
    ...base,
    items: commit.items.map((i) => ({ class: i.class, kind: i.kind, content: i.content, context: i.context, links: i.links ?? [] })),
    rejected: result.rejected.map((r) => ({ item: r.item, index: r.index, rule: r.rule })),
  })
}

/** The error's code or name, never its message: stdout carries no text. */
function errorLabel(err: unknown): string {
  if (isExtractionReplyError(err)) return err.fault
  if (!(err instanceof Error)) return 'unknown'
  const code = (err as { code?: unknown }).code
  const status = (err as { status?: unknown }).status
  if (typeof code === 'string' || typeof code === 'number') return String(code)
  if (typeof status === 'number') return `HTTP_${status}`
  return err.name
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${errorLabel(err)}: ${err.message.slice(0, 500)}` : 'unknown error'
}
