import type { BenchRecallResult, BenchScoredMemory } from '../merge-associations.js'

/**
 * Iterative / agentic retrieval (the A4 arm).
 *
 * The cheap, no-graph multi-hop competitor every modern agent already uses:
 * retrieve → let an LLM name the bridge entity / next sub-question → re-retrieve,
 * for a few rounds. It recovers hop-2+ evidence that single-shot dense misses
 * (the bridge paragraph is not similar to the original question, so vector
 * search alone cannot surface it) WITHOUT a graph, a second datastore, or
 * per-ingest extraction.
 *
 * It is the linchpin of the eval: if a correctly-wired graph (A3, PPR bound)
 * cannot beat A4 on bridge-entity multi-hop — the graph's home turf — then the
 * universal case for a graph engine collapses, because A4 is cheaper and
 * generalizes across distributions.
 *
 * Dependencies are injected (`recall`, `proposeNextQuery`) so the control flow
 * is unit-testable with no OpenAI/Neo4j: the LLM "name the bridge" step and the
 * underlying memory recall are both stubs in tests and real clients in the
 * adapter.
 */
export interface IterativeRecallDeps {
  /** Bound recall over the memory under test. For A4 the graph is OFF. */
  recall: (query: string) => Promise<BenchRecallResult>
  /**
   * The agentic step: given the original multi-hop question and the memories
   * gathered so far, return the NEXT single-hop retrieval query (a sub-question
   * or bridge entity), or null to stop (enough evidence / no further hop).
   */
  proposeNextQuery: (
    question: string,
    retrievedSoFar: readonly BenchScoredMemory[],
  ) => Promise<string | null>
}

export interface IterativeRecallOpts {
  /** Max retrieval rounds, including the first. Default 3. */
  maxRounds?: number
  /** Cap on returned memories. Default 20. */
  limit?: number
  /**
   * Mirror the adapter's scoring pool: when true, append the graph
   * spreading-activation channel to each round's pool. A4 runs graph-off so
   * this is normally false; kept for parity if iterative is ever combined with
   * the graph arm.
   */
  mergeAssociationsIntoTopK?: boolean
}

export interface IterativeRecallTrace {
  /** Queries issued in order, starting with the original question. */
  queries: string[]
  /** Memory count returned by each round's recall. */
  perRoundCounts: number[]
  /** Number of recall rounds actually run. */
  rounds: number
}

export interface IterativeRecallResult {
  memories: BenchScoredMemory[]
  trace: IterativeRecallTrace
}

function dedupeByBestRelevance(
  memories: readonly BenchScoredMemory[],
): BenchScoredMemory[] {
  const best = new Map<string, BenchScoredMemory>()
  for (const m of memories) {
    const prev = best.get(m.id)
    if (!prev || m.relevance > prev.relevance) best.set(m.id, m)
  }
  return [...best.values()]
}

/**
 * Round-robin interleave the per-round ranked lists, deduping by id.
 *
 * This is the faithful multi-hop merge: it reserves top slots for EACH round's
 * best evidence, so the round-2 bridge paragraph (high-relevance to its
 * sub-query) lands near the top instead of being buried under round-1's full
 * ranked list. Pure dense (A1) is exactly round 1 alone; the interleave is what
 * lets later hops survive into top-K.
 */
function interleaveByRank(
  perRound: readonly (readonly BenchScoredMemory[])[],
  limit: number,
): BenchScoredMemory[] {
  const seen = new Set<string>()
  const out: BenchScoredMemory[] = []
  const maxLen = perRound.reduce((acc, r) => Math.max(acc, r.length), 0)
  for (let rank = 0; rank < maxLen && out.length < limit; rank++) {
    for (const round of perRound) {
      if (rank >= round.length) continue
      const m = round[rank]
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
      if (out.length >= limit) break
    }
  }
  return out
}

export async function iterativeRecall(
  question: string,
  deps: IterativeRecallDeps,
  opts: IterativeRecallOpts = {},
): Promise<IterativeRecallResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 3)
  const limit = opts.limit ?? 20

  const perRound: BenchScoredMemory[][] = []
  const queries: string[] = []
  let query = question

  for (let round = 0; round < maxRounds; round++) {
    queries.push(query)
    const result = await deps.recall(query)
    const pool = opts.mergeAssociationsIntoTopK
      ? [...result.memories, ...result.associations]
      : result.memories
    perRound.push(pool)

    if (round === maxRounds - 1) break

    const accumulated = dedupeByBestRelevance(perRound.flat())
    const next = await deps.proposeNextQuery(question, accumulated)
    const trimmed = next?.trim()
    if (!trimmed) break
    // Cycle guard: an agent that re-proposes a query it already ran would loop
    // without adding evidence.
    if (queries.includes(trimmed)) break
    query = trimmed
  }

  return {
    memories: interleaveByRank(perRound, limit),
    trace: {
      queries,
      perRoundCounts: perRound.map((r) => r.length),
      rounds: perRound.length,
    },
  }
}
