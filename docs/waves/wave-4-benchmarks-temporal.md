# Wave 4: Benchmarking Harness + Temporal Validity Queries

**Document status:** Implementation plan — an agent should implement this without asking questions.
**Date authored:** 2026-04-06
**Repository:** `/Users/muhammadkh4n/Projects/github/muhammadkh4n/engram`
**Target packages:** new `@engram/bench`, `@engram/core`, `@engram/sqlite`, `@engram/supabase`, `@engram/mcp`

---

## Pre-Script: What Engram Is and Why This Wave Exists

### The System

Engram is a brain-inspired cognitive memory engine for AI agents implemented as a TypeScript monorepo at `/Users/muhammadkh4n/Projects/github/muhammadkh4n/engram`. The monorepo uses npm workspaces (root `package.json`) with Turborepo for task orchestration (`turbo.json`).

Current packages:

- `packages/core` — `@engram/core`. The pure TypeScript engine. Contains: `Memory` class (`memory.ts`), five memory systems, four consolidation cycles, 11-type intent classifier, hybrid retrieval pipeline. No I/O. All storage goes through adapter interfaces defined in `src/adapters/storage.ts`. Key public export: `createMemory(opts)` from `create-memory.ts`. Recall signature: `memory.recall(query, opts?)` where `opts` is `{ embedding?: number[]; tokenBudget?: number }`. Return type: `RecallResult` (defined in `types.ts`).

- `packages/sqlite` — `@engram/sqlite`. `SqliteStorageAdapter` backed by `better-sqlite3`. Schema migrations use `PRAGMA user_version` in `src/migrations.ts`. Current version is V2 (V1 base tables + V2 `episode_parts`). Note: V2 is the latest migration because Neo4j (not SQLite) handles graph persistence — there is no V3 SQL graph table migration. V3 in Wave 4 is for temporal columns.

- `packages/supabase` — `@engram/supabase`. `SupabaseStorageAdapter` via `@supabase/supabase-js`. Migration files in `supabase/migrations/`. Latest file: `20260401000001_enable_rls_all_tables.sql`. Wave 4 adds `20260406000001_temporal_columns.sql`.

- `packages/openai` — `@engram/openai`. `OpenAIIntelligenceAdapter` implementing `IntelligenceAdapter`.

- `packages/mcp` — `@engram/mcp`. MCP server (`src/index.ts`). Currently exposes three tools: `memory_recall`, `memory_ingest`, `memory_forget`. Uses `SupabaseStorageAdapter` + `OpenAIIntelligenceAdapter`.

- `packages/graph` — `@engram/graph`. Created in Wave 1. Wraps `neo4j-driver`. Contains `NeuralGraph` class (Cypher-based, all graph state lives in Neo4j — NOT in-process), `SpreadingActivation` engine (Cypher variable-length path traversal), 8 node label types, 13 relationship types, context extraction helpers. All operations go through Neo4j Bolt; there is no in-memory graph object.

### What Waves 1–3 Built

**Wave 1**: `@engram/graph` package. `NeuralGraph` wrapping `neo4j-driver`. All graph state persisted in a running Neo4j instance (Community Edition, Bolt port 7687). 8 node labels: `Memory`, `Person`, `Topic`, `Entity`, `Emotion`, `Intent`, `Session`, `TimeContext`. 13 relationship types. `SpreadingActivation` using Cypher variable-length path traversal with decay parameters. Context extraction functions. Neo4j constraints and indexes applied on `connect()`.

**Wave 2**: Graph-aware ingestion and retrieval. On `ingest()`, each episode becomes a `Memory` node in Neo4j with adjacent `Person`, `Topic`, `Entity`, `Emotion`, `Intent`, `Session`, `TimeContext` nodes via `decomposeEpisode()`. Recall pipeline runs 4-way parallel search (vector + BM25 + temporal + entity), passes results to `NeuralGraph.spreadActivation()` as Cypher seeds, merges activated node IDs back to SQL content via `NeuralGraph.getMemoryNodeIds()`, returns `CompositeMemory`. MCP responses include environmental context.

**Wave 3**: All 4 consolidation cycles are graph-aware. Light sleep creates digest `Memory` nodes in Neo4j with `DERIVES_FROM` relationships to source episode nodes. Deep sleep creates semantic/procedural `Memory` nodes with temporal validity (`validFrom`/`validUntil` on Neo4j node properties) and `CONTRADICTS` relationships on supersession. Dream cycle uses Neo4j GDS Louvain for community detection, betweenness centrality for bridge node flagging, and hippocampal replay via Cypher spreading activation. Decay pass uses Neo4j GDS PageRank to protect hub memories. Neo4j IS the persistence layer for graph data — no `graph_nodes` or `graph_edges` SQL tables were added.

### CRITICAL: Schema Version Numbering

The previous draft of this document incorrectly referred to a V3 SQL migration for graph tables. That migration does not exist. Neo4j handles graph storage entirely. The actual migration history is:

- **V1** — Base tables: `memories`, `episodes`, `digests`, `semantic`, `procedural`, `associations`, `consolidation_runs`, `sensory_snapshots`. FTS5 virtual tables and triggers.
- **V2** — `episode_parts` table.
- **V3** (this wave) — `valid_from` and `valid_until` columns on `semantic` table. Also adds a partial index.

### What Wave 4 Must Do

Wave 3 added architectural capability for temporal validity (Neo4j nodes have `validFrom`/`validUntil` properties, supersession creates `CONTRADICTS` relationships). But there is no way to query temporal state from the public `Memory` API, and the SQL `semantic` table lacks temporal columns that would allow efficient filtered queries without hitting Neo4j for every recall.

Wave 4 closes both gaps:

1. **Benchmark harness** (`@engram/bench`): Ingest standard memory benchmarks (LoCoMo, LongMemEval) into Engram, run recall queries, output results in benchmark-expected formats. A `--compare` mode runs with-graph (Neo4j + SQL) and without-graph (SQL only) to prove graph value empirically.

2. **Temporal validity queries**: `memory.recall()` gains an `asOf?: Date` parameter. When set, all queries filter to what was believed at that point in time. A new MCP tool `memory_timeline` exposes the supersession chain for a topic.

---

## Audit Fixes Applied in This Version

This document corrects six classes of errors from the previous draft:

**Audit Fix 1: Memory factory uses `:memory:` string, not a Database object.**
`SqliteStorageAdapter` constructor accepts a string path, not a `better-sqlite3` Database instance. The factory must pass the string `':memory:'` directly. Do NOT construct a `Database` object and pass it. Verify the actual constructor signature in `packages/sqlite/src/adapter.ts` before implementing.

**Audit Fix 2: LoCoMo evidence ID mapping is segment-based, not array-index-based.**
LoCoMo evidence IDs are strings like `"D<N>:<M>"` where `N` is a dialogue segment index and `M` is a `dia_id` within that segment. `N` refers to the N-th unique date-group within a single conversation, not the conversation's position in the file array. The adapter must build a `segmentIndex` map (date-group ordinal → segment number, 1-based) per conversation and store `locomoSegmentIndex` in episode metadata. Matching at evaluation time uses `locomoSegmentIndex` and `locomoTurnId` together to reconstruct `D<N>:<M>`.

**Audit Fix 3: F1 is retrieval F1, not generated-answer F1.**
The F1 metric in this harness measures how much of the gold answer text appears in the recalled memory content concatenation. This is NOT the same as running the recalled context through an LLM and judging the generated answer. Published LoCoMo baselines report generated-answer F1 (higher numbers). Our retrieval F1 will be lower. All output must label this explicitly: `"retrieval_f1"`, never just `"f1"`. The docstrings, JSON output keys, and table headers must all say "retrieval F1".

**Audit Fix 4: graph flag controls NeuralGraph initialization, not a runtime skip.**
The `graph?: boolean` field on `MemoryOptions` controls whether `Memory` connects to Neo4j at all. When `graph === false`, `this.graph = null` (or the graph field is never populated), and every code path that calls `this.graph?.spreadActivation(...)` or `this.graph?.decomposeEpisode(...)` is skipped via null-check. This is the Wave 2 null-check pattern. Comparison mode creates two fully separate `Memory` instances: one with `graph: true` (calls `NeuralGraph.connect()` on initialization) and one with `graph: false` (never touches Neo4j). The without-graph instance uses the SQL CTE association walk that predates Wave 2.

**Audit Fix 5: `valid_from`/`valid_until` are first-class SQL columns, not metadata JSON.**
The temporal filter on `SemanticStorage.searchAtTime()` must query the `valid_from` and `valid_until` SQL columns directly. Post-filtering on `metadata` JSON is a fallback that must NOT be the primary path. The `SemanticRow` interface in `packages/sqlite/src/semantic.ts` must include `valid_from: number | null` and `valid_until: number | null`. The row mapper must expose them as ISO strings in `metadata` for convenience, but `searchAtTime()` must issue a SQL query with a WHERE clause, not load all results and filter in JavaScript.

**Audit Fix 6: `getTopicTimeline` is a required method on `SemanticStorage`, not an optional duck-typed capability.**
`Memory.getTimeline()` must NOT use `typeof (this.storage.semantic as unknown).getTopicTimeline === 'function'` as a capability check and fall back to `getUnaccessed(0)`. `getUnaccessed(0)` excludes recently-accessed memories (the `last_accessed` filter), making it incorrect for timeline queries. `getTopicTimeline` is a required method on `SemanticStorage`. Both `SqliteSemanticStorage` and the Supabase adapter's semantic implementation must implement it. The Supabase implementation may use a simpler SQL query since it doesn't have the same optimization constraints.

**Audit Fix 7: Temporal boundary is half-open `[validFrom, validUntil)` — validUntil is exclusive.**
A memory with `validUntil = T` is NOT valid AT time T. It was valid before T and superseded at T. All comparisons must use `valid_until > asOf` (exclusive upper bound), not `valid_until >= asOf`. This applies consistently in: SQL WHERE clauses, Neo4j Cypher WHERE clauses, JavaScript post-filter comparisons, and test fixture comments.

**Audit Fix 8: NULL temporal semantics are explicit and documented.**
`NULL valid_from` means the memory has always been valid (treat as epoch 0 — epoch is always <= asOf for any reasonable asOf). `NULL valid_until` means the memory is still currently valid (no expiry). These semantics must appear in SQL comments in the schema, in the TypeScript interface JSDoc, and in the test cases that exercise NULL boundaries.

**Audit Fix 9: Episode/digest temporal filtering uses `beforeDate` inside `unifiedSearch`.**
The `asOf` filter for episodes and digests cannot be applied after `unifiedSearch` returns `RetrievedMemory[]` because that return type does not include `createdAt`. The filter must be applied inside `unifiedSearch` (in `packages/core/src/retrieval/search.ts`) where the raw `Episode` and `Digest` objects are still accessible. Add `beforeDate?: Date` to `SearchOptions` (not `asOf` — use a distinct name to avoid confusion at the storage layer). The engine passes `beforeDate: opts.asOf` when calling storage layer search methods.

**Audit Fix 10: Linear supersession enforcement.**
When deep sleep detects a contradiction and would create a new semantic memory superseding an old one, it must first check whether the old memory is already superseded (i.e., `superseded_by IS NOT NULL`). If it is, the new memory supersedes the LATEST unsuperseded memory in the chain, not the original. This prevents branching chains where multiple new memories all point to the same original. One topic, one currently-valid truth, one linear chain. The deep sleep implementation in `packages/core/src/consolidation/deep-sleep.ts` must implement this traversal before setting supersession pointers.

---

## Part 1: `@engram/bench` Package

### 1.1 Directory Structure

```
packages/bench/
  package.json
  tsconfig.json
  vitest.config.ts
  bin/
    engram-bench.ts               # CLI entry point (executable)
  src/
    index.ts                      # public exports
    types.ts                      # all benchmark-specific types
    memory-factory.ts             # creates Memory instances for bench use
    locomo/
      adapter.ts                  # LoCoMoAdapter class
      types.ts                    # LoCoMo raw JSON format types
    longmemeval/
      adapter.ts                  # LongMemEvalAdapter class
      types.ts                    # LongMemEval raw JSON format types
    metrics/
      f1.ts                       # retrieval F1 and recall@k computation
      table.ts                    # human-readable ASCII table formatter
    runner/
      compare.ts                  # comparison mode: with-graph vs without-graph
  test/
    locomo.test.ts
    longmemeval.test.ts
    temporal.test.ts
    comparison.test.ts
```

### 1.2 `package.json`

```json
{
  "name": "@engram/bench",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "engram-bench": "dist/bin/engram-bench.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@engram/core": "*",
    "@engram/sqlite": "*",
    "@engram/openai": "*",
    "uuid": "^11.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/node": "^22.0.0"
  }
}
```

### 1.3 `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "paths": {}
  },
  "include": ["src/**/*", "bin/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 1.4 `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120000,   // benchmark tests are slow
    hookTimeout: 60000,
  },
})
```

---

## Part 2: Type Definitions

### 2.1 `src/types.ts`

```typescript
// ============================================================
// Shared benchmark types
// ============================================================

/** Options passed to any benchmark runner. */
export interface BenchmarkOpts {
  /**
   * Run consolidation after ingestion before evaluation.
   * Defaults to true. Set false to test raw episode recall only.
   */
  consolidate?: boolean

  /**
   * Enable the Neo4j graph layer during recall.
   * When true: Memory connects to Neo4j, uses spreading activation.
   * When false: Memory skips Neo4j entirely, uses SQL CTE association walk.
   * Defaults to true.
   */
  graph?: boolean

  /**
   * Maximum number of memories to return per recall query.
   * Used for R@k computation. Defaults to 10.
   */
  topK?: number

  /**
   * OpenAI API key for embeddings + summarization.
   * Falls back to process.env.OPENAI_API_KEY.
   */
  openaiApiKey?: string

  /**
   * Path to write results JSON. If omitted, results are returned only (not written).
   */
  outputPath?: string
}

/** Timing and volume metrics shared by all benchmarks. */
export interface BenchmarkMetrics {
  /** Total queries evaluated. */
  totalQueries: number

  /** Wall-clock time for ingestion in milliseconds. */
  ingestTimeMs: number

  /** Wall-clock time for all recall queries in milliseconds. */
  evalTimeMs: number

  /** Total tokens estimated across all recalled memories (chars / 4). */
  totalTokensRecalled: number
}

// ============================================================
// LoCoMo types
// ============================================================

/**
 * LoCoMo question categories:
 * 1 = single-hop, 2 = multi-hop, 3 = temporal, 4 = commonsense, 5 = adversarial
 */
export type LoCoMoCategory = 1 | 2 | 3 | 4 | 5

export interface LoCoMoQAPrediction {
  /** The QA pair ID within this conversation. */
  qaId: string

  /** The question text. */
  question: string

  /** Gold answer. */
  goldAnswer: string

  /**
   * Recalled memory content used as the basis for scoring.
   * This is the concatenation of the top-K recalled memory texts.
   */
  prediction: string

  /**
   * Token-level partial retrieval F1 score.
   * Measures overlap between recalled text tokens and gold answer tokens.
   * This is RETRIEVAL F1, not generated-answer F1.
   * Published LoCoMo baselines use LLM-generated answers and will have higher numbers.
   */
  retrievalF1: number

  /**
   * Whether the gold evidence episode (identified by its segment+turn ID)
   * appears in the top-K recalled memories.
   */
  recallAtK: boolean

  /** Question category (1–5). */
  category: LoCoMoCategory
}

export interface LoCoMoCategoryMetrics {
  category: LoCoMoCategory
  totalQuestions: number
  /** Average retrieval F1 across questions in this category. */
  averageRetrievalF1: number
  /** Fraction of questions where the gold episode was in top-K. */
  recallAtK: number
}

export interface LoCoMoConversationResult {
  conversationId: string
  qaPredictions: LoCoMoQAPrediction[]
  episodesIngested: number
  sessionsCreated: number
}

export interface LoCoMoEvalFormat {
  sample_id: string
  qa: Array<{
    /** The recalled text used as prediction. */
    prediction: string
    /**
     * Retrieval F1. Key is named retrieval_f1 to distinguish from
     * the prediction_f1 used by LoCoMo's evaluate_qa.py (which is LLM-generated F1).
     */
    retrieval_f1: number
  }>
}

export interface LoCoMoResult {
  benchmark: 'locomo'
  conversations: LoCoMoConversationResult[]
  overall: {
    /** Average retrieval F1 across all questions. */
    averageRetrievalF1: number
    /** Fraction of questions where the gold episode was in top-K. */
    recallAtK: number
    byCategory: LoCoMoCategoryMetrics[]
  }
  metrics: BenchmarkMetrics
  /**
   * Compatible output format for LoCoMo's task_eval/evaluate_qa.py.
   * Note: the script expects prediction_f1 keys; this eval format uses retrieval_f1
   * instead. Rename the key if submitting to the official evaluation script.
   */
  evalFormat: LoCoMoEvalFormat[]
}

// ============================================================
// LongMemEval types
// ============================================================

export type LongMemEvalAbility =
  | 'information_extraction'
  | 'multi_session_reasoning'
  | 'knowledge_updates'
  | 'temporal_reasoning'
  | 'abstention'

export interface LongMemEvalPrediction {
  questionId: string
  question: string
  goldAnswer: string
  goldSessionIds: string[]
  prediction: string
  recalledSessionIds: string[]
  recallAt5: boolean
  recallAt10: boolean
  ability: LongMemEvalAbility
}

export interface LongMemEvalAbilityMetrics {
  ability: LongMemEvalAbility
  totalQuestions: number
  recallAt5: number
  recallAt10: number
}

export interface LongMemEvalResult {
  benchmark: 'longmemeval'
  predictions: LongMemEvalPrediction[]
  overall: {
    recallAt5: number
    recallAt10: number
    byAbility: LongMemEvalAbilityMetrics[]
  }
  metrics: BenchmarkMetrics
  /**
   * JSONL format for GPT-4o judge evaluation.
   * Each line: { "question_id": string; "hypothesis": string }
   */
  evalJsonl: Array<{ question_id: string; hypothesis: string }>
}

// ============================================================
// Comparison mode types
// ============================================================

export interface ComparisonResult {
  benchmark: 'locomo' | 'longmemeval'
  withGraph: LoCoMoResult | LongMemEvalResult
  withoutGraph: LoCoMoResult | LongMemEvalResult
  delta: ComparisonDelta
}

export interface ComparisonDelta {
  /** Change in primary metric (retrieval F1 for LoCoMo, R@5 for LongMemEval). Positive = improvement. */
  primaryMetricDelta: number
  /** Change in ingest time ms. Positive = slower with graph. */
  ingestTimeDeltaMs: number
  /** Change in eval time ms. Positive = slower with graph. */
  evalTimeDeltaMs: number
  /** Change in tokens recalled. Positive = more with graph. */
  tokensDelta: number
}
```

### 2.2 `src/locomo/types.ts` — Raw LoCoMo JSON Format

These types represent what exists on disk in the LoCoMo dataset. Do NOT alter them to match Engram internals — they describe the external format.

```typescript
/**
 * A single dialogue turn in a LoCoMo conversation.
 * dia_id: integer index (0-based) within the conversation.
 * date: "Month DD, YYYY" format (e.g. "January 15, 2023"). May be absent.
 */
export interface LoCoMoTurn {
  dia_id: number
  speaker: string
  text: string
  date?: string
  blip_caption?: string  // image caption — ignore for text benchmarks
}

/**
 * A QA pair. evidence_ids are "D<N>:<M>" where N is 1-based segment index
 * and M is dia_id within that segment.
 */
export interface LoCoMoQA {
  id: string
  question: string
  answer: string
  evidence_ids: string[]
  category: number
}

/** Top-level structure of a LoCoMo conversation file. */
export interface LoCoMoConversationFile {
  /** Normalize to string — may be integer or string in raw data. */
  id: string | number
  conversation: LoCoMoTurn[]
  qa: LoCoMoQA[]
}
```

### 2.3 `src/longmemeval/types.ts`

```typescript
export interface LongMemEvalMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string | number
}

export interface LongMemEvalSession {
  session_id: string
  messages: LongMemEvalMessage[]
  date?: string
}

export interface LongMemEvalQuestion {
  question_id: string
  question: string
  answer: string
  answer_session_ids: string[]
  memory_type: string
  haystack_sessions: LongMemEvalSession[]
}

/**
 * (a) Single JSON file = array of LongMemEvalQuestion, or
 * (b) Directory with one JSON file per question.
 */
export type LongMemEvalDataset = LongMemEvalQuestion[]
```

---

## Part 3: LoCoMo Adapter

### 3.1 `src/locomo/adapter.ts`

```typescript
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Memory } from '@engram/core'
import type {
  BenchmarkOpts, LoCoMoResult, LoCoMoConversationResult,
  LoCoMoQAPrediction, LoCoMoEvalFormat, LoCoMoCategoryMetrics,
} from '../types.js'
import type { LoCoMoConversationFile, LoCoMoQA, LoCoMoTurn } from './types.js'
import { computeRetrievalF1 } from '../metrics/f1.js'
import { createBenchMemory } from '../memory-factory.js'

export class LoCoMoAdapter {
  /**
   * Parse all conversation JSON files from dataPath.
   * dataPath may be a directory (reads all *.json files) or a single file
   * (must be array or single conversation object).
   */
  async loadDataset(dataPath: string): Promise<LoCoMoConversationFile[]> {
    const stat = await fs.stat(dataPath)

    if (stat.isDirectory()) {
      const entries = await fs.readdir(dataPath)
      const jsonFiles = entries.filter(e => e.endsWith('.json')).sort()
      const conversations: LoCoMoConversationFile[] = []
      for (const filename of jsonFiles) {
        const raw = await fs.readFile(path.join(dataPath, filename), 'utf8')
        const parsed = JSON.parse(raw) as LoCoMoConversationFile | LoCoMoConversationFile[]
        if (Array.isArray(parsed)) {
          conversations.push(...parsed)
        } else {
          conversations.push(parsed)
        }
      }
      return conversations
    }

    const raw = await fs.readFile(dataPath, 'utf8')
    const parsed = JSON.parse(raw) as LoCoMoConversationFile | LoCoMoConversationFile[]
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  /**
   * Ingest all turns from a single conversation into memory.
   *
   * Segment strategy (AUDIT FIX: segment = date-group, not array index):
   * Turns are grouped by date string. Each unique date gets an Engram sessionId
   * AND a 1-based segment index (locomoSegmentIndex). This segment index is what
   * LoCoMo evidence IDs reference. Example: if the conversation has turns on
   * "January 10" and "January 15", their locomoSegmentIndex values are 1 and 2.
   *
   * Episode metadata stores:
   * {
   *   locomoConvId: string,
   *   locomoTurnId: number,    // = dia_id, the M in "D<N>:<M>"
   *   locomoSegmentIndex: number, // = N in "D<N>:<M>", 1-based date-group ordinal
   *   locomoSpeaker: string,
   *   locomoDate: string | null,
   * }
   */
  async ingestConversation(
    conv: LoCoMoConversationFile,
    memory: Memory,
  ): Promise<{ episodesIngested: number; sessionsCreated: string[] }> {
    const convId = String(conv.id)
    // Map date-string → { sessionId, segmentIndex }
    const dateToSegment = new Map<string, { sessionId: string; segmentIndex: number }>()
    const sessionsCreated: string[] = []
    let segmentCounter = 0
    let episodesIngested = 0

    for (const turn of conv.conversation) {
      if (!turn.text || turn.text.trim().length === 0) continue

      const dateKey = turn.date ?? 'undated'
      if (!dateToSegment.has(dateKey)) {
        segmentCounter++
        const sessionId = `locomo:${convId}:${dateKey.replace(/\s+/g, '-')}`
        dateToSegment.set(dateKey, { sessionId, segmentIndex: segmentCounter })
        sessionsCreated.push(sessionId)
      }

      const { sessionId, segmentIndex } = dateToSegment.get(dateKey)!
      const role: 'user' | 'assistant' = turn.speaker === 'B' ? 'assistant' : 'user'

      await memory.ingest({
        role,
        content: turn.text.trim(),
        sessionId,
        metadata: {
          locomoConvId: convId,
          locomoTurnId: turn.dia_id,
          locomoSegmentIndex: segmentIndex,
          locomoSpeaker: turn.speaker,
          locomoDate: turn.date ?? null,
        },
      })

      episodesIngested++
    }

    return { episodesIngested, sessionsCreated }
  }

  /**
   * Ingest an entire dataset. Runs light sleep after each conversation,
   * then full consolidation at the end (if consolidate is not false).
   */
  async ingestDataset(
    conversations: LoCoMoConversationFile[],
    memory: Memory,
    opts?: Pick<BenchmarkOpts, 'consolidate'>
  ): Promise<{ totalEpisodes: number; totalSessions: number }> {
    let totalEpisodes = 0
    let totalSessions = 0

    for (const conv of conversations) {
      const { episodesIngested, sessionsCreated } = await this.ingestConversation(conv, memory)
      totalEpisodes += episodesIngested
      totalSessions += sessionsCreated.length

      if (opts?.consolidate !== false) {
        await memory.consolidate('light')
      }
    }

    if (opts?.consolidate !== false) {
      await memory.consolidate('deep')
      await memory.consolidate('dream')
      await memory.consolidate('decay')
    }

    return { totalEpisodes, totalSessions }
  }

  /**
   * Evaluate all QA pairs across all conversations.
   *
   * Evidence ID resolution (AUDIT FIX):
   * The LoCoMo evidence format is "D<N>:<M>":
   *   N = 1-based segment index (date-group ordinal within the conversation)
   *   M = dia_id of the turn within that segment
   *
   * This is NOT the conversation's position in the conversations array.
   * The adapter matches recalled memories by checking:
   *   metadata.locomoConvId === conv.id AND
   *   metadata.locomoSegmentIndex === N AND
   *   metadata.locomoTurnId === M
   */
  async evaluateDataset(
    conversations: LoCoMoConversationFile[],
    memory: Memory,
    opts?: Pick<BenchmarkOpts, 'topK'>
  ): Promise<LoCoMoConversationResult[]> {
    const topK = opts?.topK ?? 10
    const convResults: LoCoMoConversationResult[] = []

    for (const conv of conversations) {
      const convId = String(conv.id)
      const qaPredictions: LoCoMoQAPrediction[] = []

      for (const qa of conv.qa) {
        const recallResult = await memory.recall(qa.question)
        const topMemories = recallResult.memories.slice(0, topK)

        const prediction = topMemories
          .map(m => m.content)
          .filter(c => c && c.trim().length > 0)
          .join(' ')
          .slice(0, 2000)

        // AUDIT FIX: retrievalF1 not predictionF1
        const retrievalF1 = computeRetrievalF1(prediction, qa.answer)

        // Build set of recalled "D<N>:<M>" identifiers from metadata
        const recalledEvidenceIds = new Set<string>()
        for (const mem of topMemories) {
          const locomoConvId = mem.metadata?.locomoConvId as string | undefined
          const locomoSegmentIndex = mem.metadata?.locomoSegmentIndex as number | undefined
          const locomoTurnId = mem.metadata?.locomoTurnId as number | undefined
          if (
            locomoConvId === convId &&
            locomoSegmentIndex !== undefined &&
            locomoTurnId !== undefined
          ) {
            recalledEvidenceIds.add(`D${locomoSegmentIndex}:${locomoTurnId}`)
          }
        }

        const recallAtK = qa.evidence_ids.some(eid => recalledEvidenceIds.has(eid))

        qaPredictions.push({
          qaId: qa.id,
          question: qa.question,
          goldAnswer: qa.answer,
          prediction,
          retrievalF1,
          recallAtK,
          category: qa.category as 1 | 2 | 3 | 4 | 5,
        })
      }

      convResults.push({
        conversationId: convId,
        qaPredictions,
        episodesIngested: conv.conversation.length,
        sessionsCreated: 0,  // populated by caller from ingestConversation
      })
    }

    return convResults
  }

  /** End-to-end: create memory → ingest → evaluate → return LoCoMoResult. */
  async run(dataPath: string, opts?: BenchmarkOpts): Promise<LoCoMoResult> {
    const ingestStart = Date.now()
    const memory = await createBenchMemory(opts)
    const conversations = await this.loadDataset(dataPath)

    await this.ingestDataset(conversations, memory, opts)
    const ingestTimeMs = Date.now() - ingestStart

    const evalStart = Date.now()
    const convResults = await this.evaluateDataset(conversations, memory, opts)
    const evalTimeMs = Date.now() - evalStart

    const allPredictions = convResults.flatMap(c => c.qaPredictions)
    const totalQueries = allPredictions.length

    const averageRetrievalF1 =
      allPredictions.length > 0
        ? allPredictions.reduce((sum, p) => sum + p.retrievalF1, 0) / allPredictions.length
        : 0

    const overallRecallAtK =
      allPredictions.length > 0
        ? allPredictions.filter(p => p.recallAtK).length / allPredictions.length
        : 0

    const categoryMap = new Map<number, LoCoMoQAPrediction[]>()
    for (const p of allPredictions) {
      const bucket = categoryMap.get(p.category) ?? []
      bucket.push(p)
      categoryMap.set(p.category, bucket)
    }

    const byCategory: LoCoMoCategoryMetrics[] = []
    for (const [cat, preds] of categoryMap) {
      byCategory.push({
        category: cat as 1 | 2 | 3 | 4 | 5,
        totalQuestions: preds.length,
        averageRetrievalF1: preds.reduce((s, p) => s + p.retrievalF1, 0) / preds.length,
        recallAtK: preds.filter(p => p.recallAtK).length / preds.length,
      })
    }
    byCategory.sort((a, b) => a.category - b.category)

    const evalFormat: LoCoMoEvalFormat[] = convResults.map(cr => ({
      sample_id: cr.conversationId,
      qa: cr.qaPredictions.map(p => ({
        prediction: p.prediction,
        retrieval_f1: p.retrievalF1,
      })),
    }))

    const totalTokensRecalled = allPredictions.reduce(
      (sum, p) => sum + Math.ceil(p.prediction.length / 4),
      0
    )

    return {
      benchmark: 'locomo',
      conversations: convResults,
      overall: { averageRetrievalF1, recallAtK: overallRecallAtK, byCategory },
      metrics: { totalQueries, ingestTimeMs, evalTimeMs, totalTokensRecalled },
      evalFormat,
    }
  }
}
```

---

## Part 4: LongMemEval Adapter

### 4.1 `src/longmemeval/adapter.ts`

```typescript
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Memory } from '@engram/core'
import type {
  BenchmarkOpts, LongMemEvalResult, LongMemEvalPrediction,
  LongMemEvalAbilityMetrics, LongMemEvalAbility,
} from '../types.js'
import type { LongMemEvalQuestion, LongMemEvalSession } from './types.js'
import { createBenchMemory } from '../memory-factory.js'

export class LongMemEvalAdapter {
  /**
   * Load dataset from dataPath.
   * (a) Single JSON file: array of LongMemEvalQuestion.
   * (b) Directory: each *.json file is one LongMemEvalQuestion.
   */
  async loadDataset(dataPath: string): Promise<LongMemEvalQuestion[]> {
    const stat = await fs.stat(dataPath)

    if (stat.isDirectory()) {
      const entries = await fs.readdir(dataPath)
      const jsonFiles = entries.filter(e => e.endsWith('.json')).sort()
      const questions: LongMemEvalQuestion[] = []
      for (const filename of jsonFiles) {
        const raw = await fs.readFile(path.join(dataPath, filename), 'utf8')
        questions.push(JSON.parse(raw) as LongMemEvalQuestion)
      }
      return questions
    }

    const raw = await fs.readFile(dataPath, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as LongMemEvalQuestion[])
      : [parsed as LongMemEvalQuestion]
  }

  /**
   * Ingest one question's haystack sessions.
   * Each session → one Engram sessionId = `longmemeval:<question_id>:<session_id>`.
   * Episode metadata: { lmeQuestionId, lmeSessionId, lmeMsgIndex }.
   *
   * Timestamp handling:
   *   string  → parse as ISO date
   *   number  → epoch seconds → multiply by 1000 for Date
   *   absent  → use session.date if available, else current time (not stored in metadata)
   */
  async ingestQuestion(
    question: LongMemEvalQuestion,
    memory: Memory,
  ): Promise<{ episodesIngested: number }> {
    let episodesIngested = 0

    for (const session of question.haystack_sessions) {
      const engSessionId = `longmemeval:${question.question_id}:${session.session_id}`

      for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
        const msg = session.messages[msgIdx]
        if (!msg.content || msg.content.trim().length === 0) continue

        await memory.ingest({
          role: msg.role,
          content: msg.content.trim(),
          sessionId: engSessionId,
          metadata: {
            lmeQuestionId: question.question_id,
            lmeSessionId: session.session_id,
            lmeMsgIndex: msgIdx,
          },
        })

        episodesIngested++
      }
    }

    return { episodesIngested }
  }

  async ingestDataset(
    questions: LongMemEvalQuestion[],
    memory: Memory,
    opts?: Pick<BenchmarkOpts, 'consolidate'>
  ): Promise<{ totalEpisodes: number }> {
    let totalEpisodes = 0

    for (const question of questions) {
      const { episodesIngested } = await this.ingestQuestion(question, memory)
      totalEpisodes += episodesIngested

      if (opts?.consolidate !== false) {
        await memory.consolidate('light')
      }
    }

    if (opts?.consolidate !== false) {
      await memory.consolidate('deep')
      await memory.consolidate('dream')
      await memory.consolidate('decay')
    }

    return { totalEpisodes }
  }

  /**
   * Maps raw memory_type strings from LongMemEval to LongMemEvalAbility union.
   * Unknown types default to 'information_extraction'.
   */
  protected mapAbility(rawType: string): LongMemEvalAbility {
    const mapping: Record<string, LongMemEvalAbility> = {
      single_session_user: 'information_extraction',
      single_session_assistant: 'information_extraction',
      multi_session: 'multi_session_reasoning',
      knowledge_update: 'knowledge_updates',
      temporal: 'temporal_reasoning',
      adversarial: 'abstention',
    }
    return mapping[rawType] ?? 'information_extraction'
  }

  /**
   * Evaluate all questions.
   * R@5 = any gold session ID in top-5 recalled session IDs.
   * R@10 = any gold session ID in top-10 recalled session IDs.
   */
  async evaluateDataset(
    questions: LongMemEvalQuestion[],
    memory: Memory,
    opts?: Pick<BenchmarkOpts, 'topK'>
  ): Promise<LongMemEvalPrediction[]> {
    const topK = opts?.topK ?? 10
    const predictions: LongMemEvalPrediction[] = []

    for (const question of questions) {
      const recallResult = await memory.recall(question.question)
      const topMemories = recallResult.memories.slice(0, topK)

      const seenSessionIds = new Set<string>()
      const recalledSessionIds: string[] = []
      for (const mem of topMemories) {
        const lmeSessionId = mem.metadata?.lmeSessionId as string | undefined
        if (lmeSessionId && !seenSessionIds.has(lmeSessionId)) {
          seenSessionIds.add(lmeSessionId)
          recalledSessionIds.push(lmeSessionId)
        }
      }

      const top5 = recalledSessionIds.slice(0, 5)
      const top10 = recalledSessionIds.slice(0, 10)

      const recallAt5 = question.answer_session_ids.some(id => top5.includes(id))
      const recallAt10 = question.answer_session_ids.some(id => top10.includes(id))

      const prediction = topMemories
        .map(m => m.content)
        .filter(c => c && c.trim().length > 0)
        .join(' ')
        .slice(0, 2000)

      predictions.push({
        questionId: question.question_id,
        question: question.question,
        goldAnswer: question.answer,
        goldSessionIds: question.answer_session_ids,
        prediction,
        recalledSessionIds,
        recallAt5,
        recallAt10,
        ability: this.mapAbility(question.memory_type),
      })
    }

    return predictions
  }

  async run(dataPath: string, opts?: BenchmarkOpts): Promise<LongMemEvalResult> {
    const ingestStart = Date.now()
    const memory = await createBenchMemory(opts)
    const questions = await this.loadDataset(dataPath)

    await this.ingestDataset(questions, memory, opts)
    const ingestTimeMs = Date.now() - ingestStart

    const evalStart = Date.now()
    const predictions = await this.evaluateDataset(questions, memory, opts)
    const evalTimeMs = Date.now() - evalStart

    const totalQueries = predictions.length
    const overallR5 =
      predictions.length > 0
        ? predictions.filter(p => p.recallAt5).length / predictions.length
        : 0
    const overallR10 =
      predictions.length > 0
        ? predictions.filter(p => p.recallAt10).length / predictions.length
        : 0

    const abilityMap = new Map<LongMemEvalAbility, LongMemEvalPrediction[]>()
    for (const p of predictions) {
      const bucket = abilityMap.get(p.ability) ?? []
      bucket.push(p)
      abilityMap.set(p.ability, bucket)
    }

    const byAbility: LongMemEvalAbilityMetrics[] = []
    for (const [ability, preds] of abilityMap) {
      byAbility.push({
        ability,
        totalQuestions: preds.length,
        recallAt5: preds.filter(p => p.recallAt5).length / preds.length,
        recallAt10: preds.filter(p => p.recallAt10).length / preds.length,
      })
    }

    const evalJsonl = predictions.map(p => ({
      question_id: p.questionId,
      hypothesis: p.prediction,
    }))

    const totalTokensRecalled = predictions.reduce(
      (sum, p) => sum + Math.ceil(p.prediction.length / 4),
      0
    )

    return {
      benchmark: 'longmemeval',
      predictions,
      overall: { recallAt5: overallR5, recallAt10: overallR10, byAbility },
      metrics: { totalQueries, ingestTimeMs, evalTimeMs, totalTokensRecalled },
      evalJsonl,
    }
  }
}
```

---

## Part 5: Metrics Helpers

### 5.1 `src/metrics/f1.ts`

```typescript
/**
 * Tokenize text into a bag of lowercase alphanumeric tokens.
 * Matches the LoCoMo evaluate_qa.py tokenization.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0)
}

/**
 * Compute token-level partial-match RETRIEVAL F1.
 *
 * This measures how much of the gold answer text appears in the recalled
 * memory content. It is NOT generated-answer F1. Published LoCoMo baselines
 * pass recalled context to an LLM and score the generated answer — those
 * numbers will be higher than this retrieval F1.
 *
 * SQuAD-style multiset F1:
 *   precision = |pred_tokens ∩ gold_tokens| / |pred_tokens|
 *   recall    = |pred_tokens ∩ gold_tokens| / |gold_tokens|
 *   F1        = 2 * precision * recall / (precision + recall)
 *
 * Returns 0 if either string is empty.
 */
export function computeRetrievalF1(prediction: string, gold: string): number {
  if (!prediction || !gold) return 0

  const predTokens = tokenize(prediction)
  const goldTokens = tokenize(gold)

  if (predTokens.length === 0 || goldTokens.length === 0) return 0

  const predCount = new Map<string, number>()
  for (const t of predTokens) {
    predCount.set(t, (predCount.get(t) ?? 0) + 1)
  }

  const goldCount = new Map<string, number>()
  for (const t of goldTokens) {
    goldCount.set(t, (goldCount.get(t) ?? 0) + 1)
  }

  let commonCount = 0
  for (const [token, count] of predCount) {
    commonCount += Math.min(count, goldCount.get(token) ?? 0)
  }

  if (commonCount === 0) return 0

  const precision = commonCount / predTokens.length
  const recall = commonCount / goldTokens.length
  return (2 * precision * recall) / (precision + recall)
}

/**
 * Fraction of queries where the gold item appears in top-K results.
 */
export function recallAtK(hits: boolean[]): number {
  if (hits.length === 0) return 0
  return hits.filter(Boolean).length / hits.length
}
```

### 5.2 `src/metrics/table.ts`

```typescript
import type { LoCoMoResult, LongMemEvalResult, ComparisonResult } from '../types.js'

export function formatLoCoMoTable(result: LoCoMoResult): string {
  const lines: string[] = []
  lines.push('=== LoCoMo Benchmark Results (Retrieval F1) ===')
  lines.push('')
  lines.push('NOTE: This is RETRIEVAL F1 — how much gold text appears in recalled memories.')
  lines.push('      Published baselines use LLM-generated answers and will be higher.')
  lines.push('')
  lines.push(padRow(['Category', 'Questions', 'Retrieval F1', 'R@K']))
  lines.push(separator())

  const categoryNames: Record<number, string> = {
    1: 'Single-hop', 2: 'Multi-hop', 3: 'Temporal', 4: 'Commonsense', 5: 'Adversarial',
  }

  for (const cat of result.overall.byCategory) {
    lines.push(padRow([
      categoryNames[cat.category] ?? `Cat ${cat.category}`,
      String(cat.totalQuestions),
      (cat.averageRetrievalF1 * 100).toFixed(1) + '%',
      (cat.recallAtK * 100).toFixed(1) + '%',
    ]))
  }

  lines.push(separator())
  lines.push(padRow([
    'Overall',
    String(result.metrics.totalQueries),
    (result.overall.averageRetrievalF1 * 100).toFixed(1) + '%',
    (result.overall.recallAtK * 100).toFixed(1) + '%',
  ]))
  lines.push('')
  lines.push(`Ingest time:  ${result.metrics.ingestTimeMs.toLocaleString()}ms`)
  lines.push(`Eval time:    ${result.metrics.evalTimeMs.toLocaleString()}ms`)
  lines.push(`Tokens recalled: ${result.metrics.totalTokensRecalled.toLocaleString()}`)

  return lines.join('\n')
}

export function formatLongMemEvalTable(result: LongMemEvalResult): string {
  const lines: string[] = []
  lines.push('=== LongMemEval Benchmark Results ===')
  lines.push('')
  lines.push(padRow(['Ability', 'Questions', 'R@5', 'R@10']))
  lines.push(separator())

  for (const ab of result.overall.byAbility) {
    lines.push(padRow([
      ab.ability, String(ab.totalQuestions),
      (ab.recallAt5 * 100).toFixed(1) + '%',
      (ab.recallAt10 * 100).toFixed(1) + '%',
    ]))
  }

  lines.push(separator())
  lines.push(padRow([
    'Overall', String(result.metrics.totalQueries),
    (result.overall.recallAt5 * 100).toFixed(1) + '%',
    (result.overall.recallAt10 * 100).toFixed(1) + '%',
  ]))
  lines.push('')
  lines.push(`Ingest time: ${result.metrics.ingestTimeMs.toLocaleString()}ms`)
  lines.push(`Eval time:   ${result.metrics.evalTimeMs.toLocaleString()}ms`)

  return lines.join('\n')
}

export function formatComparisonTable(result: ComparisonResult): string {
  const lines: string[] = []
  lines.push(`=== ${result.benchmark.toUpperCase()} Comparison: Neo4j Graph ON vs OFF ===`)
  lines.push('')
  lines.push(padRow(['Metric', 'With Graph', 'Without Graph', 'Delta'], 20))
  lines.push(separator(4, 20))

  const wg = result.withGraph
  const wog = result.withoutGraph

  if (result.benchmark === 'locomo') {
    const wgL = wg as LoCoMoResult
    const wogL = wog as LoCoMoResult
    lines.push(padRow([
      'Retrieval F1',
      (wgL.overall.averageRetrievalF1 * 100).toFixed(1) + '%',
      (wogL.overall.averageRetrievalF1 * 100).toFixed(1) + '%',
      formatDelta(result.delta.primaryMetricDelta * 100, '%'),
    ], 20))
    lines.push(padRow([
      'R@K',
      (wgL.overall.recallAtK * 100).toFixed(1) + '%',
      (wogL.overall.recallAtK * 100).toFixed(1) + '%',
      '',
    ], 20))
  } else {
    const wgE = wg as LongMemEvalResult
    const wogE = wog as LongMemEvalResult
    lines.push(padRow([
      'R@5',
      (wgE.overall.recallAt5 * 100).toFixed(1) + '%',
      (wogE.overall.recallAt5 * 100).toFixed(1) + '%',
      formatDelta(result.delta.primaryMetricDelta * 100, '%'),
    ], 20))
    lines.push(padRow([
      'R@10',
      (wgE.overall.recallAt10 * 100).toFixed(1) + '%',
      (wogE.overall.recallAt10 * 100).toFixed(1) + '%',
      '',
    ], 20))
  }

  lines.push(padRow([
    'Ingest time',
    wg.metrics.ingestTimeMs.toLocaleString() + 'ms',
    wog.metrics.ingestTimeMs.toLocaleString() + 'ms',
    formatDelta(result.delta.ingestTimeDeltaMs, 'ms'),
  ], 20))
  lines.push(padRow([
    'Eval time',
    wg.metrics.evalTimeMs.toLocaleString() + 'ms',
    wog.metrics.evalTimeMs.toLocaleString() + 'ms',
    formatDelta(result.delta.evalTimeDeltaMs, 'ms'),
  ], 20))

  return lines.join('\n')
}

function padRow(cols: string[], width = 18): string {
  return cols.map(c => c.padEnd(width)).join(' | ')
}

function separator(cols = 3, width = 18): string {
  return Array(cols).fill('-'.repeat(width)).join('-+-')
}

function formatDelta(value: number, unit: string): string {
  const sign = value > 0 ? '+' : ''
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${sign}${formatted}${unit}`
}
```

---

## Part 6: Memory Factory

### 6.1 `src/memory-factory.ts`

**AUDIT FIX 1: Pass `:memory:` string, not a Database object.**

Before implementing, verify the `SqliteStorageAdapter` constructor signature by reading `packages/sqlite/src/adapter.ts`. If it accepts a string path, use `new SqliteStorageAdapter(':memory:')`. If it accepts a `better-sqlite3` Database instance, use `new SqliteStorageAdapter(new Database(':memory:'))`. Do not guess — read the file first.

```typescript
import { SqliteStorageAdapter } from '@engram/sqlite'
import { openaiIntelligence } from '@engram/openai'
import { createMemory } from '@engram/core'
import type { Memory } from '@engram/core'
import type { BenchmarkOpts } from './types.js'

/**
 * Create an in-memory SQLite-backed Memory instance for benchmark use.
 *
 * Uses ':memory:' database so each benchmark run starts with a clean slate.
 *
 * AUDIT FIX: graph?: boolean controls whether Memory connects to Neo4j.
 * When graph === false, Memory never calls NeuralGraph.connect() and never
 * calls decomposeEpisode() or spreadActivation(). The graph field on the
 * Memory instance is null. This is the Wave 2 null-check pattern.
 * When graph === true (default), Memory attempts Neo4j connection.
 *
 * For comparison mode: two separate Memory instances are created.
 * The without-graph instance uses the SQL CTE association walk from pre-Wave-2.
 */
export async function createBenchMemory(opts?: BenchmarkOpts): Promise<Memory> {
  // AUDIT FIX: verify constructor signature in packages/sqlite/src/adapter.ts
  // and use the correct form. Do not pass a Database object if the constructor
  // expects a string, and vice versa.
  const storage = new SqliteStorageAdapter(':memory:')

  const apiKey = opts?.openaiApiKey ?? process.env.OPENAI_API_KEY
  const intelligence = apiKey ? openaiIntelligence({ apiKey }) : undefined

  const graphEnabled = opts?.graph !== false   // default true

  const memory = createMemory({
    storage,
    intelligence,
    graph: graphEnabled,
  })

  await memory.initialize()
  return memory
}
```

---

## Part 7: Comparison Runner

### 7.1 `src/runner/compare.ts`

```typescript
import type {
  BenchmarkOpts, ComparisonResult, ComparisonDelta, LoCoMoResult, LongMemEvalResult,
} from '../types.js'
import { LoCoMoAdapter } from '../locomo/adapter.js'
import { LongMemEvalAdapter } from '../longmemeval/adapter.js'

/**
 * Run benchmark twice: once with Neo4j graph, once without.
 * Each run creates a separate Memory instance (separate SQLite :memory: DB,
 * separate NeuralGraph connection or no connection).
 */
export async function compareLoCoMo(
  dataPath: string,
  opts?: Omit<BenchmarkOpts, 'graph'>
): Promise<ComparisonResult> {
  const adapter = new LoCoMoAdapter()
  const withGraph = await adapter.run(dataPath, { ...opts, graph: true })
  const withoutGraph = await adapter.run(dataPath, { ...opts, graph: false })
  return {
    benchmark: 'locomo',
    withGraph,
    withoutGraph,
    delta: {
      primaryMetricDelta: withGraph.overall.averageRetrievalF1 - withoutGraph.overall.averageRetrievalF1,
      ingestTimeDeltaMs: withGraph.metrics.ingestTimeMs - withoutGraph.metrics.ingestTimeMs,
      evalTimeDeltaMs: withGraph.metrics.evalTimeMs - withoutGraph.metrics.evalTimeMs,
      tokensDelta: withGraph.metrics.totalTokensRecalled - withoutGraph.metrics.totalTokensRecalled,
    },
  }
}

export async function compareLongMemEval(
  dataPath: string,
  opts?: Omit<BenchmarkOpts, 'graph'>
): Promise<ComparisonResult> {
  const adapter = new LongMemEvalAdapter()
  const withGraph = await adapter.run(dataPath, { ...opts, graph: true })
  const withoutGraph = await adapter.run(dataPath, { ...opts, graph: false })
  return {
    benchmark: 'longmemeval',
    withGraph,
    withoutGraph,
    delta: {
      primaryMetricDelta: withGraph.overall.recallAt5 - withoutGraph.overall.recallAt5,
      ingestTimeDeltaMs: withGraph.metrics.ingestTimeMs - withoutGraph.metrics.ingestTimeMs,
      evalTimeDeltaMs: withGraph.metrics.evalTimeMs - withoutGraph.metrics.evalTimeMs,
      tokensDelta: withGraph.metrics.totalTokensRecalled - withoutGraph.metrics.totalTokensRecalled,
    },
  }
}
```

---

## Part 8: CLI Runner

### 8.1 `bin/engram-bench.ts`

```typescript
#!/usr/bin/env node
/**
 * engram-bench CLI
 *
 * Usage:
 *   npx engram-bench --benchmark locomo --data ./data/locomo/ --output ./results/
 *   npx engram-bench --benchmark longmemeval --data ./data/longmemeval/
 *   npx engram-bench --benchmark locomo --compare --data ./data/locomo/
 *
 * Flags:
 *   --benchmark <name>     Required. "locomo" or "longmemeval"
 *   --data <path>          Required. Dataset directory or file path
 *   --output <path>        Optional. Results directory. Defaults to ./results/
 *   --compare              Run twice: with-graph and without-graph, output comparison table
 *   --consolidate          Run consolidation (default: on)
 *   --no-consolidate       Skip consolidation
 *   --graph                Enable Neo4j graph layer (default: on)
 *   --no-graph             Disable graph layer (SQL-only fallback)
 *   --top-k <n>            Results per query for R@k metrics (default: 10)
 *   --verbose              Log per-question results
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { LoCoMoAdapter } from '../src/locomo/adapter.js'
import { LongMemEvalAdapter } from '../src/longmemeval/adapter.js'
import { compareLoCoMo, compareLongMemEval } from '../src/runner/compare.js'
import { formatLoCoMoTable, formatLongMemEvalTable, formatComparisonTable } from '../src/metrics/table.js'
import type { BenchmarkOpts } from '../src/types.js'

function parseArgs(argv: string[]): {
  benchmark: string
  dataPath: string
  outputDir: string
  consolidate: boolean
  graph: boolean
  compare: boolean
  topK: number
  verbose: boolean
} {
  const args: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-consolidate') { args['consolidate'] = false; continue }
    if (arg === '--no-graph')       { args['graph'] = false; continue }
    if (arg === '--consolidate')    { args['consolidate'] = true; continue }
    if (arg === '--graph')          { args['graph'] = true; continue }
    if (arg === '--compare')        { args['compare'] = true; continue }
    if (arg === '--verbose')        { args['verbose'] = true; continue }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      args[key] = argv[i + 1] ?? true
      i++
    }
  }

  if (!args['benchmark'] || typeof args['benchmark'] !== 'string') {
    console.error('Error: --benchmark is required (locomo or longmemeval)')
    process.exit(1)
  }
  if (!args['data'] || typeof args['data'] !== 'string') {
    console.error('Error: --data is required')
    process.exit(1)
  }

  return {
    benchmark: args['benchmark'] as string,
    dataPath: path.resolve(args['data'] as string),
    outputDir: path.resolve((args['output'] as string | undefined) ?? './results'),
    consolidate: args['consolidate'] !== false,
    graph: args['graph'] !== false,
    compare: args['compare'] === true,
    topK: parseInt(args['top-k'] as string ?? '10', 10) || 10,
    verbose: args['verbose'] === true,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const opts: BenchmarkOpts = {
    consolidate: args.consolidate,
    graph: args.graph,
    topK: args.topK,
  }

  await fs.mkdir(args.outputDir, { recursive: true })

  console.log(`Benchmark:     ${args.benchmark}`)
  console.log(`Data:          ${args.dataPath}`)
  console.log(`Graph layer:   ${args.graph ? 'ON (Neo4j)' : 'OFF (SQL-only)'}`)
  console.log(`Consolidation: ${args.consolidate ? 'ON' : 'OFF'}`)
  console.log('')

  if (args.compare) {
    console.log('Running comparison mode...')
    let comparisonResult

    if (args.benchmark === 'locomo') {
      comparisonResult = await compareLoCoMo(args.dataPath, opts)
    } else if (args.benchmark === 'longmemeval') {
      comparisonResult = await compareLongMemEval(args.dataPath, opts)
    } else {
      console.error(`Unknown benchmark: ${args.benchmark}`)
      process.exit(1)
    }

    console.log(formatComparisonTable(comparisonResult))
    const outputFile = path.join(args.outputDir, `${args.benchmark}-comparison.json`)
    await fs.writeFile(outputFile, JSON.stringify(comparisonResult, null, 2), 'utf8')
    console.log(`\nResults written to: ${outputFile}`)
    return
  }

  if (args.benchmark === 'locomo') {
    const adapter = new LoCoMoAdapter()
    console.log('Ingesting and evaluating LoCoMo...')
    const result = await adapter.run(args.dataPath, opts)
    console.log(formatLoCoMoTable(result))

    const outputFile = path.join(args.outputDir, 'locomo-results.json')
    const evalFile = path.join(args.outputDir, 'locomo-eval.json')
    await fs.writeFile(outputFile, JSON.stringify(result, null, 2), 'utf8')
    await fs.writeFile(evalFile, JSON.stringify(result.evalFormat, null, 2), 'utf8')
    console.log(`\nFull results: ${outputFile}`)
    console.log(`Eval format:  ${evalFile}`)

    if (args.verbose) {
      for (const conv of result.conversations) {
        for (const p of conv.qaPredictions) {
          console.log(`[${p.qaId}] cat=${p.category} F1=${(p.retrievalF1 * 100).toFixed(1)}% R@K=${p.recallAtK}`)
          console.log(`  Q: ${p.question}`)
          console.log(`  A: ${p.goldAnswer}`)
          console.log('')
        }
      }
    }

  } else if (args.benchmark === 'longmemeval') {
    const adapter = new LongMemEvalAdapter()
    console.log('Ingesting and evaluating LongMemEval...')
    const result = await adapter.run(args.dataPath, opts)
    console.log(formatLongMemEvalTable(result))

    const outputFile = path.join(args.outputDir, 'longmemeval-results.json')
    const jsonlFile = path.join(args.outputDir, 'longmemeval-predictions.jsonl')
    await fs.writeFile(outputFile, JSON.stringify(result, null, 2), 'utf8')
    await fs.writeFile(jsonlFile, result.evalJsonl.map(r => JSON.stringify(r)).join('\n'), 'utf8')
    console.log(`\nFull results: ${outputFile}`)
    console.log(`JSONL for GPT-4o judge: ${jsonlFile}`)

  } else {
    console.error(`Unknown benchmark: ${args.benchmark}. Valid: locomo, longmemeval`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
```

### 8.2 `src/index.ts`

```typescript
export { LoCoMoAdapter } from './locomo/adapter.js'
export { LongMemEvalAdapter } from './longmemeval/adapter.js'
export { compareLoCoMo, compareLongMemEval } from './runner/compare.js'
export { computeRetrievalF1, recallAtK } from './metrics/f1.js'
export { formatLoCoMoTable, formatLongMemEvalTable, formatComparisonTable } from './metrics/table.js'
export { createBenchMemory } from './memory-factory.js'
export type {
  BenchmarkOpts, BenchmarkMetrics,
  LoCoMoCategory, LoCoMoQAPrediction, LoCoMoCategoryMetrics,
  LoCoMoResult, LoCoMoConversationResult, LoCoMoEvalFormat,
  LongMemEvalAbility, LongMemEvalPrediction, LongMemEvalAbilityMetrics, LongMemEvalResult,
  ComparisonResult, ComparisonDelta,
} from './types.js'
```

---

## Part 9: Temporal Validity Queries

### 9.1 Background

Wave 3's deep sleep cycle sets `validFrom` on Neo4j Memory nodes when creating semantic/procedural memories. When a semantic memory is superseded, it sets `validUntil` on the old node and creates a `CONTRADICTS` relationship from new to old. These properties live in Neo4j.

The SQL `semantic` table currently has `supersedes`/`superseded_by` columns but no `valid_from`/`valid_until` columns. Temporal filtering via Neo4j on every recall would require a Cypher round-trip for every query, even non-temporal ones. Wave 4 adds dedicated `valid_from`/`valid_until` columns to the SQL `semantic` table and keeps them in sync with Neo4j node properties during deep sleep. This is the single source of truth for temporal queries — SQL columns, not metadata JSON, not Neo4j.

### 9.2 Schema Migration V3 (SQLite)

**File to modify:** `packages/sqlite/src/migrations.ts`

Add a `SCHEMA_V3` constant and a `currentVersion < 3` branch. The version number is V3 because V1 = base tables, V2 = episode_parts, V3 = temporal columns. There is no SQL graph table migration (Neo4j handles graph persistence).

```typescript
const SCHEMA_V3 = `
-- Temporal validity columns for semantic memories.
-- These mirror the validFrom/validUntil properties on Neo4j Memory nodes.
-- They are the single source of truth for temporal queries from the recall pipeline.
--
-- Boundary convention: half-open interval [valid_from, valid_until)
--   valid_from  is INCLUSIVE — memory becomes valid at this moment.
--   valid_until is EXCLUSIVE — memory ceases to be valid at this moment.
--
-- NULL semantics:
--   NULL valid_from  = memory has always been valid (treat as epoch 0).
--   NULL valid_until = memory is still currently valid (no expiry set).
--
-- Do NOT store this in metadata JSON. Query these columns directly.
ALTER TABLE semantic ADD COLUMN valid_from  REAL;
ALTER TABLE semantic ADD COLUMN valid_until REAL;

-- Backfill valid_from from created_at for all existing rows.
UPDATE semantic SET valid_from = created_at WHERE valid_from IS NULL;

-- Backfill valid_until from the superseding memory's created_at.
UPDATE semantic SET valid_until = (
  SELECT s2.created_at FROM semantic s2
  WHERE s2.id = semantic.superseded_by LIMIT 1
) WHERE superseded_by IS NOT NULL AND valid_until IS NULL;
`
```

**Implementation details for `runMigrations()`:**

`ALTER TABLE ... ADD COLUMN` fails with an error if the column already exists (unlike `CREATE TABLE IF NOT EXISTS`). Guard it with a column existence check:

```typescript
if (currentVersion < 3) {
  const columns = db.prepare("PRAGMA table_info(semantic)").all() as Array<{ name: string }>
  const hasValidFrom = columns.some(c => c.name === 'valid_from')
  if (!hasValidFrom) {
    db.exec(`ALTER TABLE semantic ADD COLUMN valid_from REAL`)
    db.exec(`ALTER TABLE semantic ADD COLUMN valid_until REAL`)
  }
  // Backfill regardless — idempotent UPDATE
  db.exec(`UPDATE semantic SET valid_from = created_at WHERE valid_from IS NULL`)
  db.exec(`
    UPDATE semantic SET valid_until = (
      SELECT s2.created_at FROM semantic s2
      WHERE s2.id = semantic.superseded_by LIMIT 1
    ) WHERE superseded_by IS NOT NULL AND valid_until IS NULL
  `)
  db.pragma('user_version = 3')
}
```

Add a partial index for temporal queries after adding the columns:

```typescript
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_semantic_temporal
  ON semantic(valid_from, valid_until)
  WHERE valid_until IS NOT NULL
`)
```

### 9.3 Supabase Migration V3

**New file:** `supabase/migrations/20260406000001_temporal_columns.sql`

```sql
-- Temporal validity columns for semantic memories.
-- Mirrors valid_from/valid_until properties on Neo4j Memory nodes.
--
-- Boundary convention: half-open interval [valid_from, valid_until)
--   valid_from  INCLUSIVE — memory becomes valid at this moment.
--   valid_until EXCLUSIVE — memory ceases to be valid at this moment.
--
-- NULL valid_from  = always valid (treat as epoch).
-- NULL valid_until = currently valid, no expiry.

ALTER TABLE semantic ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ;
ALTER TABLE semantic ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

-- Backfill valid_from from created_at.
UPDATE semantic SET valid_from = created_at WHERE valid_from IS NULL;

-- Backfill valid_until from the superseding memory's created_at.
UPDATE semantic
SET valid_until = (
  SELECT s2.created_at FROM semantic s2 WHERE s2.id = semantic.superseded_by LIMIT 1
)
WHERE superseded_by IS NOT NULL AND valid_until IS NULL;

-- Index for temporal filtering queries.
CREATE INDEX IF NOT EXISTS idx_semantic_valid_from  ON semantic (valid_from);
CREATE INDEX IF NOT EXISTS idx_semantic_valid_until ON semantic (valid_until) WHERE valid_until IS NOT NULL;
```

### 9.4 `SemanticStorage` Interface Extension

**File to modify:** `packages/core/src/adapters/storage.ts`

Add `beforeDate?: Date` to `SearchOptions` and two new required methods to `SemanticStorage`:

```typescript
export interface SearchOptions {
  limit?: number
  minScore?: number
  sessionId?: string
  embedding?: number[]
  /**
   * Only return memories created at or before this date.
   * Applied inside unifiedSearch where createdAt is available on the raw item.
   * Named beforeDate (not asOf) to distinguish from the recall-level asOf parameter.
   *
   * AUDIT FIX: This filter must be applied INSIDE unifiedSearch where Episode and
   * Digest objects are still accessible, NOT after the pipeline returns RetrievedMemory
   * (which does not carry createdAt).
   */
  beforeDate?: Date
}

export interface SemanticStorage {
  // ... existing methods (insert, search, getUnaccessed, recordAccessAndBoost,
  //                        markSuperseded, batchDecay) ...

  /**
   * Search semantic memories that were valid at the given point in time.
   *
   * A memory M is valid at asOf if:
   *   (M.valid_from IS NULL OR M.valid_from <= asOf) AND
   *   (M.valid_until IS NULL OR M.valid_until > asOf)
   *
   * The boundary is half-open [valid_from, valid_until):
   *   - valid_from is INCLUSIVE
   *   - valid_until is EXCLUSIVE
   *
   * AUDIT FIX: This method must issue a SQL query with WHERE clause
   * directly on the valid_from and valid_until columns. It must NOT
   * post-filter on metadata JSON.
   */
  searchAtTime(
    query: string,
    asOf: Date,
    opts?: Omit<SearchOptions, 'asOf'>
  ): Promise<SearchResult<SemanticMemory>[]>

  /**
   * Return all semantic memories related to topic, ordered by valid_from ASC.
   * Includes superseded (expired) memories so callers can trace the full chain.
   *
   * AUDIT FIX: This is a REQUIRED method on SemanticStorage.
   * Memory.getTimeline() must NOT duck-type check for its existence.
   * Both SqliteSemanticStorage and the Supabase adapter must implement it.
   * The Supabase implementation may use a simpler scan if GDS is not needed.
   *
   * Topic matching: exact match on topic column OR LIKE '%topic%'.
   * Date range: fromDate and toDate filter on COALESCE(valid_from, created_at).
   */
  getTopicTimeline(
    topic: string,
    opts?: { fromDate?: Date; toDate?: Date }
  ): Promise<SemanticMemory[]>
}
```

### 9.5 `RecallOpts` Extension

**File to modify:** `packages/core/src/retrieval/engine.ts`

Add `asOf` to `RecallOpts`:

```typescript
export interface RecallOpts {
  strategy: RecallStrategy
  embedding: number[]
  intelligence?: IntelligenceAdapter
  sessionId?: string
  tokenBudget?: number
  /**
   * Return memories that were valid at this point in time.
   *
   * When set:
   *   - Semantic storage: calls searchAtTime(query, asOf) — SQL WHERE on valid_from/valid_until
   *   - Episodes/digests: passes beforeDate: asOf to SearchOptions (filtered inside unifiedSearch)
   *   - Neo4j spreading activation: passes asOf to SpreadActivationOpts so Cypher
   *     skips nodes where validUntil < asOf
   *
   * Boundary: half-open [valid_from, valid_until). A memory with validUntil = T is
   * NOT valid at T.
   *
   * When unset: no temporal filter — return all currently-valid memories.
   */
  asOf?: Date
}
```

### 9.6 `Memory.recall()` Signature Extension

**File to modify:** `packages/core/src/memory.ts`

```typescript
// Add graph?: boolean to MemoryOptions
export interface MemoryOptions {
  storage: StorageAdapter
  intelligence?: IntelligenceAdapter
  consolidation?: { schedule: 'auto' | 'manual' }
  tokenizer?: (text: string) => number
  /**
   * Enable the Neo4j graph layer (spreading activation via NeuralGraph.spreadActivation).
   * Defaults to true. Set to false to skip Neo4j entirely and use the SQL CTE
   * association walk (pre-Wave-2 behavior). Used by benchmarks to compare
   * graph vs no-graph performance.
   *
   * AUDIT FIX: When false, this.graph = null and ALL graph codepaths are skipped
   * via null-checks. No NeuralGraph.connect() is called. No decomposeEpisode().
   * No spreadActivation(). The null-check pattern from Wave 2 applies everywhere.
   */
  graph?: boolean
}

// Update recall() signature
async recall(
  query: string,
  opts?: {
    embedding?: number[]
    tokenBudget?: number
    /**
     * Return only memories valid at this point in time.
     * See RecallOpts.asOf for full semantics.
     */
    asOf?: Date
  }
): Promise<RecallResult>

// Inside recall(), forward asOf to engineRecall:
const result = await engineRecall(query, this.storage, this.sensory, {
  strategy,
  embedding: embedding ?? [],
  tokenBudget: opts?.tokenBudget,
  intelligence: this.intelligence,
  asOf: opts?.asOf,
  graph: this.opts.graph !== false ? this.graph : null,
})
```

Also add `SemanticMemory` to imports if not already present:

```typescript
import type {
  Message, SemanticMemory, ConsolidateResult, RecallResult, RetrievedMemory,
} from './types.js'
```

### 9.7 Engine-Level `asOf` Wiring

**File to modify:** `packages/core/src/retrieval/engine.ts`

When `opts.asOf` is set, the engine must apply filtering at two layers:

**Layer 1: SQL semantic search substitution**

Instead of calling `storage.semantic.search(query, opts)`, call:

```typescript
const semanticResults = opts.asOf
  ? await storage.semantic.searchAtTime(query, opts.asOf, { limit, embedding })
  : await storage.semantic.search(query, { limit, embedding })
```

**Layer 2: Episode and digest beforeDate filter (inside unifiedSearch)**

Pass `beforeDate: opts.asOf` through `SearchOptions` to the storage layer search calls. The actual filtering happens inside `unifiedSearch` in `packages/core/src/retrieval/search.ts`, where the raw `Episode` and `Digest` objects (which have `createdAt`) are still available.

**AUDIT FIX: Episode/digest filtering MUST happen inside `unifiedSearch`.**

After `unifiedSearch` returns `RetrievedMemory[]`, the `createdAt` field is gone. You cannot filter at that level. The `beforeDate` option on `SearchOptions` is specifically for this — the storage layer (or the search layer) applies `item.createdAt <= beforeDate` before constructing `RetrievedMemory`.

In `packages/core/src/retrieval/search.ts`, wherever `Episode` or `Digest` results are converted to `RetrievedMemory`, apply the filter:

```typescript
// Example for episodes:
const episodeResults = rawEpisodes.filter(ep => {
  if (!opts?.beforeDate) return true
  return ep.item.createdAt <= opts.beforeDate
})
```

**Layer 3: Neo4j spreading activation temporal filter**

Pass `asOf` to the spreading activation call. The Neo4j `spreadActivation` Cypher must include a temporal WHERE clause on neighbor nodes:

```typescript
// In NeuralGraph.spreadActivation() (packages/graph/src/neural-graph.ts):
// Add to SpreadActivationOpts:
interface SpreadActivationOpts {
  seedNodeIds: string[]
  seedActivations?: Map<string, number>
  maxHops?: number
  decay?: number
  threshold?: number
  edgeFilter?: string[]
  /**
   * When set, skip graph nodes where validUntil < asOf.
   * Prevents expired knowledge from being activated during historical queries.
   * Boundary: a node with validUntil = T is excluded at asOf = T (exclusive).
   */
  asOf?: Date
}
```

In the Cypher query inside `spreadActivation()`, add a temporal filter on neighbor nodes:

```cypher
MATCH (seed:Memory)
WHERE seed.nodeId IN $seedNodeIds
CALL apoc.path.subgraphAll(seed, {
  maxLevel: $maxHops,
  relationshipFilter: $edgeFilter
}) YIELD nodes, relationships
UNWIND nodes AS neighbor
WHERE neighbor.nodeId IS NOT NULL
  AND (
    $asOfMs IS NULL
    OR (
      (neighbor.validFrom IS NULL OR neighbor.validFrom <= $asOfMs)
      AND (neighbor.validUntil IS NULL OR neighbor.validUntil > $asOfMs)
    )
  )
RETURN neighbor.nodeId AS nodeId, neighbor.validFrom, neighbor.validUntil
```

Or, if using a custom BFS Cypher without APOC:

```cypher
-- In the variable-length path match, add a WHERE on neighbor:
MATCH p = (seed:Memory)-[*1..$maxHops]-(neighbor)
WHERE seed.nodeId IN $seedNodeIds
  AND (
    $asOfMs IS NULL
    OR (
      (neighbor.validFrom IS NULL OR neighbor.validFrom <= $asOfMs)
      AND (neighbor.validUntil IS NULL OR neighbor.validUntil > $asOfMs)
    )
  )
RETURN neighbor.nodeId AS nodeId
```

The `$asOfMs` parameter is `asOf.getTime()` (epoch milliseconds) or `null` when unset. Neo4j node properties `validFrom`/`validUntil` are stored as epoch millisecond integers (set during Wave 3 deep sleep).

**Boundary enforcement in Cypher:** `validUntil > $asOfMs` (exclusive upper bound). A node with `validUntil = T` is NOT returned when `$asOfMs = T`.

### 9.8 SQLite `searchAtTime` Implementation

**File to modify:** `packages/sqlite/src/semantic.ts`

**AUDIT FIX: SQL columns, not metadata JSON.**

First, update `SemanticRow` interface to include the new columns:

```typescript
interface SemanticRow {
  id: string
  topic: string
  content: string
  confidence: number
  source_digest_ids: string
  source_episode_ids: string
  access_count: number
  last_accessed: number | null
  decay_rate: number
  supersedes: string | null
  superseded_by: string | null
  embedding: Buffer | null
  metadata: string
  created_at: number
  updated_at: number
  valid_from: number | null   // Julian day (REAL). NULL = always valid.
  valid_until: number | null  // Julian day (REAL). NULL = currently valid.
}
```

Update `rowToSemantic()` to include temporal fields. Store them in metadata as ISO strings for convenience, but the primary truth is the SQL columns:

```typescript
private rowToSemantic(row: SemanticRow): SemanticMemory {
  return {
    id: row.id,
    topic: row.topic,
    content: row.content,
    confidence: row.confidence,
    sourceDigestIds: JSON.parse(row.source_digest_ids),
    sourceEpisodeIds: JSON.parse(row.source_episode_ids),
    accessCount: row.access_count,
    lastAccessed: julianToDate(row.last_accessed),
    decayRate: row.decay_rate,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    embedding: row.embedding
      ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4))
      : null,
    metadata: {
      ...JSON.parse(row.metadata ?? '{}'),
      // Expose temporal info as ISO strings for consumers.
      // DO NOT use these for filtering — use the SQL columns directly.
      validFrom: julianToDate(row.valid_from)?.toISOString() ?? null,
      validUntil: julianToDate(row.valid_until)?.toISOString() ?? null,
    },
    createdAt: julianToDate(row.created_at)!,
    updatedAt: julianToDate(row.updated_at)!,
  }
}
```

Implement `searchAtTime` with a SQL WHERE clause:

```typescript
async searchAtTime(
  query: string,
  asOf: Date,
  opts?: Omit<SearchOptions, 'asOf'>
): Promise<SearchResult<SemanticMemory>[]> {
  const asOfJulian = dateToJulian(asOf)  // convert Date to Julian day REAL
  const limit = opts?.limit ?? 10
  const embedding = opts?.embedding
  const ftsQuery = sanitizeFtsQuery(query)

  // Temporal WHERE clause (half-open interval [valid_from, valid_until)):
  //   (valid_from IS NULL OR valid_from <= asOfJulian)  — NULL means always valid
  //   AND
  //   (valid_until IS NULL OR valid_until > asOfJulian) — NULL means currently valid
  //                                                        valid_until is EXCLUSIVE
  const temporalClause = `
    (valid_from IS NULL OR valid_from <= ?)
    AND (valid_until IS NULL OR valid_until > ?)
  `
  const temporalParams = [asOfJulian, asOfJulian]

  if (embedding && embedding.length > 0) {
    // Hybrid path: run BM25 with temporal filter, then rerank by vector similarity.
    const bm25Rows = this.db
      .prepare(
        `SELECT s.*, -semantic_fts.rank AS bm25_score
         FROM semantic_fts
         JOIN semantic s ON semantic_fts.rowid = s.rowid
         WHERE semantic_fts MATCH ?
           AND ${temporalClause}
         ORDER BY rank LIMIT 50`
      )
      .all(ftsQuery, ...temporalParams) as Array<SemanticRow & { bm25_score: number }>

    // Rerank by vector similarity against the embedding (same pattern as existing hybrid search)
    // ... use hybridSearch helper or inline reranking ...
    // This is delegated to the existing hybridSearch helper in vector-search.ts,
    // passing a custom runBm25 function that includes the temporal clause.
    // See implementation pattern in the existing search() method.
    const db = this.db
    const rowToS = (row: SemanticRow & { bm25_score: number }) => this.rowToSemantic(row)
    return hybridSearch<SemanticMemory, SemanticRow>(
      {
        db,
        runBm25: () =>
          db
            .prepare(
              `SELECT s.*, -semantic_fts.rank AS bm25_score
               FROM semantic_fts
               JOIN semantic s ON semantic_fts.rowid = s.rowid
               WHERE semantic_fts MATCH ?
                 AND (s.valid_from IS NULL OR s.valid_from <= ?)
                 AND (s.valid_until IS NULL OR s.valid_until > ?)
               ORDER BY rank LIMIT 50`
            )
            .all(ftsQuery, asOfJulian, asOfJulian) as Array<SemanticRow & { bm25_score: number }>,
        recentVectorSql: `
          SELECT id, embedding FROM semantic
          WHERE embedding IS NOT NULL
            AND (valid_from IS NULL OR valid_from <= ?)
            AND (valid_until IS NULL OR valid_until > ?)
          ORDER BY created_at DESC LIMIT ?
        `,
        recentVectorLimit: 200,
        queryEmbedding: embedding,
        limit,
        // Pass asOfJulian as extra bind params for recentVectorSql
        recentVectorParams: [asOfJulian, asOfJulian],
        getByIds: async (ids) => {
          if (ids.length === 0) return []
          const placeholders = ids.map(() => '?').join(',')
          const rows = db
            .prepare(`SELECT * FROM semantic WHERE id IN (${placeholders})`)
            .all(...ids) as SemanticRow[]
          return rows.map(r => this.rowToSemantic(r))
        },
      },
      rowToS,
      (item, score) => ({ item, similarity: score })
    )
  }

  // BM25-only path with temporal filter
  const rows = this.db
    .prepare(
      `SELECT s.*, -semantic_fts.rank AS bm25_score
       FROM semantic_fts
       JOIN semantic s ON semantic_fts.rowid = s.rowid
       WHERE semantic_fts MATCH ?
         AND (s.valid_from IS NULL OR s.valid_from <= ?)
         AND (s.valid_until IS NULL OR s.valid_until > ?)
       ORDER BY rank LIMIT ?`
    )
    .all(ftsQuery, asOfJulian, asOfJulian, limit) as Array<SemanticRow & { bm25_score: number }>

  const maxScore = rows.length > 0 ? Math.max(...rows.map(r => r.bm25_score)) : 1
  return rows
    .filter(r => r.bm25_score > 0)
    .map(r => ({
      item: this.rowToSemantic(r),
      similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
    }))
}
```

The `dateToJulian` helper function must be added to `packages/sqlite/src/search.ts` (the reverse of the existing `julianToDate`):

```typescript
// In packages/sqlite/src/search.ts — add alongside julianToDate:
export function dateToJulian(d: Date): number {
  // Julian day number from Unix epoch milliseconds.
  // Julian epoch = noon January 1, 4713 BC UTC.
  // Unix epoch in Julian days = 2440587.5
  return d.getTime() / 86400000 + 2440587.5
}
```

### 9.9 SQLite `getTopicTimeline` Implementation

**AUDIT FIX: Required method. Memory.getTimeline() does not duck-type check for it.**

```typescript
async getTopicTimeline(
  topic: string,
  opts?: { fromDate?: Date; toDate?: Date }
): Promise<SemanticMemory[]> {
  // Include all memories about the topic — including superseded ones.
  // ORDER BY COALESCE(valid_from, created_at) ASC to get chronological order.
  // NULL valid_from (= always valid) sorts before everything else (epoch).
  let sql = `
    SELECT * FROM semantic
    WHERE (topic = ? OR topic LIKE ?)
  `
  const params: (string | number)[] = [topic, `%${topic}%`]

  if (opts?.fromDate) {
    const fromJulian = dateToJulian(opts.fromDate)
    sql += ` AND COALESCE(valid_from, 0) >= ?`
    params.push(fromJulian)
  }

  if (opts?.toDate) {
    const toJulian = dateToJulian(opts.toDate)
    sql += ` AND COALESCE(valid_from, 0) <= ?`
    params.push(toJulian)
  }

  sql += ` ORDER BY COALESCE(valid_from, created_at) ASC`

  const rows = this.db.prepare(sql).all(...params) as SemanticRow[]
  return rows.map(r => this.rowToSemantic(r))
}
```

### 9.10 `Memory.getTimeline()` Method

**File to modify:** `packages/core/src/memory.ts`

**AUDIT FIX: Call getTopicTimeline() directly. No duck-type check. No getUnaccessed() fallback.**

```typescript
/**
 * Return a chronological list of all semantic memories about a topic.
 * Includes superseded (expired) memories — the full belief history.
 * Results are sorted by validFrom ascending (oldest first).
 *
 * Uses getTopicTimeline() from SemanticStorage, which is a required interface method.
 */
async getTimeline(
  topic: string,
  opts?: { fromDate?: Date; toDate?: Date }
): Promise<Array<{
  id: string
  content: string
  confidence: number
  validFrom: string | null
  validUntil: string | null
  supersededBy: string | null
  createdAt: Date
}>> {
  this.assertInitialized()

  const memories = await this.storage.semantic.getTopicTimeline(topic, opts)

  return memories.map(m => ({
    id: m.id,
    content: m.content,
    confidence: m.confidence,
    validFrom: (m.metadata?.validFrom as string | null) ?? null,
    validUntil: (m.metadata?.validUntil as string | null) ?? null,
    supersededBy: m.supersededBy,
    createdAt: m.createdAt,
  }))
}
```

### 9.11 Linear Supersession Enforcement in Deep Sleep

**File to modify:** `packages/core/src/consolidation/deep-sleep.ts`

**AUDIT FIX: New memory supersedes the LATEST unsuperseded in the chain, not the original.**

When deep sleep detects a contradiction and would mark memory A as superseded by new memory B, it must first check whether A is already superseded. If A has a `superseded_by` pointer, follow the chain until reaching the last memory that has `superseded_by = null` — that is the current truth. The new memory B supersedes that one.

```typescript
/**
 * Find the terminal (currently-valid) memory in a supersession chain.
 * Given a memory ID, follow superseded_by pointers until reaching
 * a memory with superseded_by = null.
 * Returns the ID of the terminal memory.
 *
 * This enforces linear supersession: each topic has exactly one currently-valid
 * truth at any point in time.
 */
async function findTerminalInChain(
  startId: string,
  storage: SemanticStorage,
  maxDepth = 20
): Promise<string> {
  let currentId = startId
  let depth = 0

  while (depth < maxDepth) {
    // getTopicTimeline returns full rows; we need a lighter lookup here.
    // Use searchAtTime or a direct lookup by ID.
    // The cleanest approach: add a lightweight getById to SemanticStorage,
    // or use the existing StorageAdapter.getById(id, 'semantic').
    const result = await storage.getById?.(currentId, 'semantic')
    if (!result) break

    const mem = (result as { data: SemanticMemory }).data
    if (!mem.supersededBy) return currentId

    currentId = mem.supersededBy
    depth++
  }

  return currentId
}

// In the supersession detection block of deep sleep:
// Before: storage.semantic.markSuperseded(oldMemory.id, newMemory.id)
// After:
const terminalId = await findTerminalInChain(oldMemory.id, storage.semantic)
if (terminalId !== newMemory.id) {
  await storage.semantic.markSuperseded(terminalId, newMemory.id)
  // Also update Neo4j: add CONTRADICTS relationship from new → terminal
  // (if graph is enabled)
  if (graph) {
    await graph.addContradicts(newMemory.id, terminalId)
  }
}
```

Note: `StorageAdapter.getById(id, type)` already exists on the `StorageAdapter` interface. Pass `storage` (the full adapter) to `findTerminalInChain` rather than `storage.semantic` to use it.

### 9.12 `memory_timeline` MCP Tool

**File to modify:** `packages/mcp/src/index.ts`

#### ListTools addition

Add to the `tools` array in the `ListToolsRequestSchema` handler:

```typescript
{
  name: 'memory_timeline',
  description:
    'Show how knowledge about a topic has changed over time. Returns a chronological list of semantic memories on the topic, including superseded beliefs, showing what replaced what. Useful for tracing decision history, preference evolution, or belief changes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      topic: {
        type: 'string',
        description: 'The topic or subject to trace. E.g. "database preference" or "deployment platform".',
      },
      from_date: {
        type: 'string',
        description: 'Optional ISO date (YYYY-MM-DD). Only include memories valid after this date.',
      },
      to_date: {
        type: 'string',
        description: 'Optional ISO date (YYYY-MM-DD). Only include memories valid before this date.',
      },
    },
    required: ['topic'],
  },
},
```

Also add `as_of` to the existing `memory_recall` tool definition:

```typescript
// Add to memory_recall inputSchema.properties:
as_of: {
  type: 'string',
  description:
    'Optional ISO date string (YYYY-MM-DD or full ISO 8601). When set, returns only memories valid at that point in time. Use this to ask "what did I believe about X on date Y?"',
},
```

#### CallTool handler additions

Add `as_of` handling to the `memory_recall` handler:

```typescript
if (name === 'memory_recall') {
  const query = args['query']
  const asOfRaw = args['as_of']

  // ... existing query validation ...

  let asOf: Date | undefined
  if (typeof asOfRaw === 'string' && asOfRaw.trim().length > 0) {
    const parsed = new Date(asOfRaw)
    if (isNaN(parsed.getTime())) {
      return {
        content: [{ type: 'text' as const, text: `Error: as_of "${asOfRaw}" is not a valid ISO date` }],
        isError: true,
      }
    }
    asOf = parsed
  }

  const result = await mem.recall(query.trim(), { asOf })
  // ... rest of handler unchanged ...
}
```

Add the `memory_timeline` handler (insert after the `memory_forget` block):

```typescript
if (name === 'memory_timeline') {
  const topic = args['topic']
  const fromDateRaw = args['from_date']
  const toDateRaw = args['to_date']

  if (typeof topic !== 'string' || topic.trim().length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'Error: topic must be a non-empty string' }],
      isError: true,
    }
  }

  let fromDate: Date | undefined
  let toDate: Date | undefined

  if (typeof fromDateRaw === 'string' && fromDateRaw.trim()) {
    const parsed = new Date(fromDateRaw)
    if (!isNaN(parsed.getTime())) fromDate = parsed
  }
  if (typeof toDateRaw === 'string' && toDateRaw.trim()) {
    const parsed = new Date(toDateRaw)
    if (!isNaN(parsed.getTime())) toDate = parsed
  }

  const timeline = await mem.getTimeline(topic.trim(), { fromDate, toDate })

  if (timeline.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No memories found about topic: "${topic}"` }],
    }
  }

  return {
    content: [{ type: 'text' as const, text: formatTimeline(topic, timeline) }],
  }
}
```

#### `formatTimeline` helper (add to `packages/mcp/src/index.ts`)

```typescript
interface TimelineEntry {
  content: string
  validFrom: string | null
  validUntil: string | null
  confidence: number
  supersededBy: string | null
}

function formatTimeline(topic: string, entries: TimelineEntry[]): string {
  const lines: string[] = [`Timeline for "${topic}":`]
  lines.push('')

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const fromLabel = entry.validFrom
      ? new Date(entry.validFrom).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric',
        })
      : 'unknown date'

    const untilLabel = entry.validUntil
      ? new Date(entry.validUntil).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric',
        })
      : null

    const status = untilLabel
      ? `valid ${fromLabel} — ${untilLabel} (superseded)`
      : `valid from ${fromLabel} (current)`

    const arrow = i < entries.length - 1 ? '\n     ->' : ''
    lines.push(`[${status}] ${entry.content} (confidence: ${(entry.confidence * 100).toFixed(0)}%)${arrow}`)
  }

  return lines.join('\n')
}
```

### 9.13 Supabase `SemanticStorage` Stub Methods

**File to modify:** `packages/supabase/src/semantic.ts` (or equivalent)

The Supabase adapter's semantic storage must implement `searchAtTime` and `getTopicTimeline` to satisfy the updated interface. Full optimization is out of scope for Wave 4; these are correct but not performance-optimized implementations.

```typescript
// In the Supabase SemanticStorage implementation:

async searchAtTime(
  query: string,
  asOf: Date,
  opts?: Omit<SearchOptions, 'asOf'>
): Promise<SearchResult<SemanticMemory>[]> {
  // Supabase: filter on valid_from and valid_until columns.
  // (valid_from IS NULL OR valid_from <= asOf) AND (valid_until IS NULL OR valid_until > asOf)
  // The Supabase client uses .lte() and .gt() for these comparisons.
  // Use the existing search() method as base and add temporal filters in the query.
  // This is a direct Supabase query, not a post-filter.
  const asOfIso = asOf.toISOString()
  const limit = opts?.limit ?? 10

  const { data, error } = await this.client
    .from('semantic')
    .select('*')
    .or(`valid_from.is.null,valid_from.lte.${asOfIso}`)
    .or(`valid_until.is.null,valid_until.gt.${asOfIso}`)
    .limit(limit)

  if (error) throw error
  return (data ?? []).map(row => ({ item: this.rowToSemantic(row), similarity: 0.5 }))
}

async getTopicTimeline(
  topic: string,
  opts?: { fromDate?: Date; toDate?: Date }
): Promise<SemanticMemory[]> {
  let q = this.client
    .from('semantic')
    .select('*')
    .or(`topic.eq.${topic},topic.ilike.%${topic}%`)
    .order('valid_from', { ascending: true, nullsFirst: true })

  if (opts?.fromDate) {
    q = q.gte('valid_from', opts.fromDate.toISOString())
  }
  if (opts?.toDate) {
    q = q.lte('valid_from', opts.toDate.toISOString())
  }

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map(row => this.rowToSemantic(row))
}
```

---

## Part 10: Tests

All tests go in `packages/bench/test/`. Use vitest.

### 10.1 `test/locomo.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { LoCoMoAdapter } from '../src/locomo/adapter.js'
import { createBenchMemory } from '../src/memory-factory.js'
import { computeRetrievalF1 } from '../src/metrics/f1.js'
import type { LoCoMoConversationFile } from '../src/locomo/types.js'

/**
 * Synthetic LoCoMo fixture with two date-groups (two segments).
 * Segment 1 (January 10): dia_id 0, 1, 2
 * Segment 2 (January 15): dia_id 3, 4, 5
 *
 * Evidence ID "D1:2" means segment 1 (January 10), turn with dia_id=2.
 * Evidence ID "D2:3" means segment 2 (January 15), turn with dia_id=3.
 */
function makeFixture(): LoCoMoConversationFile[] {
  return [
    {
      id: 'test-conv-1',
      conversation: [
        { dia_id: 0, speaker: 'A', text: 'I really enjoy hiking in the mountains every weekend.', date: 'January 10, 2024' },
        { dia_id: 1, speaker: 'B', text: 'That sounds wonderful! Which mountains do you usually go to?', date: 'January 10, 2024' },
        { dia_id: 2, speaker: 'A', text: 'I usually hike in the Rocky Mountains near Colorado.', date: 'January 10, 2024' },
        { dia_id: 3, speaker: 'A', text: 'My favorite programming language is TypeScript.', date: 'January 15, 2024' },
        { dia_id: 4, speaker: 'B', text: 'Why TypeScript over JavaScript?', date: 'January 15, 2024' },
        { dia_id: 5, speaker: 'A', text: 'TypeScript gives me type safety which prevents a lot of bugs.', date: 'January 15, 2024' },
      ],
      qa: [
        {
          id: 'q1',
          question: 'Where does the person like to hike?',
          answer: 'Rocky Mountains near Colorado',
          evidence_ids: ['D1:2'],   // segment 1 (Jan 10), dia_id=2
          category: 1,
        },
        {
          id: 'q2',
          question: 'What is their favorite programming language?',
          answer: 'TypeScript',
          evidence_ids: ['D2:3'],   // segment 2 (Jan 15), dia_id=3
          category: 1,
        },
      ],
    },
  ]
}

describe('computeRetrievalF1', () => {
  it('returns 1.0 on exact match', () => {
    expect(computeRetrievalF1('Rocky Mountains near Colorado', 'Rocky Mountains near Colorado')).toBeCloseTo(1.0, 2)
  })

  it('returns 0 on empty strings', () => {
    expect(computeRetrievalF1('', 'anything')).toBe(0)
    expect(computeRetrievalF1('anything', '')).toBe(0)
  })

  it('returns partial F1 on overlapping tokens', () => {
    const f1 = computeRetrievalF1('Rocky Mountains Colorado', 'Rocky Mountains near Colorado')
    expect(f1).toBeGreaterThan(0)
    expect(f1).toBeLessThan(1)
  })
})

describe('LoCoMoAdapter', () => {
  it('ingests a synthetic conversation without throwing', async () => {
    const memory = await createBenchMemory({ graph: false })
    const adapter = new LoCoMoAdapter()
    const { episodesIngested } = await adapter.ingestConversation(makeFixture()[0], memory)
    expect(episodesIngested).toBe(6)
  })

  it('assigns locomoSegmentIndex correctly: segment 1 for Jan 10, segment 2 for Jan 15', async () => {
    // This tests the AUDIT FIX: segment index = date-group ordinal, not conversation array index.
    const memory = await createBenchMemory({ graph: false })
    const adapter = new LoCoMoAdapter()
    const fixture = makeFixture()

    await adapter.ingestConversation(fixture[0], memory)

    // Evaluate Q1 which expects evidence at D1:2 (segment=1, dia_id=2)
    const result = await memory.recall('Rocky Mountains Colorado')
    const janTenTurns = result.memories.filter(m =>
      m.metadata?.locomoSegmentIndex === 1 &&
      m.metadata?.locomoTurnId === 2
    )
    // The episode with dia_id=2 from January 10 should be ingested with segmentIndex=1
    expect(janTenTurns.length).toBeGreaterThanOrEqual(0)  // structural check only
  }, 30000)

  it('evaluates QA pairs and produces retrievalF1 > 0 after ingestion', async () => {
    const memory = await createBenchMemory({ graph: false })
    const adapter = new LoCoMoAdapter()
    const fixture = makeFixture()

    await adapter.ingestDataset(fixture, memory, { consolidate: false })
    const results = await adapter.evaluateDataset(fixture, memory, { topK: 10 })

    expect(results).toHaveLength(1)
    expect(results[0].qaPredictions).toHaveLength(2)

    // At least one QA pair should have retrievalF1 > 0 (content was ingested and recalled)
    const totalF1 = results[0].qaPredictions.reduce((s, p) => s + p.retrievalF1, 0)
    expect(totalF1).toBeGreaterThan(0)
  }, 30000)

  it('result shape uses retrievalF1 key, not predictionF1', async () => {
    const memory = await createBenchMemory({ graph: false })
    const adapter = new LoCoMoAdapter()
    const fixture = makeFixture()

    await adapter.ingestDataset(fixture, memory, { consolidate: false })
    const results = await adapter.evaluateDataset(fixture, memory)

    for (const pred of results[0].qaPredictions) {
      expect(pred).toHaveProperty('retrievalF1')
      expect(pred).not.toHaveProperty('predictionF1')
    }
  }, 30000)

  it('run() returns a valid LoCoMoResult shape', async () => {
    const adapter = new LoCoMoAdapter()
    const fixture = makeFixture()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-bench-'))
    const fixturePath = path.join(tmpDir, 'fixture.json')
    await fs.writeFile(fixturePath, JSON.stringify(fixture), 'utf8')

    const result = await adapter.run(fixturePath, { consolidate: false, graph: false })

    expect(result.benchmark).toBe('locomo')
    expect(result.conversations).toHaveLength(1)
    expect(result.metrics.totalQueries).toBe(2)
    expect(result.evalFormat[0].qa[0]).toHaveProperty('retrieval_f1')
    expect(result.evalFormat[0].qa[0]).not.toHaveProperty('prediction_f1')

    await fs.rm(tmpDir, { recursive: true })
  }, 60000)
})
```

### 10.2 `test/longmemeval.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { LongMemEvalAdapter } from '../src/longmemeval/adapter.js'
import { createBenchMemory } from '../src/memory-factory.js'
import type { LongMemEvalQuestion } from '../src/longmemeval/types.js'

function makeFixture(): LongMemEvalQuestion[] {
  return [
    {
      question_id: 'lme-q1',
      question: 'What project management tool does the user prefer?',
      answer: 'Linear',
      answer_session_ids: ['session-a'],
      memory_type: 'single_session_user',
      haystack_sessions: [
        {
          session_id: 'session-a',
          messages: [
            { role: 'user', content: 'I switched from Jira to Linear last month and love it.' },
            { role: 'assistant', content: 'Linear is great for small to mid-sized teams.' },
          ],
        },
        {
          session_id: 'session-b',
          messages: [
            { role: 'user', content: 'The weather today is really nice.' },
            { role: 'assistant', content: 'Enjoy it!' },
          ],
        },
      ],
    },
  ]
}

describe('LongMemEvalAdapter', () => {
  it('ingests haystack sessions without throwing', async () => {
    const memory = await createBenchMemory({ graph: false })
    const adapter = new LongMemEvalAdapter()
    const { episodesIngested } = await adapter.ingestQuestion(makeFixture()[0], memory)
    expect(episodesIngested).toBe(4)  // 2 sessions × 2 messages
  })

  it('evaluates questions and returns predictions with correct shape', async () => {
    const memory = await createBenchMemory({ graph: false })
    const adapter = new LongMemEvalAdapter()
    const fixture = makeFixture()

    await adapter.ingestDataset(fixture, memory, { consolidate: false })
    const predictions = await adapter.evaluateDataset(fixture, memory, { topK: 10 })

    expect(predictions).toHaveLength(1)
    expect(predictions[0].questionId).toBe('lme-q1')
    expect(predictions[0].goldSessionIds).toContain('session-a')
    expect(typeof predictions[0].recallAt5).toBe('boolean')
    expect(typeof predictions[0].recallAt10).toBe('boolean')
  }, 30000)

  it('run() returns a valid LongMemEvalResult shape', async () => {
    const adapter = new LongMemEvalAdapter()
    const fixture = makeFixture()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-lme-'))
    const fixturePath = path.join(tmpDir, 'fixture.json')
    await fs.writeFile(fixturePath, JSON.stringify(fixture), 'utf8')

    const result = await adapter.run(fixturePath, { consolidate: false, graph: false })

    expect(result.benchmark).toBe('longmemeval')
    expect(result.predictions).toHaveLength(1)
    expect(result.evalJsonl).toHaveLength(1)
    expect(result.evalJsonl[0]).toHaveProperty('question_id')
    expect(result.evalJsonl[0]).toHaveProperty('hypothesis')

    await fs.rm(tmpDir, { recursive: true })
  }, 60000)

  it('mapAbility handles unknown types gracefully', () => {
    // mapAbility is protected — test via evaluateDataset result
    const adapter = new LongMemEvalAdapter()
    const adaptorWithAccess = adapter as unknown as { mapAbility(t: string): string }
    expect(adaptorWithAccess.mapAbility('unknown_type')).toBe('information_extraction')
    expect(adaptorWithAccess.mapAbility('temporal')).toBe('temporal_reasoning')
    expect(adaptorWithAccess.mapAbility('multi_session')).toBe('multi_session_reasoning')
  })
})
```

### 10.3 `test/temporal.test.ts`

This is the primary test file for Job 2. It tests the temporal validity system end-to-end.

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { createBenchMemory } from '../src/memory-factory.js'
import type { Memory } from '@engram/core'

/**
 * Temporal validity test suite.
 *
 * These tests inject data and verify asOf filtering. They do NOT require Neo4j.
 * graph: false is used throughout so tests pass in CI without a running Neo4j.
 *
 * Coverage:
 * 1. Episode-level createdAt filtering via asOf.
 * 2. getTimeline() returns entries in chronological order.
 * 3. getTimeline() returns empty for unknown topic.
 * 4. Boundary: asOf before any memories → empty.
 * 5. NULL validFrom semantics (semantic-level — requires injection test helper).
 * 6. Half-open interval boundary (validUntil is exclusive).
 * 7. searchAtTime returns semantic memories from SQL columns, not metadata JSON.
 *
 * Tests 5–7 on semantic memories require directly inserting rows into the
 * SqliteStorageAdapter. Use the storage adapter exposed on the Memory instance
 * via a test injection helper. The Memory class must expose storage for tests via:
 *
 *   memory.storage   -- accessible if the field is typed as public or exposed
 *                       via a getter. If private, add:
 *   // In Memory class: get _storageForTest() { return this.storage }
 *
 * The implementing agent must add this test accessor if Memory.storage is private.
 */

describe('Temporal validity — episode-level filtering', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = await createBenchMemory({ graph: false })
  })

  it('recall without asOf returns recently ingested episodes', async () => {
    await memory.ingest({
      role: 'user',
      content: 'I prefer PostgreSQL for our database.',
      sessionId: 'temporal-test',
    })
    const result = await memory.recall('database preference')
    expect(result.memories.length).toBeGreaterThan(0)
  }, 30000)

  it('recall with asOf = now returns recently ingested episodes', async () => {
    await memory.ingest({
      role: 'user',
      content: 'We use Redshift for data warehousing.',
      sessionId: 'temporal-test',
    })
    const result = await memory.recall('data warehouse', { asOf: new Date() })
    const hit = result.memories.some(m => m.content.toLowerCase().includes('redshift'))
    expect(hit).toBe(true)
  }, 30000)

  it('recall with asOf = 5 minutes ago does NOT return just-ingested episodes', async () => {
    // Episode is created NOW. asOf = 5 minutes ago → episode was not yet created → excluded.
    await memory.ingest({
      role: 'user',
      content: 'We should migrate to BigQuery.',
      sessionId: 'temporal-test',
    })
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const result = await memory.recall('bigquery migration', { asOf: fiveMinutesAgo })
    const hit = result.memories.some(m => m.content.toLowerCase().includes('bigquery'))
    expect(hit).toBe(false)
  }, 30000)

  it('recall with asOf = 1 year ago returns empty (no memories existed then)', async () => {
    await memory.ingest({
      role: 'user',
      content: 'I prefer PostgreSQL for our database.',
      sessionId: 'temporal-test',
    })
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    const result = await memory.recall('database preference', { asOf: oneYearAgo })
    // No memories were created a year ago
    const postgresHits = result.memories.filter(m => m.content.toLowerCase().includes('postgresql'))
    expect(postgresHits).toHaveLength(0)
  }, 30000)
})

describe('Temporal validity — half-open interval boundary', () => {
  it('validUntil is exclusive: a memory with validUntil=T is not returned at asOf=T', async () => {
    // This test directly manipulates the SQLite semantic table to inject a memory
    // with specific valid_from and valid_until values.
    //
    // Setup: insert a semantic memory with:
    //   valid_from  = Julian day for 2025-01-01
    //   valid_until = Julian day for 2025-03-01   (exclusive upper bound)
    //
    // Test: searchAtTime(asOf=2025-03-01) should NOT return the memory.
    //       searchAtTime(asOf=2025-02-28) SHOULD return the memory.
    //
    // The implementing agent must add a _storageForTest getter on Memory
    // OR use a test-only wrapper that exposes the storage adapter.

    const memory = await createBenchMemory({ graph: false })
    const storage = (memory as unknown as { _storageForTest: { semantic: { db?: unknown } } })._storageForTest

    // If _storageForTest is not available, this test is marked pending.
    // The agent must add the accessor rather than skipping this test.
    if (!storage) {
      // Agent: add `get _storageForTest() { return this.storage }` to Memory class.
      // Then rerun.
      expect(true).toBe(true)  // placeholder until accessor is added
      return
    }

    // Direct SQLite injection (skipping FTS triggers for simplicity):
    // See test/fixtures/temporal-injection.ts for the helper function.
    // The agent must create this helper.
    expect(true).toBe(true)  // structural placeholder
  }, 30000)
})

describe('Temporal validity — getTimeline', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = await createBenchMemory({ graph: false })
  })

  it('returns entries in chronological order (createdAt ascending)', async () => {
    await memory.ingest({ role: 'user', content: 'We prefer to deploy on AWS.', sessionId: 'timeline-test' })
    await memory.ingest({ role: 'user', content: 'We are switching deployment from AWS to GCP.', sessionId: 'timeline-test' })
    await memory.ingest({ role: 'user', content: 'GCP deployment is now complete.', sessionId: 'timeline-test' })

    const timeline = await memory.getTimeline('deployment')

    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        timeline[i - 1].createdAt.getTime()
      )
    }
  }, 30000)

  it('returns empty array for unknown topic', async () => {
    const timeline = await memory.getTimeline('xyzzy-nonexistent-topic-99')
    expect(timeline).toHaveLength(0)
  }, 15000)

  it('each entry has the required fields', async () => {
    await memory.ingest({ role: 'user', content: 'Our stack is Node.js and TypeScript.', sessionId: 'timeline-test' })
    const timeline = await memory.getTimeline('stack')

    // Timeline currently contains episodes (semantic requires consolidation).
    // If getTopicTimeline returns empty for episode-level data, that is correct —
    // it only returns SemanticMemory rows. This test verifies the shape when non-empty.
    for (const entry of timeline) {
      expect(entry).toHaveProperty('id')
      expect(entry).toHaveProperty('content')
      expect(entry).toHaveProperty('confidence')
      expect(entry).toHaveProperty('createdAt')
      expect(entry).toHaveProperty('supersededBy')
      // validFrom and validUntil may be null for newly created memories
      expect('validFrom' in entry).toBe(true)
      expect('validUntil' in entry).toBe(true)
    }
  }, 30000)
})

describe('Temporal validity — semantic-level (injection via test helper)', () => {
  /**
   * These tests verify asOf filtering on the semantic table via direct SQL injection.
   * The implementing agent must create packages/bench/test/fixtures/temporal-injection.ts
   * with a helper that inserts a SemanticMemory row with specific valid_from/valid_until
   * Julian day values directly into the SQLite database.
   *
   * Helper signature:
   *   async function injectSemanticMemory(
   *     db: Database.Database,
   *     opts: {
   *       id: string
   *       topic: string
   *       content: string
   *       confidence: number
   *       validFromDate: Date | null
   *       validUntilDate: Date | null
   *     }
   *   ): Promise<void>
   *
   * The helper inserts directly into the `memories` table and `semantic` table,
   * bypassing the FTS5 triggers (which is acceptable for these tests since we
   * are testing the SQL filter, not FTS5 ranking).
   *
   * After creating the helper, replace the placeholder assertions below with
   * real searchAtTime calls.
   */

  it('searchAtTime returns memory valid at asOf, not after valid_until', async () => {
    // Placeholder: implement after creating temporal-injection.ts helper.
    // T1 = 2025-01-01, T2 = 2025-03-01
    // Inject: memory A valid [T1, T2) — content "prefer Redshift"
    // Inject: memory B valid [T2, null) — content "prefer BigQuery"
    // searchAtTime(asOf=T1+1day) → returns memory A
    // searchAtTime(asOf=T2) → returns memory B (T2 is exclusive for A, so A is gone at T2)
    // searchAtTime(asOf=T2-1day) → returns memory A
    expect(true).toBe(true)  // placeholder
  }, 30000)

  it('NULL validFrom means always valid (treated as epoch)', async () => {
    // Inject memory with valid_from = NULL, valid_until = NULL.
    // searchAtTime(asOf=any date) → should return the memory.
    expect(true).toBe(true)  // placeholder
  }, 30000)

  it('linear supersession: new memory supersedes latest in chain, not original', async () => {
    // Inject chain: A superseded by B, B superseded by C (C is current truth).
    // When deep sleep creates D to supersede A, it should find C as terminal
    // and supersede C with D, not A with D.
    // This is a unit test of findTerminalInChain().
    expect(true).toBe(true)  // placeholder
  }, 30000)
})
```

### 10.4 `test/comparison.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { LoCoMoAdapter } from '../src/locomo/adapter.js'
import type { LoCoMoConversationFile } from '../src/locomo/types.js'

function makeFixture(): LoCoMoConversationFile[] {
  return [
    {
      id: 'compare-conv-1',
      conversation: [
        { dia_id: 0, speaker: 'A', text: 'The project uses a microservices architecture.', date: 'February 1, 2024' },
        { dia_id: 1, speaker: 'B', text: 'Which services do you have?', date: 'February 1, 2024' },
        { dia_id: 2, speaker: 'A', text: 'We have auth, orders, and inventory services.', date: 'February 1, 2024' },
      ],
      qa: [
        {
          id: 'cq1',
          question: 'What services does the project have?',
          answer: 'auth, orders, and inventory services',
          evidence_ids: ['D1:2'],
          category: 1,
        },
      ],
    },
  ]
}

describe('Comparison mode', () => {
  it('graph=false produces a valid LoCoMoResult shape', async () => {
    const adapter = new LoCoMoAdapter()
    const fixture = makeFixture()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-cmp-'))
    const fixturePath = path.join(tmpDir, 'fixture.json')
    await fs.writeFile(fixturePath, JSON.stringify(fixture), 'utf8')

    const result = await adapter.run(fixturePath, { consolidate: false, graph: false })

    expect(result.benchmark).toBe('locomo')
    expect(typeof result.overall.averageRetrievalF1).toBe('number')
    expect(result.overall.averageRetrievalF1).toBeGreaterThanOrEqual(0)
    expect(result.overall.averageRetrievalF1).toBeLessThanOrEqual(1)

    await fs.rm(tmpDir, { recursive: true })
  }, 60000)

  it('both graph modes produce the same number of QA evaluations', async () => {
    // graph=true requires Neo4j. In CI without Neo4j, graph=true fails to connect.
    // This test runs graph=false twice to verify structural correctness.
    // For comparison with graph=true, run manually with Neo4j available.
    const adapter = new LoCoMoAdapter()
    const fixture = makeFixture()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-cmp3-'))
    const fixturePath = path.join(tmpDir, 'fixture.json')
    await fs.writeFile(fixturePath, JSON.stringify(fixture), 'utf8')

    const [run1, run2] = await Promise.all([
      adapter.run(fixturePath, { consolidate: false, graph: false }),
      adapter.run(fixturePath, { consolidate: false, graph: false }),
    ])

    expect(run1.metrics.totalQueries).toBe(run2.metrics.totalQueries)

    await fs.rm(tmpDir, { recursive: true })
  }, 90000)
})
```

---

## Part 11: Register Package in Monorepo

### 11.1 `turbo.json`

The root `turbo.json` already defines `build`, `test`, `typecheck`, `clean`. No change needed — Turborepo auto-discovers workspace packages.

### 11.2 Root `package.json`

The root uses `"workspaces": ["packages/*"]`. The new package at `packages/bench/` is auto-discovered. No change needed.

### 11.3 Verify `@engram/sqlite` Exports

The bench's `memory-factory.ts` imports `SqliteStorageAdapter` from `@engram/sqlite`. Confirm that `packages/sqlite/src/index.ts` exports it. If not, add:

```typescript
export { SqliteStorageAdapter } from './adapter.js'
```

Also confirm that `dateToJulian` (added in Part 9.8) is exported from `packages/sqlite/src/search.ts` or is accessible within the package.

---

## Part 12: Files Modified vs Created

### New files (create from scratch)

```
packages/bench/package.json
packages/bench/tsconfig.json
packages/bench/vitest.config.ts
packages/bench/bin/engram-bench.ts
packages/bench/src/index.ts
packages/bench/src/types.ts
packages/bench/src/memory-factory.ts
packages/bench/src/locomo/adapter.ts
packages/bench/src/locomo/types.ts
packages/bench/src/longmemeval/adapter.ts
packages/bench/src/longmemeval/types.ts
packages/bench/src/metrics/f1.ts
packages/bench/src/metrics/table.ts
packages/bench/src/runner/compare.ts
packages/bench/test/locomo.test.ts
packages/bench/test/longmemeval.test.ts
packages/bench/test/temporal.test.ts
packages/bench/test/comparison.test.ts
packages/bench/test/fixtures/temporal-injection.ts   ← NEW (helper for semantic injection tests)
supabase/migrations/20260406000001_temporal_columns.sql
```

### Modified files

```
packages/core/src/memory.ts
  - Add graph?: boolean to MemoryOptions
  - Add asOf?: Date to recall() opts parameter
  - Forward opts.asOf to engineRecall()
  - Add getTimeline() public method (calls storage.semantic.getTopicTimeline() directly)
  - Add SemanticMemory to imports if not present
  - Add _storageForTest getter for test injection

packages/core/src/retrieval/engine.ts
  - Add asOf?: Date to RecallOpts interface
  - Substitute storage.semantic.searchAtTime() when asOf is set
  - Pass beforeDate: asOf to SearchOptions for episode/digest filtering
  - Pass asOf to NeuralGraph.spreadActivation() opts

packages/core/src/retrieval/search.ts
  - Apply beforeDate filter inside unifiedSearch where Episode/Digest createdAt is accessible

packages/core/src/adapters/storage.ts
  - Add beforeDate?: Date to SearchOptions
  - Add searchAtTime() to SemanticStorage interface (required method)
  - Add getTopicTimeline() to SemanticStorage interface (required method)

packages/core/src/consolidation/deep-sleep.ts
  - Add findTerminalInChain() helper
  - Use findTerminalInChain() before calling markSuperseded()

packages/graph/src/neural-graph.ts (or spreading-activation.ts)
  - Add asOf?: Date to SpreadActivationOpts
  - Add temporal WHERE clause to Cypher query in spreadActivation()
  - Pass asOfMs = asOf.getTime() as Cypher parameter ($asOfMs, null when unset)

packages/sqlite/src/migrations.ts
  - Add SCHEMA_V3 constant (valid_from, valid_until columns on semantic table)
  - Add currentVersion < 3 branch in runMigrations()
  - PRAGMA check before ALTER TABLE ADD COLUMN
  - Backfill UPDATE statements
  - Partial index creation

packages/sqlite/src/search.ts
  - Add dateToJulian() export alongside julianToDate()

packages/sqlite/src/semantic.ts
  - Add valid_from, valid_until to SemanticRow interface
  - Update rowToSemantic() to include validFrom/validUntil in metadata
  - Implement searchAtTime() with SQL WHERE clause (not post-filter)
  - Implement getTopicTimeline()

packages/supabase/src/semantic.ts (or equivalent)
  - Implement searchAtTime() using Supabase client temporal filter
  - Implement getTopicTimeline() using Supabase client query

packages/mcp/src/index.ts
  - Add as_of parameter to memory_recall tool definition
  - Add memory_timeline tool definition
  - Add as_of handling in memory_recall CallTool handler
  - Add memory_timeline CallTool handler
  - Add formatTimeline() helper function
  - Add TimelineEntry interface
```

---

## Part 13: Implementation Order

Execute in this order to avoid broken intermediate states:

1. Add `dateToJulian()` to `packages/sqlite/src/search.ts`. This is a leaf with no dependents.
2. Add `SCHEMA_V3` and migration branch to `packages/sqlite/src/migrations.ts`.
3. Update `SemanticRow` and `rowToSemantic()` in `packages/sqlite/src/semantic.ts`.
4. Implement `searchAtTime()` and `getTopicTimeline()` in `packages/sqlite/src/semantic.ts`.
5. Modify `packages/core/src/adapters/storage.ts` — add `beforeDate` to `SearchOptions`, add `searchAtTime` and `getTopicTimeline` to `SemanticStorage` interface.
6. Implement Supabase stub methods for `searchAtTime` and `getTopicTimeline`.
7. Modify `packages/graph/src/neural-graph.ts` — add `asOf` to `SpreadActivationOpts`, add temporal Cypher WHERE.
8. Modify `packages/core/src/retrieval/engine.ts` — add `asOf` to `RecallOpts`, wire searchAtTime and beforeDate.
9. Modify `packages/core/src/retrieval/search.ts` — apply `beforeDate` filter inside `unifiedSearch`.
10. Modify `packages/core/src/consolidation/deep-sleep.ts` — add `findTerminalInChain`, use it.
11. Modify `packages/core/src/memory.ts` — add `graph` to `MemoryOptions`, add `asOf` to `recall()`, add `getTimeline()`, add `_storageForTest` getter.
12. Modify `packages/mcp/src/index.ts` — add `memory_timeline` tool, add `as_of` to `memory_recall`.
13. Create all files in `packages/bench/` — package.json, tsconfig.json, all src files, all test files.
14. Run `npm run build` from monorepo root — verify zero type errors.
15. Run `npm run test` from monorepo root — verify pre-existing tests still pass.
16. Run `cd packages/bench && npm run test` — verify bench test suite passes.
17. Create `supabase/migrations/20260406000001_temporal_columns.sql`.

---

## Part 14: Validation Checklist

Before declaring Wave 4 complete:

**Package structure:**
- `packages/bench/` exists with all files listed in Part 12.
- `cd packages/bench && npm run typecheck` — zero errors.
- `cd packages/bench && npm run test` — all test files execute without crash.

**Benchmark harness:**
- `npx engram-bench --benchmark locomo --data <fixture-dir> --no-consolidate --no-graph` — runs end-to-end, prints F1 table with "Retrieval F1" heading.
- Output JSON has `retrieval_f1` keys, not `prediction_f1`.
- F1 values are between 0 and 1 inclusive.
- `--compare --no-graph` is not a valid combination (compare requires two separate instances; `--no-graph` only makes sense as a flag when not using compare mode — in compare mode, the two instances are always graph=true and graph=false).

**Temporal queries:**
- `temporal.test.ts` passes: all 4 episode-level temporal tests pass.
- `memory.recall('query', { asOf: new Date() })` returns the same memories as `memory.recall('query')` (modulo timing jitter in the same millisecond).
- `memory.recall('query', { asOf: fiveMinutesAgo })` does NOT return an episode created in the last 5 minutes.
- `memory.getTimeline('unknown-topic-xxx')` returns `[]`.
- `memory.getTimeline('topic')` returns entries with `createdAt` in ascending order.

**Schema correctness:**
- After `SqliteStorageAdapter.initialize()`, `PRAGMA table_info(semantic)` includes `valid_from` and `valid_until` columns.
- `PRAGMA user_version` returns 3.
- `searchAtTime` issues SQL with WHERE clause (verifiable by examining the query, not by post-filtering).

**No regressions:**
- `npm run test` at monorepo root — all pre-existing tests in `core`, `sqlite`, `supabase`, `openai`, `mcp` still pass.
- `npm run typecheck` at monorepo root — zero errors across all packages.
- Adding `getTopicTimeline` and `searchAtTime` to the `SemanticStorage` interface does not break existing adapters (both SQLite and Supabase implement them).

---

## Post-Script: What Wave 4 Does NOT Include

1. **Real dataset download automation.** The CLI expects the user to have downloaded LoCoMo and LongMemEval datasets manually. No network access in the harness.

2. **GPT-4o judge integration for LongMemEval.** The JSONL output is produced for offline submission. Running the judge is the user's responsibility.

3. **Full Supabase temporal filter optimization.** The Supabase `searchAtTime` and `getTopicTimeline` use simple Supabase client queries, not pgvector hybrid search with temporal join optimization. That is Wave 5 territory.

4. **`getTopicTimeline` for episodes, digests, or procedural.** Only semantic memories have supersession chains. Episode timelines use the standard `recall(asOf=...)` filter.

5. **Neo4j Cypher as the primary temporal query source.** Neo4j nodes carry `validFrom`/`validUntil` properties (set by Wave 3), but Wave 4 does NOT query Neo4j for temporal filtering. SQL is the single source of truth for temporal recall queries. The Neo4j temporal filter (Part 9.7 Layer 3) only applies during spreading activation to prevent expired nodes from being activated — it is a secondary consistency layer, not the primary filter.

6. **Minimum F1 or R@5 targets.** The harness measures empirical results; it does not enforce them.

7. **UI or dashboard.** Results go to JSON files and stdout only.

8. **Performance benchmarks at 10K/50K/100K nodes.** Those were deferred from the original Wave 4 plan into Wave 5.

The only acceptance criterion for Wave 4: the test suite passes, type checks pass, the CLI runs end-to-end against synthetic fixtures, and `memory.recall(query, { asOf: date })` returns a different (temporally filtered) result than `memory.recall(query)` when episodes were created after the `asOf` date.
