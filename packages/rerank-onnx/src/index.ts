// Local cross-encoder reranker for Engram.
//
// Runs a single-logit cross-encoder (gte-reranker-modernbert-base by default,
// or an mxbai-rerank-v1 DeBERTa-v2 model) via ONNX Runtime through
// @huggingface/transformers. No network calls at query time — weights are
// downloaded on first use and cached under the HF cache directory.
//
// The public surface implements the rerank() contract from
// @engram-mem/core's IntelligenceAdapter, so it can be composed into any
// intelligence adapter via object spread:
//
//     const onnx = createOnnxReranker()
//     const intelligence = { ...openaiIntelligence({ apiKey }), rerank: onnx.rerank }

import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from '@huggingface/transformers'

export type OnnxDType = 'fp32' | 'fp16' | 'q8' | 'q4'

export interface OnnxRerankerOptions {
  /**
   * HuggingFace model id. Default: 'Alibaba-NLP/gte-reranker-modernbert-base'.
   *
   * Any cross-encoder with ONNX weights and a single relevance logit works:
   *   - 'Alibaba-NLP/gte-reranker-modernbert-base' (default): ModernBERT, 149M
   *     params. Matched large-v1 within judge noise on LongMemEval and led it
   *     on real recall queries, with about 4x faster rerank and ~1.2GB less
   *     RSS on a CPU host.
   *   - 'mixedbread-ai/mxbai-rerank-large-v1': previous default. DeBERTa-v2,
   *     435M params, higher RSS and about 4x slower rerank.
   *   - 'mixedbread-ai/mxbai-rerank-base-v1'  : smaller mxbai, small quality drop
   *   - 'mixedbread-ai/mxbai-rerank-xsmall-v1': fastest mxbai, further quality drop
   *
   * Scores are not comparable across models: each model's sigmoid output sits
   * on its own scale, so nothing may gate on an absolute rerank score.
   */
  model?: string
  /** ONNX weight dtype. 'q8' is ~4x smaller than fp32 with small quality loss. Default: 'q8'. */
  dtype?: OnnxDType
  /** Pairs per forward pass. Default: 8. */
  batchSize?: number
  /**
   * Max candidates reranked per call; docs past the cap get no score.
   * Default: 50, at least the largest slate the recall engine sends
   * (30 fused candidates plus a 15-row lexical reserve).
   */
  maxCandidates?: number
  /** Max token length per pair. Default: 512. */
  maxLength?: number
  /** Chars per document before tokenization (truncation guard). Default: 1200. */
  maxDocChars?: number
}

export interface RerankResult {
  id: string
  score: number
}

export interface OnnxReranker {
  rerank(
    query: string,
    documents: ReadonlyArray<{ id: string; content: string }>,
  ): Promise<RerankResult[]>
  /** Whether the model has been loaded. */
  readonly isReady: boolean
  /** Force-load the model now (warms cache). Optional — rerank() auto-loads. */
  load(): Promise<void>
  /** Free model memory. */
  dispose(): Promise<void>
}

export const DEFAULT_RERANK_MODEL = 'Alibaba-NLP/gte-reranker-modernbert-base'
const DEFAULT_DTYPE: OnnxDType = 'q8'
const DEFAULT_BATCH_SIZE = 8
const DEFAULT_MAX_CANDIDATES = 50
const DEFAULT_MAX_LENGTH = 512
const DEFAULT_MAX_DOC_CHARS = 1200

export function createOnnxReranker(options: OnnxRerankerOptions = {}): OnnxReranker {
  const model = options.model ?? DEFAULT_RERANK_MODEL
  const dtype = options.dtype ?? DEFAULT_DTYPE
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  const maxDocChars = options.maxDocChars ?? DEFAULT_MAX_DOC_CHARS

  let tokenizer: PreTrainedTokenizer | null = null
  let modelInstance: PreTrainedModel | null = null
  let loadPromise: Promise<void> | null = null

  async function ensureLoaded(): Promise<void> {
    if (tokenizer && modelInstance) return
    if (!loadPromise) {
      loadPromise = (async () => {
        const [tok, mdl] = await Promise.all([
          AutoTokenizer.from_pretrained(model),
          AutoModelForSequenceClassification.from_pretrained(model, { dtype }),
        ])
        tokenizer = tok
        modelInstance = mdl
      })()
    }
    await loadPromise
  }

  async function scoreBatch(query: string, docs: string[]): Promise<number[]> {
    if (docs.length === 0) return []
    await ensureLoaded()
    if (!tokenizer || !modelInstance) throw new Error('reranker not loaded')

    const truncatedDocs = docs.map(d => d.slice(0, maxDocChars))
    const queries = truncatedDocs.map(() => query)

    // Call _call directly: transformers.js makes the tokenizer object
    // callable via a Proxy, but TypeScript types don't reflect that,
    // so we go through the documented method instead.
    const encoded = tokenizer._call(queries, {
      text_pair: truncatedDocs,
      padding: true,
      truncation: true,
      max_length: maxLength,
      return_tensor: true,
    }) as unknown as Record<string, unknown>

    const output = await (
      modelInstance as unknown as { _call: (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }> }
    )._call(encoded)

    const logits = output?.logits
    if (!logits?.data) {
      throw new Error('reranker returned unexpected output shape')
    }
    // Both supported families (gte-reranker-modernbert, mxbai-rerank-v1) emit
    // one relevance logit per pair. A multi-label head would flatten to
    // several values per pair and silently misalign scores with documents.
    if (logits.data.length !== docs.length) {
      throw new Error(
        `reranker model ${model} returned ${logits.data.length} logits for ${docs.length} pairs; expected one logit per pair`,
      )
    }

    // Sigmoid maps the logit to [0, 1]; higher is more relevant. The scale
    // is model-specific, so scores only order candidates within one model.
    return Array.from(logits.data, (x: number) => sigmoid(Number(x)))
  }

  async function rerank(
    query: string,
    documents: ReadonlyArray<{ id: string; content: string }>,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return []
    if (documents.length === 1) return [{ id: documents[0]!.id, score: 1.0 }]

    const candidates = documents.slice(0, maxCandidates)
    const scores: number[] = new Array(candidates.length)

    for (let start = 0; start < candidates.length; start += batchSize) {
      const end = Math.min(start + batchSize, candidates.length)
      const batch = candidates.slice(start, end).map(c => c.content)
      const batchScores = await scoreBatch(query, batch)
      for (let i = 0; i < batchScores.length; i++) {
        scores[start + i] = batchScores[i]!
      }
    }

    return candidates.map((c, i) => ({ id: c.id, score: scores[i] ?? 0 }))
  }

  return {
    rerank,
    get isReady() {
      return tokenizer !== null && modelInstance !== null
    },
    async load() {
      await ensureLoaded()
    },
    async dispose() {
      if (modelInstance && typeof (modelInstance as unknown as { dispose?: () => Promise<void> }).dispose === 'function') {
        await (modelInstance as unknown as { dispose: () => Promise<void> }).dispose()
      }
      tokenizer = null
      modelInstance = null
      loadPromise = null
    },
  }
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x)
    return 1 / (1 + z)
  }
  const z = Math.exp(x)
  return z / (1 + z)
}

export {
  createOnnxEmbedder,
  formatEmbedQuery,
  lastTokenIndices,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_QUERY_TASK,
  type OnnxEmbedder,
  type OnnxEmbedderOptions,
} from './embed.js'
