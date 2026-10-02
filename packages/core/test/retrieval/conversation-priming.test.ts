import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Memory } from '../../src/memory.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { Episode, SearchResult, TypedMemory, IntentResult } from '../../src/types.js'
import type { ConversationStore } from '../../src/systems/sensory-buffer.js'
import type { HeuristicIntentAnalyzer } from '../../src/intent/analyzer.js'
import { createMockStorage, MOCK_EPISODE } from './mock-storage.js'

// Three rows that share "zebra" (primed after one recall) and a row that only
// contains it inside a longer word.
function episode(id: string, content: string): Episode {
  return { ...MOCK_EPISODE, id, content, createdAt: new Date(Date.now() - 3_600_000) }
}

const ROWS: SearchResult<TypedMemory>[] = [
  { item: { type: 'episode', data: episode('z1', 'zebra paddock fence repaired') }, similarity: 0.8 },
  { item: { type: 'episode', data: episode('z2', 'zebra feeding moved to dawn') }, similarity: 0.7 },
  { item: { type: 'episode', data: episode('z3', 'vet checked the zebra herd') }, similarity: 0.6 },
  { item: { type: 'episode', data: episode('w1', 'zebrafish tank cleaned') }, similarity: 0.65 },
]

const QUERY = 'what did we decide about the paddock'
const RECALL = { embedding: [0.1, 0.2, 0.3], reconsolidate: false, strategyOverride: RECALL_STRATEGIES.deep } as const

interface Harness {
  memory: Memory
  store: ConversationStore
  lookupEntityNodes: ReturnType<typeof vi.fn>
  analyze: ReturnType<typeof vi.spyOn>
}

async function harness(): Promise<Harness> {
  const lookupEntityNodes = vi.fn().mockResolvedValue([])
  const graph = {
    isAvailable: vi.fn().mockResolvedValue(true),
    lookupEntityNodes,
    spreadActivation: vi.fn().mockResolvedValue([]),
  } as unknown as GraphPort
  const memory = new Memory({ storage: createMockStorage({ vectorSearchResults: ROWS, textBoostResults: [] }), graph })
  await memory.initialize()
  const internals = memory as unknown as { conversations: ConversationStore; intentAnalyzer: HeuristicIntentAnalyzer }
  const analyze = vi.spyOn(internals.intentAnalyzer, 'analyze')
  return { memory, store: internals.conversations, lookupEntityNodes, analyze }
}

// Recency decays with the wall clock between recalls, so equal scores agree
// to about 1e-9, far below the smallest priming boost (0.15 before blending).
function relevanceOf(result: { memories: Array<{ id: string; relevance: number }> }, id: string): number {
  const hit = result.memories.find((m) => m.id === id)
  if (!hit) throw new Error(`${id} not recalled`)
  return hit.relevance
}

/** Calls to lookupEntityNodes that carried primed context topics. */
function contextLookups(lookup: ReturnType<typeof vi.fn>): string[][] {
  return lookup.mock.calls.map((c) => c[0] as string[]).filter((topics) => topics.includes('zebra'))
}

function lastContext(analyze: ReturnType<typeof vi.spyOn>): { activeIntent: IntentResult | null; primedTopics: string[] } {
  const calls = analyze.mock.calls
  return calls[calls.length - 1]![1] as { activeIntent: IntentResult | null; primedTopics: string[] }
}

describe('Memory.recall — priming is scoped to one conversation', () => {
  let h: Harness
  const savedSwitch = process.env['ENGRAM_RECALL_PRIMING']

  beforeEach(async () => {
    delete process.env['ENGRAM_RECALL_PRIMING']
    h = await harness()
  })

  afterEach(async () => {
    if (savedSwitch === undefined) delete process.env['ENGRAM_RECALL_PRIMING']
    else process.env['ENGRAM_RECALL_PRIMING'] = savedSwitch
    await h.memory.dispose()
  })

  it('a recall with no key gets no boost and writes no state', async () => {
    const first = await h.memory.recall(QUERY, RECALL)
    const second = await h.memory.recall(QUERY, RECALL)

    expect(first.primed).toEqual([])
    expect(second.primed).toEqual([])
    expect(relevanceOf(second, 'z1')).toBeCloseTo(relevanceOf(first, 'z1'), 6)
    expect(h.store.size()).toBe(0)
    expect(contextLookups(h.lookupEntityNodes)).toEqual([])
    expect(lastContext(h.analyze)).toEqual({ activeIntent: null, primedTopics: [] })
  })

  it('two keys do not see each other\'s priming boost, context topics or intent', async () => {
    const baseline = await h.memory.recall(QUERY, RECALL)
    const primingA = await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    expect(primingA.primed).toContain('zebra')
    h.lookupEntityNodes.mockClear()

    const b = await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-b' })
    expect(relevanceOf(b, 'z1')).toBeCloseTo(relevanceOf(baseline, 'z1'), 6)
    expect(contextLookups(h.lookupEntityNodes)).toEqual([])
    expect(lastContext(h.analyze)).toEqual({ activeIntent: null, primedTopics: [] })

    const a = await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    expect(relevanceOf(a, 'z1')).toBeGreaterThan(relevanceOf(baseline, 'z1'))
    expect(contextLookups(h.lookupEntityNodes)).toHaveLength(1)
    const context = lastContext(h.analyze)
    expect(context.activeIntent).toEqual(primingA.intent)
    expect(context.primedTopics).toContain('zebra')
    expect(h.store.keys().sort()).toEqual(['conv-a', 'conv-b'])
  })

  it('boosts whole tokens only: a primed "zebra" does not lift "zebrafish"', async () => {
    const baseline = await h.memory.recall(QUERY, RECALL)
    await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    const a = await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    expect(relevanceOf(a, 'w1')).toBeCloseTo(relevanceOf(baseline, 'w1'), 6)
    expect(relevanceOf(a, 'z1')).toBeGreaterThan(relevanceOf(baseline, 'z1'))
  })

  it('ENGRAM_RECALL_PRIMING=off disables priming, context topics and intent even with a key', async () => {
    process.env['ENGRAM_RECALL_PRIMING'] = 'off'
    const baseline = await h.memory.recall(QUERY, RECALL)
    const first = await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    const second = await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })

    expect(first.primed).toEqual([])
    expect(relevanceOf(second, 'z1')).toBeCloseTo(relevanceOf(baseline, 'z1'), 6)
    expect(contextLookups(h.lookupEntityNodes)).toEqual([])
    expect(lastContext(h.analyze)).toEqual({ activeIntent: null, primedTopics: [] })
    expect(h.store.size()).toBe(0)
  })

  it('reads the switch on every recall', async () => {
    process.env['ENGRAM_RECALL_PRIMING'] = 'off'
    await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    expect(h.store.size()).toBe(0)
    process.env['ENGRAM_RECALL_PRIMING'] = 'on'
    const primed = await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    expect(primed.primed).toContain('zebra')
    expect(h.store.keys()).toEqual(['conv-a'])
  })

  it('an unknown switch value throws, with or without a key', async () => {
    process.env['ENGRAM_RECALL_PRIMING'] = 'maybe'
    await expect(h.memory.recall(QUERY, RECALL)).rejects.toThrow(/ENGRAM_RECALL_PRIMING must be "on" or "off"/)
    await expect(h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })).rejects.toThrow(/ENGRAM_RECALL_PRIMING/)
  })

  it('a blank key is rejected rather than treated as a conversation', async () => {
    await expect(h.memory.recall(QUERY, { ...RECALL, conversationKey: '  ' })).rejects.toThrow(/conversationKey/)
    expect(h.store.size()).toBe(0)
  })

  it('a key\'s priming lapses after its own five recalls, not other keys\'', async () => {
    await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    const other = { ...RECALL, conversationKey: 'conv-b', embedding: [0.3, 0.2, 0.1] }
    for (let i = 0; i < 6; i++) await h.memory.recall('unrelated chatter', { ...other, strategyOverride: RECALL_STRATEGIES.light })
    expect(h.store.peek('conv-a')?.getPrimed().find((p) => p.topic === 'zebra')?.turnsRemaining).toBe(4)
  })

  it('forget() previews neither read nor prime any conversation', async () => {
    await h.memory.recall(QUERY, { ...RECALL, conversationKey: 'conv-a' })
    const before = h.store.peek('conv-a')?.getPrimed().map((p) => ({ ...p }))
    await h.memory.forget('zebra paddock')
    expect(h.store.keys()).toEqual(['conv-a'])
    expect(h.store.peek('conv-a')?.getPrimed()).toEqual(before)
  })

  it('a session handle uses its session id as the conversation key', async () => {
    const session = h.memory.session('sess-77')
    await session.recall(QUERY, RECALL)
    expect(h.store.keys()).toEqual(['sess-77'])
  })
})
