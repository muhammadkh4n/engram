/**
 * Unit tests for `fuseByReciprocalRank` — the RRF fusion step used to combine
 * a primary recall pass with a HyDE-augmented pass.
 *
 * Bug B fix: when the same memory id appears in both lists, per-pass metadata
 * enrichments (HyDE, pattern-completion, reranker) must survive the merge.
 * The pre-fix code did `if (!byId.has(m.id)) byId.set(m.id, m)` — keeping only
 * the first occurrence and silently dropping any later-pass metadata.
 */
import { describe, it, expect } from 'vitest'
import { fuseByReciprocalRank } from '../../src/retrieval/engine.js'
import type { RetrievedMemory } from '../../src/types.js'

function mem(
  id: string,
  relevance: number,
  metadata: Record<string, unknown> = {},
): RetrievedMemory {
  return {
    id,
    type: 'episode',
    content: `content-${id}`,
    relevance,
    source: 'recall',
    metadata,
  }
}

describe('fuseByReciprocalRank', () => {
  it('merges metadata when same id appears in both lists (Bug B fix)', () => {
    const listA = [mem('a', 0.9, { from: 'primary', pass: 1 })]
    const listB = [mem('a', 0.7, { hydeMatch: true, rerankScore: 0.85 })]

    const fused = fuseByReciprocalRank(listA, listB, 10)

    expect(fused).toHaveLength(1)
    expect(fused[0]!.id).toBe('a')
    // BOTH passes' metadata survives the fusion
    expect(fused[0]!.metadata).toEqual({
      from: 'primary',
      pass: 1,
      hydeMatch: true,
      rerankScore: 0.85,
    })
  })

  it('later-list keys win conflicts (HyDE enrichment overrides primary)', () => {
    const listA = [mem('a', 0.9, { rerankScore: 0.5, source: 'primary' })]
    const listB = [mem('a', 0.8, { rerankScore: 0.9, hydeMatch: true })]

    const fused = fuseByReciprocalRank(listA, listB, 10)

    expect(fused[0]!.metadata).toEqual({
      rerankScore: 0.9, // listB wins
      source: 'primary', // listA-only key survives
      hydeMatch: true, // listB-only key survives
    })
  })

  it('preserves first-seen metadata for items only in one list', () => {
    const listA = [mem('a', 0.9, { tag: 'A-only' })]
    const listB = [mem('b', 0.8, { tag: 'B-only' })]

    const fused = fuseByReciprocalRank(listA, listB, 10)

    const byId = Object.fromEntries(fused.map((m) => [m.id, m]))
    expect(byId.a!.metadata).toEqual({ tag: 'A-only' })
    expect(byId.b!.metadata).toEqual({ tag: 'B-only' })
  })

  it('overwrites relevance with RRF score', () => {
    const listA = [mem('a', 0.99)]
    const listB = [mem('a', 0.01)]

    const fused = fuseByReciprocalRank(listA, listB, 10)

    // Both lists rank 'a' at position 0 → RRF score = 2 / (60 + 1) ≈ 0.0328
    expect(fused[0]!.relevance).toBeCloseTo(2 / 61, 4)
    // Original 0.99 / 0.01 relevances are discarded
    expect(fused[0]!.relevance).not.toBe(0.99)
  })

  it('items in both lists outrank items in only one', () => {
    const listA = [mem('shared', 0.9), mem('a-only', 0.8)]
    const listB = [mem('shared', 0.9), mem('b-only', 0.8)]

    const fused = fuseByReciprocalRank(listA, listB, 10)

    expect(fused[0]!.id).toBe('shared')
    expect(fused[0]!.relevance).toBeCloseTo(2 / 61, 4)
    // The two single-list items tie at rank 1 in their respective lists
    expect(fused[1]!.relevance).toBeCloseTo(1 / 62, 4)
    expect(fused[2]!.relevance).toBeCloseTo(1 / 62, 4)
  })

  it('respects maxResults slicing', () => {
    const listA = Array.from({ length: 20 }, (_, i) => mem(`a${i}`, 1 - i * 0.01))
    const listB = Array.from({ length: 20 }, (_, i) => mem(`b${i}`, 1 - i * 0.01))

    const fused = fuseByReciprocalRank(listA, listB, 5)

    expect(fused).toHaveLength(5)
  })

  it('empty inputs yield empty output', () => {
    expect(fuseByReciprocalRank([], [], 10)).toEqual([])
  })

  it('one empty list passes the other through with RRF scoring', () => {
    const listA = [mem('a', 0.9), mem('b', 0.7)]

    const fused = fuseByReciprocalRank(listA, [], 10)

    expect(fused).toHaveLength(2)
    expect(fused[0]!.id).toBe('a')
    expect(fused[0]!.relevance).toBeCloseTo(1 / 61, 4)
    expect(fused[1]!.id).toBe('b')
    expect(fused[1]!.relevance).toBeCloseTo(1 / 62, 4)
  })

  it('handles empty metadata objects on both sides', () => {
    const listA = [mem('a', 0.9, {})]
    const listB = [mem('a', 0.8, { added: true })]

    const fused = fuseByReciprocalRank(listA, listB, 10)

    expect(fused[0]!.metadata).toEqual({ added: true })
  })
})
