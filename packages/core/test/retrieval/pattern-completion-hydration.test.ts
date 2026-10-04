import { describe, it, expect, vi } from 'vitest'
import { recall } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { MemoryType, TypedMemory } from '../../src/types.js'
import { createMockStorage, MOCK_EPISODE, MOCK_SEMANTIC } from './mock-storage.js'

const LIVE_EPISODE_ID = 'ep-live'
const FORGOTTEN_SEMANTIC_ID = 'sem-forgotten'

// Mirrors the adapters' default lookup: a tombstoned row is not returned
// unless the caller passes includeInactive.
const ROWS: Record<string, { row: TypedMemory; forgotten: boolean }> = {
  [LIVE_EPISODE_ID]: {
    row: { type: 'episode', data: { ...MOCK_EPISODE, id: LIVE_EPISODE_ID, content: 'Chose Postgres for the auth service' } },
    forgotten: false,
  },
  [FORGOTTEN_SEMANTIC_ID]: {
    row: { type: 'semantic', data: { ...MOCK_SEMANTIC, id: FORGOTTEN_SEMANTIC_ID, content: 'Auth service runs on MySQL' } },
    forgotten: true,
  },
}

// Nothing from search, so the explicit-recall query falls back to pattern
// completion.
const NO_SEARCH_HITS = {
  episodeResults: [],
  digestResults: [],
  semanticResults: [],
  proceduralResults: [],
  walkResults: [],
  vectorSearchResults: [],
  textBoostResults: [],
}

function makeGraph(): GraphPort {
  return {
    findMatchingContextNodes: vi.fn().mockResolvedValue([{ nodeIds: ['topic:auth'] }]),
    spreadActivation: vi.fn().mockResolvedValue([
      { nodeId: LIVE_EPISODE_ID, nodeType: 'Memory', activation: 0.8, depth: 1 },
      { nodeId: FORGOTTEN_SEMANTIC_ID, nodeType: 'Memory', activation: 0.7, depth: 1 },
    ]),
    lookupEntityNodes: vi.fn().mockResolvedValue([]),
    strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined),
  } as unknown as GraphPort
}

describe('pattern completion hydration', () => {
  it('hydrates graph-activated ids in one lookup and drops a forgotten row', async () => {
    const storage = createMockStorage(NO_SEARCH_HITS)
    const getByIds = vi.fn(
      async (refs: Array<{ id: string; type: MemoryType }>, opts?: { includeInactive?: boolean }) =>
        refs.flatMap((ref) => {
          const entry = ROWS[ref.id]
          if (!entry || entry.row.type !== ref.type) return []
          if (entry.forgotten && opts?.includeInactive !== true) return []
          return [entry.row]
        }),
    )
    storage.getByIds = getByIds
    const graph = makeGraph()

    const result = await recall('what did we decide about auth', storage, new SensoryBuffer(), {
      strategy: RECALL_STRATEGIES.light,
      embedding: [0.1, 0.2, 0.3],
      graph,
    })

    const patternIds = result.memories
      .filter((m) => m.metadata['patternCompletion'] === true)
      .map((m) => m.id)
    expect(patternIds).toEqual([LIVE_EPISODE_ID])
    expect(result.memories.map((m) => m.id)).not.toContain(FORGOTTEN_SEMANTIC_ID)
    expect(getByIds).toHaveBeenCalledTimes(1)
    const [refs, opts] = getByIds.mock.calls[0]!
    expect(opts?.includeInactive).not.toBe(true)
    expect(refs).toEqual(
      [LIVE_EPISODE_ID, FORGOTTEN_SEMANTIC_ID].flatMap((id) =>
        (['episode', 'digest', 'semantic', 'procedural'] as const).map((type) => ({ id, type })),
      ),
    )
    expect(storage.getById).not.toHaveBeenCalled()
  })

  it('keeps the episode row when an id resolves in several tiers', async () => {
    const storage = createMockStorage(NO_SEARCH_HITS)
    const sharedId = 'shared-id'
    storage.getByIds = vi.fn(async (refs: Array<{ id: string; type: MemoryType }>) =>
      refs.flatMap((ref): TypedMemory[] => {
        if (ref.id !== sharedId) return []
        if (ref.type === 'semantic') return [{ type: 'semantic', data: { ...MOCK_SEMANTIC, id: sharedId } }]
        if (ref.type === 'episode') return [{ type: 'episode', data: { ...MOCK_EPISODE, id: sharedId } }]
        return []
      }),
    )
    const graph = makeGraph()
    graph.spreadActivation = vi.fn().mockResolvedValue([
      { nodeId: sharedId, nodeType: 'Memory', activation: 0.8, depth: 1 },
    ])

    const result = await recall('what did we decide about auth', storage, new SensoryBuffer(), {
      strategy: RECALL_STRATEGIES.light,
      embedding: [0.1, 0.2, 0.3],
      graph,
    })

    const hit = result.memories.find((m) => m.id === sharedId)
    expect(hit?.type).toBe('episode')
  })
})

describe('pattern completion under a kind or session filter', () => {
  function storageWithLiveRows() {
    const storage = createMockStorage(NO_SEARCH_HITS)
    storage.getByIds = vi.fn(async (refs: Array<{ id: string; type: MemoryType }>) =>
      refs.flatMap((ref) => {
        const entry = ROWS[ref.id]
        return entry && !entry.forgotten && entry.row.type === ref.type ? [entry.row] : []
      }),
    )
    return storage
  }

  async function patternIds(filter: { kinds?: Array<'turn' | 'fact'>; excludeSessionId?: string }) {
    const result = await recall('what did we decide about auth', storageWithLiveRows(), new SensoryBuffer(), {
      strategy: RECALL_STRATEGIES.light,
      embedding: [0.1, 0.2, 0.3],
      graph: makeGraph(),
      ...filter,
    })
    return result.memories.filter((m) => m.metadata['patternCompletion'] === true).map((m) => m.id)
  }

  it('drops a graph-found row of another kind', async () => {
    // The live episode has no source and a named session: kind `turn`.
    expect(await patternIds({ kinds: ['turn'] })).toEqual([LIVE_EPISODE_ID])
    expect(await patternIds({ kinds: ['fact'] })).toEqual([])
  })

  it('drops a graph-found row from the excluded session', async () => {
    expect(await patternIds({ excludeSessionId: MOCK_EPISODE.sessionId })).toEqual([])
  })
})
