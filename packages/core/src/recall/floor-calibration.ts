/**
 * A rerank score means something only for the model and dtype that produced
 * it: gte-reranker-modernbert-base at q8 and the OpenAI fallback put the same
 * pair on different scales. So the relevance floor is measured per reranker
 * on real memory and recorded here, and a recall with a reranker that has no
 * entry refuses instead of guessing a threshold.
 */
export interface FloorCalibration {
  /** The reranker id the scores came from, e.g. `onnx:<model>:q8`. */
  reranker: string
  /** Items scoring below this are not shown. */
  floor: number
  /** Items scoring at or above this form the first band. */
  strong: number
  /** When the measurement ran (ISO 8601). */
  calibratedAt: string
  /** Which cases it ran on. */
  dataset: string
  /** Gold items that reached the slate. */
  neededInSlate: number
  /** Of those, how many scored below the floor. */
  neededBelowFloor: number
}

export const FLOOR_CALIBRATIONS: readonly FloorCalibration[] = []

/** The measured floor for a reranker, or null when none is recorded. */
export function floorFor(rerankerId: string, table: readonly FloorCalibration[] = FLOOR_CALIBRATIONS): FloorCalibration | null {
  return table.find((entry) => entry.reranker === rerankerId) ?? null
}
