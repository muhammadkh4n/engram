# @engram-mem/rerank-onnx

Local cross-encoder reranker for Engram. Runs `mxbai-rerank-v1` (DeBERTa-v2) via ONNX Runtime through `@huggingface/transformers`. No API calls at query time — weights are downloaded on first use and cached by HuggingFace locally.

## Why

Engram's default reranker is an LLM pointwise scorer (gpt-4o-mini). That works, but:

- Every recall that crosses the rerank threshold costs ~$0.001 in API calls.
- Latency is dominated by the round-trip to OpenAI (~1-3s per rerank).
- The ordering quality is capped by what gpt-4o-mini can discriminate over a tight JSON-scored list.

A purpose-built cross-encoder like `mxbai-rerank-large-v1` typically gives stronger ordering with:

- Zero API cost (model runs locally).
- ~10-50ms inference per query after the model is loaded.
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
const onnx = createOnnxReranker() // default: mxbai-rerank-large-v1 @ q8
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
  model: 'mixedbread-ai/mxbai-rerank-large-v1', // or -base-v1 / -xsmall-v1
  dtype: 'q8',        // 'fp32' | 'fp16' | 'q8' | 'q4'
  batchSize: 8,       // pairs per forward pass
  maxCandidates: 25,  // cap on docs reranked per call
  maxLength: 512,     // max tokens per pair
  maxDocChars: 1200,  // chars per doc before tokenization
})
```

## Model variants

| Model                              | Params | q8 size | Quality       | Speed  |
|------------------------------------|--------|---------|---------------|--------|
| mxbai-rerank-large-v1 (**default**)| 435M   | ~113MB  | Best          | Slower |
| mxbai-rerank-base-v1               | 184M   | ~47MB   | Good          | 3x faster |
| mxbai-rerank-xsmall-v1             | 70M    | ~17MB   | Decent        | Fastest |
