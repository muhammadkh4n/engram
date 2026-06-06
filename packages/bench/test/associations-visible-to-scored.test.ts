/**
 * Phase 0 invariant — the metric MUST be able to see the graph channel.
 *
 * Discovery #1: both bench adapters score only `recallResult.memories`, but
 * graph spreading-activation output lands in the separate
 * `recallResult.associations` channel. So `graph:true` vs `graph:false`
 * mathematically could not move recall@K — the graph was never measured.
 *
 * This pins the fix: with the merge flag ON, a gold id that lives ONLY in
 * associations becomes visible to the scored top-K; with it OFF, the scored
 * pool is byte-identical to today. This is the "associations-visible
 * invariant" the symmetric kill-criterion (Unit 8) later depends on.
 *
 * Deterministic: a hand-built recall result, no dataset, no Neo4j, no LLM.
 */
import { describe, it, expect } from 'vitest'
import {
  mergeAssociationsIntoScored,
  type BenchRecallResult,
  type BenchScoredMemory,
} from '../src/merge-associations.js'

const GOLD_SESSION = 'gold-sess'

function mem(id: string, lmeSessionId: string): BenchScoredMemory {
  return {
    id,
    type: 'episode',
    content: `content-${id}`,
    relevance: 0.9, // strong channel — post MMR/rerank
    source: 'recall',
    metadata: { lmeSessionId },
  }
}

function assoc(id: string, lmeSessionId: string): BenchScoredMemory {
  return {
    id,
    type: 'episode',
    content: `content-${id}`,
    relevance: 0.12, // graph-relevance scale — deliberately lower than memories
    source: 'association',
    metadata: { lmeSessionId, activationSource: 'spreading_activation' },
  }
}

// Gold session lives ONLY in the association channel; the memory channel holds
// only noise. This is the case the graph is supposed to rescue.
function makeFixture(): BenchRecallResult {
  return {
    memories: [mem('m1', 'noise-a'), mem('m2', 'noise-b')],
    associations: [assoc('a1', GOLD_SESSION)],
    intent: {} as BenchRecallResult['intent'],
    primed: [],
    estimatedTokens: 0,
    formatted: '',
  }
}

// Mirror the adapters' gold-id set-membership over the deduped top-K.
function goldInTopK(pool: BenchScoredMemory[], k = 10): boolean {
  const seen = new Set<string>()
  for (const m of pool.slice(0, k)) {
    const sid = m.metadata?.['lmeSessionId'] as string | undefined
    if (sid) seen.add(sid)
  }
  return seen.has(GOLD_SESSION)
}

describe('associations are visible to the scored pool iff merge is ON', () => {
  it('gold session is ABSENT from the scored pool when merge is OFF', () => {
    const scored = mergeAssociationsIntoScored(makeFixture(), false)
    expect(goldInTopK(scored)).toBe(false)
  })

  it('gold session is PRESENT in the scored pool when merge is ON', () => {
    const scored = mergeAssociationsIntoScored(makeFixture(), true)
    expect(goldInTopK(scored)).toBe(true)
  })

  it('merge OFF returns the memories array unchanged (no behaviour drift)', () => {
    const fixture = makeFixture()
    expect(mergeAssociationsIntoScored(fixture, false)).toBe(fixture.memories)
    expect(mergeAssociationsIntoScored(fixture, undefined)).toBe(fixture.memories)
  })

  it('merge ON appends associations after memories (memory-first ordering)', () => {
    const fixture = makeFixture()
    const scored = mergeAssociationsIntoScored(fixture, true)
    expect(scored.map((m) => m.id)).toEqual(['m1', 'm2', 'a1'])
  })
})
