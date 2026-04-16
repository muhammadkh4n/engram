# Wave 5: Community Intelligence + Pattern Completion + Namespace Isolation

**Document status:** Implementation plan — an agent implements this without asking questions.
**Date authored:** 2026-04-08 (Neo4j rewrite)
**Repository:** `/Users/muhammadkh4n/Projects/github/muhammadkh4n/engram`
**This is the FINAL wave.**

---

## Pre-Script: Everything Engram Is and Everything All Previous Waves Built

### The System

Engram is a TypeScript monorepo at `/Users/muhammadkh4n/Projects/github/muhammadkh4n/engram`. It implements a brain-inspired cognitive memory engine for AI agents. The central thesis: agent memory is not a retrieval problem, it is a neuroscience problem. Memories are not documents. They are distributed patterns of activation across a contextual network that encodes who, what, when, and how things felt.

The monorepo packages:

```
packages/
  core/       @engram-mem/core     — The engine. Memory class, 5 memory systems,
                                  4 consolidation cycles, 11-type intent classifier,
                                  vector-first hybrid retrieval pipeline.
  sqlite/     @engram-mem/sqlite   — SqliteStorageAdapter. better-sqlite3. Schema V3
                                  after Wave 4 adds valid_from/valid_until columns.
  supabase/   @engram-mem/supabase — SupabaseStorageAdapter. pgvector + supabase-js.
  openai/     @engram-mem/openai   — OpenAIIntelligenceAdapter. Embeddings, summarization,
                                  query expansion, HyDE doc generation.
  mcp/        @engram-mem/mcp      — MCP server. Exposes memory_recall, memory_ingest,
                                  memory_forget, memory_timeline (Wave 4) via stdio.
  graph/      @engram-mem/graph    — NeuralGraph wrapping neo4j-driver + SpreadingActivation
                                  via Cypher (built in Wave 1).
  bench/      @engram-mem/bench    — Benchmark harness (Wave 4). LoCoMo + LongMemEval
                                  adapters, CLI runner, comparison mode.
```

### CRITICAL: Graph Persistence Architecture

**Neo4j IS the graph persistence layer.** There are NO `graph_nodes` or `graph_edges` SQL tables. There is no `GraphStorageAdapter` interface. There is no `graph_snapshots` table. All graph state lives in a running Neo4j instance (Community Edition, Bolt port 7687). All graph operations go through `NeuralGraph` class methods that execute Cypher queries via `neo4j-driver`.

The `NeuralGraph` class (from `packages/graph/src/neural-graph.ts`) is the ONLY interface for graph operations:

```typescript
export class NeuralGraph {
  async connect(): Promise<void>
  async disconnect(): Promise<void>
  async decomposeEpisode(episode: EpisodeInput): Promise<void>
  async spreadActivation(opts: SpreadActivationOpts): Promise<ActivatedNode[]>
  async lookupEntityNodes(names: string[]): Promise<EntitySeedResult[]>
  async getMemoryNodeIds(nodeIds: string[]): Promise<string[]>
  async strengthenTraversedEdges(pairs: Array<[string, string]>): Promise<void>
  async runCypher(query: string, params?: Record<string, unknown>): Promise<neo4j.QueryResult>
  async runCypherWrite(query: string, params?: Record<string, unknown>): Promise<neo4j.QueryResult>
  async isAvailable(): Promise<boolean>
  async isGdsAvailable(): Promise<boolean>
}
```

Any code that needs to create, read, update, or delete graph nodes/edges MUST go through `NeuralGraph.runCypher()` or `NeuralGraph.runCypherWrite()`. Do NOT use in-process graph libraries, do NOT store graph data in SQL tables, do NOT iterate graph nodes in JavaScript memory.

### The Five Memory Systems

1. **Sensory Buffer** (`packages/core/src/systems/sensory-buffer.ts`) — In-process working memory for the current turn. Holds `WorkingMemoryItem[]` (key-value facts) and `PrimedTopic[]` (short-term topic boosts). Decays via `tick()` each turn. Persisted as JSON snapshots via `storage.saveSensorySnapshot()`.

2. **Episodic Memory** — The `episodes` table. Every ingested `Message` becomes an `Episode` with: `content` (clean text, no tool calls), `salience` (0–1 from `scoreSalience()`), `entities` (array from `extractEntities()`), `embedding` (float32 vector), and `metadata` (role, raw parts). FTS5 virtual table `episodes_fts` indexes content and entities for BM25 search.

3. **Digest Memory** — The `digests` table. Output of Light Sleep consolidation. Batches of 20 episodes (sorted by salience DESC) compressed into session-level summaries with `keyTopics`, `sourceEpisodeIds`, and an embedding.

4. **Semantic Memory** — The `semantic` table. Long-term facts extracted during Deep Sleep from digest content. Each has `topic`, `content`, `confidence` (0–1), `decayRate` (0.02), `supersedes` and `supersededBy` FK pointers for supersession chains. After Wave 4: `valid_from` and `valid_until` SQL columns for temporal queries.

5. **Procedural Memory** — The `procedural` table. Trigger-action patterns extracted from workflow and preference phrases. Has `trigger`, `procedure`, `category` (workflow/preference/habit/pattern/convention), `observationCount`, and `decayRate` (0.01 — stickier than semantic).

The SQL `associations` table links any two memories via 8 edge types (`temporal`, `causal`, `topical`, `supports`, `contradicts`, `elaborates`, `derives_from`, `co_recalled`) with `strength` (0–1) and `lastActivated`.

### The Four Consolidation Cycles

**Light Sleep** (`packages/core/src/consolidation/light-sleep.ts`): Per-session. Takes unconsolidated episodes, batches 20 at a time by salience DESC, summarizes via intelligence adapter (3-level fallback: preserve_details → bullet_points → heuristic TF-IDF), inserts a `Digest`, marks episodes consolidated, creates SQL `derives_from` association edges. After Wave 3: also creates a digest `Memory` node in Neo4j via `NeuralGraph.runCypherWrite()`, connects it to source episode nodes via `DERIVES_FROM` relationships, inherits topic/person/entity/emotion context from source episodes with merged weights. Signature: `lightSleep(storage, intelligence, graph, opts?)`.

**Deep Sleep** (`packages/core/src/consolidation/deep-sleep.ts`): Operates on the 7 most recent days of digests. Regex-based pattern extraction: 9 semantic patterns (preferences, decisions, personal info) + 8 procedural trigger patterns. Deduplicates (cosine similarity > 0.92 → boost existing), detects supersession (contradiction pairs). After Wave 3: creates semantic and procedural memory nodes in Neo4j with `validFrom`/`validUntil` properties; sets `validUntil` on superseded nodes via Cypher; adds `CONTRADICTS` relationships between new and superseded memories; inherits context connections transitively from source digest nodes (weight × 0.7). Signature: `deepSleep(storage, intelligence, graph, opts?)`.

**Dream Cycle** (`packages/core/src/consolidation/dream-cycle.ts`): After Wave 3, runs five graph-native operations via Neo4j GDS:
1. Louvain community detection via `gds.louvain.write()` — assigns `communityId` property to every node.
2. Intra-community edge strengthening — Cypher UPDATE on edges where source and target share `communityId`, boosting weight by 0.1 (capped at 1.0).
3. Bridge node detection via `gds.betweenness.write()` — marks nodes with edges spanning 2+ distinct communities as `isBridge: true`.
4. Hippocampal replay simulation — picks 5 random Memory nodes as seeds via Cypher, runs `NeuralGraph.spreadActivation()` from each, creates `TOPICAL` relationships between seed pairs whose activation overlaps by 2+ shared nodes.
5. Causal edge discovery — Cypher query for Topic/Entity nodes connected to Memory nodes in 3+ distinct sessions, promotes to `CAUSAL` relationships.
Also runs the legacy SQL entity co-occurrence scan as a supplementary pass. Signature: `dreamCycle(storage, graph, opts?)`.

**Decay Pass** (`packages/core/src/consolidation/decay-pass.ts`): After Wave 3, runs `gds.pageRank.write()` on all graph nodes via Neo4j GDS, identifies top-10% hubs by `pageRank` property, excludes their SQL memory IDs from batch decay. Prunes graph edges via Cypher `DELETE` where `traversalCount = 0` and `createdAt` older than `edgePruneDays`. Signature: `decayPass(storage, graph, opts?)`.

### Schema Version Numbering

- **V1** — Base tables: `memories`, `episodes`, `digests`, `semantic`, `procedural`, `associations`, `consolidation_runs`, `sensory_snapshots`. FTS5 virtual tables and triggers.
- **V2** — `episode_parts` table.
- **V3** (Wave 4) — `valid_from` and `valid_until` columns on `semantic` table. Partial index for temporal queries.
- **V4** (this wave) — `community_summaries` cache table. `project_id` columns on all memory tables.

There is NO V3 SQL graph table migration. Neo4j handles graph storage entirely.

### What Waves 1–4 Built

**Wave 1**: `@engram-mem/graph` package wrapping `neo4j-driver`. `NeuralGraph` class with all graph state persisted in Neo4j. 8 node labels: `Memory`, `Person`, `Topic`, `Entity`, `Emotion`, `Intent`, `Session`, `TimeContext`. 13 relationship types. `SpreadingActivation` using Cypher variable-length path traversal with decay parameters. Context extraction functions. Neo4j constraints and indexes applied on `connect()`.

**Wave 2**: Graph-aware ingestion and retrieval. On `ingest()`, each episode is decomposed into Neo4j via `NeuralGraph.decomposeEpisode()` — single Cypher write transaction. Recall pipeline runs 4-way parallel search (vector + BM25 + temporal + entity), passes results to `NeuralGraph.spreadActivation()` as Cypher seeds, merges activated node IDs back to SQL content via `NeuralGraph.getMemoryNodeIds()`, returns `CompositeMemory`. `Memory._graph: NeuralGraph | null` — when null, system operates in SQL-only mode.

**Wave 3**: All 4 consolidation cycles are graph-aware via Neo4j GDS. Light sleep creates digest Memory nodes in Neo4j with `DERIVES_FROM` relationships. Deep sleep creates semantic/procedural Memory nodes with temporal validity (`validFrom`/`validUntil` as Neo4j node properties) and `CONTRADICTS` relationships. Dream cycle uses GDS Louvain (`gds.louvain.write()`), betweenness centrality (`gds.betweenness.write()`), and hippocampal replay via Cypher spreading activation. Decay pass uses GDS PageRank (`gds.pageRank.write()`) to protect hub memories.

**Wave 4**: `@engram-mem/bench` package with LoCoMo and LongMemEval benchmark adapters, CLI runner with `--compare` mode. Temporal validity queries: `asOf?: Date` parameter on `recall()`, SQL `searchAtTime()` with half-open `[valid_from, valid_until)` boundaries, `memory_timeline` MCP tool. Schema V3 migration for temporal columns.

### Node and Edge Type Inventory (Post Wave 3)

**8 node labels** in Neo4j:

| Label        | ID Format                          | Singleton Scope |
|-------------|-------------------------------------|-----------------|
| `:Memory`    | SQL primary key (UUID v7)           | per-episode     |
| `:Person`    | `person:{lowercase_name}`           | global          |
| `:Topic`     | `topic:{lowercase_name}`            | global          |
| `:Entity`    | `entity:{lowercase_name}`           | global          |
| `:Emotion`   | `emotion:{sessionId}:{label}`       | per-session     |
| `:Intent`    | `intent:{intentType}`               | global          |
| `:Session`   | `session:{sessionId}`               | per-session     |
| `:TimeContext`| `time:{yearWeek}:{dayOfWeek}:{tod}`| global          |

**13 relationship types**: `TEMPORAL`, `CAUSAL`, `TOPICAL`, `SUPPORTS`, `CONTRADICTS`, `ELABORATES`, `DERIVES_FROM`, `CO_RECALLED`, `SPOKE`, `CONTEXTUAL`, `EMOTIONAL`, `INTENTIONAL`, `OCCURRED_IN`.

All relationships carry: `weight FLOAT`, `createdAt STRING (ISO 8601)`, `lastTraversed STRING`, `traversalCount INTEGER`.

All nodes stored in Neo4j via `MERGE` on `id` property. Person and Entity nodes are global singletons — NOT scoped by session or project.

### The Retrieval Pipeline (Post Wave 2)

In `packages/core/src/retrieval/engine.ts`, the `recall()` function:
1. Classifies intent via `classifyMode()` → one of `skip | light | deep`
2. Embeds the query via `intelligence.embed()`
3. Calls `unifiedSearch()` which runs: vector cosine search + BM25 text boost → RRF fusion → top-N results
4. HyDE fallback: if top score < 0.3, generates hypothetical document, embeds it, re-searches, merges
5. Association walk (deep mode only): uses `NeuralGraph.spreadActivation()` from `@engram-mem/graph` with vector/BM25 result IDs as Cypher seeds
6. Topic priming: updates `SensoryBuffer` with frequent entities from recalled memories
7. Reconsolidation: strengthens `CO_RECALLED` edges between returned memories via `NeuralGraph.strengthenTraversedEdges()`

### The `Memory` Class Constructor

```typescript
export interface MemoryOptions {
  storage: StorageAdapter
  intelligence?: IntelligenceAdapter
  consolidation?: { schedule: 'auto' | 'manual' }
  tokenizer?: (text: string) => number
  graph?: boolean  // Wave 4: controls Neo4j connection. Default true.
}
```

`createMemory(opts: MemoryOptions): Memory` is the public factory in `packages/core/src/create-memory.ts`.

### The MCP Server (Post Wave 4)

`packages/mcp/src/index.ts` exposes four tools:
- `memory_recall(query, session_id?)` — calls `mem.recall()`
- `memory_ingest(content, role, session_id?)` — calls `mem.ingest()`
- `memory_forget(query, confirm?)` — calls `mem.forget()`
- `memory_timeline(topic, limit?)` — walks the supersession chain for a topic

---

## Wave 5 Scope

Three jobs. All are additive — existing behavior is preserved. Backward compatibility is non-negotiable.

**Job 1: Community Summaries** — GraphRAG-style "zoom out" recall. After the dream cycle runs GDS Louvain and assigns community IDs, Wave 5 generates natural language summaries for each community and stores them as `:Community` nodes in Neo4j. A new `memory_overview` MCP tool exposes community summaries to agents.

**Job 2: Pattern Completion** — Hippocampal pattern completion for fragmentary cues. When vector search returns weak scores (top score < 0.2 on RECALL_EXPLICIT queries), extract attributes from the query text, find matching context nodes in Neo4j via Cypher, and use them as spreading activation seeds to converge on the target memory.

**Job 3: Project Namespace Isolation** — Multi-agent support for Ouija. Add `projectId` scoping to all storage operations and the Neo4j graph layer. Memories ingested with `projectId = "alpha"` are invisible to queries with `projectId = "beta"`. Shared Person and Entity nodes bridge projects. Two new MCP tools: `memory_overview` and `memory_bridges` for cross-project queries.

---

## Audit Fixes Applied in This Version

This document corrects errors from the previous (graphology-based) draft:

**Audit Fix 1: No SQL graph tables.** The previous draft referenced `graph_nodes` and `graph_edges` SQL tables inherited from a graphology persistence layer. These tables do not exist. Neo4j IS the graph persistence layer. All graph CRUD goes through `NeuralGraph.runCypher()` / `NeuralGraph.runCypherWrite()`.

**Audit Fix 2: No GraphStorageAdapter.** The previous draft defined a `GraphStorageAdapter` interface with `saveNodes()`, `saveEdges()`, `loadAll()`, `pruneEdges()`. This interface does not exist. The `NeuralGraph` class is the only graph abstraction. Community summary persistence uses a lightweight SQL cache table for MCP query performance, but the source of truth is Neo4j.

**Audit Fix 3: No in-process graph iteration.** The previous draft iterated graph nodes with `graph.nodes()` and accessed attributes with `graph.getNodeAttribute()` — these are graphology APIs for in-memory graphs. All node/edge operations must use Cypher queries executed through `NeuralGraph`. This means: no `for (const nodeId of graph.nodes())` loops, no `graph.neighbors()` calls, no `graph.addNode()` / `graph.addEdge()` calls.

**Audit Fix 4: Community PK collision across projects.** Community IDs from Louvain are integers (0, 1, 2...) that reset each run. When project namespace isolation is active, the same integer may appear in different projects. Community node IDs must be prefixed with `projectId`: `community:{projectId}:{louvainId}` or `community:global:{louvainId}` when no project is set.

**Audit Fix 5: IntelligenceAdapter.summarize() signature.** The `summarize()` method takes `(content: string, opts: SummarizeOptions)`, NOT `(messages: Message[], format: string)`. Community summary generation must use the correct signature.

**Audit Fix 6: Privacy leak through shared nodes.** Spreading activation crosses shared Person/Entity nodes but STOPS at Memory nodes tagged with a foreign `projectId`. The `memory_bridges` tool returns counts and labels only, not full memory content from other projects.

---

## Part 1: Community Summaries (GraphRAG-Style)

### 1.1 New Node Label: `:Community`

Add `:Community` as a 9th node label in Neo4j. The `NeuralGraph.connect()` method already creates constraints for each label. Add the Community constraint:

```typescript
// In NeuralGraph.connect(), add to the constraint creation block:
await this.runCypherWrite(`
  CREATE CONSTRAINT community_id IF NOT EXISTS
  FOR (c:Community) REQUIRE c.id IS UNIQUE
`)
```

Community node properties:

```typescript
interface CommunityNodeProperties {
  id: string              // 'community:{projectId}:{louvainId}' or 'community:global:{louvainId}'
  communityId: string     // the Louvain integer as string
  label: string           // generated natural-language summary (max 200 chars)
  memberCount: number     // number of Memory nodes in this community
  topEntities: string[]   // top 3 entity labels by frequency (stored as JSON string in Neo4j)
  topTopics: string[]     // top 3 topic labels by frequency
  topPersons: string[]    // top 3 person labels by frequency
  dominantEmotion: string | null
  generatedAt: string     // ISO timestamp
  projectId: string | null
}
```

### 1.2 New Relationship Type: `MEMBER_OF`

Add `MEMBER_OF` as a 14th relationship type.

```
MEMBER_OF — (:Memory)-[:MEMBER_OF]->(:Community)  // memory belongs to community
```

This makes the total relationship type count 14.

### 1.3 Community Summary SQL Cache Table

The SQL `community_summaries` table exists as a **read cache** for fast MCP tool queries. The source of truth remains the `:Community` nodes in Neo4j.

In `packages/sqlite/src/migrations.ts`, add a `SCHEMA_V4` constant:

```typescript
const SCHEMA_V4 = `
-- Community summaries: cache table for MCP queries.
-- Source of truth is the :Community nodes in Neo4j.
-- Rebuilt from Neo4j during dream cycle.
CREATE TABLE IF NOT EXISTS community_summaries (
  community_id     TEXT    NOT NULL PRIMARY KEY,
  project_id       TEXT,
  label            TEXT    NOT NULL,
  member_count     INTEGER NOT NULL DEFAULT 0,
  top_entities     TEXT    NOT NULL DEFAULT '[]',
  top_topics       TEXT    NOT NULL DEFAULT '[]',
  top_persons      TEXT    NOT NULL DEFAULT '[]',
  dominant_emotion TEXT,
  generated_at     REAL    NOT NULL DEFAULT (julianday('now')),
  updated_at       REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_community_project ON community_summaries(project_id);
CREATE INDEX IF NOT EXISTS idx_community_members ON community_summaries(member_count DESC);

-- Add project_id column to all memory tables.
-- NULL = global (accessible from all projects, backward compatible).
ALTER TABLE episodes ADD COLUMN project_id TEXT;
ALTER TABLE digests ADD COLUMN project_id TEXT;
ALTER TABLE semantic ADD COLUMN project_id TEXT;
ALTER TABLE procedural ADD COLUMN project_id TEXT;

-- Indexes for project-scoped queries
CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_digests_project ON digests(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_semantic_project ON semantic(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_procedural_project ON procedural(project_id) WHERE project_id IS NOT NULL;
`
```

Guard ALTER TABLE with column existence checks (SQLite throws on duplicate column):

```typescript
if (currentVersion < 4) {
  // Community summaries table (safe to CREATE IF NOT EXISTS)
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_summaries (
      community_id     TEXT    NOT NULL PRIMARY KEY,
      project_id       TEXT,
      label            TEXT    NOT NULL,
      member_count     INTEGER NOT NULL DEFAULT 0,
      top_entities     TEXT    NOT NULL DEFAULT '[]',
      top_topics       TEXT    NOT NULL DEFAULT '[]',
      top_persons      TEXT    NOT NULL DEFAULT '[]',
      dominant_emotion TEXT,
      generated_at     REAL    NOT NULL DEFAULT (julianday('now')),
      updated_at       REAL    NOT NULL DEFAULT (julianday('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_community_project ON community_summaries(project_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_community_members ON community_summaries(member_count DESC)`)

  // project_id columns on memory tables
  const tables = ['episodes', 'digests', 'semantic', 'procedural']
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some(c => c.name === 'project_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project_id) WHERE project_id IS NOT NULL`)
    }
  }

  db.pragma('user_version = 4')
}
```

For Supabase (`packages/supabase/`), add equivalent SQL via a new migration file `supabase/migrations/20260408000001_community_and_projects.sql`.

### 1.4 `NeuralGraph` New Methods for Community Operations

**File to modify:** `packages/graph/src/neural-graph.ts`

Add the following methods to the `NeuralGraph` class:

```typescript
/**
 * Query all communities from Neo4j, grouped by communityId.
 * Returns community metadata with member counts and context frequencies.
 */
async getCommunityMembers(opts?: {
  minSize?: number
  projectId?: string
}): Promise<Array<{
  communityId: string
  memberNodeIds: string[]
  memberLabels: string[]
}>> {
  const minSize = opts?.minSize ?? 5
  const projectFilter = opts?.projectId
    ? 'AND m.projectId = $projectId'
    : ''

  const result = await this.runCypher(`
    MATCH (m:Memory)
    WHERE m.communityId IS NOT NULL ${projectFilter}
    WITH m.communityId AS cid, collect(m.id) AS memberIds, collect(m.label) AS labels
    WHERE size(memberIds) >= $minSize
    RETURN cid, memberIds, labels
    ORDER BY size(memberIds) DESC
  `, { minSize, projectId: opts?.projectId ?? null })

  return result.records.map(r => ({
    communityId: r.get('cid').toString(),
    memberNodeIds: r.get('memberIds') as string[],
    memberLabels: r.get('labels') as string[],
  }))
}

/**
 * For a given community, get the context node frequencies (entities, topics, persons, emotions).
 */
async getCommunityContext(communityId: string, projectId?: string): Promise<{
  entityFrequency: Map<string, number>
  topicFrequency: Map<string, number>
  personFrequency: Map<string, number>
  emotionFrequency: Map<string, number>
}> {
  const projectFilter = projectId
    ? 'AND m.projectId = $projectId'
    : ''

  const result = await this.runCypher(`
    MATCH (m:Memory {communityId: $communityId})--(ctx)
    WHERE (ctx:Entity OR ctx:Topic OR ctx:Person OR ctx:Emotion)
      ${projectFilter}
    WITH labels(ctx)[0] AS ctxType, ctx.label AS label, count(*) AS freq
    RETURN ctxType, label, freq
    ORDER BY freq DESC
  `, { communityId, projectId: projectId ?? null })

  const entityFrequency = new Map<string, number>()
  const topicFrequency = new Map<string, number>()
  const personFrequency = new Map<string, number>()
  const emotionFrequency = new Map<string, number>()

  for (const record of result.records) {
    const ctxType = (record.get('ctxType') as string).toLowerCase()
    const label = record.get('label') as string
    const freq = (record.get('freq') as { toNumber(): number }).toNumber()

    switch (ctxType) {
      case 'entity': entityFrequency.set(label, freq); break
      case 'topic': topicFrequency.set(label, freq); break
      case 'person': personFrequency.set(label, freq); break
      case 'emotion': emotionFrequency.set(label, freq); break
    }
  }

  return { entityFrequency, topicFrequency, personFrequency, emotionFrequency }
}

/**
 * Create or update a :Community node and connect member :Memory nodes via MEMBER_OF.
 */
async upsertCommunityNode(props: {
  id: string
  communityId: string
  label: string
  memberCount: number
  topEntities: string[]
  topTopics: string[]
  topPersons: string[]
  dominantEmotion: string | null
  generatedAt: string
  projectId: string | null
  memberNodeIds: string[]
}): Promise<void> {
  // Upsert the :Community node
  await this.runCypherWrite(`
    MERGE (c:Community {id: $id})
    SET c.communityId = $communityId,
        c.label = $label,
        c.memberCount = $memberCount,
        c.topEntities = $topEntities,
        c.topTopics = $topTopics,
        c.topPersons = $topPersons,
        c.dominantEmotion = $dominantEmotion,
        c.generatedAt = $generatedAt,
        c.projectId = $projectId
  `, {
    id: props.id,
    communityId: props.communityId,
    label: props.label,
    memberCount: props.memberCount,
    topEntities: props.topEntities,
    topTopics: props.topTopics,
    topPersons: props.topPersons,
    dominantEmotion: props.dominantEmotion,
    generatedAt: props.generatedAt,
    projectId: props.projectId,
  })

  // Create MEMBER_OF relationships from member Memory nodes to Community
  if (props.memberNodeIds.length > 0) {
    await this.runCypherWrite(`
      MATCH (c:Community {id: $communityId})
      UNWIND $memberIds AS memberId
      MATCH (m:Memory {id: memberId})
      MERGE (m)-[r:MEMBER_OF]->(c)
      ON CREATE SET r.weight = 1.0,
                    r.traversalCount = 0,
                    r.createdAt = $now,
                    r.lastTraversed = null
    `, {
      communityId: props.id,
      memberIds: props.memberNodeIds,
      now: new Date().toISOString(),
    })
  }
}

/**
 * Query community summaries from Neo4j for MCP tool responses.
 */
async queryCommunities(opts?: {
  projectId?: string
  limit?: number
}): Promise<Array<{
  communityId: string
  label: string
  memberCount: number
  topEntities: string[]
  topTopics: string[]
  topPersons: string[]
  dominantEmotion: string | null
  generatedAt: string
  projectId: string | null
}>> {
  const limit = opts?.limit ?? 20
  const projectFilter = opts?.projectId
    ? 'WHERE (c.projectId = $projectId OR c.projectId IS NULL)'
    : ''

  const result = await this.runCypher(`
    MATCH (c:Community)
    ${projectFilter}
    RETURN c
    ORDER BY c.memberCount DESC
    LIMIT $limit
  `, { projectId: opts?.projectId ?? null, limit })

  return result.records.map(r => {
    const c = r.get('c').properties
    return {
      communityId: c.communityId as string,
      label: c.label as string,
      memberCount: (c.memberCount as { toNumber(): number }).toNumber(),
      topEntities: c.topEntities as string[] ?? [],
      topTopics: c.topTopics as string[] ?? [],
      topPersons: c.topPersons as string[] ?? [],
      dominantEmotion: c.dominantEmotion as string | null,
      generatedAt: c.generatedAt as string,
      projectId: c.projectId as string | null,
    }
  })
}

/**
 * Find shared Person/Entity nodes bridging two projects.
 * Returns labels and snippet counts only — no cross-project memory content (privacy).
 */
async findProjectBridges(projectA: string, projectB: string): Promise<Array<{
  nodeId: string
  nodeType: 'person' | 'entity'
  label: string
  projectACount: number
  projectBCount: number
  projectALabels: string[]
  projectBLabels: string[]
}>> {
  const result = await this.runCypher(`
    MATCH (shared)--(memA:Memory {projectId: $projectA})
    WHERE shared:Person OR shared:Entity
    WITH shared, collect(DISTINCT memA.label)[0..3] AS memALabels, count(DISTINCT memA) AS memACount
    MATCH (shared)--(memB:Memory {projectId: $projectB})
    WITH shared, memALabels, memACount,
         collect(DISTINCT memB.label)[0..3] AS memBLabels, count(DISTINCT memB) AS memBCount
    WHERE memACount > 0 AND memBCount > 0
    RETURN shared.id AS nodeId,
           CASE WHEN shared:Person THEN 'person' ELSE 'entity' END AS nodeType,
           shared.label AS label,
           memACount, memBCount, memALabels, memBLabels
    ORDER BY memACount + memBCount DESC
  `, { projectA, projectB })

  return result.records.map(r => ({
    nodeId: r.get('nodeId') as string,
    nodeType: r.get('nodeType') as 'person' | 'entity',
    label: r.get('label') as string,
    projectACount: (r.get('memACount') as { toNumber(): number }).toNumber(),
    projectBCount: (r.get('memBCount') as { toNumber(): number }).toNumber(),
    projectALabels: r.get('memALabels') as string[],
    projectBLabels: r.get('memBLabels') as string[],
  }))
}
```

### 1.5 Community Summary Generation Inside Dream Cycle

**File to modify:** `packages/core/src/consolidation/dream-cycle.ts`

After Operation 1 (Louvain community detection — `gds.louvain.write()` assigns `communityId` to all nodes) and before Operation 2 (edge strengthening), add Operation 1b: Community Summary Generation.

**New `DreamCycleOptions` additions:**
```typescript
export interface DreamCycleOptions {
  daysLookback?: number
  maxNewAssociations?: number
  communityBoostAmount?: number
  replaySeeds?: number
  causalMinSessions?: number
  // Wave 5 new:
  generateCommunitySummaries?: boolean   // default true
  minCommunitySize?: number              // default 5 MemoryNodes
  projectId?: string                     // namespace scope
}
```

**Updated function signature:**
```typescript
export async function dreamCycle(
  storage: StorageAdapter,
  graph: NeuralGraph,
  intelligence: IntelligenceAdapter | undefined,
  opts?: DreamCycleOptions
): Promise<ConsolidateResult>
```

The calling site in `packages/core/src/memory.ts` passes `this.intelligence`.

**Implementation of Operation 1b — Community Summary Generation:**

```typescript
// Operation 1b: Generate community summaries
const generateSummaries = opts?.generateCommunitySummaries ?? true
const minCommunitySize = opts?.minCommunitySize ?? 5
let communitySummariesGenerated = 0

if (generateSummaries) {
  // Step 1: Query communities from Neo4j with member counts
  const communities = await graph.getCommunityMembers({
    minSize: minCommunitySize,
    projectId: opts?.projectId,
  })

  // Step 2: For each qualifying community, collect context and generate summary
  for (const community of communities) {
    const { communityId, memberNodeIds, memberLabels } = community

    // Step 3: Get context frequencies via Cypher
    const context = await graph.getCommunityContext(communityId, opts?.projectId)
    const { entityFrequency, topicFrequency, personFrequency, emotionFrequency } = context

    // Step 4: Extract top-3 from each dimension
    const topEntities = topNByFrequency(entityFrequency, 3)
    const topTopics = topNByFrequency(topicFrequency, 3)
    const topPersons = topNByFrequency(personFrequency, 3)
    const dominantEmotion = topNByFrequency(emotionFrequency, 1)[0] ?? null

    // Step 5: Generate summary text
    let summaryLabel: string

    if (intelligence?.summarize) {
      // LLM path: build a prompt from the top labels
      const contextParts: string[] = []
      if (topTopics.length > 0) contextParts.push(`Topics: ${topTopics.join(', ')}`)
      if (topEntities.length > 0) contextParts.push(`Technologies/Entities: ${topEntities.join(', ')}`)
      if (topPersons.length > 0) contextParts.push(`People: ${topPersons.join(', ')}`)
      if (dominantEmotion) contextParts.push(`Emotional tone: ${dominantEmotion}`)

      // Take up to 10 memory labels to keep the prompt bounded
      const sampleLabels = memberLabels.slice(0, 10).join('\n- ')

      const prompt = [
        'Summarize the following cluster of related memories into a single 2-3 sentence description.',
        'Describe what knowledge domain or recurring theme this cluster represents.',
        'Be specific — name the subject matter, not just "a group of memories".',
        '',
        'Memory samples:',
        `- ${sampleLabels}`,
        '',
        ...contextParts,
      ].join('\n')

      try {
        summaryLabel = await intelligence.summarize(prompt, { format: 'bullet_points' })
        // Truncate to 200 chars for the graph node label
        summaryLabel = summaryLabel.slice(0, 200)
      } catch {
        summaryLabel = buildHeuristicSummary(topTopics, topEntities, topPersons, memberNodeIds.length)
      }
    } else {
      // Heuristic path: construct summary from frequency data
      summaryLabel = buildHeuristicSummary(topTopics, topEntities, topPersons, memberNodeIds.length)
    }

    // Step 6: Create/update :Community node in Neo4j + MEMBER_OF relationships
    const projectPrefix = opts?.projectId ?? 'global'
    const communityNodeId = `community:${projectPrefix}:${communityId}`

    await graph.upsertCommunityNode({
      id: communityNodeId,
      communityId,
      label: summaryLabel,
      memberCount: memberNodeIds.length,
      topEntities,
      topTopics,
      topPersons,
      dominantEmotion,
      generatedAt: new Date().toISOString(),
      projectId: opts?.projectId ?? null,
      memberNodeIds,
    })

    // Step 7: Write to SQL cache for fast MCP queries
    await writeCommunityCache(storage, {
      communityId: communityNodeId,
      projectId: opts?.projectId ?? null,
      label: summaryLabel,
      memberCount: memberNodeIds.length,
      topEntities,
      topTopics,
      topPersons,
      dominantEmotion,
    })

    communitySummariesGenerated++
  }
}
```

**Helper functions (module scope in `dream-cycle.ts`):**

```typescript
function topNByFrequency(freq: Map<string, number>, n: number): string[] {
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label]) => label)
}

function buildHeuristicSummary(
  topTopics: string[],
  topEntities: string[],
  topPersons: string[],
  memberCount: number
): string {
  const parts: string[] = []
  if (topTopics.length > 0) parts.push(`discussions about ${topTopics.slice(0, 2).join(' and ')}`)
  if (topEntities.length > 0) parts.push(`involving ${topEntities.slice(0, 2).join(' and ')}`)
  if (topPersons.length > 0) parts.push(`with ${topPersons[0]}`)
  return parts.length > 0
    ? `A cluster of ${memberCount} memories covering ${parts.join(', ')}.`
    : `A cluster of ${memberCount} related memories.`
}

async function writeCommunityCache(
  storage: StorageAdapter,
  data: {
    communityId: string
    projectId: string | null
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
  }
): Promise<void> {
  // The storage adapter must expose a saveCommunityCache method (added in Wave 5).
  // If not available (e.g., during testing without full adapter), skip silently.
  if (typeof (storage as { saveCommunityCache?: unknown }).saveCommunityCache === 'function') {
    await (storage as { saveCommunityCache: (data: typeof data) => Promise<void> }).saveCommunityCache(data)
  }
}
```

**Add to `ConsolidateResult` in `packages/core/src/types.ts`:**
```typescript
communitySummariesGenerated?: number
```

### 1.6 `StorageAdapter` Community Cache Method

**File to modify:** `packages/core/src/adapters/storage.ts`

Add optional community cache methods (optional because graph-only setups may skip SQL caching):

```typescript
export interface StorageAdapter {
  // ... existing methods ...

  // Wave 5: community summary SQL cache (optional — used by MCP for fast queries)
  saveCommunityCache?(data: {
    communityId: string
    projectId: string | null
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
  }): Promise<void>

  getCommunitySummaries?(opts?: {
    projectId?: string
    limit?: number
  }): Promise<Array<{
    communityId: string
    projectId: string | null
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
    generatedAt: string
  }>>
}
```

### 1.7 SQLite Community Cache Implementation

**File to modify:** `packages/sqlite/src/adapter.ts`

```typescript
async saveCommunityCache(data: {
  communityId: string
  projectId: string | null
  label: string
  memberCount: number
  topEntities: string[]
  topTopics: string[]
  topPersons: string[]
  dominantEmotion: string | null
}): Promise<void> {
  this.db.prepare(`
    INSERT INTO community_summaries
      (community_id, project_id, label, member_count, top_entities, top_topics,
       top_persons, dominant_emotion, generated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, julianday('now'), julianday('now'))
    ON CONFLICT(community_id) DO UPDATE SET
      label            = excluded.label,
      member_count     = excluded.member_count,
      top_entities     = excluded.top_entities,
      top_topics       = excluded.top_topics,
      top_persons      = excluded.top_persons,
      dominant_emotion = excluded.dominant_emotion,
      updated_at       = julianday('now')
  `).run(
    data.communityId,
    data.projectId ?? null,
    data.label,
    data.memberCount,
    JSON.stringify(data.topEntities),
    JSON.stringify(data.topTopics),
    JSON.stringify(data.topPersons),
    data.dominantEmotion ?? null,
  )
}

async getCommunitySummaries(opts?: {
  projectId?: string
  limit?: number
}): Promise<Array<{
  communityId: string
  projectId: string | null
  label: string
  memberCount: number
  topEntities: string[]
  topTopics: string[]
  topPersons: string[]
  dominantEmotion: string | null
  generatedAt: string
}>> {
  const limit = opts?.limit ?? 20
  let sql: string
  let params: unknown[]

  if (opts?.projectId !== undefined) {
    sql = `SELECT * FROM community_summaries
           WHERE (project_id = ? OR project_id IS NULL)
           ORDER BY member_count DESC LIMIT ?`
    params = [opts.projectId, limit]
  } else {
    sql = `SELECT * FROM community_summaries ORDER BY member_count DESC LIMIT ?`
    params = [limit]
  }

  const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  return rows.map(r => ({
    communityId: r.community_id as string,
    projectId: r.project_id as string | null,
    label: r.label as string,
    memberCount: r.member_count as number,
    topEntities: JSON.parse(r.top_entities as string),
    topTopics: JSON.parse(r.top_topics as string),
    topPersons: JSON.parse(r.top_persons as string),
    dominantEmotion: r.dominant_emotion as string | null,
    generatedAt: String(r.generated_at),
  }))
}
```

### 1.8 Community-Aware Spreading Activation

**File to modify:** `packages/graph/src/neural-graph.ts`

In the `spreadActivation()` method, after the Cypher spreading activation query returns the activation map, add a post-processing Cypher query that activates `:Community` nodes when 2+ of their `MEMBER_OF` source nodes were activated:

```typescript
// After spreading activation returns activationMap...

// Community node activation: find communities where 2+ member nodes were activated
if (activatedNodeIds.length > 0) {
  const communityResult = await this.runCypher(`
    UNWIND $activatedIds AS activatedId
    MATCH (m:Memory {id: activatedId})-[:MEMBER_OF]->(c:Community)
    WITH c, collect(m) AS activatedMembers,
         avg($activationMap[activatedId]) AS avgActivation
    WHERE size(activatedMembers) >= 2
    RETURN c.id AS communityId, c.label AS label, c.memberCount AS memberCount,
           size(activatedMembers) AS activatedCount, avgActivation * 0.8 AS activation
  `, {
    activatedIds: activatedNodeIds,
    activationMap: Object.fromEntries(activationMap),
  })

  for (const record of communityResult.records) {
    const activation = record.get('activation') as number
    if (activation >= this.config.threshold) {
      activationMap.set(record.get('communityId') as string, activation)
    }
  }
}
```

Note: If the Cypher map parameter approach doesn't work cleanly with neo4j-driver, an alternative is to pass activated IDs and compute the average in a separate step in TypeScript. The key constraint is: community activation requires 2+ activated members.

### 1.9 Community Nodes in Recall Context Assembly

**File to modify:** `packages/core/src/retrieval/engine.ts`

After spreading activation returns results, query Neo4j for any activated `:Community` nodes and append their labels to the formatted output.

In the `recall()` function, after spreading activation completes and before calling `formatMemories()`:

```typescript
// Extract community summaries from activated community nodes
const communitySummaries: string[] = []
if (graph) {
  const communityNodeIds = [...activationMap.keys()].filter(id => id.startsWith('community:'))
  if (communityNodeIds.length > 0) {
    const communityResult = await graph.runCypher(`
      UNWIND $ids AS communityId
      MATCH (c:Community {id: communityId})
      RETURN c.label AS label, c.memberCount AS memberCount
      ORDER BY c.memberCount DESC
    `, { ids: communityNodeIds })

    for (const record of communityResult.records) {
      const label = record.get('label') as string
      const memberCount = (record.get('memberCount') as { toNumber(): number }).toNumber()
      communitySummaries.push(`${label} (${memberCount} related memories)`)
    }
  }
}
```

Extend `formatMemories()` to accept an optional third argument:

```typescript
function formatMemories(
  memories: RetrievedMemory[],
  associations: RetrievedMemory[],
  communitySummaries?: string[]
): string {
  // ... existing lines setup ...

  if (communitySummaries && communitySummaries.length > 0) {
    lines.push('\n### Knowledge Domain Context\n')
    for (const summary of communitySummaries) {
      lines.push(`- ${summary}`)
    }
  }

  // ... rest of existing implementation ...
}
```

### 1.10 New MCP Tool: `memory_overview`

**File to modify:** `packages/mcp/src/index.ts`

Add `memory_overview` to the `ListToolsRequestSchema` handler tools array:

```typescript
{
  name: 'memory_overview',
  description:
    'Returns a high-level summary of what Engram knows, organized by knowledge clusters. Use this to understand what topics, projects, or domains are heavily represented in memory. Optionally filter by topic to find related clusters.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      topic: {
        type: 'string',
        description: 'Optional topic filter. If provided, returns clusters whose summary or top entities match this topic.',
      },
      max_communities: {
        type: 'number',
        description: 'Maximum number of communities to return. Default 5.',
      },
      project_id: {
        type: 'string',
        description: 'Optional project namespace to scope the query.',
      },
    },
    required: [],
  },
},
```

Add handler in `CallToolRequestSchema`:

```typescript
if (name === 'memory_overview') {
  const topic = typeof args['topic'] === 'string' ? args['topic'].trim() : undefined
  const maxCommunities = typeof args['max_communities'] === 'number'
    ? Math.min(args['max_communities'], 20)
    : 5
  const projectId = typeof args['project_id'] === 'string' ? args['project_id'] : undefined

  const communities = await mem.getCommunitySummaries({ topic, limit: maxCommunities, projectId })

  if (communities.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No knowledge clusters found. Run a dream cycle consolidation to generate community summaries.' }],
    }
  }

  const lines = ['## Engram — Knowledge Domain Overview', '']
  for (const c of communities) {
    lines.push(`### ${c.label}`)
    lines.push(`- Members: ${c.memberCount} memories`)
    if (c.topTopics.length > 0) lines.push(`- Topics: ${c.topTopics.join(', ')}`)
    if (c.topEntities.length > 0) lines.push(`- Entities: ${c.topEntities.join(', ')}`)
    if (c.topPersons.length > 0) lines.push(`- People: ${c.topPersons.join(', ')}`)
    if (c.dominantEmotion) lines.push(`- Dominant tone: ${c.dominantEmotion}`)
    lines.push('')
  }

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  }
}
```

### 1.11 `Memory.getCommunitySummaries()` Method

**File to modify:** `packages/core/src/memory.ts`

```typescript
async getCommunitySummaries(opts?: {
  topic?: string
  limit?: number
  projectId?: string
}): Promise<Array<{
  communityId: string
  label: string
  memberCount: number
  topEntities: string[]
  topTopics: string[]
  topPersons: string[]
  dominantEmotion: string | null
}>> {
  this.assertInitialized()

  // Prefer Neo4j direct query when graph is available
  if (this._graph) {
    const communities = await this._graph.queryCommunities({
      projectId: opts?.projectId,
      limit: opts?.limit ?? 5,
    })

    if (!opts?.topic) return communities

    const needle = opts.topic.toLowerCase()
    return communities.filter(c =>
      c.label.toLowerCase().includes(needle) ||
      c.topTopics.some(t => t.toLowerCase().includes(needle)) ||
      c.topEntities.some(e => e.toLowerCase().includes(needle))
    )
  }

  // Fallback: SQL cache
  if (this.storage.getCommunitySummaries) {
    const all = await this.storage.getCommunitySummaries({
      projectId: opts?.projectId,
      limit: opts?.limit ?? 5,
    })

    if (!opts?.topic) return all

    const needle = opts.topic.toLowerCase()
    return all.filter(c =>
      c.label.toLowerCase().includes(needle) ||
      c.topTopics.some(t => t.toLowerCase().includes(needle)) ||
      c.topEntities.some(e => e.toLowerCase().includes(needle))
    )
  }

  return []
}
```

---

## Part 2: Pattern Completion

### 2.1 The Design Decision

Pattern completion is a fallback, not a replacement. The trigger condition is:
- Intent classified as `RECALL_EXPLICIT`
- AND top vector search score is < 0.2 (vector search cannot find a good anchor)

When triggered, the fallback:
1. Runs `extractEntities()` on the query text (reuses the existing entity extractor)
2. Detects emotion keywords from the query
3. Finds matching context nodes in Neo4j via Cypher (indexed lookups, not full scans)
4. Uses those matching context nodes as spreading activation seeds (alongside any weak vector seeds)
5. Produces an activation map where memories connected to multiple matching attributes get convergence bonuses

### 2.2 `NeuralGraph` Methods for Pattern Completion

**File to modify:** `packages/graph/src/neural-graph.ts`

Add methods for attribute-based node lookup:

```typescript
/**
 * Find graph nodes matching query attributes for pattern completion.
 * Uses indexed Cypher lookups — NOT full graph scans.
 */
async findMatchingContextNodes(input: {
  entities: string[]
  emotions: string[]
  persons: string[]
  topics: string[]
}): Promise<Array<{ attributeType: string; nodeIds: string[] }>> {
  const seedsByAttribute: Array<{ attributeType: string; nodeIds: string[] }> = []

  // Entity/Topic matching via Cypher — case-insensitive CONTAINS
  if (input.entities.length > 0) {
    const result = await this.runCypher(`
      UNWIND $needles AS needle
      MATCH (n)
      WHERE (n:Entity OR n:Topic)
        AND toLower(n.label) CONTAINS toLower(needle)
      RETURN DISTINCT n.id AS nodeId
    `, { needles: input.entities })

    const nodeIds = result.records.map(r => r.get('nodeId') as string)
    if (nodeIds.length > 0) {
      seedsByAttribute.push({ attributeType: 'entity', nodeIds })
    }
  }

  // Person matching via Cypher
  if (input.persons.length > 0) {
    const result = await this.runCypher(`
      UNWIND $needles AS needle
      MATCH (n:Person)
      WHERE toLower(n.label) CONTAINS toLower(needle)
      RETURN DISTINCT n.id AS nodeId
    `, { needles: input.persons })

    const nodeIds = result.records.map(r => r.get('nodeId') as string)
    if (nodeIds.length > 0) {
      seedsByAttribute.push({ attributeType: 'person', nodeIds })
    }
  }

  // Emotion matching via Cypher
  const emotionLabels = ['positive', 'negative', 'neutral', 'urgent']
  const canonicalEmotions = input.emotions
    .map(e => emotionLabels.find(el => e.toLowerCase().includes(el) || el.includes(e.toLowerCase())))
    .filter((e): e is string => e !== undefined)

  if (canonicalEmotions.length > 0) {
    const result = await this.runCypher(`
      UNWIND $emotions AS emotion
      MATCH (n:Emotion)
      WHERE toLower(n.label) = emotion
      RETURN DISTINCT n.id AS nodeId
    `, { emotions: canonicalEmotions })

    const nodeIds = result.records.map(r => r.get('nodeId') as string)
    if (nodeIds.length > 0) {
      seedsByAttribute.push({ attributeType: 'emotion', nodeIds })
    }
  }

  // Topic matching (separate from entity for priority handling)
  if (input.topics.length > 0) {
    const result = await this.runCypher(`
      UNWIND $needles AS needle
      MATCH (n:Topic)
      WHERE toLower(n.label) CONTAINS toLower(needle)
      RETURN DISTINCT n.id AS nodeId
    `, { needles: input.topics })

    const nodeIds = result.records.map(r => r.get('nodeId') as string)
    if (nodeIds.length > 0) {
      seedsByAttribute.push({ attributeType: 'topic', nodeIds })
    }
  }

  return seedsByAttribute
}
```

### 2.3 New Function: `runPatternCompletion()` in `@engram-mem/graph`

**File to create:** `packages/graph/src/pattern-completion.ts`

```typescript
import type { NeuralGraph } from './neural-graph.js'
import type { ActivatedNode } from './types.js'

export interface PatternCompletionInput {
  entities: string[]
  emotions: string[]
  persons: string[]
  topics: string[]
}

export interface PatternCompletionResult {
  activationResults: ActivatedNode[]
  seedsUsed: number
  convergenceMap: Map<string, number>
}

/**
 * Given partial cue attributes, find matching context nodes in Neo4j,
 * run spreading activation from each attribute group independently,
 * and apply convergence bonuses to Memory nodes reached from multiple attributes.
 *
 * All graph operations use Cypher via NeuralGraph — no in-process iteration.
 */
export async function runPatternCompletion(
  graph: NeuralGraph,
  input: PatternCompletionInput,
  config?: { maxHops?: number; decay?: number; threshold?: number }
): Promise<PatternCompletionResult> {
  const threshold = config?.threshold ?? 0.01

  // Step 1: Find matching context nodes via Cypher
  const seedsByAttribute = await graph.findMatchingContextNodes(input)

  if (seedsByAttribute.length === 0) {
    return { activationResults: [], seedsUsed: 0, convergenceMap: new Map() }
  }

  // Step 2: Run spreading activation from EACH attribute group independently
  // This lets us measure how many independent attribute paths converge on a memory
  const perAttributeActivations: Array<Map<string, number>> = []

  for (const { nodeIds } of seedsByAttribute) {
    const seedActivations = new Map<string, number>()
    for (const nodeId of nodeIds) {
      seedActivations.set(nodeId, 0.8) // 0.8 multiplier for pattern-completion seeds
    }

    const results = await graph.spreadActivation({
      seedNodeIds: nodeIds,
      seedActivations,
      maxHops: config?.maxHops ?? 3,
      decay: config?.decay ?? 0.5,
      threshold,
    })

    const activationMap = new Map<string, number>()
    for (const r of results) {
      activationMap.set(r.nodeId, r.activation)
    }
    perAttributeActivations.push(activationMap)
  }

  // Step 3: Build convergence map — for each Memory node, count how many
  // attribute groups activated it above threshold
  const convergenceMap = new Map<string, number>()
  const mergedActivation = new Map<string, number>()

  for (const attributeMap of perAttributeActivations) {
    for (const [nodeId, activation] of attributeMap) {
      // Only count convergence on Memory nodes (they start with UUID or known prefix)
      // We need to check if it's a Memory node. Since we can't iterate nodeType
      // in-process, filter by node ID convention: Memory IDs are UUIDs,
      // context nodes have prefixes like 'person:', 'entity:', 'topic:', etc.
      if (nodeId.includes(':')) continue // skip context nodes
      convergenceMap.set(nodeId, (convergenceMap.get(nodeId) ?? 0) + 1)
      const existing = mergedActivation.get(nodeId) ?? 0
      mergedActivation.set(nodeId, Math.max(existing, activation))
    }
  }

  // Step 4: Apply convergence bonus — each additional attribute that confirms a memory
  // multiplies its activation by 1.2
  for (const [nodeId, convergenceCount] of convergenceMap) {
    if (convergenceCount < 2) continue
    const base = mergedActivation.get(nodeId) ?? 0
    const bonus = Math.pow(1.2, convergenceCount - 1)
    mergedActivation.set(nodeId, Math.min(1.0, base * bonus))
  }

  // Step 5: Convert to ActivatedNode array, sorted by activation DESC
  const activationResults: ActivatedNode[] = []
  for (const [nodeId, activation] of mergedActivation) {
    if (activation < threshold) continue
    activationResults.push({
      nodeId,
      nodeType: 'memory',
      activation,
      depth: 0,
      path: [],
    })
  }
  activationResults.sort((a, b) => b.activation - a.activation)

  return {
    activationResults,
    seedsUsed: seedsByAttribute.length,
    convergenceMap,
  }
}
```

### 2.4 Emotion Keyword Extraction for Pattern Completion

**File to create:** `packages/graph/src/emotion-extractor.ts`

```typescript
const POSITIVE_KEYWORDS = [
  'happy', 'excited', 'great', 'excellent', 'good', 'success', 'worked', 'solved',
  'fixed', 'done', 'finished', 'completed', 'deployed', 'shipped',
]

const NEGATIVE_KEYWORDS = [
  'frustrated', 'angry', 'broken', 'failed', 'error', 'crash',
  'stuck', 'blocked', 'wrong', 'bad', 'terrible', 'awful', 'annoyed', 'confused',
]

const URGENT_KEYWORDS = [
  'urgent', 'critical', 'asap', 'immediately', 'production', 'down', 'outage',
  'emergency', 'priority',
]

/**
 * Extract emotion keywords from text for use as pattern completion attributes.
 * Returns canonical emotion labels: 'positive', 'negative', 'neutral', 'urgent'
 */
export function extractEmotionKeywords(text: string): string[] {
  const lower = text.toLowerCase()
  const emotions = new Set<string>()

  if (URGENT_KEYWORDS.some(k => lower.includes(k))) emotions.add('urgent')
  if (NEGATIVE_KEYWORDS.some(k => lower.includes(k))) emotions.add('negative')
  if (POSITIVE_KEYWORDS.some(k => lower.includes(k))) emotions.add('positive')

  return [...emotions]
}
```

Export from `packages/graph/src/index.ts`:
```typescript
export { runPatternCompletion } from './pattern-completion.js'
export type { PatternCompletionInput, PatternCompletionResult } from './pattern-completion.js'
export { extractEmotionKeywords } from './emotion-extractor.js'
```

### 2.5 Integration in the Retrieval Engine

**File to modify:** `packages/core/src/retrieval/engine.ts`

In the `recall()` function, after the HyDE fallback block and before Stage 2 (association walk), insert the pattern completion fallback:

```typescript
// Pattern completion fallback: triggered when:
// 1. Intent is RECALL_EXPLICIT (query has recall keywords)
// 2. Top vector/BM25 score is below the weak-seed threshold (0.2)
// 3. The graph is available
const topScore = memories[0]?.relevance ?? 0
const isRecallExplicit = /\b(remember|recall|what did|did we|last time|previously|have we|remind me)\b/i.test(query)

if (graph && isRecallExplicit && topScore < 0.2) {
  try {
    const { runPatternCompletion } = await import('@engram-mem/graph')
    const { extractEmotionKeywords } = await import('@engram-mem/graph')

    // Extract attributes from the query text
    const queryEntities = extractEntities(query)         // existing @engram-mem/core function
    const queryEmotions = extractEmotionKeywords(query)  // new @engram-mem/graph function

    // Separate person-like entities from tech entities
    const queryPersons = queryEntities.filter(e => /^[A-Z][a-z]/.test(e))
    const queryTopics = queryEntities.filter(e => !/^[A-Z][a-z]/.test(e))

    const completionResult = await runPatternCompletion(graph, {
      entities: queryEntities,
      emotions: queryEmotions,
      persons: queryPersons,
      topics: queryTopics,
    })

    if (completionResult.activationResults.length > 0) {
      // Resolve activated Memory node IDs back to SQL content
      const memoryIds = completionResult.activationResults
        .slice(0, strategy.maxResults)
        .map(r => r.nodeId)

      const patternMemories: RetrievedMemory[] = []
      for (let i = 0; i < memoryIds.length; i++) {
        const memoryId = memoryIds[i]
        const activation = completionResult.activationResults[i].activation

        const typed = await storage.getById(memoryId)
        if (!typed) continue

        const content = getMemoryContent(typed)
        patternMemories.push({
          id: memoryId,
          type: typed.type,
          content,
          relevance: activation,
          source: 'association',
          metadata: {
            ...typed.data.metadata,
            patternCompletion: true,
            convergenceCount: completionResult.convergenceMap.get(memoryId) ?? 1,
          },
        })
      }

      // Merge with existing weak vector results: deduplicate, sort by relevance
      if (patternMemories.length > 0) {
        const merged = new Map<string, RetrievedMemory>()
        for (const m of [...memories, ...patternMemories]) {
          const existing = merged.get(m.id)
          if (!existing || m.relevance > existing.relevance) {
            merged.set(m.id, m)
          }
        }
        memories = Array.from(merged.values())
          .sort((a, b) => b.relevance - a.relevance)
          .slice(0, strategy.maxResults)
      }
    }
  } catch (err) {
    console.error('[engram] pattern completion fallback error:', err)
    // non-fatal: continue with existing weak results
  }
}
```

**Add helper function `getMemoryContent()` in `engine.ts`:**

```typescript
function getMemoryContent(typed: TypedMemory): string {
  switch (typed.type) {
    case 'episode': return typed.data.content
    case 'digest': return typed.data.summary
    case 'semantic': return `${typed.data.topic}: ${typed.data.content}`
    case 'procedural': return `${typed.data.trigger}: ${typed.data.procedure}`
  }
}
```

The `graph` parameter needs to be threaded into `recall()`. The `RecallOpts` interface gains:
```typescript
export interface RecallOpts {
  strategy: RecallStrategy
  embedding: number[]
  intelligence?: IntelligenceAdapter
  sessionId?: string
  tokenBudget?: number
  asOf?: Date               // Wave 4
  graph?: NeuralGraph | null // Wave 5
}
```

And in `Memory.recall()`, pass `this._graph` into the opts:
```typescript
const result = await engineRecall(query, this.storage, this.sensory, {
  strategy,
  embedding: embedding ?? [],
  tokenBudget: opts?.tokenBudget,
  intelligence: this.intelligence,
  asOf: opts?.asOf,
  graph: this._graph,
})
```

---

## Part 3: Project Namespace Isolation

### 3.1 The Design

Every memory operation accepts an optional `projectId: string`. When set:
- Ingested episodes, digests, semantic memories, procedural memories are tagged with `project_id` in SQL
- All SQL queries add `AND (project_id = ? OR project_id IS NULL)` to filter results to the project
- Neo4j nodes get a `projectId` property set during MERGE; spreading activation Cypher includes a `projectId` WHERE clause
- Community summary generation is scoped per project

When NOT set (backward compatibility):
- All existing behavior unchanged
- Queries return all memories regardless of `project_id`
- Existing rows with `project_id IS NULL` remain accessible to all queries

**Cross-project shared nodes:** `Person` and `Entity` nodes are NOT scoped to a project. A `:Person` node for "Sarah" exists once in Neo4j and can have relationships to `:Memory` nodes from multiple projects. This is intentional — it enables cross-project bridge queries.

### 3.2 SQL Schema Changes

The `project_id` columns and indexes are included in the `SCHEMA_V4` migration defined in Part 1, Section 1.3 above. No separate migration needed.

Note: there are NO `graph_nodes` or `graph_edges` SQL tables to alter. Graph data lives in Neo4j.

### 3.3 `MemoryOptions` Change

**File to modify:** `packages/core/src/memory.ts`

Add `projectId` to `MemoryOptions`:

```typescript
export interface MemoryOptions {
  storage: StorageAdapter
  intelligence?: IntelligenceAdapter
  consolidation?: { schedule: 'auto' | 'manual' }
  tokenizer?: (text: string) => number
  graph?: boolean
  projectId?: string  // Wave 5: namespace all operations to this project
}
```

Store it on the `Memory` instance:
```typescript
private projectId: string | undefined

constructor(opts: MemoryOptions) {
  this.storage = opts.storage
  this.intelligence = opts.intelligence
  this.sensory = new SensoryBuffer()
  this.intentAnalyzer = new HeuristicIntentAnalyzer()
  this.projectId = opts.projectId
}
```

### 3.4 `SearchOptions` Change

**File to modify:** `packages/core/src/types.ts`

Add `projectId` to `SearchOptions`:

```typescript
export interface SearchOptions {
  limit?: number
  minScore?: number
  sessionId?: string
  embedding?: number[]
  beforeDate?: Date    // Wave 4
  projectId?: string   // Wave 5
}
```

Also add `projectId` to `StorageAdapter` methods:

```typescript
export interface StorageAdapter {
  vectorSearch(embedding: number[], opts?: {
    limit?: number
    sessionId?: string
    tiers?: MemoryType[]
    projectId?: string
  }): Promise<SearchResult<TypedMemory>[]>

  textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
    projectId?: string
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>>
}
```

### 3.5 Data Model Changes

Add `projectId: string | null` to `Episode`, `Digest`, `SemanticMemory`, and `ProceduralMemory` interfaces in `packages/core/src/types.ts`:

```typescript
export interface Episode {
  // ... existing fields ...
  projectId: string | null  // Wave 5
}
```

### 3.6 SQLite Storage: Writing and Filtering by projectId

**Files to modify:** `packages/sqlite/src/episodes.ts`, `digests.ts`, `semantic.ts`, `procedural.ts`

In each `insert()` method, add `project_id` to the INSERT statement:
```typescript
// Example for episodes:
this.db.prepare(`
  INSERT INTO episodes
    (id, session_id, role, content, salience, embedding, entities_json,
     metadata, project_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  id, episode.sessionId, episode.role, episode.content,
  episode.salience, embeddingBlob, entitiesJson, metadataJson,
  episode.projectId ?? null,
)
```

In `rowTo*()` helpers, add:
```typescript
projectId: row.project_id ?? null,
```

### 3.7 SQLite Adapter: vectorSearch and textBoost with projectId

**File to modify:** `packages/sqlite/src/adapter.ts`

In `vectorSearch()`, add WHERE clause when projectId is provided:

```typescript
if (opts?.projectId) {
  conditions.push('(project_id = ? OR project_id IS NULL)')
  params.push(opts.projectId)
}
```

Same pattern for `textBoost()` and each FTS query.

### 3.8 Neo4j Node Project Scoping

When ingestion creates nodes via `NeuralGraph.decomposeEpisode()`, the `projectId` is passed as a node property in the Cypher MERGE:

```typescript
// In NeuralGraph.decomposeEpisode():
// Memory, Topic, Emotion, Intent, Session, TimeContext nodes get projectId
// Person and Entity nodes do NOT get projectId (cross-project bridges)

await this.runCypherWrite(`
  MERGE (m:Memory {id: $id})
  SET m.label = $label,
      m.memoryType = $memoryType,
      m.projectId = $projectId,
      m.createdAt = $createdAt
`, {
  id: episode.id,
  label: episode.content.slice(0, 100),
  memoryType: 'episode',
  projectId: episode.projectId ?? null,
  createdAt: new Date().toISOString(),
})
```

### 3.9 Spreading Activation Project Boundary

**File to modify:** `packages/graph/src/neural-graph.ts`

Add optional `projectId` to `SpreadActivationOpts`:

```typescript
export interface SpreadActivationOpts {
  seedNodeIds: string[]
  seedActivations?: Map<string, number>
  maxHops?: number
  decay?: number
  threshold?: number
  edgeFilter?: string[]
  asOf?: Date       // Wave 4
  projectId?: string // Wave 5: confine traversal to this project (+ shared nodes)
}
```

In the Cypher variable-length path traversal query, add a project boundary filter:

```cypher
-- In the spreading activation Cypher:
-- When projectId is set, skip Memory nodes tagged to a different project.
-- Person and Entity nodes (projectId IS NULL) are always traversable.
MATCH p = (seed)-[*1..$maxHops]-(neighbor)
WHERE seed.id IN $seedNodeIds
  AND (
    $projectId IS NULL
    OR neighbor.projectId IS NULL
    OR neighbor.projectId = $projectId
  )
  AND (
    $asOfMs IS NULL
    OR (
      (neighbor.validFrom IS NULL OR neighbor.validFrom <= $asOfMs)
      AND (neighbor.validUntil IS NULL OR neighbor.validUntil > $asOfMs)
    )
  )
RETURN DISTINCT neighbor.id AS nodeId, neighbor.label AS label
```

### 3.10 MCP Tool Changes: Optional `project_id` Parameter

**File to modify:** `packages/mcp/src/index.ts`

Add `project_id` as an optional parameter to all existing tools (`memory_recall`, `memory_ingest`, `memory_forget`, `memory_timeline`). Update each tool's `inputSchema` to include:

```typescript
project_id: {
  type: 'string',
  description: 'Optional project namespace. Scopes this operation to a specific project.',
},
```

The MCP server creates `Memory` instances per unique projectId, cached in a Map:

```typescript
const memoryCache = new Map<string, Memory>()

async function getMemory(projectId?: string): Promise<Memory> {
  const cacheKey = projectId ?? 'global'
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey)!

  const storage = new SupabaseStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  const intelligence = openaiIntelligence({ apiKey: openaiApiKey })

  const memory = createMemory({ storage, intelligence, projectId })
  await memory.initialize()
  memoryCache.set(cacheKey, memory)
  return memory
}
```

In each tool handler, extract `project_id`:
```typescript
const projectId = typeof args['project_id'] === 'string' ? args['project_id'] : undefined
const mem = await getMemory(projectId)
```

### 3.11 Memory.ingest() with projectId

**File to modify:** `packages/core/src/memory.ts`

Pass `this.projectId` when inserting episodes and decomposing into Neo4j:

```typescript
const episode = await this.storage.episodes.insert({
  // ... existing fields ...
  projectId: this.projectId ?? null,
})
```

Thread `projectId` through to:
- `memory.recall()` → `engineRecall()` → `unifiedSearch()` → `vectorSearch()` and `textBoost()`
- `lightSleep()`, `deepSleep()`, `dreamCycle()`, `decayPass()` — all receive `this.projectId` so they only operate on memories belonging to this project

### 3.12 New MCP Tool: `memory_bridges`

**File to modify:** `packages/mcp/src/index.ts`

```typescript
{
  name: 'memory_bridges',
  description:
    'Find shared people or entities that bridge two different projects. Returns cross-project connections — useful for understanding what or who connects two workstreams. Returns labels and counts only, not full memory content from other projects.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_a: { type: 'string', description: 'First project ID.' },
      project_b: { type: 'string', description: 'Second project ID.' },
    },
    required: ['project_a', 'project_b'],
  },
},
```

Handler:

```typescript
if (name === 'memory_bridges') {
  const projectA = args['project_a']
  const projectB = args['project_b']

  if (typeof projectA !== 'string' || typeof projectB !== 'string') {
    return { content: [{ type: 'text' as const, text: 'Error: project_a and project_b are required.' }], isError: true }
  }

  const mem = await getMemory()  // global instance for bridge queries
  const bridges = await mem.findBridges(projectA, projectB)

  if (bridges.length === 0) {
    return { content: [{ type: 'text' as const, text: `No shared entities or people found between ${projectA} and ${projectB}.` }] }
  }

  const lines = [`## Cross-Project Bridges: ${projectA} ↔ ${projectB}`, '']
  for (const b of bridges) {
    lines.push(`### ${b.nodeType === 'person' ? 'Person' : 'Entity'}: ${b.label}`)
    lines.push(`  - ${projectA}: ${b.projectACount} memories`)
    lines.push(`  - ${projectB}: ${b.projectBCount} memories`)
    lines.push('')
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
}
```

### 3.13 `Memory.findBridges()` Method

**File to modify:** `packages/core/src/memory.ts`

```typescript
export interface BridgeResult {
  nodeId: string
  nodeType: 'person' | 'entity'
  label: string
  projectACount: number
  projectBCount: number
  projectALabels: string[]
  projectBLabels: string[]
}

async findBridges(projectA: string, projectB: string): Promise<BridgeResult[]> {
  this.assertInitialized()
  if (!this._graph) return []

  // Single Cypher query — no in-process graph iteration
  return this._graph.findProjectBridges(projectA, projectB)
}
```

---

## Part 4: Conformance Changes to Existing Packages

These are mechanical changes required to satisfy the above interface additions. They must all be made for the system to compile.

### 4.1 `@engram-mem/sqlite` Episode Row

In `packages/sqlite/src/episodes.ts`, the `rowToEpisode()` helper gains:
```typescript
projectId: row.project_id ?? null,
```

In the SELECT statements, add `project_id` to the column list.

### 4.2 `@engram-mem/sqlite` Digest, Semantic, Procedural Storage

Same pattern: add `project_id TEXT` to INSERT statements and `rowTo*()` helpers. The `projectId` value comes from the calling `lightSleep()` / `deepSleep()` which receive it from `Memory.consolidate()`.

Specifically: `lightSleep()`, `deepSleep()`, `dreamCycle()`, and `decayPass()` all gain an optional `opts.projectId?: string` passed into storage insert calls.

### 4.3 `@engram-mem/supabase` Storage

Apply the same changes to all Supabase sub-stores: add `project_id` to INSERT and SELECT operations, with `OR project_id IS NULL` in query filters.

### 4.4 `ConsolidateResult` Extended Fields

In `packages/core/src/types.ts`, the `ConsolidateResult` interface after all wave additions:

```typescript
export interface ConsolidateResult {
  cycle: string
  digestsCreated?: number
  episodesProcessed?: number
  promoted?: number
  procedural?: number
  deduplicated?: number
  superseded?: number
  associationsCreated?: number
  semanticDecayed?: number
  proceduralDecayed?: number
  edgesPruned?: number
  // Wave 3 additions:
  graphNodesCreated?: number
  graphEdgesCreated?: number
  communitiesDetected?: number
  bridgesFound?: number
  replayEdgesCreated?: number
  causalEdgesCreated?: number
  // Wave 5 additions:
  communitySummariesGenerated?: number
}
```

---

## Part 5: Tests

All tests live in `test/` subdirectories within each package. Test framework is Vitest.

**IMPORTANT: Neo4j Test Setup**

Tests that interact with the graph require a running Neo4j instance. Use the test Docker Compose at `docker/docker-compose.neo4j.yml`. Each test suite clears test data before running:

```typescript
import { createNeuralGraph, type NeuralGraph } from '@engram-mem/graph'

let graph: NeuralGraph

beforeAll(async () => {
  graph = createNeuralGraph({
    uri: process.env.NEO4J_TEST_URI ?? 'bolt://localhost:7687',
    username: 'neo4j',
    password: 'engram-dev',
  })
  await graph.connect()
})

afterAll(async () => {
  await graph.disconnect()
})

beforeEach(async () => {
  // Clear all test data
  await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
})
```

### 5.1 Community Summary Tests

**File:** `packages/graph/test/community-summaries.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createNeuralGraph, type NeuralGraph } from '../src/neural-graph.js'

describe('Community summary generation', () => {
  let graph: NeuralGraph

  beforeAll(async () => {
    graph = createNeuralGraph()
    await graph.connect()
  })

  afterAll(async () => {
    await graph.disconnect()
  })

  beforeEach(async () => {
    await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
  })

  it('getCommunityMembers returns communities with >= minSize members', async () => {
    // Create community A: 6 Memory nodes with communityId='0'
    for (let i = 0; i < 6; i++) {
      await graph.runCypherWrite(`
        CREATE (m:Memory {
          id: $id, label: $label, communityId: '0',
          memoryType: 'episode', projectId: null,
          createdAt: datetime().epochMillis
        })
      `, { id: `ep-${i}`, label: `Memory about authentication ${i}` })
    }

    // Create community B: 3 Memory nodes (below threshold)
    for (let i = 0; i < 3; i++) {
      await graph.runCypherWrite(`
        CREATE (m:Memory {
          id: $id, label: $label, communityId: '1',
          memoryType: 'semantic', projectId: null,
          createdAt: datetime().epochMillis
        })
      `, { id: `sm-${i}`, label: `Semantic fact ${i}` })
    }

    const communities = await graph.getCommunityMembers({ minSize: 5 })
    expect(communities.length).toBe(1)
    expect(communities[0].communityId).toBe('0')
    expect(communities[0].memberNodeIds.length).toBe(6)
  })

  it('getCommunityContext returns frequency counts by context type', async () => {
    // Create Memory nodes in community '0' linked to context nodes
    const topicId = 'topic:authentication'
    await graph.runCypherWrite(`CREATE (t:Topic {id: $id, label: 'authentication'})`, { id: topicId })

    for (let i = 0; i < 5; i++) {
      const memId = `ep-${i}`
      await graph.runCypherWrite(`
        CREATE (m:Memory {
          id: $id, label: $label, communityId: '0',
          memoryType: 'episode', projectId: null,
          createdAt: datetime().epochMillis
        })
      `, { id: memId, label: `Memory ${i}` })

      await graph.runCypherWrite(`
        MATCH (m:Memory {id: $memId}), (t:Topic {id: $topicId})
        CREATE (m)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: datetime().epochMillis}]->(t)
      `, { memId, topicId })
    }

    const context = await graph.getCommunityContext('0')
    expect(context.topicFrequency.get('authentication')).toBe(5)
  })

  it('upsertCommunityNode creates Community node and MEMBER_OF relationships', async () => {
    // Create Memory nodes
    for (let i = 0; i < 3; i++) {
      await graph.runCypherWrite(`
        CREATE (m:Memory {id: $id, label: 'mem', communityId: '0', memoryType: 'episode', projectId: null})
      `, { id: `ep-${i}` })
    }

    await graph.upsertCommunityNode({
      id: 'community:global:0',
      communityId: '0',
      label: 'Auth cluster',
      memberCount: 3,
      topEntities: [],
      topTopics: ['authentication'],
      topPersons: [],
      dominantEmotion: null,
      generatedAt: new Date().toISOString(),
      projectId: null,
      memberNodeIds: ['ep-0', 'ep-1', 'ep-2'],
    })

    // Verify Community node exists
    const result = await graph.runCypher(`
      MATCH (c:Community {id: 'community:global:0'})
      RETURN c.label AS label, c.memberCount AS memberCount
    `)
    expect(result.records.length).toBe(1)
    expect(result.records[0].get('label')).toBe('Auth cluster')

    // Verify MEMBER_OF relationships
    const rels = await graph.runCypher(`
      MATCH (m:Memory)-[:MEMBER_OF]->(c:Community {id: 'community:global:0'})
      RETURN count(m) AS count
    `)
    expect(rels.records[0].get('count').toNumber()).toBe(3)
  })
})
```

### 5.2 Pattern Completion Tests

**File:** `packages/graph/test/pattern-completion.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createNeuralGraph, type NeuralGraph } from '../src/neural-graph.js'
import { runPatternCompletion } from '../src/pattern-completion.js'

describe('Pattern completion', () => {
  let graph: NeuralGraph

  beforeAll(async () => {
    graph = createNeuralGraph()
    await graph.connect()
  })

  afterAll(async () => {
    await graph.disconnect()
  })

  beforeEach(async () => {
    await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
  })

  it('finds correct memory from partial attributes (emotion + entity)', async () => {
    // Target memory connected to 'negative' emotion and 'TypeScript' entity
    await graph.runCypherWrite(`
      CREATE (m:Memory {id: 'ep-target', label: 'Muhammad was frustrated about TypeScript types',
                        memoryType: 'episode', projectId: null}),
             (e:Emotion {id: 'emotion:s1:negative', label: 'negative'}),
             (ent:Entity {id: 'entity:typescript', label: 'TypeScript'}),
             (m)-[:EMOTIONAL {weight: 0.9, traversalCount: 0, createdAt: '2026-04-08'}]->(e),
             (m)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(ent)
    `)

    // Decoy memory: unrelated
    await graph.runCypherWrite(`
      CREATE (m:Memory {id: 'ep-decoy', label: 'Deployed successfully', memoryType: 'episode', projectId: null})
    `)

    const result = await runPatternCompletion(graph, {
      entities: ['TypeScript'],
      emotions: ['frustrated'],  // maps to 'negative'
      persons: [],
      topics: [],
    })

    expect(result.activationResults.length).toBeGreaterThan(0)
    expect(result.activationResults[0].nodeId).toBe('ep-target')
    expect(result.seedsUsed).toBeGreaterThan(0)
  })

  it('applies convergence bonus when multiple attributes reach the same memory', async () => {
    await graph.runCypherWrite(`
      CREATE (m:Memory {id: 'ep-t', label: 'Target', memoryType: 'episode', projectId: null}),
             (e:Emotion {id: 'emotion:s1:negative', label: 'negative'}),
             (ent:Entity {id: 'entity:postgresql', label: 'PostgreSQL'}),
             (t:Topic {id: 'topic:migrations', label: 'migrations'}),
             (m)-[:EMOTIONAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(e),
             (m)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(ent),
             (m)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(t)
    `)

    const result = await runPatternCompletion(graph, {
      entities: ['PostgreSQL', 'migrations'],
      emotions: ['negative'],
      persons: [],
      topics: ['migrations'],
    })

    const targetResult = result.activationResults.find(r => r.nodeId === 'ep-t')
    expect(targetResult).toBeDefined()
    expect(result.convergenceMap.get('ep-t')!).toBeGreaterThan(1)
  })

  it('returns empty results when no graph nodes match any attribute', async () => {
    await graph.runCypherWrite(`
      CREATE (m:Memory {id: 'ep1', label: 'Some memory', memoryType: 'episode', projectId: null})
    `)

    const result = await runPatternCompletion(graph, {
      entities: ['NonexistentEntity'],
      emotions: [],
      persons: [],
      topics: [],
    })

    expect(result.activationResults).toHaveLength(0)
    expect(result.seedsUsed).toBe(0)
  })
})
```

### 5.3 Pattern Completion Fallback Trigger Tests

**File:** `packages/core/test/pattern-completion-integration.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'

describe('Pattern completion fallback trigger', () => {
  it('only triggers when top vector score < 0.2 AND query is RECALL_EXPLICIT', async () => {
    // Mock: vector search returns a result with relevance = 0.15
    // Mock: query = "remember when someone was frustrated about databases"
    // Assert: patternCompletion is called (mock assertion)
  })

  it('does NOT trigger when top vector score >= 0.2', async () => {
    // Mock: vector search returns result with relevance = 0.35
    // Assert: patternCompletion is NOT called
  })

  it('does NOT trigger for non-RECALL_EXPLICIT queries even with weak scores', async () => {
    // Query: "what is TypeScript?" (not recall-explicit)
    // Mock: weak vector score
    // Assert: patternCompletion is NOT called
  })
})
```

### 5.4 Namespace Isolation Tests

**File:** `packages/sqlite/test/namespace.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteStorageAdapter } from '../src/adapter.js'

describe('Project namespace isolation', () => {
  let storage: SqliteStorageAdapter

  beforeEach(async () => {
    storage = new SqliteStorageAdapter(':memory:')
    await storage.initialize()
  })

  afterEach(async () => {
    await storage.dispose()
  })

  it('vectorSearch with projectId only returns matching project memories', async () => {
    // Insert episode with projectId='alpha'
    // Insert episode with projectId='beta'
    // Both have similar embeddings
    // Query with projectId='alpha': only 'alpha' episode returned
    // Query with projectId='beta': only 'beta' episode returned
  })

  it('vectorSearch without projectId returns ALL memories (backward compat)', async () => {
    // Insert episodes with projectId='alpha' and projectId='beta'
    // Query with no projectId: both returned
  })

  it('memories with project_id IS NULL are always returned when projectId filter active', async () => {
    // Insert episode with project_id=NULL (old data, no project)
    // Insert episode with project_id='alpha'
    // Query with projectId='beta': NULL episode IS returned, 'alpha' is NOT
  })
})
```

### 5.5 Namespace Integration Tests

**File:** `packages/core/test/namespace-integration.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { createMemory } from '../src/create-memory.js'
import { SqliteStorageAdapter } from '@engram-mem/sqlite'

describe('Namespace integration', () => {
  it('memories ingested into project_a are not visible in project_b', async () => {
    const storage = new SqliteStorageAdapter(':memory:')

    const memA = createMemory({ storage, projectId: 'alpha', graph: false })
    const memB = createMemory({ storage, projectId: 'beta', graph: false })

    await memA.initialize()
    await memB.initialize()

    await memA.ingest({ role: 'user', content: 'Alpha project: We decided to use PostgreSQL' })
    await memB.ingest({ role: 'user', content: 'Beta project: We decided to use MongoDB' })

    const resultA = await memA.recall('database decision')
    const resultB = await memB.recall('database decision')

    expect(resultA.memories.some(m => m.content.includes('PostgreSQL'))).toBe(true)
    expect(resultA.memories.some(m => m.content.includes('MongoDB'))).toBe(false)

    expect(resultB.memories.some(m => m.content.includes('MongoDB'))).toBe(true)
    expect(resultB.memories.some(m => m.content.includes('PostgreSQL'))).toBe(false)

    await memA.dispose()
    await memB.dispose()
    await storage.dispose()
  })

  it('Memory with no projectId sees all memories (backward compat)', async () => {
    const storage = new SqliteStorageAdapter(':memory:')
    const memAll = createMemory({ storage, graph: false })
    const memA = createMemory({ storage, projectId: 'alpha', graph: false })

    await memAll.initialize()
    await memA.initialize()

    await memA.ingest({ role: 'user', content: 'Alpha: the migration is complete' })

    const result = await memAll.recall('migration complete')
    expect(result.memories.length).toBeGreaterThan(0)

    await memAll.dispose()
    await memA.dispose()
    await storage.dispose()
  })
})
```

### 5.6 Bridge Query Tests

**File:** `packages/graph/test/bridges.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createNeuralGraph, type NeuralGraph } from '../src/neural-graph.js'

describe('Cross-project bridge queries', () => {
  let graph: NeuralGraph

  beforeAll(async () => {
    graph = createNeuralGraph()
    await graph.connect()
  })

  afterAll(async () => {
    await graph.disconnect()
  })

  beforeEach(async () => {
    await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
  })

  it('finds shared Person node bridging two projects', async () => {
    await graph.runCypherWrite(`
      CREATE (p:Person {id: 'person:sarah', label: 'Sarah'}),
             (m1:Memory {id: 'ep-1', label: 'Sarah approved alpha architecture', projectId: 'alpha', memoryType: 'episode'}),
             (m2:Memory {id: 'ep-2', label: 'Sarah reviewed beta deployment', projectId: 'beta', memoryType: 'episode'}),
             (p)-[:SPOKE {weight: 0.9, traversalCount: 0, createdAt: '2026-04-08'}]->(m1),
             (p)-[:SPOKE {weight: 0.9, traversalCount: 0, createdAt: '2026-04-08'}]->(m2)
    `)

    const bridges = await graph.findProjectBridges('alpha', 'beta')
    expect(bridges.length).toBeGreaterThan(0)

    const sarahBridge = bridges.find(b => b.label === 'Sarah')
    expect(sarahBridge).toBeDefined()
    expect(sarahBridge!.nodeType).toBe('person')
    expect(sarahBridge!.projectACount).toBeGreaterThan(0)
    expect(sarahBridge!.projectBCount).toBeGreaterThan(0)
  })

  it('returns empty when no shared nodes exist between projects', async () => {
    await graph.runCypherWrite(`
      CREATE (m1:Memory {id: 'ep-1', label: 'Alpha only', projectId: 'alpha', memoryType: 'episode'}),
             (m2:Memory {id: 'ep-2', label: 'Beta only', projectId: 'beta', memoryType: 'episode'})
    `)

    const bridges = await graph.findProjectBridges('alpha', 'beta')
    expect(bridges).toHaveLength(0)
  })
})
```

---

## Part 6: Exports and Public API Surface

### 6.1 `@engram-mem/graph` New Exports

In `packages/graph/src/index.ts`, add:

```typescript
export { runPatternCompletion } from './pattern-completion.js'
export type { PatternCompletionInput, PatternCompletionResult } from './pattern-completion.js'
export { extractEmotionKeywords } from './emotion-extractor.js'
```

The `:Community` node label and `MEMBER_OF` relationship type are handled entirely through Cypher — no new TypeScript type exports needed beyond what `NeuralGraph` already exposes.

### 6.2 `@engram-mem/core` New Exports

In `packages/core/src/index.ts`, add:

```typescript
export type { BridgeResult } from './memory.js'
```

### 6.3 `@engram-mem/mcp` Tool Count

After Wave 5, the MCP server exposes 6 tools:
1. `memory_recall` — unchanged, gains optional `project_id`
2. `memory_ingest` — unchanged, gains optional `project_id`
3. `memory_forget` — unchanged, gains optional `project_id`
4. `memory_timeline` — from Wave 4, gains optional `project_id`
5. `memory_overview` — new in Wave 5
6. `memory_bridges` — new in Wave 5

---

## Part 7: Implementation Order

Execute in this order. Each step must compile before proceeding to the next.

**Step 1:** Add `:Community` constraint in `NeuralGraph.connect()`. Add `MEMBER_OF` to the relationship type documentation.

**Step 2:** Add `SCHEMA_V4` to `packages/sqlite/src/migrations.ts`: `community_summaries` table + `project_id` columns on all memory tables. Run migration version check.

**Step 3:** Add `projectId` to `Episode`, `Digest`, `SemanticMemory`, `ProceduralMemory`, `SearchOptions` in `packages/core/src/types.ts`.

**Step 4:** Update `StorageAdapter` interface — add `projectId` to `vectorSearch()` and `textBoost()` opts, add optional `saveCommunityCache()` and `getCommunitySummaries()`.

**Step 5:** Update `packages/sqlite/src/episodes.ts`, `digests.ts`, `semantic.ts`, `procedural.ts` — add `project_id` to INSERT statements and row mappers.

**Step 6:** Update `packages/sqlite/src/adapter.ts` — add project filter logic to `vectorSearch()` and `textBoost()`, implement `saveCommunityCache()` and `getCommunitySummaries()`.

**Step 7:** Add `getCommunityMembers()`, `getCommunityContext()`, `upsertCommunityNode()`, `queryCommunities()`, `findProjectBridges()`, `findMatchingContextNodes()` to `NeuralGraph` class.

**Step 8:** Create `packages/graph/src/emotion-extractor.ts` with `extractEmotionKeywords()`.

**Step 9:** Create `packages/graph/src/pattern-completion.ts` with `runPatternCompletion()`.

**Step 10:** Update exports in `packages/graph/src/index.ts`.

**Step 11:** Add `projectId` field to `MemoryOptions`, store on `Memory` class in `packages/core/src/memory.ts`.

**Step 12:** Thread `projectId` through `Memory.ingest()` → episode insert, and `Memory.recall()` → `engineRecall()` → `unifiedSearch()` → `vectorSearch()` / `textBoost()`.

**Step 13:** Update community summary generation in `packages/core/src/consolidation/dream-cycle.ts` — add Operation 1b using `NeuralGraph` Cypher methods.

**Step 14:** Update spreading activation in `packages/graph/src/neural-graph.ts` — add Community node post-processing and `projectId` boundary check in Cypher.

**Step 15:** Update `packages/core/src/retrieval/engine.ts` — add `graph?: NeuralGraph | null` to `RecallOpts`, implement pattern completion fallback block, implement `getMemoryContent()` helper, extend `formatMemories()` for community summaries.

**Step 16:** Add `Memory.getCommunitySummaries()` and `Memory.findBridges()` to `packages/core/src/memory.ts`.

**Step 17:** Update `packages/mcp/src/index.ts` — add `project_id` parameter to all 4 existing tools, implement multi-instance memory cache keyed by projectId, add `memory_overview` tool, add `memory_bridges` tool.

**Step 18:** Apply equivalent changes to `packages/supabase/src/` (same column additions, project filter logic).

**Step 19:** Write all tests in the order listed in Part 5. Run `pnpm test` across all packages.

---

## Post-Script: Final Wave — Complete Capability Summary

This is the fifth and final implementation wave. With all five waves complete, Engram is a production-grade cognitive memory engine with the following capabilities:

### Memory Architecture

- **5 memory tiers**: Sensory buffer (working memory) → Episodic (raw exchanges) → Digest (session summaries) → Semantic (long-term facts) → Procedural (behavioral patterns)
- **Neo4j graph database**: 9 node labels (Memory, Person, Topic, Entity, Emotion, Intent, Session, TimeContext, Community) and 14 relationship types, all persisted in Neo4j Community Edition via Cypher
- **Dual storage**: SQL relational tables for content and embeddings, Neo4j for graph structure — each optimized for its access pattern

### Ingestion

- Every message is parsed for clean text, scored for salience, entity-extracted, and embedded
- Neo4j decomposition runs on every ingest via `NeuralGraph.decomposeEpisode()`: creates Memory, Person, Topic, Entity, Emotion, Intent, Session, and TimeContext nodes with typed relationships — single Cypher write transaction
- Person and Entity nodes are global singletons reused across messages and projects

### Retrieval

- **3-mode intent classification**: `skip` (acks/greetings), `light` (statements), `deep` (questions/recall)
- **Hybrid search**: vector cosine + BM25 text boost → RRF fusion
- **HyDE fallback**: when top score < 0.3, generates a hypothetical document, re-embeds, merges results
- **Spreading activation**: vector/BM25 seeds fed into Neo4j Cypher spreading activation; activation propagates through typed relationships with exponential decay, surfacing contextually associated memories
- **Pattern completion**: when RECALL_EXPLICIT queries fail vector search (score < 0.2), extracts attributes from the query, finds matching context nodes in Neo4j via Cypher, runs independent spreading activations per attribute, applies convergence bonuses to memories reached from multiple attributes
- **Community context**: when 2+ memories from the same Louvain community are activated, the `:Community` node's summary is appended to the formatted output

### Consolidation

- **Light sleep**: compresses episodes into digests; builds digest Memory nodes in Neo4j with DERIVES_FROM relationships
- **Deep sleep**: extracts semantic and procedural memories from digests; creates typed Neo4j nodes with temporal validity (validFrom/validUntil); marks supersession chains with CONTRADICTS relationships
- **Dream cycle**: runs GDS Louvain community detection, intra-community edge boosting, bridge node flagging via GDS betweenness centrality, hippocampal replay simulation, causal edge promotion, community summary generation
- **Decay pass**: GDS PageRank-modulated decay (hub nodes decay slower); Cypher edge pruning for untouched edges

### Memory Intelligence Features

- **Temporal queries**: `asOf` parameter filters memories by validFrom/validUntil — "what did I believe about X on date Y?"
- **Supersession chains**: `memory_timeline` traces a topic through its knowledge evolution over time
- **Community overview**: `memory_overview` surfaces the top knowledge domains stored in memory without individual retrieval
- **Pattern completion**: fragmentary cues ("that meeting where someone was frustrated about databases") recover the target memory through Neo4j graph attribute intersection

### Multi-Agent Namespace Isolation

- `projectId` scopes all storage operations: ingest, recall, consolidation, and Neo4j graph traversal
- Memories with `project_id IS NULL` (pre-namespace data) remain globally accessible (backward compatible)
- Person and Entity nodes are intentionally cross-project — they serve as bridges
- `memory_bridges` finds shared persons or entities that connect two distinct projects (returns counts/labels only, not cross-project memory content)
- MCP server creates per-project Memory instances, cached by projectId

### Benchmarking

- `@engram-mem/bench` package with LoCoMo and LongMemEval dataset adapters
- CLI runner with comparison mode measuring graph vs. no-graph recall accuracy (P@k), temporal accuracy, and latency (p50/p95)

### Integration Surface

- **MCP server**: 6 tools (`memory_recall`, `memory_ingest`, `memory_forget`, `memory_timeline`, `memory_overview`, `memory_bridges`)
- **SQLite**: production-ready local storage with WAL mode, full-text search (FTS5), vector cosine similarity, schema at V4
- **Supabase**: cloud storage with pgvector and equivalent schema
- **Neo4j**: Community Edition with GDS plugin for graph algorithms (PageRank, Louvain, betweenness centrality)
- **OpenAI**: embeddings, summarization, query expansion, HyDE document generation

### What Is Not Built

Engram has no:
- HTTP API (MCP stdio only)
- Web UI
- Real-time sync between instances
- Fine-tuning or model training loops
- Conflict resolution for concurrent writes from multiple agents to the same projectId
