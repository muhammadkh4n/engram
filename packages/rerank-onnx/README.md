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
  maxCandidates: 25,  // cap on docs reranked per call
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

Rerank p50 and RSS (after 50 queries) were measured at q8 in the MCP server on the production CPU host; the mxbai base/xsmall rows were not measured there.

**Score scale:** each model's sigmoid output sits on its own scale (on the same recalls, 69.7% of gte scores are ≥ 0.5 vs 6.4% for large-v1). Scores only order candidates within one model; nothing may gate on an absolute rerank score.

**Upgrading:** an install that sets `ENGRAM_RERANK_LOCAL=true` without `ENGRAM_RERANK_LOCAL_MODEL` moves from `mxbai-rerank-large-v1` to `gte-reranker-modernbert-base`. The first rerank after the upgrade downloads the new q8 weights, and relevance values shift to the new scale. To keep the previous model, set `ENGRAM_RERANK_LOCAL_MODEL=mixedbread-ai/mxbai-rerank-large-v1`.

> **In the MCP server (`@engram-mem/mcp`):** just set `ENGRAM_RERANK_LOCAL=true` in the server's env — the MCP startup will dynamically import this package and spread its `rerank` over the openaiIntelligence adapter automatically. Pick the model via `ENGRAM_RERANK_LOCAL_MODEL` (default: `Alibaba-NLP/gte-reranker-modernbert-base`).

