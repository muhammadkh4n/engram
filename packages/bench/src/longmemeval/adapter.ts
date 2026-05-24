/**
 * LongMemEval adapter — fresh-memory-per-question architecture.
 *
 * Unlike LoCoMo (10 conversations, each with many QAs sharing one history),
 * LongMemEval ships 500 independent questions, each with its own haystack
 * of 30–60 sessions. The right shape is:
 *
 *   for each question:
 *     fresh memory     ← ingest haystack, then recall, then dispose
 *     measure recall@K against answer_session_ids
 *
 * Sharing memory across questions would cause cross-question pollution
 * (recall for question N would return sessions from question N-1's haystack)
 * and silently inflate the recall metric.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Memory } from '@engram-mem/core'
import type {
  BenchmarkOpts, LongMemEvalResult, LongMemEvalPrediction,
  LongMemEvalAbilityMetrics, LongMemEvalAbility,
} from '../types.js'
import type { LongMemEvalQuestion, LongMemEvalQuestionType } from './types.js'
import { createBenchMemory } from '../memory-factory.js'

export class LongMemEvalAdapter {
  /**
   * Load a LongMemEval JSON file (or a directory of per-question files).
   * Returns the array of question objects in the cleaned-dataset shape.
   */
  async loadDataset(dataPath: string): Promise<LongMemEvalQuestion[]> {
    const stat = await fs.stat(dataPath)

    if (stat.isDirectory()) {
      const entries = await fs.readdir(dataPath)
      const jsonFiles = entries.filter((e) => e.endsWith('.json')).sort()
      const questions: LongMemEvalQuestion[] = []
      for (const filename of jsonFiles) {
        const raw = await fs.readFile(path.join(dataPath, filename), 'utf8')
        questions.push(JSON.parse(raw) as LongMemEvalQuestion)
      }
      return questions
    }

    const raw = await fs.readFile(dataPath, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as LongMemEvalQuestion[])
      : [parsed as LongMemEvalQuestion]
  }

  /**
   * Ingest a single question's haystack into a fresh Memory.
   *
   * Each turn is tagged with metadata.lmeSessionId so recall results can be
   * matched back to the answer_session_ids gold set for recall@K scoring.
   * The Engram sessionId is namespaced under the question to avoid any
   * collision if the same memory instance is reused later.
   */
  async ingestQuestion(
    question: LongMemEvalQuestion,
    memory: Memory,
  ): Promise<{ episodesIngested: number; sessionsCreated: number }> {
    let episodesIngested = 0
    const sessionsCreated = new Set<string>()

    const n = Math.min(
      question.haystack_session_ids.length,
      question.haystack_sessions.length,
    )

    for (let s = 0; s < n; s++) {
      const lmeSessionId = question.haystack_session_ids[s]!
      const turns = question.haystack_sessions[s]!
      const sessionDate = question.haystack_dates?.[s]
      const engSessionId = `lme:${question.question_id}:${lmeSessionId}`
      sessionsCreated.add(engSessionId)

      for (let t = 0; t < turns.length; t++) {
        const msg = turns[t]!
        if (!msg.content || msg.content.trim().length === 0) continue

        await memory.ingest({
          role: msg.role,
          content: msg.content.trim(),
          sessionId: engSessionId,
          metadata: {
            lmeQuestionId: question.question_id,
            lmeSessionId,
            lmeMsgIndex: t,
            lmeSessionDate: sessionDate ?? null,
            lmeQuestionType: question.question_type,
          },
        })
        episodesIngested++
      }
    }

    return { episodesIngested, sessionsCreated: sessionsCreated.size }
  }

  /**
   * Run one question end-to-end: fresh memory → ingest haystack → recall →
   * compute recall@K. The Memory is disposed afterward to free SQLite.
   */
  async runQuestion(
    question: LongMemEvalQuestion,
    opts?: BenchmarkOpts,
  ): Promise<{
    prediction: LongMemEvalPrediction
    episodesIngested: number
    sessionsCreated: number
    ingestMs: number
    evalMs: number
  }> {
    const memory = await createBenchMemory(opts)
    const topK = opts?.topK ?? 10

    try {
      const ingestStart = Date.now()
      const { episodesIngested, sessionsCreated } = await this.ingestQuestion(question, memory)
      const ingestMs = Date.now() - ingestStart

      const evalStart = Date.now()
      const recallResult = await memory.recall(question.question)
      const topMemories = recallResult.memories.slice(0, topK)

      // Deduplicate retrieved sessions in rank order
      const seen = new Set<string>()
      const recalledSessionIds: string[] = []
      for (const mem of topMemories) {
        const lmeSessionId = mem.metadata?.['lmeSessionId'] as string | undefined
        if (lmeSessionId && !seen.has(lmeSessionId)) {
          seen.add(lmeSessionId)
          recalledSessionIds.push(lmeSessionId)
        }
      }

      const top5 = recalledSessionIds.slice(0, 5)
      const top10 = recalledSessionIds.slice(0, 10)
      const recallAt5 = question.answer_session_ids.some((id) => top5.includes(id))
      const recallAt10 = question.answer_session_ids.some((id) => top10.includes(id))

      const prediction = topMemories
        .map((m) => m.content)
        .filter((c) => c && c.trim().length > 0)
        .join(' ')
        .slice(0, 2000)

      const evalMs = Date.now() - evalStart

      return {
        prediction: {
          questionId: question.question_id,
          question: question.question,
          goldAnswer: question.answer,
          goldSessionIds: question.answer_session_ids,
          prediction,
          recalledSessionIds,
          recallAt5,
          recallAt10,
          ability: this.mapAbility(question.question_type),
        },
        episodesIngested,
        sessionsCreated,
        ingestMs,
        evalMs,
      }
    } finally {
      await memory.dispose().catch(() => { /* cleanup non-fatal */ })
    }
  }

  /**
   * Run the full dataset, fresh memory per question. This is the right
   * shape for LongMemEval — sharing memory across questions would
   * cross-contaminate recall results.
   *
   * Use opts.limit to cap how many questions get evaluated (smoke runs).
   */
  async run(dataPath: string, opts?: BenchmarkOpts): Promise<LongMemEvalResult> {
    const all = await this.loadDataset(dataPath)
    const questions = opts?.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all

    const predictions: LongMemEvalPrediction[] = []
    let totalIngestMs = 0
    let totalEvalMs = 0

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!
      const { prediction, ingestMs, evalMs } = await this.runQuestion(q, opts)
      predictions.push(prediction)
      totalIngestMs += ingestMs
      totalEvalMs += evalMs

      if ((i + 1) % 25 === 0 || i + 1 === questions.length) {
        const hits5 = predictions.filter((p) => p.recallAt5).length
        const hits10 = predictions.filter((p) => p.recallAt10).length
        console.log(
          `  Q ${i + 1}/${questions.length}  recall@5=${hits5}/${predictions.length}  recall@10=${hits10}/${predictions.length}`,
        )
      }
    }

    const totalQueries = predictions.length
    const overallR5 = totalQueries > 0
      ? predictions.filter((p) => p.recallAt5).length / totalQueries
      : 0
    const overallR10 = totalQueries > 0
      ? predictions.filter((p) => p.recallAt10).length / totalQueries
      : 0

    const abilityMap = new Map<LongMemEvalAbility, LongMemEvalPrediction[]>()
    for (const p of predictions) {
      const bucket = abilityMap.get(p.ability) ?? []
      bucket.push(p)
      abilityMap.set(p.ability, bucket)
    }
    const byAbility: LongMemEvalAbilityMetrics[] = []
    for (const [ability, preds] of abilityMap) {
      byAbility.push({
        ability,
        totalQuestions: preds.length,
        recallAt5: preds.filter((p) => p.recallAt5).length / preds.length,
        recallAt10: preds.filter((p) => p.recallAt10).length / preds.length,
      })
    }

    const evalJsonl = predictions.map((p) => ({
      question_id: p.questionId,
      hypothesis: p.prediction,
    }))

    const totalTokensRecalled = predictions.reduce(
      (sum, p) => sum + Math.ceil(p.prediction.length / 4),
      0,
    )

    return {
      benchmark: 'longmemeval',
      predictions,
      overall: { recallAt5: overallR5, recallAt10: overallR10, byAbility },
      metrics: {
        totalQueries,
        ingestTimeMs: totalIngestMs,
        evalTimeMs: totalEvalMs,
        totalTokensRecalled,
      },
      evalJsonl,
    }
  }

  protected mapAbility(rawType: LongMemEvalQuestionType): LongMemEvalAbility {
    switch (rawType) {
      case 'single-session-user':
      case 'single-session-assistant':
      case 'single-session-preference':
        return 'information_extraction'
      case 'multi-session':
        return 'multi_session_reasoning'
      case 'knowledge-update':
        return 'knowledge_updates'
      case 'temporal-reasoning':
        return 'temporal_reasoning'
      case 'abstention':
        return 'abstention'
    }
  }
}
