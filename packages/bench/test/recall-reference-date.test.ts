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
const { latestSessionDate, parseLoCoMoDateTime } = await import('../src/locomo/session-date.js')

function stubMemory() {
  return {
    recall: vi.fn().mockResolvedValue({
      memories: [{ id: 'm1', type: 'episode', content: 'the planters are on the balcony', relevance: 0.9, metadata: { lmeSessionId: 's1' } }],
      associations: [],
      formatted: '',
    }),
    ingestBatch: vi.fn().mockResolvedValue(undefined),
    flushPendingWrites: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
}

function lmeQuestion(questionDate: string): LongMemEvalQuestion {
  return {
    question_id: 'q-planters', question_type: 'temporal-reasoning', question: 'where did I put the planters last week?',
    question_date: questionDate, answer: 'balcony', answer_session_ids: ['s1'],
    haystack_dates: ['2023/05/20 (Sat) 02:21'], haystack_session_ids: ['s1'],
    haystack_sessions: [[{ role: 'user', content: 'I moved the planters to the balcony' }]],
  }
}

const LOCOMO_CONV = {
  sample_id: 'conv-3',
  conversation: {
    speaker_a: 'Ana',
    speaker_b: 'Ben',
    session_1: [],
    session_1_date_time: '1:56 pm on 8 May, 2023',
    session_3: [],
    session_3_date_time: '10:37 am on 27 June 2023',
    session_2: [],
    session_2_date_time: '7:55 pm on 9 June, 2023',
  },
  qa: [{ question: 'When did Ana move the planters?', answer: 'June', evidence: [], category: 2 }],
} as unknown as LoCoMoConversationFile

describe('bench recall sites pass the reference date of their data', () => {
  beforeEach(() => createBenchMemory.mockReset())

  it('LongMemEval runQuestion passes the parsed question date', async () => {
    const memory = stubMemory()
    createBenchMemory.mockResolvedValue({ memory, config: {} })
    await new LongMemEvalAdapter().runQuestion(lmeQuestion('2023/05/30 (Tue) 23:40'))
    expect(memory.recall).toHaveBeenCalledWith('where did I put the planters last week?', {
      now: new Date('2023-05-30T23:40:00Z'),
    })
  })

  it('LongMemEval runQuestion recalls undated when the question date does not parse', async () => {
    const memory = stubMemory()
    createBenchMemory.mockResolvedValue({ memory, config: {} })
    await new LongMemEvalAdapter().runQuestion(lmeQuestion('sometime in May'))
    expect(memory.recall).toHaveBeenCalledWith('where did I put the planters last week?', {})
  })

  it('the LoCoMo adapter passes the latest session date, not the last session key', async () => {
    const memory = stubMemory()
    await new LoCoMoAdapter().evaluateDataset([LOCOMO_CONV], memory as unknown as Memory)
    expect(memory.recall).toHaveBeenCalledWith('When did Ana move the planters?', {
      now: new Date(2023, 5, 27, 10, 37, 0),
    })
  })

  it('the LoCoMo judge recalls with the date it is given', async () => {
    const memory = stubMemory()
    const now = new Date(2023, 5, 27, 10, 37, 0)
    await retrieveContext(memory, 'When did Ana move the planters?', now)
    expect(memory.recall).toHaveBeenCalledWith('When did Ana move the planters?', { now })
    await retrieveContext(memory, 'When did Ana move the planters?')
    expect(memory.recall).toHaveBeenLastCalledWith('When did Ana move the planters?', {})
  })

  it('latestSessionDate picks the latest parseable session time', () => {
    expect(latestSessionDate(LOCOMO_CONV)).toEqual(new Date(2023, 5, 27, 10, 37, 0))
    const undated = { ...LOCOMO_CONV, conversation: { session_1: [], session_1_date_time: 'unknown' } } as unknown as LoCoMoConversationFile
    expect(latestSessionDate(undated)).toBeNull()
  })

  it('parseLoCoMoDateTime reads 12-hour times with and without the comma', () => {
    expect(parseLoCoMoDateTime('12:05 am on 1 January, 2024')).toEqual(new Date(2024, 0, 1, 0, 5, 0))
    expect(parseLoCoMoDateTime('12:30 pm on 2 March 2024')).toEqual(new Date(2024, 2, 2, 12, 30, 0))
    expect(parseLoCoMoDateTime('noon on 2 March 2024')).toBeNull()
  })
})
