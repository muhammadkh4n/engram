// Pure helpers for a stratified question subset.
//
// A reranker A/B runs every arm over the same questions; a first-N slice
// over-represents whatever types the dataset lists first. The subset keeps
// each question_type's share of the dataset (largest-remainder allocation,
// at least one per type) and picks within a type with a seeded PRNG, so the
// same seed always yields the same list and the list can be recorded.

export interface SubsetQuestion {
  question_id: string
  question_type: string
}

export interface TypeAllocation {
  type: string
  available: number
  /** Exact proportional share: n * available / total. */
  exact: number
  selected: number
}

/** mulberry32: a small, well-mixed 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates over a copy, driven by `rand`. */
export function seededShuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/**
 * Per-type counts summing to `n`, types in first-appearance order. Each type
 * starts at floor(exact) raised to 1; the rest goes one each to the largest
 * remainders (ties to the earlier type). When the minimum of 1 overshoots,
 * the types furthest above their exact share give one back.
 */
export function allocateByType(questions: readonly SubsetQuestion[], n: number): TypeAllocation[] {
  const counts = new Map<string, number>()
  for (const q of questions) counts.set(q.question_type, (counts.get(q.question_type) ?? 0) + 1)
  const total = questions.length
  if (!Number.isInteger(n) || n < counts.size) {
    throw new Error(`--n must be an integer of at least ${counts.size} (one per question_type), got ${n}`)
  }
  if (n > total) throw new Error(`--n ${n} exceeds the ${total} questions in the dataset`)

  const alloc: TypeAllocation[] = [...counts].map(([type, available]) => {
    const exact = (n * available) / total
    return { type, available, exact, selected: Math.min(available, Math.max(1, Math.floor(exact))) }
  })
  let remaining = n - alloc.reduce((s, a) => s + a.selected, 0)
  while (remaining > 0) {
    const next = pickBy(alloc.filter((a) => a.selected < a.available), (a) => a.exact - a.selected)
    next.selected++
    remaining--
  }
  while (remaining < 0) {
    const next = pickBy(alloc.filter((a) => a.selected > 1), (a) => a.selected - a.exact)
    next.selected--
    remaining++
  }
  return alloc
}

/** The entry with the largest score; the earliest wins a tie. */
function pickBy<T>(items: readonly T[], score: (item: T) => number): T {
  let best: T = items[0]!
  for (const item of items) if (score(item) > score(best)) best = item
  return best
}

/**
 * The stratified subset: per-type counts from `allocateByType`, members chosen
 * by a seeded shuffle of each type's ids, returned in dataset order.
 */
export function makeQuestionSubset(
  questions: readonly SubsetQuestion[],
  n: number,
  seed: number,
): { ids: string[]; allocation: TypeAllocation[] } {
  if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer, got ${seed}`)
  const seen = new Set<string>()
  for (const q of questions) {
    if (seen.has(q.question_id)) throw new Error(`duplicate question_id in dataset: ${q.question_id}`)
    seen.add(q.question_id)
  }
  const allocation = allocateByType(questions, n)
  const rand = mulberry32(seed)
  const chosen = new Set<string>()
  for (const a of allocation) {
    const ids = questions.filter((q) => q.question_type === a.type).map((q) => q.question_id)
    for (const id of seededShuffle(ids, rand).slice(0, a.selected)) chosen.add(id)
  }
  return { ids: questions.filter((q) => chosen.has(q.question_id)).map((q) => q.question_id), allocation }
}

/** Dataset rows reduced to the fields the subset needs; throws on a bad row. */
export function parseSubsetDataset(raw: unknown): SubsetQuestion[] {
  if (!Array.isArray(raw)) throw new Error('dataset must be a JSON array of questions')
  return raw.map((q: unknown, i) => {
    const r = q as Record<string, unknown> | null
    if (!r || typeof r['question_id'] !== 'string' || typeof r['question_type'] !== 'string') {
      throw new Error(`dataset row ${i} lacks a string question_id and question_type`)
    }
    return { question_id: r['question_id'], question_type: r['question_type'] }
  })
}
