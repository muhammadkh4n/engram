// Context modes for the recall sweep and the judge.
//
// `sessions` (default): recall with a widened result cap and project dataset
// session ids — the reader context is rebuilt later from raw dataset sessions.
// `formatted`: recall exactly as the MCP server does and record the text it
// returns to the agent (`result.formatted`), so downstream judging reads the
// production payload rather than a re-hydrated approximation; the judge's
// `formatted` mode hands that recorded text to the reader verbatim.
//
// Structurally typed over the recall result, so tests drive it with a stubbed
// memory: no model, no network. Token counts use core's own estimator.
import { estimateTokens } from '@engram-mem/core'
import { projectSessionIds, stripBenchSessionNamespace, type SessionProjectionInput } from './project-sessions.js'
import type { SynthesisBlock } from './synthesis-row.js'
import { assertRecallNotDegraded } from '../../refuse-degraded.js'

export type ContextMode = 'sessions' | 'formatted'

const CONTEXT_MODES: readonly ContextMode[] = ['sessions', 'formatted']

/** The `--context-mode` value; `sessions` when the flag is absent. */
function parseContextModeValue(argv: readonly string[]): ContextMode {
  const i = argv.indexOf('--context-mode')
  if (i === -1) return 'sessions'
  const raw = argv[i + 1]
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error('--context-mode needs a value: sessions or formatted')
  }
  if (!(CONTEXT_MODES as readonly string[]).includes(raw)) {
    throw new Error(`--context-mode must be "sessions" or "formatted", got ${JSON.stringify(raw)}`)
  }
  return raw as ContextMode
}

/**
 * Parse the sweep's `--context-mode sessions|formatted` (default `sessions`).
 * Throws on an unknown value, a missing value, or `formatted` combined with
 * `--synthesize` or `--max-results`: the MCP handler neither synthesizes nor
 * overrides the result cap unless the caller asks, and the formatted payload
 * is defined as that default response.
 */
export function parseContextMode(argv: readonly string[]): ContextMode {
  const mode = parseContextModeValue(argv)
  if (mode === 'formatted' && argv.includes('--synthesize')) {
    throw new Error('--synthesize cannot be combined with --context-mode formatted (the MCP payload is recalled without synthesis)')
  }
  if (mode === 'formatted' && argv.includes('--max-results')) {
    throw new Error('--max-results cannot be combined with --context-mode formatted (the MCP payload uses the intent strategy\'s own result cap)')
  }
  return mode
}

/**
 * Parse the judge's `--context-mode sessions|formatted` (default `sessions`).
 * In `formatted` mode the reader context is the recorded payload verbatim, so
 * `--top-sessions` (a session re-hydration cap) and `--include-synthesis` (a
 * second content slot the payload does not have) cannot apply.
 */
export function parseJudgeContextMode(argv: readonly string[]): ContextMode {
  const mode = parseContextModeValue(argv)
  if (mode === 'formatted' && argv.includes('--top-sessions')) {
    throw new Error('--top-sessions cannot be combined with --context-mode formatted (the reader context is the recorded payload, not re-hydrated sessions)')
  }
  if (mode === 'formatted' && argv.includes('--include-synthesis')) {
    throw new Error('--include-synthesis cannot be combined with --context-mode formatted (the recorded payload is the only reader context)')
  }
  return mode
}

export interface ProductionRecallOptions {
  projectId?: string
  now?: Date
}

/**
 * The options the `memory_recall` tool handler in
 * packages/mcp/src/server-core.ts passes to `Memory.recall`: `projectId` only
 * when the caller supplies one, `synthesize` only when the caller asks (never
 * here), and `now`, the reference date for query expansion and synthesis. The
 * server passes the request time; a bench passes the question date in its
 * place, omitted when the question has none. No `strategyOverride` or
 * `tokenBudget`, so the intent-mode strategy's own result cap and token budget
 * apply.
 */
export function productionRecallOptions(projectId?: string, now?: Date | null): ProductionRecallOptions {
  return {
    ...(projectId ? { projectId } : {}),
    ...(now ? { now } : {}),
  }
}

interface MetadataCarrier {
  id?: string
  metadata?: Record<string, unknown>
}

/** One emitted line of the payload; `raw.slice(start, end)` is the line. */
export interface SweepPayloadItem {
  section: string
  /** The memory id when the item renders a memory. */
  id?: string
  start: number
  end: number
}

/** Structural mirror of core's RecallPayload, the fields the sweep records. */
export interface SweepRecallPayload {
  truncated: boolean
  items: ReadonlyArray<SweepPayloadItem>
}

export interface SweepRecallResult extends SessionProjectionInput {
  memories: ReadonlyArray<SessionProjectionInput['memories'][number] & { relevance?: number }>
  formatted: string
  synthesis?: SynthesisBlock | null
  /** "Related Memories" in `formatted`. */
  associations?: ReadonlyArray<MetadataCarrier>
  /** "Faint Associations" in `formatted`; absent when there were none. */
  faintAssociations?: ReadonlyArray<MetadataCarrier>
  /** Core's token estimate of the raw, namespaced `formatted`; not recorded. */
  estimatedTokens?: number
  /** Where each emitted item sits in `formatted`; set by Memory.recall. */
  payload?: SweepRecallPayload
  /** Set by Memory.recall when the query could not be embedded. */
  degraded?: { vector: string }
}

export interface SweepMemory {
  recall(query: string, opts: Record<string, unknown>): Promise<SweepRecallResult>
}

export interface SweepRecallConfig {
  contextMode: ContextMode
  /** Result cap for `sessions` mode (the largest K scored). */
  maxK: number
  synthesize: boolean
  /**
   * Question date, passed in both modes as the server passes the request time:
   * query expansion anchors relative dates to it, and with `synthesize` it is
   * also the anchor for now-relative synthesis lines.
   */
  now?: Date | null
  /**
   * `formatted` mode only: fusion weights for this recall, passed as
   * `strategyOverride.fusion`. No other strategy key is overridden, so the
   * intent strategy's result cap and token budget still apply.
   */
  fusion?: Readonly<Record<string, number>>
  /**
   * `formatted` mode only: false keeps the recall from recording access,
   * co-recall edges and graph weights, so several recalls over one store
   * each see the store as ingested.
   */
  reconsolidate?: false
}

/** One payload item located in the recorded (namespace-rewritten) text. */
export interface RecordedPayloadItem {
  section: string
  /** `formatted.slice(start, end)` of the row is the item line. */
  start: number
  end: number
  /** Dataset session id of the rendered memory; null for non-memory items. */
  session: string | null
}

export interface FormattedContextFields {
  formatted: string
  context_chars: number
  /** Recalled-memory items emitted in the payload. */
  context_items: number
  /** Gold session ids with at least one emitted item in the payload, in gold order. */
  gold_ids_in_context: string[]
  /** Every emitted item in payload order, so the text can be re-cut exactly. */
  payload_items: RecordedPayloadItem[]
  /**
   * Token estimate of the stored text (namespace stripped), the text the judge
   * reads; a derived arm measures its re-cut text the same way.
   */
  context_tokens: number
  /** The output token budget stopped assembly before every candidate item. */
  truncated: boolean
}

export interface SweepRecallOutcome {
  recalledSessionIds: string[]
  /** Relevance of each recalled memory, in returned order (see `relevanceTop`). */
  relevanceTop: Array<number | null>
  /** Set only when `synthesize` is on; null when recall produced no block. */
  synthesisRow?: SynthesisBlock | null
  /** Set only in `formatted` mode. */
  formattedFields?: FormattedContextFields
}

/** Options for one sweep recall call in the given mode. */
export function sweepRecallOptions(cfg: SweepRecallConfig): Record<string, unknown> {
  if (cfg.contextMode === 'formatted') {
    return {
      ...productionRecallOptions(undefined, cfg.now),
      ...(cfg.fusion !== undefined ? { strategyOverride: { fusion: { ...cfg.fusion } } } : {}),
      ...(cfg.reconsolidate === false ? { reconsolidate: false } : {}),
    }
  }
  if (cfg.fusion !== undefined || cfg.reconsolidate !== undefined) {
    throw new Error('a fusion override and reconsolidate: false apply only to --context-mode formatted')
  }
  return {
    strategyOverride: { maxResults: cfg.maxK },
    ...(cfg.now ? { now: cfg.now } : {}),
    ...(cfg.synthesize ? { synthesize: { maxEvidenceSessions: 5, includeComputeNotes: true } } : {}),
  }
}

/**
 * Gold session ids with at least one emitted payload item, in gold order. Read
 * from the items rather than from every recalled memory: a token budget or
 * emit-K can cut a memory the recall returned, and the reader never sees it.
 */
export function goldIdsInPayload(
  items: ReadonlyArray<Pick<RecordedPayloadItem, 'session'>>,
  goldIds: readonly string[],
): string[] {
  const emitted = new Set(items.map((item) => item.session))
  return goldIds.filter((id, i) => emitted.has(id) && goldIds.indexOf(id) === i)
}

/**
 * Payload items with offsets moved from the raw recall text into `rewrite(raw)`.
 * The rewrite removes a namespace prefix that contains no newline, and every
 * item boundary sits at a line edge, so no removed span straddles a boundary
 * and the new offset is the length of the rewritten prefix.
 */
export function recordPayloadItems(
  result: SweepRecallResult,
  rewrite: (text: string) => string,
): RecordedPayloadItem[] {
  if (!result.payload) {
    throw new Error('recall result has no "payload"; formatted mode needs a core whose Memory.recall reports payload items')
  }
  const raw = result.formatted
  const sessionById = new Map<string, string>()
  for (const m of [...result.memories, ...(result.associations ?? []), ...(result.faintAssociations ?? [])]) {
    const sid = m.metadata?.['lmeSessionId']
    if (typeof m.id === 'string' && typeof sid === 'string' && !sessionById.has(m.id)) sessionById.set(m.id, sid)
  }
  return result.payload.items.map((item) => {
    if (!(Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.start <= item.end && item.end <= raw.length)) {
      throw new Error(`payload item [${item.start}, ${item.end}) lies outside the ${raw.length}-char payload`)
    }
    return {
      section: item.section,
      start: rewrite(raw.slice(0, item.start)).length,
      end: rewrite(raw.slice(0, item.end)).length,
      session: item.id !== undefined ? sessionById.get(item.id) ?? null : null,
    }
  })
}

const RELEVANCE_DECIMALS = 1e4

/**
 * The score of every recalled memory in returned order, rounded to 4
 * decimals. Scores only, never content: the row shows the distribution a
 * reranker produces, which feeds the rerank blend and the forget delete gate.
 * A memory without a finite score records null so positions stay aligned.
 */
export function relevanceTop(result: Pick<SweepRecallResult, 'memories'>): Array<number | null> {
  return result.memories.map((m) =>
    typeof m.relevance === 'number' && Number.isFinite(m.relevance)
      ? Math.round(m.relevance * RELEVANCE_DECIMALS) / RELEVANCE_DECIMALS
      : null,
  )
}

/**
 * One recall for one question. Session projection (and so recall@K) is the
 * same in both modes; `formatted` mode additionally captures the payload text
 * with the bench session namespace rewritten to dataset ids.
 */
export async function runSweepRecall(
  memory: SweepMemory,
  question: { question_id: string; question: string; answer_session_ids: readonly string[] },
  cfg: SweepRecallConfig,
): Promise<SweepRecallOutcome> {
  const result = await memory.recall(question.question, sweepRecallOptions(cfg))
  assertRecallNotDegraded(result, question.question_id)
  const outcome: SweepRecallOutcome = {
    recalledSessionIds: projectSessionIds(result),
    relevanceTop: relevanceTop(result),
  }

  if (cfg.contextMode === 'sessions' && cfg.synthesize) {
    outcome.synthesisRow = result.synthesis
      ? {
          intent: result.synthesis.intent,
          method: result.synthesis.method,
          text: stripBenchSessionNamespace(result.synthesis.text, question.question_id),
        }
      : null
  }

  if (cfg.contextMode === 'formatted') {
    const rewrite = (text: string): string => stripBenchSessionNamespace(text, question.question_id)
    const formatted = rewrite(result.formatted)
    const payloadItems = recordPayloadItems(result, rewrite)
    outcome.formattedFields = {
      formatted,
      context_chars: formatted.length,
      context_items: payloadItems.filter((item) => item.section === 'recalled').length,
      gold_ids_in_context: goldIdsInPayload(payloadItems, question.answer_session_ids),
      payload_items: payloadItems,
      context_tokens: estimateTokens(formatted),
      truncated: result.payload!.truncated,
    }
  }

  return outcome
}

/** The fields of a sweep row the judge reads to build reader context. */
export interface JudgeSweepRow {
  question_id: string
  retrieved_session_ids: string[]
  synthesis?: { text: string } | null
  formatted?: string
  gold_ids_in_context?: string[]
}

export interface JudgeContextConfig {
  contextMode: ContextMode
  topSessions: number
  includeSynthesis: boolean
}

export interface FormattedJudgeFields {
  context_mode: 'formatted'
  context_chars: number
  gold_ids_in_context: string[]
}

export interface JudgeReaderContext {
  /** The text that fills the gen prompt's context block. */
  context: string
  /** The optional derived-notes section; never set in `formatted` mode. */
  synthesisText?: string
  /** Dataset sessions re-hydrated into `context`; 0 in `formatted` mode. */
  sessionsUsed: number
  /** Set only in `formatted` mode, so `sessions` rows keep their shape. */
  rowFields?: FormattedJudgeFields
}

/**
 * Reader context for one judged row. `sessions` re-hydrates the top-N
 * retrieved dataset sessions (via `rebuildSessions`) and optionally adds the
 * synthesis text; `formatted` hands the reader the sweep's recorded payload
 * verbatim. A `formatted` judge over a sweep row without the payload fails
 * loudly: silently re-hydrating sessions would mislabel the cell.
 */
export function judgeReaderContext(
  row: JudgeSweepRow,
  cfg: JudgeContextConfig,
  rebuildSessions: (sessionIds: readonly string[]) => string,
): JudgeReaderContext {
  if (cfg.contextMode === 'formatted') {
    if (typeof row.formatted !== 'string') {
      throw new Error(`sweep row ${row.question_id} has no "formatted" payload; re-run recall-sweep with --context-mode formatted`)
    }
    if (!Array.isArray(row.gold_ids_in_context)) {
      throw new Error(`sweep row ${row.question_id} has no "gold_ids_in_context"; re-run recall-sweep with --context-mode formatted`)
    }
    return {
      context: row.formatted,
      sessionsUsed: 0,
      rowFields: {
        context_mode: 'formatted',
        context_chars: row.formatted.length,
        gold_ids_in_context: [...row.gold_ids_in_context],
      },
    }
  }
  const topSessions = row.retrieved_session_ids.slice(0, cfg.topSessions)
  const synthesisText = cfg.includeSynthesis && row.synthesis?.text ? row.synthesis.text : undefined
  return {
    context: rebuildSessions(topSessions),
    ...(synthesisText !== undefined ? { synthesisText } : {}),
    sessionsUsed: topSessions.length,
  }
}
