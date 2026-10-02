import { describe, it, expect, vi } from 'vitest'
import { stageActivate } from '../../src/retrieval/spreading-activation.js'
import { renderRecallPayload } from '../../src/retrieval/engine.js'
import { assemble } from '../../src/retrieval/output-policy.js'
import type { GraphActivatedNode, GraphPort } from '../../src/adapters/graph.js'
import type { StorageAdapter } from '../../src/adapters/storage.js'
import type { Episode, RecallStrategy, RetrievedMemory } from '../../src/types.js'

const STRATEGY = { mode: 'deep', associations: true } as unknown as RecallStrategy

const recalled: RetrievedMemory[] = [
  { id: 'seed-1', type: 'episode', content: 'seed', relevance: 0.9, source: 'recall', metadata: {} } as RetrievedMemory,
]

function memoryNode(nodeId: string, activation: number): GraphActivatedNode {
  return { nodeId, nodeType: 'Memory', activation, depth: 1, properties: { memoryType: 'episode' } }
}

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
    createdAt: new Date('2026-01-01T00:00:00Z'),
    projectId: null,
  } as Episode
}

// The graph's list is already totally ordered: activation desc, then newest
// createdAt, then id. Primary (>= 0.1) and faint (0.03..0.1) both carry ties.
const ACTIVATED: GraphActivatedNode[] = [
  memoryNode('p-top', 0.5),
  memoryNode('p-tie-c', 0.3),
  memoryNode('p-tie-a', 0.3),
  memoryNode('p-tie-d', 0.3),
  memoryNode('p-tie-b', 0.3),
  memoryNode('p-low', 0.2),
  memoryNode('f-tie-z', 0.05),
  memoryNode('f-tie-x', 0.05),
  memoryNode('f-tie-y', 0.05),
  memoryNode('f-low', 0.04),
]
const PRIMARY_ORDER = ['p-top', 'p-tie-c', 'p-tie-a', 'p-tie-d', 'p-tie-b', 'p-low']
const FAINT_ORDER = ['f-tie-z', 'f-tie-x', 'f-tie-y', 'f-low']

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

// getByIds answers with the requested rows in a different, arbitrary order on
// each call, as an unordered SQL `IN (...)` lookup may.
function shufflingStorage(seed: number): StorageAdapter {
  return {
    getByIds: vi.fn().mockImplementation(async (refs: Array<{ id: string }>) =>
      shuffled(refs.map((ref) => ({ type: 'episode' as const, data: ep(ref.id) })), seed),
    ),
  } as unknown as StorageAdapter
}

function graph(): GraphPort {
  return {
    lookupEntityNodes: vi.fn().mockResolvedValue([]),
    spreadActivation: vi.fn().mockResolvedValue(ACTIVATED),
  } as unknown as GraphPort
}

async function activate(seed: number) {
  const result = await stageActivate(recalled, 'plain query', graph(), STRATEGY, shufflingStorage(seed))
  if (result === null) throw new Error('expected an activation result')
  return result
}

describe('stageActivate — Related order after hydration', () => {
  it('hydration returns the rows out of the graph order', async () => {
    const storage = shufflingStorage(7)
    const rows = await storage.getByIds(PRIMARY_ORDER.map((id) => ({ id, type: 'episode' as const })))
    expect(rows.map((r) => r.data.id)).not.toEqual(PRIMARY_ORDER)
  })

  it('associations follow the activation order, ties broken by graph rank', async () => {
    for (const seed of [1, 7, 42, 99]) {
      const result = await activate(seed)
      expect(result.associations.map((a) => a.id)).toEqual(PRIMARY_ORDER)
      expect(result.context.faintAssociations.map((a) => a.id)).toEqual(FAINT_ORDER)
    }
  })

  it('two recalls with different hydration orders render byte-identical Related text', async () => {
    const first = await activate(3)
    const second = await activate(11)

    const render = (r: Awaited<ReturnType<typeof activate>>) =>
      assemble(renderRecallPayload(recalled, r.associations, r.context, [])).text

    const a = render(first)
    expect(a).toContain('### Related Memories')
    expect(a).toContain('### Faint Associations')
    expect(render(second)).toBe(a)
  })
})
