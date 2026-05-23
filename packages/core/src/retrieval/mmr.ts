/**
 * Maximal Marginal Relevance (MMR) — diversify a ranked candidate list
 * before passing it to a cross-encoder reranker.
 *
 * Why we have this: cross-encoder rerankers waste capacity on near-duplicate
 * candidates and can push genuinely different relevant items out of the
 * final ranked top-K. SOTA 2026 production RAG pipelines (Prem AI hybrid
 * guide, tianpan.co production hybrid) consistently include an MMR or
 * dedup pass before the cross-encoder. Engram previously did not.
 *
 * Three consecutive ingest-layer experiments (Contextual Retrieval split,
 * BM25-as-peer, atomic propositions) each broke the reranker by changing
 * the input candidate distribution. MMR is the structural defense: it
 * normalizes the distribution by removing near-duplicates regardless of
 * which upstream stage produced them.
 *
 * Similarity: lemma-Jaccard over content. Lightweight, deterministic,
 * needs no extra embeddings, and catches the exact near-duplicate shape
 * we've seen (proposition + source turn sharing 80%+ of content lemmas).
 */
import type { RetrievedMemory } from '../types.js'

/**
 * Apply Maximal Marginal Relevance to a relevance-ranked candidate list.
 *
 * Iteratively picks the candidate that maximizes:
 *   λ * relevance(c) − (1 − λ) * max_{s ∈ selected} jaccard(c, s)
 *
 * - λ = 1.0 → pure relevance, identity transform (no diversification)
 * - λ = 0.0 → pure diversity, completely anti-correlated picks
 * - λ = 0.5 → balanced, standard starting point for MMR in IR
 *
 * If `candidates.length <= maxOut`, the list is still re-ordered by MMR
 * but no items are dropped — diversity reordering still benefits the
 * downstream reranker even when it would see all items anyway.
 */
export function applyMMR(
  candidates: RetrievedMemory[],
  lambda: number,
  maxOut: number,
): RetrievedMemory[] {
  if (candidates.length <= 1) return candidates
  // Defensive: clamp lambda into [0, 1].
  const lam = Math.max(0, Math.min(1, lambda))
  const k = Math.min(maxOut, candidates.length)

  // Pre-compute lemma sets once — content-string lemmatization is the
  // hot path under repeated jaccard() calls below.
  const lemmaSets = candidates.map((c) => contentLemmas(c.content))

  const selectedIdx: number[] = []
  const remaining = new Set<number>(candidates.map((_, i) => i))

  // Bootstrap: first slot is always the top-relevance candidate.
  // (At slot 0 there are no "already selected" items, so MMR reduces to
  // λ * relevance, which is monotone in relevance.)
  let firstIdx = 0
  let firstRel = -Infinity
  for (const i of remaining) {
    if (candidates[i]!.relevance > firstRel) {
      firstRel = candidates[i]!.relevance
      firstIdx = i
    }
  }
  selectedIdx.push(firstIdx)
  remaining.delete(firstIdx)

  while (selectedIdx.length < k && remaining.size > 0) {
    let bestIdx = -1
    let bestScore = -Infinity
    for (const i of remaining) {
      const rel = candidates[i]!.relevance
      let maxSim = 0
      for (const j of selectedIdx) {
        const sim = jaccard(lemmaSets[i]!, lemmaSets[j]!)
        if (sim > maxSim) maxSim = sim
      }
      const mmr = lam * rel - (1 - lam) * maxSim
      if (mmr > bestScore) {
        bestScore = mmr
        bestIdx = i
      }
    }
    if (bestIdx === -1) break
    selectedIdx.push(bestIdx)
    remaining.delete(bestIdx)
  }

  return selectedIdx.map((i) => candidates[i]!)
}

/**
 * Read MMR config from environment.
 * Returns null when disabled (so callers can no-op trivially).
 */
export function mmrConfigFromEnv(): { lambda: number; maxOut: number } | null {
  if (process.env['ENGRAM_MMR_PRE_RERANK'] !== 'true') return null
  const lambda = parseFloat(process.env['ENGRAM_MMR_LAMBDA'] ?? '0.5')
  const maxOut = parseInt(process.env['ENGRAM_MMR_MAX_CANDIDATES'] ?? '50', 10)
  // Defensive: if env supplies garbage, fall back to safe defaults rather
  // than NaN propagating into the scoring math.
  return {
    lambda: Number.isFinite(lambda) ? lambda : 0.5,
    maxOut: Number.isFinite(maxOut) && maxOut > 0 ? maxOut : 50,
  }
}

// --- internals --------------------------------------------------------

const MMR_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'us', 'them',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'if', 'because', 'so', 'as', 'than',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'from',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'should',
  'what', 'who', 'when', 'where', 'why', 'how', 'which',
  'not', 'no', 'yes',
])

/**
 * Tokenize content → lowercased set of stop-filtered, simple-stemmed lemmas.
 * Matches the lemma-overlap technique used in the proposition extractor's
 * hallucination validator so similarity semantics stay consistent across
 * the codebase.
 */
function contentLemmas(text: string): Set<string> {
  const out = new Set<string>()
  const tokens = text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []
  for (const tok of tokens) {
    if (tok.length < 3) continue
    if (MMR_STOPWORDS.has(tok)) continue
    let stem = tok
    if (stem.endsWith('ies') && stem.length > 4) stem = stem.slice(0, -3) + 'y'
    else if (stem.endsWith('ing') && stem.length > 4) stem = stem.slice(0, -3)
    else if (stem.endsWith('ed') && stem.length > 3) stem = stem.slice(0, -2)
    else if (stem.endsWith('s') && stem.length > 3) stem = stem.slice(0, -1)
    out.add(stem)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const x of a) if (b.has(x)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}
