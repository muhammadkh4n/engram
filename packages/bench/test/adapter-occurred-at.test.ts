import { describe, it, expect } from 'vitest'
import { LongMemEvalAdapter } from '../src/longmemeval/adapter.js'
import type { Memory } from '@engram-mem/core'
import type { LongMemEvalQuestion } from '../src/longmemeval/types.js'

describe('ingestQuestion occurredAt convention', () => {
  it('stamps each turn with the haystack session date as metadata.occurredAt', async () => {
    const adapter = new LongMemEvalAdapter()
    const captured: Array<{ metadata?: Record<string, unknown> }> = []
    const memory = {
      ingestBatch: async (batch: Array<{ metadata?: Record<string, unknown> }>) => { captured.push(...batch) },
    } as unknown as Memory
    const question: LongMemEvalQuestion = {
      question_id: 'q1', question_type: 'temporal-reasoning', question: 'x',
      question_date: '2023/05/30 (Tue) 23:40', answer: 'y', answer_session_ids: ['s1'],
      haystack_dates: ['2023/05/20 (Sat) 02:21'], haystack_session_ids: ['s1'],
      haystack_sessions: [[{ role: 'user', content: 'hello world content' }]],
    }
    await adapter.ingestQuestion(question, memory)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.metadata!['occurredAt']).toBe('2023/05/20 (Sat) 02:21')
  })
})
