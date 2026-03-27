import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AssociationManager } from '../../src/systems/association-manager.js'
import type { AssociationStorage } from '../../src/adapters/storage.js'
import type { Association, MemoryType, WalkResult, DiscoveredEdge } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockStorage(overrides?: Partial<AssociationStorage>): AssociationStorage {
  return {
    insert: vi.fn().mockResolvedValue({
      id: 'mock-id',
      sourceId: '',
      sourceType: 'episode' as MemoryType,
      targetId: '',
      targetType: 'episode' as MemoryType,
      edgeType: 'temporal',
      strength: 0,
      lastActivated: null,
      metadata: {},
      createdAt: new Date(),
    } satisfies Association),
    walk: vi.fn().mockResolvedValue([] as WalkResult[]),
    upsertCoRecalled: vi.fn().mockResolvedValue(undefined),
    pruneWeak: vi.fn().mockResolvedValue(0),
    discoverTopicalEdges: vi.fn().mockResolvedValue([] as DiscoveredEdge[]),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// createTemporalEdges
// ---------------------------------------------------------------------------

describe('AssociationManager.createTemporalEdges', () => {
  let storage: AssociationStorage
  let manager: AssociationManager

  beforeEach(() => {
    storage = makeMockStorage()
    manager = new AssociationManager(storage)
  })

  it('creates edges between every pair within default maxDistance of 5', async () => {
    // 5 episodes at indices 0-4. Pairs within distance 5:
    // (0,1),(0,2),(0,3),(0,4),(1,2),(1,3),(1,4),(2,3),(2,4),(3,4) = 10 pairs
    const ids = ['e1', 'e2', 'e3', 'e4', 'e5']
    const count = await manager.createTemporalEdges(ids)
    expect(count).toBe(10)
    expect(storage.insert).toHaveBeenCalledTimes(10)
  })

  it('all inserted edges have edgeType temporal and strength 0.3', async () => {
    await manager.createTemporalEdges(['e1', 'e2', 'e3'])
    const calls = vi.mocked(storage.insert).mock.calls
    for (const [arg] of calls) {
      expect(arg.edgeType).toBe('temporal')
      expect(arg.strength).toBe(0.3)
      expect(arg.sourceType).toBe('episode')
      expect(arg.targetType).toBe('episode')
    }
  })

  it('respects a custom maxDistance', async () => {
    // 5 episodes, maxDistance=2: only pairs at distance 1 or 2
    // (0,1),(0,2),(1,2),(1,3),(2,3),(2,4),(3,4) = 7 pairs
    const ids = ['e1', 'e2', 'e3', 'e4', 'e5']
    const count = await manager.createTemporalEdges(ids, { maxDistance: 2 })
    expect(count).toBe(7)
  })

  it('returns 0 for a single episode', async () => {
    const count = await manager.createTemporalEdges(['e1'])
    expect(count).toBe(0)
    expect(storage.insert).not.toHaveBeenCalled()
  })

  it('returns 0 for an empty array', async () => {
    const count = await manager.createTemporalEdges([])
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// createDerivationEdges
// ---------------------------------------------------------------------------

describe('AssociationManager.createDerivationEdges', () => {
  let storage: AssociationStorage
  let manager: AssociationManager

  beforeEach(() => {
    storage = makeMockStorage()
    manager = new AssociationManager(storage)
  })

  it('creates one derives_from edge per source', async () => {
    const sources = [
      { id: 's1', type: 'episode' as MemoryType },
      { id: 's2', type: 'episode' as MemoryType },
      { id: 's3', type: 'digest' as MemoryType },
    ]
    const target = { id: 't1', type: 'digest' as MemoryType }

    const count = await manager.createDerivationEdges(sources, target)
    expect(count).toBe(3)
    expect(storage.insert).toHaveBeenCalledTimes(3)
  })

  it('all edges have edgeType derives_from and strength 0.8', async () => {
    const sources = [
      { id: 's1', type: 'episode' as MemoryType },
      { id: 's2', type: 'episode' as MemoryType },
    ]
    const target = { id: 't1', type: 'semantic' as MemoryType }

    await manager.createDerivationEdges(sources, target)
    const calls = vi.mocked(storage.insert).mock.calls
    for (const [arg] of calls) {
      expect(arg.edgeType).toBe('derives_from')
      expect(arg.strength).toBe(0.8)
      expect(arg.targetId).toBe('t1')
      expect(arg.targetType).toBe('semantic')
    }
  })

  it('returns 0 and inserts nothing for an empty sources array', async () => {
    const count = await manager.createDerivationEdges([], { id: 't1', type: 'digest' })
    expect(count).toBe(0)
    expect(storage.insert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createCoRecalledEdges
// ---------------------------------------------------------------------------

describe('AssociationManager.createCoRecalledEdges', () => {
  it('uses only the top 5 memories when more are provided', async () => {
    const storage = makeMockStorage()
    const manager = new AssociationManager(storage)

    // 10 memories — only first 5 should participate, giving C(5,2) = 10 pairs
    const memories = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      type: 'episode' as MemoryType,
    }))

    const count = await manager.createCoRecalledEdges(memories)
    expect(count).toBe(10)
    expect(storage.upsertCoRecalled).toHaveBeenCalledTimes(10)

    // Verify only ids m0-m4 were used
    const usedIds = new Set<string>()
    for (const call of vi.mocked(storage.upsertCoRecalled).mock.calls) {
      usedIds.add(call[0])
      usedIds.add(call[2])
    }
    expect([...usedIds].every((id) => ['m0', 'm1', 'm2', 'm3', 'm4'].includes(id))).toBe(true)
  })

  it('creates C(n,2) pairs for n <= 5 memories', async () => {
    const storage = makeMockStorage()
    const manager = new AssociationManager(storage)

    const memories = [
      { id: 'a', type: 'episode' as MemoryType },
      { id: 'b', type: 'digest' as MemoryType },
      { id: 'c', type: 'semantic' as MemoryType },
    ]

    const count = await manager.createCoRecalledEdges(memories)
    expect(count).toBe(3) // C(3,2) = 3
    expect(storage.upsertCoRecalled).toHaveBeenCalledTimes(3)
  })

  it('skips a source that already has more than 100 edges (cap enforcement)', async () => {
    // m0 has 101 neighbours (over cap) — all pairs where m0 is the source should be skipped.
    // top-5: m0, m1, m2, m3, m4
    // Pairs with m0 as source (i=0): (m0,m1),(m0,m2),(m0,m3),(m0,m4) = 4 pairs skipped
    // Remaining pairs: (m1,m2),(m1,m3),(m1,m4),(m2,m3),(m2,m4),(m3,m4) = 6 pairs created
    const walkResults: WalkResult[] = Array.from({ length: 101 }, (_, i) => ({
      memoryId: `n${i}`,
      memoryType: 'episode' as MemoryType,
      depth: 1,
      pathStrength: 0.5,
    }))

    const storage = makeMockStorage({
      walk: vi.fn().mockImplementation(async (seedIds: string[]) => {
        if (seedIds[0] === 'm0') return walkResults
        return []
      }),
    })
    const manager = new AssociationManager(storage)

    const memories = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      type: 'episode' as MemoryType,
    }))

    const count = await manager.createCoRecalledEdges(memories)
    expect(count).toBe(6)
  })

  it('returns 0 for an empty memories array', async () => {
    const storage = makeMockStorage()
    const manager = new AssociationManager(storage)
    const count = await manager.createCoRecalledEdges([])
    expect(count).toBe(0)
    expect(storage.upsertCoRecalled).not.toHaveBeenCalled()
  })

  it('returns 0 for a single memory (no pairs possible)', async () => {
    const storage = makeMockStorage()
    const manager = new AssociationManager(storage)
    const count = await manager.createCoRecalledEdges([{ id: 'solo', type: 'episode' }])
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// createContradictionEdge
// ---------------------------------------------------------------------------

describe('AssociationManager.createContradictionEdge', () => {
  it('inserts a contradicts edge with strength 0.7 from new to old', async () => {
    const storage = makeMockStorage()
    const manager = new AssociationManager(storage)

    await manager.createContradictionEdge('old-1', 'semantic', 'new-1', 'semantic')

    expect(storage.insert).toHaveBeenCalledOnce()
    const [arg] = vi.mocked(storage.insert).mock.calls[0]
    expect(arg.edgeType).toBe('contradicts')
    expect(arg.strength).toBe(0.7)
    expect(arg.sourceId).toBe('new-1')
    expect(arg.targetId).toBe('old-1')
    expect(arg.sourceType).toBe('semantic')
    expect(arg.targetType).toBe('semantic')
  })

  it('works with different source and target memory types', async () => {
    const storage = makeMockStorage()
    const manager = new AssociationManager(storage)

    await manager.createContradictionEdge('old-ep', 'episode', 'new-sem', 'semantic')

    const [arg] = vi.mocked(storage.insert).mock.calls[0]
    expect(arg.sourceType).toBe('semantic')
    expect(arg.targetType).toBe('episode')
  })
})

// ---------------------------------------------------------------------------
// createSupportEdge
// ---------------------------------------------------------------------------

describe('AssociationManager.createSupportEdge', () => {
  it('inserts a supports edge with strength 0.5', async () => {
    const storage = makeMockStorage()
    const manager = new AssociationManager(storage)

    await manager.createSupportEdge('src-1', 'episode', 'tgt-1', 'semantic')

    expect(storage.insert).toHaveBeenCalledOnce()
    const [arg] = vi.mocked(storage.insert).mock.calls[0]
    expect(arg.edgeType).toBe('supports')
    expect(arg.strength).toBe(0.5)
    expect(arg.sourceId).toBe('src-1')
    expect(arg.targetId).toBe('tgt-1')
    expect(arg.sourceType).toBe('episode')
    expect(arg.targetType).toBe('semantic')
  })

  it('sets lastActivated to null on the inserted edge', async () => {
    const storage = makeMockStorage()
    const manager = new AssociationManager(storage)

    await manager.createSupportEdge('a', 'digest', 'b', 'procedural')

    const [arg] = vi.mocked(storage.insert).mock.calls[0]
    expect(arg.lastActivated).toBeNull()
  })
})
