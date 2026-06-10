import { describe, it, expect, vi } from 'vitest'
import { stageActivate } from '../../src/retrieval/spreading-activation.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { StorageAdapter } from '../../src/adapters/storage.js'
import type { RecallStrategy, RetrievedMemory, Episode } from '../../src/types.js'

// stageActivate touches only these graph/storage methods.
function makeGraph(overrides: Partial<GraphPort> = {}): GraphPort {
  return {
    lookupEntityNodes: vi.fn().mockResolvedValue([]),
    spreadActivation: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as GraphPort
}

function makeStorage(episodes: Episode[]): StorageAdapter {
  return {
    episodes: { getByIds: vi.fn().mockResolvedValue(episodes) },
  } as unknown as StorageAdapter
}

const STRATEGY = { mode: 'deep', associations: true } as unknown as RecallStrategy

function ep(id: string): Episode {
  return {
    id,
    sessionId: 's',
    role: 'user',
    content: `content ${id}`,
    salience: 0.5,
    accessCount: 0,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: null,
    entities: [],
    metadata: {},
    createdAt: new Date(),
    projectId: null,
  } as Episode
}

const recalled: RetrievedMemory[] = [
  { id: 'seed-1', type: 'episode', content: 'x', relevance: 0.9, source: 'recall', metadata: {} } as RetrievedMemory,
]

describe('stageActivate — context reinstatement (Gap 4)', () => {
  it('seeds primed-topic context nodes into spreading activation', async () => {
    const spreadActivation = vi.fn().mockResolvedValue([])
    const graph = makeGraph({
      // No query entities ('what did we decide' extracts none), so this is
      // called only for the context topics.
      lookupEntityNodes: vi
        .fn()
        .mockImplementation(async (names: string[]) =>
          names.includes('auth') ? [{ nodeId: 'topic:auth', nodeType: 'Topic', name: 'auth' }] : [],
        ),
      spreadActivation,
    })

    await stageActivate(
      recalled,
      'what did we decide',
      graph,
      STRATEGY,
      makeStorage([]),
      undefined,
      undefined,
      ['auth'],
    )

    expect(graph.lookupEntityNodes).toHaveBeenCalledWith(['auth'])
    const opts = vi.mocked(spreadActivation).mock.calls[0]![0] as { seedActivations: Map<string, number> }
    expect(opts.seedActivations.get('topic:auth')).toBeCloseTo(0.45)
  })

  it('is a no-op when there are no primed topics', async () => {
    const spreadActivation = vi.fn().mockResolvedValue([])
    const graph = makeGraph({ spreadActivation })

    await stageActivate(recalled, 'plain query', graph, STRATEGY, makeStorage([]))

    // Only the vector seed — no context nodes added.
    const opts = vi.mocked(spreadActivation).mock.calls[0]![0] as { seedActivations: Map<string, number> }
    expect([...opts.seedActivations.keys()]).toEqual(['seed-1'])
  })
})

describe('stageActivate — lateral inhibition (Gap 5)', () => {
  it('halves the activation of high-betweenness hub nodes (isBridge)', async () => {
    const spreadActivation = vi.fn().mockResolvedValue([
      { nodeId: 'm-bridge', nodeType: 'Memory', activation: 0.5, depth: 1, properties: { isBridge: true } },
      { nodeId: 'm-plain', nodeType: 'Memory', activation: 0.5, depth: 1, properties: {} },
    ])
    const graph = makeGraph({ spreadActivation })
    const storage = makeStorage([ep('m-bridge'), ep('m-plain')])

    const result = await stageActivate(recalled, 'query', graph, STRATEGY, storage)

    expect(result).not.toBeNull()
    const byId = new Map(result!.associations.map((a) => [a.id, a.relevance]))
    expect(byId.get('m-plain')).toBeCloseTo(0.5)
    expect(byId.get('m-bridge')).toBeCloseTo(0.25) // suppressed by HUB_INHIBITION_FACTOR
    expect(byId.get('m-plain')!).toBeGreaterThan(byId.get('m-bridge')!)
  })

  it('leaves activation untouched when no node is flagged isBridge', async () => {
    const spreadActivation = vi.fn().mockResolvedValue([
      { nodeId: 'm1', nodeType: 'Memory', activation: 0.5, depth: 1, properties: {} },
    ])
    const graph = makeGraph({ spreadActivation })
    const storage = makeStorage([ep('m1')])

    const result = await stageActivate(recalled, 'query', graph, STRATEGY, storage)
    const m1 = result!.associations.find((a) => a.id === 'm1')
    expect(m1?.relevance).toBeCloseTo(0.5)
  })
})
