import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the transformers runtime so these tests never download or load an
// ONNX model. The tokenizer turns each whitespace-separated word into one
// token and pads every batch to its longest row on the configured side. The
// model's hidden state at sequence position t is supplied by `hiddenAt`, so a
// test can tell which position the embedder pooled.
const stub = vi.hoisted(() => ({
  hiddenSize: 8,
  paddingSide: 'right' as 'left' | 'right',
  tokenizerLoads: [] as string[],
  modelLoads: [] as Array<{ model: string; options: unknown }>,
  tokenizerCalls: [] as Array<{ texts: string[]; options: Record<string, unknown> }>,
  forwardBatchSizes: [] as number[],
  hiddenAt: (_row: number, _pos: number, size: number): number[] => new Array<number>(size).fill(1),
}))

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: async (model: string) => {
      stub.tokenizerLoads.push(model)
      return {
        _call: (texts: string[], options: Record<string, unknown>) => {
          stub.tokenizerCalls.push({ texts, options })
          const maxLength = Number(options['max_length'])
          const lengths = texts.map(t => Math.min(t.split(/\s+/).filter(Boolean).length, maxLength))
          const seq = Math.max(...lengths)
          const mask = new BigInt64Array(texts.length * seq)
          lengths.forEach((len, b) => {
            const first = stub.paddingSide === 'right' ? 0 : seq - len
            for (let t = first; t < first + len; t++) mask[b * seq + t] = 1n
          })
          return {
            input_ids: { data: new BigInt64Array(texts.length * seq), dims: [texts.length, seq], type: 'int64' },
            attention_mask: { data: mask, dims: [texts.length, seq], type: 'int64' },
          }
        },
      }
    },
  },
  AutoModel: {
    from_pretrained: async (model: string, options: unknown) => {
      stub.modelLoads.push({ model, options })
      return {
        config: { hidden_size: stub.hiddenSize },
        _call: async (inputs: { attention_mask: { dims: number[] } }) => {
          const [batch, seq] = inputs.attention_mask.dims as [number, number]
          stub.forwardBatchSizes.push(batch)
          const size = stub.hiddenSize
          const data = new Float32Array(batch * seq * size)
          for (let b = 0; b < batch; b++) {
            for (let t = 0; t < seq; t++) data.set(stub.hiddenAt(b, t, size), (b * seq + t) * size)
          }
          return { last_hidden_state: { data, dims: [batch, seq, size], type: 'float32' } }
        },
      }
    },
  },
}))

import {
  createOnnxEmbedder,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_QUERY_TASK,
} from '../src/index.js'

// One-hot at the sequence position, scaled so normalisation has work to do:
// the pooled vector's hot dimension is the position that was pooled.
const positionOneHot = (_row: number, pos: number, size: number): number[] => {
  const v = new Array<number>(size).fill(0)
  v[pos % size] = pos + 2
  return v
}

const hotIndex = (v: number[]): number => v.findIndex(x => x > 0.5)

const norm = (v: number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0))

beforeEach(() => {
  stub.hiddenSize = 8
  stub.paddingSide = 'right'
  stub.tokenizerLoads.length = 0
  stub.modelLoads.length = 0
  stub.tokenizerCalls.length = 0
  stub.forwardBatchSizes.length = 0
  stub.hiddenAt = positionOneHot
})

describe('createOnnxEmbedder: last-token pooling', () => {
  it('pools the last attended token of each right-padded row', async () => {
    const embedder = createOnnxEmbedder()
    const vectors = await embedder.embedBatch(['a b', 'a b c d e', 'a b c'])
    expect(stub.forwardBatchSizes).toEqual([3])
    expect(vectors.map(hotIndex)).toEqual([1, 4, 2])
  })

  it('pools the final position of each left-padded row', async () => {
    stub.paddingSide = 'left'
    const embedder = createOnnxEmbedder()
    const vectors = await embedder.embedBatch(['a b', 'a b c d e', 'a b c'])
    expect(vectors.map(hotIndex)).toEqual([4, 4, 4])
  })

  it('returns unit-norm vectors of the model hidden size', async () => {
    stub.hiddenAt = (row, pos, size) => Array.from({ length: size }, (_, h) => (row + 1) * 0.7 + pos * 1.3 - h * 0.4)
    const embedder = createOnnxEmbedder()
    const vectors = await embedder.embedBatch(['one', 'one two three', 'one two', 'four five six seven'])
    vectors.push(await embedder.embed('alpha beta'), await embedder.embedQuery('gamma'))
    for (const v of vectors) {
      expect(v).toHaveLength(8)
      expect(norm(v)).toBeCloseTo(1, 10)
    }
  })
})

describe('createOnnxEmbedder: query instruction', () => {
  it('prefixes queries with the instruction and leaves documents bare', async () => {
    const embedder = createOnnxEmbedder()
    await embedder.embedQuery('where did I park')
    await embedder.embed('parked on level 3')
    await embedder.embedBatch(['doc one', 'doc two'])
    expect(stub.tokenizerCalls.map(c => c.texts)).toEqual([
      [`Instruct: ${DEFAULT_EMBED_QUERY_TASK}\nQuery:where did I park`],
      ['parked on level 3'],
      ['doc one', 'doc two'],
    ])
  })

  it('uses the configured query task', async () => {
    const embedder = createOnnxEmbedder({ queryTask: 'Find the release notes' })
    await embedder.embedQuery('v2 changes')
    expect(stub.tokenizerCalls[0]!.texts).toEqual(['Instruct: Find the release notes\nQuery:v2 changes'])
  })

  it('applies the char guard to the query, never to the instruction', async () => {
    const embedder = createOnnxEmbedder({ maxChars: 5 })
    await embedder.embedQuery('abcdefghij')
    await embedder.embed('abcdefghij')
    expect(stub.tokenizerCalls.map(c => c.texts)).toEqual([
      [`Instruct: ${DEFAULT_EMBED_QUERY_TASK}\nQuery:abcde`],
      ['abcde'],
    ])
  })
})

describe('createOnnxEmbedder: batching and loading', () => {
  it('embeds 40 texts in 3 forward passes of up to 16, in input order', async () => {
    const embedder = createOnnxEmbedder()
    const texts = Array.from({ length: 40 }, (_, i) => Array.from({ length: (i % 6) + 1 }, () => 'w').join(' '))
    const vectors = await embedder.embedBatch(texts)
    expect(stub.forwardBatchSizes).toEqual([16, 16, 8])
    expect(vectors).toHaveLength(40)
    expect(vectors.map(hotIndex)).toEqual(texts.map((_, i) => i % 6))
  })

  it('returns [] for an empty batch without loading the model', async () => {
    const embedder = createOnnxEmbedder()
    expect(await embedder.embedBatch([])).toEqual([])
    expect(stub.tokenizerLoads).toEqual([])
    expect(stub.modelLoads).toEqual([])
    expect(embedder.isReady).toBe(false)
  })

  it('loads the default model at q8 once and passes the token limit to the tokenizer', async () => {
    const embedder = createOnnxEmbedder()
    await Promise.all([embedder.embed('a'), embedder.embed('b'), embedder.load()])
    expect(stub.tokenizerLoads).toEqual([DEFAULT_EMBED_MODEL])
    expect(stub.modelLoads).toEqual([{ model: DEFAULT_EMBED_MODEL, options: { dtype: 'q8' } }])
    expect(DEFAULT_EMBED_MODEL).toBe('onnx-community/Qwen3-Embedding-0.6B-ONNX')
    expect(stub.tokenizerCalls[0]!.options).toMatchObject({ padding: true, truncation: true, max_length: 512 })
  })

  it('reports dimensions from the model config after load and throws before it', async () => {
    stub.hiddenSize = 1024
    const embedder = createOnnxEmbedder()
    expect(() => embedder.dimensions()).toThrow(/load/)
    await embedder.load()
    expect(embedder.isReady).toBe(true)
    expect(embedder.dimensions()).toBe(1024)
    await embedder.dispose()
    expect(embedder.isReady).toBe(false)
    expect(() => embedder.dimensions()).toThrow(/load/)
  })
})
