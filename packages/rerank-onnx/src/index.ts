// Local cross-encoder reranker for Engram.
//
// Runs an mxbai-rerank (DeBERTa-v2) model via ONNX Runtime through
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
   * HuggingFace model id. Default: 'mixedbread-ai/mxbai-rerank-large-v1'.
   *
   * Tradeoffs (all mxbai-rerank-v1 variants have ONNX weights):
   *   - 'mixedbread-ai/mxbai-rerank-large-v1' : best quality, ~113MB @ q8, slower
   *   - 'mixedbread-ai/mxbai-rerank-base-v1'  : 3x faster, small quality drop
   *   - 'mixedbread-ai/mxbai-rerank-xsmall-v1': fastest, further quality drop
   */
  model?: string
  /** ONNX weight dtype. 'q8' is ~4x smaller than fp32 with small quality loss. Default: 'q8'. */
  dtype?: OnnxDType
  /** Pairs per forward pass. Default: 8. */
  batchSize?: number
  /** Max candidates reranked per call. Default: 25. */
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

const DEFAULT_MODEL = 'mixedbread-ai/mxbai-rerank-large-v1'
const DEFAULT_DTYPE: OnnxDType = 'q8'
const DEFAULT_BATCH_SIZE = 8
const DEFAULT_MAX_CANDIDATES = 25
const DEFAULT_MAX_LENGTH = 512
const DEFAULT_MAX_DOC_CHARS = 1200

export function createOnnxReranker(options: OnnxRerankerOptions = {}): OnnxReranker {
  const model = options.model ?? DEFAULT_MODEL
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

    // mxbai-rerank returns a single regression-style logit per pair.
    // Sigmoid maps it to [0, 1]; higher is more relevant.
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
