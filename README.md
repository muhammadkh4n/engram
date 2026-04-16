# Engram: Brain-Inspired Cognitive Memory for AI Agents

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-@engram--mem-blue.svg)](https://www.npmjs.com/search?q=%40engram-mem)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0+-3178c6.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-Vitest-6e9f18.svg)](https://vitest.dev/)

Brain-inspired cognitive memory engine for AI agents. While other context engines compress and retrieve, Engram consolidates, associates, primes, and strengthens — like biological memory.

## What's New in v0.3.0

**Retrieval overhaul — 3.4x recall improvement.**

| Change | Impact |
|--------|--------|
| Cross-encoder reranking | LLM pointwise scoring for precise semantic ordering |
| Wide vector scan pool | Scan 500 candidates instead of 90, no recency bias |
| BM25 as independent candidates | Keyword matches enter the pipeline even with weak embeddings |
| Contextual embedding | Preceding turns prepended at ingest for richer vectors |

**LoCoMo Benchmark (conversational QA, 199 questions):**

| Category | R@K |
|----------|-----|
| Single-hop | 34.4% |
| Multi-hop | 70.3% |
| Temporal | 46.2% |
| Commonsense | 71.4% |
| Adversarial | 85.1% |
| **Overall** | **66.8%** |

See [CHANGELOG.md](CHANGELOG.md) for full release history.

## Why Engram

Existing context engines focus on **compression and retrieval** (the LCM approach). Engram models **five cognitive memory systems** with consolidation cycles, associative networks, intent-driven recall, and reconsolidation — mirroring how biological memory actually works.

**Positioning**: LCM is the best compression engine. Engram is the best cognitive engine. Choose based on whether you want an agent that remembers or an agent that learns.

## Architecture

Engram implements a brain-inspired memory system with five interconnected memory systems:

```
INGEST → [Salience Detection, Entity Extraction, Temporal Linking]
         ↓
    ┌────────────────────────────────────────────────┐
    │      ASSOCIATIVE NETWORK (Graph Edges)         │
    │  temporal, causal, topical, supports,          │
    │  contradicts, elaborates, derives_from, co_recalled
    │                                                 │
    │  ┌─────────────┐  ┌──────────┐  ┌────────────┐ │
    │  │  EPISODIC   │  │ SEMANTIC │  │ PROCEDURAL │ │
    │  │  (events)   │  │ (facts)  │  │ (how-to)   │ │
    │  │             │  │          │  │            │ │
    │  │ - lossless  │  │ - decays │  │ - learns   │ │
    │  │ - temporal  │  │ - scored │  │ - counts   │ │
    │  └─────────────┘  └──────────┘  └────────────┘ │
    │         ↑              ↑              ↑          │
    │         └──────────────┼──────────────┘          │
    │                   SENSORY BUFFER                 │
    │              (working memory ~100)               │
    └────────────────────────────────────────────────┘
         ↓
RECALL → [BM25/Vector Search, Association Walk, Priming, Reconsolidation]
         ↓
    CONSOLIDATION → [Light Sleep, Deep Sleep, Dream, Decay]
    (automatic or manual)
```

**Five Memory Systems**:
- **Sensory Buffer** — Working memory. What's top-of-mind right now (~100 items, volatile)
- **Episodic** — Raw conversation turns. Lossless ground truth. Never deleted.
- **Semantic** — Extracted facts and concepts. Decays with confidence scores.
- **Procedural** — Learned workflows, preferences, habits. Confidence + observation count.
- **Associative Network** — 8 edge types linking memories to enable discovery and pattern completion

## Quick Start

Zero-config, no API keys required:

```javascript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'

const memory = createMemory({ storage: sqliteAdapter() })
await memory.initialize()

// Ingest
await memory.ingest({ role: 'user', content: 'I prefer TypeScript' })

// Recall
const result = await memory.recall('What languages does the user like?')
console.log(result.formatted)

await memory.dispose()
```

That's it. SQLite + BM25, no setup. Upgrade to embeddings and cloud storage later.

## Packages

| Package | Purpose | Key Features |
|---------|---------|--------------|
| `@engram-mem/core` | Memory engine | 5 memory systems, 4-stage recall, consolidation cycles, intent analysis, salience detection |
| `@engram-mem/sqlite` | Local storage | Zero-config SQLite + BM25 full-text search, zero dependencies |
| `@engram-mem/openai` | Intelligence | OpenAI embeddings, vector search, LLM-based summarization |
| `@engram-mem/supabase` | Cloud storage | PostgreSQL + pgvector, distributed agents, scalable |
| `@engram-mem/graph` | Neural graph | Neo4j spreading activation, community detection, pattern completion |
| `@engram-mem/openclaw` | Framework integration | OpenClaw ContextEngine plugin, 4 memory tools, auto-consolidation |
| `@engram-mem/mcp` | Claude integration | MCP server for Claude Code, memory tools for AI assistants |
| `@engram-mem/bench` | Benchmarks | LoCoMo + LongMemEval evaluation, comparison mode, CLI runner |

## Core Concepts

### Four-Stage Retrieval

When you call `recall(query)`:

1. **Recall** — BM25 or vector search across all tiers
2. **Association Walk** — Follow edges to discover related memories
3. **Priming** — Boost topics from recent recalls
4. **Reconsolidation** — Bump up accessed memories' importance

### Four Consolidation Cycles

Run automatically or manually:

- **Light Sleep** — Episodes → Digests (summaries)
- **Deep Sleep** — Digests → Semantic & Procedural memories
- **Dream Cycle** — Extract new associations between memories
- **Decay Pass** — Prune low-confidence items and stale edges

## Upgrade Path

| Level | Storage | Intelligence | Consolidation | Use Case |
|-------|---------|---------------|---------------|----------|
| 0 | SQLite + BM25 | Heuristic | Manual | Fast, local, zero-cost. Good for testing. |
| 1 | SQLite | OpenAI embeddings | Manual | Add vector search. Still fully local DB. |
| 2 | Supabase (cloud) | OpenAI embeddings | Manual | Share memory between agents. |
| 3 | Supabase (cloud) | OpenAI (embeddings + intent + summarization) | Auto | Full cognitive engine. LLM-powered everything. |

Pick a level. Start at 0. Upgrade anytime.

```javascript
// Level 0 (included, shown above)

// Level 1: Add embeddings
import { openaiIntelligence } from '@engram-mem/openai'
const memory = createMemory({
  intelligence: openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY })
})

// Level 2: Add cloud storage
import { supabaseAdapter } from '@engram-mem/supabase'
const memory = createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' }),
  intelligence: openaiIntelligence({ apiKey: '...' })
})

// Level 3: Full cognitive engine
const memory = createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' }),
  intelligence: openaiIntelligence({
    apiKey: '...',
    intentAnalysis: true,
    summarization: true
  }),
  consolidation: { schedule: 'auto' }
})
```


## API Reference

### createMemory(options)

Factory function. Returns a Memory instance.

```typescript
interface MemoryOptions {
  storage: StorageAdapter                    // Required
  intelligence?: IntelligenceAdapter         // Optional, defaults to heuristic
  consolidation?: { schedule: 'auto' | 'manual' }  // Optional
  tokenizer?: (text: string) => number       // Optional, for token budgets
}
```

### Memory Methods

#### `initialize(): Promise<void>`
Initialize storage and load sensory buffer snapshot. Must call before operations.

#### `ingest(message): Promise<void>`
Store a message. Auto-detects salience, extracts entities, creates temporal edges.

```typescript
interface Message {
  sessionId?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: Record<string, unknown>
}
```

#### `recall(query, opts?): Promise<RecallResult>`
Intent-analyzed, association-walked, primed recall.

```typescript
interface RecallResult {
  memories: RetrievedMemory[]      // Direct hits
  associations: RetrievedMemory[]  // Via graph walk
  intent: IntentResult             // Classified intent
  primed: string[]                 // Boosted topics
  estimatedTokens: number          // Token estimate for context
  formatted: string                // Ready to inject into prompt
}
```

#### `expand(memoryId): Promise<{ episodes: Episode[] }>`
Drill into a digest to see original episodes.

#### `consolidate(cycle?): Promise<ConsolidateResult>`
Run consolidation. Cycle: `'light' | 'deep' | 'dream' | 'decay' | 'all'` (default: 'all').

#### `stats(): Promise<MemoryStats>`
Returns counts: episodes, digests, semantic, procedural, associations.

#### `forget(query, opts?): Promise<ForgetResult>`
Lossless deprioritization. Pass `confirm: true` to apply.

#### `session(sessionId?): SessionHandle`
Get or create a session-scoped handle. Auto-generates sessionId if omitted.

#### `dispose(): Promise<void>`
Release resources, persist sensory buffer snapshot.

## MCP Server Setup

Engram includes an MCP (Model Context Protocol) server for Claude Code integration. Add to Claude's settings.json:

```json
{
  "mcpServers": {
    "engram-memory": {
      "command": "node",
      "args": ["/path/to/openclaw-memory/packages/mcp/dist/index.js"]
    }
  }
}
```

Then in Claude Code, use the memory tools:
- `engram_search` — Deep memory search
- `engram_stats` — Memory statistics
- `engram_forget` — Lossless deprioritization
- `engram_consolidate` — Manual consolidation

Messages are automatically ingested and associated across sessions.

## Storage Adapters

Engram ships with multiple storage adapters. Choose based on your needs:

### SQLite (Local, Zero-Config)
```javascript
import { sqliteAdapter } from '@engram-mem/sqlite'

const memory = createMemory({
  storage: sqliteAdapter({ path: './engram.db' })
})
```

Best for: Development, single-agent, no infrastructure.

### Supabase (Cloud, Distributed)
```javascript
import { supabaseAdapter } from '@engram-mem/supabase'

const memory = createMemory({
  storage: supabaseAdapter({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_ANON_KEY
  })
})
```

Best for: Multi-agent systems, persistent storage, scaling.

## OpenClaw Plugin

Engram is a drop-in OpenClaw ContextEngine. One command to install:

```bash
# From the packages/openclaw directory, or via remote URL:
bash install.sh
```

Or manually:

```bash
cd ~/.openclaw
mkdir -p engram/dist
npm init -y && npm install @engram-mem/core @engram-mem/sqlite @engram-mem/openai
# Copy compiled plugin to engram/dist/openclaw-plugin.js
# Update openclaw.json to load plugin and set context engine
```

**Plugin Features**:
- Automatic message ingestion via `afterTurn` hook
- Deep memory search via `engram_search` tool
- Memory stats via `engram_stats` tool
- Manual forget via `engram_forget` tool
- Manual consolidation via `engram_consolidate` tool
- Auto-consolidation every 100 episodes

**Warning**: `afterTurn` is called with full session history. The plugin extracts only new messages from this turn to avoid re-ingesting. Understand this contract before modifying.

## Standalone Usage

Engram is framework-agnostic. Use without OpenClaw:

```javascript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { openaiIntelligence } from '@engram-mem/openai'

const memory = createMemory({
  storage: sqliteAdapter({ path: './my-memory.db' }),
  intelligence: openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY })
})

await memory.initialize()

// Your agent loop
for (const userMessage of userMessages) {
  await memory.ingest({ role: 'user', content: userMessage })

  const recalled = await memory.recall(userMessage)
  const context = recalled.formatted  // Inject into system prompt

  const response = await llm(userMessage, { system: context })
  await memory.ingest({ role: 'assistant', content: response })

  // Optional: manually consolidate periodically
  if (episodeCount % 50 === 0) {
    await memory.consolidate('light')
  }
}

await memory.dispose()
```

## How It Works

### Intent Analysis

Engram auto-classifies queries into 11 intent types:
- `TASK_START`, `TASK_CONTINUE`, `QUESTION`, `RECALL_EXPLICIT`
- `DEBUGGING`, `PREFERENCE`, `REVIEW`, `CONTEXT_SWITCH`
- `EMOTIONAL`, `SOCIAL`, `INFORMATIONAL`

Each intent type has a custom **retrieval strategy** (which tiers to search, how much to prioritize procedural vs. semantic, whether to include associations). No manual tuning needed.

### Salience Detection

Every ingested message is auto-scored for salience using 10 signal types:
- Explicit keywords (prefer, important, remember)
- Numbers (decisions, metrics)
- Decisions and constraints
- Questions and tasks
- Code and technical artifacts
- Emotional markers
- Role changes
- Repetition
- and more

Higher salience = higher recall weight and slower decay.

### Reconsolidation

When a memory is accessed during recall, Engram:
- Increments access count
- Updates last access timestamp
- **Reconsolidates** it: boosts confidence for semantic, increments observation count for procedural

This mimics biological memory: accessing a memory makes it stronger.

### Lossless Design

Memories are never deleted. Instead, they decay:
- Semantic: confidence score drops to 0.05 (below retrieval floor)
- Procedural: decayRate increases
- Episodes: marked as consolidated but still retrievable
- Edges: pruned if both endpoints fall below confidence floor

This preserves the agent's history even as old memories fade from active retrieval.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup and local testing
- Monorepo structure and package organization
- Code style and testing conventions
- Adding new storage or intelligence adapters
- Pull request process

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) file for details.

Copyright 2026 Muhammad Khan.

## Brain-Science References

Engram's design is inspired by:
- **Sensory Buffer**: Baddeley's working memory model (phonological loop + visuo-spatial sketchpad)
- **Episodic System**: Hippocampus-dependent autobiographical memory
- **Semantic System**: Cortical distributed knowledge networks
- **Procedural System**: Striatal habit learning (implicit memory)
- **Associative Network**: Neuromodulation and pattern completion during retrieval
- **Consolidation Cycles**: Sleep-dependent memory consolidation (light sleep, deep sleep, REM dream, and decay)
- **Reconsolidation**: Destabilization and restabilization of memories during recall

The 4-stage retrieval pipeline (recall → association walk → priming → reconsolidation) mirrors the temporal dynamics of a memory search in the brain.
