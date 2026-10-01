import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Memory } from '@engram-mem/core'
import type { LongMemEvalQuestion } from '../src/longmemeval/types.js'
import type { LoCoMoConversationFile } from '../src/locomo/types.js'

const createBenchMemory = vi.fn()
vi.mock('../src/memory-factory.js', () => ({
  createBenchMemory: (...args: unknown[]) => createBenchMemory(...args),
}))

const { LongMemEvalAdapter } = await import('../src/longmemeval/adapter.js')
const { LoCoMoAdapter } = await import('../src/locomo/adapter.js')
const { retrieveContext } = await import('../src/locomo/judge-adapter.js')
const { runSweepRecall } = await import('../src/longmemeval/forensics/context-modes.js')
const { DegradedRecallError } = await import('../src/refuse-degraded.js')

const REASON = '429 insufficient_quota: You exceeded your current quota'

function recallResult(degraded: boolean) {
  return {
    memories: [
      { id: 'm1', type: 'episode', content: 'the blue notebook is in the attic', relevance: 0.9, metadata: { lmeSessionId: 's1' } },
    ],
    associations: [],
    formatted: '',
    ...(degraded ? { degraded: { vector: REASON } } : {}),
  }
}

function stubMemory(degraded: boolean) {
  return {
    recall: vi.fn().mockResolvedValue(recallResult(degraded)),
    ingestBatch: vi.fn().mockResolvedValue(undefined),
    flushPendingWrites: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
}

const LME_QUESTION: LongMemEvalQuestion = {
  question_id: 'q-attic', question_type: 'single-session-user', question: 'where is the blue notebook?',
  question_date: '2023/05/30 (Tue) 23:40', answer: 'attic', answer_session_ids: ['s1'],
  haystack_dates: ['2023/05/20 (Sat) 02:21'], haystack_session_ids: ['s1'],
  haystack_sessions: [[{ role: 'user', content: 'I put the blue notebook in the attic' }]],
}

const LOCOMO_CONV = {
  sample_id: 'conv-7',
  conversation: {},
  qa: [{ question: 'Where is the blue notebook?', answer: 'attic', evidence: [], category: 1 }],
} as unknown as LoCoMoConversationFile

describe('bench adapters refuse a degraded recall', () => {
  beforeEach(() => createBenchMemory.mockReset())

  it('LongMemEval names the question and does not score it', async () => {
    const memory = stubMemory(true)
    createBenchMemory.mockResolvedValue({ memory, config: {} })
    const run = new LongMemEvalAdapter().runQuestion(LME_QUESTION)
    await expect(run).rejects.toBeInstanceOf(DegradedRecallError)
    await expect(new LongMemEvalAdapter().runQuestion(LME_QUESTION)).rejects.toThrow(/q-attic.*insufficient_quota/)
    expect(memory.dispose).toHaveBeenCalled()
  })

  it('LongMemEval scores a healthy recall', async () => {
    createBenchMemory.mockResolvedValue({ memory: stubMemory(false), config: {} })
    const out = await new LongMemEvalAdapter().runQuestion(LME_QUESTION)
    expect(out.prediction.recallAt5).toBe(true)
  })

  it('LoCoMo names the conversation and question', async () => {
    const memory = stubMemory(true) as unknown as Memory
    await expect(new LoCoMoAdapter().evaluateDataset([LOCOMO_CONV], memory))
      .rejects.toThrow(/conv-7: Where is the blue notebook\?.*insufficient_quota/)
    const healthy = stubMemory(false) as unknown as Memory
    await expect(new LoCoMoAdapter().evaluateDataset([LOCOMO_CONV], healthy)).resolves.toHaveLength(1)
  })

  it('the LoCoMo judge never builds an answer context from a degraded recall', async () => {
    await expect(retrieveContext(stubMemory(true), 'Where is the blue notebook?'))
      .rejects.toThrow(/Where is the blue notebook\?.*insufficient_quota/)
    await expect(retrieveContext(stubMemory(false), 'Where is the blue notebook?'))
      .resolves.toContain('[Memory 1] the blue notebook is in the attic')
  })

  it('the LongMemEval recall sweep stops on a degraded recall', async () => {
    const cfg = { contextMode: 'sessions' as const, maxK: 30, synthesize: false }
    await expect(runSweepRecall(stubMemory(true), LME_QUESTION, cfg)).rejects.toThrow(/q-attic/)
    await expect(runSweepRecall(stubMemory(false), LME_QUESTION, cfg)).resolves.toMatchObject({ recalledSessionIds: ['s1'] })
  })
})
