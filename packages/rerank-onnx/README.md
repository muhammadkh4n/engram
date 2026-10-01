# @engram-mem/rerank-onnx

Local cross-encoder reranker for Engram. Runs a single-logit cross-encoder via ONNX Runtime through `@huggingface/transformers`: `gte-reranker-modernbert-base` (ModernBERT) by default, or any `mxbai-rerank-v1` model (DeBERTa-v2). No API calls at query time — weights are downloaded on first use and cached by HuggingFace locally.

## Why

Engram's default reranker is an LLM pointwise scorer (gpt-4o-mini). That works, but:

- Every recall that crosses the rerank threshold costs ~$0.001 in API calls.
- Latency is dominated by the round-trip to OpenAI (~1-3s per rerank).
- The ordering quality is capped by what gpt-4o-mini can discriminate over a tight JSON-scored list.

A purpose-built cross-encoder like `gte-reranker-modernbert-base` typically gives stronger ordering with:

- Zero API cost (model runs locally).
- No network round-trip; latency depends on the model and host CPU (see the model table).
- Better calibration — cross-encoders are trained on millions of rank-pair examples.

## Install

```sh
npm install @engram-mem/rerank-onnx
```

### macOS Intel note

`onnxruntime-node@1.23+` dropped `darwin-x64` binaries. If you run Intel macOS, add an npm override:

```json
"overrides": {
  "onnxruntime-node": "1.22.0"
}
```

Apple Silicon and Linux x64/arm64 work with the default version.

## Usage

Compose with an existing intelligence adapter via object spread:

```ts
import { openaiIntelligence } from '@engram-mem/openai'
import { createOnnxReranker } from '@engram-mem/rerank-onnx'
import { createMemory } from '@engram-mem/core'

const openai = openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY! })
const onnx = createOnnxReranker() // default: gte-reranker-modernbert-base @ q8
await onnx.load() // optional — rerank() auto-loads on first call

const memory = createMemory({
  storage,
  intelligence: {
    ...openai,
    rerank: (query, docs) => onnx.rerank(query, docs),
  },
})
```

## Options

```ts
createOnnxReranker({
  model: 'Alibaba-NLP/gte-reranker-modernbert-base', // or mixedbread-ai/mxbai-rerank-{large,base,xsmall}-v1
  dtype: 'q8',        // 'fp32' | 'fp16' | 'q8' | 'q4'
  batchSize: 8,       // pairs per forward pass
  maxCandidates: 50,  // cap on docs reranked per call; docs past it get no score
  maxLength: 512,     // max tokens per pair
  maxDocChars: 1200,  // chars per doc before tokenization
})
```

## Model variants

| Model                                                   | Params | Quality | Rerank p50 | RSS |
|---------------------------------------------------------|--------|---------|------------|-----|
| `Alibaba-NLP/gte-reranker-modernbert-base` (**default**) | 149M   | Equal to large-v1 within the judge's noise band on LongMemEval_s (150-question stratified subset: 121 vs 123 strict, band 8, McNemar p = 0.79); ahead on 50 real recall queries (19 wins / 13 losses / 18 ties, blind pairwise top-5) | 3.6 s | 1.66 GB |
| `mixedbread-ai/mxbai-rerank-large-v1` (previous default) | 435M   | Reference | 17.2 s | 2.84 GB |
| `mixedbread-ai/mxbai-rerank-base-v1`                     | 184M   | Good | faster than large | lower |
| `mixedbread-ai/mxbai-rerank-xsmall-v1`                   | 70M    | Decent | fastest mxbai | lowest |

Rerank p50 and RSS (after 50 queries) were measured at q8 in the MCP server on the production CPU host, with up to 25 docs per call; the mxbai base/xsmall rows were not measured there. The default `maxCandidates` is now 50, so that the largest slate recall sends (30 fused candidates plus a 15-row lexical reserve) is scored in full. Rerank time grows with the number of docs, so a full 45-doc slate takes longer than the p50 above.

**Score scale:** each model's sigmoid output sits on its own scale (on the same recalls, 69.7% of gte scores are ≥ 0.5 vs 6.4% for large-v1). Scores only order candidates within one model; nothing may gate on an absolute rerank score.

**Upgrading:** an install that sets `ENGRAM_RERANK_LOCAL=true` without `ENGRAM_RERANK_LOCAL_MODEL` moves from `mxbai-rerank-large-v1` to `gte-reranker-modernbert-base`. The first rerank after the upgrade downloads the new q8 weights, and relevance values shift to the new scale. To keep the previous model, set `ENGRAM_RERANK_LOCAL_MODEL=mixedbread-ai/mxbai-rerank-large-v1`.

> **In the MCP server (`@engram-mem/mcp`):** just set `ENGRAM_RERANK_LOCAL=true` in the server's env — the MCP startup will dynamically import this package and spread its `rerank` over the openaiIntelligence adapter automatically. Pick the model via `ENGRAM_RERANK_LOCAL_MODEL` (default: `Alibaba-NLP/gte-reranker-modernbert-base`).


## Local embedder

The package also exports `createOnnxEmbedder`, a local bi-encoder for the embedding side of recall. The default model is `onnx-community/Qwen3-Embedding-0.6B-ONNX` at `q8`. It implements the `embed`, `embedBatch`, `embedQuery` and `dimensions` members of the core `IntelligenceAdapter`, so it replaces the API embedder in the same way the reranker replaces the API reranker:

```ts
import { openaiIntelligence } from '@engram-mem/openai'
import { createOnnxEmbedder } from '@engram-mem/rerank-onnx'

const embedder = createOnnxEmbedder() // default: Qwen3-Embedding-0.6B @ q8
await embedder.load() // dimensions() reads the model config, so load before wiring

const intelligence = {
  ...openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY! }),
  embed: embedder.embed,
  embedBatch: embedder.embedBatch,
  embedQuery: embedder.embedQuery,
  dimensions: embedder.dimensions,
}
```

Vectors from different embedding models live in different spaces, and this model's hidden size (1024) differs from `text-embedding-3-small` (1536). A store embedded with one model cannot be searched with another; switching models means re-embedding the store.

**Pooling.** Qwen3-Embedding is trained for last-token pooling. The embedder takes each sequence's hidden state at its last non-padding token, located through the attention mask, then L2-normalises it to unit length. Locating the token through the mask makes the result independent of the tokenizer's padding side; taking the final position of the padded batch would only be correct for left padding.

**Query instruction.** The model is asymmetric. `embedQuery` formats a query as the model card does, `Instruct: <task>\nQuery:<query>`, with the default task `Given a question or topic, retrieve memories that answer or relate to it`. `embed` and `embedBatch` embed documents bare. Core's recall and forget preview call `embedQuery` when an adapter provides it, while stored content goes through `embed` / `embedBatch`.

**Verification.** The unit tests stub the tokenizer and the model, so they check the pooling index, the normalisation, the instruction and the batching, not the weights. Before relying on a model, load the real weights once and check that the model card's example queries and documents reproduce its published similarity scores.

```ts
createOnnxEmbedder({
  model: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
  dtype: 'q8',        // 'fp32' | 'fp16' | 'q8' | 'q4'
  queryTask: 'Given a question or topic, retrieve memories that answer or relate to it',
  batchSize: 16,      // texts per forward pass
  maxLength: 512,     // max tokens per text
  maxChars: 2000,     // chars per text before tokenization; the query instruction is not counted
})
```
