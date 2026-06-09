import { describe, it, expect, vi } from 'vitest'
import { iterativeRecall } from '../src/retrieval/iterative.js'
import type { BenchRecallResult, BenchScoredMemory } from '../src/merge-associations.js'

function mem(id: string, relevance: number): BenchScoredMemory {
  return {
    id,
    type: 'episode',
    content: `content-${id}`,
    relevance,
    source: 'vector',
    metadata: {},
  } as unknown as BenchScoredMemory
}

function recallResult(
  memories: BenchScoredMemory[],
  associations: BenchScoredMemory[] = [],
): BenchRecallResult {
  return {
    memories,
    associations,
    intent: undefined,
    primed: [],
    estimatedTokens: 0,
    formatted: '',
  } as unknown as BenchRecallResult
}

describe('iterativeRecall (A4 control flow, no OpenAI/Neo4j)', () => {
  it('runs a single round when the agent proposes STOP (null)', async () => {
    const recall = vi.fn(async () => recallResult([mem('a', 0.9), mem('b', 0.8)]))
    const proposeNextQuery = vi.fn(async () => null)

    const out = await iterativeRecall('q', { recall, proposeNextQuery })

    expect(recall).toHaveBeenCalledTimes(1)
    expect(recall).toHaveBeenCalledWith('q')
    expect(out.memories.map((m) => m.id)).toEqual(['a', 'b'])
    expect(out.trace.rounds).toBe(1)
    expect(out.trace.queries).toEqual(['q'])
  })

  it('recovers a hop-2 bridge memory that single-shot dense missed', async () => {
    // Round 1 surfaces hop-1 evidence but NOT the bridge paragraph (it is not
    // similar to the original question). The agent names the bridge; round 2
    // retrieves it. Recovering it is the entire reason A4 exists.
    const recall = vi.fn(async (query: string) =>
      query === 'q'
        ? recallResult([mem('hop1', 0.9)])
        : recallResult([mem('bridge', 0.95)]),
    )
    const proposeNextQuery = vi.fn(async () => 'who directed the film')

    const out = await iterativeRecall('q', { recall, proposeNextQuery }, { maxRounds: 2 })

    const ids = out.memories.map((m) => m.id)
    expect(ids).toContain('hop1')
    expect(ids).toContain('bridge')
    expect(recall).toHaveBeenCalledTimes(2)
    expect(out.trace.queries).toEqual(['q', 'who directed the film'])
  })

  it('stops at maxRounds even when the agent keeps proposing new queries', async () => {
    let n = 0
    const recall = vi.fn(async () => recallResult([mem(`m${n++}`, 0.5)]))
    let c = 0
    const proposeNextQuery = vi.fn(async () => `q-${c++}`)

    const out = await iterativeRecall('q', { recall, proposeNextQuery }, { maxRounds: 3 })

    expect(recall).toHaveBeenCalledTimes(3)
    expect(out.trace.rounds).toBe(3)
    // Not proposed after the final round.
    expect(proposeNextQuery).toHaveBeenCalledTimes(2)
  })

  it('breaks the loop when the agent re-proposes an already-issued query', async () => {
    const recall = vi.fn(async () => recallResult([mem('a', 0.5)]))
    const proposeNextQuery = vi.fn(async () => 'q') // identical to the original question

    const out = await iterativeRecall('q', { recall, proposeNextQuery }, { maxRounds: 5 })

    expect(recall).toHaveBeenCalledTimes(1)
    expect(out.trace.rounds).toBe(1)
  })

  it('interleaves rounds by rank and dedupes by id', async () => {
    const recall = vi.fn(async (query: string) =>
      query === 'q'
        ? recallResult([mem('a', 0.9), mem('b', 0.7)])
        : recallResult([mem('c', 0.8), mem('a', 0.6)]),
    )
    const proposeNextQuery = vi.fn(async () => 'bridge')

    const out = await iterativeRecall('q', { recall, proposeNextQuery }, { maxRounds: 2, limit: 10 })

    // rank0: r1=a, r2=c; rank1: r1=b, r2=a(dup→skip) → [a, c, b]
    expect(out.memories.map((m) => m.id)).toEqual(['a', 'c', 'b'])
  })

  it('caps output at the limit', async () => {
    const recall = vi.fn(async () =>
      recallResult([mem('a', 0.9), mem('b', 0.8), mem('c', 0.7)]),
    )
    const proposeNextQuery = vi.fn(async () => null)

    const out = await iterativeRecall('q', { recall, proposeNextQuery }, { limit: 2 })

    expect(out.memories.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('appends the association channel when mergeAssociationsIntoTopK is set', async () => {
    const recall = vi.fn(async () => recallResult([mem('a', 0.9)], [mem('assoc', 0.5)]))
    const proposeNextQuery = vi.fn(async () => null)

    const out = await iterativeRecall(
      'q',
      { recall, proposeNextQuery },
      { mergeAssociationsIntoTopK: true },
    )

    expect(out.memories.map((m) => m.id)).toEqual(['a', 'assoc'])
  })
})
