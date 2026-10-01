import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the transformers runtime so these tests never download or load an
// ONNX model. The tokenizer turns each whitespace-separated word into one
// token id, appends `endToken` the way a post-processor does (none when it is
// null), truncates the special-token-bearing sequence to max_length the way
// transformers.js 4.2.0 does, and pads every batch to its longest row on the
// configured side. The model's hidden state at sequence position t is
// supplied by `hiddenAt`, so a test can tell which position the embedder
// pooled; the ids the model received are recorded per row.
const PAD_ID = 0
const stub = vi.hoisted(() => ({
  hiddenSize: 8,
  paddingSide: 'right' as 'left' | 'right',
  endToken: null as number | null,
  tokenizerLoads: [] as string[],
  modelLoads: [] as Array<{ model: string; options: unknown }>,
  tokenizerCalls: [] as Array<{ texts: string[]; options: Record<string, unknown> }>,
  forwardBatchSizes: [] as number[],
  modelInputIds: [] as number[][][],
  hiddenAt: (_row: number, _pos: number, size: number, _id: number): number[] => new Array<number>(size).fill(1),
}))

vi.mock('@huggingface/transformers', () => {
  const wordIds = (text: string): number[] => text.split(/\s+/).filter(Boolean).map((_, i) => 1 + (i % 50))
  const encodeIds = (text: string, addSpecialTokens: boolean): number[] =>
    addSpecialTokens && stub.endToken !== null ? [...wordIds(text), stub.endToken] : wordIds(text)
  return {
    Tensor: class {
      constructor(
        public type: string,
        public data: ArrayLike<number | bigint>,
        public dims: number[],
      ) {}
    },
    AutoTokenizer: {
      from_pretrained: async (model: string) => {
        stub.tokenizerLoads.push(model)
        return {
          encode: (text: string, options: { add_special_tokens?: boolean } = {}) =>
            encodeIds(text, options.add_special_tokens ?? true),
          _call: (texts: string[], options: Record<string, unknown>) => {
            stub.tokenizerCalls.push({ texts, options })
            const maxLength = Number(options['max_length'])
            const rows = texts.map(t => encodeIds(t, true).slice(0, maxLength))
            const seq = Math.max(...rows.map(r => r.length))
            const ids = new BigInt64Array(texts.length * seq).fill(BigInt(0))
            const mask = new BigInt64Array(texts.length * seq)
            rows.forEach((row, b) => {
              const first = stub.paddingSide === 'right' ? 0 : seq - row.length
              row.forEach((id, i) => {
                ids[b * seq + first + i] = BigInt(id)
                mask[b * seq + first + i] = 1n
              })
            })
            return {
              input_ids: { data: ids, dims: [texts.length, seq], type: 'int64' },
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
          _call: async (inputs: {
            input_ids: { data: ArrayLike<bigint>; dims: number[] }
            attention_mask: { dims: number[] }
          }) => {
            const [batch, seq] = inputs.attention_mask.dims as [number, number]
            stub.forwardBatchSizes.push(batch)
            const ids = Array.from(inputs.input_ids.data, Number)
            stub.modelInputIds.push(Array.from({ length: batch }, (_, b) => ids.slice(b * seq, (b + 1) * seq)))
            const size = stub.hiddenSize
            const data = new Float32Array(batch * seq * size)
            for (let b = 0; b < batch; b++) {
              for (let t = 0; t < seq; t++) data.set(stub.hiddenAt(b, t, size, ids[b * seq + t]!), (b * seq + t) * size)
            }
            return { last_hidden_state: { data, dims: [batch, seq, size], type: 'float32' } }
          },
        }
      },
    },
  }
})

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
  stub.endToken = null
  stub.modelInputIds.length = 0
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

describe('createOnnxEmbedder: the end token survives truncation', () => {
  const END = 99
  const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

  it.each(['right', 'left'] as const)(
    'ends a %s-padded over-long text with the end token and pools it',
    async side => {
      stub.endToken = END
      stub.paddingSide = side
      const embedder = createOnnxEmbedder({ maxLength: 6 })
      const vectors = await embedder.embedBatch([words(10), words(2)])
      const [longRow, shortRow] = stub.modelInputIds[0]!
      // Five content tokens plus the end token fill the limit exactly.
      expect(longRow).toEqual([1, 2, 3, 4, 5, END])
      expect(hotIndex(vectors[0]!)).toBe(5)
      const shortTokens = side === 'right' ? [1, 2, END, PAD_ID, PAD_ID, PAD_ID] : [PAD_ID, PAD_ID, PAD_ID, 1, 2, END]
      expect(shortRow).toEqual(shortTokens)
      expect(hotIndex(vectors[1]!)).toBe(side === 'right' ? 2 : 5)
    },
  )

  it('pools the end-token hidden state, not a content token, for an over-long text', async () => {
    stub.endToken = END
    stub.hiddenAt = (_row, _pos, size, id) => {
      const v = new Array<number>(size).fill(0)
      v[id === END ? 0 : 1] = 3
      return v
    }
    const embedder = createOnnxEmbedder({ maxLength: 4 })
    const [long, short] = await embedder.embedBatch([words(9), 'a'])
    expect(hotIndex(long!)).toBe(0)
    expect(hotIndex(short!)).toBe(0)
  })

  it('passes a text within the limit to the model unchanged', async () => {
    stub.endToken = END
    const embedder = createOnnxEmbedder({ maxLength: 6 })
    await embedder.embedBatch([words(3), words(5)])
    expect(stub.modelInputIds[0]).toEqual([
      [1, 2, 3, END, PAD_ID, PAD_ID],
      [1, 2, 3, 4, 5, END],
    ])
  })

  it('leaves truncated rows alone when the tokenizer appends no end token', async () => {
    const embedder = createOnnxEmbedder({ maxLength: 4 })
    await embedder.embedBatch([words(9)])
    expect(stub.modelInputIds[0]).toEqual([[1, 2, 3, 4]])
  })

  it('refuses a token limit with no room for content besides the end token', async () => {
    stub.endToken = END
    const embedder = createOnnxEmbedder({ maxLength: 1 })
    await expect(embedder.embed('a b')).rejects.toThrow(/maxLength/)
  })
})
