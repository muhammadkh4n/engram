import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the transformers runtime so these tests never download or load an
// ONNX model. The stub records which model id was requested and returns
// whatever logits the test queues.
const calls = vi.hoisted(() => ({
  tokenizerModels: [] as string[],
  modelLoads: [] as Array<{ model: string; options: unknown }>,
  nextLogits: [] as number[],
}))

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: async (model: string) => {
      calls.tokenizerModels.push(model)
      return { _call: (queries: string[]) => ({ pairs: queries.length }) }
    },
  },
  AutoModelForSequenceClassification: {
    from_pretrained: async (model: string, options: unknown) => {
      calls.modelLoads.push({ model, options })
      return {
        _call: async () => ({ logits: { data: Float32Array.from(calls.nextLogits) } }),
      }
    },
  },
}))

import { createOnnxReranker, DEFAULT_RERANK_MODEL } from '../src/index.js'

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

describe('createOnnxReranker defaults and scoring (stubbed runtime)', () => {
  beforeEach(() => {
    calls.tokenizerModels.length = 0
    calls.modelLoads.length = 0
    calls.nextLogits = []
  })

  it('defaults to gte-reranker-modernbert-base at q8', async () => {
    expect(DEFAULT_RERANK_MODEL).toBe('Alibaba-NLP/gte-reranker-modernbert-base')
    const reranker = createOnnxReranker()
    await reranker.load()
    expect(calls.tokenizerModels).toEqual(['Alibaba-NLP/gte-reranker-modernbert-base'])
    expect(calls.modelLoads).toEqual([
      { model: 'Alibaba-NLP/gte-reranker-modernbert-base', options: { dtype: 'q8' } },
    ])
  })

  it('loads an explicitly requested model instead of the default', async () => {
    const reranker = createOnnxReranker({ model: 'mixedbread-ai/mxbai-rerank-large-v1' })
    await reranker.load()
    expect(calls.modelLoads[0]!.model).toBe('mixedbread-ai/mxbai-rerank-large-v1')
  })

  it.each([
    ['Alibaba-NLP/gte-reranker-modernbert-base'],
    ['mixedbread-ai/mxbai-rerank-large-v1'],
  ])('maps one logit per pair through a sigmoid for %s', async model => {
    calls.nextLogits = [2.5, -1.25, 0]
    const reranker = createOnnxReranker({ model })
    const result = await reranker.rerank('q', [
      { id: 'a', content: 'alpha' },
      { id: 'b', content: 'beta' },
      { id: 'c', content: 'gamma' },
    ])
    expect(result.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(result[0]!.score).toBeCloseTo(sigmoid(2.5), 6)
    expect(result[1]!.score).toBeCloseTo(sigmoid(-1.25), 6)
    expect(result[2]!.score).toBeCloseTo(0.5, 6)
  })

  it('rejects a head that emits more than one logit per pair', async () => {
    calls.nextLogits = [0.1, 0.9, 0.2, 0.8]
    const reranker = createOnnxReranker()
    await expect(
      reranker.rerank('q', [
        { id: 'a', content: 'alpha' },
        { id: 'b', content: 'beta' },
      ]),
    ).rejects.toThrow(/expected one logit per pair/)
  })
})
