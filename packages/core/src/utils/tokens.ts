/** Estimate token count using ~4 chars per token approximation. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}
