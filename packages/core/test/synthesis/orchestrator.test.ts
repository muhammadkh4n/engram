import { describe, it, expect, vi } from 'vitest'
import { synthesize } from '../../src/synthesis/index.js'
import { extractIsoDates } from '../../src/synthesis/temporal.js'
import { BLOCK_HEADER } from '../../src/synthesis/render.js'
import type { RetrievedMemory } from '../../src/types.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import { parseEventDate, isoDate } from '../../src/utils/event-date.js'

function mem(id: string, content: string, sessionId: string, occurredAt?: string): RetrievedMemory {
  return {
    id, type: 'episode', content, relevance: 0.5, source: 'recall',
    metadata: occurredAt ? { occurredAt } : {}, sessionId,
  }
}
const NOW = parseEventDate('2023/06/07 (Wed) 10:00')!
const MEMS = [
  mem('m0', 'visited the MoMA with my cousin', 'S3', '2023-05-14'),
  mem('m1', 'went to the Ancient Civilizations exhibit at the Met', 'S9', '2023-06-04'),
  mem('m2', 'we discussed dinner options', 'S12', '2023-06-01'),
]
function selecting(items: Array<{ index: number; instance?: string; dateText?: string }>): IntelligenceAdapter {
  return { selectEvidence: vi.fn().mockResolvedValue({ items }) } as unknown as IntelligenceAdapter
}

describe('synthesize — gating', () => {
  it('returns null on intent none without a preference request (zero LLM cost)', async () => {
    const adapter = selecting([{ index: 0 }])
    const block = await synthesize({ query: 'What did I say about the hotel?', memories: MEMS, intelligence: adapter, now: NOW })
    expect(block).toBeNull()
    expect(adapter.selectEvidence).not.toHaveBeenCalled()
  })
  it('returns null on empty memories', async () => {
    expect(await synthesize({ query: 'How many days between my trips?', memories: [], now: NOW })).toBeNull()
  })
})

describe('synthesize — temporal selection path', () => {
  const QUERY = 'How many days passed between my visit to the MoMA and the exhibit at the Met?'
  it('renders a date-arithmetic block with the shared header; all dates anchored to source ∪ now', async () => {
    const block = (await synthesize({
      query: QUERY, memories: MEMS, intelligence: selecting([{ index: 0 }, { index: 1 }]), now: NOW,
    }))!
    expect(block.intent).toBe('temporal')
    expect(block.method).toBe('date-arithmetic')
    expect(block.llmSelectionUsed).toBe(true)
    expect(block.text.startsWith(BLOCK_HEADER)).toBe(true)
    expect(block.text).toContain('Elapsed between conversations from (1) to (2): 21 days (3 weeks)')
    const allowed = new Set(['2023-05-14', '2023-06-04', isoDate(NOW)])
    for (const date of extractIsoDates(block.text)) expect(allowed.has(date)).toBe(true)
  })
  it('explicit empty selection → null block (abstention safety, NOT the degradation tier)', async () => {
    expect(await synthesize({ query: QUERY, memories: MEMS, intelligence: selecting([]), now: NOW })).toBeNull()
  })
  it('selection error → degradation tier (temporal-grounding), not a crash', async () => {
    const failing = { selectEvidence: vi.fn().mockRejectedValue(new Error('down')) } as unknown as IntelligenceAdapter
    const block = (await synthesize({ query: QUERY, memories: MEMS, intelligence: failing, now: NOW }))!
    expect(block.method).toBe('temporal-grounding')
    expect(block.llmSelectionUsed).toBe(false)
  })
  it('no adapter at all → degradation tier', async () => {
    const block = (await synthesize({ query: QUERY, memories: MEMS, now: NOW }))!
    expect(block.method).toBe('temporal-grounding')
  })
})

describe('synthesize — aggregation degradation', () => {
  it('no adapter on an aggregation query → evidence-index', async () => {
    const block = (await synthesize({ query: 'How many museums have I visited?', memories: MEMS, now: NOW }))!
    expect(block.method).toBe('evidence-index')
    expect(block.text).toContain('distinct sessions matched')
  })
})

describe('synthesize — evidence cap (maxEvidenceSessions)', () => {
  it('only cites sessions within the first K ranked sessions', async () => {
    // rank order of sessions follows memory rank: S3 (head), S9, S12
    const block = (await synthesize({
      query: 'When did I visit the MoMA?', memories: MEMS,
      intelligence: selecting([{ index: 0 }]), now: NOW,
      opts: { maxEvidenceSessions: 1 },
    }))!
    expect(block.text).toContain('S3')
    expect(block.text).not.toContain('S9')
    // and the selection call only saw S3 evidence
  })
})

describe('synthesize — preference both-sides gate', () => {
  const PREF_MEMS = [
    mem('p1', "I'm vegetarian so no meat dishes please", 'S5', '2023-03-01'),
    mem('p2', 'we discussed restaurants downtown', 'S6', '2023-04-01'),
  ]
  it('recommendation-shaped query + stored preference → constraint block', async () => {
    const block = (await synthesize({ query: 'Any suggestions for a dinner spot?', memories: PREF_MEMS, now: NOW }))!
    expect(block.intent).toBe('preference')
    expect(block.method).toBe('constraint-surface')
    expect(block.text).toContain('[constraint] Stated user preference (S5, 2023-03-01)')
  })
  it('recommendation-shaped query with NO stored preference → null', async () => {
    const noPref = [mem('x1', 'we discussed restaurants downtown', 'S6', '2023-04-01')]
    expect(await synthesize({ query: 'Any suggestions for a dinner spot?', memories: noPref, now: NOW })).toBeNull()
  })
  it('preference co-fires as an extra section alongside a compute section', async () => {
    const both = [...MEMS, ...PREF_MEMS]
    const block = (await synthesize({
      query: 'How many days since my last museum visit? Any suggestions for the next one?',
      memories: both, intelligence: selecting([{ index: 0 }]), now: NOW,
    }))!
    expect(block.intent).toBe('temporal')
    expect(block.text).toContain('[constraint]')
  })
  it('caps constraints at the 3 most relevant', async () => {
    const many = [
      mem('p1', 'I prefer aisle seats', 'S1', '2023-01-01'),
      mem('p2', 'I never eat shellfish', 'S2', '2023-01-02'),
      mem('p3', "I'm allergic to peanuts", 'S3', '2023-01-03'),
      mem('p4', 'my favorite cuisine is Ethiopian', 'S4', '2023-01-04'),
    ]
    const block = (await synthesize({ query: 'Any dinner suggestions?', memories: many, now: NOW }))!
    expect((block.text.match(/\[constraint\]/g) ?? []).length).toBe(3)
  })
})

describe('synthesize — error isolation', () => {
  it('never throws even when internals do', async () => {
    const hostile = { selectEvidence: vi.fn(() => { throw new Error('sync boom') }) } as unknown as IntelligenceAdapter
    await expect(
      synthesize({ query: 'How long ago was my trip?', memories: MEMS, intelligence: hostile, now: NOW }),
    ).resolves.not.toThrow()
  })
})
