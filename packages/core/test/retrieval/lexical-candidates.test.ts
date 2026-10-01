import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recall } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type { Episode, MemoryType, SearchResult, TypedMemory } from '../../src/types.js'
import { createMockStorage } from './mock-storage.js'

// A ticket-key query whose key-bearing memories are not among the nearest
// embedding neighbours. The vector leg returns 120 neighbours that mention
// other tickets; the lexical leg returns 25 exact-key matches that the vector
// leg missed. Every row shares recency, access count and role, so ordering is
// decided by cosine and lexical boost alone.

const QUERY = 'ACA-2613'
const KEY = 'ACA-2613'
const DIMS = 8
const NEIGHBOUR_COUNT = 120
const KEYED_COUNT = 25
const MAX_RESULTS = RECALL_STRATEGIES.light.maxResults

/** Unit vector whose cosine to the query vector e0 is exactly `c`. */
function unitAt(c: number): number[] {
  const v = new Array<number>(DIMS).fill(0)
  v[0] = c
  v[1] = Math.sqrt(1 - c * c)
  return v
}

const QUERY_EMBEDDING = unitAt(1)

const TOPICS = [
  'renewal calendar export columns', 'portfolio drilldown counts', 'vendor spend rollup',
  'license entitlement import', 'contract owner reassignment', 'hardware warranty sync',
  'cloud cost anomaly alert', 'software catalog dedupe', 'approval workflow timeout',
  'tenant onboarding checklist', 'dashboard tile latency', 'csv upload validation',
]

function episode(id: string, content: string, cosine: number, createdAt: Date): Episode {
  return {
    id,
    sessionId: `sess-${id}`,
    role: 'user',
    content,
    salience: 0.5,
    accessCount: 0,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: unitAt(cosine),
    entities: [],
    metadata: {},
    createdAt,
    projectId: null,
  }
}

interface Fixture {
  neighbours: Episode[]
  keyed: Episode[]
  vectorResults: SearchResult<TypedMemory>[]
  textBoostResults: Array<{ id: string; type: MemoryType; boost: number }>
}

function buildFixture(): Fixture {
  const createdAt = new Date(Date.now() - 24 * 3_600_000)

  const neighbours: Episode[] = []
  const vectorResults: SearchResult<TypedMemory>[] = []
  for (let i = 0; i < NEIGHBOUR_COUNT; i++) {
    // Even ticket numbers only, so no neighbour carries the odd queried key.
    const ticket = `ACA-${2400 + i * 2}`
    const topic = TOPICS[i % TOPICS.length]
    const similarity = 0.55 - (0.15 * i) / (NEIGHBOUR_COUNT - 1)
    const ep = episode(`nb-${i}`, `${ticket} ${topic} note ${i}`, similarity, createdAt)
    neighbours.push(ep)
    vectorResults.push({ item: { type: 'episode', data: ep }, similarity })
  }

  const keyed: Episode[] = []
  const textBoostResults: Array<{ id: string; type: MemoryType; boost: number }> = []
  for (let i = 0; i < KEYED_COUNT; i++) {
    const cosine = 0.45 - (0.05 * i) / (KEYED_COUNT - 1)
    const boost = 1.0 - (0.7 * i) / (KEYED_COUNT - 1)
    const topic = TOPICS[(i + 5) % TOPICS.length]
    const ep = episode(`key-${i}`, `${KEY} ${topic} detail ${i}`, cosine, createdAt)
    keyed.push(ep)
    textBoostResults.push({ id: ep.id, type: 'episode', boost })
  }

  return { neighbours, keyed, vectorResults, textBoostResults }
}

function buildStorage(fx: Fixture) {
  const storage = createMockStorage({
    vectorSearchResults: fx.vectorResults,
    textBoostResults: fx.textBoostResults,
  })
  const byId = new Map<string, TypedMemory>(
    [...fx.neighbours, ...fx.keyed].map((ep) => [ep.id, { type: 'episode', data: ep }]),
  )
  storage.getById = vi.fn(async (id: string) => byId.get(id) ?? null)
  storage.getByIds = vi.fn(async (refs: Array<{ id: string; type: MemoryType }>) =>
    refs.flatMap((r) => {
      const m = byId.get(r.id)
      return m ? [m] : []
    }),
  )
  return storage
}

function rerankSpy() {
  const received: Array<{ id: string; content: string }> = []
  const rerank = vi.fn(async (_query: string, docs: ReadonlyArray<{ id: string; content: string }>) => {
    received.push(...docs)
    return docs.map((d) => ({ id: d.id, score: d.content.includes(KEY) ? 0.9 : 0.8 }))
  })
  return { rerank, received }
}

const isKeyed = (content: string) => content.includes(KEY)

async function runRecall(intelligence?: IntelligenceAdapter) {
  const fx = buildFixture()
  const storage = buildStorage(fx)
  return recall(QUERY, storage, new SensoryBuffer(), {
    strategy: RECALL_STRATEGIES.light,
    embedding: QUERY_EMBEDDING,
    ...(intelligence ? { intelligence } : {}),
  })
}

// Output of the recall with no reranker, recorded once lexical-only candidates
// were scored on their true cosine. Twelve key-bearing rows enter the result:
// cosine plus the lexical boost now lets the strongest exact matches outrank
// mid-list neighbours. Without a reranker the pipeline must stay byte-identical
// from here on.
const NO_RERANK_IDS: string[] = [
  'key-0', 'nb-0', 'key-1', 'key-2', 'key-3', 'nb-1', 'key-4', 'key-5', 'key-6', 'nb-2',
  'nb-3', 'nb-4', 'key-8', 'nb-5', 'key-9', 'nb-7', 'nb-8', 'nb-9', 'nb-10', 'nb-11',
  'key-10', 'key-11', 'key-7', 'nb-6', 'nb-12', 'nb-13', 'nb-14', 'nb-15', 'nb-16', 'nb-17',
]

const MMR_ENV = ['ENGRAM_MMR_PRE_RERANK', 'ENGRAM_MMR_LAMBDA', 'ENGRAM_MMR_MAX_CANDIDATES'] as const

describe('lexical-only candidates and the reranker', () => {
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const k of MMR_ENV) {
      saved.set(k, process.env[k])
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of MMR_ENV) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it.fails('at least 15 key-bearing docs reach the reranker', async () => {
    const { rerank, received } = rerankSpy()
    await runRecall({ rerank } as IntelligenceAdapter)
    expect(rerank).toHaveBeenCalledTimes(1)
    expect(received.length).toBeGreaterThan(0)
    const keyedReceived = received.filter((d) => isKeyed(d.content)).length
    expect(keyedReceived).toBeGreaterThanOrEqual(15)
  })

  it.fails('at least 15 key-bearing items are in the final results', async () => {
    const { rerank } = rerankSpy()
    const result = await runRecall({ rerank } as IntelligenceAdapter)
    const keyedOut = result.memories.filter((m) => isKeyed(m.content)).length
    expect(keyedOut).toBeGreaterThanOrEqual(15)
  })

  it('without a reranker the output ids and order are unchanged', async () => {
    const result = await runRecall()
    expect(result.memories.map((m) => m.id)).toEqual(NO_RERANK_IDS)
  })

  it('the output never exceeds the strategy result size', async () => {
    const { rerank } = rerankSpy()
    const withRerank = await runRecall({ rerank } as IntelligenceAdapter)
    const without = await runRecall()
    expect(withRerank.memories.length).toBeLessThanOrEqual(MAX_RESULTS)
    expect(without.memories.length).toBeLessThanOrEqual(MAX_RESULTS)
  })
})
