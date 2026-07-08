/** All gold ids present within the first `topSessions` retrieved ids —
 *  i.e. the gen model SAW the complete gold evidence. Empty gold → false
 *  (nothing to attribute). */
export function goldFullyInGenContext(
  goldIds: readonly string[],
  retrievedIds: readonly string[],
  topSessions: number,
): boolean {
  if (goldIds.length === 0) return false
  const ctx = new Set(retrievedIds.slice(0, topSessions))
  return goldIds.every((g) => ctx.has(g))
}

const ABSTENTION_RES = [
  /\bi don'?t know\b/i,
  /\bno (?:such )?information\b/i,
  /\bnot (?:mentioned|available|provided|specified)\b/i,
  /\bcannot (?:determine|find|answer)\b/i,
]
/** Refusal-shaped ANSWER (whole-answer heuristic): abstention phrasing in a
 *  short reply, or as the opening clause of a longer one. */
export function genIsAbstention(answer: string): boolean {
  const head = answer.trim().slice(0, 120)
  return ABSTENTION_RES.some((re) => re.test(head)) && answer.trim().length < 240
}

export function goldIsNumeric(gold: string): boolean {
  return /^\s*\d+/.test(gold)
}
