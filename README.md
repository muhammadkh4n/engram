# Engram — A Brain for Your AI Agents

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-@engram--mem-blue.svg)](https://www.npmjs.com/search?q=%40engram-mem)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0+-3178c6.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-Vitest-6e9f18.svg)](https://vitest.dev/)

**Your agent has amnesia. We gave it a hippocampus.**

Other memory systems remember what you told them. Engram learns what matters and forgets what doesn't — across sessions, projects, and agents. Five memory systems, graph-based spreading activation, and consolidation cycles that turn conversations into semantic knowledge.

> Published as [`@engram-mem/*`](https://www.npmjs.com/search?q=%40engram-mem) on npm. Not affiliated with `engram-sdk` or engram.fyi — different project, different architecture.

## Start in 30 seconds

**For Claude Code users:**

```bash
npm install -g @engram-mem/mcp
```

Add to `~/.claude/settings.json` — see [MCP setup](packages/mcp/README.md).

**For builders:**

```bash
npm install @engram-mem/core @engram-mem/sqlite
```

```javascript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'

const memory = createMemory({ storage: sqliteAdapter() })
await memory.initialize()

await memory.ingest({ role: 'user', content: 'I prefer TypeScript strict mode' })
await memory.consolidate('light')

const { memories } = await memory.recall('What TypeScript config do I use?')
console.log(memories[0]?.content)
```

No API keys required. SQLite + BM25 out of the box. Upgrade to embeddings, cloud storage, or Neo4j graph when ready.

## What's New in v0.6.0

**Synthesize recall mode (preference-first) + session ranking — judged end-to-end on LongMemEval-S.**

- **`recall(query, { synthesize: true })`** returns a deterministic, citation-anchored `synthesis` block derived from the recalled memories and appends it to `formatted`. The default renders **preference constraint-surfacing only** — stated user preferences quoted verbatim with session/date citations plus an apply-this-preference instruction. Code-only: zero LLM calls at recall time. Judged effect on preference questions under a current answerer: 30.0% → 53.3% strict, 7 improvements / 0 regressions, p = 0.016.
- **Temporal/aggregation compute notes are opt-in** (`synthesize: { includeComputeNotes: true }`): current thinking-tier answerers recompute dates and counts from the raw sessions themselves, so injected notes measured noise-level to slightly negative for them — opt in only for weak answerers. Grounding guards regardless: every calendar date in a block is validated against the source evidence date set, counts are phrased as candidates that defer to in-context evidence, and `memories` is byte-identical whether synthesis ran or not.
- **`RecallResult.sessions`** — additive session-completeness ranking (RRF mass per session, earliest/latest event dates); the memories array is never reordered. `RetrievedMemory.sessionId` now flows through every retrieval path.
- **Judged end-to-end accuracy** (LongMemEval-S, 500 questions, 3-vote heterogeneous judge panel, strictest tie-break): **79.4% strict / 83.4% lenient** with a DeepSeek V4-Flash thinking answerer over Engram retrieval — the answerer, not the memory system, was the previous bottleneck (same stack with gpt-4o-mini: 52.8% strict). Pre-registered criteria, paired McNemar; artifacts committed under `results/longmemeval/`.
- **Self-host upgrade:** re-apply `packages/postgrest/schema.sql` (idempotent) and run `NOTIFY pgrst, 'reload schema';` so the recall RPCs expose `session_id`.

## What's New in v0.4.x

**Self-host story complete — bring your own infra, zero marginal cost.**

| Release | Highlight |
|---------|-----------|
| v0.4.0 | `@engram-mem/supabase` rebranded to `@engram-mem/postgrest`. Works against Supabase, self-hosted Postgres + PostgREST, or any PostgREST-compatible endpoint. |
| v0.4.1 | Swapped underlying client from `supabase-js` to bare `postgrest-js` so the BYO-infra path actually works (supabase-js prepended `/rest/v1/`; bare PostgREST doesn't). |
| v0.4.2 | npm audit clean (0 vulnerabilities). `@supabase/supabase-js` dropped from the install tree entirely. |
| v0.4.3 | `ENGRAM_RERANK_LOCAL=true` opt-in: swap the LLM-pointwise reranker for **mxbai-rerank-large-v1** via ONNX Runtime ($0 per query). `ENGRAM_INGEST_CONTEXTUAL=true` enables Anthropic-style Contextual Retrieval at ingest. |
| v0.4.4 | Single idempotent `packages/postgrest/schema.sql` replaces the dual-track migration scheme — `psql -f schema.sql` bootstraps any database state. `ENGRAM_RERANK_LOCAL_MODEL` env var selects the mxbai variant (large / base / xsmall) for memory-constrained boxes. |

**LongMemEval-S benchmark (v0.3.15, May 2026)** — full 500-question, single-session evaluation:

| Metric | Score |
|---|---|
| **R@5** (correct evidence in top-5 retrieved) | **98.8%** |
| R@10 | **99.6%** |

> Beats the published Zep/Graphiti baseline (63.8%) on the same benchmark by ~35pp. The single miss across 500 questions was a visual-content query; all non-visual categories at 100%. Methodology in [packages/bench/README.md](packages/bench/README.md).

**LoCoMo retrieval baseline** (legacy benchmark, 1,986 questions across 10 conversations) — 85% R@K after the v0.3.6 correction. Engram's design isn't optimized for LoCoMo's compressed-fact recall shape; LongMemEval-S is the more meaningful target.

> **Metric note:** R@K measures retrieval recall (gold evidence present in the top-K candidates), not judge-graded answer correctness. The two are different — see [CHANGELOG.md](CHANGELOG.md) for full release context.

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

## Examples

- [`examples/demo.mjs`](examples/demo.mjs) — standalone SQLite demo, no API keys
- [`examples/claude-code-memory.mjs`](examples/claude-code-memory.mjs) — persistent memory across Claude Code sessions

```bash
npm install @engram-mem/core @engram-mem/sqlite
node examples/demo.mjs
```

## Packages

| Package | Purpose | Key Features |
|---------|---------|--------------|
| `@engram-mem/core` | Memory engine | 5 memory systems, 4-stage recall, consolidation cycles, intent analysis, salience detection |
| `@engram-mem/sqlite` | Local storage | Zero-config SQLite + BM25 full-text search, zero dependencies |
| `@engram-mem/postgrest` | PostgREST storage | PostgreSQL + pgvector via any PostgREST endpoint (Supabase, self-hosted, EnterpriseDB cloud) — uses bare `@supabase/postgrest-js` |
| `@engram-mem/supabase` | _Deprecated shim_ | Re-exports `@engram-mem/postgrest` for backward compat (will be removed in v0.5.0) |
| `@engram-mem/openai` | Intelligence | OpenAI embeddings, summarization, reranking, contextualization |
| `@engram-mem/rerank-onnx` | Local reranker | mxbai-rerank-large/base/xsmall-v1 via ONNX Runtime — zero per-query cost, opt-in via `ENGRAM_RERANK_LOCAL=true` |
| `@engram-mem/graph` | Neural graph | Neo4j spreading activation, community detection, pattern completion |
| `@engram-mem/openclaw` | Framework integration | OpenClaw ContextEngine plugin, 4 memory tools, auto-consolidation |
| `@engram-mem/mcp` | Claude integration | MCP server (stdio + Streamable HTTP), 13 bin CLIs, Claude Code hooks |
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
| 2 | PostgREST (Supabase or self-hosted) | OpenAI embeddings | Manual | Share memory between agents over HTTP. |
| 3 | PostgREST + Neo4j graph | OpenAI + local mxbai-rerank | Auto | Full cognitive engine with $0 marginal rerank. |

Pick a level. Start at 0. Upgrade anytime.

```javascript
// Level 0 (included, shown above)

// Level 1: Add embeddings
import { openaiIntelligence } from '@engram-mem/openai'
const memory = createMemory({
  intelligence: openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY })
})

// Level 2: PostgREST storage (Supabase OR self-hosted)
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
const memory = createMemory({
  storage: new PostgRestStorageAdapter({
    url: process.env.POSTGREST_URL,    // https://*.supabase.co  OR  http://127.0.0.1:3001
    key: process.env.POSTGREST_KEY,    // service-role JWT (or any JWT signed with your PGRST_JWT_SECRET)
  }),
  intelligence: openaiIntelligence({ apiKey: '...' })
})

// Level 3: Full cognitive engine with graph + local rerank
import { NeuralGraph } from '@engram-mem/graph'
import { createOnnxReranker } from '@engram-mem/rerank-onnx'

const onnx = createOnnxReranker()  // mxbai-rerank-large-v1 by default
const memory = createMemory({
  storage: new PostgRestStorageAdapter({ url: '...', key: '...' }),
  intelligence: {
    ...openaiIntelligence({ apiKey: '...', intentAnalysis: true }),
    rerank: onnx.rerank.bind(onnx),  // swap LLM rerank for $0 local cross-encoder
  },
  graph: new NeuralGraph({ uri: 'bolt://localhost:7687', user: 'neo4j', password: '...' }),
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
  sessions?: SessionGroup[]        // v0.6: session-completeness ranking (additive)
  synthesis?: SynthesisBlock | null // v0.6: opt-in derived-from-memory block
}
```

Pass `{ synthesize: true }` to opt into the synthesis block — preference constraint-surfacing by default, compute notes via `{ synthesize: { includeComputeNotes: true } }`. Full reference in the [`@engram-mem/core` README](packages/core/README.md#synthesize-mode-v06).

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

## MCP Server Setup (Claude Code)

Install the MCP server globally:

```bash
npm install -g @engram-mem/mcp
```

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "engram-mcp",
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_KEY": "<service-role JWT — needs RLS bypass for writes>",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

> The env keys are still named `SUPABASE_URL` / `SUPABASE_KEY` for backward compatibility — but as of v0.4.0 they accept any PostgREST endpoint URL + any JWT signed with your `PGRST_JWT_SECRET`. Point them at hosted Supabase, self-hosted Postgres + PostgREST, or any PostgREST-compatible deployment.

**Optional v0.4.x env flags** for the full self-host story:

```json
"env": {
  "NEO4J_URI": "bolt://localhost:7687",        // enables graph spreading-activation recall
  "NEO4J_USER": "neo4j",
  "NEO4J_PASSWORD": "...",

  "ENGRAM_RERANK_LOCAL": "true",                // swap LLM rerank for local ONNX cross-encoder
  "ENGRAM_RERANK_LOCAL_MODEL": "mixedbread-ai/mxbai-rerank-base-v1",   // optional: pick variant (default: large-v1, ~1-1.5GB RAM)

  "ENGRAM_INGEST_CONTEXTUAL": "true"            // Anthropic-style contextual preamble per turn
}
```

> **Project isolation (Wave 5).** `memory_recall` and `memory_ingest` take an optional declarative `project_id` parameter — the agent passes the current project (e.g. the git repo name) to scope the call. A scoped recall returns only that project's memories plus shared (`NULL`) ones; every other project is excluded, enforced in both SQL and the graph traversal. Omit it for unscoped (all projects). The server itself holds no project state, so one shared HTTP server isolates correctly per request. The git/hook ingest CLIs auto-detect the project from their working directory (`ENGRAM_PROJECT_ID` overrides).

Available MCP tools: `memory_recall`, `memory_ingest`, `memory_forget`, `memory_timeline`, `memory_overview`, `memory_bridges`, `memory_consolidation_status`.

See [`packages/mcp/README.md`](packages/mcp/README.md) for full tool schemas and troubleshooting.

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

### PostgREST (Supabase OR Self-hosted)
```javascript
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'

const memory = createMemory({
  storage: new PostgRestStorageAdapter({
    url: process.env.POSTGREST_URL,   // hosted Supabase URL OR self-hosted PostgREST endpoint
    key: process.env.POSTGREST_KEY    // service-role JWT (not the anon key — needs RLS bypass)
  })
})
```

Best for: Multi-agent systems, persistent storage, scaling. Works against hosted Supabase, self-hosted Postgres + PostgREST in Docker, or any PostgREST-compatible endpoint.

**Self-host bootstrap**: apply `packages/postgrest/schema.sql` once with `psql -U postgres -d engram -f schema.sql` — idempotent, re-runnable, creates all tables + functions + RLS policies from scratch.

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
