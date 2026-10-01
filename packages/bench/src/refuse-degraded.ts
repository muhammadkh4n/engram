/**
 * A degraded recall ran without a query vector: its candidates come from the
 * lexical leg alone. Scoring it would report keyword-only retrieval under the
 * name of the full pipeline, so a measurement run stops on it instead.
 */
export class DegradedRecallError extends Error {
  constructor(question: string, reason: string) {
    super(`recall degraded for question "${question}" (vector search unavailable: ${reason}); refusing to score it`)
    this.name = 'DegradedRecallError'
  }
}

export interface MaybeDegradedRecall {
  degraded?: { vector: string } | undefined
}

export function assertRecallNotDegraded(result: MaybeDegradedRecall, question: string): void {
  if (result.degraded) throw new DegradedRecallError(question, result.degraded.vector)
}
