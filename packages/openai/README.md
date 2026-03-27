# @engram/openai

OpenAI embeddings and summarization for Engram. Adds semantic vector search and LLM-powered consolidation.

## Installation

```bash
npm install @engram/openai
npm install @engram/core
npm install @engram/sqlite  # or @engram/supabase
```

Set your API key:

```bash
export OPENAI_API_KEY=sk-...
```

## Quick Start — Level 1 (Embeddings)

Add semantic search to SQLite:

```javascript
import { createMemory } from '@engram/core'
import { sqliteAdapter } from '@engram/sqlite'
import { openaiIntelligence } from '@engram/openai'

const memory = createMemory({
  storage: sqliteAdapter(),
  intelligence: openaiIntelligence({
    apiKey: process.env.OPENAI_API_KEY
  })
})

await memory.initialize()
await memory.ingest({ role: 'user', content: 'I prefer TypeScript' })

// Queries now use semantic search (embeddings)
const result = await memory.recall('What languages does the user like?')
console.log(result.formatted)

await memory.dispose()
```

Now `recall()` will:
1. Embed your query into a vector
2. Search for semantically similar digests and semantic memories
3. Fall back to keyword search for episodes and procedural memories

## Configuration

### Embedding Service

```typescript
interface OpenAIIntelligenceOptions {
  apiKey: string                    // Required
  embeddingModel?: string           // Default: 'text-embedding-3-small'
  embeddingDimensions?: number      // Default: 1536
  summarizationModel?: string       // Default: 'gpt-4o-mini'
  intentAnalysis?: boolean          // Reserved for Level 3 (future)
}

const intelligence = openaiIntelligence({
  apiKey: process.env.OPENAI_API_KEY,
  embeddingModel: 'text-embedding-3-large',  // 3072 dimensions, more accurate
  embeddingDimensions: 3072,
  summarizationModel: 'gpt-4-turbo'  // Better summarization quality
})
```

### Embedding Models

| Model | Dimensions | Speed | Quality | Cost |
|-------|-----------|-------|---------|------|
| `text-embedding-3-small` | 1536 | Fast | Good | $0.02/MTok |
| `text-embedding-3-large` | 3072 | Medium | Better | $0.13/MTok |

For most use cases, small is fine. Use large if query precision is critical.

### Summarization Models

| Model | Speed | Quality | Cost |
|-------|-------|---------|------|
| `gpt-4o-mini` | Fast | Good | $0.15/$0.60 per 1M tokens |
| `gpt-4-turbo` | Medium | Better | $10/$30 per 1M tokens |
| `gpt-4o` | Medium | Best | $2.50/$10 per 1M tokens |

Use mini for speed. Use turbo/4o for quality when budget allows.

## Level 1 vs Level 3

### Level 1 (Embeddings Only)

```javascript
const memory = createMemory({
  intelligence: openaiIntelligence({ apiKey: '...' })
})
```

Features:
- Embedding-based semantic search
- Heuristic consolidation (rule-based summaries)
- Heuristic intent analysis (pattern-matched)
- Fast and cheap

### Level 3 (Full Cognitive) — Future

```javascript
const memory = createMemory({
  intelligence: openaiIntelligence({
    apiKey: '...',
    intentAnalysis: true,    // Not yet implemented
    summarization: true      // Summarization is implemented, but auto-consolidation hooks not yet
  }),
  consolidation: { schedule: 'auto' }
})
```

Features (to come):
- LLM-powered intent classification (better understanding of queries)
- LLM-powered summarization (better digests)
- Auto-consolidation on schedule

For now, `intentAnalysis: true` has no effect. Use `summarization: true` to enable LLM summaries during manual `consolidate()` calls.

## API Reference

All usage goes through the Memory class. The IntelligenceAdapter is internal.

```typescript
export function openaiIntelligence(opts: OpenAIIntelligenceOptions): IntelligenceAdapter
```

The adapter provides:

```typescript
interface IntelligenceAdapter {
  // Embedding
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  dimensions(): number

  // Summarization
  summarize(content: string, opts?: SummarizeOptions): Promise<string>
  extractKnowledge(content: string): Promise<KnowledgeExtraction>
}
```

## How Embeddings Work

When you call `recall(query)`:

1. **Embed query** — Convert to 1536-dim vector (or 3072 if using large)
2. **Search semantic memories** — Find similar facts (cosine similarity)
3. **Search digests** — Find similar summaries
4. **Keyword fallback** — Use BM25 for episodes and procedural

Costs roughly **$0.00001 per query** (small model).

## How Summarization Works

When you call `consolidate()` with LLM summarization:

1. **Batch episodes** — Group recent episodes by session
2. **Summarize** — Use GPT to create concise digest
3. **Extract topics** — Identify key topics from digest
4. **Embed digest** — Store embedding for future search

Costs roughly **$0.01-0.10 per digest** (depends on model).

## Cost Estimation

For a typical agent with 1000 messages:

**Embeddings**:
- 1000 queries × $0.000001 = $0.001
- Very cheap

**Consolidation** (one full cycle):
- Light sleep (100 episodes → 10 digests): ~$0.10
- Deep sleep (10 digests → facts): ~$0.05
- Total: ~$0.15 per 1000 messages

**Monthly budget** for active agent:
- If 100 messages/day × 30 days = 3000 messages
- Recall: 3000 queries × 30 days = ~$0.003 (negligible)
- Consolidation: 3 full cycles × $0.15 = ~$0.45
- **Total: ~$0.45/month**

This is very economical compared to traditional cloud memory services.

## Troubleshooting

**Q: Embedding failures**

A: Check API key, rate limits, and network. OpenAI rate limits are generous ($200/month free tier). Errors are logged.

**Q: High costs**

A: You may be calling `consolidate()` too often or using a large model. Switch to small embeddings and mini summarizer to reduce cost.

**Q: Summarization quality is poor**

A: Try a better model (`gpt-4-turbo` or `gpt-4o`). Or provide better prompts (future customization).

**Q: Embedding search not working**

A: Embeddings only help if memories actually have embeddings. Run `consolidate('light')` and `consolidate('deep')` first to create digests with embeddings.

**Q: Can I use other embedding models?**

A: Not yet. Future versions may support Anthropic, Cohere, or local models. Currently, OpenAI only.

## Best Practices

1. **Start with Level 0** (SQLite + BM25) to validate memory flow
2. **Move to Level 1** when keyword search isn't precise enough
3. **Run consolidation monthly** — balance cost with memory freshness
4. **Monitor API usage** via OpenAI dashboard
5. **Use small embeddings** by default, switch to large if precision matters
6. **Cache embeddings** — don't re-embed the same text

## Upgrade Path

```javascript
// Level 0: No intelligence
createMemory({ storage: sqliteAdapter() })

// Level 1: Add embeddings
createMemory({
  storage: sqliteAdapter(),
  intelligence: openaiIntelligence({ apiKey: '...' })
})

// Level 2: Add cloud storage
createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' }),
  intelligence: openaiIntelligence({ apiKey: '...' })
})

// Level 3: Add auto-consolidation (future)
createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' }),
  intelligence: openaiIntelligence({
    apiKey: '...',
    intentAnalysis: true,
    summarization: true
  }),
  consolidation: { schedule: 'auto' }
})
```

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) at repo root.

## License

MIT
