// Context modes for the recall sweep.
//
// `sessions` (default): recall with a widened result cap and project dataset
// session ids — the reader context is rebuilt later from raw dataset sessions.
// `formatted`: recall exactly as the MCP server does and record the text it
// returns to the agent (`result.formatted`), so downstream judging reads the
// production payload rather than a re-hydrated approximation.
//
// Structurally typed and free of runtime imports, so tests drive it with a
// stubbed memory: no model, no network, no built core package.
import { projectSessionIds, stripBenchSessionNamespace, type SessionProjectionInput } from './project-sessions.js'
import type { SynthesisBlock } from './synthesis-row.js'

export type ContextMode = 'sessions' | 'formatted'

const CONTEXT_MODES: readonly ContextMode[] = ['sessions', 'formatted']

/**
 * Parse `--context-mode sessions|formatted` (default `sessions`). Throws on an
 * unknown value, a missing value, or `formatted` combined with `--synthesize`:
 * the MCP handler only synthesizes when the caller asks, and the formatted
 * payload is defined as the no-synthesis response.
 */
export function parseContextMode(argv: readonly string[]): ContextMode {
  const i = argv.indexOf('--context-mode')
  if (i === -1) return 'sessions'
  const raw = argv[i + 1]
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error('--context-mode needs a value: sessions or formatted')
  }
  if (!(CONTEXT_MODES as readonly string[]).includes(raw)) {
    throw new Error(`--context-mode must be "sessions" or "formatted", got ${JSON.stringify(raw)}`)
  }
  const mode = raw as ContextMode
  if (mode === 'formatted' && argv.includes('--synthesize')) {
    throw new Error('--synthesize cannot be combined with --context-mode formatted (the MCP payload is recalled without synthesis)')
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

export interface SweepRecallResult extends SessionProjectionInput {
  formatted: string
  synthesis?: SynthesisBlock | null
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
}

export interface SweepRecallOutcome {
  recalledSessionIds: string[]
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
 * One recall for one question. Session projection (and so recall@K) is the
 * same in both modes; `formatted` mode additionally captures the payload text
 * with the bench session namespace rewritten to dataset ids.
 */
export async function runSweepRecall(
  memory: SweepMemory,
  question: { question_id: string; question: string },
  cfg: SweepRecallConfig,
): Promise<SweepRecallOutcome> {
  const result = await memory.recall(question.question, sweepRecallOptions(cfg))
  const outcome: SweepRecallOutcome = { recalledSessionIds: projectSessionIds(result) }

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
    }
  }

  return outcome
}
