import { afterEach, describe, it, expect, vi } from 'vitest'
import { stageActivate } from '../../src/retrieval/spreading-activation.js'
import { stageReconsolidate } from '../../src/retrieval/reconsolidation.js'
import { recall } from '../../src/retrieval/engine.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import type { GraphActivatedNode, GraphPort } from '../../src/adapters/graph.js'
import type { LookupOptions, StorageAdapter } from '../../src/adapters/storage.js'
import type { AssociationManager } from '../../src/systems/association-manager.js'
import type { MemoryType, RecallStrategy, RetrievedMemory, TypedMemory } from '../../src/types.js'
import {
  createMockStorage,
  MOCK_DIGEST,
  MOCK_EPISODE,
  MOCK_PROCEDURAL,
  MOCK_SEMANTIC,
} from './mock-storage.js'

const STRATEGY = { mode: 'deep', associations: true } as unknown as RecallStrategy

const recalled: RetrievedMemory[] = [
  { id: 'seed-1', type: 'episode', content: 'seed', relevance: 0.9, source: 'recall', metadata: {} } as RetrievedMemory,
]

function memoryNode(nodeId: string, activation: number, memoryType?: string): GraphActivatedNode {
  return {
    nodeId,
    nodeType: 'Memory',
    activation,
    depth: 1,
    properties: memoryType === undefined ? {} : { memoryType },
  }
}

// Already in the graph's total order: activation desc, then graph rank.
const ACTIVATED: GraphActivatedNode[] = [
  memoryNode('seed-1', 0.9, 'episode'),
  { nodeId: 'person:sam', nodeType: 'Person', activation: 0.6, depth: 1, properties: { name: 'Sam' } },
  memoryNode('sem-live', 0.5, 'semantic'),
  memoryNode('ep-live', 0.4, 'episode'),
  memoryNode('sem-old', 0.35, 'semantic'),
  memoryNode('dig-live', 0.3, 'digest'),
  memoryNode('proc-live', 0.3, 'procedural'),
  memoryNode('no-type', 0.25),
  memoryNode('bad-type', 0.2, 'Entity'),
  memoryNode('sem-faint', 0.05, 'semantic'),
  memoryNode('ep-faint', 0.05, 'episode'),
  memoryNode('dig-gone', 0.04, 'digest'),
]
const PRIMARY = [
  ['sem-live', 'semantic'],
  ['ep-live', 'episode'],
  ['dig-live', 'digest'],
  ['proc-live', 'procedural'],
]
const FAINT = [
  ['sem-faint', 'semantic'],
  ['ep-faint', 'episode'],
]
// sem-old is superseded, no-type and bad-type carry no known tier, dig-gone
// has no row at all.
const MISSES = 4

interface StoredRow {
  typed: TypedMemory
  inactive: boolean
}

function row(id: string, type: MemoryType, inactive = false): StoredRow {
  switch (type) {
    case 'episode':
      return { typed: { type, data: { ...MOCK_EPISODE, id, content: `episode ${id}` } }, inactive }
    case 'digest':
      return { typed: { type, data: { ...MOCK_DIGEST, id, summary: `digest ${id}` } }, inactive }
    case 'semantic':
      return {
        typed: {
          type,
          data: { ...MOCK_SEMANTIC, id, content: `fact ${id}`, supersededBy: inactive ? 'sem-live' : null },
        },
        inactive,
      }
    case 'procedural':
      return { typed: { type, data: { ...MOCK_PROCEDURAL, id, procedure: `procedure ${id}` } }, inactive }
  }
}

const ROWS: StoredRow[] = [
  row('sem-live', 'semantic'),
  row('ep-live', 'episode'),
  row('sem-old', 'semantic', true),
  row('dig-live', 'digest'),
  row('proc-live', 'procedural'),
  // A row exists under this id, but the node names no tier to look it up in.
  row('no-type', 'episode'),
  row('sem-faint', 'semantic'),
  row('ep-faint', 'episode'),
]

// Mirrors the storage contract: a ref resolves only in its own tier, and the
// default lookup skips forgotten and superseded rows. Rows come back in
// reverse request order, as an unordered SQL lookup may return them.
function tieredGetByIds(rows: StoredRow[]) {
  return vi.fn(async (refs: Array<{ id: string; type: MemoryType }>, opts?: LookupOptions) =>
    refs
      .flatMap((ref) => {
        const hit = rows.find((r) => r.typed.data.id === ref.id && r.typed.type === ref.type)
        return hit && (opts?.includeInactive === true || !hit.inactive) ? [hit.typed] : []
      })
      .reverse(),
  )
}

function fakeStorage() {
  const getByIds = tieredGetByIds(ROWS)
  const recordShown = {
    episode: vi.fn().mockResolvedValue(undefined),
    semantic: vi.fn().mockResolvedValue(undefined),
    procedural: vi.fn().mockResolvedValue(undefined),
  }
  const episodesGetByIds = vi.fn().mockResolvedValue([])
  const storage = {
    getByIds,
    episodes: { getByIds: episodesGetByIds, recordShown: recordShown.episode },
    semantic: { recordShown: recordShown.semantic },
    procedural: { recordShown: recordShown.procedural },
  } as unknown as StorageAdapter
  return { storage, getByIds, episodesGetByIds, recordShown }
}

function fakeGraph(nodes: GraphActivatedNode[] = ACTIVATED): GraphPort {
  return {
    lookupEntityNodes: vi.fn().mockResolvedValue([]),
    spreadActivation: vi.fn().mockResolvedValue(nodes),
  } as unknown as GraphPort
}

async function activate(storage: StorageAdapter) {
  const result = await stageActivate(recalled, 'plain query', fakeGraph(), STRATEGY, storage)
  if (result === null) throw new Error('expected an activation result')
  return result
}

const idAndType = (m: RetrievedMemory) => [m.id, m.type]

describe('stageActivate — Related hydrates every live tier', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders live rows of every tier, in activation then graph-rank order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage } = fakeStorage()

    const result = await activate(storage)

    expect(result.associations.map(idAndType)).toEqual(PRIMARY)
    expect(result.context.faintAssociations.map(idAndType)).toEqual(FAINT)
    const byId = new Map(result.associations.map((m) => [m.id, m]))
    expect(byId.get('sem-live')?.content).toBe('fact sem-live')
    expect(byId.get('dig-live')?.content).toBe('digest dig-live')
    expect(byId.get('proc-live')?.content).toBe('procedure proc-live')
    expect(byId.get('sem-live')?.source).toBe('association')
    expect(byId.get('sem-live')?.relevance).toBeCloseTo(0.5)
    expect(byId.get('sem-live')?.metadata['graphActivation']).toBeCloseTo(0.5)
  })

  it('never renders the superseded fact, the recalled seed or an untyped node', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage } = fakeStorage()

    const result = await activate(storage)

    const shown = [...result.associations, ...result.context.faintAssociations].map((m) => m.id)
    for (const id of ['sem-old', 'seed-1', 'no-type', 'bad-type', 'dig-gone']) {
      expect(shown).not.toContain(id)
    }
  })

  it('loads every candidate in one typed lookup with the default options', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage, getByIds, episodesGetByIds } = fakeStorage()

    await activate(storage)

    expect(getByIds).toHaveBeenCalledTimes(1)
    expect(episodesGetByIds).not.toHaveBeenCalled()
    const [refs, opts] = getByIds.mock.calls[0]!
    expect(opts).toBeUndefined()
    expect(refs).toEqual([
      { id: 'sem-live', type: 'semantic' },
      { id: 'ep-live', type: 'episode' },
      { id: 'sem-old', type: 'semantic' },
      { id: 'dig-live', type: 'digest' },
      { id: 'proc-live', type: 'procedural' },
      { id: 'sem-faint', type: 'semantic' },
      { id: 'ep-faint', type: 'episode' },
      { id: 'dig-gone', type: 'digest' },
    ])
  })

  it('counts every miss and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage } = fakeStorage()

    const result = await activate(storage)

    expect(result.relatedUnhydrated).toBe(MISSES)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(`${MISSES} activated memories not hydrated`)
    expect(String(warn.mock.calls[0]![0])).toContain('2 without a known memoryType')
    expect(String(warn.mock.calls[0]![0])).toContain('2 not returned by their tier')
  })

  it('stays silent and reports zero when every candidate hydrates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = { getByIds: tieredGetByIds(ROWS) } as unknown as StorageAdapter
    const nodes = [memoryNode('sem-live', 0.5, 'semantic'), memoryNode('ep-live', 0.4, 'episode')]

    const result = await stageActivate(recalled, 'plain query', fakeGraph(nodes), STRATEGY, storage)

    expect(result?.relatedUnhydrated).toBe(0)
    expect(result?.associations.map((m) => m.id)).toEqual(['sem-live', 'ep-live'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reconsolidation records exposure in each memory’s own tier', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage, recordShown } = fakeStorage()
    const result = await activate(storage)

    stageReconsolidate(recalled, result.associations, storage, {} as AssociationManager, null, {
      coRecall: false,
      graphReinforce: false,
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(recordShown.episode).toHaveBeenCalledWith(['seed-1', 'ep-live'])
    expect(recordShown.semantic).toHaveBeenCalledWith(['sem-live'])
    expect(recordShown.procedural).toHaveBeenCalledWith(['proc-live'])
  })
})

describe('recall — Related tiers and the miss count', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('renders a semantic fact under its own tier tag and records the misses in timings', async () => {
    vi.stubEnv('ENGRAM_RECALL_TIMING', '1')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = createMockStorage()
    storage.getByIds = tieredGetByIds([...ROWS, row(MOCK_EPISODE.id, 'episode')])
    const graph = {
      findMatchingContextNodes: vi.fn().mockResolvedValue([]),
      lookupEntityNodes: vi.fn().mockResolvedValue([]),
      spreadActivation: vi.fn().mockResolvedValue([
        memoryNode('sem-live', 0.5, 'semantic'),
        memoryNode('sem-old', 0.45, 'semantic'),
        memoryNode('no-type', 0.4),
      ]),
      strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined),
    } as unknown as GraphPort

    const result = await recall('TypeScript strict mode', storage, new SensoryBuffer(), {
      strategy: RECALL_STRATEGIES.deep,
      embedding: [0.1, 0.2, 0.3],
      graph,
      reconsolidate: false,
    })

    expect(result.associations.map(idAndType)).toEqual([['sem-live', 'semantic']])
    expect(result.formatted).toContain('### Related Memories')
    expect(result.formatted).toMatch(/- \[semantic[^\]]*\] fact sem-live/)
    expect(result.formatted).not.toContain('sem-old')
    expect(result.timings?.['relatedUnhydrated']).toBe(2)
  })
})
