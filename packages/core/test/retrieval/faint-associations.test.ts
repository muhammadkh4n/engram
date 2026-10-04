import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RetrievedMemory } from '../../src/types.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { CompositeMemory } from '../../src/retrieval/spreading-activation.js'

const activate = vi.hoisted(() => vi.fn())

vi.mock('../../src/retrieval/spreading-activation.js', () => ({
  stageActivate: activate,
}))

import { recall } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import { createMockStorage } from './mock-storage.js'

const DUMMY_EMBEDDING = [0.1, 0.2, 0.3]
const GRAPH = {
  strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined),
} as unknown as GraphPort

function neighbour(id: string, relevance: number): RetrievedMemory {
  return {
    id,
    type: 'episode',
    content: `graph neighbour ${id}`,
    relevance,
    source: 'association',
    metadata: { lmeSessionId: `session-${id}`, activationSource: 'spreading_activation' },
  }
}

function composite(faint: RetrievedMemory[]): CompositeMemory {
  return {
    coreMemories: [],
    speakers: [],
    emotionalContext: [],
    dominantIntent: 'INFORMATIONAL',
    temporalContext: [],
    relatedTopics: [],
    faintAssociations: faint,
  }
}

async function recallDeep() {
  return recall('what did we decide about the deploy?', createMockStorage(), new SensoryBuffer(), {
    strategy: RECALL_STRATEGIES.deep,
    embedding: DUMMY_EMBEDDING,
    graph: GRAPH,
  })
}

describe('recall engine — faintAssociations', () => {
  beforeEach(() => {
    activate.mockReset()
  })

  it('exposes the faint associations rendered in formatted, separate from associations', async () => {
    const primary = neighbour('primary-1', 0.4)
    const faint = [neighbour('faint-1', 0.05), neighbour('faint-2', 0.04)]
    activate.mockResolvedValue({ associations: [primary], context: composite(faint) })

    const result = await recallDeep()

    expect(result.faintAssociations).toEqual(faint)
    expect(result.associations.map((a) => a.id)).toEqual(['primary-1'])
    expect(result.formatted).toContain('### Faint Associations')
    for (const f of faint) expect(result.formatted).toContain(f.content)
  })

  it('omits the field when activation found no faint neighbours', async () => {
    activate.mockResolvedValue({ associations: [neighbour('primary-1', 0.4)], context: composite([]) })

    const result = await recallDeep()

    expect(result).not.toHaveProperty('faintAssociations')
    expect(result.formatted).not.toContain('### Faint Associations')
  })

  it('omits the field when the graph has no seed nodes and the SQL walk runs', async () => {
    activate.mockResolvedValue(null)

    const result = await recallDeep()

    expect(result).not.toHaveProperty('faintAssociations')
  })

  describe('with ENGRAM_RECALL_FAINT=off', () => {
    const original = process.env['ENGRAM_RECALL_FAINT']

    afterEach(() => {
      if (original === undefined) delete process.env['ENGRAM_RECALL_FAINT']
      else process.env['ENGRAM_RECALL_FAINT'] = original
    })

    it('drops both the section and the field', async () => {
      process.env['ENGRAM_RECALL_FAINT'] = 'off'
      const faint = [neighbour('faint-1', 0.05)]
      activate.mockResolvedValue({ associations: [neighbour('primary-1', 0.4)], context: composite(faint) })

      const result = await recallDeep()

      expect(result).not.toHaveProperty('faintAssociations')
      expect(result.formatted).not.toContain('### Faint Associations')
      expect(result.formatted).not.toContain(faint[0]?.content)
      expect(result.payload.emittedFaint).toBe(0)
      expect(result.associations.map((a) => a.id)).toEqual(['primary-1'])
    })
  })
})

describe('recall engine — kind and session filter on graph neighbours', () => {
  beforeEach(() => {
    activate.mockReset()
  })

  function storedNeighbour(id: string, type: RetrievedMemory['type']): RetrievedMemory {
    return { ...neighbour(id, 0.3), type }
  }

  it('judges an episode neighbour on its stored session and drops it from Related and Faint', async () => {
    // ep-assoc-1 is stored under sess-2, ep-1 under sess-1 (mock storage fixtures).
    activate.mockResolvedValue({
      associations: [storedNeighbour('ep-assoc-1', 'episode'), storedNeighbour('ep-1', 'episode')],
      context: composite([storedNeighbour('ep-assoc-1', 'episode')]),
    })
    const storage = createMockStorage()

    const result = await recall('what did we decide about the deploy?', storage, new SensoryBuffer(), {
      strategy: RECALL_STRATEGIES.deep,
      embedding: DUMMY_EMBEDDING,
      graph: GRAPH,
      excludeSessionId: 'sess-2',
    })

    expect(result.associations.map((a) => a.id)).toEqual(['ep-1'])
    expect(result).not.toHaveProperty('faintAssociations')
    expect(result.formatted).not.toContain('graph neighbour ep-assoc-1')
  })

  it('keeps a semantic neighbour by tier alone and drops a neighbour storage no longer returns', async () => {
    activate.mockResolvedValue({
      associations: [storedNeighbour('sem-k7q', 'semantic'), storedNeighbour('gone-k7q', 'episode')],
      context: composite([]),
    })
    const storage = createMockStorage()

    const result = await recall('what did we decide about the deploy?', storage, new SensoryBuffer(), {
      strategy: RECALL_STRATEGIES.deep,
      embedding: DUMMY_EMBEDDING,
      graph: GRAPH,
      kinds: ['fact', 'turn'],
    })

    expect(result.associations.map((a) => a.id)).toEqual(['sem-k7q'])
  })
})
