import { describe, it, expect } from 'vitest'
import {
  parseRerankerArgs, buildModelMeta, buildJudgeModelMeta,
  DEFAULT_ONNX_RERANK_MODEL, OPENAI_RERANK_MODEL, BENCH_EMBED_MODEL,
} from '../src/longmemeval/forensics/reranker-meta-lib.js'

describe('parseRerankerArgs', () => {
  it('accepts openai, onnx and none', () => {
    expect(parseRerankerArgs(['--reranker', 'openai'])).toEqual({ rerankerBackend: 'openai' })
    expect(parseRerankerArgs(['--reranker', 'onnx'])).toEqual({ rerankerBackend: 'onnx' })
    expect(parseRerankerArgs(['--reranker', 'none'])).toEqual({ rerankerBackend: 'none' })
  })

  it('leaves the backend unset when --reranker is absent, so --no-rerank keeps working', () => {
    expect(parseRerankerArgs(['--limit', '5'])).toEqual({})
    expect(parseRerankerArgs(['--no-rerank'])).toEqual({})
    expect(parseRerankerArgs(['--no-rerank', '--reranker', 'none'])).toEqual({ rerankerBackend: 'none' })
  })

  it('rejects an unknown backend', () => {
    expect(() => parseRerankerArgs(['--reranker', 'foo'])).toThrow(/openai\|onnx\|none.*"foo"/)
  })

  it('rejects --reranker with no value', () => {
    expect(() => parseRerankerArgs(['--reranker', '--limit', '5'])).toThrow(/--reranker must be one of/)
  })

  it('passes --onnx-model through with the onnx backend', () => {
    expect(parseRerankerArgs(['--reranker', 'onnx', '--onnx-model', 'mixedbread-ai/mxbai-rerank-base-v1']))
      .toEqual({ rerankerBackend: 'onnx', onnxRerankerModel: 'mixedbread-ai/mxbai-rerank-base-v1' })
  })

  it('rejects --onnx-model without the onnx backend or without a value', () => {
    expect(() => parseRerankerArgs(['--onnx-model', 'x/y'])).toThrow(/only valid with --reranker onnx/)
    expect(() => parseRerankerArgs(['--reranker', 'openai', '--onnx-model', 'x/y'])).toThrow(/only valid/)
    expect(() => parseRerankerArgs(['--reranker', 'onnx', '--onnx-model'])).toThrow(/requires a HuggingFace model id/)
  })

  it('rejects --no-rerank combined with a live reranker', () => {
    expect(() => parseRerankerArgs(['--no-rerank', '--reranker', 'onnx'])).toThrow(/contradicts --reranker onnx/)
  })
})

describe('buildModelMeta', () => {
  it('maps onnx to the given model id, or the ONNX default', () => {
    expect(buildModelMeta('onnx', 'org/model')).toEqual({ rerankerBackend: 'onnx', rerankModel: 'org/model', embedModel: BENCH_EMBED_MODEL })
    expect(buildModelMeta('onnx', undefined).rerankModel).toBe(DEFAULT_ONNX_RERANK_MODEL)
    expect(DEFAULT_ONNX_RERANK_MODEL).toBe('mixedbread-ai/mxbai-rerank-large-v1')
  })

  it('maps openai to gpt-4o-mini and none to null', () => {
    expect(buildModelMeta('openai', undefined).rerankModel).toBe(OPENAI_RERANK_MODEL)
    expect(OPENAI_RERANK_MODEL).toBe('gpt-4o-mini')
    expect(buildModelMeta('none', undefined)).toEqual({ rerankerBackend: 'none', rerankModel: null, embedModel: 'text-embedding-3-small' })
  })

  it('records null when no question resolved a backend', () => {
    expect(buildModelMeta(null, undefined)).toEqual({ rerankerBackend: null, rerankModel: null, embedModel: BENCH_EMBED_MODEL })
  })
})

describe('buildJudgeModelMeta', () => {
  it('copies the sweep model ids and adds the gen model', () => {
    const sweepMeta = { args: {}, rerankerBackend: 'onnx', rerankModel: 'org/model', embedModel: 'text-embedding-3-small' }
    expect(buildJudgeModelMeta(sweepMeta, 'gpt-4o')).toEqual({
      rerankerBackend: 'onnx', rerankModel: 'org/model', embedModel: 'text-embedding-3-small', chatModel: 'gpt-4o',
    })
  })

  it('records nulls for a sweep file that predates the model fields', () => {
    expect(buildJudgeModelMeta({ args: {} }, 'gpt-4o-mini')).toEqual({
      rerankerBackend: null, rerankModel: null, embedModel: null, chatModel: 'gpt-4o-mini',
    })
    expect(buildJudgeModelMeta(undefined, 'm').rerankerBackend).toBeNull()
  })
})
