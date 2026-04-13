function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 0)
}

export function computeRetrievalF1(prediction: string, gold: string): number {
  if (!prediction || !gold) return 0
  const predTokens = tokenize(prediction)
  const goldTokens = tokenize(gold)
  if (predTokens.length === 0 || goldTokens.length === 0) return 0

  const predCount = new Map<string, number>()
  for (const t of predTokens) predCount.set(t, (predCount.get(t) ?? 0) + 1)

  const goldCount = new Map<string, number>()
  for (const t of goldTokens) goldCount.set(t, (goldCount.get(t) ?? 0) + 1)

  let commonCount = 0
  for (const [token, count] of predCount) {
    commonCount += Math.min(count, goldCount.get(token) ?? 0)
  }
  if (commonCount === 0) return 0

  const precision = commonCount / predTokens.length
  const recall = commonCount / goldTokens.length
  return (2 * precision * recall) / (precision + recall)
}

export function recallAtK(hits: boolean[]): number {
  if (hits.length === 0) return 0
  return hits.filter(Boolean).length / hits.length
}
