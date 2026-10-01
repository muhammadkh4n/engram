import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the transformers runtime with a tokenizer that pads the way the real
// one does (to the longest row for padding: true, to max_length for
// 'max_length', and refuses ragged rows when unpadded) and a model that
// records every input it is fed. The q8 weights quantize activations with one
// scale per tensor, so anything else in a forward pass (other pairs, pad
// positions) changes a pair's score; these tests pin what a pass may contain.

interface FakeTensor {
  dims: number[]
  data: number[]
}
interface FakeEncoding {
  input_ids: FakeTensor
  attention_mask: FakeTensor
}
interface RecordedPass {
  documents: string[]
  input_ids: FakeTensor
  attention_mask: FakeTensor
}

const stub = vi.hoisted(() => ({
  passes: [] as RecordedPass[],
  documentsOf: new WeakMap<object, string[]>(),
}))

vi.mock('@huggingface/transformers', () => {
  const CLS = 1
  const SEP = 2
  const PAD = 0
  const wordId = (word: string): number => {
    let h = 7
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 30000
    return 100 + h
  }
  const words = (s: string): number[] => s.split(/\s+/).filter(Boolean).map(wordId)
  const asArray = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v])

  return {
    AutoTokenizer: {
      from_pretrained: async () => ({
        _call: (
          text: string | string[],
          opts: { text_pair: string | string[]; padding?: boolean | 'max_length'; truncation?: boolean; max_length: number },
        ): FakeEncoding => {
          const queries = asArray(text)
          const documents = asArray(opts.text_pair)
          const rows = queries.map((q, i) => {
            const ids = [CLS, ...words(q), SEP, ...words(documents[i]!), SEP]
            return opts.truncation ? ids.slice(0, opts.max_length) : ids
          })
          const longest = Math.max(...rows.map(r => r.length))
          const width = opts.padding === 'max_length' ? opts.max_length : longest
          if (!opts.padding && rows.some(r => r.length !== longest)) {
            throw new Error('ragged rows need padding to form a tensor')
          }
          const ids: number[] = []
          const mask: number[] = []
          for (const r of rows) {
            ids.push(...r, ...new Array<number>(width - r.length).fill(PAD))
            mask.push(...r.map(() => 1), ...new Array<number>(width - r.length).fill(0))
          }
          const encoding = {
            input_ids: { dims: [rows.length, width], data: ids },
            attention_mask: { dims: [rows.length, width], data: mask },
          }
          stub.documentsOf.set(encoding, documents)
          return encoding
        },
      }),
    },
    AutoModelForSequenceClassification: {
      from_pretrained: async () => ({
        _call: async (inputs: FakeEncoding) => {
          stub.passes.push({
            documents: [...(stub.documentsOf.get(inputs) ?? [])],
            input_ids: { dims: [...inputs.input_ids.dims], data: [...inputs.input_ids.data] },
            attention_mask: { dims: [...inputs.attention_mask.dims], data: [...inputs.attention_mask.data] },
          })
          return { logits: { data: Float32Array.from(new Array<number>(inputs.input_ids.dims[0]!).fill(0)) } }
        },
      }),
    },
  }
})

import { createOnnxReranker } from '../src/index.js'

const QUERY = 'which connection pool size did the recall service settle on'
const TARGET = 'The recall service keeps a connection pool of twelve because the server allows forty connections.'
const SHORT = ['Build passed.', 'Lint fixed one unused import.']
const LONG = Array.from(
  { length: 10 },
  (_, i) =>
    `Session ${i} rebased the feature branch, reran the package build and the type check, ` +
    'updated the README table of environment variables, and wrote a summary of the tool calls it made. '.repeat(i + 1),
)

const docs = (contents: string[]) => contents.map((content, i) => ({ id: `d${i}`, content }))

async function passScoring(content: string, slate: string[]): Promise<RecordedPass> {
  stub.passes.length = 0
  await createOnnxReranker().rerank(QUERY, docs(slate))
  const pass = stub.passes.find(p => p.documents.includes(content))
  if (!pass) throw new Error(`no forward pass scored ${JSON.stringify(content.slice(0, 30))}`)
  return { documents: [], input_ids: pass.input_ids, attention_mask: pass.attention_mask }
}

describe('rerank forward passes do not depend on the rest of the slate (stubbed runtime)', () => {
  beforeEach(() => {
    stub.passes.length = 0
  })

  it('feeds the model identical tensors for a pair whatever its neighbours and position', async () => {
    const withShort = await passScoring(TARGET, [TARGET, ...SHORT])
    const amongLong = await passScoring(TARGET, [...LONG.slice(0, 3), TARGET, ...LONG.slice(3)])
    const reversed = await passScoring(TARGET, [...LONG.slice(3)].reverse().concat(TARGET, ...LONG.slice(0, 3)))
    expect(amongLong).toEqual(withShort)
    expect(reversed).toEqual(withShort)

    const alone = await passScoring(TARGET, [TARGET])
    expect(alone).toEqual(withShort)
  })

  it('scores each pair in its own pass, with no pad positions', async () => {
    const slate = [...SHORT, TARGET, ...LONG]
    await createOnnxReranker().rerank(QUERY, docs(slate))

    expect(stub.passes).toHaveLength(slate.length)
    for (const pass of stub.passes) {
      expect(pass.documents).toHaveLength(1)
      expect(pass.input_ids.dims[0]).toBe(1)
      expect(pass.attention_mask.data.every(m => m === 1)).toBe(true)
    }
    expect(stub.passes.map(p => p.documents[0])).toEqual(slate)
  })
})
