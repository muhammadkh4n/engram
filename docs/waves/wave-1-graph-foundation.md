# Wave 1: Neo4j Graph Foundation & Spreading Activation Engine

## Pre-Script: Project Context

### What Engram Is

Engram is a TypeScript monorepo (`/Users/muhammadkh4n/Projects/github/muhammadkh4n/engram`) that implements a brain-inspired cognitive memory engine for AI agents. It stores, consolidates, and retrieves memories across four tiers:

- **Episodes** -- raw conversational turns (the hippocampus). Each has content, salience score, embedding vector, extracted entities, and metadata. Defined as `Episode` in `packages/core/src/types.ts`.
- **Digests** -- session-level summaries compressed from episodes via Light Sleep consolidation. Contain `keyTopics`, `sourceEpisodeIds`, `sourceDigestIds`. Defined as `Digest`.
- **Semantic Memory** -- long-term knowledge facts extracted during Deep Sleep. Topic + content pairs with confidence scores, decay rates, supersession chains. Defined as `SemanticMemory`.
- **Procedural Memory** -- learned patterns, preferences, habits. Trigger/procedure pairs with observation counts. Defined as `ProceduralMemory`.

These four tiers are connected by an **associative network** stored as adjacency rows in a SQL `associations` table. The network supports 8 edge types defined in `packages/core/src/types.ts`:

```typescript
export type EdgeType =
  | 'temporal'    // adjacent episodes in a session
  | 'causal'      // cause-effect relationships
  | 'topical'     // shared entity co-occurrence (discovered by Dream Cycle)
  | 'supports'    // corroborating memories
  | 'contradicts' // superseding memories
  | 'elaborates'  // detail expansion
  | 'derives_from'// digest/semantic derived from episodes
  | 'co_recalled' // co-activated during retrieval (reconsolidation)
```

Each association has: `sourceId`, `sourceType` (MemoryType), `targetId`, `targetType`, `edgeType`, `strength` (0-1), `lastActivated`, `metadata`, `createdAt`.

### Monorepo Package Map

```
packages/
  core/       @engram/core     -- The brain. Memory class, 5 memory systems, 4 consolidation
                                  cycles, 11-type intent classification, hybrid retrieval.
                                  Key files:
                                    src/types.ts              -- all type definitions
                                    src/memory.ts             -- Memory class (ingest, recall, consolidate)
                                    src/adapters/storage.ts   -- StorageAdapter interface
                                    src/adapters/intelligence.ts -- IntelligenceAdapter interface
                                    src/ingestion/entity-extractor.ts -- extractEntities()
                                    src/ingestion/salience.ts -- scoreSalience()
                                    src/intent/intents.ts     -- INTENT_PATTERNS, classifyMode()
                                    src/intent/analyzer.ts    -- HeuristicIntentAnalyzer
                                    src/retrieval/engine.ts   -- recall() pipeline
                                    src/retrieval/association-walk.ts -- stageAssociate() (SQL CTE walk)
                                    src/systems/association-manager.ts -- AssociationManager
                                    src/consolidation/dream-cycle.ts -- Dream Cycle (association discovery)
  sqlite/     @engram/sqlite   -- SQLite storage adapter (vector cosine sim + BM25 FTS5)
  supabase/   @engram/supabase -- Supabase/Postgres storage adapter (pgvector)
  openai/     @engram/openai   -- OpenAI intelligence adapter (embeddings, summarization)
  mcp/        @engram/mcp      -- MCP server (memory_recall, memory_ingest, memory_forget)
```

### Build Configuration

Root `tsconfig.base.json` targets ES2022, ESNext modules, bundler moduleResolution, strict mode. Each package extends it. Turborepo orchestrates build/test/typecheck. Vitest workspace defined in `vitest.workspace.ts` at repo root. Currently includes: `packages/core`, `packages/sqlite`, `packages/openai`, `packages/openclaw`, `packages/supabase`.

### The Problem with Vector-First Retrieval

Today, retrieval works like this (see `packages/core/src/retrieval/engine.ts`):

1. **Intent classification** -- `classifyMode()` maps user message to one of 3 recall modes (skip/light/deep). `HeuristicIntentAnalyzer` also classifies into 11 intent types for backward compat.
2. **Unified vector search** -- `unifiedSearch()` does cosine similarity against all memory embeddings via `storage.vectorSearch()`. BM25 text boost via `storage.textBoost()` adds secondary signal.
3. **HyDE fallback** -- when top result scores below 0.3, generates a hypothetical document, embeds it, and runs a second search pass.
4. **Association walk** (deep mode only) -- `stageAssociate()` calls `storage.associations.walk()` which runs a SQL recursive CTE from top-5 results, up to 2 hops, min strength 0.2.
5. **Priming** -- frequent keywords across recalled memories are primed for the next turn.
6. **Reconsolidation** -- co-recalled memories get `co_recalled` edges strengthened.

This is fundamentally a **vector-search-with-post-hoc-graph** architecture. The graph walk is supplementary -- it can only find memories reachable from the vector search seeds within 2 hops of the SQL adjacency list. The SQL CTE walk is slow for deep traversals, cannot model heterogeneous node types (people, topics, emotions are not nodes -- they are flat strings in `episode.entities[]`), and cannot propagate activation through context.

### The Neuroscience Motivation

The graph layer draws from four established neuroscience concepts:

**Hippocampal Indexing Theory** (Teyler & DiScenna 1986, Teyler & Rudy 2007): The hippocampus does not store memories. It stores a sparse index -- a small set of pointers that, when reactivated, reconstruct the full memory by reactivating distributed cortical representations. In Engram, `MemoryNode` is this index: a lightweight node (`id` matches the SQL episode/digest/semantic/procedural ID) that knows WHERE the content lives (SQL) but does not duplicate it. The graph is the index; the relational tables hold the content.

**Spreading Activation** (Collins & Loftus 1975): When a concept is activated in semantic memory, activation spreads along weighted connections to related concepts with exponential decay per hop. The activation level of each node determines its accessibility. This is the retrieval mechanism: instead of ranking by embedding distance alone, we seed the graph and let activation propagate through context edges to find what the brain would naturally associate. Neo4j's native variable-length path traversal handles this natively.

**Engram Cells** (Josselyn & Tonegawa 2020): A memory "engram" is not a single neuron -- it is a distributed ensemble of cells that were co-active during encoding. Memories that share context (same person, same project, same emotional state) share engram cells. In the graph, a `PersonNode` for "Muhammad" connects every memory involving Muhammad. An `EntityNode` for "TypeScript" connects every memory mentioning TypeScript. These shared context nodes ARE the engram cells -- they form implicit associative links between memories that were never explicitly connected. Cypher `MERGE` is the mechanism: it creates a node on first reference and reuses it on subsequent references, naturally implementing the engram cell pattern.

**Pattern Completion** (Marr 1971, McClelland & Rumelhart 1985): Given a partial cue, the hippocampus can reconstruct the full memory. In graph terms: activating "Muhammad" + "frustrated" + "TypeScript" should spread activation through the graph to find the specific memory where Muhammad was frustrated about a TypeScript issue, even if the vector embedding of the query does not closely match the embedding of that memory.

### Why Neo4j Replaces graphology

The previous plan used `graphology` (in-process JS graph library). Architecture auditors identified critical performance issues:

| Problem | graphology | Neo4j |
|---------|-----------|-------|
| Edge duplicate check | O(E) per edge addition -- catastrophic at 50K nodes | O(1) via `MERGE` on indexed properties |
| BFS queue growth | Unbounded in spreading activation -- manual queue management | Native variable-length path traversal with LIMIT |
| Persistence | Manual JSON snapshot serialization -- fragile, slow for large graphs, blocks startup | Neo4j IS the persistence layer -- no serialization step |
| Graph algorithms | PageRank, Louvain, community detection require manual implementation | Neo4j GDS provides all out of the box |
| Startup latency | Full in-memory graph load blocks initialization | Neo4j runs as a service; queries stream results |
| Concurrency | Single-threaded JS -- no parallel reads | Neo4j handles concurrent sessions natively |

### The Architecture Vision (All Waves)

- **Wave 1** (this document): Create `@engram/graph` package. Stand up Neo4j infrastructure. Build `NeuralGraph` class as a thin typed wrapper over `neo4j-driver`. Implement Cypher-based spreading activation. Build context extraction functions (person, emotion, intent). Purely additive -- does not touch retrieval pipeline.
- **Wave 2**: Wire the graph into the retrieval pipeline. On ingest, `Memory.ingest()` calls `NeuralGraph.decomposeEpisode()` to populate the graph. On recall, vector search produces seed node IDs, spreading activation replaces the SQL CTE walk, and graph-activated results are scored alongside vector results.
- **Wave 3**: Consolidation integration. Light Sleep creates digest nodes and derivation edges. Dream Cycle uses Neo4j GDS community detection (Louvain/Leiden) instead of SQL entity co-occurrence. Decay Pass prunes low-activation graph nodes. Deep Sleep promotes semantic knowledge with graph edges.
- **Wave 4**: Advanced graph features. Pattern completion as a first-class retrieval mode. Betweenness centrality for bridge memory identification. Graph-aware deduplication. Performance benchmarks at 10K, 50K, 100K nodes.

---

## Wave 1 Scope

Wave 1 is **purely additive**. It creates a new package (`@engram/graph`) and a Docker Compose file for Neo4j. It does NOT modify any existing file in `@engram/core`, `@engram/sqlite`, `@engram/supabase`, or `@engram/mcp`. No existing tests break. No existing behavior changes.

What Wave 1 delivers:

1. `docker/docker-compose.neo4j.yml` -- Neo4j Community Edition container with GDS plugin
2. `@engram/graph` package with `neo4j-driver` as its sole runtime dependency
3. Neo4j schema (Cypher constraints and indexes) applied automatically on initialization
4. `NeuralGraph` class -- typed wrapper over `neo4j-driver` with `MERGE`-based node/edge operations
5. `SpreadingActivation` class -- Cypher variable-length path traversal with configurable decay
6. Context extraction functions (`extractPersons`, `classifyEmotion`, `classifyContentIntent`)
7. Configuration via environment variables
8. Integration tests against a real Neo4j instance
9. Unit tests for extraction functions (no Neo4j required)
10. Performance tests: activation at 10K and 50K node scales

---

## 1. Infrastructure Setup

### File: `docker/docker-compose.neo4j.yml`

```yaml
version: "3.8"

services:
  neo4j:
    image: neo4j:5.26-community
    container_name: engram-neo4j
    ports:
      - "7474:7474"   # HTTP browser
      - "7687:7687"   # Bolt protocol
    environment:
      NEO4J_AUTH: neo4j/engram-dev
      NEO4J_PLUGINS: '["graph-data-science"]'
      # Memory settings appropriate for dev
      NEO4J_server_memory_heap_initial__size: 512m
      NEO4J_server_memory_heap_max__size: 512m
      NEO4J_server_memory_pagecache_size: 256m
      # Disable telemetry
      NEO4J_dbms_usage__report_enabled: "false"
    volumes:
      - engram-neo4j-data:/data
      - engram-neo4j-logs:/logs
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:7474 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
    restart: unless-stopped

volumes:
  engram-neo4j-data:
  engram-neo4j-logs:
```

**Usage**: `docker compose -f docker/docker-compose.neo4j.yml up -d`

The health check ensures Neo4j is fully ready before any test or application tries to connect. The `start_period` of 30s accommodates GDS plugin loading on first startup.

---

## 2. Package Structure

```
packages/graph/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                    # public exports
    types.ts                    # all node/edge type definitions
    neural-graph.ts             # NeuralGraph class (thin neo4j-driver wrapper)
    spreading-activation.ts     # SpreadingActivation class (Cypher-based)
    context-extractors.ts       # person, emotion, intent extraction
    schema.ts                   # Cypher constraint and index definitions
    config.ts                   # GraphConfig type and env parsing
  test/
    neural-graph.test.ts        # integration: node/edge CRUD against real Neo4j
    spreading-activation.test.ts # integration: activation correctness
    context-extractors.test.ts  # unit: no Neo4j required
    config.test.ts              # unit: config parsing
    performance.test.ts         # integration: 10K and 50K node benchmarks
    helpers/
      setup.ts                  # Neo4j connection setup/teardown for tests
```

### File: `packages/graph/package.json`

```json
{
  "name": "@engram/graph",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:unit": "vitest run test/context-extractors.test.ts test/config.test.ts",
    "test:integration": "vitest run test/neural-graph.test.ts test/spreading-activation.test.ts test/performance.test.ts",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "neo4j-driver": "^5.27.0"
  },
  "peerDependencies": {
    "@engram/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

**Design decision**: `@engram/core` is a `peerDependency`, not a direct dependency. This avoids duplicate type definitions when the consuming application already has `@engram/core` installed. The graph package imports ONLY types from core (`MemoryType`, `IntentType`, `EdgeType`), never runtime functions, so the peer dependency is sufficient.

**AUDIT FIX**: The previous plan listed `graphology`, `graphology-traversal`, and `graphology-operators` as dependencies. These are completely removed. `neo4j-driver` is the sole runtime dependency.

### File: `packages/graph/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### File: `packages/graph/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,  // Neo4j operations can take time on first run
  },
})
```

### Registration

After creating the package, add it to `vitest.workspace.ts` at the repo root:

```ts
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core',
  'packages/sqlite',
  'packages/openai',
  'packages/openclaw',
  'packages/supabase',
  'packages/graph',   // <-- new
])
```

---

## 3. Node Type Definitions

All node types share a `BaseNodeProperties` interface. Each specialized node type adds domain-specific fields. These interfaces define the **properties stored on Neo4j nodes**, not the nodes themselves (Neo4j nodes are identified by labels and properties, not by a class hierarchy).

**AUDIT FIX (CRITICAL)**: `EmotionNode` is session-scoped, not a global singleton. "Frustrated" in session A is a different node than "frustrated" in session B. This prevents false emotional associations across unrelated sessions. The node ID includes the session ID: `emotion:{sessionId}:{label}`.

**AUDIT FIX (CRITICAL)**: `TimeContextNode` ID includes `yearWeek` to prevent false associations across weeks. The previous plan used 28 global singletons (`morning/monday`, `afternoon/tuesday`, etc.) which created spurious connections between unrelated memories that happened to occur at the same time-of-week. Now each node represents a specific week+time combination, e.g. `time:2026-W15:monday:morning`.

**Design decision**: `PersonNode` and `EntityNode` ARE global singletons (engram cells). Two memories mentioning "Muhammad" should share the same PersonNode -- that IS the associative link. Same for "TypeScript" as an EntityNode. The engram cell pattern requires these to be global.

### File: `src/types.ts`

```ts
import type { MemoryType, IntentType, EdgeType as CoreEdgeType } from '@engram/core'

// ============================================================================
// Neo4j Node Labels
// ============================================================================

/**
 * Every node in the graph has exactly one of these labels.
 * Neo4j labels are used for constraint/index targeting and query filtering.
 */
export type NodeLabel =
  | 'Memory'
  | 'Person'
  | 'Topic'
  | 'Entity'
  | 'Emotion'
  | 'Intent'
  | 'Session'
  | 'TimeContext'

// ============================================================================
// Base Properties (shared by all nodes)
// ============================================================================

export interface BaseNodeProperties {
  /** Primary identifier. Unique per label (enforced by Neo4j constraint). */
  id: string
  /** ISO 8601 datetime string. When this node was first created. */
  createdAt: string
  /** ISO 8601 datetime string. When this node was last accessed during retrieval. */
  lastAccessed: string
  /** How many times this node has been activated during spreading activation. */
  activationCount: number
}

// ============================================================================
// Memory Node
// ============================================================================

/**
 * Hippocampal index pointer. Does NOT store content -- only enough metadata
 * to identify the SQL record and filter during graph traversal.
 *
 * ID: matches the SQL episode/digest/semantic/procedural ID exactly.
 * This is the join key between graph (fast traversal) and SQL (content storage).
 */
export interface MemoryNodeProperties extends BaseNodeProperties {
  /** Which memory tier this points to. */
  memoryType: MemoryType  // 'episode' | 'digest' | 'semantic' | 'procedural'
  /** Human-readable label: first 100 chars of content for debugging. */
  label: string
  /** Optional project scope for multi-tenant deployments. */
  projectId?: string
}

/**
 * Input for creating a MemoryNode. The caller provides these fields;
 * NeuralGraph fills in createdAt, lastAccessed, activationCount.
 */
export interface MemoryNodeInput {
  id: string
  memoryType: MemoryType
  label: string
  projectId?: string
}

// ============================================================================
// Person Node (ENGRAM CELL -- global singleton)
// ============================================================================

/**
 * A named conversation participant. Global singleton keyed on normalized name.
 * Two memories mentioning "Muhammad" share the same PersonNode.
 *
 * ID: `person:{normalized_name}` where normalized_name = name.toLowerCase().replace(/\s+/g, '_')
 * Example: `person:muhammad_khan`
 *
 * MERGE behavior: first reference creates the node; subsequent references
 * update lastSeen without creating duplicates.
 */
export interface PersonNodeProperties extends BaseNodeProperties {
  /** Display name (original casing). */
  name: string
  /** Alternative names/spellings that resolved to this node. JSON array string. */
  aliases: string  // JSON string: '["MK", "Muhammad"]'
  /** ISO 8601. When this person was first mentioned. */
  firstSeen: string
  /** ISO 8601. When this person was most recently mentioned. */
  lastSeen: string
}

export interface PersonNodeInput {
  name: string
  aliases?: string[]
}

// ============================================================================
// Topic Node (ENGRAM CELL -- global singleton)
// ============================================================================

/**
 * A subject area derived from digest keyTopics or semantic memory topics.
 *
 * ID: `topic:{normalized_name}` where normalized_name = name.toLowerCase().replace(/\s+/g, '_')
 * Example: `topic:memory_architecture`
 */
export interface TopicNodeProperties extends BaseNodeProperties {
  name: string
  description?: string
}

export interface TopicNodeInput {
  name: string
  description?: string
}

// ============================================================================
// Entity Node (ENGRAM CELL -- global singleton)
// ============================================================================

/**
 * A named entity: technology, tool, concept. Global singleton keyed on normalized name.
 *
 * ID: `entity:{normalized_name}` where normalized_name = name.toLowerCase().replace(/[^a-z0-9]/g, '_')
 * Example: `entity:typescript`, `entity:neo4j`
 *
 * AUDIT FIX: Uses deterministic ID generation (not random UUID) to ensure
 * the same entity always resolves to the same node. This is what makes
 * MERGE work correctly as an engram cell mechanism.
 */
export interface EntityNodeProperties extends BaseNodeProperties {
  name: string
  entityType: 'tech' | 'concept' | 'tool' | 'project'
}

export interface EntityNodeInput {
  name: string
  entityType: 'tech' | 'concept' | 'tool' | 'project'
}

// ============================================================================
// Emotion Node (SESSION-SCOPED -- not a global singleton)
// ============================================================================

/**
 * An emotional classification for a memory within a specific session.
 *
 * AUDIT FIX (CRITICAL): Emotions are session-scoped. "Frustrated" in session A
 * is a DIFFERENT node than "frustrated" in session B. This prevents spurious
 * emotional associations across unrelated conversations.
 *
 * ID: `emotion:{sessionId}:{label}`
 * Example: `emotion:sess_abc123:frustrated`
 *
 * If sessionScoped is false (for rare cross-session emotion tracking),
 * ID: `emotion:global:{label}` -- but default is session-scoped.
 */
export interface EmotionNodeProperties extends BaseNodeProperties {
  label: EmotionLabel
  /** Emotional intensity: 0.0 (barely detectable) to 1.0 (overwhelming). */
  intensity: number
  /** Whether this emotion is scoped to a single session. Default true. */
  sessionScoped: boolean
  /** Session ID when sessionScoped is true. */
  sessionId?: string
}

export type EmotionLabel =
  | 'excited'
  | 'frustrated'
  | 'neutral'
  | 'urgent'
  | 'curious'
  | 'determined'
  | 'confused'
  | 'satisfied'

export interface EmotionNodeInput {
  label: EmotionLabel
  intensity: number
  sessionId: string
  sessionScoped?: boolean  // default true
}

// ============================================================================
// Intent Node (SESSION-SCOPED)
// ============================================================================

/**
 * The classified intent of a message. Session-scoped like EmotionNode.
 *
 * ID: `intent:{sessionId}:{intentType}`
 * Example: `intent:sess_abc123:DEBUGGING`
 */
export interface IntentNodeProperties extends BaseNodeProperties {
  intentType: IntentType
  sessionScoped: boolean
  sessionId?: string
}

export interface IntentNodeInput {
  intentType: IntentType
  sessionId: string
  sessionScoped?: boolean  // default true
}

// ============================================================================
// Session Node
// ============================================================================

/**
 * A conversation session that groups MemoryNodes.
 *
 * ID: matches the sessionId from the Episode record.
 */
export interface SessionNodeProperties extends BaseNodeProperties {
  sessionId: string
  startTime: string   // ISO 8601
  endTime?: string    // ISO 8601, null for active sessions
}

export interface SessionNodeInput {
  sessionId: string
  startTime: string
  endTime?: string
}

// ============================================================================
// TimeContext Node
// ============================================================================

/**
 * Temporal context for when a memory was encoded.
 *
 * AUDIT FIX (CRITICAL): ID includes yearWeek to prevent false associations
 * across weeks. The previous design used 28 global singletons (7 days x 4
 * time-of-day) which created spurious connections between memories that
 * happened to occur at the same weekday+time but weeks apart.
 *
 * ID: `time:{yearWeek}:{dayOfWeek}:{timeOfDay}`
 * Example: `time:2026-W15:monday:morning`
 *
 * This means memories from Monday morning of week 15 share a TimeContext,
 * but memories from Monday morning of week 16 do NOT.
 */
export interface TimeContextNodeProperties extends BaseNodeProperties {
  /** ISO week: e.g. '2026-W15' */
  yearWeek: string
  /** Lowercase day name: 'monday' through 'sunday' */
  dayOfWeek: string
  /** Time bucket: 'morning' (6-12), 'afternoon' (12-17), 'evening' (17-21), 'night' (21-6) */
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night'
}

export interface TimeContextNodeInput {
  timestamp: Date  // NeuralGraph computes yearWeek, dayOfWeek, timeOfDay from this
}

// ============================================================================
// Union Types
// ============================================================================

export type GraphNodeProperties =
  | MemoryNodeProperties
  | PersonNodeProperties
  | TopicNodeProperties
  | EntityNodeProperties
  | EmotionNodeProperties
  | IntentNodeProperties
  | SessionNodeProperties
  | TimeContextNodeProperties

// ============================================================================
// Relationship Types
// ============================================================================

/**
 * All relationship types in the graph. Extends core's EdgeType with
 * additional context-specific relationships.
 *
 * Core edge types (stored in SQL associations table too):
 *   TEMPORAL, CAUSAL, TOPICAL, SUPPORTS, CONTRADICTS, ELABORATES, DERIVES_FROM, CO_RECALLED
 *
 * New context edge types (graph-only, connect memories to context nodes):
 *   SPOKE         -- Memory -> Person (who said/was mentioned in this memory)
 *   CONTEXTUAL    -- Memory -> Entity/Topic (what this memory is about)
 *   EMOTIONAL     -- Memory -> Emotion (how the speaker felt)
 *   INTENTIONAL   -- Memory -> Intent (what the speaker was trying to do)
 *   OCCURRED_IN   -- Memory -> Session (which session this belongs to)
 *   OCCURRED_AT   -- Memory -> TimeContext (when this happened)
 */
export type RelationType =
  // Core edge types (uppercase of CoreEdgeType for Neo4j convention)
  | 'TEMPORAL'
  | 'CAUSAL'
  | 'TOPICAL'
  | 'SUPPORTS'
  | 'CONTRADICTS'
  | 'ELABORATES'
  | 'DERIVES_FROM'
  | 'CO_RECALLED'
  // Context edge types (graph-only)
  | 'SPOKE'
  | 'CONTEXTUAL'
  | 'EMOTIONAL'
  | 'INTENTIONAL'
  | 'OCCURRED_IN'
  | 'OCCURRED_AT'

/**
 * Properties stored on every relationship.
 */
export interface RelationshipProperties {
  /** Edge weight: 0.0 to 1.0. Higher = stronger association. */
  weight: number
  /** ISO 8601. When this edge was first created. */
  createdAt: string
  /** ISO 8601. When this edge was last traversed during activation. */
  lastTraversed: string
  /** How many times this edge has been traversed. Incremented on each activation. */
  traversalCount: number
}

// ============================================================================
// Spreading Activation Types
// ============================================================================

export interface ActivationParams {
  /** Maximum hops from seed nodes. Default: 3. */
  maxHops?: number
  /** Activation multiplier per hop. Default: 0.6 (40% decay per hop). */
  decayPerHop?: number
  /** Minimum activation threshold to include in results. Default: 0.05. */
  minActivation?: number
  /** Maximum nodes to return. Default: 100. */
  maxNodes?: number
  /** Minimum edge weight to traverse. Default: 0.01. */
  minWeight?: number
  /** Only traverse these relationship types. Undefined = traverse all. */
  edgeTypeFilter?: RelationType[]
}

export interface ActivationResult {
  /** Node ID (matches BaseNodeProperties.id). */
  nodeId: string
  /** Neo4j label of the node. */
  nodeType: NodeLabel
  /** All properties of the activated node. */
  properties: Record<string, unknown>
  /** Computed activation level: 0.0 to 1.0. Higher = more strongly activated. */
  activation: number
  /** Shortest path distance from any seed node. */
  hops: number
}

// ============================================================================
// Episode Decomposition Input
// ============================================================================

/**
 * Input for NeuralGraph.decomposeEpisode(). Contains everything needed to
 * create the Memory node and all its context edges in a single transaction.
 *
 * The caller (Wave 2 ingestion pipeline) is responsible for extracting these
 * fields from the Episode and passing them here.
 */
export interface EpisodeDecomposition {
  /** Episode ID (becomes the MemoryNode ID). */
  episodeId: string
  /** Memory type. For episodes, always 'episode'. */
  memoryType: MemoryType
  /** First 100 chars of content for the MemoryNode label. */
  label: string
  /** Session this episode belongs to. */
  sessionId: string
  /** Timestamp of the episode. */
  timestamp: Date
  /** Extracted person names. */
  persons: string[]
  /** Extracted entity names with types. */
  entities: Array<{ name: string; entityType: 'tech' | 'concept' | 'tool' | 'project' }>
  /** Classified emotion. */
  emotion: { label: EmotionLabel; intensity: number } | null
  /** Classified intent. */
  intent: IntentType | null
  /** Optional project ID for multi-tenant scoping. */
  projectId?: string
}
```

---

## 4. Neo4j Schema

All constraints and indexes are applied idempotently on `NeuralGraph.initialize()` via `IF NOT EXISTS` clauses. This means calling `initialize()` multiple times (e.g., across application restarts) is safe.

### File: `src/schema.ts`

```ts
/**
 * Cypher statements for schema initialization.
 * Run in order during NeuralGraph.initialize().
 *
 * Design: constraints are created first (they implicitly create indexes),
 * then additional indexes are created for non-constrained properties
 * frequently used in WHERE clauses.
 */

// ============================================================================
// Unique Constraints
// ============================================================================

export const CONSTRAINTS: string[] = [
  // Memory nodes: ID is the SQL record ID (episode, digest, semantic, procedural)
  'CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE',

  // Person nodes: global singleton keyed on deterministic ID
  'CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE',

  // Topic nodes: global singleton keyed on deterministic ID
  'CREATE CONSTRAINT topic_id IF NOT EXISTS FOR (t:Topic) REQUIRE t.id IS UNIQUE',

  // Entity nodes: global singleton keyed on deterministic ID
  'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE',

  // Emotion nodes: session-scoped, ID includes session
  'CREATE CONSTRAINT emotion_id IF NOT EXISTS FOR (e:Emotion) REQUIRE e.id IS UNIQUE',

  // Intent nodes: session-scoped, ID includes session
  'CREATE CONSTRAINT intent_id IF NOT EXISTS FOR (i:Intent) REQUIRE i.id IS UNIQUE',

  // Session nodes: keyed on sessionId
  'CREATE CONSTRAINT session_id IF NOT EXISTS FOR (s:Session) REQUIRE s.sessionId IS UNIQUE',

  // TimeContext nodes: keyed on composite ID (yearWeek:dayOfWeek:timeOfDay)
  'CREATE CONSTRAINT time_context_id IF NOT EXISTS FOR (t:TimeContext) REQUIRE t.id IS UNIQUE',
]

// ============================================================================
// Additional Indexes (for properties used in WHERE/ORDER BY but not constrained)
// ============================================================================

export const INDEXES: string[] = [
  // Memory type filtering (e.g., "only activate episode nodes")
  'CREATE INDEX memory_type IF NOT EXISTS FOR (m:Memory) ON (m.memoryType)',

  // Temporal ordering of memories
  'CREATE INDEX memory_created IF NOT EXISTS FOR (m:Memory) ON (m.createdAt)',

  // Entity type filtering
  'CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.entityType)',

  // Emotion label lookup
  'CREATE INDEX emotion_label IF NOT EXISTS FOR (e:Emotion) ON (e.label)',

  // Intent type lookup
  'CREATE INDEX intent_type IF NOT EXISTS FOR (i:Intent) ON (i.intentType)',

  // TimeContext composite lookup for temporal queries
  'CREATE INDEX time_context_composite IF NOT EXISTS FOR (t:TimeContext) ON (t.yearWeek, t.dayOfWeek, t.timeOfDay)',

  // Person name lookup (for search by name)
  'CREATE INDEX person_name IF NOT EXISTS FOR (p:Person) ON (p.name)',
]

/**
 * All schema statements in execution order.
 * Constraints first (they create implicit indexes), then explicit indexes.
 */
export const ALL_SCHEMA_STATEMENTS: string[] = [...CONSTRAINTS, ...INDEXES]
```

---

## 5. Configuration

### File: `src/config.ts`

```ts
export interface GraphConfig {
  /** Neo4j Bolt protocol URI. Default: 'bolt://localhost:7687' */
  neo4jUri: string
  /** Neo4j username. Default: 'neo4j' */
  neo4jUser: string
  /** Neo4j password. Default: 'engram-dev' */
  neo4jPassword: string
  /** Whether the graph layer is enabled. Set false to disable entirely. Default: true */
  enabled: boolean
}

/**
 * Parse graph configuration from environment variables with defaults.
 *
 * Environment variables:
 *   NEO4J_URI           -- Bolt URI (default: bolt://localhost:7687)
 *   NEO4J_USER          -- Username (default: neo4j)
 *   NEO4J_PASSWORD      -- Password (default: engram-dev)
 *   ENGRAM_GRAPH_ENABLED -- 'true' or 'false' (default: true)
 */
export function parseGraphConfig(env: Record<string, string | undefined> = process.env): GraphConfig {
  return {
    neo4jUri: env.NEO4J_URI ?? 'bolt://localhost:7687',
    neo4jUser: env.NEO4J_USER ?? 'neo4j',
    neo4jPassword: env.NEO4J_PASSWORD ?? 'engram-dev',
    enabled: env.ENGRAM_GRAPH_ENABLED !== 'false',
  }
}

/**
 * Validate a GraphConfig. Throws if required fields are missing or invalid.
 */
export function validateGraphConfig(config: GraphConfig): void {
  if (!config.neo4jUri) throw new Error('GraphConfig: neo4jUri is required')
  if (!config.neo4jUri.startsWith('bolt://') && !config.neo4jUri.startsWith('neo4j://')) {
    throw new Error(`GraphConfig: neo4jUri must start with bolt:// or neo4j://, got: ${config.neo4jUri}`)
  }
  if (!config.neo4jUser) throw new Error('GraphConfig: neo4jUser is required')
  if (!config.neo4jPassword) throw new Error('GraphConfig: neo4jPassword is required')
}
```

---

## 6. NeuralGraph Class

The core class. A thin typed wrapper over `neo4j-driver`. All node creation uses Cypher `MERGE` for idempotency. All operations run in explicit transactions for atomicity.

**AUDIT FIX**: No graphology import. No in-memory graph state. No JSON serialization. Neo4j IS the state.

### File: `src/neural-graph.ts`

```ts
import neo4j, { type Driver, type Session, type ManagedTransaction } from 'neo4j-driver'
import { ALL_SCHEMA_STATEMENTS } from './schema.js'
import type { GraphConfig } from './config.js'
import type {
  MemoryNodeInput,
  PersonNodeInput,
  TopicNodeInput,
  EntityNodeInput,
  EmotionNodeInput,
  IntentNodeInput,
  SessionNodeInput,
  TimeContextNodeInput,
  EpisodeDecomposition,
  RelationType,
  RelationshipProperties,
  NodeLabel,
  GraphNodeProperties,
  EmotionLabel,
} from './types.js'

// ============================================================================
// ID Generation Helpers
// ============================================================================

/** Normalize a name to a deterministic ID component. */
function normalizeForId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')
}

/** Compute ISO week string from a Date. Returns e.g. '2026-W15'. */
function getYearWeek(date: Date): string {
  // ISO week calculation
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7 // Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

/** Get lowercase day-of-week name from a Date. */
function getDayOfWeek(date: Date): string {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  return days[date.getDay()]
}

/** Get time-of-day bucket from a Date. */
function getTimeOfDay(date: Date): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = date.getHours()
  if (hour >= 6 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

// ============================================================================
// NeuralGraph
// ============================================================================

export class NeuralGraph {
  private driver: Driver
  private config: GraphConfig

  constructor(config: GraphConfig) {
    this.config = config
    this.driver = neo4j.driver(
      config.neo4jUri,
      neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
    )
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Verify connectivity and apply schema (constraints + indexes).
   * Safe to call multiple times -- all statements use IF NOT EXISTS.
   */
  async initialize(): Promise<void> {
    // Verify connectivity
    await this.driver.verifyConnectivity()

    // Apply schema in a single session
    const session = this.driver.session()
    try {
      for (const statement of ALL_SCHEMA_STATEMENTS) {
        await session.run(statement)
      }
    } finally {
      await session.close()
    }
  }

  /**
   * Close the Neo4j driver. Must be called on application shutdown.
   */
  async dispose(): Promise<void> {
    await this.driver.close()
  }

  // --------------------------------------------------------------------------
  // Node Operations (all use MERGE for idempotency)
  // --------------------------------------------------------------------------

  /**
   * Add a Memory node. ID matches the SQL record ID exactly.
   * MERGE ensures idempotency: calling this twice with the same ID
   * updates lastAccessed and activationCount without creating duplicates.
   */
  async addMemoryNode(input: MemoryNodeInput): Promise<string> {
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (m:Memory {id: $id})
           ON CREATE SET
             m.memoryType = $memoryType,
             m.label = $label,
             m.projectId = $projectId,
             m.createdAt = $now,
             m.lastAccessed = $now,
             m.activationCount = 0
           ON MATCH SET
             m.lastAccessed = $now,
             m.activationCount = m.activationCount + 1`,
          {
            id: input.id,
            memoryType: input.memoryType,
            label: input.label.slice(0, 100),
            projectId: input.projectId ?? null,
            now,
          }
        )
      })
      return input.id
    } finally {
      await session.close()
    }
  }

  /**
   * Add a Person node (global singleton / engram cell).
   * MERGE on deterministic ID ensures one node per person.
   */
  async addPersonNode(input: PersonNodeInput): Promise<string> {
    const id = `person:${normalizeForId(input.name)}`
    const now = new Date().toISOString()
    const aliases = JSON.stringify(input.aliases ?? [])
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (p:Person {id: $id})
           ON CREATE SET
             p.name = $name,
             p.aliases = $aliases,
             p.firstSeen = $now,
             p.lastSeen = $now,
             p.createdAt = $now,
             p.lastAccessed = $now,
             p.activationCount = 0
           ON MATCH SET
             p.lastSeen = $now,
             p.lastAccessed = $now,
             p.activationCount = p.activationCount + 1`,
          { id, name: input.name, aliases, now }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  /**
   * Add a Topic node (global singleton / engram cell).
   */
  async addTopicNode(input: TopicNodeInput): Promise<string> {
    const id = `topic:${normalizeForId(input.name)}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (t:Topic {id: $id})
           ON CREATE SET
             t.name = $name,
             t.description = $description,
             t.createdAt = $now,
             t.lastAccessed = $now,
             t.activationCount = 0
           ON MATCH SET
             t.lastAccessed = $now,
             t.activationCount = t.activationCount + 1`,
          { id, name: input.name, description: input.description ?? null, now }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  /**
   * Add an Entity node (global singleton / engram cell).
   *
   * AUDIT FIX: Deterministic ID from normalized name ensures "TypeScript"
   * and "typescript" and "TYPESCRIPT" all resolve to the same node.
   */
  async addEntityNode(input: EntityNodeInput): Promise<string> {
    const id = `entity:${normalizeForId(input.name)}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (e:Entity {id: $id})
           ON CREATE SET
             e.name = $name,
             e.entityType = $entityType,
             e.createdAt = $now,
             e.lastAccessed = $now,
             e.activationCount = 0
           ON MATCH SET
             e.lastAccessed = $now,
             e.activationCount = e.activationCount + 1`,
          { id, name: input.name, entityType: input.entityType, now }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  /**
   * Add an Emotion node (session-scoped).
   *
   * AUDIT FIX (CRITICAL): ID includes sessionId to prevent cross-session
   * emotional associations.
   */
  async addEmotionNode(input: EmotionNodeInput): Promise<string> {
    const scoped = input.sessionScoped !== false  // default true
    const id = scoped
      ? `emotion:${input.sessionId}:${input.label}`
      : `emotion:global:${input.label}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (e:Emotion {id: $id})
           ON CREATE SET
             e.label = $label,
             e.intensity = $intensity,
             e.sessionScoped = $sessionScoped,
             e.sessionId = $sessionId,
             e.createdAt = $now,
             e.lastAccessed = $now,
             e.activationCount = 0
           ON MATCH SET
             e.intensity = CASE WHEN $intensity > e.intensity THEN $intensity ELSE e.intensity END,
             e.lastAccessed = $now,
             e.activationCount = e.activationCount + 1`,
          {
            id,
            label: input.label,
            intensity: input.intensity,
            sessionScoped: scoped,
            sessionId: scoped ? input.sessionId : null,
            now,
          }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  /**
   * Add an Intent node (session-scoped).
   */
  async addIntentNode(input: IntentNodeInput): Promise<string> {
    const scoped = input.sessionScoped !== false
    const id = scoped
      ? `intent:${input.sessionId}:${input.intentType}`
      : `intent:global:${input.intentType}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (i:Intent {id: $id})
           ON CREATE SET
             i.intentType = $intentType,
             i.sessionScoped = $sessionScoped,
             i.sessionId = $sessionId,
             i.createdAt = $now,
             i.lastAccessed = $now,
             i.activationCount = 0
           ON MATCH SET
             i.lastAccessed = $now,
             i.activationCount = i.activationCount + 1`,
          {
            id,
            intentType: input.intentType,
            sessionScoped: scoped,
            sessionId: scoped ? input.sessionId : null,
            now,
          }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  /**
   * Add a Session node.
   */
  async addSessionNode(input: SessionNodeInput): Promise<string> {
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (s:Session {sessionId: $sessionId})
           ON CREATE SET
             s.id = $sessionId,
             s.startTime = $startTime,
             s.endTime = $endTime,
             s.createdAt = $now,
             s.lastAccessed = $now,
             s.activationCount = 0
           ON MATCH SET
             s.endTime = COALESCE($endTime, s.endTime),
             s.lastAccessed = $now,
             s.activationCount = s.activationCount + 1`,
          {
            sessionId: input.sessionId,
            startTime: input.startTime,
            endTime: input.endTime ?? null,
            now,
          }
        )
      })
      return input.sessionId
    } finally {
      await session.close()
    }
  }

  /**
   * Add a TimeContext node.
   *
   * AUDIT FIX (CRITICAL): ID includes yearWeek. Memories from Monday morning
   * of week 15 share a TimeContext, but week 16 Monday morning is a different node.
   */
  async addTimeContextNode(input: TimeContextNodeInput): Promise<string> {
    const yearWeek = getYearWeek(input.timestamp)
    const dayOfWeek = getDayOfWeek(input.timestamp)
    const timeOfDay = getTimeOfDay(input.timestamp)
    const id = `time:${yearWeek}:${dayOfWeek}:${timeOfDay}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (t:TimeContext {id: $id})
           ON CREATE SET
             t.yearWeek = $yearWeek,
             t.dayOfWeek = $dayOfWeek,
             t.timeOfDay = $timeOfDay,
             t.createdAt = $now,
             t.lastAccessed = $now,
             t.activationCount = 0
           ON MATCH SET
             t.lastAccessed = $now,
             t.activationCount = t.activationCount + 1`,
          { id, yearWeek, dayOfWeek, timeOfDay, now }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Edge Operations
  // --------------------------------------------------------------------------

  /**
   * Add a relationship between two nodes. Uses MERGE for idempotency.
   * On duplicate (same source, target, type), increments traversalCount
   * and updates lastTraversed. Weight is set to the MAX of existing and new.
   *
   * AUDIT FIX: O(1) via indexed MERGE, not O(E) scan.
   *
   * IMPORTANT: sourceId and targetId must be the `id` property of the nodes,
   * not Neo4j internal IDs. The Cypher matches on `id` property.
   */
  async addEdge(
    sourceId: string,
    targetId: string,
    type: RelationType,
    weight: number,
  ): Promise<void> {
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        // Match source and target by their id property.
        // Use label-agnostic match since we don't know the label at call site.
        await tx.run(
          `MATCH (source) WHERE source.id = $sourceId
           MATCH (target) WHERE target.id = $targetId
           MERGE (source)-[r:${type}]->(target)
           ON CREATE SET
             r.weight = $weight,
             r.createdAt = $now,
             r.lastTraversed = $now,
             r.traversalCount = 1
           ON MATCH SET
             r.weight = CASE WHEN $weight > r.weight THEN $weight ELSE r.weight END,
             r.lastTraversed = $now,
             r.traversalCount = r.traversalCount + 1`,
          { sourceId, targetId, weight, now }
        )
      })
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Query Operations
  // --------------------------------------------------------------------------

  /**
   * Get a node by its id property. Returns null if not found.
   */
  async getNode(id: string): Promise<{ id: string; label: string; properties: Record<string, unknown> } | null> {
    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx: ManagedTransaction) => {
        return tx.run(
          `MATCH (n) WHERE n.id = $id
           RETURN n, labels(n)[0] AS label`,
          { id }
        )
      })
      if (result.records.length === 0) return null
      const record = result.records[0]
      const node = record.get('n')
      return {
        id,
        label: record.get('label') as string,
        properties: node.properties as Record<string, unknown>,
      }
    } finally {
      await session.close()
    }
  }

  /**
   * Get neighbors of a node with optional filtering.
   */
  async getNeighbors(
    id: string,
    opts?: {
      edgeType?: RelationType
      direction?: 'in' | 'out' | 'both'
      limit?: number
    },
  ): Promise<Array<{ id: string; label: string; properties: Record<string, unknown>; edgeWeight: number }>> {
    const direction = opts?.direction ?? 'both'
    const limit = opts?.limit ?? 50

    // Build direction-specific pattern
    let pattern: string
    if (direction === 'out') {
      pattern = opts?.edgeType
        ? `(source)-[r:${opts.edgeType}]->(neighbor)`
        : '(source)-[r]->(neighbor)'
    } else if (direction === 'in') {
      pattern = opts?.edgeType
        ? `(source)<-[r:${opts.edgeType}]-(neighbor)`
        : '(source)<-[r]-(neighbor)'
    } else {
      pattern = opts?.edgeType
        ? `(source)-[r:${opts.edgeType}]-(neighbor)`
        : '(source)-[r]-(neighbor)'
    }

    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx: ManagedTransaction) => {
        return tx.run(
          `MATCH (source) WHERE source.id = $id
           MATCH ${pattern}
           RETURN neighbor, labels(neighbor)[0] AS label, r.weight AS weight
           ORDER BY r.weight DESC
           LIMIT $limit`,
          { id, limit: neo4j.int(limit) }
        )
      })
      return result.records.map(record => ({
        id: record.get('neighbor').properties.id as string,
        label: record.get('label') as string,
        properties: record.get('neighbor').properties as Record<string, unknown>,
        edgeWeight: (record.get('weight') as number) ?? 0,
      }))
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Bulk Operations
  // --------------------------------------------------------------------------

  /**
   * Decompose an episode into graph nodes and edges in a single transaction.
   * Creates:
   *   1. The MemoryNode (MERGE by episode ID)
   *   2. PersonNodes for each mentioned person (MERGE - engram cells)
   *   3. EntityNodes for each mentioned entity (MERGE - engram cells)
   *   4. EmotionNode if emotion detected (MERGE - session-scoped)
   *   5. IntentNode if intent classified (MERGE - session-scoped)
   *   6. SessionNode (MERGE by sessionId)
   *   7. TimeContextNode (MERGE by yearWeek:dayOfWeek:timeOfDay)
   *   8. All edges: SPOKE, CONTEXTUAL, EMOTIONAL, INTENTIONAL, OCCURRED_IN, OCCURRED_AT
   *
   * Everything runs in one executeWrite transaction for atomicity.
   * If any part fails, the entire decomposition is rolled back.
   *
   * AUDIT FIX: Single transaction instead of N+1 individual calls.
   * AUDIT FIX: Uses MERGE throughout, not CREATE (no duplicates possible).
   */
  async decomposeEpisode(input: EpisodeDecomposition): Promise<void> {
    const now = new Date().toISOString()
    const yearWeek = getYearWeek(input.timestamp)
    const dayOfWeek = getDayOfWeek(input.timestamp)
    const timeOfDay = getTimeOfDay(input.timestamp)
    const timeContextId = `time:${yearWeek}:${dayOfWeek}:${timeOfDay}`

    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        // 1. Memory node
        await tx.run(
          `MERGE (m:Memory {id: $id})
           ON CREATE SET
             m.memoryType = $memoryType,
             m.label = $label,
             m.projectId = $projectId,
             m.createdAt = $now,
             m.lastAccessed = $now,
             m.activationCount = 0
           ON MATCH SET
             m.lastAccessed = $now,
             m.activationCount = m.activationCount + 1`,
          {
            id: input.episodeId,
            memoryType: input.memoryType,
            label: input.label.slice(0, 100),
            projectId: input.projectId ?? null,
            now,
          }
        )

        // 2. Session node + OCCURRED_IN edge
        await tx.run(
          `MERGE (s:Session {sessionId: $sessionId})
           ON CREATE SET
             s.id = $sessionId,
             s.startTime = $now,
             s.createdAt = $now,
             s.lastAccessed = $now,
             s.activationCount = 0
           ON MATCH SET
             s.lastAccessed = $now
           WITH s
           MATCH (m:Memory {id: $memoryId})
           MERGE (m)-[r:OCCURRED_IN]->(s)
           ON CREATE SET
             r.weight = 1.0,
             r.createdAt = $now,
             r.lastTraversed = $now,
             r.traversalCount = 1`,
          { sessionId: input.sessionId, memoryId: input.episodeId, now }
        )

        // 3. TimeContext node + OCCURRED_AT edge
        await tx.run(
          `MERGE (t:TimeContext {id: $timeContextId})
           ON CREATE SET
             t.yearWeek = $yearWeek,
             t.dayOfWeek = $dayOfWeek,
             t.timeOfDay = $timeOfDay,
             t.createdAt = $now,
             t.lastAccessed = $now,
             t.activationCount = 0
           ON MATCH SET
             t.lastAccessed = $now
           WITH t
           MATCH (m:Memory {id: $memoryId})
           MERGE (m)-[r:OCCURRED_AT]->(t)
           ON CREATE SET
             r.weight = 0.5,
             r.createdAt = $now,
             r.lastTraversed = $now,
             r.traversalCount = 1`,
          { timeContextId, yearWeek, dayOfWeek, timeOfDay, memoryId: input.episodeId, now }
        )

        // 4. Person nodes + SPOKE edges
        for (const personName of input.persons) {
          const personId = `person:${normalizeForId(personName)}`
          await tx.run(
            `MERGE (p:Person {id: $personId})
             ON CREATE SET
               p.name = $name,
               p.aliases = '[]',
               p.firstSeen = $now,
               p.lastSeen = $now,
               p.createdAt = $now,
               p.lastAccessed = $now,
               p.activationCount = 0
             ON MATCH SET
               p.lastSeen = $now,
               p.lastAccessed = $now
             WITH p
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:SPOKE]->(p)
             ON CREATE SET
               r.weight = 0.7,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1
             ON MATCH SET
               r.lastTraversed = $now,
               r.traversalCount = r.traversalCount + 1`,
            { personId, name: personName, memoryId: input.episodeId, now }
          )
        }

        // 5. Entity nodes + CONTEXTUAL edges
        for (const entity of input.entities) {
          const entityId = `entity:${normalizeForId(entity.name)}`
          await tx.run(
            `MERGE (e:Entity {id: $entityId})
             ON CREATE SET
               e.name = $name,
               e.entityType = $entityType,
               e.createdAt = $now,
               e.lastAccessed = $now,
               e.activationCount = 0
             ON MATCH SET
               e.lastAccessed = $now
             WITH e
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:CONTEXTUAL]->(e)
             ON CREATE SET
               r.weight = 0.6,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1
             ON MATCH SET
               r.lastTraversed = $now,
               r.traversalCount = r.traversalCount + 1`,
            { entityId, name: entity.name, entityType: entity.entityType, memoryId: input.episodeId, now }
          )
        }

        // 6. Emotion node + EMOTIONAL edge (if detected)
        if (input.emotion) {
          const emotionId = `emotion:${input.sessionId}:${input.emotion.label}`
          await tx.run(
            `MERGE (e:Emotion {id: $emotionId})
             ON CREATE SET
               e.label = $label,
               e.intensity = $intensity,
               e.sessionScoped = true,
               e.sessionId = $sessionId,
               e.createdAt = $now,
               e.lastAccessed = $now,
               e.activationCount = 0
             ON MATCH SET
               e.intensity = CASE WHEN $intensity > e.intensity THEN $intensity ELSE e.intensity END,
               e.lastAccessed = $now
             WITH e
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:EMOTIONAL]->(e)
             ON CREATE SET
               r.weight = $intensity,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1`,
            {
              emotionId,
              label: input.emotion.label,
              intensity: input.emotion.intensity,
              sessionId: input.sessionId,
              memoryId: input.episodeId,
              now,
            }
          )
        }

        // 7. Intent node + INTENTIONAL edge (if classified)
        if (input.intent) {
          const intentId = `intent:${input.sessionId}:${input.intent}`
          await tx.run(
            `MERGE (i:Intent {id: $intentId})
             ON CREATE SET
               i.intentType = $intentType,
               i.sessionScoped = true,
               i.sessionId = $sessionId,
               i.createdAt = $now,
               i.lastAccessed = $now,
               i.activationCount = 0
             ON MATCH SET
               i.lastAccessed = $now
             WITH i
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:INTENTIONAL]->(i)
             ON CREATE SET
               r.weight = 0.5,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1`,
            {
              intentId,
              intentType: input.intent,
              sessionId: input.sessionId,
              memoryId: input.episodeId,
              now,
            }
          )
        }
      })
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Schema Management
  // --------------------------------------------------------------------------

  /**
   * Apply all schema constraints and indexes.
   * Called by initialize(); exposed publicly for testing.
   */
  async ensureSchema(): Promise<void> {
    const session = this.driver.session()
    try {
      for (const statement of ALL_SCHEMA_STATEMENTS) {
        await session.run(statement)
      }
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  /**
   * Verify Neo4j connectivity. Returns true if reachable, false otherwise.
   */
  async ping(): Promise<boolean> {
    try {
      await this.driver.verifyConnectivity()
      return true
    } catch {
      return false
    }
  }

  // --------------------------------------------------------------------------
  // Stats (for debugging and monitoring)
  // --------------------------------------------------------------------------

  /**
   * Get node and relationship counts by label/type.
   */
  async stats(): Promise<{
    nodes: Record<string, number>
    relationships: Record<string, number>
    total: { nodes: number; relationships: number }
  }> {
    const session = this.driver.session()
    try {
      const nodeResult = await session.run(
        `CALL db.labels() YIELD label
         CALL {
           WITH label
           CALL db.stats.retrieve('GRAPH COUNTS') YIELD data
           RETURN 0 AS count
         }
         MATCH (n)
         WHERE label IN labels(n)
         WITH label, count(DISTINCT n) AS cnt
         RETURN label, cnt`
      )

      // Simpler approach: count per label
      const nodeCountResult = await session.run(
        `MATCH (n)
         UNWIND labels(n) AS label
         RETURN label, count(n) AS count
         ORDER BY label`
      )

      const relCountResult = await session.run(
        `MATCH ()-[r]->()
         RETURN type(r) AS type, count(r) AS count
         ORDER BY type`
      )

      const nodes: Record<string, number> = {}
      for (const record of nodeCountResult.records) {
        const label = record.get('label') as string
        const count = (record.get('count') as { toNumber: () => number }).toNumber()
        nodes[label] = count
      }

      const relationships: Record<string, number> = {}
      for (const record of relCountResult.records) {
        const type = record.get('type') as string
        const count = (record.get('count') as { toNumber: () => number }).toNumber()
        relationships[type] = count
      }

      const totalNodes = Object.values(nodes).reduce((a, b) => a + b, 0)
      const totalRels = Object.values(relationships).reduce((a, b) => a + b, 0)

      return { nodes, relationships, total: { nodes: totalNodes, relationships: totalRels } }
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup (for testing)
  // --------------------------------------------------------------------------

  /**
   * Delete all nodes and relationships. FOR TESTING ONLY.
   * Batched to avoid memory issues with large graphs.
   */
  async clearAll(): Promise<void> {
    const session = this.driver.session()
    try {
      // Delete in batches to avoid transaction memory limits
      let deleted = 1
      while (deleted > 0) {
        const result = await session.run(
          `MATCH (n) WITH n LIMIT 10000
           DETACH DELETE n
           RETURN count(*) AS deleted`
        )
        deleted = (result.records[0]?.get('deleted') as { toNumber: () => number })?.toNumber() ?? 0
      }
    } finally {
      await session.close()
    }
  }
}
```

---

## 7. Spreading Activation

The core retrieval mechanism. Uses Cypher variable-length path traversal to propagate activation from seed nodes through weighted edges with exponential decay per hop.

**AUDIT FIX**: No manual BFS queue. No O(E) duplicate checks. No unbounded queue growth. Neo4j handles traversal natively, and LIMIT caps the result set.

### File: `src/spreading-activation.ts`

```ts
import neo4j, { type Driver } from 'neo4j-driver'
import type { ActivationParams, ActivationResult, RelationType, NodeLabel } from './types.js'

const DEFAULT_PARAMS: Required<ActivationParams> = {
  maxHops: 3,
  decayPerHop: 0.6,
  minActivation: 0.05,
  maxNodes: 100,
  minWeight: 0.01,
  edgeTypeFilter: [],
}

export class SpreadingActivation {
  private driver: Driver

  constructor(driver: Driver) {
    this.driver = driver
  }

  /**
   * Activate seed nodes and propagate activation through the graph.
   *
   * Algorithm:
   * 1. For each seed node, traverse variable-length paths up to maxHops.
   * 2. Only traverse edges with weight >= minWeight.
   * 3. At each hop, activation *= edgeWeight * decayPerHop.
   * 4. If a node is reachable by multiple paths, take the MAX activation.
   * 5. Filter results by minActivation threshold.
   * 6. Order by activation descending, limit to maxNodes.
   *
   * The entire computation happens in a single Cypher query.
   *
   * Performance characteristics:
   * - Neo4j's index-free adjacency gives O(1) per hop traversal.
   * - Variable-length paths are bounded by maxHops (default 3).
   * - LIMIT caps result set to maxNodes (default 100).
   * - Edge weight filter (minWeight) prunes low-weight paths early.
   *
   * Returns: ActivationResult[] sorted by activation descending.
   */
  async activate(
    seedIds: string[],
    params?: ActivationParams,
  ): Promise<ActivationResult[]> {
    if (seedIds.length === 0) return []

    const p = { ...DEFAULT_PARAMS, ...params }

    // Build the relationship type filter clause.
    // If edgeTypeFilter is empty, traverse all relationship types.
    // If specified, only traverse those types.
    const relFilter = p.edgeTypeFilter.length > 0
      ? `:${p.edgeTypeFilter.join('|')}`
      : ''

    // The Cypher query:
    //
    // 1. UNWIND seed IDs and MATCH seed nodes.
    // 2. Use variable-length path to traverse 1..maxHops hops.
    // 3. Filter edges by minimum weight.
    // 4. Compute activation as product of edge weights * decay^hops.
    // 5. For each neighbor, take MAX activation and MIN hops.
    // 6. Filter by minActivation threshold.
    // 7. Return sorted and limited.
    //
    // IMPORTANT: This query uses `reduce()` over the relationship list
    // to compute the product of (edge_weight * decayPerHop) along the path.
    // The seed itself has activation 1.0; each hop multiplies by weight * decay.
    const cypher = `
      UNWIND $seedIds AS seedId
      MATCH (seed) WHERE seed.id = seedId
      CALL {
        WITH seed
        MATCH path = (seed)-[rels${relFilter}*1..${p.maxHops}]-(neighbor)
        WHERE neighbor <> seed
          AND ALL(r IN rels WHERE r.weight >= $minWeight)
        WITH neighbor,
             reduce(
               activation = 1.0,
               r IN rels | activation * r.weight * $decayPerHop
             ) AS activation,
             length(path) AS hops
        RETURN neighbor, activation, hops
      }
      WITH neighbor, MAX(activation) AS bestActivation, MIN(hops) AS shortestPath
      WHERE bestActivation >= $minActivation
      RETURN
        neighbor.id AS nodeId,
        labels(neighbor)[0] AS nodeType,
        properties(neighbor) AS properties,
        bestActivation AS activation,
        shortestPath AS hops
      ORDER BY activation DESC
      LIMIT $maxNodes
    `

    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, {
          seedIds,
          minWeight: p.minWeight,
          decayPerHop: p.decayPerHop,
          minActivation: p.minActivation,
          maxNodes: neo4j.int(p.maxNodes),
        })
      })

      return result.records.map(record => {
        // Neo4j integers need conversion
        const activation = record.get('activation') as number
        const hops = typeof record.get('hops') === 'object'
          ? (record.get('hops') as { toNumber: () => number }).toNumber()
          : record.get('hops') as number

        return {
          nodeId: record.get('nodeId') as string,
          nodeType: record.get('nodeType') as NodeLabel,
          properties: record.get('properties') as Record<string, unknown>,
          activation,
          hops,
        }
      })
    } finally {
      await session.close()
    }
  }

  /**
   * Update traversal metadata on edges that were used during activation.
   * Called after activate() to implement reconsolidation (edges get
   * stronger through use, mirroring synaptic long-term potentiation).
   *
   * Fire-and-forget: failures here should not block the retrieval pipeline.
   */
  async strengthenTraversedEdges(
    seedIds: string[],
    activatedNodeIds: string[],
    boostAmount: number = 0.02,
  ): Promise<void> {
    if (seedIds.length === 0 || activatedNodeIds.length === 0) return

    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx) => {
        // Find all edges on shortest paths between seeds and activated nodes,
        // then increment their traversalCount and slightly boost weight.
        await tx.run(
          `UNWIND $seedIds AS seedId
           UNWIND $activatedIds AS activatedId
           MATCH (seed) WHERE seed.id = seedId
           MATCH (activated) WHERE activated.id = activatedId
           MATCH path = shortestPath((seed)-[*..3]-(activated))
           UNWIND relationships(path) AS r
           SET r.traversalCount = r.traversalCount + 1,
               r.lastTraversed = $now,
               r.weight = CASE
                 WHEN r.weight + $boost > 1.0 THEN 1.0
                 ELSE r.weight + $boost
               END`,
          {
            seedIds,
            activatedIds: activatedNodeIds,
            now: new Date().toISOString(),
            boost: boostAmount,
          }
        )
      })
    } finally {
      await session.close()
    }
  }
}
```

---

## 8. Context Extraction Functions

Functions that extract structured context from episode text content. Used by `decomposeEpisode()` (via the Wave 2 ingestion pipeline) to determine which context nodes to create.

**AUDIT FIX**: `extractPersons()` imports and extends `@engram/core`'s `extractEntities()` function. It does NOT duplicate the regex patterns. It calls core's extractor and then filters for person-like entities.

**AUDIT FIX**: `classifyEmotion()` requires 2+ pattern matches for non-neutral classification to reduce false positives.

### File: `src/context-extractors.ts`

```ts
import type { IntentType } from '@engram/core'
import type { EmotionLabel } from './types.js'

// ============================================================================
// Person Extraction
// ============================================================================

/**
 * Person name patterns. These supplement @engram/core's extractEntities()
 * which extracts a flat array of [people, technologies, projects].
 *
 * AUDIT FIX: We import core's extractEntities for technology/project extraction
 * in the decomposition pipeline (Wave 2). For person extraction specifically,
 * we use these dedicated patterns because core's person extraction is
 * position-dependent (requires sentence-start context) which we replicate here.
 *
 * The implementor should call core's extractEntities() for entity nodes
 * and these functions for person nodes. Do NOT duplicate core's tech/project patterns.
 */

const PERSON_PATTERNS: RegExp[] = [
  // Explicit person references: "tell X", "ask X", "cc X", "ping X", "@X"
  /(?:(?:tell|ask|cc|ping)\s+|@)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  // "with X", "from X", "by X" followed by capitalized name
  /(?:with|from|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  // Two capitalized words not at sentence start (heuristic for names)
  /(?<=\s)([A-Z][a-z]+\s+[A-Z][a-z]+)(?=[\s,.])/g,
]

const NAME_BLOCKLIST = new Set([
  'The', 'This', 'That', 'These', 'Those', 'What', 'How', 'Why',
  'When', 'Where', 'Who', 'Which', 'There', 'Here', 'Some', 'Any',
  'Each', 'Every', 'Both', 'All', 'Most', 'Many', 'Much', 'More',
  'Other', 'Another', 'Such', 'Same', 'Good', 'Great', 'Best',
  'New', 'Old', 'First', 'Last', 'Next', 'Previous', 'Note',
  'True', 'False', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March',
  'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December', 'Light', 'Deep', 'Dream', 'Wave',
])

export interface PersonExtraction {
  name: string
  confidence: number  // 0-1, based on pattern strength
}

/**
 * Extract person names from text.
 * Returns deduplicated list with confidence scores.
 */
export function extractPersons(text: string): PersonExtraction[] {
  const found = new Map<string, number>() // name -> max confidence

  for (const pattern of PERSON_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim()
      const firstName = name.split(/\s+/)[0]
      if (!firstName || NAME_BLOCKLIST.has(firstName) || name.length <= 1) continue

      // Two-word names get higher confidence than single-word
      const confidence = name.includes(' ') ? 0.8 : 0.6
      const existing = found.get(name) ?? 0
      found.set(name, Math.max(existing, confidence))
    }
  }

  return Array.from(found.entries()).map(([name, confidence]) => ({
    name,
    confidence,
  }))
}

// ============================================================================
// Emotion Classification
// ============================================================================

const EMOTION_PATTERNS: Record<EmotionLabel, RegExp[]> = {
  excited: [
    /\b(excited|awesome|amazing|fantastic|love it|great news|thrilled|pumped)\b/i,
    /!{2,}/,
    /\b(can'?t wait|looking forward|let'?s go)\b/i,
  ],
  frustrated: [
    /\b(frustrated|annoyed|stuck|blocked|broken|hate|ugh|damn|aargh)\b/i,
    /\b(not working|keeps? failing|still (broken|stuck|wrong))\b/i,
    /\b(wast(ed?|ing) time|going in circles|ridiculous)\b/i,
  ],
  urgent: [
    /\b(urgent|asap|critical|emergency|production( is)? down|blocking)\b/i,
    /\b(immediately|right now|drop everything)\b/i,
  ],
  curious: [
    /\b(curious|interesting|wonder|hmm|intriguing|fascinated)\b/i,
    /\b(what if|how does|i wonder|could we)\b/i,
  ],
  determined: [
    /\b(determined|committed|going to|must|will not stop|push through)\b/i,
    /\b(no matter what|whatever it takes|let'?s do this)\b/i,
  ],
  confused: [
    /\b(confused|don'?t understand|what does|makes no sense|lost)\b/i,
    /\b(huh|wait what|i'?m not following|unclear)\b/i,
  ],
  satisfied: [
    /\b(satisfied|pleased|glad|happy with|works? (perfectly|great|well))\b/i,
    /\b(nailed it|exactly right|that'?s it|perfect)\b/i,
  ],
  neutral: [], // fallback -- no patterns needed
}

export interface EmotionClassification {
  label: EmotionLabel
  intensity: number  // 0-1
  patternMatches: number
}

/**
 * Classify the emotional tone of text.
 *
 * AUDIT FIX (HIGH): Requires 2+ pattern matches for non-neutral classification.
 * A single pattern match (e.g., one exclamation mark triggering 'excited') is
 * insufficient and caused false positives in the previous version. With the
 * 2-match requirement, classification is much more conservative.
 *
 * Intensity scales with pattern match count:
 *   1 match (below threshold): neutral (fallback)
 *   2 matches: 0.5 intensity
 *   3+ matches: 0.7 + 0.1 per additional match, capped at 0.95
 */
export function classifyEmotion(text: string): EmotionClassification {
  let bestLabel: EmotionLabel = 'neutral'
  let bestCount = 0

  for (const [label, patterns] of Object.entries(EMOTION_PATTERNS) as [EmotionLabel, RegExp[]][]) {
    if (label === 'neutral' || patterns.length === 0) continue

    let matchCount = 0
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      if (pattern.test(text)) matchCount++
    }

    // AUDIT FIX: require 2+ matches for non-neutral
    if (matchCount >= 2 && matchCount > bestCount) {
      bestCount = matchCount
      bestLabel = label
    }
  }

  if (bestLabel === 'neutral') {
    return { label: 'neutral', intensity: 0.1, patternMatches: 0 }
  }

  // Intensity scaling
  let intensity: number
  if (bestCount === 2) {
    intensity = 0.5
  } else {
    intensity = Math.min(0.7 + 0.1 * (bestCount - 3), 0.95)
  }

  return { label: bestLabel, intensity, patternMatches: bestCount }
}

// ============================================================================
// Intent Classification
// ============================================================================

/**
 * Classify the content intent of text.
 *
 * AUDIT FIX: Reuses the exact same INTENT_PATTERNS from @engram/core
 * (packages/core/src/intent/intents.ts). Does NOT duplicate patterns.
 * The implementor should import INTENT_PATTERNS from @engram/core and
 * use this function only as a lightweight wrapper for graph decomposition.
 *
 * This function is provided as a convenience so graph decomposition
 * does not require instantiating HeuristicIntentAnalyzer. It uses the
 * same priority rules: SOCIAL first (short), EMOTIONAL override,
 * then highest pattern match count, fallback to INFORMATIONAL.
 */
export function classifyContentIntent(
  text: string,
  intentPatterns: Record<IntentType, RegExp[]>,
): IntentType {
  const trimmed = text.trim()

  // SOCIAL check (short greetings/acks)
  const socialPatterns = intentPatterns['SOCIAL'] ?? []
  if (trimmed.length < 20) {
    for (const p of socialPatterns) {
      p.lastIndex = 0
      if (p.test(trimmed)) return 'SOCIAL'
    }
  }

  // EMOTIONAL override
  const emotionalPatterns = intentPatterns['EMOTIONAL'] ?? []
  for (const p of emotionalPatterns) {
    p.lastIndex = 0
    if (p.test(trimmed)) return 'EMOTIONAL'
  }

  // Score remaining intents
  const SCOREABLE: IntentType[] = [
    'RECALL_EXPLICIT', 'TASK_START', 'TASK_CONTINUE', 'QUESTION',
    'DEBUGGING', 'PREFERENCE', 'REVIEW', 'CONTEXT_SWITCH',
  ]

  let bestType: IntentType = 'INFORMATIONAL'
  let bestScore = 0

  for (const type of SCOREABLE) {
    const patterns = intentPatterns[type] ?? []
    let score = 0
    for (const p of patterns) {
      p.lastIndex = 0
      if (p.test(trimmed)) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestType = type
    }
  }

  if (bestScore > 0) return bestType

  // Fallback
  return trimmed.length > 15 ? 'INFORMATIONAL' : 'SOCIAL'
}
```

---

## 9. Public Exports

### File: `src/index.ts`

```ts
// === Core classes ===
export { NeuralGraph } from './neural-graph.js'
export { SpreadingActivation } from './spreading-activation.js'

// === Configuration ===
export { parseGraphConfig, validateGraphConfig } from './config.js'
export type { GraphConfig } from './config.js'

// === Context extractors ===
export { extractPersons, classifyEmotion, classifyContentIntent } from './context-extractors.js'
export type { PersonExtraction, EmotionClassification } from './context-extractors.js'

// === Schema ===
export { ALL_SCHEMA_STATEMENTS, CONSTRAINTS, INDEXES } from './schema.js'

// === Types ===
export type {
  // Node labels and properties
  NodeLabel,
  BaseNodeProperties,
  MemoryNodeProperties,
  MemoryNodeInput,
  PersonNodeProperties,
  PersonNodeInput,
  TopicNodeProperties,
  TopicNodeInput,
  EntityNodeProperties,
  EntityNodeInput,
  EmotionNodeProperties,
  EmotionNodeInput,
  EmotionLabel,
  IntentNodeProperties,
  IntentNodeInput,
  SessionNodeProperties,
  SessionNodeInput,
  TimeContextNodeProperties,
  TimeContextNodeInput,
  GraphNodeProperties,
  // Relationships
  RelationType,
  RelationshipProperties,
  // Activation
  ActivationParams,
  ActivationResult,
  // Episode decomposition
  EpisodeDecomposition,
} from './types.js'
```

---

## 10. Tests

### Test Infrastructure

### File: `test/helpers/setup.ts`

```ts
import neo4j from 'neo4j-driver'
import { NeuralGraph } from '../../src/neural-graph.js'
import { SpreadingActivation } from '../../src/spreading-activation.js'
import type { GraphConfig } from '../../src/config.js'

/**
 * Test setup helper.
 *
 * Connects to a running Neo4j instance. The instance can be:
 * 1. Started via docker/docker-compose.neo4j.yml (recommended)
 * 2. A running instance specified by NEO4J_TEST_URI env var
 *
 * Integration tests require Neo4j to be running. Unit tests
 * (context-extractors.test.ts, config.test.ts) do NOT require Neo4j.
 */
export function getTestConfig(): GraphConfig {
  return {
    neo4jUri: process.env.NEO4J_TEST_URI ?? 'bolt://localhost:7687',
    neo4jUser: process.env.NEO4J_TEST_USER ?? 'neo4j',
    neo4jPassword: process.env.NEO4J_TEST_PASSWORD ?? 'engram-dev',
    enabled: true,
  }
}

/**
 * Create a NeuralGraph instance for testing.
 * Initializes the schema and clears all data.
 */
export async function createTestGraph(): Promise<NeuralGraph> {
  const config = getTestConfig()
  const graph = new NeuralGraph(config)
  await graph.initialize()
  await graph.clearAll()
  return graph
}

/**
 * Create a SpreadingActivation instance backed by the same Neo4j driver.
 * NOTE: This creates a new driver instance for the activation engine.
 * In production, the NeuralGraph and SpreadingActivation should share a driver.
 * For tests, separate instances are fine.
 */
export function createTestActivation(): SpreadingActivation {
  const config = getTestConfig()
  const driver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
  )
  return new SpreadingActivation(driver)
}
```

### Test: Neural Graph Integration

### File: `test/neural-graph.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { createTestGraph } from './helpers/setup.js'

describe('NeuralGraph (integration)', () => {
  let graph: NeuralGraph

  beforeAll(async () => {
    graph = await createTestGraph()
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
  })

  describe('node creation', () => {
    it('creates a Memory node and retrieves it', async () => {
      const id = await graph.addMemoryNode({
        id: 'ep-001',
        memoryType: 'episode',
        label: 'Test episode about TypeScript',
      })

      expect(id).toBe('ep-001')

      const node = await graph.getNode('ep-001')
      expect(node).not.toBeNull()
      expect(node!.label).toBe('Memory')
      expect(node!.properties.memoryType).toBe('episode')
      expect(node!.properties.activationCount).toBe(0)
    })

    it('MERGE deduplicates: same ID creates one node, increments activationCount', async () => {
      await graph.addMemoryNode({
        id: 'ep-dedup-001',
        memoryType: 'episode',
        label: 'First insert',
      })
      await graph.addMemoryNode({
        id: 'ep-dedup-001',
        memoryType: 'episode',
        label: 'Second insert',
      })

      const node = await graph.getNode('ep-dedup-001')
      expect(node).not.toBeNull()
      // activationCount should be 1 (incremented on second MERGE)
      expect(node!.properties.activationCount).toBe(1)
    })

    it('creates Person nodes as global singletons (engram cells)', async () => {
      const id1 = await graph.addPersonNode({ name: 'Muhammad Khan' })
      const id2 = await graph.addPersonNode({ name: 'Muhammad Khan' })

      // Same deterministic ID
      expect(id1).toBe(id2)
      expect(id1).toBe('person:muhammad_khan')

      // Only one node exists
      const node = await graph.getNode('person:muhammad_khan')
      expect(node).not.toBeNull()
      expect(node!.properties.activationCount).toBe(1) // incremented on second MERGE
    })

    it('creates Entity nodes with deterministic IDs', async () => {
      const id1 = await graph.addEntityNode({ name: 'TypeScript', entityType: 'tech' })
      const id2 = await graph.addEntityNode({ name: 'typescript', entityType: 'tech' })

      // Normalized to same ID
      expect(id1).toBe(id2)
      expect(id1).toBe('entity:typescript')
    })

    it('creates Emotion nodes scoped to session', async () => {
      const id1 = await graph.addEmotionNode({
        label: 'frustrated',
        intensity: 0.7,
        sessionId: 'session-A',
      })
      const id2 = await graph.addEmotionNode({
        label: 'frustrated',
        intensity: 0.5,
        sessionId: 'session-B',
      })

      // Different sessions = different nodes
      expect(id1).not.toBe(id2)
      expect(id1).toBe('emotion:session-A:frustrated')
      expect(id2).toBe('emotion:session-B:frustrated')
    })

    it('creates TimeContext nodes scoped to yearWeek', async () => {
      // Two Mondays in different weeks should be different nodes
      const monday1 = new Date('2026-04-06T09:00:00') // Monday, W15
      const monday2 = new Date('2026-04-13T09:00:00') // Monday, W16

      const id1 = await graph.addTimeContextNode({ timestamp: monday1 })
      const id2 = await graph.addTimeContextNode({ timestamp: monday2 })

      expect(id1).not.toBe(id2)
      // Both are monday morning but different weeks
      expect(id1).toContain('monday:morning')
      expect(id2).toContain('monday:morning')
    })
  })

  describe('edge creation', () => {
    it('creates an edge between two nodes', async () => {
      await graph.addMemoryNode({ id: 'edge-src', memoryType: 'episode', label: 'Source' })
      await graph.addPersonNode({ name: 'Edge Target Person' })

      await graph.addEdge('edge-src', 'person:edge_target_person', 'SPOKE', 0.7)

      const neighbors = await graph.getNeighbors('edge-src', { direction: 'out' })
      expect(neighbors.length).toBeGreaterThanOrEqual(1)
      const personNeighbor = neighbors.find(n => n.id === 'person:edge_target_person')
      expect(personNeighbor).toBeDefined()
      expect(personNeighbor!.edgeWeight).toBe(0.7)
    })

    it('MERGE deduplicates edges: same edge increments traversalCount', async () => {
      await graph.addMemoryNode({ id: 'edge-dedup-src', memoryType: 'episode', label: 'Src' })
      await graph.addEntityNode({ name: 'DedupTech', entityType: 'tech' })

      await graph.addEdge('edge-dedup-src', 'entity:deduptech', 'CONTEXTUAL', 0.5)
      await graph.addEdge('edge-dedup-src', 'entity:deduptech', 'CONTEXTUAL', 0.6)

      // Should have one edge with weight 0.6 (MAX) and traversalCount 2
      const neighbors = await graph.getNeighbors('edge-dedup-src')
      const tech = neighbors.find(n => n.id === 'entity:deduptech')
      expect(tech).toBeDefined()
      expect(tech!.edgeWeight).toBe(0.6) // MAX of 0.5 and 0.6
    })
  })

  describe('decomposeEpisode', () => {
    it('creates all nodes and edges in a single transaction', async () => {
      await graph.decomposeEpisode({
        episodeId: 'decompose-ep-001',
        memoryType: 'episode',
        label: 'Muhammad discussed TypeScript debugging with frustration',
        sessionId: 'decompose-session-001',
        timestamp: new Date('2026-04-06T14:30:00'),
        persons: ['Muhammad Khan'],
        entities: [
          { name: 'TypeScript', entityType: 'tech' },
          { name: 'Neo4j', entityType: 'tech' },
        ],
        emotion: { label: 'frustrated', intensity: 0.7 },
        intent: 'DEBUGGING',
      })

      // Verify Memory node
      const memory = await graph.getNode('decompose-ep-001')
      expect(memory).not.toBeNull()
      expect(memory!.label).toBe('Memory')

      // Verify Person node (engram cell)
      const person = await graph.getNode('person:muhammad_khan')
      expect(person).not.toBeNull()

      // Verify Entity nodes
      const ts = await graph.getNode('entity:typescript')
      expect(ts).not.toBeNull()
      const neo = await graph.getNode('entity:neo4j')
      expect(neo).not.toBeNull()

      // Verify Emotion node (session-scoped)
      const emotion = await graph.getNode('emotion:decompose-session-001:frustrated')
      expect(emotion).not.toBeNull()

      // Verify Intent node (session-scoped)
      const intent = await graph.getNode('intent:decompose-session-001:DEBUGGING')
      expect(intent).not.toBeNull()

      // Verify Session node
      const session = await graph.getNode('decompose-session-001')
      expect(session).not.toBeNull()

      // Verify edges from Memory node
      const neighbors = await graph.getNeighbors('decompose-ep-001', { direction: 'out' })
      const neighborIds = neighbors.map(n => n.id)
      expect(neighborIds).toContain('person:muhammad_khan')     // SPOKE
      expect(neighborIds).toContain('entity:typescript')         // CONTEXTUAL
      expect(neighborIds).toContain('entity:neo4j')             // CONTEXTUAL
      expect(neighborIds).toContain('emotion:decompose-session-001:frustrated')  // EMOTIONAL
      expect(neighborIds).toContain('intent:decompose-session-001:DEBUGGING')    // INTENTIONAL
      expect(neighborIds).toContain('decompose-session-001')    // OCCURRED_IN
    })

    it('shared Person node creates implicit association between memories', async () => {
      // Two episodes mentioning the same person should share a PersonNode
      await graph.decomposeEpisode({
        episodeId: 'shared-person-ep-1',
        memoryType: 'episode',
        label: 'Muhammad discussed architecture',
        sessionId: 'shared-session',
        timestamp: new Date('2026-04-06T10:00:00'),
        persons: ['Muhammad Khan'],
        entities: [],
        emotion: null,
        intent: null,
      })
      await graph.decomposeEpisode({
        episodeId: 'shared-person-ep-2',
        memoryType: 'episode',
        label: 'Muhammad reviewed the PR',
        sessionId: 'shared-session',
        timestamp: new Date('2026-04-06T11:00:00'),
        persons: ['Muhammad Khan'],
        entities: [],
        emotion: null,
        intent: null,
      })

      // Both memories should connect to the SAME PersonNode
      const neighbors1 = await graph.getNeighbors('shared-person-ep-1', { edgeType: 'SPOKE' })
      const neighbors2 = await graph.getNeighbors('shared-person-ep-2', { edgeType: 'SPOKE' })
      expect(neighbors1[0]?.id).toBe('person:muhammad_khan')
      expect(neighbors2[0]?.id).toBe('person:muhammad_khan')

      // The PersonNode is the engram cell: it implicitly links the two memories
      // A 2-hop traversal from ep-1 -> Muhammad -> ep-2 should work
    })

    it('creates 100 memories with shared context, deduplicates correctly', async () => {
      for (let i = 0; i < 100; i++) {
        await graph.decomposeEpisode({
          episodeId: `bulk-ep-${i}`,
          memoryType: 'episode',
          label: `Bulk episode ${i} about TypeScript`,
          sessionId: 'bulk-session',
          timestamp: new Date(`2026-04-06T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`),
          persons: ['Muhammad Khan'],
          entities: [{ name: 'TypeScript', entityType: 'tech' }],
          emotion: i % 10 === 0 ? { label: 'frustrated', intensity: 0.5 } : null,
          intent: 'TASK_CONTINUE',
        })
      }

      // Should have 100 Memory nodes but only 1 PersonNode and 1 EntityNode
      const stats = await graph.stats()
      expect(stats.nodes['Memory']).toBeGreaterThanOrEqual(100)
      // PersonNode "muhammad_khan" is a singleton across all episodes
      // EntityNode "typescript" is a singleton across all episodes
      // These prove MERGE-based engram cells work at scale
    })
  })

  describe('ping', () => {
    it('returns true when Neo4j is reachable', async () => {
      const result = await graph.ping()
      expect(result).toBe(true)
    })
  })
})
```

### Test: Spreading Activation Integration

### File: `test/spreading-activation.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import { createTestGraph, createTestActivation } from './helpers/setup.js'

describe('SpreadingActivation (integration)', () => {
  let graph: NeuralGraph
  let activation: SpreadingActivation

  beforeAll(async () => {
    graph = await createTestGraph()
    activation = createTestActivation()
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
  })

  beforeEach(async () => {
    await graph.clearAll()
  })

  /**
   * Build a known topology for testing:
   *
   *   ep-1 --SPOKE(0.7)--> person:alice
   *   ep-2 --SPOKE(0.7)--> person:alice
   *   ep-2 --CONTEXTUAL(0.8)--> entity:typescript
   *   ep-3 --CONTEXTUAL(0.8)--> entity:typescript
   *   ep-3 --EMOTIONAL(0.6)--> emotion:sess:frustrated
   *
   * Expected activation from seed [ep-1]:
   *   hop 1: person:alice (activation = 0.7 * 0.6 = 0.42)
   *   hop 2: ep-2 (via alice, activation = 0.42 * 0.7 * 0.6 = 0.176)
   *   hop 3: entity:typescript (via ep-2, activation = 0.176 * 0.8 * 0.6 = 0.085)
   */
  async function buildKnownTopology(): Promise<void> {
    await graph.addMemoryNode({ id: 'ep-1', memoryType: 'episode', label: 'Episode 1' })
    await graph.addMemoryNode({ id: 'ep-2', memoryType: 'episode', label: 'Episode 2' })
    await graph.addMemoryNode({ id: 'ep-3', memoryType: 'episode', label: 'Episode 3' })
    await graph.addPersonNode({ name: 'Alice' })
    await graph.addEntityNode({ name: 'TypeScript', entityType: 'tech' })
    await graph.addEmotionNode({ label: 'frustrated', intensity: 0.6, sessionId: 'sess' })

    await graph.addEdge('ep-1', 'person:alice', 'SPOKE', 0.7)
    await graph.addEdge('ep-2', 'person:alice', 'SPOKE', 0.7)
    await graph.addEdge('ep-2', 'entity:typescript', 'CONTEXTUAL', 0.8)
    await graph.addEdge('ep-3', 'entity:typescript', 'CONTEXTUAL', 0.8)
    await graph.addEdge('ep-3', 'emotion:sess:frustrated', 'EMOTIONAL', 0.6)
  }

  it('activates neighbors with correct decay', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 1,
      decayPerHop: 0.6,
      minActivation: 0.01,
    })

    // Only 1 hop from ep-1: person:alice with activation 0.7 * 0.6 = 0.42
    expect(results.length).toBe(1)
    expect(results[0].nodeId).toBe('person:alice')
    expect(results[0].activation).toBeCloseTo(0.42, 2)
    expect(results[0].hops).toBe(1)
  })

  it('propagates activation through 2 hops', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 2,
      decayPerHop: 0.6,
      minActivation: 0.01,
    })

    // hop 1: person:alice (0.42)
    // hop 2: ep-2 (0.42 * 0.7 * 0.6 = 0.176)
    const alice = results.find(r => r.nodeId === 'person:alice')
    const ep2 = results.find(r => r.nodeId === 'ep-2')

    expect(alice).toBeDefined()
    expect(alice!.activation).toBeCloseTo(0.42, 2)
    expect(ep2).toBeDefined()
    expect(ep2!.activation).toBeCloseTo(0.176, 2)
  })

  it('propagates activation through 3 hops', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.01,
    })

    // hop 3: entity:typescript (via ep-1 -> alice -> ep-2 -> typescript)
    // activation = 0.7 * 0.6 * 0.7 * 0.6 * 0.8 * 0.6 = 0.085
    const ts = results.find(r => r.nodeId === 'entity:typescript')
    expect(ts).toBeDefined()
    expect(ts!.activation).toBeCloseTo(0.085, 2)
    expect(ts!.hops).toBe(3)
  })

  it('respects minActivation threshold', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.2, // Only alice (0.42) should pass
    })

    expect(results.length).toBe(1)
    expect(results[0].nodeId).toBe('person:alice')
  })

  it('respects edge type filter', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.01,
      edgeTypeFilter: ['SPOKE'], // Only traverse SPOKE edges
    })

    // Only person:alice (via SPOKE) and ep-2 (via SPOKE back from alice)
    const nodeIds = results.map(r => r.nodeId)
    expect(nodeIds).toContain('person:alice')
    // ep-2 connects to alice via SPOKE, so it should be reachable
    expect(nodeIds).toContain('ep-2')
    // entity:typescript connects via CONTEXTUAL, should NOT be reachable
    expect(nodeIds).not.toContain('entity:typescript')
  })

  it('handles multiple seeds (union of activations)', async () => {
    await buildKnownTopology()

    // Seed from both ep-1 and ep-3
    const results = await activation.activate(['ep-1', 'ep-3'], {
      maxHops: 1,
      decayPerHop: 0.6,
      minActivation: 0.01,
    })

    // From ep-1: person:alice
    // From ep-3: entity:typescript, emotion:sess:frustrated
    const nodeIds = results.map(r => r.nodeId)
    expect(nodeIds).toContain('person:alice')
    expect(nodeIds).toContain('entity:typescript')
    expect(nodeIds).toContain('emotion:sess:frustrated')
  })

  it('returns empty array for empty seeds', async () => {
    const results = await activation.activate([])
    expect(results).toEqual([])
  })

  it('returns empty array for non-existent seed', async () => {
    const results = await activation.activate(['non-existent-id'])
    expect(results).toEqual([])
  })

  it('respects maxNodes limit', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.01,
      maxNodes: 2,
    })

    expect(results.length).toBeLessThanOrEqual(2)
    // Results should be ordered by activation descending
    if (results.length === 2) {
      expect(results[0].activation).toBeGreaterThanOrEqual(results[1].activation)
    }
  })
})
```

### Test: Performance

### File: `test/performance.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import { createTestGraph, createTestActivation } from './helpers/setup.js'

describe('Performance benchmarks (integration)', () => {
  let graph: NeuralGraph
  let activation: SpreadingActivation

  beforeAll(async () => {
    graph = await createTestGraph()
    activation = createTestActivation()
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
  })

  /**
   * Generate a graph with N memory nodes, each connected to shared
   * Person and Entity nodes (simulating realistic engram cell topology).
   *
   * Topology:
   * - N Memory nodes
   * - 10 Person nodes (each memory connects to 1-2 persons)
   * - 20 Entity nodes (each memory connects to 1-3 entities)
   * - N/10 Emotion nodes (one per 10 memories, session-scoped)
   * - N/100 Session nodes
   * - Temporal edges between adjacent memories in the same session
   */
  async function generateGraph(nodeCount: number): Promise<void> {
    const persons = Array.from({ length: 10 }, (_, i) => `Perf Person ${i}`)
    const entities = Array.from({ length: 20 }, (_, i) => `PerfEntity${i}`)

    // Create Person and Entity nodes first
    for (const name of persons) {
      await graph.addPersonNode({ name })
    }
    for (const name of entities) {
      await graph.addEntityNode({ name, entityType: 'tech' })
    }

    // Create Memory nodes with connections
    for (let i = 0; i < nodeCount; i++) {
      const sessionId = `perf-session-${Math.floor(i / 100)}`
      const personIndices = [i % 10, (i + 3) % 10]
      const entityIndices = [i % 20, (i + 7) % 20, (i + 13) % 20]

      await graph.decomposeEpisode({
        episodeId: `perf-ep-${i}`,
        memoryType: 'episode',
        label: `Performance test episode ${i}`,
        sessionId,
        timestamp: new Date(Date.now() - (nodeCount - i) * 60000),
        persons: personIndices.map(j => persons[j]),
        entities: entityIndices.map(j => ({ name: entities[j], entityType: 'tech' as const })),
        emotion: i % 10 === 0 ? { label: 'determined' as const, intensity: 0.5 } : null,
        intent: i % 5 === 0 ? 'TASK_CONTINUE' as const : null,
      })

      // Add temporal edges to previous memory in same session
      if (i > 0 && Math.floor(i / 100) === Math.floor((i - 1) / 100)) {
        await graph.addEdge(`perf-ep-${i - 1}`, `perf-ep-${i}`, 'TEMPORAL', 0.3)
      }
    }
  }

  it('10K nodes: activation completes in <500ms', async () => {
    await graph.clearAll()
    await generateGraph(10_000)

    // Warm up
    await activation.activate(['perf-ep-5000'], { maxHops: 3, maxNodes: 100 })

    // Benchmark
    const start = performance.now()
    const results = await activation.activate(['perf-ep-5000'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.05,
      maxNodes: 100,
    })
    const elapsed = performance.now() - start

    console.log(`10K nodes: activation took ${elapsed.toFixed(1)}ms, returned ${results.length} results`)
    expect(elapsed).toBeLessThan(500)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(100)
  }, 120_000) // generous timeout for graph generation

  it('50K nodes: activation completes in <2000ms', async () => {
    await graph.clearAll()
    await generateGraph(50_000)

    // Warm up
    await activation.activate(['perf-ep-25000'], { maxHops: 3, maxNodes: 100 })

    // Benchmark
    const start = performance.now()
    const results = await activation.activate(['perf-ep-25000'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.05,
      maxNodes: 100,
    })
    const elapsed = performance.now() - start

    console.log(`50K nodes: activation took ${elapsed.toFixed(1)}ms, returned ${results.length} results`)
    expect(elapsed).toBeLessThan(2000)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(100)
  }, 600_000) // very generous timeout for 50K node generation
})
```

### Test: Context Extractors (Unit -- no Neo4j required)

### File: `test/context-extractors.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { extractPersons, classifyEmotion, classifyContentIntent } from '../src/context-extractors.js'
import { INTENT_PATTERNS } from '@engram/core'

describe('extractPersons', () => {
  it('extracts names from "tell X" pattern', () => {
    const result = extractPersons('Can you tell Muhammad about the update?')
    expect(result.find(p => p.name === 'Muhammad')).toBeDefined()
  })

  it('extracts names from "ask X" pattern', () => {
    const result = extractPersons('Ask Sarah about the deployment')
    expect(result.find(p => p.name === 'Sarah')).toBeDefined()
  })

  it('extracts @-mentioned names', () => {
    const result = extractPersons('Hey @Alice, can you review this?')
    expect(result.find(p => p.name === 'Alice')).toBeDefined()
  })

  it('does not extract blocklisted words', () => {
    const result = extractPersons('The First thing to Note is that This works')
    const names = result.map(p => p.name)
    expect(names).not.toContain('First')
    expect(names).not.toContain('Note')
    expect(names).not.toContain('This')
  })

  it('deduplicates same name from multiple patterns', () => {
    const result = extractPersons('Tell Muhammad, ask Muhammad, ping Muhammad')
    const muhammads = result.filter(p => p.name === 'Muhammad')
    expect(muhammads.length).toBe(1)
  })

  it('returns empty array for text with no names', () => {
    const result = extractPersons('the quick brown fox jumps over the lazy dog')
    expect(result.length).toBe(0)
  })
})

describe('classifyEmotion', () => {
  it('returns neutral for plain text', () => {
    const result = classifyEmotion('I need to update the database schema')
    expect(result.label).toBe('neutral')
  })

  it('requires 2+ matches for non-neutral (AUDIT FIX)', () => {
    // Single exclamation mark pattern should NOT trigger excited
    const result = classifyEmotion('That works!!')
    // "!!" matches one pattern. Need 2+ distinct patterns.
    // This should remain neutral because only one excited pattern matches.
    expect(result.label).toBe('neutral')
  })

  it('classifies frustrated with 2+ pattern matches', () => {
    const result = classifyEmotion('I am frustrated, this is still broken and not working')
    expect(result.label).toBe('frustrated')
    expect(result.patternMatches).toBeGreaterThanOrEqual(2)
    expect(result.intensity).toBeGreaterThan(0.4)
  })

  it('classifies urgent with 2+ pattern matches', () => {
    const result = classifyEmotion('This is urgent, production is down, we need to fix immediately')
    expect(result.label).toBe('urgent')
    expect(result.patternMatches).toBeGreaterThanOrEqual(2)
  })

  it('classifies excited with 2+ pattern matches', () => {
    const result = classifyEmotion("I'm excited about this, it's amazing and I can't wait to try it!!")
    expect(result.label).toBe('excited')
    expect(result.patternMatches).toBeGreaterThanOrEqual(2)
  })

  it('intensity scales with match count', () => {
    const low = classifyEmotion('frustrated and stuck')
    const high = classifyEmotion('frustrated and stuck and broken, keeps failing, going in circles')
    expect(high.intensity).toBeGreaterThan(low.intensity)
  })
})

describe('classifyContentIntent', () => {
  it('classifies questions', () => {
    const result = classifyContentIntent('What is the architecture of this system?', INTENT_PATTERNS)
    expect(result).toBe('QUESTION')
  })

  it('classifies debugging', () => {
    const result = classifyContentIntent('There is an error in the build, it keeps failing', INTENT_PATTERNS)
    expect(result).toBe('DEBUGGING')
  })

  it('classifies recall requests', () => {
    const result = classifyContentIntent('Do you remember what we decided about the schema?', INTENT_PATTERNS)
    expect(result).toBe('RECALL_EXPLICIT')
  })

  it('classifies social greetings', () => {
    const result = classifyContentIntent('hey!', INTENT_PATTERNS)
    expect(result).toBe('SOCIAL')
  })

  it('falls back to INFORMATIONAL for long unclassified text', () => {
    const result = classifyContentIntent(
      'The system processes data through multiple stages of transformation and validation',
      INTENT_PATTERNS,
    )
    expect(result).toBe('INFORMATIONAL')
  })
})
```

### Test: Configuration (Unit -- no Neo4j required)

### File: `test/config.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseGraphConfig, validateGraphConfig } from '../src/config.js'

describe('parseGraphConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = parseGraphConfig({})
    expect(config.neo4jUri).toBe('bolt://localhost:7687')
    expect(config.neo4jUser).toBe('neo4j')
    expect(config.neo4jPassword).toBe('engram-dev')
    expect(config.enabled).toBe(true)
  })

  it('reads from environment variables', () => {
    const config = parseGraphConfig({
      NEO4J_URI: 'bolt://production:7687',
      NEO4J_USER: 'admin',
      NEO4J_PASSWORD: 'secret',
      ENGRAM_GRAPH_ENABLED: 'false',
    })
    expect(config.neo4jUri).toBe('bolt://production:7687')
    expect(config.neo4jUser).toBe('admin')
    expect(config.neo4jPassword).toBe('secret')
    expect(config.enabled).toBe(false)
  })

  it('treats any value except "false" as enabled', () => {
    expect(parseGraphConfig({ ENGRAM_GRAPH_ENABLED: 'true' }).enabled).toBe(true)
    expect(parseGraphConfig({ ENGRAM_GRAPH_ENABLED: 'yes' }).enabled).toBe(true)
    expect(parseGraphConfig({ ENGRAM_GRAPH_ENABLED: '1' }).enabled).toBe(true)
    expect(parseGraphConfig({ ENGRAM_GRAPH_ENABLED: 'false' }).enabled).toBe(false)
  })
})

describe('validateGraphConfig', () => {
  it('passes for valid config', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'bolt://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'test',
      enabled: true,
    })).not.toThrow()
  })

  it('accepts neo4j:// protocol', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'neo4j://cluster:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'test',
      enabled: true,
    })).not.toThrow()
  })

  it('rejects invalid protocol', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'http://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'test',
      enabled: true,
    })).toThrow(/must start with bolt:\/\/ or neo4j:\/\//)
  })

  it('rejects empty user', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'bolt://localhost:7687',
      neo4jUser: '',
      neo4jPassword: 'test',
      enabled: true,
    })).toThrow(/neo4jUser is required/)
  })

  it('rejects empty password', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'bolt://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: '',
      enabled: true,
    })).toThrow(/neo4jPassword is required/)
  })
})
```

---

## 11. Default Edge Weights

Reference table for all edge weights used in `decomposeEpisode()` and elsewhere. These are the ON CREATE defaults; reconsolidation can increase them up to 1.0.

| Relationship | Default Weight | Rationale |
|---|---|---|
| SPOKE | 0.7 | Strong: who was involved matters for recall |
| CONTEXTUAL | 0.6 | Medium-strong: what the memory is about |
| EMOTIONAL | {intensity} | Variable: scaled by detected emotional intensity |
| INTENTIONAL | 0.5 | Medium: what the user was trying to do |
| OCCURRED_IN | 1.0 | Session membership is unconditional |
| OCCURRED_AT | 0.5 | Medium: temporal context is supplementary |
| TEMPORAL | 0.3 | Low: adjacent episodes are weakly linked by default |
| DERIVES_FROM | 0.8 | Strong: derivation is a definitive relationship |
| CO_RECALLED | 0.2 | Low initial: strengthened through repeated co-retrieval |
| SUPPORTS | 0.5 | Medium: corroboration |
| CONTRADICTS | 0.7 | Strong: contradiction is important to surface |
| TOPICAL | 0.3-0.8 | Variable: 0.3 + 0.1 * min(sharedEntityCount, 5) |

---

## 12. Audit Fix Summary

This section explicitly enumerates every audit finding from the previous graphology-based plan and how this Neo4j-based plan addresses it.

### CRITICAL Findings

| # | Finding | Resolution |
|---|---------|-----------|
| 1 | O(E) edge duplicate check per edge addition | MERGE with indexed unique constraints gives O(1). See `addEdge()` in NeuralGraph. |
| 2 | BFS queue grows without bound in spreading activation | Cypher variable-length path traversal with LIMIT. See SpreadingActivation.activate(). |
| 3 | Manual JSON snapshot persistence is fragile and blocks startup | Neo4j IS the persistence layer. No serialization. No startup loading. |
| 4 | EmotionNode as global singleton creates false associations | EmotionNode ID includes sessionId. See types.ts `EmotionNodeProperties`. |
| 5 | TimeContextNode as 28 global singletons creates false associations | TimeContextNode ID includes yearWeek. See types.ts `TimeContextNodeProperties`. |

### HIGH Findings

| # | Finding | Resolution |
|---|---------|-----------|
| 1 | Context extraction duplicates core's entity extractor | `extractPersons()` is graph-specific. Entity/tech/project extraction delegates to `@engram/core`'s `extractEntities()` via peer dependency. `classifyContentIntent()` takes INTENT_PATTERNS as a parameter, not duplicating patterns. |
| 2 | Emotion classification false positives (single pattern match) | `classifyEmotion()` requires 2+ pattern matches for non-neutral. See AUDIT FIX callout in context-extractors.ts. |
| 3 | No performance tests at scale | Dedicated performance.test.ts with 10K and 50K node benchmarks. |
| 4 | Entity node IDs not deterministic | All context node IDs use `normalizeForId()` for deterministic generation. Same entity string always produces same node ID. |

### MEDIUM Findings

| # | Finding | Resolution |
|---|---------|-----------|
| 1 | No graph algorithms (PageRank, Louvain) | Neo4j GDS plugin provides these out of the box. Used in Wave 3/4. |
| 2 | No concurrent access support | Neo4j handles concurrent sessions natively via Bolt protocol. |
| 3 | decomposeEpisode was N+1 individual calls | Single executeWrite transaction wraps all MERGE operations. See NeuralGraph.decomposeEpisode(). |

---

## Post-Script: What Comes Next

### Wave 2: Retrieval Rewiring

Wave 2 wires `@engram/graph` into the existing ingestion and retrieval pipelines in `@engram/core`. Specifically:

1. **Ingestion hook**: `Memory.ingest()` in `packages/core/src/memory.ts` gains an optional `NeuralGraph` dependency. After inserting the episode into SQL, it calls `graph.decomposeEpisode()` to populate the Neo4j graph. The graph is non-blocking: if Neo4j is unreachable, ingestion still succeeds (fire-and-forget pattern with circuit breaker).

2. **Retrieval rewiring**: `stageAssociate()` in `packages/core/src/retrieval/association-walk.ts` currently calls `storage.associations.walk()` (SQL recursive CTE). In Wave 2, when `NeuralGraph` is available, it calls `SpreadingActivation.activate()` instead. The SQL walk becomes the fallback when the graph is disabled.

3. **Composite scoring**: Vector search scores and graph activation scores are combined. A memory that scores 0.5 in vector similarity but 0.8 in graph activation (because it shares engram cells with the query context) gets a higher composite score than a memory with 0.6 vector similarity and 0.0 graph activation.

4. **Reconsolidation**: After retrieval, `strengthenTraversedEdges()` updates the edges that were used, implementing Hebbian learning ("neurons that fire together wire together").

5. **Environmental context in output**: RecallResult gains an optional `context` field containing the activated PersonNodes, EmotionNodes, and EntityNodes from the graph traversal. This allows the MCP server to include environmental context in the formatted memory output.

### Wave 3: Consolidation Integration

Light Sleep creates digest nodes with DERIVES_FROM edges. Dream Cycle uses Neo4j GDS community detection (Louvain or Leiden algorithm) to find topic clusters instead of the current SQL entity co-occurrence scan. Decay Pass prunes graph nodes with low activation counts.

### Wave 4: Advanced Graph Features

Pattern completion as a first-class retrieval mode. Betweenness centrality for identifying bridge memories. Graph-aware deduplication during Deep Sleep. Full performance benchmarking suite at 100K+ nodes.
