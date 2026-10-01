import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createOnnxReranker, type OnnxReranker } from '../src/index.js'
import { buildMixedLengthSlate, MIXED_LENGTH_QUERY, type SlateDocument } from './fixtures/mixed-length-slate.js'

// Opt-in: loads the default reranker (gte-reranker-modernbert-base, q8),
// downloading about 150 MB of public weights on the first run, and scores
// the 45-document slate nine times over (405 forward passes). Run it with
//
//   ENGRAM_RERANK_REAL_MODEL=1 npx vitest run test/real-model-batch-invariance.test.ts
//
// from packages/rerank-onnx.
const enabled = process.env.ENGRAM_RERANK_REAL_MODEL === '1'
const TOLERANCE = 1e-6

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function ranking(scores: ReadonlyMap<string, number>): string[] {
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)! || a.localeCompare(b))
}

describe.skipIf(!enabled)('real-model rerank scores do not depend on the slate', () => {
  let reranker: OnnxReranker
  const slate = buildMixedLengthSlate()

  beforeAll(async () => {
    reranker = createOnnxReranker()
    await reranker.load()
  }, 600_000)

  afterAll(async () => {
    await reranker.dispose()
  })

  async function scoreCalls(calls: SlateDocument[][]): Promise<Map<string, number>> {
    const scores = new Map<string, number>()
    for (const call of calls) {
      for (const r of await reranker.rerank(MIXED_LENGTH_QUERY, call)) scores.set(r.id, r.score)
    }
    return scores
  }

  it('gives every document the same score and rank alone, in order, shuffled and regrouped', async () => {
    const alone = await scoreCalls(slate.map(doc => [doc]))
    expect(alone.size).toBe(slate.length)

    const arrangements: Record<string, SlateDocument[][]> = {
      'whole slate': [slate],
      reversed: [[...slate].reverse()],
      'shuffled 1': [shuffled(slate, 1)],
      'shuffled 2': [shuffled(slate, 2)],
      'shuffled 3': [shuffled(slate, 3)],
      'groups of 8': chunks(slate, 8),
      'shuffled groups of 8': chunks(shuffled(slate, 4), 8),
      'shuffled groups of 5': chunks(shuffled(slate, 5), 5),
    }

    for (const [name, calls] of Object.entries(arrangements)) {
      const scores = await scoreCalls(calls)
      const drift = slate.map(doc => Math.abs(scores.get(doc.id)! - alone.get(doc.id)!))
      expect({ name, maxDrift: Math.max(...drift) <= TOLERANCE ? 0 : Math.max(...drift) }).toEqual({ name, maxDrift: 0 })
      expect({ name, ranking: ranking(scores) }).toEqual({ name, ranking: ranking(alone) })
    }
  }, 600_000)
})
