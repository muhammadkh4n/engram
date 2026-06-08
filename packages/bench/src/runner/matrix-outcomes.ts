// Dependency-light outcome extraction for the ablation matrix. Kept separate
// from compare-matrix.ts (which imports the onnx-heavy adapters) so the pairing
// + classification logic stays unit-testable without native binaries. Pure:
// imports only the classifier and types.
import { classifyRecallStructure } from '../classification/classify-recall-structure.js'
import type { QuestionOutcome } from '../metrics/graph-effect.js'
import type { LoCoMoResult, LongMemEvalResult } from '../types.js'

/** Pair LongMemEval predictions (graph-on vs graph-off) into classified outcomes. */
export function extractLongMemEvalOutcomes(
  on: LongMemEvalResult,
  off: LongMemEvalResult,
): QuestionOutcome[] {
  const offById = new Map(off.predictions.map((p) => [p.questionId, p]))
  const outcomes: QuestionOutcome[] = []
  for (const onP of on.predictions) {
    const offP = offById.get(onP.questionId)
    if (!offP) continue
    const structure = classifyRecallStructure({
      question: onP.question,
      goldAnswer: onP.goldAnswer,
      goldIds: onP.goldSessionIds,
      ability: onP.ability,
    }).type
    outcomes.push({
      id: onP.questionId,
      recallAtKMergeOff: offP.recallAt5,
      recallAtKMergeOn: onP.recallAt5,
      structure,
    })
  }
  return outcomes
}

/** Pair LoCoMo qa predictions (graph-on vs graph-off) into classified outcomes. */
export function extractLoCoMoOutcomes(on: LoCoMoResult, off: LoCoMoResult): QuestionOutcome[] {
  const offById = new Map<string, { recallAtK: boolean }>()
  for (const c of off.conversations) {
    for (const qa of c.qaPredictions) offById.set(qa.qaId, qa)
  }
  const outcomes: QuestionOutcome[] = []
  for (const c of on.conversations) {
    for (const qa of c.qaPredictions) {
      const offQa = offById.get(qa.qaId)
      if (!offQa) continue
      const structure = classifyRecallStructure({
        question: qa.question,
        goldAnswer: qa.goldAnswer,
        goldIds: [],
        category: qa.category,
      }).type
      outcomes.push({
        id: qa.qaId,
        recallAtKMergeOff: offQa.recallAtK,
        recallAtKMergeOn: qa.recallAtK,
        structure,
      })
    }
  }
  return outcomes
}
