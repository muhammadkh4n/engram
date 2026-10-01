// Local bi-encoder embedder for Engram.
//
// Runs a last-token-pooled embedding model (Qwen3-Embedding by default) via
// ONNX Runtime through @huggingface/transformers. No network calls at query
// time; weights are downloaded on first use and cached under the HF cache
// directory.
//
// The returned object implements the embed / embedBatch / embedQuery /
// dimensions members of @engram-mem/core's IntelligenceAdapter, so it can be
// spread over any intelligence adapter:
//
//     const embedder = createOnnxEmbedder()
//     await embedder.load()
//     const intelligence = { ...openaiIntelligence({ apiKey }), ...embedder }

import {
  AutoTokenizer,
  AutoModel,
  Tensor,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from '@huggingface/transformers'
import type { OnnxDType } from './index.js'

export interface OnnxEmbedderOptions {
  /**
   * HuggingFace model id. Default: 'onnx-community/Qwen3-Embedding-0.6B-ONNX'.
   * The model must emit `last_hidden_state` and be trained for last-token
   * pooling (the Qwen3-Embedding family is).
   */
  model?: string
  /** ONNX weight dtype. Default: 'q8'. */
  dtype?: OnnxDType
  /**
   * Task description placed in the query instruction
   * `Instruct: <task>\nQuery:<query>`. Documents get no instruction.
   */
  queryTask?: string
  /** Texts per forward pass. Default: 16. */
  batchSize?: number
  /**
   * Max tokens per text, end token included; longer texts lose content
   * tokens from the tail and keep the end token. Default: 512.
   */
  maxLength?: number
  /** Chars per text before tokenization (truncation guard). Default: 2000. */
  maxChars?: number
}

export interface OnnxEmbedder {
  /** Embed one stored document. */
  embed(text: string): Promise<number[]>
  /** Embed stored documents, `batchSize` per forward pass, in input order. */
  embedBatch(texts: string[]): Promise<number[][]>
  /** Embed a search query, prefixed with the query instruction. */
  embedQuery(text: string): Promise<number[]>
  /** The model's hidden size. Throws until the model is loaded. */
  dimensions(): number
  /** Whether the model has been loaded. */
  readonly isReady: boolean
  /** Force-load the model now. Optional; embedding auto-loads. */
  load(): Promise<void>
  /** Free model memory. */
  dispose(): Promise<void>
}

export const DEFAULT_EMBED_MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'
export const DEFAULT_EMBED_QUERY_TASK =
  'Given a question or topic, retrieve memories that answer or relate to it'
const DEFAULT_DTYPE: OnnxDType = 'q8'
const DEFAULT_BATCH_SIZE = 16
const DEFAULT_MAX_LENGTH = 512
const DEFAULT_MAX_CHARS = 2000

interface TensorLike {
  data: ArrayLike<number | bigint>
  dims: number[]
  type?: string
  to?(type: string): TensorLike
}

type CallableModel = { _call(inputs: unknown): Promise<{ last_hidden_state?: TensorLike }> }

interface EncodingTokenizer {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[]
}

/** Qwen3-Embedding's query format: the instruction, a newline, then `Query:` with no space. */
export function formatEmbedQuery(task: string, query: string): string {
  return `Instruct: ${task}\nQuery:${query}`
}

/**
 * Index of the last attended token in each row of a [batch, seq] attention
 * mask. Works for left and right padding alike, so pooling never depends on
 * the tokenizer's padding side.
 */
export function lastTokenIndices(mask: TensorLike): number[] {
  const [batch, seq] = mask.dims as [number, number]
  const indices: number[] = []
  for (let b = 0; b < batch; b++) {
    let last = -1
    for (let t = seq - 1; t >= 0; t--) {
      if (Number(mask.data[b * seq + t]) !== 0) {
        last = t
        break
      }
    }
    if (last < 0) throw new Error(`embedder: row ${b} has no attended token`)
    indices.push(last)
  }
  return indices
}

/**
 * Token ids the tokenizer's post-processor appends after a single sequence's
 * content (`<|endoftext|>` for Qwen3-Embedding), or [] when it appends none.
 * Found by encoding a probe with and without special tokens rather than read
 * from the config's `eos_token`, which can name a different token:
 * Qwen3-Embedding's config says `<|im_end|>` while its post-processor
 * appends `<|endoftext|>`, the token the model was trained to pool.
 */
export function trailingSpecialIds(tokenizer: EncodingTokenizer): number[] {
  const probe = 'a'
  const withSpecials = tokenizer.encode(probe)
  const bare = tokenizer.encode(probe, { add_special_tokens: false })
  for (let start = 0; start + bare.length <= withSpecials.length; start++) {
    if (bare.every((id, i) => withSpecials[start + i] === id)) {
      return withSpecials.slice(start + bare.length)
    }
  }
  throw new Error('embedder: tokenizer output with special tokens does not contain the bare encoding')
}

/**
 * The tokenizer truncates after its post-processor has appended the end
 * token, so a text longer than max_length loses that token and last-token
 * pooling would read a mid-sentence token instead. Returns a copy of the
 * [batch, seq] input ids where every row's last attended positions hold
 * `endIds`: a truncated row gives up its final content tokens to make room,
 * so content plus end tokens still fit the limit. Rows that already end with
 * `endIds` are copied unchanged, and the attention mask already covers the
 * replaced positions.
 */
export function withEndTokens(inputIds: TensorLike, mask: TensorLike, endIds: number[]): BigInt64Array {
  const seq = inputIds.dims[1]!
  const data = BigInt64Array.from(inputIds.data, v => BigInt(v))
  if (endIds.length === 0) return data
  lastTokenIndices(mask).forEach((last, b) => {
    const start = b * seq + last - endIds.length + 1
    if (endIds.every((id, i) => data[start + i] === BigInt(id))) return
    for (let i = 0; i < endIds.length; i++) {
      if (start + i < b * seq || Number(mask.data[start + i]) === 0) {
        throw new Error(`embedder: row ${b} has no room for its end token`)
      }
      data[start + i] = BigInt(endIds[i]!)
    }
  })
  return data
}

function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0
  for (const x of vector) sumSquares += x * x
  const norm = Math.sqrt(sumSquares)
  if (!(norm > 0) || !Number.isFinite(norm)) {
    throw new Error('embedder produced a zero or non-finite vector')
  }
  return vector.map(x => x / norm)
}

export function createOnnxEmbedder(options: OnnxEmbedderOptions = {}): OnnxEmbedder {
  const model = options.model ?? DEFAULT_EMBED_MODEL
  const dtype = options.dtype ?? DEFAULT_DTYPE
  const queryTask = options.queryTask ?? DEFAULT_EMBED_QUERY_TASK
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`embedder batchSize must be a positive integer, got ${batchSize}`)
  }
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error(`embedder maxLength must be a positive integer, got ${maxLength}`)
  }

  let tokenizer: PreTrainedTokenizer | null = null
  let modelInstance: PreTrainedModel | null = null
  let hiddenSize: number | null = null
  let endIds: number[] = []
  let loadPromise: Promise<void> | null = null

  async function ensureLoaded(): Promise<void> {
    if (tokenizer && modelInstance) return
    if (!loadPromise) {
      loadPromise = (async () => {
        const [tok, mdl] = await Promise.all([
          AutoTokenizer.from_pretrained(model),
          AutoModel.from_pretrained(model, { dtype }),
        ])
        const size = Number((mdl.config as unknown as { hidden_size?: unknown }).hidden_size)
        if (!Number.isInteger(size) || size < 1) {
          throw new Error(`embedder model ${model} has no hidden_size in its config`)
        }
        const trailing = trailingSpecialIds(tok as unknown as EncodingTokenizer)
        if (trailing.length >= maxLength) {
          throw new Error(
            `embedder maxLength ${maxLength} leaves no room for content besides ${trailing.length} end token(s)`,
          )
        }
        tokenizer = tok
        modelInstance = mdl
        hiddenSize = size
        endIds = trailing
      })().catch((err: unknown) => {
        loadPromise = null
        throw err
      })
    }
    await loadPromise
  }

  async function forward(texts: string[]): Promise<number[][]> {
    await ensureLoaded()
    if (!tokenizer || !modelInstance || hiddenSize === null) throw new Error('embedder not loaded')

    // _call is the documented method behind the tokenizer's callable Proxy,
    // which TypeScript's types do not model.
    const encoded = tokenizer._call(texts, {
      padding: true,
      truncation: true,
      max_length: maxLength,
      return_tensor: true,
    }) as unknown as { input_ids: TensorLike; attention_mask: TensorLike }

    const inputIds = new Tensor(
      'int64',
      withEndTokens(encoded.input_ids, encoded.attention_mask, endIds),
      encoded.input_ids.dims,
    )
    const output = await (modelInstance as unknown as CallableModel)._call({ ...encoded, input_ids: inputIds })
    let hidden = output?.last_hidden_state
    if (!hidden?.data || hidden.dims?.length !== 3) {
      throw new Error(`embedder model ${model} returned no [batch, seq, hidden] last_hidden_state`)
    }
    if (hidden.type && hidden.type !== 'float32' && typeof hidden.to === 'function') {
      hidden = hidden.to('float32')
    }
    const [batch, seq, size] = hidden.dims as [number, number, number]
    if (batch !== texts.length || size !== hiddenSize) {
      throw new Error(
        `embedder model ${model} returned shape [${hidden.dims.join(', ')}] for ${texts.length} texts; expected hidden size ${hiddenSize}`,
      )
    }

    const lastIndices = lastTokenIndices(encoded.attention_mask)
    return lastIndices.map((t, b) => {
      const offset = (b * seq + t) * size
      const vector = new Array<number>(size)
      for (let h = 0; h < size; h++) vector[h] = Number(hidden!.data[offset + h])
      return l2Normalize(vector)
    })
  }

  // Texts arrive already truncated and, for queries, already prefixed, so
  // the char guard never cuts into the instruction.
  async function embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += batchSize) {
      vectors.push(...(await forward(texts.slice(start, start + batchSize))))
    }
    return vectors
  }

  async function embedOne(text: string): Promise<number[]> {
    const [vector] = await embedTexts([text])
    return vector!
  }

  return {
    embed: (text: string) => embedOne(text.slice(0, maxChars)),
    embedBatch: (texts: string[]) => embedTexts(texts.map(t => t.slice(0, maxChars))),
    embedQuery: (text: string) => embedOne(formatEmbedQuery(queryTask, text.slice(0, maxChars))),
    dimensions() {
      if (hiddenSize === null) {
        throw new Error('embedder dimensions are read from the model config; call load() first')
      }
      return hiddenSize
    },
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
      hiddenSize = null
      endIds = []
      loadPromise = null
    },
  }
}
