import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createOnnxReranker, type OnnxReranker } from '../src/index.js'

// First-run model download can be slow (~50-200MB depending on dtype).
// Subsequent runs hit the HF cache under ~/.cache/huggingface.
// xsmall keeps the test lightweight; the behavioural assertions are model-agnostic.
const TEST_MODEL = 'mixedbread-ai/mxbai-rerank-xsmall-v1'

describe('createOnnxReranker', () => {
  let reranker: OnnxReranker

  beforeAll(async () => {
    reranker = createOnnxReranker({
      model: TEST_MODEL,
      dtype: 'q8',
      batchSize: 4,
    })
    await reranker.load()
  }, 180000)

  afterAll(async () => {
    await reranker.dispose()
  })

  it('loads the model', () => {
    expect(reranker.isReady).toBe(true)
  })

  it('returns empty array for no documents', async () => {
    const result = await reranker.rerank('whatever', [])
    expect(result).toEqual([])
  })

  it('returns perfect score for a single document', async () => {
    const result = await reranker.rerank('anything', [{ id: 'x', content: 'the quick brown fox' }])
    expect(result).toEqual([{ id: 'x', score: 1.0 }])
  })

  it('scores a relevant doc higher than an irrelevant one', async () => {
    const query = 'How many legs does a dog have?'
    const docs = [
      { id: 'relevant', content: 'A dog has four legs.' },
      { id: 'irrelevant', content: 'The Eiffel Tower is located in Paris.' },
    ]
    const result = await reranker.rerank(query, docs)
    const byId = Object.fromEntries(result.map(r => [r.id, r.score]))
    expect(byId['relevant']).toBeGreaterThan(byId['irrelevant']!)
    // Sanity: relevant should be clearly strong, irrelevant clearly weak
    expect(byId['relevant']).toBeGreaterThan(0.5)
    expect(byId['irrelevant']).toBeLessThan(0.5)
  })

  it('handles multiple batches', async () => {
    const query = 'What color is grass?'
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `doc-${i}`,
      content: i === 3 ? 'Grass is typically green.' : `Random unrelated fact number ${i}.`,
    }))
    const result = await reranker.rerank(query, docs)
    expect(result).toHaveLength(10)
    // Every input id appears in the output exactly once
    const ids = new Set(result.map(r => r.id))
    expect(ids.size).toBe(10)
    // doc-3 should score highest
    const topScoringId = result.reduce((a, b) => (b.score > a.score ? b : a)).id
    expect(topScoringId).toBe('doc-3')
  })

  it('respects maxCandidates cap', async () => {
    const capped = createOnnxReranker({ model: TEST_MODEL, dtype: 'q8', maxCandidates: 3 })
    // Reuse loaded model? No — createOnnxReranker loads its own. Dispose after.
    try {
      const docs = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, content: `fact ${i}` }))
      const result = await capped.rerank('query', docs)
      expect(result).toHaveLength(3)
      expect(result.map(r => r.id)).toEqual(['d0', 'd1', 'd2'])
    } finally {
      await capped.dispose()
    }
  }, 180000)
})
