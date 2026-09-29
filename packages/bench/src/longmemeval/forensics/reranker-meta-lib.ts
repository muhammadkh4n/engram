// Pure helpers for the recall sweep and judge: reranker flag parsing and the
// model-id block written into result `meta`. No runtime imports beyond types,
// so tests exercise them without loading ONNX weights or touching the network.
import type { RerankerBackend } from '../../types.js'

/** createOnnxReranker's default model id when no --onnx-model is given. */
export const DEFAULT_ONNX_RERANK_MODEL = 'mixedbread-ai/mxbai-rerank-large-v1'
/** The OpenAI summarizer's default chat model, which does pointwise rerank. */
export const OPENAI_RERANK_MODEL = 'gpt-4o-mini'
/** createBenchMemory builds openaiIntelligence without an embeddingModel override. */
export const BENCH_EMBED_MODEL = 'text-embedding-3-small'

const BACKENDS: readonly RerankerBackend[] = ['openai', 'onnx', 'none']

export interface RerankerArgs {
  rerankerBackend?: RerankerBackend
  onnxRerankerModel?: string
}

/**
 * Parse `--reranker openai|onnx|none` and `--onnx-model <hf id>`.
 * Absent `--reranker` leaves the backend unset so createBenchMemory keeps its
 * default (openai, or none under --no-rerank). Throws on any invalid or
 * contradictory combination; the caller prints the message and exits 1.
 */
export function parseRerankerArgs(argv: readonly string[]): RerankerArgs {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next !== undefined && !next.startsWith('--') ? next : ''
  }

  const rawBackend = valueOf('--reranker')
  if (rawBackend !== undefined && !BACKENDS.includes(rawBackend as RerankerBackend)) {
    throw new Error(`--reranker must be one of openai|onnx|none, got ${JSON.stringify(rawBackend)}`)
  }
  const rerankerBackend = rawBackend as RerankerBackend | undefined

  const onnxRerankerModel = valueOf('--onnx-model')
  if (onnxRerankerModel === '') {
    throw new Error('--onnx-model requires a HuggingFace model id')
  }
  if (onnxRerankerModel !== undefined && rerankerBackend !== 'onnx') {
    throw new Error('--onnx-model is only valid with --reranker onnx')
  }
  if (argv.includes('--no-rerank') && rerankerBackend !== undefined && rerankerBackend !== 'none') {
    throw new Error(`--no-rerank contradicts --reranker ${rerankerBackend}`)
  }

  return {
    ...(rerankerBackend !== undefined ? { rerankerBackend } : {}),
    ...(onnxRerankerModel !== undefined ? { onnxRerankerModel } : {}),
  }
}

export interface ModelMeta {
  rerankerBackend: RerankerBackend | null
  rerankModel: string | null
  embedModel: string
}

/**
 * Model ids for a sweep's `meta`. `backend` is the resolved backend reported
 * by the memory handle (null only when no question ran), not the raw flag.
 */
export function buildModelMeta(
  backend: RerankerBackend | null,
  onnxRerankerModel: string | undefined,
  embedModel: string = BENCH_EMBED_MODEL,
): ModelMeta {
  return { rerankerBackend: backend, rerankModel: rerankModelFor(backend, onnxRerankerModel), embedModel }
}

function rerankModelFor(backend: RerankerBackend | null, onnxRerankerModel: string | undefined): string | null {
  if (backend === 'onnx') return onnxRerankerModel ?? DEFAULT_ONNX_RERANK_MODEL
  if (backend === 'openai') return OPENAI_RERANK_MODEL
  return null
}

export interface JudgeModelMeta {
  rerankerBackend: RerankerBackend | null
  rerankModel: string | null
  embedModel: string | null
  chatModel: string
}

/**
 * Model ids for a judge output: copied from the sweep file's `meta` (null when
 * an older sweep predates these fields) plus the answer-generation model.
 */
export function buildJudgeModelMeta(sweepMeta: unknown, chatModel: string): JudgeModelMeta {
  const m = (sweepMeta !== null && typeof sweepMeta === 'object' ? sweepMeta : {}) as Record<string, unknown>
  const backend = BACKENDS.includes(m['rerankerBackend'] as RerankerBackend)
    ? (m['rerankerBackend'] as RerankerBackend)
    : null
  return {
    rerankerBackend: backend,
    rerankModel: typeof m['rerankModel'] === 'string' ? m['rerankModel'] : null,
    embedModel: typeof m['embedModel'] === 'string' ? m['embedModel'] : null,
    chatModel,
  }
}
