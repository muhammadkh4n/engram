import { afterEach, describe, it, expect, vi } from 'vitest'
import { recallFanEffectFromEnv } from '../../src/retrieval/link-switches.js'
import { stageActivate } from '../../src/retrieval/spreading-activation.js'
import { recall } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import type { GraphPort, GraphSpreadActivationOpts } from '../../src/adapters/graph.js'
import type { StorageAdapter } from '../../src/adapters/storage.js'
import type { RecallStrategy, RetrievedMemory } from '../../src/types.js'
import { createMockStorage, MOCK_EPISODE } from './mock-storage.js'

const PROJECT_NODE = 'project:engram'

describe('recallFanEffectFromEnv', () => {
  it('is off when unset or blank', () => {
    expect(recallFanEffectFromEnv({})).toBe(false)
    expect(recallFanEffectFromEnv({ ENGRAM_RECALL_FAN: '' })).toBe(false)
    expect(recallFanEffectFromEnv({ ENGRAM_RECALL_FAN: '   ' })).toBe(false)
  })

  it('reads on and off', () => {
    expect(recallFanEffectFromEnv({ ENGRAM_RECALL_FAN: 'on' })).toBe(true)
    expect(recallFanEffectFromEnv({ ENGRAM_RECALL_FAN: ' on ' })).toBe(true)
    expect(recallFanEffectFromEnv({ ENGRAM_RECALL_FAN: 'off' })).toBe(false)
  })

  it('throws on any other value, naming the variable', () => {
    for (const bad of ['true', '1', 'ON', 'yes']) {
      expect(() => recallFanEffectFromEnv({ ENGRAM_RECALL_FAN: bad })).toThrow('ENGRAM_RECALL_FAN')
    }
  })
})

function fakeGraph(spreadActivation = vi.fn().mockResolvedValue([])): GraphPort {
  return {
    lookupEntityNodes: vi.fn().mockResolvedValue([]),
    spreadActivation,
  } as unknown as GraphPort
}

const STORAGE = { episodes: { getByIds: vi.fn().mockResolvedValue([]) } } as unknown as StorageAdapter
const STRATEGY = { mode: 'deep', associations: true } as unknown as RecallStrategy
const RECALLED: RetrievedMemory[] = [
  { id: 'seed-1', type: 'episode', content: 'x', relevance: 0.9, source: 'recall', metadata: {} } as RetrievedMemory,
]

async function spreadOpts(options?: { fanEffect?: boolean }): Promise<GraphSpreadActivationOpts> {
  const spreadActivation = vi.fn().mockResolvedValue([])
  await stageActivate(RECALLED, 'plain query', fakeGraph(spreadActivation), STRATEGY, STORAGE, 'engram', undefined, [], options)
  expect(spreadActivation).toHaveBeenCalledTimes(1)
  return spreadActivation.mock.calls[0]![0] as GraphSpreadActivationOpts
}

describe('stageActivate fan-effect option', () => {
  it('sends no fanEffect and seeds the project node when off', async () => {
    for (const options of [undefined, {}, { fanEffect: false }]) {
      const opts = await spreadOpts(options)
      expect(opts).not.toHaveProperty('fanEffect')
      expect(opts.seedNodeIds).toContain(PROJECT_NODE)
      expect(opts.seedActivations?.get(PROJECT_NODE)).toBe(0.6)
    }
  })

  it('sends fanEffect and leaves the project node out when on', async () => {
    const opts = await spreadOpts({ fanEffect: true })
    expect(opts.fanEffect).toBe(true)
    expect(opts.seedNodeIds).toEqual(['seed-1'])
    expect(opts.seedActivations?.has(PROJECT_NODE)).toBe(false)
  })
})

// An explicit-recall query with no search hits runs the attribute pattern
// completion; its single hit then seeds the association stage.
const NO_SEARCH_HITS = {
  episodeResults: [],
  digestResults: [],
  semanticResults: [],
  proceduralResults: [],
  walkResults: [],
  vectorSearchResults: [],
  textBoostResults: [],
}
const ATTRIBUTE_SEED = 'topic:auth'
const HIT_ID = 'ep-hit'

async function recallSpreadCalls(): Promise<GraphSpreadActivationOpts[]> {
  const storage = createMockStorage(NO_SEARCH_HITS)
  storage.getByIds = vi.fn(async (refs: Array<{ id: string; type: string }>) =>
    refs.flatMap((ref) =>
      ref.id === HIT_ID && ref.type === 'episode' ? [{ type: 'episode' as const, data: { ...MOCK_EPISODE, id: HIT_ID } }] : [],
    ),
  )
  const spreadActivation = vi.fn().mockResolvedValue([{ nodeId: HIT_ID, nodeType: 'Memory', activation: 0.8, depth: 1 }])
  const graph = {
    findMatchingContextNodes: vi.fn().mockResolvedValue([{ nodeIds: [ATTRIBUTE_SEED] }]),
    spreadActivation,
    lookupEntityNodes: vi.fn().mockResolvedValue([]),
    strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined),
  } as unknown as GraphPort
  await recall('what did we decide about auth', storage, new SensoryBuffer(), {
    strategy: RECALL_STRATEGIES.deep,
    embedding: [0.1, 0.2, 0.3],
    graph,
    project: 'engram',
  })
  return spreadActivation.mock.calls.map((c) => c[0] as GraphSpreadActivationOpts)
}

describe('recall reads ENGRAM_RECALL_FAN for the association stage only', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function split(calls: GraphSpreadActivationOpts[]) {
    const attribute = calls.filter((o) => o.seedNodeIds.includes(ATTRIBUTE_SEED))
    const association = calls.filter((o) => !o.seedNodeIds.includes(ATTRIBUTE_SEED))
    expect(attribute).toHaveLength(1)
    expect(association).toHaveLength(1)
    return { attribute: attribute[0]!, association: association[0]! }
  }

  it('on: the association stage spreads with the fan effect, the attribute pass does not', async () => {
    vi.stubEnv('ENGRAM_RECALL_FAN', 'on')
    const { attribute, association } = split(await recallSpreadCalls())
    expect(association.fanEffect).toBe(true)
    expect(association.seedNodeIds).not.toContain(PROJECT_NODE)
    expect(attribute).not.toHaveProperty('fanEffect')
  })

  it('unset: no call carries fanEffect and the project node is seeded', async () => {
    vi.stubEnv('ENGRAM_RECALL_FAN', '')
    const { attribute, association } = split(await recallSpreadCalls())
    expect(association).not.toHaveProperty('fanEffect')
    expect(association.seedNodeIds).toContain(PROJECT_NODE)
    expect(attribute).not.toHaveProperty('fanEffect')
  })

  it('an invalid value fails the recall, naming the variable', async () => {
    vi.stubEnv('ENGRAM_RECALL_FAN', 'yes')
    await expect(recallSpreadCalls()).rejects.toThrow('ENGRAM_RECALL_FAN')
  })
})
