import { describe, it, expect } from 'vitest'
import {
  parseRerankerArgs, buildModelMeta, buildJudgeModelMeta,
  DEFAULT_ONNX_RERANK_MODEL, OPENAI_RERANK_MODEL, BENCH_EMBED_MODEL,
  parseEmbedArgs, resolveEmbedSettings, DEFAULT_ONNX_EMBED_MODEL,
} from '../src/longmemeval/forensics/reranker-meta-lib.js'
import { DEFAULT_EMBED_MODEL } from '@engram-mem/rerank-onnx'

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

describe('parseEmbedArgs', () => {
  it('sets nothing when no embed flag is given, so a plain run keeps its args', () => {
    expect(parseEmbedArgs(['--limit', '5', '--reranker', 'onnx'])).toEqual({})
  })

  it('accepts both backends, a model id and positive integer dims', () => {
    expect(parseEmbedArgs(['--embed-backend', 'openai'])).toEqual({ embedBackend: 'openai' })
    expect(parseEmbedArgs(['--embed-backend', 'onnx', '--embed-model', 'org/m', '--embed-dims', '1024']))
      .toEqual({ embedBackend: 'onnx', embedModel: 'org/m', embedDims: 1024 })
  })

  it('rejects an unknown or missing backend', () => {
    expect(() => parseEmbedArgs(['--embed-backend', 'cohere'])).toThrow(/openai\|onnx.*"cohere"/)
    expect(() => parseEmbedArgs(['--embed-backend', '--limit', '5'])).toThrow(/--embed-backend must be one of/)
  })

  it('rejects --embed-model without a value', () => {
    expect(() => parseEmbedArgs(['--embed-model'])).toThrow(/requires a model id/)
    expect(() => parseEmbedArgs(['--embed-model', '--embed-dims', '3'])).toThrow(/requires a model id/)
  })

  it('rejects dims that are not a positive integer', () => {
    for (const bad of ['0', '-5', '1.5', '1e3', 'abc', '99999999999999999999']) {
      expect(() => parseEmbedArgs(['--embed-dims', bad])).toThrow(/positive integer/)
    }
    expect(() => parseEmbedArgs(['--embed-dims'])).toThrow(/positive integer/)
  })
})

describe('resolveEmbedSettings', () => {
  it('defaults to openai text-embedding-3-small at the native width', () => {
    expect(resolveEmbedSettings({})).toEqual({ backend: 'openai', model: BENCH_EMBED_MODEL, dims: null })
  })

  it('defaults onnx to the embedder package default model', () => {
    expect(resolveEmbedSettings({ embedBackend: 'onnx' }).model).toBe(DEFAULT_ONNX_EMBED_MODEL)
    expect(DEFAULT_ONNX_EMBED_MODEL).toBe(DEFAULT_EMBED_MODEL)
  })

  it('keeps an explicit model and dims', () => {
    expect(resolveEmbedSettings({ embedModel: 'text-embedding-3-large', embedDims: 1536 }))
      .toEqual({ backend: 'openai', model: 'text-embedding-3-large', dims: 1536 })
  })
})
