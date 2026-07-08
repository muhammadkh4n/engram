import { describe, it, expect, vi } from 'vitest'
import { runSelection } from '../../src/synthesis/select-evidence.js'
import type { RetrievedMemory } from '../../src/types.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'

function mem(id: string, content: string, occurredAt?: string): RetrievedMemory {
  return {
    id, type: 'episode', content, relevance: 0.5, source: 'recall',
    metadata: occurredAt ? { occurredAt } : {}, sessionId: 's1',
  }
}
const EVIDENCE = [mem('m0', 'first line', '2023-01-10'), mem('m1', 'second line'), mem('m2', 'third line', '2023-02-02')]

function adapterReturning(selection: unknown): IntelligenceAdapter {
  return { selectEvidence: vi.fn().mockResolvedValue(selection) } as unknown as IntelligenceAdapter
}

describe('runSelection', () => {
  it('valid selection: resolves memories, normalizes instance labels, keeps dateText', async () => {
    const adapter = adapterReturning({ items: [
      { index: 0, instance: 'Trip A', dateText: 'last Tuesday' },
      { index: 2, instance: 'Trip B' },
    ] })
    const out = await runSelection('q', 'temporal', EVIDENCE, adapter)
    expect(out.kind).toBe('selected')
    if (out.kind !== 'selected') return
    expect(out.items.map((i) => i.memory.id)).toEqual(['m0', 'm2'])
    expect(out.items[0]!.instance).toBe('trip a')
    expect(out.items[0]!.dateText).toBe('last Tuesday')
    expect(out.items[1]!.dateText).toBeNull()
  })

  it('passes numbered, capped evidence lines with ISO dates to the adapter', async () => {
    const adapter = adapterReturning({ items: [] })
    await runSelection('q', 'aggregation', EVIDENCE, adapter)
    const call = (adapter.selectEvidence as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[0]).toBe('q')
    expect(call[1]).toEqual([
      { index: 0, text: 'first line', date: '2023-01-10' },
      { index: 1, text: 'second line' },
      { index: 2, text: 'third line', date: '2023-02-02' },
    ])
    expect(call[2]).toEqual({ mode: 'aggregation' })
  })

  it('explicit empty selection → empty (no block; abstention safety)', async () => {
    const out = await runSelection('q', 'temporal', EVIDENCE, adapterReturning({ items: [] }))
    expect(out.kind).toBe('empty')
  })

  it('out-of-bounds / non-integer / duplicate indices are dropped; all-garbage → error', async () => {
    const partly = await runSelection('q', 'temporal', EVIDENCE, adapterReturning({ items: [
      { index: 0 }, { index: 0 }, { index: 99 }, { index: -1 }, { index: 1.5 },
    ] }))
    expect(partly.kind).toBe('selected')
    if (partly.kind === 'selected') expect(partly.items).toHaveLength(1)
    const garbage = await runSelection('q', 'temporal', EVIDENCE, adapterReturning({ items: [{ index: 99 }] }))
    expect(garbage.kind).toBe('error')
  })

  it('malformed shape or adapter throw → error (degrade, never crash recall)', async () => {
    expect((await runSelection('q', 'temporal', EVIDENCE, adapterReturning({ nope: true }))).kind).toBe('error')
    const throwing = { selectEvidence: vi.fn().mockRejectedValue(new Error('api down')) } as unknown as IntelligenceAdapter
    expect((await runSelection('q', 'temporal', EVIDENCE, throwing)).kind).toBe('error')
  })

  it('caps evidence at 30 lines of ≤120 chars', async () => {
    const many = Array.from({ length: 40 }, (_, i) => mem(`m${i}`, 'x'.repeat(300)))
    const adapter = adapterReturning({ items: [] })
    await runSelection('q', 'temporal', many, adapter)
    const lines = (adapter.selectEvidence as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Array<{ text: string }>
    expect(lines).toHaveLength(30)
    expect(lines[0]!.text.length).toBeLessThanOrEqual(120)
  })
})
