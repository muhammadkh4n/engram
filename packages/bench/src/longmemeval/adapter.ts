import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Memory } from '@engram-mem/core'
import type {
  BenchmarkOpts, LongMemEvalResult, LongMemEvalPrediction,
  LongMemEvalAbilityMetrics, LongMemEvalAbility,
} from '../types.js'
import type { LongMemEvalQuestion } from './types.js'
import { createBenchMemory } from '../memory-factory.js'

export class LongMemEvalAdapter {
  async loadDataset(dataPath: string): Promise<LongMemEvalQuestion[]> {
    const stat = await fs.stat(dataPath)

    if (stat.isDirectory()) {
      const entries = await fs.readdir(dataPath)
      const jsonFiles = entries.filter(e => e.endsWith('.json')).sort()
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

  async ingestQuestion(
    question: LongMemEvalQuestion,
    memory: Memory,
  ): Promise<{ episodesIngested: number }> {
    let episodesIngested = 0

    for (const session of question.haystack_sessions) {
      const engSessionId = `longmemeval:${question.question_id}:${session.session_id}`

      for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
        const msg = session.messages[msgIdx]!
        if (!msg.content || msg.content.trim().length === 0) continue

        await memory.ingest({
          role: msg.role,
          content: msg.content.trim(),
          sessionId: engSessionId,
          metadata: {
            lmeQuestionId: question.question_id,
            lmeSessionId: session.session_id,
            lmeMsgIndex: msgIdx,
          },
        })

        episodesIngested++
      }
    }

    return { episodesIngested }
  }

  async ingestDataset(
    questions: LongMemEvalQuestion[],
    memory: Memory,
    opts?: Pick<BenchmarkOpts, 'consolidate'>,
  ): Promise<{ totalEpisodes: number }> {
    let totalEpisodes = 0

    for (const question of questions) {
      const { episodesIngested } = await this.ingestQuestion(question, memory)
      totalEpisodes += episodesIngested

      if (opts?.consolidate !== false) {
        await memory.consolidate('light')
      }
    }

    if (opts?.consolidate !== false) {
      await memory.consolidate('deep')
      await memory.consolidate('dream')
      await memory.consolidate('decay')
    }

    return { totalEpisodes }
  }

  protected mapAbility(rawType: string): LongMemEvalAbility {
    const mapping: Record<string, LongMemEvalAbility> = {
      single_session_user: 'information_extraction',
      single_session_assistant: 'information_extraction',
      multi_session: 'multi_session_reasoning',
      knowledge_update: 'knowledge_updates',
      temporal: 'temporal_reasoning',
      adversarial: 'abstention',
    }
    return mapping[rawType] ?? 'information_extraction'
  }

  async evaluateDataset(
    questions: LongMemEvalQuestion[],
    memory: Memory,
    opts?: Pick<BenchmarkOpts, 'topK'>,
  ): Promise<LongMemEvalPrediction[]> {
    const topK = opts?.topK ?? 10
    const predictions: LongMemEvalPrediction[] = []

    for (const question of questions) {
      const recallResult = await memory.recall(question.question)
      const topMemories = recallResult.memories.slice(0, topK)

      const seenSessionIds = new Set<string>()
      const recalledSessionIds: string[] = []
      for (const mem of topMemories) {
        const lmeSessionId = mem.metadata?.lmeSessionId as string | undefined
        if (lmeSessionId && !seenSessionIds.has(lmeSessionId)) {
          seenSessionIds.add(lmeSessionId)
          recalledSessionIds.push(lmeSessionId)
        }
      }

      const top5 = recalledSessionIds.slice(0, 5)
      const top10 = recalledSessionIds.slice(0, 10)

      const recallAt5 = question.answer_session_ids.some(id => top5.includes(id))
      const recallAt10 = question.answer_session_ids.some(id => top10.includes(id))

      const prediction = topMemories
        .map(m => m.content)
        .filter(c => c && c.trim().length > 0)
        .join(' ')
        .slice(0, 2000)

      predictions.push({
        questionId: question.question_id,
        question: question.question,
        goldAnswer: question.answer,
        goldSessionIds: question.answer_session_ids,
        prediction,
        recalledSessionIds,
        recallAt5,
        recallAt10,
        ability: this.mapAbility(question.memory_type),
      })
    }

    return predictions
  }

  async run(dataPath: string, opts?: BenchmarkOpts): Promise<LongMemEvalResult> {
    const ingestStart = Date.now()
    const memory = await createBenchMemory(opts)
    const questions = await this.loadDataset(dataPath)

    await this.ingestDataset(questions, memory, opts)
    const ingestTimeMs = Date.now() - ingestStart

    const evalStart = Date.now()
    const predictions = await this.evaluateDataset(questions, memory, opts)
    const evalTimeMs = Date.now() - evalStart

    const totalQueries = predictions.length
    const overallR5 =
      predictions.length > 0
        ? predictions.filter(p => p.recallAt5).length / predictions.length
        : 0
    const overallR10 =
      predictions.length > 0
        ? predictions.filter(p => p.recallAt10).length / predictions.length
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
        recallAt5: preds.filter(p => p.recallAt5).length / preds.length,
        recallAt10: preds.filter(p => p.recallAt10).length / preds.length,
      })
    }

    const evalJsonl = predictions.map(p => ({
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
      metrics: { totalQueries, ingestTimeMs, evalTimeMs, totalTokensRecalled },
      evalJsonl,
    }
  }
}
