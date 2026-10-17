import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  RecallAbortedError,
  runRecall,
  type FloorCalibration,
  type RecallDeps,
  type RecallItemRow,
  type RecallStore,
} from '@engram-mem/core'

// The recall pipeline and the ONNX reranker's queue are tested apart against
// one contract; this runs them together. The transformers runtime is stubbed
// with a forward pass the test settles by hand, so it decides which recall's
// pass is running and which waits.

const stub = vi.hoisted(() => ({ pending: [] as Array<() => void> }))

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: async () => ({ _call: () => ({}) }),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: async () => ({
      _call: () =>
        new Promise<{ logits: { data: Float32Array } }>((resolve) => {
          stub.pending.push(() => resolve({ logits: { data: Float32Array.from([2]) } }))
        }),
    }),
  },
}))

import { createOnnxReranker } from '../src/index.js'

const RERANKER_ID = 'tst-onnx-reranker'
const FLOOR: FloorCalibration = {
  reranker: RERANKER_ID,
  floor: 0.3,
  strong: 0.7,
  calibratedAt: '2026-02-03T04:00:00Z',
  dataset: 'tst',
  neededInSlate: 0,
  neededBelowFloor: 0,
}
const T0 = new Date('2026-02-03T04:00:00Z')

function row(id: string): RecallItemRow {
  return {
    id,
    class: 'mk_statement',
    kind: 'ruling',
    speaker: 'mk',
    trust: 0,
    projectId: null,
    workspaceId: null,
    planSlug: null,
    sessionId: null,
    subjectLabel: null,
    contentHead: `text of ${id}`,
    contentLength: 10,
    question: null,
    searchHead: `search ${id}`,
    occurredAt: T0,
    supersededBy: null,
    retired: false,
    restated: 0,
    source: { type: 'transcript' },
    requested: true,
    currentId: id,
    chain: 'current',
    endExcluded: false,
  }
}

function recallDeps(rerank: ReturnType<typeof createOnnxReranker>, ids: string[]): RecallDeps {
  const rows = new Map(ids.map((id) => [id, row(id)]))
  const store: RecallStore = {
    candidates: async () => ids.map((itemId, i) => ({ itemId, leg: 'bm25' as const, rank: i + 1, rawScore: 1, path: null })),
    items: async (wanted) => wanted.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : [])),
    associations: async () => [],
    registerTokens: async () => [],
    storeVersion: async () => 1,
    itemStates: async () => [],
    projectWorkspace: async () => null,
    projects: async () => [],
    cacheGet: async () => [],
    cachePut: async (_step, key, version, output) => ({
      key,
      version,
      vector: output.vector ? [...output.vector] : null,
      phrases: output.phrases ? [...output.phrases] : null,
      passage: output.passage ?? null,
    }),
  }
  return {
    store,
    embed: async () => [1, 0, 0],
    rerank: { id: RERANKER_ID, rerank: (query, documents, options) => rerank.rerank(query, documents, options) },
    referenceDate: (now) => now.toISOString().slice(0, 10),
    floor: FLOOR,
    versions: { embedding: 'openai:tst:3', chat: 'tst-chat:1' },
    now: () => T0,
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function settleNextPass(): Promise<void> {
  for (let i = 0; i < 50 && stub.pending.length === 0; i++) await flush()
  const next = stub.pending.shift()
  if (!next) throw new Error('no forward pass is waiting')
  next()
  await flush()
}

describe('recall runs on the queueing reranker', () => {
  beforeEach(() => {
    stub.pending.length = 0
  })

  it('stops a recall whose caller leaves while its slate waits, with the time it waited, and the running recall completes', async () => {
    const reranker = createOnnxReranker()
    await reranker.load()
    const leaving = new AbortController()

    const running = runRecall(recallDeps(reranker, ['b1', 'b2']), { query: 'tst running', channel: 'mcp', scope: {} })
    for (let i = 0; i < 50 && stub.pending.length === 0; i++) await flush()
    const waitingFrom = performance.now()
    const waiting = runRecall(recallDeps(reranker, ['a1', 'a2']), { query: 'tst waiting', channel: 'mcp', scope: {} }, { signal: leaving.signal })
    const waitingOutcome = waiting.then(
      () => null,
      (error: unknown) => error,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const leftAt = performance.now()
    leaving.abort()

    const error = await waitingOutcome
    expect(error).toBeInstanceOf(RecallAbortedError)
    expect((error as RecallAbortedError).stage).toBe('slate-rerank')
    expect((error as RecallAbortedError).queueMs).toBeGreaterThan(0)
    expect((error as RecallAbortedError).queueMs).toBeLessThanOrEqual(leftAt - waitingFrom + 1)

    await settleNextPass()
    await settleNextPass()
    const { response, trace } = await running
    expect(response.items.map((i) => i.id)).toEqual(['b1', 'b2'])
    expect(response.degraded).toBeUndefined()
    expect(trace.timings.queue).toBeLessThan(5)
    expect(stub.pending).toHaveLength(0)
  })
})
