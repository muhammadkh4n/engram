import { describe, it, expect } from 'vitest'
import {
  goldIdsInContext,
  relevanceTop,
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
      { id: 'm1', relevance: 0.912345, metadata: { lmeSessionId: 'sess_a' } },
      { id: 'm2', relevance: 0.5, metadata: { lmeSessionId: 'sess_b' } },
      { id: 'm3', relevance: 0.03333333, metadata: { lmeSessionId: 'sess_a' } },
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

const QUESTION = {
  question_id: QID,
  question: 'Where did I move the herb planters?',
  answer_session_ids: ['sess_b', 'sess_z'],
}

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

  it('rejects --max-results with formatted', () => {
    expect(() => parseContextMode(['--context-mode', 'formatted', '--max-results', '30'])).toThrow(/--max-results cannot be combined/)
    expect(() => parseContextMode(['--max-results', '10', '--context-mode', 'formatted'])).toThrow(/--max-results cannot be combined/)
  })

  it('keeps --max-results legal in sessions mode', () => {
    expect(parseContextMode(['--max-results', '30'])).toBe('sessions')
    expect(parseContextMode(['--max-results', '30', '--context-mode', 'sessions'])).toBe('sessions')
  })
})

describe('goldIdsInContext', () => {
  it('finds gold ids across recalled, related and faint memories, in gold order', () => {
    const result = stubResult({
      memories: [{ id: 'm1', metadata: { lmeSessionId: 'sess_a' } }],
      associations: [{ metadata: { lmeSessionId: 'sess_c' } }],
      faintAssociations: [{ metadata: { lmeSessionId: 'sess_d' } }],
    })
    expect(goldIdsInContext(result, ['sess_d', 'sess_x', 'sess_c', 'sess_a'])).toEqual(['sess_d', 'sess_c', 'sess_a'])
  })

  it('ignores memories without a dataset session id and repeated gold ids', () => {
    const result = stubResult({
      memories: [{ id: 'm1' }, { id: 'm2', metadata: { lmeSessionId: 42 } }, { id: 'm3', metadata: { lmeSessionId: 'sess_a' } }],
      associations: [{ metadata: {} }],
    })
    expect(goldIdsInContext(result, ['sess_a', 'sess_a', 'sess_b'])).toEqual(['sess_a'])
  })

  it('treats absent association lists as empty', () => {
    expect(goldIdsInContext(stubResult({ memories: [] }), ['sess_a'])).toEqual([])
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

  it('counts a gold id reached only through a faint association and leaves the payload untouched', async () => {
    const result = stubResult({
      memories: [{ id: 'm1', metadata: { lmeSessionId: 'sess_a' } }],
      associations: [{ metadata: { lmeSessionId: 'sess_c' } }],
      faintAssociations: [{ metadata: { lmeSessionId: 'sess_z' } }],
    })
    const out = await runSweepRecall(stubMemory(result), QUESTION, { contextMode: 'formatted', maxK: 30, synthesize: false })
    expect(out.formattedFields?.gold_ids_in_context).toEqual(['sess_z'])
    expect(out.formattedFields?.formatted).toBe(PAYLOAD.split(`lme:${QID}:`).join(''))
    expect(out.formattedFields?.context_items).toBe(1)
  })

  it('counts gold ids among recalled memories', async () => {
    const out = await runSweepRecall(stubMemory(stubResult()), QUESTION, { contextMode: 'formatted', maxK: 30, synthesize: false })
    expect(out.formattedFields?.gold_ids_in_context).toEqual(['sess_b'])
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
    expect(out.formattedFields).toEqual({ formatted: '', context_chars: 0, context_items: 0, gold_ids_in_context: [] })
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
    expect(out).toEqual({ recalledSessionIds: ['sess_a', 'sess_b'], relevanceTop: [0.9123, 0.5, 0.0333] })

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

describe('relevanceTop', () => {
  it('records every recalled score in returned order, rounded to 4 decimals, in both modes', async () => {
    const result = stubResult({
      memories: [
        { id: 'm9', relevance: 0.123456789, metadata: { lmeSessionId: 'sess_c' } },
        { id: 'm1', relevance: 0.98765, metadata: { lmeSessionId: 'sess_a' } },
        { id: 'm4', relevance: 0.00004, metadata: { lmeSessionId: 'sess_b' } },
      ],
    })
    for (const contextMode of ['sessions', 'formatted'] as const) {
      const out = await runSweepRecall(stubMemory(result), QUESTION, { contextMode, maxK: 30, synthesize: false })
      expect(out.relevanceTop).toEqual([0.1235, 0.9877, 0])
    }
  })

  it('carries numbers only, never memory content or ids', () => {
    const scores = relevanceTop({
      memories: [
        { id: 'm1', relevance: 0.7, metadata: { lmeSessionId: 'sess_a', content: 'basil needs sun' } },
      ],
    })
    expect(scores).toEqual([0.7])
    expect(JSON.stringify(scores)).not.toMatch(/basil|m1|sess_a/)
  })

  it('keeps positions aligned with null for a missing or non-finite score', () => {
    expect(relevanceTop({
      memories: [
        { id: 'a', relevance: 0.25 },
        { id: 'b' },
        { id: 'c', relevance: Number.NaN },
        { id: 'd', relevance: 1 },
      ],
    })).toEqual([0.25, null, null, 1])
  })

  it('is empty when recall returns nothing', () => {
    expect(relevanceTop({ memories: [] })).toEqual([])
  })
})
