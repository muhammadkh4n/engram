// Context modes for the recall sweep and the judge.
//
// `sessions` (default): recall with a widened result cap and project dataset
// session ids — the reader context is rebuilt later from raw dataset sessions.
// `formatted`: recall exactly as the MCP server does and record the text it
// returns to the agent (`result.formatted`), so downstream judging reads the
// production payload rather than a re-hydrated approximation; the judge's
// `formatted` mode hands that recorded text to the reader verbatim.
//
// Structurally typed and free of runtime imports, so tests drive it with a
// stubbed memory: no model, no network, no built core package.
import { projectSessionIds, stripBenchSessionNamespace, type SessionProjectionInput } from './project-sessions.js'
import type { SynthesisBlock } from './synthesis-row.js'

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
}

/**
 * The options the `memory_recall` tool handler in
 * packages/mcp/src/server-core.ts passes to `Memory.recall`: `projectId` only
 * when the caller supplies one, `synthesize` only when the caller asks (never
 * here). No `strategyOverride`, `tokenBudget`, `asOf` or `now`, so the
 * intent-mode strategy's own result cap and token budget apply.
 */
export function productionRecallOptions(projectId?: string): ProductionRecallOptions {
  return projectId ? { projectId } : {}
}

interface MetadataCarrier {
  metadata?: Record<string, unknown>
}

export interface SweepRecallResult extends SessionProjectionInput {
  memories: ReadonlyArray<SessionProjectionInput['memories'][number] & { relevance?: number }>
  formatted: string
  synthesis?: SynthesisBlock | null
  /** "Related Memories" in `formatted`. */
  associations?: ReadonlyArray<MetadataCarrier>
  /** "Faint Associations" in `formatted`; absent when there were none. */
  faintAssociations?: ReadonlyArray<MetadataCarrier>
}

export interface SweepMemory {
  recall(query: string, opts: Record<string, unknown>): Promise<SweepRecallResult>
}

export interface SweepRecallConfig {
  contextMode: ContextMode
  /** Result cap for `sessions` mode (the largest K scored). */
  maxK: number
  synthesize: boolean
  /** Question date, the anchor for now-relative synthesis lines. */
  now?: Date | null
}

export interface FormattedContextFields {
  formatted: string
  context_chars: number
  context_items: number
  /** Gold session ids with at least one memory in the payload, in gold order. */
  gold_ids_in_context: string[]
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
  if (cfg.contextMode === 'formatted') return { ...productionRecallOptions() }
  return {
    strategyOverride: { maxResults: cfg.maxK },
    ...(cfg.synthesize
      ? {
          synthesize: { maxEvidenceSessions: 5, includeComputeNotes: true },
          ...(cfg.now ? { now: cfg.now } : {}),
        }
      : {}),
  }
}

/**
 * Gold session ids present in the payload. The formatter's line tags carry no
 * session id, so presence is read from `metadata.lmeSessionId` of every memory
 * the payload renders: recalled, related and faint.
 */
export function goldIdsInContext(result: SweepRecallResult, goldIds: readonly string[]): string[] {
  const inContext = new Set<string>()
  const rendered = [...result.memories, ...(result.associations ?? []), ...(result.faintAssociations ?? [])]
  for (const m of rendered) {
    const sid = m.metadata?.['lmeSessionId']
    if (typeof sid === 'string') inContext.add(sid)
  }
  return goldIds.filter((id, i) => inContext.has(id) && goldIds.indexOf(id) === i)
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
    const formatted = stripBenchSessionNamespace(result.formatted, question.question_id)
    outcome.formattedFields = {
      formatted,
      context_chars: formatted.length,
      context_items: result.memories.length,
      gold_ids_in_context: goldIdsInContext(result, question.answer_session_ids),
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
