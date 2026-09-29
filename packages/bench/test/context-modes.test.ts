import { describe, it, expect } from 'vitest'
import {
  parseContextMode,
  productionRecallOptions,
  runSweepRecall,
  sweepRecallOptions,
  type SweepMemory,
  type SweepRecallResult,
} from '../src/longmemeval/forensics/context-modes.js'
import { buildSynthesisField } from '../src/longmemeval/forensics/synthesis-row.js'

const QID = 'q-7a1'

// Shaped like a formatter payload: header, tagged memory lines, a Related
// section and a Faint Associations section. One line quotes the bench's
// namespaced session id so the rewrite is observable.
const PAYLOAD = [
  '## Engram — Recalled Conversation Memory',
  '',
  'IMPORTANT: The following are memories retrieved from past conversations.',
  '',
  '### Recalled Memories\n',
  '- [episode · user · 2023-05-20] I moved the herb planters to the balcony last weekend.',
  `- [episode · assistant · 2023-05-20] Noted for lme:${QID}:sess_b — basil needs six hours of sun.`,
  '\n### Related Memories\n',
  '- [digest · 2023-05-21] Gardening: balcony planters, basil, watering schedule.',
  '\n### Faint Associations\n',
  '- [episode · user · 2023-04-02] The hardware store had terracotta pots on sale.',
].join('\n')

function stubResult(overrides: Partial<SweepRecallResult> = {}): SweepRecallResult {
  return {
    memories: [
      { id: 'm1', metadata: { lmeSessionId: 'sess_a' } },
      { id: 'm2', metadata: { lmeSessionId: 'sess_b' } },
      { id: 'm3', metadata: { lmeSessionId: 'sess_a' } },
    ],
    formatted: PAYLOAD,
    synthesis: null,
    ...overrides,
  }
}

function stubMemory(result: SweepRecallResult): SweepMemory & { calls: Array<{ query: string; opts: Record<string, unknown> }> } {
  const calls: Array<{ query: string; opts: Record<string, unknown> }> = []
  return {
    calls,
    async recall(query, opts) {
      calls.push({ query, opts })
      return result
    },
  }
}

const QUESTION = { question_id: QID, question: 'Where did I move the herb planters?' }

describe('parseContextMode', () => {
  it('defaults to sessions', () => {
    expect(parseContextMode(['--limit', '5'])).toBe('sessions')
  })

  it('accepts sessions and formatted', () => {
    expect(parseContextMode(['--context-mode', 'sessions'])).toBe('sessions')
    expect(parseContextMode(['--context-mode', 'formatted'])).toBe('formatted')
  })

  it('rejects an unknown or missing value', () => {
    expect(() => parseContextMode(['--context-mode', 'raw'])).toThrow(/sessions" or "formatted/)
    expect(() => parseContextMode(['--context-mode'])).toThrow(/needs a value/)
    expect(() => parseContextMode(['--context-mode', '--synthesize'])).toThrow(/needs a value/)
  })

  it('rejects --synthesize with formatted', () => {
    expect(() => parseContextMode(['--context-mode', 'formatted', '--synthesize'])).toThrow(/--synthesize cannot be combined/)
    expect(() => parseContextMode(['--synthesize', '--context-mode', 'formatted'])).toThrow(/--synthesize cannot be combined/)
  })

  it('keeps --synthesize legal in sessions mode', () => {
    expect(parseContextMode(['--synthesize'])).toBe('sessions')
    expect(parseContextMode(['--synthesize', '--context-mode', 'sessions'])).toBe('sessions')
  })
})

describe('productionRecallOptions', () => {
  it('passes nothing when no project is given — no result cap, budget or synthesis override', () => {
    expect(productionRecallOptions()).toEqual({})
  })

  it('passes projectId only when given', () => {
    expect(productionRecallOptions('engram')).toEqual({ projectId: 'engram' })
    expect(productionRecallOptions('')).toEqual({})
  })
})

describe('sweepRecallOptions', () => {
  it('sessions mode keeps the widened result cap', () => {
    expect(sweepRecallOptions({ contextMode: 'sessions', maxK: 30, synthesize: false })).toEqual({
      strategyOverride: { maxResults: 30 },
    })
  })

  it('sessions mode with synthesis keeps the evidence cap and the question-date anchor', () => {
    const now = new Date('2023-05-30T00:00:00Z')
    expect(sweepRecallOptions({ contextMode: 'sessions', maxK: 30, synthesize: true, now })).toEqual({
      strategyOverride: { maxResults: 30 },
      synthesize: { maxEvidenceSessions: 5, includeComputeNotes: true },
      now,
    })
    expect(sweepRecallOptions({ contextMode: 'sessions', maxK: 30, synthesize: true, now: null })).toEqual({
      strategyOverride: { maxResults: 30 },
      synthesize: { maxEvidenceSessions: 5, includeComputeNotes: true },
    })
  })

  it('formatted mode uses the production options and ignores maxK', () => {
    expect(sweepRecallOptions({ contextMode: 'formatted', maxK: 30, synthesize: false })).toEqual({})
  })
})

describe('runSweepRecall — formatted mode', () => {
  it('calls recall with the production options and stores the payload with only the namespace rewritten', async () => {
    const memory = stubMemory(stubResult())
    const out = await runSweepRecall(memory, QUESTION, { contextMode: 'formatted', maxK: 30, synthesize: false })

    expect(memory.calls).toEqual([{ query: QUESTION.question, opts: {} }])
    const expected = PAYLOAD.split(`lme:${QID}:`).join('')
    expect(out.formattedFields?.formatted).toBe(expected)
    expect(out.formattedFields?.formatted).toContain('### Related Memories')
    expect(out.formattedFields?.formatted).toContain('### Faint Associations')
    expect(out.formattedFields?.formatted).toContain('Noted for sess_b')
    expect(out.formattedFields?.formatted).not.toContain(`lme:${QID}:`)
  })

  it('counts characters of the stored string and items from result.memories', async () => {
    const out = await runSweepRecall(stubMemory(stubResult()), QUESTION, { contextMode: 'formatted', maxK: 30, synthesize: false })
    const stored = out.formattedFields!.formatted
    expect(out.formattedFields?.context_chars).toBe(stored.length)
    expect(out.formattedFields?.context_chars).toBe(PAYLOAD.length - `lme:${QID}:`.length)
    expect(out.formattedFields?.context_items).toBe(3)
  })

  it('projects session ids exactly as sessions mode does', async () => {
    const out = await runSweepRecall(stubMemory(stubResult()), QUESTION, { contextMode: 'formatted', maxK: 30, synthesize: false })
    expect(out.recalledSessionIds).toEqual(['sess_a', 'sess_b'])
    expect('synthesisRow' in out).toBe(false)
  })

  it('records an empty payload as-is', async () => {
    const out = await runSweepRecall(
      stubMemory(stubResult({ memories: [], formatted: '' })),
      QUESTION,
      { contextMode: 'formatted', maxK: 30, synthesize: false },
    )
    expect(out.formattedFields).toEqual({ formatted: '', context_chars: 0, context_items: 0 })
    expect(out.recalledSessionIds).toEqual([])
  })
})

describe('runSweepRecall — sessions mode keeps the row shape', () => {
  const baseRow = (recalled: string[]) => ({
    question_id: QID,
    question_type: 'single-session-user',
    question: QUESTION.question,
    gold_session_ids: ['sess_b'],
    retrieved_session_ids: recalled,
    retrieved_count: recalled.length,
    episodes_ingested: 12,
    ingest_ms: 10,
    eval_ms: 20,
    recall_at_k: { 5: recalled.includes('sess_b') },
  })

  it('adds no formatted fields and no synthesis key without --synthesize', async () => {
    const memory = stubMemory(stubResult())
    const out = await runSweepRecall(memory, QUESTION, { contextMode: 'sessions', maxK: 30, synthesize: false })

    expect(memory.calls[0]!.opts).toEqual({ strategyOverride: { maxResults: 30 } })
    expect(out).toEqual({ recalledSessionIds: ['sess_a', 'sess_b'] })

    const row = {
      ...baseRow(out.recalledSessionIds),
      ...buildSynthesisField(false, out.synthesisRow),
      ...(out.formattedFields ?? {}),
    }
    expect(Object.keys(row)).toEqual(Object.keys(baseRow([])))
    expect(row).toEqual(baseRow(['sess_a', 'sess_b']))
  })

  it('records the synthesis block with the namespace rewritten under --synthesize', async () => {
    const memory = stubMemory(stubResult({
      synthesis: { intent: 'temporal-reasoning', method: 'timeline', text: `Per session lme:${QID}:sess_b, the planters moved on 2023-05-20.` },
    }))
    const out = await runSweepRecall(memory, QUESTION, { contextMode: 'sessions', maxK: 30, synthesize: true })
    expect(out.synthesisRow).toEqual({
      intent: 'temporal-reasoning',
      method: 'timeline',
      text: 'Per session sess_b, the planters moved on 2023-05-20.',
    })
    expect(out.formattedFields).toBeUndefined()
  })

  it('records synthesis null when recall produced no block under --synthesize', async () => {
    const out = await runSweepRecall(stubMemory(stubResult()), QUESTION, { contextMode: 'sessions', maxK: 30, synthesize: true })
    expect(out.synthesisRow).toBeNull()
  })
})
