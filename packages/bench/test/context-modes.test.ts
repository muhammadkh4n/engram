import { describe, it, expect } from 'vitest'
import { estimateTokens } from '@engram-mem/core'
import {
  goldIdsInPayload,
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
const ITEM_LINES = {
  m1: '- [episode · user · 2023-05-20] I moved the herb planters to the balcony last weekend.',
  m2: `- [episode · assistant · 2023-05-20] Noted for lme:${QID}:sess_b — basil needs six hours of sun.`,
  r1: '- [digest · 2023-05-21] Gardening: balcony planters, basil, watering schedule.',
  f1: '- [episode · user · 2023-04-02] The hardware store had terracotta pots on sale.',
}

const PAYLOAD = [
  '## Engram — Recalled Conversation Memory',
  '',
  'IMPORTANT: The following are memories retrieved from past conversations.',
  '',
  '### Recalled Memories\n',
  ITEM_LINES.m1,
  ITEM_LINES.m2,
  '\n### Related Memories\n',
  ITEM_LINES.r1,
  '\n### Faint Associations\n',
  ITEM_LINES.f1,
].join('\n')

// Offsets of each item line in the raw payload, as Memory.recall reports them.
function rawItem(section: string, id: keyof typeof ITEM_LINES): { section: string; id: string; start: number; end: number } {
  const start = PAYLOAD.indexOf(ITEM_LINES[id])
  return { section, id, start, end: start + ITEM_LINES[id].length }
}

const PAYLOAD_ITEMS = [rawItem('recalled', 'm1'), rawItem('recalled', 'm2'), rawItem('related', 'r1'), rawItem('faint', 'f1')]

function stubResult(overrides: Partial<SweepRecallResult> = {}): SweepRecallResult {
  return {
    memories: [
      { id: 'm1', relevance: 0.912345, metadata: { lmeSessionId: 'sess_a' } },
      { id: 'm2', relevance: 0.5, metadata: { lmeSessionId: 'sess_b' } },
      { id: 'm3', relevance: 0.03333333, metadata: { lmeSessionId: 'sess_a' } },
    ],
    formatted: PAYLOAD,
    synthesis: null,
    estimatedTokens: 97,
    payload: { truncated: false, items: PAYLOAD_ITEMS },
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

describe('goldIdsInPayload', () => {
  it('finds gold ids among the emitted items of every section, in gold order', () => {
    const items = [{ session: 'sess_a' }, { session: null }, { session: 'sess_c' }, { session: 'sess_d' }]
    expect(goldIdsInPayload(items, ['sess_d', 'sess_x', 'sess_c', 'sess_a'])).toEqual(['sess_d', 'sess_c', 'sess_a'])
  })

  it('ignores repeated gold ids and an empty payload', () => {
    expect(goldIdsInPayload([{ session: 'sess_a' }, { session: 'sess_a' }], ['sess_a', 'sess_a', 'sess_b'])).toEqual(['sess_a'])
    expect(goldIdsInPayload([], ['sess_a'])).toEqual([])
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

  it('passes the reference date when given, as the server passes the request time', () => {
    const now = new Date('2023-05-27T14:05:00Z')
    expect(productionRecallOptions('engram', now)).toEqual({ projectId: 'engram', now })
    expect(productionRecallOptions(undefined, now)).toEqual({ now })
    expect(productionRecallOptions(undefined, null)).toEqual({})
  })
})

describe('sweepRecallOptions', () => {
  it('sessions mode keeps the widened result cap', () => {
    expect(sweepRecallOptions({ contextMode: 'sessions', maxK: 30, synthesize: false })).toEqual({
      strategyOverride: { maxResults: 30 },
    })
  })

  it('sessions mode passes the question date with synthesize off', () => {
    const now = new Date('2023-05-30T00:00:00Z')
    expect(sweepRecallOptions({ contextMode: 'sessions', maxK: 30, synthesize: false, now })).toEqual({
      strategyOverride: { maxResults: 30 },
      now,
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
    const now = new Date('2023-05-27T14:05:00Z')
    expect(sweepRecallOptions({ contextMode: 'formatted', maxK: 30, synthesize: false, now })).toEqual({ now })
    expect(sweepRecallOptions({ contextMode: 'formatted', maxK: 30, synthesize: false, now: null })).toEqual({})
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

  it('counts characters of the stored string and the emitted recalled items', async () => {
    const out = await runSweepRecall(stubMemory(stubResult()), QUESTION, { contextMode: 'formatted', maxK: 30, synthesize: false })
    const stored = out.formattedFields!.formatted
    expect(out.formattedFields?.context_chars).toBe(stored.length)
    expect(out.formattedFields?.context_chars).toBe(PAYLOAD.length - `lme:${QID}:`.length)
    // m3 was recalled but no item renders it, so the reader never sees it.
    expect(out.formattedFields?.context_items).toBe(2)
  })

  it('counts a gold id reached only through a faint association and leaves the payload untouched', async () => {
    const result = stubResult({
      memories: [{ id: 'm1', metadata: { lmeSessionId: 'sess_a' } }],
      associations: [{ id: 'r1', metadata: { lmeSessionId: 'sess_c' } }],
      faintAssociations: [{ id: 'f1', metadata: { lmeSessionId: 'sess_z' } }],
    })
    const out = await runSweepRecall(stubMemory(result), QUESTION, { contextMode: 'formatted', maxK: 30, synthesize: false })
    expect(out.formattedFields?.gold_ids_in_context).toEqual(['sess_z'])
    expect(out.formattedFields?.formatted).toBe(PAYLOAD.split(`lme:${QID}:`).join(''))
  })

  it('leaves out a gold session whose memory was recalled but not emitted', async () => {
    const result = stubResult({
      memories: [
        { id: 'm1', metadata: { lmeSessionId: 'sess_a' } },
        { id: 'm9', metadata: { lmeSessionId: 'sess_z' } },
      ],
      payload: { truncated: true, items: [rawItem('recalled', 'm1')] },
    })
    const out = await runSweepRecall(stubMemory(result), QUESTION, { contextMode: 'formatted', maxK: 30, synthesize: false })
    expect(out.formattedFields?.gold_ids_in_context).toEqual([])
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
      stubMemory(stubResult({ memories: [], formatted: '', estimatedTokens: 0, payload: { truncated: false, items: [] } })),
      QUESTION,
      { contextMode: 'formatted', maxK: 30, synthesize: false },
    )
    expect(out.formattedFields).toEqual({
      formatted: '',
      context_chars: 0,
      context_items: 0,
      gold_ids_in_context: [],
      payload_items: [],
      context_tokens: 0,
      truncated: false,
    })
    expect(out.recalledSessionIds).toEqual([])
  })
})

describe('runSweepRecall — formatted mode payload items', () => {
  const FORMATTED = { contextMode: 'formatted', maxK: 30, synthesize: false } as const
  const withLinks = (): SweepRecallResult =>
    stubResult({
      associations: [{ id: 'r1', metadata: { lmeSessionId: 'sess_c' } }],
      faintAssociations: [{ id: 'f1', metadata: { lmeSessionId: 'sess_z' } }],
      estimatedTokens: 123,
      payload: { truncated: true, items: PAYLOAD_ITEMS },
    })

  it('records section, offsets and dataset session per item, the stored-text token estimate and the truncation flag', async () => {
    const out = await runSweepRecall(stubMemory(withLinks()), QUESTION, FORMATTED)
    const fields = out.formattedFields!
    expect(fields.payload_items.map(({ section, session }) => ({ section, session }))).toEqual([
      { section: 'recalled', session: 'sess_a' },
      { section: 'recalled', session: 'sess_b' },
      { section: 'related', session: 'sess_c' },
      { section: 'faint', session: 'sess_z' },
    ])
    // Measured on the namespace-stripped text the judge reads, not core's raw estimate.
    expect(fields.context_tokens).toBe(estimateTokens(fields.formatted))
    expect(fields.context_tokens).not.toBe(estimateTokens(PAYLOAD))
    expect(fields.truncated).toBe(true)
  })

  it('keeps formatted.slice(start, end) equal to each item line after the namespace rewrite', async () => {
    const out = await runSweepRecall(stubMemory(withLinks()), QUESTION, FORMATTED)
    const { formatted, payload_items } = out.formattedFields!
    const expected = [ITEM_LINES.m1, ITEM_LINES.m2, ITEM_LINES.r1, ITEM_LINES.f1].map((l) => l.split(`lme:${QID}:`).join(''))
    expect(payload_items.map((it) => formatted.slice(it.start, it.end))).toEqual(expected)
    // The rewrite shortens the second line, so every later item moved left.
    expect(payload_items[2]!.start).toBe(PAYLOAD_ITEMS[2]!.start - `lme:${QID}:`.length)
  })

  it('records a null session for an item without a memory id or without a dataset session', async () => {
    const result = stubResult({
      memories: [{ id: 'm1' }],
      payload: { truncated: false, items: [{ section: 'context', start: 0, end: 2 }, rawItem('recalled', 'm1')] },
    })
    const out = await runSweepRecall(stubMemory(result), QUESTION, FORMATTED)
    expect(out.formattedFields!.payload_items.map((it) => it.session)).toEqual([null, null])
  })

  it('records truncated false when the budget did not stop assembly', async () => {
    const out = await runSweepRecall(stubMemory(stubResult()), QUESTION, FORMATTED)
    expect(out.formattedFields!.truncated).toBe(false)
    expect(out.formattedFields!.context_tokens).toBe(estimateTokens(out.formattedFields!.formatted))
  })

  it('refuses a recall result without payload items', async () => {
    const { payload: _p, ...noPayload } = stubResult()
    await expect(runSweepRecall(stubMemory(noPayload), QUESTION, FORMATTED)).rejects.toThrow(/no "payload"/)
  })

  it('refuses an item offset outside the payload', async () => {
    const result = stubResult({ payload: { truncated: false, items: [{ section: 'recalled', id: 'm1', start: 5, end: PAYLOAD.length + 1 }] } })
    await expect(runSweepRecall(stubMemory(result), QUESTION, FORMATTED)).rejects.toThrow(/outside the/)
  })

  it('needs no payload in sessions mode', async () => {
    const { payload: _p, estimatedTokens: _t, ...bare } = stubResult()
    const out = await runSweepRecall(stubMemory(bare), QUESTION, { contextMode: 'sessions', maxK: 30, synthesize: false })
    expect(out.formattedFields).toBeUndefined()
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
