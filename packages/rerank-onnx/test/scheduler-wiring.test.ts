import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the transformers runtime so no model loads. The tokenizer records every
// call it receives; the model's forward pass is a deferred promise the test
// settles by hand (or at once, in auto mode), so the order in which calls'
// passes reach the model is observable.

interface TokenizerCall {
  queries: string[]
  options: Record<string, unknown>
}

const stub = vi.hoisted(() => ({
  tokenizerCalls: [] as TokenizerCall[],
  pending: [] as Array<(logit: number) => void>,
  auto: false,
}))

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: async () => ({
      _call: (queries: string[], options: Record<string, unknown>) => {
        stub.tokenizerCalls.push({ queries, options })
        return { pairs: queries.length }
      },
    }),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: async () => ({
      _call: () =>
        new Promise<{ logits: { data: Float32Array } }>((resolve) => {
          const answer = (logit: number): void => resolve({ logits: { data: Float32Array.from([logit]) } })
          if (stub.auto) answer(0)
          else stub.pending.push(answer)
        }),
    }),
  },
}))

import { createOnnxReranker } from '../src/index.js'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function releaseNext(logit = 0): Promise<void> {
  await flush()
  const answer = stub.pending.shift()
  if (!answer) throw new Error('no forward pass is waiting')
  answer(logit)
  await flush()
}

const documentsSeen = (): unknown[] => stub.tokenizerCalls.map((c) => (c.options.text_pair as string[])[0])

const docs = (prefix: string, n: number): Array<{ id: string; content: string }> =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, content: `${prefix} document ${i + 1}` }))

describe('the ONNX reranker submits each call to its scheduler', () => {
  beforeEach(() => {
    stub.tokenizerCalls.length = 0
    stub.pending.length = 0
    stub.auto = false
  })

  it('tokenizes (query, content) per candidate in order with unchanged arguments', async () => {
    stub.auto = true
    const reranker = createOnnxReranker()
    const long = 'x'.repeat(1500)

    const results = await reranker.rerank('the query', [
      { id: 'a', content: 'first' },
      { id: 'b', content: long },
      { id: 'c', content: 'third' },
    ])

    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(results.every((r) => r.score === 0.5)).toBe(true)
    expect(stub.tokenizerCalls).toEqual(
      ['first', long.slice(0, 1200), 'third'].map((document) => ({
        queries: ['the query'],
        options: { text_pair: [document], padding: false, truncation: true, max_length: 512, return_tensor: true },
      })),
    )
  })

  it('keeps the candidate cap: documents past it are never scored', async () => {
    stub.auto = true
    const reranker = createOnnxReranker({ maxCandidates: 2 })

    const results = await reranker.rerank('q', docs('d', 4))

    expect(results.map((r) => r.id)).toEqual(['d1', 'd2'])
    expect(stub.tokenizerCalls).toHaveLength(2)
  })

  it('runs a newer call with an older priority before the rest of a running call', async () => {
    const reranker = createOnnxReranker()
    await reranker.load()

    const first = reranker.rerank('q1', docs('a', 3), { priority: 2 })
    await flush()
    expect(documentsSeen()).toEqual(['a document 1'])
    const second = reranker.rerank('q2', docs('b', 2), { priority: 1 })

    for (let i = 0; i < 5; i++) await releaseNext()

    expect(documentsSeen()).toEqual(['a document 1', 'b document 1', 'b document 2', 'a document 2', 'a document 3'])
    expect((await first).map((r) => r.id)).toEqual(['a1', 'a2', 'a3'])
    expect((await second).map((r) => r.id)).toEqual(['b1', 'b2'])
  })

  it('makes no tokenizer call for a signal aborted before the call', async () => {
    const reranker = createOnnxReranker()
    await reranker.load()
    const ctrl = new AbortController()
    ctrl.abort()

    await expect(reranker.rerank('q', docs('d', 3), { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await flush()
    expect(stub.tokenizerCalls).toHaveLength(0)
  })

  it('stops tokenizing after the running pass when the call is aborted mid-way', async () => {
    const reranker = createOnnxReranker()
    await reranker.load()
    const ctrl = new AbortController()

    const call = reranker.rerank('q', docs('d', 4), { signal: ctrl.signal })
    const outcome = call.then(
      () => 'resolved',
      (error: Error) => error.name,
    )
    await releaseNext()
    ctrl.abort()
    await releaseNext()

    expect(await outcome).toBe('AbortError')
    await flush()
    expect(documentsSeen()).toEqual(['d document 1', 'd document 2'])
    expect(stub.pending).toHaveLength(0)
  })

  it('reports onSettled once per call', async () => {
    stub.auto = true
    const reranker = createOnnxReranker()
    const first = vi.fn()
    const second = vi.fn()

    await Promise.all([
      reranker.rerank('q1', docs('a', 3), { onSettled: first }),
      reranker.rerank('q2', docs('b', 2), { onSettled: second }),
    ])

    expect(first).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0]![0]).toMatchObject({ passes: 3 })
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0]![0]).toMatchObject({ passes: 2 })
  })
})
