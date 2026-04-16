import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Memory } from '@engram-mem/core'
import type {
  BenchmarkOpts, LoCoMoResult, LoCoMoConversationResult,
  LoCoMoQAPrediction, LoCoMoEvalFormat, LoCoMoCategoryMetrics,
} from '../types.js'
import type { LoCoMoConversationFile, LoCoMoTurn } from './types.js'
import { computeRetrievalF1 } from '../metrics/f1.js'
import { createBenchMemory } from '../memory-factory.js'

export class LoCoMoAdapter {
  async loadDataset(dataPath: string): Promise<LoCoMoConversationFile[]> {
    const stat = await fs.stat(dataPath)

    if (stat.isDirectory()) {
      const entries = await fs.readdir(dataPath)
      const jsonFiles = entries.filter(e => e.endsWith('.json')).sort()
      const conversations: LoCoMoConversationFile[] = []
      for (const filename of jsonFiles) {
        const raw = await fs.readFile(path.join(dataPath, filename), 'utf8')
        const parsed = JSON.parse(raw) as LoCoMoConversationFile | LoCoMoConversationFile[]
        if (Array.isArray(parsed)) {
          conversations.push(...parsed)
        } else {
          conversations.push(parsed)
        }
      }
      return conversations
    }

    const raw = await fs.readFile(dataPath, 'utf8')
    const parsed = JSON.parse(raw) as LoCoMoConversationFile | LoCoMoConversationFile[]
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  /**
   * Extract session turns from the conversation object.
   * Real LoCoMo format: conversation.session_1 = LoCoMoTurn[], conversation.session_1_date_time = string
   */
  private extractSessions(conv: LoCoMoConversationFile): Array<{
    sessionKey: string
    segmentIndex: number
    dateTime: string | null
    turns: LoCoMoTurn[]
    speakerA: string
    speakerB: string
  }> {
    const sessions: Array<{
      sessionKey: string
      segmentIndex: number
      dateTime: string | null
      turns: LoCoMoTurn[]
      speakerA: string
      speakerB: string
    }> = []

    const speakerA = conv.conversation.speaker_a as string
    const speakerB = conv.conversation.speaker_b as string

    // Find all session_N keys (sorted numerically)
    const sessionKeys = Object.keys(conv.conversation)
      .filter(k => /^session_\d+$/.test(k))
      .sort((a, b) => {
        const numA = parseInt(a.replace('session_', ''), 10)
        const numB = parseInt(b.replace('session_', ''), 10)
        return numA - numB
      })

    for (let i = 0; i < sessionKeys.length; i++) {
      const key = sessionKeys[i]!
      const turns = conv.conversation[key] as LoCoMoTurn[]
      const dateTimeKey = `${key}_date_time`
      const dateTime = (conv.conversation[dateTimeKey] as string) ?? null

      sessions.push({
        sessionKey: key,
        segmentIndex: i + 1, // 1-based
        dateTime,
        turns: Array.isArray(turns) ? turns : [],
        speakerA,
        speakerB,
      })
    }

    return sessions
  }

  /**
   * Ingest all turns from a conversation into memory.
   * Maps each session to an Engram sessionId. Stores dia_id in metadata
   * for evidence matching.
   */
  async ingestConversation(
    conv: LoCoMoConversationFile,
    memory: Memory,
  ): Promise<{ episodesIngested: number; sessionsCreated: string[] }> {
    const convId = conv.sample_id
    const sessions = this.extractSessions(conv)
    const sessionsCreated: string[] = []
    let episodesIngested = 0

    for (const session of sessions) {
      const sessionId = `locomo:${convId}:session-${session.segmentIndex}`
      sessionsCreated.push(sessionId)

      for (const turn of session.turns) {
        if (!turn.text || turn.text.trim().length === 0) continue

        // Map speaker name to role
        const role: 'user' | 'assistant' = turn.speaker === session.speakerB ? 'assistant' : 'user'

        await memory.ingest({
          role,
          content: turn.text.trim(),
          sessionId,
          metadata: {
            locomoConvId: convId,
            locomoDiaId: turn.dia_id, // e.g. "D1:3" — the evidence ID directly
            locomoSegmentIndex: session.segmentIndex,
            locomoSpeaker: turn.speaker,
            locomoDate: session.dateTime,
          },
        })

        episodesIngested++
      }
    }

    return { episodesIngested, sessionsCreated }
  }

  async ingestDataset(
    conversations: LoCoMoConversationFile[],
    memory: Memory,
    opts?: Pick<BenchmarkOpts, 'consolidate'>,
  ): Promise<{ totalEpisodes: number; totalSessions: number }> {
    let totalEpisodes = 0
    let totalSessions = 0

    for (const conv of conversations) {
      const { episodesIngested, sessionsCreated } = await this.ingestConversation(conv, memory)
      totalEpisodes += episodesIngested
      totalSessions += sessionsCreated.length

      if (opts?.consolidate !== false) {
        await memory.consolidate('light')
      }
    }

    if (opts?.consolidate !== false) {
      await memory.consolidate('deep')
      await memory.consolidate('dream')
      await memory.consolidate('decay')
    }

    return { totalEpisodes, totalSessions }
  }

  /**
   * Evaluate all QA pairs. Evidence matching uses dia_id from metadata.
   * LoCoMo evidence format: "D1:3" — already stored as locomoDiaId.
   */
  async evaluateDataset(
    conversations: LoCoMoConversationFile[],
    memory: Memory,
    opts?: Pick<BenchmarkOpts, 'topK'>,
  ): Promise<LoCoMoConversationResult[]> {
    const topK = opts?.topK ?? 10
    const convResults: LoCoMoConversationResult[] = []

    for (const conv of conversations) {
      const convId = conv.sample_id
      const qaPredictions: LoCoMoQAPrediction[] = []

      for (const qa of conv.qa) {
        const recallResult = await memory.recall(qa.question)
        const topMemories = recallResult.memories.slice(0, topK)

        const prediction = topMemories
          .map(m => m.content)
          .filter(c => c && c.trim().length > 0)
          .join(' ')
          .slice(0, 2000)

        const goldAnswer = String(qa.answer)
        const retrievalF1 = computeRetrievalF1(prediction, goldAnswer)

        // Build set of recalled evidence IDs from metadata
        const recalledEvidenceIds = new Set<string>()
        for (const mem of topMemories) {
          const locomoConvId = mem.metadata?.locomoConvId as string | undefined
          const diaId = mem.metadata?.locomoDiaId as string | undefined
          if (locomoConvId === convId && diaId) {
            recalledEvidenceIds.add(diaId)
          }
        }

        const recallAtK = qa.evidence.some(eid => recalledEvidenceIds.has(eid))

        qaPredictions.push({
          qaId: `${convId}:${qa.question.slice(0, 30)}`,
          question: qa.question,
          goldAnswer,
          prediction,
          retrievalF1,
          recallAtK,
          category: qa.category as 1 | 2 | 3 | 4 | 5,
        })
      }

      convResults.push({
        conversationId: convId,
        qaPredictions,
        episodesIngested: 0, // populated by caller
        sessionsCreated: 0,
      })
    }

    return convResults
  }

  /**
   * Evaluate a single conversation in isolation: fresh memory instance,
   * ingest its turns, optionally consolidate, then evaluate its QA pairs.
   * This prevents cross-conversation noise pollution.
   */
  async runConversation(
    conv: LoCoMoConversationFile,
    opts?: BenchmarkOpts,
  ): Promise<{ result: LoCoMoConversationResult; ingestMs: number; evalMs: number }> {
    const memory = await createBenchMemory(opts)

    const ingestStart = Date.now()
    const { episodesIngested, sessionsCreated } = await this.ingestConversation(conv, memory)

    if (opts?.consolidate !== false) {
      await memory.consolidate('light')
      await memory.consolidate('deep')
    }
    const ingestMs = Date.now() - ingestStart

    const evalStart = Date.now()
    const [convResult] = await this.evaluateDataset([conv], memory, opts)
    const evalMs = Date.now() - evalStart

    // Fill in ingestion stats
    convResult!.episodesIngested = episodesIngested
    convResult!.sessionsCreated = sessionsCreated.length

    await memory.dispose()
    return { result: convResult!, ingestMs, evalMs }
  }

  async run(dataPath: string, opts?: BenchmarkOpts): Promise<LoCoMoResult> {
    const allConversations = await this.loadDataset(dataPath)
    const conversations = opts?.limit
      ? allConversations.slice(0, opts.limit)
      : allConversations

    console.log(`LoCoMo: ${conversations.length} conversations loaded${opts?.limit ? ` (limited from ${allConversations.length})` : ''}`)

    // Per-conversation isolation: each conversation gets its own memory
    // instance so cross-conversation noise doesn't pollute retrieval.
    const convResults: LoCoMoConversationResult[] = []
    let totalIngestMs = 0
    let totalEvalMs = 0

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i]!
      console.log(`LoCoMo: [${i + 1}/${conversations.length}] ${conv.sample_id} — ingesting...`)

      const { result, ingestMs, evalMs } = await this.runConversation(conv, opts)
      convResults.push(result)
      totalIngestMs += ingestMs
      totalEvalMs += evalMs

      const hits = result.qaPredictions.filter(p => p.recallAtK).length
      console.log(`LoCoMo: [${i + 1}/${conversations.length}] ${conv.sample_id} — ${result.qaPredictions.length} QAs, ${hits} hits, ingest ${ingestMs}ms, eval ${evalMs}ms`)
    }

    const ingestTimeMs = totalIngestMs
    const evalTimeMs = totalEvalMs

    const allPredictions = convResults.flatMap(c => c.qaPredictions)
    const totalQueries = allPredictions.length

    const averageRetrievalF1 =
      allPredictions.length > 0
        ? allPredictions.reduce((sum, p) => sum + p.retrievalF1, 0) / allPredictions.length
        : 0

    const overallRecallAtK =
      allPredictions.length > 0
        ? allPredictions.filter(p => p.recallAtK).length / allPredictions.length
        : 0

    const categoryMap = new Map<number, LoCoMoQAPrediction[]>()
    for (const p of allPredictions) {
      const bucket = categoryMap.get(p.category) ?? []
      bucket.push(p)
      categoryMap.set(p.category, bucket)
    }

    const byCategory: LoCoMoCategoryMetrics[] = []
    for (const [cat, preds] of categoryMap) {
      byCategory.push({
        category: cat as 1 | 2 | 3 | 4 | 5,
        totalQuestions: preds.length,
        averageRetrievalF1: preds.reduce((s, p) => s + p.retrievalF1, 0) / preds.length,
        recallAtK: preds.filter(p => p.recallAtK).length / preds.length,
      })
    }
    byCategory.sort((a, b) => a.category - b.category)

    const evalFormat: LoCoMoEvalFormat[] = convResults.map(cr => ({
      sample_id: cr.conversationId,
      qa: cr.qaPredictions.map(p => ({
        prediction: p.prediction,
        retrieval_f1: p.retrievalF1,
      })),
    }))

    const totalTokensRecalled = allPredictions.reduce(
      (sum, p) => sum + Math.ceil(p.prediction.length / 4),
      0,
    )

    return {
      benchmark: 'locomo',
      conversations: convResults,
      overall: { averageRetrievalF1, recallAtK: overallRecallAtK, byCategory },
      metrics: { totalQueries, ingestTimeMs, evalTimeMs, totalTokensRecalled },
      evalFormat,
    }
  }
}
