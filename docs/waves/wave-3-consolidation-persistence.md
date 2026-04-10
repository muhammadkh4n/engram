# Wave 3: Graph-Aware Consolidation + Neo4j GDS Algorithms

**Document status:** Implementation plan — an agent should implement this without asking questions.
**Date authored:** 2026-04-06
**Repository:** `/Users/muhammadkh4n/Projects/github/muhammadkh4n/engram`
**Target packages:** `@engram/core`, `@engram/graph`, `@engram/mcp`

---

## Pre-Script: What Engram Is and Why This Wave Exists

### The System

Engram is a cognitive memory engine for AI agents. Its purpose is to give agents the ability to remember, connect, and reason over past interactions — not as a retrieval-augmented dump of documents, but as a structured model of experience that evolves over time, the way human memory does.

The monorepo at `/Users/muhammadkh4n/Projects/github/muhammadkh4n/engram` contains:

- `packages/core` — the pure TypeScript engine: five memory systems, four consolidation cycles, an 11-type intent classifier, an association walk, and a vector-first retrieval pipeline. No I/O. All storage goes through adapter interfaces.
- `packages/sqlite` — the `SqliteStorageAdapter` implementing `StorageAdapter` from `@engram/core`, backed by `better-sqlite3`. Current schema is at version 2 (V1 tables + V2 episode_parts table).
- `packages/supabase` — the `SupabaseStorageAdapter`, connecting to a Supabase project via `@supabase/supabase-js`. Same interface as sqlite.
- `packages/openai` — the `OpenAIIntelligenceAdapter` implementing `IntelligenceAdapter`.
- `packages/mcp` — the MCP server wrapper that makes Engram accessible to Claude and other MCP clients.
- `packages/graph` — the `@engram/graph` package created in Wave 1, wrapping `neo4j-driver`. Contains `NeuralGraph` class and `SpreadingActivation`.

### The Five Memory Systems

1. **Sensory Buffer** — working memory for the current turn. Holds `WorkingMemoryItem[]` and `PrimedTopic[]`. Decays each turn via `tick()`. Not persisted to SQL directly; snapshots saved via `storage.saveSensorySnapshot()`.

2. **Episodic Memory** — the `episodes` table. Every ingested `Message` becomes an `Episode` row with `content`, `salience`, `entities`, a vector `embedding`, and `entities_json`. The FTS5 virtual table `episodes_fts` indexes content + entities for BM25 search.

3. **Digest Memory** — the `digests` table. The output of light sleep consolidation. Each digest is a session-scoped summary of 20 episodes (one batch), with `key_topics`, `source_episode_ids`, and a vector embedding.

4. **Semantic Memory** — the `semantic` table. Extracted facts and preferences, each with `topic`, `content`, `confidence`, `decay_rate`, and supersession pointers (`supersedes`, `superseded_by`).

5. **Procedural Memory** — the `procedural` table. Trigger-action patterns extracted from workflow and habit phrases. Has `trigger_text`, `procedure`, `category`, `observation_count`, and its own `decay_rate`.

The `associations` table links any two memory items by an `edge_type` drawn from eight types: `temporal`, `causal`, `topical`, `supports`, `contradicts`, `elaborates`, `derives_from`, `co_recalled`. Every edge has a `strength` (0.0–1.0) and `last_activated` timestamp.

### The Four Consolidation Cycles

**Light Sleep** (`packages/core/src/consolidation/light-sleep.ts`): runs per session over unconsolidated episodes. Batches 20 episodes at a time (sorted by `salience DESC`). Summarizes using the intelligence adapter (3-level fallback). Inserts a `Digest`, marks episodes consolidated, creates `derives_from` association edges from each episode to the digest.

**Deep Sleep** (`packages/core/src/consolidation/deep-sleep.ts`): operates on the 7 most recent days of digests. Runs regex-based extraction: 9 semantic patterns and 8 procedural trigger patterns. Runs deduplication (cosine similarity > 0.92), supersession detection, and inserts new `SemanticMemory` and `ProceduralMemory` records.

**Dream Cycle** (`packages/core/src/consolidation/dream-cycle.ts`): currently delegates to `storage.associations.discoverTopicalEdges()`, which runs a SQL temp-table scan for entity co-occurrence across episode pairs.

**Decay Pass** (`packages/core/src/consolidation/decay-pass.ts`): batch-decays semantic memories older than 30 days (rate 0.02), procedural memories older than 60 days (rate 0.01). Prunes association edges with `strength < 0.05` older than 90 days.

### The Neuroscience Vision

Each consolidation cycle maps to a biological process:

- Light sleep = NREM hippocampal replay: recent experiences compressed into session summaries
- Deep sleep = slow-wave cortical transfer: summaries crystallized into long-term facts and behavioral rules
- Dream cycle = REM creative association: the brain discovers unexpected connections between disparate memories
- Decay pass = synaptic pruning: unused pathways weaken; high-traffic pathways strengthen

Wave 3 extends this metaphor into the Neo4j graph layer. The hippocampus replays memories within a spatial-relational map. The neocortex stores facts within a web of concepts. The dreaming brain detects community structure and bridges between knowledge domains. Wave 3 makes all four consolidation cycles graph-native.

---

## What Waves 1 and 2 Built

### Wave 1: `@engram/graph` Package (Neo4j Version)

Wave 1 created `packages/graph/` with the following architecture. An implementing agent must treat this as the ground truth about what already exists.

**Infrastructure**: Neo4j Community Edition runs in Docker at `bolt://localhost:7687`. The Docker Compose file is at `docker/docker-compose.neo4j.yml`. The GDS plugin is pre-loaded via `NEO4J_PLUGINS: '["graph-data-science"]'`.

**NeuralGraph class** wrapping `neo4j-driver` (not in-process JS — all graph state lives in Neo4j):

```typescript
export function createNeuralGraph(opts?: {
  uri?: string      // default: 'bolt://localhost:7687'
  username?: string // default: 'neo4j'
  password?: string // default: 'engram-dev'
}): NeuralGraph

export class NeuralGraph {
  async connect(): Promise<void>
  async disconnect(): Promise<void>

  // Primary ingestion — single Neo4j write transaction per episode
  async decomposeEpisode(episode: EpisodeInput): Promise<void>

  // Spreading activation via Cypher variable-length path traversal
  async spreadActivation(opts: SpreadActivationOpts): Promise<ActivatedNode[]>

  // Entity-based seed lookup
  async lookupEntityNodes(names: string[]): Promise<EntitySeedResult[]>

  // Batch content loader
  async getMemoryNodeIds(nodeIds: string[]): Promise<string[]>

  // Edge strengthening (reconsolidation)
  async strengthenTraversedEdges(traversedEdgePairs: Array<[string, string]>): Promise<void>

  // Raw Cypher execution (used by Wave 3 consolidation)
  async runCypher(query: string, params?: Record<string, unknown>): Promise<neo4j.QueryResult>
  async runCypherWrite(query: string, params?: Record<string, unknown>): Promise<neo4j.QueryResult>

  // Health check
  async isAvailable(): Promise<boolean>

  // Check if GDS plugin is installed
  async isGdsAvailable(): Promise<boolean>
}
```

**8 Node Labels** in Neo4j:

```
:Memory       — pointer to a SQL episode/digest/semantic/procedural row
:Person       — named conversation participant (global singleton by name)
:Topic        — subject area (global singleton by normalized name)
:Entity       — technology/project/concept (global singleton by normalized name)
:Emotion      — classified emotional tone (session-scoped: id includes sessionId)
:Intent       — content intent (global singleton by intentType)
:Session      — conversation session (singleton by sessionId)
:TimeContext  — temporal anchor (singleton by yearWeek + dayOfWeek + timeOfDay)
```

**Node ID Convention**:

| Label        | ID Format                          | Example                      |
|-------------|-------------------------------------|------------------------------|
| Memory       | SQL primary key (UUID v7)           | `019587a3-...`               |
| Person       | `person:{lowercase_name}`           | `person:muhammad`            |
| Topic        | `topic:{lowercase_name}`            | `topic:engram`               |
| Entity       | `entity:{lowercase_name}`           | `entity:typescript`          |
| Emotion      | `emotion:{sessionId}:{label}`       | `emotion:abc123:frustrated`  |
| Intent       | `intent:{intentType}`               | `intent:DEBUGGING`           |
| Session      | `session:{sessionId}`               | `session:abc123`             |
| TimeContext  | `time:{yearWeek}:{dayOfWeek}:{tod}` | `time:2026-W14:monday:night` |

All nodes stored in Neo4j via `MERGE` on `id` property. Neo4j IS the persistence layer — no JSON snapshots, no `graph_snapshots` table, no `graph_nodes` or `graph_edges` SQL tables.

**13 Relationship Types**:

```
TEMPORAL      — (:Memory)-[:TEMPORAL]->(:Memory)             adjacent episodes in session
CAUSAL        — (:Memory)-[:CAUSAL]->(:Memory)               A caused B (or topic-level)
TOPICAL       — (:Memory)-[:TOPICAL]->(:Memory)              shared context (hippocampal replay)
SUPPORTS      — (:Memory)-[:SUPPORTS]->(:Memory)             A reinforces B
CONTRADICTS   — (:Memory)-[:CONTRADICTS]->(:Memory)          A conflicts with B (supersession)
ELABORATES    — (:Memory)-[:ELABORATES]->(:Memory)           A adds detail to B
DERIVES_FROM  — (:Memory)-[:DERIVES_FROM]->(:Memory)         digest←episode, semantic←digest
CO_RECALLED   — (:Memory)-[:CO_RECALLED]->(:Memory)          recalled together
SPOKE         — (:Person)-[:SPOKE]->(:Memory)                person authored/mentioned
CONTEXTUAL    — (:Memory)-[:CONTEXTUAL]->(:Entity|:Topic)    entity appeared in memory
EMOTIONAL     — (:Memory)-[:EMOTIONAL]->(:Emotion)           memory had this tone
INTENTIONAL   — (:Memory)-[:INTENTIONAL]->(:Intent)          memory had this purpose
OCCURRED_IN   — (:Memory)-[:OCCURRED_IN]->(:Session)         memory belongs to session
```

**All relationships carry**: `weight FLOAT`, `createdAt STRING (ISO 8601)`, `lastTraversed STRING`, `traversalCount INTEGER`.

**SpreadingActivation** uses Cypher variable-length path traversal — NOT manual BFS in JavaScript. The Cypher engine handles traversal natively.

### Wave 2: Graph-Aware Ingestion and Retrieval

Wave 2 wired the graph into the retrieval pipeline:

- Every ingested episode gets decomposed into Neo4j via `NeuralGraph.decomposeEpisode()`. SQL remains the durable store. Neo4j decomposition is fire-and-forget, non-blocking.
- `Memory` class holds a `_graph: NeuralGraph | null` field. When null, system operates in SQL-only mode.
- Retrieval runs 4-way parallel search (vector, BM25, temporal, entity), then passes seeds to `spreadActivation()` in Neo4j.
- `recall()` returns `CompositeMemory` with structured `environmentalContext` (who, emotion, intent, temporal).
- SQL `associations` table is still written on every ingest. Neo4j is the acceleration layer, not the replacement.

---

## Wave 3 Scope

Wave 3 has two jobs:

1. Make all four consolidation cycles graph-aware — so Neo4j grows and evolves during consolidation, not just during ingestion.
2. Use Neo4j Graph Data Science (GDS) for algorithmic analysis that would require manual implementation against graphology: PageRank, Louvain community detection, betweenness centrality.

### The Core Advantage: No Manual Algorithm Implementation

Wave 1/2 used graphology with manual BFS and would have required `graphology-communities-louvain` and `graphology-metrics` for graph algorithms. Wave 3 with Neo4j GDS eliminates that entirely:

| Algorithm | graphology approach | Neo4j GDS approach |
|-----------|--------------------|--------------------|
| PageRank | `graphology-metrics/centrality/pagerank` — manual JS | `gds.pageRank.write()` — one Cypher call |
| Community detection | `graphology-communities-louvain` — manual JS | `gds.louvain.write()` — one Cypher call |
| Betweenness centrality | Not available in graphology | `gds.betweenness.write()` — one Cypher call |
| Node similarity | Not available | `gds.nodeSimilarity.stream()` — one Cypher call |
| Shortest path | Not available | `gds.shortestPath.dijkstra.stream()` — one Cypher call |

GDS runs in seconds for 50K+ nodes. The result is written directly onto Neo4j node properties (`communityId`, `pageRank`, `betweenness`, `isBridge`). No intermediate data structures. No JavaScript memory pressure.

### Persistence is Already Handled

Neo4j IS the graph persistence layer. Wave 3 does NOT need:
- `graph_nodes` SQL table
- `graph_edges` SQL table
- `graph_snapshots` JSON blobs
- `GraphStorageAdapter` interface
- `migrateFromSnapshots()` function
- Any schema migration for graph data

Every consolidation operation writes directly to Neo4j via Cypher. The graph persists between process restarts because Neo4j persists it. This eliminates the entire "Part 2: Proper Graph Persistence" section that would have existed in a graphology-based design.

---

## Key Audit Findings Addressed in This Wave

The following design problems in earlier drafts are corrected here. Each fix is labeled at the point of implementation.

**AUDIT FIX — Context inheritance MAX weight**: When the same context node is reachable from multiple source digests (during deep sleep transitive inheritance), use `MAX(existingWeight, inheritedWeight)` via Cypher `CASE` expression. Do not skip the update. Do not average. MAX preserves the strongest signal.

**AUDIT FIX — Semantic `validFrom` is earliest source episode, not consolidation time**: A semantic fact "user prefers dark mode" was observed in episodes from three weeks ago. Its `validFrom` should reflect when those episodes occurred, not when deep sleep ran. Set `validFrom` by querying the earliest `createdAt` across all source episodes.

**AUDIT FIX — Community instability across dream cycle runs**: Louvain assigns numeric community IDs non-deterministically across runs. Do not try to match old communities to new ones. Before running Louvain, clear `communityId` on all nodes in the projected graph. After running, treat community IDs as opaque integers for the current run only. Community summaries are regenerated from scratch each time.

**AUDIT FIX — Hippocampal replay: use recent seeds, not random; raise overlap threshold**: Seeds for replay should be the N most recently ingested Memory nodes (by `createdAt`), not random. Overlap threshold for creating a new TOPICAL edge is 3 Memory-type nodes in common (not 2, not counting context nodes like Person/Topic/Entity in the overlap).

**AUDIT FIX — Causal edge discovery at TOPIC level, not episode level**: The previous approach looked for the same episode IDs recurring across sessions — structurally impossible since episodes are unique. The correct approach finds Topic pairs where `topicA` consistently precedes `topicB` across sessions. Implemented via OCCURRED_IN + CONTEXTUAL traversal in Cypher.

**AUDIT FIX — PageRank decay is gradient, not binary cliff**: Do not exclude the top 10% from decay entirely. Use a continuous formula: `effectiveDecayRate = baseDecayRate * (1 - clamp(pageRank / maxPageRank, 0, 0.8))`. High PageRank → near-zero decay. Low PageRank → full decay rate. No cliff.

---

## Implementation

### Function Signature Changes Overview

All four consolidation functions gain an optional `graph` parameter. The `Memory` class already holds `_graph: NeuralGraph | null` from Wave 2. Each consolidation function receives this field and null-checks it. When null, graph operations are skipped silently (SQL-only mode is preserved).

```typescript
// light-sleep.ts — new signature
export async function lightSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  opts?: LightSleepOptions,
  graph?: NeuralGraph | null
): Promise<ConsolidateResult>

// deep-sleep.ts — new signature
export async function deepSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  opts?: DeepSleepOptions,
  graph?: NeuralGraph | null
): Promise<ConsolidateResult>

// dream-cycle.ts — new signature
export async function dreamCycle(
  storage: StorageAdapter,
  opts?: DreamCycleOptions,
  graph?: NeuralGraph | null
): Promise<ConsolidateResult>

// decay-pass.ts — new signature
export async function decayPass(
  storage: StorageAdapter,
  opts?: DecayPassOptions,
  graph?: NeuralGraph | null
): Promise<ConsolidateResult>
```

The `graph` parameter goes at the end (not the middle) to preserve backward compatibility with existing callers that don't pass it. In `Memory.consolidate()`, pass `this._graph` as the final argument to each call.

### Updated `ConsolidateResult` type

**File to modify:** `packages/core/src/types.ts`

Add the following optional fields to `ConsolidateResult`:

```typescript
export interface ConsolidateResult {
  cycle: 'light_sleep' | 'deep_sleep' | 'dream' | 'decay'
  // ... existing fields ...

  // Graph fields — present when Neo4j graph is active
  graphNodesCreated?: number
  graphEdgesCreated?: number
  graphEdgesUpdated?: number
  communitiesDetected?: number
  bridgeNodesFound?: number
  replayEdgesCreated?: number
  causalEdgesCreated?: number
  graphEdgesPruned?: number
  isolatedNodesDeprioritized?: number
}
```

---

### Section 1: Light Sleep Enhancement

**File to modify:** `packages/core/src/consolidation/light-sleep.ts`

**Current behavior:** After inserting a `Digest` row and marking source episodes consolidated, creates `derives_from` association edges in the SQL `associations` table from each episode to the digest.

**New behavior:** After all SQL operations complete for a batch, creates a Digest Memory node in Neo4j, links it to source episode nodes via DERIVES_FROM, merges context connections from all source episodes with weight = frequency/total, and attaches a dominant emotion node.

All Neo4j operations for one batch happen inside a single write transaction via `graph.runCypherWrite()`. If Neo4j is unavailable (`graph` is null or `isAvailable()` returns false), log a warning and skip — SQL results are unaffected.

#### Step 1: Create the Digest Memory node

```cypher
MERGE (d:Memory {id: $digestId})
SET d.memoryType = 'digest',
    d.label = $label,
    d.createdAt = $createdAt,
    d.validFrom = $validFrom,
    d.validUntil = null,
    d.pageRank = 0.0,
    d.betweenness = 0.0,
    d.isBridge = false,
    d.activationCount = 0
```

Parameters: `{ digestId: digest.id, label: digest.summary.slice(0, 80), createdAt: new Date().toISOString(), validFrom: new Date().toISOString() }`

#### Step 2: Create DERIVES_FROM edges from each source episode to the digest

One Cypher statement handles the whole batch:

```cypher
UNWIND $sourceEpisodeIds AS episodeId
MATCH (ep:Memory {id: episodeId})
MATCH (d:Memory {id: $digestId})
MERGE (d)-[r:DERIVES_FROM]->(ep)
ON CREATE SET r.weight = 0.8,
              r.createdAt = $now,
              r.lastTraversed = null,
              r.traversalCount = 0
```

Parameters: `{ sourceEpisodeIds: batch.map(e => e.id), digestId: digest.id, now: new Date().toISOString() }`

Note the direction: digest DERIVES_FROM episode (the digest is derived from its source episodes). This matches the Wave 2 convention established by `decomposeEpisode`.

#### Step 3: Merge context connections from source episodes to the digest node

This is the key consolidation step. Each context node (Person, Entity, Topic) adjacent to a source episode is connected to the digest with a weight proportional to how many source episodes share that context. A single aggregating Cypher query handles all context types:

```cypher
MATCH (ep:Memory)-[r:SPOKE|CONTEXTUAL|TOPICAL]->(ctx)
WHERE ep.id IN $sourceEpisodeIds
  AND ctx:Person OR ctx:Entity OR ctx:Topic
WITH ctx, count(DISTINCT ep) AS frequency, $totalSources AS total
MATCH (d:Memory {id: $digestId})
MERGE (d)-[rel:CONTEXTUAL]->(ctx)
ON CREATE SET rel.weight = toFloat(frequency) / total,
              rel.createdAt = $now,
              rel.lastTraversed = null,
              rel.traversalCount = 0
ON MATCH SET rel.weight = toFloat(frequency) / total,
             rel.lastTraversed = $now
```

Parameters: `{ sourceEpisodeIds: batch.map(e => e.id), totalSources: batch.length, digestId: digest.id, now: new Date().toISOString() }`

Note the `ON MATCH SET` path: if a CONTEXTUAL edge to this context node already exists on the digest (e.g., from a previous partial run), update the weight rather than skip it.

The WHERE clause filter `AND ctx:Person OR ctx:Entity OR ctx:Topic` must be parenthesized correctly in actual Cypher:

```cypher
WHERE ep.id IN $sourceEpisodeIds
  AND (ctx:Person OR ctx:Entity OR ctx:Topic)
```

#### Step 4: Create a dominant Emotion node for the digest

Find the most frequent emotion across source episodes. Create an Emotion node scoped to the session (matching the Wave 1 convention of session-scoped emotion IDs) and attach it to the digest.

```cypher
MATCH (ep:Memory)-[:EMOTIONAL]->(em:Emotion)
WHERE ep.id IN $sourceEpisodeIds
WITH em.label AS emotionLabel, count(*) AS freq
ORDER BY freq DESC
LIMIT 1
WITH emotionLabel
WHERE emotionLabel IS NOT NULL
MATCH (d:Memory {id: $digestId})
MERGE (dominantEm:Emotion {id: 'emotion:digest:' + $digestId + ':' + emotionLabel})
ON CREATE SET dominantEm.label = emotionLabel,
              dominantEm.sessionId = $sessionId,
              dominantEm.createdAt = $now
MERGE (d)-[rel:EMOTIONAL]->(dominantEm)
ON CREATE SET rel.weight = 0.7,
              rel.createdAt = $now,
              rel.lastTraversed = null,
              rel.traversalCount = 0
```

Parameters: `{ sourceEpisodeIds: batch.map(e => e.id), digestId: digest.id, sessionId: sessionId, now: new Date().toISOString() }`

#### What to count for the return value

Maintain two counters during the batch loop: `graphNodesCreated` (1 per digest) and `graphEdgesCreated` (number of DERIVES_FROM + CONTEXTUAL + EMOTIONAL edges created in this batch). These come back from the Cypher `summary.counters` on each write transaction — access via `result.summary.counters.nodesCreated()` and `result.summary.counters.relationshipsCreated()` from neo4j-driver.

#### Error handling

Wrap all four Cypher steps for a batch in a try/catch. On failure:
- Log: `[light-sleep] Neo4j graph update failed for digest ${digest.id}: ${err.message}` (do not log the full stack in production)
- Do NOT throw. SQL results already committed — the digest row exists regardless.
- Set `graphNodesCreated` and `graphEdgesCreated` to 0 for this batch.

---

### Section 2: Deep Sleep Enhancement

**File to modify:** `packages/core/src/consolidation/deep-sleep.ts`

**Current behavior:** Inserts `SemanticMemory` and `ProceduralMemory` rows. Creates `derives_from` edges in SQL. Marks superseded memories via `storage.semantic.markSuperseded()`.

**New behavior:** Creates Memory nodes in Neo4j for each new semantic and procedural memory, inherits context from source digest nodes with weight attenuation, enforces temporal validity with bitemporal timestamps, creates CONTRADICTS relationships on supersession.

#### Step 1: Create the Semantic Memory node

After `storage.semantic.insert(...)` succeeds and returns the `knowledge.id`:

```cypher
MERGE (s:Memory {id: $semanticId})
SET s.memoryType = 'semantic',
    s.label = $label,
    s.topic = $topic,
    s.createdAt = $now,
    s.validFrom = $validFrom,
    s.validUntil = null,
    s.pageRank = 0.0,
    s.betweenness = 0.0,
    s.isBridge = false,
    s.activationCount = 0
```

Parameters:
- `semanticId`: `knowledge.id`
- `label`: `${candidate.topic}: ${candidate.content.slice(0, 60)}`
- `topic`: `candidate.topic`
- `now`: `new Date().toISOString()`
- `validFrom`: see AUDIT FIX below

**AUDIT FIX — `validFrom` is earliest source episode timestamp, not consolidation time.**

Before creating the semantic node, fetch the earliest `created_at` from the source episodes that produced the source digests. This requires one SQL query:

```typescript
// In TypeScript, before the Cypher node creation
const earliestEpisodeRow = await storage.episodes.findEarliestInDigests(candidate.sourceDigestIds)
const validFrom = earliestEpisodeRow?.createdAt ?? new Date()
```

Add `findEarliestInDigests(digestIds: string[]): Promise<{ createdAt: Date } | null>` to the `EpisodeStorage` interface in `packages/core/src/adapters/storage.ts`. SQLite implementation:

```sql
SELECT e.created_at
FROM episodes e
JOIN digests d ON e.id = ANY(string_to_array(d.source_episode_ids, ','))
WHERE d.id IN (/* $digestIds placeholders */)
ORDER BY e.created_at ASC
LIMIT 1
```

For SQLite (better-sqlite3), the JOIN needs to use `json_each` since `source_episode_ids` is stored as JSON array:

```sql
SELECT e.created_at
FROM digests d
JOIN json_each(d.source_episode_ids) ep_id ON 1=1
JOIN episodes e ON e.id = ep_id.value
WHERE d.id IN (/* placeholders */)
ORDER BY e.created_at ASC
LIMIT 1
```

The `validFrom` timestamp in ISO 8601 is then passed to the Cypher query above.

#### Step 2: Create DERIVES_FROM edges from semantic node to source digests

```cypher
UNWIND $sourceDigestIds AS digestId
MATCH (dig:Memory {id: digestId})
MATCH (s:Memory {id: $semanticId})
MERGE (s)-[r:DERIVES_FROM]->(dig)
ON CREATE SET r.weight = 0.8,
              r.createdAt = $now,
              r.lastTraversed = null,
              r.traversalCount = 0
```

#### Step 3: Transitive context inheritance with MAX weight

For each source digest, inherit its CONTEXTUAL edges onto the semantic node at 0.7 attenuation. When the same context node is reachable via multiple source digests, use MAX weight — not the first-encountered weight, not an average.

**AUDIT FIX — MAX weight, not skip.**

This is a single aggregating Cypher query that handles the entire inheritance in one round-trip:

```cypher
MATCH (dig:Memory)-[r:CONTEXTUAL]->(ctx)
WHERE dig.id IN $sourceDigestIds
  AND (ctx:Person OR ctx:Entity OR ctx:Topic)
WITH ctx, max(r.weight) * 0.7 AS inheritedWeight
MATCH (s:Memory {id: $semanticId})
MERGE (s)-[rel:CONTEXTUAL]->(ctx)
ON CREATE SET rel.weight = inheritedWeight,
              rel.createdAt = $now,
              rel.lastTraversed = null,
              rel.traversalCount = 0
ON MATCH SET rel.weight = CASE
               WHEN rel.weight < inheritedWeight THEN inheritedWeight
               ELSE rel.weight
             END,
             rel.lastTraversed = $now
```

The `max(r.weight) * 0.7` aggregation handles the multi-digest case: if digest A has CONTEXTUAL weight 0.8 to "TypeScript" and digest B has CONTEXTUAL weight 0.6 to "TypeScript", the inherited weight is `max(0.8, 0.6) * 0.7 = 0.56`. The `ON MATCH SET` path uses a CASE expression to only update if the inherited weight exceeds the existing one — MAX semantics.

Parameters: `{ sourceDigestIds: candidate.sourceDigestIds, semanticId: knowledge.id, now: new Date().toISOString() }`

#### Step 4: Supersession — temporal validity and CONTRADICTS relationship

This step runs when `candidate.supersededId !== null` (the new semantic memory supersedes an existing one).

**AUDIT FIX — `validUntil` on the old node, and CONTRADICTS relationship in one transaction.**

```cypher
MATCH (old:Memory {id: $oldId})
MATCH (new:Memory {id: $newId})
SET old.validUntil = $now
MERGE (new)-[r:CONTRADICTS]->(old)
ON CREATE SET r.weight = 1.0,
              r.createdAt = $now,
              r.lastTraversed = null,
              r.traversalCount = 0
```

Parameters: `{ oldId: candidate.supersededId, newId: knowledge.id, now: new Date().toISOString() }`

The `validUntil` timestamp on the old node enables temporal queries: "what did I believe about X on date Y?" by filtering WHERE `validFrom <= Y` AND (`validUntil IS NULL` OR `Y <= validUntil`). This is the Graphiti-inspired bitemporal model.

#### Step 5: Procedural Memory node creation

After `storage.procedural.insert(...)` succeeds and returns the `proceduralRecord.id`:

```cypher
MERGE (p:Memory {id: $proceduralId})
SET p.memoryType = 'procedural',
    p.label = $label,
    p.triggerPattern = $triggerPattern,
    p.createdAt = $now,
    p.validFrom = $now,
    p.validUntil = null,
    p.pageRank = 0.0,
    p.betweenness = 0.0,
    p.isBridge = false,
    p.activationCount = 0
```

Parameters:
- `proceduralId`: `proceduralRecord.id`
- `label`: `${candidate.trigger}: ${candidate.procedure.slice(0, 60)}`
- `triggerPattern`: `candidate.trigger`
- `now`: `new Date().toISOString()`

Procedural memories use consolidation time as `validFrom` — they describe learned behaviors, not past events, so the "when observed" question doesn't apply the same way as for semantic facts.

#### Error handling

Wrap all graph operations for each semantic/procedural insert in a try/catch. On failure:
- Log: `[deep-sleep] Neo4j graph update failed for ${knowledge.id}: ${err.message}`
- Do NOT throw. SQL insert already committed.

---

### Section 3: Dream Cycle Enhancement

**File to modify:** `packages/core/src/consolidation/dream-cycle.ts`

This is the largest change in Wave 3. The dream cycle currently delegates to a SQL entity co-occurrence scan. Wave 3 replaces this with four GDS-powered operations. The SQL-based `discoverTopicalEdges()` runs as a supplementary pass at reduced budget after the graph operations complete.

#### Updated `DreamCycleOptions`

```typescript
export interface DreamCycleOptions {
  daysLookback?: number          // default 7
  maxNewAssociations?: number    // default 100
  replaySeeds?: number           // default 5, most recent Memory nodes
  causalMinSessions?: number     // default 3
}
```

Note: `communityBoostAmount` is removed. Community assignment is handled by GDS Louvain writing `communityId` directly onto nodes — there is no in-process edge weight adjustment loop.

#### Operation 1: Community Detection (Louvain via GDS)

**AUDIT FIX — Clear old communityId values before running Louvain; regenerate from scratch.**

Step 1a: Clear existing community assignments on all nodes:

```cypher
MATCH (n)
WHERE n.communityId IS NOT NULL
SET n.communityId = null
```

Step 1b: Project the graph into GDS. This is an in-memory projection inside Neo4j — it does not create any new nodes or edges in the main graph:

```cypher
CALL gds.graph.project(
  'memory-graph',
  ['Memory', 'Person', 'Topic', 'Entity'],
  {
    SPOKE:        { orientation: 'UNDIRECTED', properties: ['weight'] },
    CONTEXTUAL:   { orientation: 'UNDIRECTED', properties: ['weight'] },
    TOPICAL:      { orientation: 'UNDIRECTED', properties: ['weight'] },
    TEMPORAL:     { orientation: 'UNDIRECTED', properties: ['weight'] },
    DERIVES_FROM: { orientation: 'UNDIRECTED', properties: ['weight'] },
    EMOTIONAL:    { orientation: 'UNDIRECTED', properties: ['weight'] },
    INTENTIONAL:  { orientation: 'UNDIRECTED', properties: ['weight'] }
  }
)
YIELD graphName, nodeCount, relationshipCount
RETURN graphName, nodeCount, relationshipCount
```

Step 1c: Run Louvain community detection. The `write` mode writes `communityId` directly onto each node:

```cypher
CALL gds.louvain.write('memory-graph', {
  writeProperty: 'communityId',
  relationshipWeightProperty: 'weight',
  maxLevels: 10,
  maxIterations: 10,
  tolerance: 0.0001,
  includeIntermediateCommunities: false
})
YIELD communityCount, modularity, ranLevels
RETURN communityCount, modularity, ranLevels
```

Capture `communityCount` from the yield for the return value.

Step 1d: Drop the projection to free memory:

```cypher
CALL gds.graph.drop('memory-graph')
```

Each of these four steps is its own `graph.runCypher()` call (not a single transaction — GDS procedures must be called in auto-commit mode). Execute them sequentially with `await`.

GDS availability: before step 1a, call `graph.isGdsAvailable()`. If it returns false, skip the entire Operation 1 block and log `[dream-cycle] GDS plugin not available — skipping Louvain community detection`. Continue with Operations 2–4 (which are also GDS-dependent and will similarly be skipped if GDS is unavailable). The SQL supplementary pass at the end still runs.

#### Operation 2: Bridge Node Detection (Betweenness Centrality via GDS)

Project a Memory-only graph (excluding context node types) for betweenness calculation. Bridge memories connect disparate knowledge domains — they are the highest-value memories for retrieval.

Step 2a: Project the Memory-only graph:

```cypher
CALL gds.graph.project(
  'bridge-graph',
  'Memory',
  ['TEMPORAL', 'TOPICAL', 'CONTEXTUAL', 'DERIVES_FROM', 'CO_RECALLED', 'CONTRADICTS']
)
YIELD graphName, nodeCount, relationshipCount
RETURN graphName, nodeCount, relationshipCount
```

Step 2b: Run betweenness centrality in write mode:

```cypher
CALL gds.betweenness.write('bridge-graph', {
  writeProperty: 'betweenness'
})
YIELD centralityDistribution, nodePropertiesWritten
RETURN centralityDistribution.p95 AS p95Threshold, nodePropertiesWritten
```

Step 2c: Drop the projection:

```cypher
CALL gds.graph.drop('bridge-graph')
```

Step 2d: Flag the top 5% of Memory nodes by betweenness score as bridge nodes. The p95 threshold comes from the `centralityDistribution` yield in step 2b — use it directly rather than computing percentiles manually:

```cypher
MATCH (m:Memory)
WHERE m.betweenness IS NOT NULL
WITH percentileCont(m.betweenness, 0.95) AS p95
MATCH (m:Memory)
SET m.isBridge = (m.betweenness >= p95)
```

Note: `m.isBridge` is set to `false` for nodes below p95 in the same query — `(m.betweenness >= p95)` evaluates to a boolean. This clears stale bridge flags from previous runs without requiring a separate clearing step.

Capture `nodePropertiesWritten` from step 2b for the return value (this is the count of betweenness scores written, not bridge nodes specifically). Query the count of bridges set to true separately:

```cypher
MATCH (m:Memory) WHERE m.isBridge = true RETURN count(m) AS bridgeCount
```

#### Operation 3: Hippocampal Replay Simulation

This operation selects recently-ingested Memory nodes as replay seeds, runs spreading activation from each independently, and creates TOPICAL edges between seeds whose activation neighborhoods significantly overlap.

**AUDIT FIX — Use recent seeds, not random; raise overlap threshold to 3 Memory nodes.**

Step 3a: Select the N most recently ingested Memory nodes as seeds:

```cypher
MATCH (m:Memory)
WHERE m.createdAt IS NOT NULL
ORDER BY m.createdAt DESC
LIMIT $replaySeeds
RETURN m.id AS memoryId
```

Parameters: `{ replaySeeds: opts.replaySeeds ?? 5 }`

Step 3b: For each seed memory ID, run spreading activation via `graph.spreadActivation()`. Filter the returned `ActivatedNode[]` to include only nodes with `nodeType === 'Memory'` (exclude Person, Topic, Entity, Emotion, Intent, Session, TimeContext from the overlap set).

**AUDIT FIX — Overlap is counted only over Memory-type activated nodes, not context nodes.**

```typescript
const activationResults: Array<{ seedId: string; activatedMemoryIds: Set<string> }> = []

for (const seed of seeds) {
  const activated = await graph.spreadActivation({
    seedNodeIds: [seed.memoryId],
    seedActivations: { [seed.memoryId]: 1.0 },
    maxHops: 3,
    decay: 0.5,
    threshold: 0.05,
  })

  // Filter to Memory nodes only for overlap counting
  const activatedMemoryIds = new Set(
    activated
      .filter(n => n.nodeType === 'Memory')
      .map(n => n.nodeId)
  )
  activationResults.push({ seedId: seed.memoryId, activatedMemoryIds })
}
```

Step 3c: For each pair of seeds (i, j), compute overlap over Memory-typed activated sets. If overlap size >= 3, create a TOPICAL edge:

```typescript
let replayEdgesCreated = 0

for (let i = 0; i < activationResults.length; i++) {
  for (let j = i + 1; j < activationResults.length; j++) {
    const a = activationResults[i]
    const b = activationResults[j]

    // Count overlap — Memory nodes only (context nodes excluded above)
    const overlap = new Set([...a.activatedMemoryIds].filter(id => b.activatedMemoryIds.has(id)))

    // AUDIT FIX: threshold is 3, not 2
    if (overlap.size < 3) continue

    // Strength scales with overlap size: 3 shared = 0.4, 8+ shared = 0.9
    const edgeWeight = Math.min(0.9, 0.3 + 0.1 * Math.min(overlap.size, 6))

    await graph.runCypherWrite(`
      MATCH (a:Memory {id: $aId})
      MATCH (b:Memory {id: $bId})
      WHERE NOT EXISTS((a)-[:TOPICAL]-(b))
      MERGE (a)-[r:TOPICAL]->(b)
      ON CREATE SET r.weight = $weight,
                    r.createdAt = $now,
                    r.lastTraversed = null,
                    r.traversalCount = 0,
                    r.discoveredVia = 'hippocampal_replay',
                    r.overlapCount = $overlapSize
    `, {
      aId: a.seedId,
      bId: b.seedId,
      weight: edgeWeight,
      now: new Date().toISOString(),
      overlapSize: overlap.size,
    })

    // Mirror to SQL associations table
    await storage.associations.insert({
      sourceId: a.seedId,
      sourceType: 'episode',  // best guess; use actual type if accessible
      targetId: b.seedId,
      targetType: 'episode',
      edgeType: 'topical',
      strength: edgeWeight,
      lastActivated: new Date(),
      metadata: { discoveredVia: 'hippocampal_replay', overlappingNodes: overlap.size },
    }).catch(() => { /* duplicate — already associated */ })

    replayEdgesCreated++
  }
}
```

The `WHERE NOT EXISTS((a)-[:TOPICAL]-(b))` guard prevents creating duplicate TOPICAL edges on repeated dream cycle runs. The `MERGE` provides idempotency for concurrent runs.

#### Operation 4: Causal Edge Discovery at Topic Level

**AUDIT FIX — Redesigned from episode-level to topic-level. Episode IDs are unique and cannot repeat across sessions; the original design was structurally broken.**

The new design finds Topic pairs where topicA consistently precedes topicB within the same session across at least `causalMinSessions` distinct sessions. "Precedes" means: there exists an episode E_a referencing topicA that occurred before an episode E_b referencing topicB in the same session.

Step 4a: Find qualifying topic pairs via Cypher:

```cypher
MATCH (s:Session)<-[:OCCURRED_IN]-(epA:Memory)-[:CONTEXTUAL]->(topicA:Topic)
MATCH (s)<-[:OCCURRED_IN]-(epB:Memory)-[:CONTEXTUAL]->(topicB:Topic)
WHERE epA.createdAt < epB.createdAt
  AND topicA.id <> topicB.id
WITH topicA, topicB, count(DISTINCT s) AS sessionCount
WHERE sessionCount >= $minSessions
RETURN topicA.id AS topicAId, topicB.id AS topicBId, sessionCount
ORDER BY sessionCount DESC
LIMIT 50
```

Parameters: `{ minSessions: opts.causalMinSessions ?? 3 }`

Step 4b: For each qualifying pair, upsert a CAUSAL edge between the Topic nodes. Use weight that increases with session count:

```cypher
MATCH (topicA:Topic {id: $topicAId})
MATCH (topicB:Topic {id: $topicBId})
MERGE (topicA)-[r:CAUSAL]->(topicB)
ON CREATE SET r.weight = 0.5,
              r.sessionCount = $sessionCount,
              r.createdAt = $now,
              r.lastTraversed = $now,
              r.traversalCount = 0
ON MATCH SET r.weight = CASE
               WHEN r.weight + 0.1 > 1.0 THEN 1.0
               ELSE r.weight + 0.1
             END,
             r.sessionCount = $sessionCount,
             r.lastTraversed = $now
```

The `ON MATCH SET` path increments weight by 0.1 on each dream cycle run where the pair still qualifies. Capped at 1.0. This creates a gradient: causal relationships observed across many sessions become stronger over time.

Parameters: `{ topicAId, topicBId, sessionCount, now: new Date().toISOString() }`

Step 4c: Count total causal edges created or updated in this run for the return value.

```typescript
let causalEdgesCreated = 0
for (const pair of causalPairs) {
  await graph.runCypherWrite(/* step 4b */, { ...pair, now })
  causalEdgesCreated++
}
```

#### Supplementary SQL pass

After all four graph operations complete, still run the original SQL-based entity co-occurrence scan as a supplementary pass at reduced budget. This catches associations between episodes that were never decomposed into Neo4j (e.g., from before Wave 2 was deployed):

```typescript
const sqlAssociations = await storage.associations.discoverTopicalEdges({
  daysLookback: opts.daysLookback ?? 7,
  maxNew: Math.floor((opts.maxNewAssociations ?? 100) / 2),
})
// sqlAssociations is already inserted by discoverTopicalEdges()
```

#### GDS graceful degradation

If `graph.isGdsAvailable()` returns false, skip Operations 1 and 2 entirely. Log:
```
[dream-cycle] GDS plugin unavailable — Louvain and betweenness skipped
[dream-cycle] Install Neo4j GDS plugin via NEO4J_PLUGINS='["graph-data-science"]' in docker-compose
```

Operations 3 and 4 (replay simulation, causal discovery) use only `spreadActivation()` and plain Cypher — they do NOT require GDS and run regardless of GDS availability.

#### GDS projection name collision guard

If a GDS projection named `'memory-graph'` or `'bridge-graph'` already exists (from a crashed previous run), the `gds.graph.project()` call will fail. Guard each projection with a conditional drop:

```cypher
CALL gds.graph.exists('memory-graph') YIELD exists
CALL apoc.do.when(exists, 'CALL gds.graph.drop("memory-graph") YIELD graphName RETURN graphName', '', {}) YIELD value
RETURN value
```

If APOC is not available, use a simpler approach: wrap the entire GDS block in a try/catch, and on failure with message containing "already exists", call `gds.graph.drop()` and retry:

```typescript
async function runWithProjectionCleanup(
  graph: NeuralGraph,
  projectQuery: string,
  algorithmQuery: string,
  dropQuery: string
): Promise<neo4j.QueryResult> {
  try {
    await graph.runCypher(projectQuery)
  } catch (err: unknown) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('already exists')) {
      await graph.runCypher(dropQuery)
      await graph.runCypher(projectQuery)
    } else {
      throw err
    }
  }
  const result = await graph.runCypher(algorithmQuery)
  await graph.runCypher(dropQuery)
  return result
}
```

This utility lives in `packages/graph/src/gds-utils.ts` and is exported from `packages/graph/src/index.ts`.

#### Updated function signature

```typescript
export async function dreamCycle(
  storage: StorageAdapter,
  opts?: DreamCycleOptions,
  graph?: NeuralGraph | null
): Promise<ConsolidateResult>
```

---

### Section 4: Decay Pass Enhancement

**File to modify:** `packages/core/src/consolidation/decay-pass.ts`

**Current behavior:** Batch-decays semantic memories older than 30 days (rate 0.02), procedural memories older than 60 days (rate 0.01). Prunes association edges with `strength < 0.05` older than 90 days.

**New behavior:** Computes PageRank via GDS, applies gradient decay rate modulation based on PageRank, prunes never-traversed edges from Neo4j, deprioritizes isolated Memory nodes.

#### Operation 1: PageRank via GDS

**AUDIT FIX — PageRank replaces the manual graphology-metrics implementation.**

Step 1a: Project the decay graph (Memory nodes + relationships that carry importance signals):

```cypher
CALL gds.graph.project(
  'decay-graph',
  'Memory',
  ['TEMPORAL', 'TOPICAL', 'CONTEXTUAL', 'DERIVES_FROM', 'CO_RECALLED']
)
YIELD graphName, nodeCount, relationshipCount
RETURN graphName, nodeCount, relationshipCount
```

Step 1b: Run PageRank in write mode:

```cypher
CALL gds.pageRank.write('decay-graph', {
  writeProperty: 'pageRank',
  dampingFactor: 0.85,
  maxIterations: 20,
  tolerance: 0.0000001
})
YIELD nodePropertiesWritten, ranIterations, didConverge, centralityDistribution
RETURN nodePropertiesWritten, centralityDistribution.max AS maxPageRank, centralityDistribution.mean AS meanPageRank
```

Capture `maxPageRank` from the yield for use in the decay formula.

Step 1c: Drop the projection:

```cypher
CALL gds.graph.drop('decay-graph')
```

#### Operation 2: Fetch PageRank scores for SQL decay modulation

After GDS writes `pageRank` onto each Memory node, fetch the scores for the memories that will be decayed in this run. This bridges the Neo4j graph back to the SQL decay operation:

```cypher
MATCH (m:Memory)
WHERE m.pageRank IS NOT NULL
  AND m.memoryType IN ['semantic', 'procedural']
RETURN m.id AS memoryId, m.memoryType AS memoryType, m.pageRank AS pageRank
```

Build a lookup map: `Map<memoryId, pageRank>`. Pass this to the SQL decay update.

#### Operation 3: Gradient decay rate modulation

**AUDIT FIX — No binary cliff. Gradient formula: effectiveDecayRate = baseDecayRate * (1 - clamp(pageRank / maxPageRank, 0, 0.8)).**

This means:
- A memory with `pageRank = maxPageRank` gets `effectiveDecayRate = baseDecayRate * (1 - 0.8) = 0.2 * baseDecayRate` — very slow decay
- A memory with `pageRank = 0` gets `effectiveDecayRate = baseDecayRate * 1.0` — full decay rate
- A memory with `pageRank = 0.5 * maxPageRank` gets `effectiveDecayRate = baseDecayRate * 0.6` — moderate protection

Apply this per-memory in a batch update. The SQL adapters need a method that accepts per-ID decay rates:

**New method on `SemanticStorage` interface** (in `packages/core/src/adapters/storage.ts`):

```typescript
interface SemanticStorage {
  // ... existing methods ...
  batchDecayGradient(updates: Array<{
    id: string
    effectiveDecayRate: number
    daysThreshold: number
  }>): Promise<number>
}
```

**New method on `ProceduralStorage` interface:**

```typescript
interface ProceduralStorage {
  // ... existing methods ...
  batchDecayGradient(updates: Array<{
    id: string
    effectiveDecayRate: number
    daysThreshold: number
  }>): Promise<number>
}
```

SQLite implementation of `batchDecayGradient` (in `packages/sqlite/src/semantic.ts`): iterate the updates array, batch into transactions of 500 rows:

```sql
UPDATE semantic
SET confidence = MAX(0.0, confidence - ?)
WHERE id = ?
  AND (last_accessed IS NULL OR last_accessed < julianday('now') - ?)
  AND superseded_by IS NULL
```

For memories NOT present in the `pageRankMap` (Neo4j not available or memory node doesn't exist yet), apply the base decay rate unchanged.

TypeScript decay loop:

```typescript
const semanticUpdates: Array<{ id: string; effectiveDecayRate: number; daysThreshold: number }> = []
const semanticBaseRate = opts.semanticDecayRate ?? 0.02
const semanticDays = opts.semanticDaysThreshold ?? 30
const maxPageRank = pageRankResult?.maxPageRank ?? 1

for (const semantic of allSemanticMemories) {
  const pr = pageRankMap.get(semantic.id) ?? 0
  const protection = Math.min(0.8, pr / maxPageRank)
  const effectiveRate = semanticBaseRate * (1 - protection)
  semanticUpdates.push({
    id: semantic.id,
    effectiveDecayRate: effectiveRate,
    daysThreshold: semanticDays,
  })
}

const semanticDecayed = await storage.semantic.batchDecayGradient(semanticUpdates)
```

Apply the same pattern for procedural memories with `proceduralBaseRate = 0.01` and `proceduralDays = 60`.

When GDS is unavailable (pageRankMap is empty), all memories decay at their base rate — existing behavior preserved.

#### Operation 4: Edge Pruning in Neo4j

Remove edges from Neo4j that have never been traversed and are older than 60 days. Never prune DERIVES_FROM edges — they are the provenance chain.

```cypher
MATCH ()-[r]->()
WHERE r.traversalCount = 0
  AND r.createdAt < $cutoffDate
  AND type(r) <> 'DERIVES_FROM'
DELETE r
```

Parameters: `{ cutoffDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() }`

Capture the count of deleted edges from `result.summary.counters.relationshipsDeleted()` for the return value.

Note: this is in addition to the existing SQL `pruneWeak()` call which already removes weak SQL association edges. The two pruning operations are complementary and both run.

#### Operation 5: Isolated Node Deprioritization

Memory nodes with zero relationships in Neo4j are disconnected from the knowledge structure. Drive their SQL confidence toward the floor.

```cypher
MATCH (m:Memory)
WHERE NOT (m)--()
  AND m.memoryType IN ['semantic', 'procedural']
RETURN m.id AS memoryId, m.memoryType AS memoryType
```

For each returned memory, update SQL confidence to a floor value (0.01). This uses the existing `storage.semantic.update()` / `storage.procedural.update()` methods — no new interface method required. Set `confidence: 0.01` directly.

```typescript
let isolatedCount = 0
for (const isolated of isolatedNodes) {
  if (isolated.memoryType === 'semantic') {
    await storage.semantic.update(isolated.memoryId, { confidence: 0.01 })
  }
  // Procedural isolation noted but no confidence field — skip for now
  isolatedCount++
}
```

Also update the Neo4j node itself to record the deprioritization:

```cypher
MATCH (m:Memory {id: $memoryId})
SET m.deprioritizedAt = $now
```

#### Updated function signature

```typescript
export async function decayPass(
  storage: StorageAdapter,
  opts?: DecayPassOptions,
  graph?: NeuralGraph | null
): Promise<ConsolidateResult>
```

---

### Section 5: Graph Health Metrics — New MCP Tool

**File to modify:** `packages/mcp/src/server.ts` (or wherever MCP tools are registered)

Add a new MCP tool `memory_graph_health` that returns a snapshot of the Neo4j graph's structural health. This tool requires the `graph` instance to be available. When Neo4j is not configured, return an error response.

#### Tool definition

```typescript
{
  name: 'memory_graph_health',
  description: 'Returns structural health metrics for the Engram Neo4j graph: node/edge counts, community distribution, bridge nodes, PageRank distribution, and edge age statistics.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  }
}
```

#### Handler implementation

The handler runs six Cypher queries against Neo4j and assembles the result. All six can be parallelized via `Promise.all()`.

Query 1 — Total nodes and edges by label/type:

```cypher
MATCH (n)
RETURN labels(n)[0] AS label, count(n) AS nodeCount
ORDER BY nodeCount DESC
```

```cypher
MATCH ()-[r]->()
RETURN type(r) AS relType, count(r) AS edgeCount
ORDER BY edgeCount DESC
```

Query 2 — Community distribution:

```cypher
MATCH (m:Memory)
WHERE m.communityId IS NOT NULL
RETURN m.communityId AS communityId, count(m) AS memberCount
ORDER BY memberCount DESC
LIMIT 20
```

Query 3 — Bridge node count:

```cypher
MATCH (m:Memory) WHERE m.isBridge = true RETURN count(m) AS bridgeCount
```

Query 4 — PageRank distribution:

```cypher
MATCH (m:Memory) WHERE m.pageRank IS NOT NULL
RETURN
  avg(m.pageRank) AS meanPageRank,
  max(m.pageRank) AS maxPageRank,
  percentileCont(m.pageRank, 0.5) AS medianPageRank,
  percentileCont(m.pageRank, 0.9) AS p90PageRank,
  count(m) AS scoredNodes
```

Query 5 — Edge age distribution (days):

```cypher
MATCH ()-[r]->()
WHERE r.createdAt IS NOT NULL
WITH
  duration.between(datetime(r.createdAt), datetime()).days AS ageDays
RETURN
  avg(ageDays) AS meanEdgeAgeDays,
  max(ageDays) AS maxEdgeAgeDays,
  percentileCont(ageDays, 0.5) AS medianEdgeAgeDays,
  count(r) AS totalEdges
```

Query 6 — Largest community summary (topics in the biggest community):

```cypher
MATCH (m:Memory)
WHERE m.communityId IS NOT NULL
WITH m.communityId AS communityId, count(m) AS memberCount
ORDER BY memberCount DESC
LIMIT 1
WITH communityId
MATCH (m:Memory {communityId: communityId})-[:CONTEXTUAL]->(t:Topic)
RETURN t.id AS topicId, count(*) AS freq
ORDER BY freq DESC
LIMIT 10
```

Assemble the results into a single JSON object:

```typescript
return {
  nodesByLabel: /* from Query 1a */,
  edgesByType: /* from Query 1b */,
  communities: {
    totalCommunities: communities.length,
    largestCommunitySize: communities[0]?.memberCount ?? 0,
    top20Communities: communities,
  },
  bridgeNodes: bridgeCount,
  pageRank: { mean, max, median, p90, scoredNodes },
  edgeAge: { mean, max, median, totalEdges },
  largestCommunityTopics: topicSummary,
  generatedAt: new Date().toISOString(),
}
```

When `graph` is null (Neo4j not configured):

```typescript
return {
  error: 'Neo4j graph not configured. Pass a NeuralGraph instance to Memory constructor.',
  sqlOnlyMode: true,
}
```

---

### Section 6: Memory Class — Passing Graph to Consolidation Functions

**File to modify:** `packages/core/src/memory.ts`

The `Memory.consolidate()` method currently calls the four consolidation functions. Update all four calls to pass `this._graph` as the final argument:

```typescript
// Before (existing)
const result = await lightSleep(this.storage, this.intelligence, opts)

// After
const result = await lightSleep(this.storage, this.intelligence, opts, this._graph)
```

Same pattern for `deepSleep`, `dreamCycle`, `decayPass`.

No other changes to `memory.ts` are needed in Wave 3.

---

## Tests

### Test file locations

All tests live in the `packages/core/test/consolidation/` and `packages/graph/test/` directories. New test files:

```
packages/core/test/consolidation/
  light-sleep-graph.test.ts
  deep-sleep-graph.test.ts
  dream-cycle-graph.test.ts
  decay-pass-graph.test.ts

packages/graph/test/
  gds-utils.test.ts
  graph-health.test.ts
```

All consolidation graph tests are integration tests requiring a live Neo4j instance. They use the same `packages/graph/test/helpers/setup.ts` helper from Wave 1 (which handles `beforeAll` connect and `afterAll` disconnect). Each test file clears the database with `MATCH (n) DETACH DELETE n` in a `beforeEach` to ensure isolation.

### Test: Light Sleep — Digest node and merged context

**File:** `packages/core/test/consolidation/light-sleep-graph.test.ts`

```typescript
describe('lightSleep — Neo4j graph', () => {
  it('creates a Digest Memory node in Neo4j after consolidation', async () => {
    // Setup: create 5 episode Memory nodes, each connected to a Topic 'typescript'
    // and a Person 'muhammad'. 2 episodes connect to Topic 'neo4j'.
    // ... (insert via graph.runCypherWrite)

    const result = await lightSleep(storage, intelligence, {}, graph)

    // Assert: result.graphNodesCreated >= 1
    expect(result.graphNodesCreated).toBeGreaterThanOrEqual(1)

    // Assert: Digest Memory node exists in Neo4j
    const digestCheck = await graph.runCypher(
      `MATCH (d:Memory {memoryType: 'digest'}) RETURN d.id AS id LIMIT 1`
    )
    expect(digestCheck.records.length).toBe(1)
  })

  it('creates DERIVES_FROM edges from digest to each source episode', async () => {
    // ... setup 5 episodes, run lightSleep ...
    const edgeCheck = await graph.runCypher(`
      MATCH (d:Memory {memoryType: 'digest'})-[:DERIVES_FROM]->(ep:Memory {memoryType: 'episode'})
      RETURN count(ep) AS episodeCount
    `)
    expect(edgeCheck.records[0].get('episodeCount').toNumber()).toBe(5)
  })

  it('assigns CONTEXTUAL weight proportional to episode frequency', async () => {
    // 5 episodes: 4 connect to Topic 'typescript', 1 connects to Topic 'neo4j'
    // ... setup and run lightSleep ...

    const contextCheck = await graph.runCypher(`
      MATCH (d:Memory {memoryType: 'digest'})-[r:CONTEXTUAL]->(t:Topic {id: 'topic:typescript'})
      RETURN r.weight AS weight
    `)
    const weight = contextCheck.records[0].get('weight')
    // 4 out of 5 episodes → 0.8
    expect(weight).toBeCloseTo(0.8, 2)
  })

  it('creates dominant Emotion node for the digest', async () => {
    // 3 episodes with 'frustrated', 2 with 'neutral'
    // ... setup and run lightSleep ...

    const emotionCheck = await graph.runCypher(`
      MATCH (d:Memory {memoryType: 'digest'})-[:EMOTIONAL]->(em:Emotion)
      RETURN em.label AS label
    `)
    expect(emotionCheck.records[0].get('label')).toBe('frustrated')
  })

  it('does not throw when Neo4j is unavailable — returns SQL result only', async () => {
    const result = await lightSleep(storage, intelligence, {}, null)
    expect(result.cycle).toBe('light_sleep')
    expect(result.graphNodesCreated).toBeUndefined()
  })
})
```

### Test: Deep Sleep — Temporal validity and CONTRADICTS

**File:** `packages/core/test/consolidation/deep-sleep-graph.test.ts`

```typescript
describe('deepSleep — Neo4j graph', () => {
  it('creates Semantic Memory node with validFrom set to earliest source episode date', async () => {
    // Setup: source episode created 10 days ago (set createdAt explicitly)
    // ... run deepSleep ...

    const semanticCheck = await graph.runCypher(`
      MATCH (s:Memory {memoryType: 'semantic'}) RETURN s.validFrom AS validFrom LIMIT 1
    `)
    const validFrom = new Date(semanticCheck.records[0].get('validFrom'))
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    // validFrom should be within 1 day of 10 days ago (not today)
    expect(Math.abs(validFrom.getTime() - tenDaysAgo.getTime())).toBeLessThan(24 * 60 * 60 * 1000)
  })

  it('sets validUntil on superseded semantic node', async () => {
    // Setup: existing semantic node for same topic; new one supersedes it
    // ... run deepSleep with contradiction ...

    const oldNodeCheck = await graph.runCypher(`
      MATCH (old:Memory {id: $oldId}) RETURN old.validUntil AS validUntil
    `, { oldId: existingSemanticId })
    expect(oldNodeCheck.records[0].get('validUntil')).not.toBeNull()
  })

  it('creates CONTRADICTS relationship from new to old semantic node', async () => {
    // ... same setup as above ...

    const contradictCheck = await graph.runCypher(`
      MATCH (new:Memory)-[r:CONTRADICTS]->(old:Memory {id: $oldId})
      RETURN r.weight AS weight
    `, { oldId: existingSemanticId })
    expect(contradictCheck.records[0].get('weight')).toBe(1.0)
  })

  it('inherits context from source digest with MAX weight when multiple digests share context', async () => {
    // Two digest nodes, both connected to Entity 'typescript' with weights 0.9 and 0.6
    // ... setup and run deepSleep ...

    const ctxCheck = await graph.runCypher(`
      MATCH (s:Memory {memoryType: 'semantic'})-[r:CONTEXTUAL]->(e:Entity {id: 'entity:typescript'})
      RETURN r.weight AS weight
    `)
    // MAX(0.9, 0.6) * 0.7 = 0.63
    expect(ctxCheck.records[0].get('weight')).toBeCloseTo(0.63, 2)
  })
})
```

### Test: Dream Cycle — GDS operations

**File:** `packages/core/test/consolidation/dream-cycle-graph.test.ts`

```typescript
describe('dreamCycle — Neo4j GDS', () => {
  it('assigns communityId to Memory nodes after Louvain', async () => {
    // Setup: 10 Memory nodes with edges forming two clear clusters
    // ... insert via runCypherWrite ...

    const result = await dreamCycle(storage, {}, graph)

    expect(result.communitiesDetected).toBeGreaterThanOrEqual(1)

    const communityCheck = await graph.runCypher(`
      MATCH (m:Memory) WHERE m.communityId IS NOT NULL RETURN count(m) AS count
    `)
    expect(communityCheck.records[0].get('count').toNumber()).toBeGreaterThan(0)
  })

  it('clears old communityId values before running Louvain', async () => {
    // Setup: Memory nodes with stale communityId = '999'
    await graph.runCypherWrite(`MATCH (m:Memory) SET m.communityId = '999'`)

    await dreamCycle(storage, {}, graph)

    const staleCheck = await graph.runCypher(`
      MATCH (m:Memory) WHERE m.communityId = '999' RETURN count(m) AS count
    `)
    expect(staleCheck.records[0].get('count').toNumber()).toBe(0)
  })

  it('flags top 5% of Memory nodes as bridge nodes', async () => {
    // Setup: 20 Memory nodes in a hub-and-spoke topology (one central hub)
    // ... insert ...

    await dreamCycle(storage, {}, graph)

    const bridgeCheck = await graph.runCypher(`
      MATCH (m:Memory) WHERE m.isBridge = true RETURN count(m) AS count
    `)
    // At least 1 bridge should be flagged (the hub)
    expect(bridgeCheck.records[0].get('count').toNumber()).toBeGreaterThanOrEqual(1)
  })

  it('creates TOPICAL edge when replay overlap >= 3 Memory nodes', async () => {
    // Setup: seed A activates memories [M1, M2, M3, M4]
    //        seed B activates memories [M2, M3, M4, M5]
    //        overlap = {M2, M3, M4} → size 3 → should create TOPICAL edge
    // ... setup activation topology ...

    const result = await dreamCycle(storage, { replaySeeds: 2 }, graph)
    expect(result.replayEdgesCreated).toBeGreaterThanOrEqual(1)

    const topicalCheck = await graph.runCypher(`
      MATCH ()-[r:TOPICAL {discoveredVia: 'hippocampal_replay'}]->() RETURN count(r) AS count
    `)
    expect(topicalCheck.records[0].get('count').toNumber()).toBeGreaterThanOrEqual(1)
  })

  it('does NOT create TOPICAL edge when overlap is only 2 Memory nodes', async () => {
    // Setup: overlap of exactly 2 Memory nodes
    // ... setup ...

    const result = await dreamCycle(storage, { replaySeeds: 2 }, graph)

    const topicalCheck = await graph.runCypher(`
      MATCH ()-[r:TOPICAL {discoveredVia: 'hippocampal_replay'}]->() RETURN count(r) AS count
    `)
    expect(topicalCheck.records[0].get('count').toNumber()).toBe(0)
  })

  it('discovers CAUSAL edge between Topic nodes that precede each other across 3+ sessions', async () => {
    // Setup: 3 Session nodes, each with an episode connecting to Topic 'auth'
    //        followed by an episode connecting to Topic 'deployment'
    // ... insert ...

    const result = await dreamCycle(storage, { causalMinSessions: 3 }, graph)
    expect(result.causalEdgesCreated).toBeGreaterThanOrEqual(1)

    const causalCheck = await graph.runCypher(`
      MATCH (a:Topic)-[r:CAUSAL]->(b:Topic)
      RETURN a.id AS from, b.id AS to, r.sessionCount AS sessions
    `)
    expect(causalCheck.records.length).toBeGreaterThanOrEqual(1)
    const record = causalCheck.records[0]
    expect(record.get('sessions')).toBeGreaterThanOrEqual(3)
  })

  it('gracefully skips GDS operations when GDS is unavailable', async () => {
    // Mock graph.isGdsAvailable() to return false
    const mockGraph = { ...graph, isGdsAvailable: async () => false }

    const result = await dreamCycle(storage, {}, mockGraph as unknown as NeuralGraph)

    // Should not throw; communities and bridges not assigned
    expect(result.communitiesDetected).toBeUndefined()
    expect(result.bridgeNodesFound).toBeUndefined()
    // Replay and causal may still run
    expect(result.cycle).toBe('dream')
  })
})
```

### Test: Decay Pass — PageRank-modulated decay, edge pruning, isolated nodes

**File:** `packages/core/test/consolidation/decay-pass-graph.test.ts`

```typescript
describe('decayPass — Neo4j GDS', () => {
  it('decays low-PageRank semantic memories at full base rate', async () => {
    // Setup: semantic memory with pageRank = 0, confidence = 0.8, last_accessed > 30 days ago
    // ... insert in SQL and set pageRank = 0 on Neo4j node ...

    await decayPass(storage, { semanticDecayRate: 0.02 }, graph)

    const updated = await storage.semantic.getById(semanticId)
    // Full decay: 0.8 - 0.02 = 0.78
    expect(updated.confidence).toBeCloseTo(0.78, 2)
  })

  it('decays high-PageRank semantic memories at significantly reduced rate', async () => {
    // Setup: semantic memory with pageRank = maxPageRank, confidence = 0.8
    // Effective rate = 0.02 * (1 - 0.8) = 0.004
    // ... insert and set pageRank = maxPageRank ...

    await decayPass(storage, { semanticDecayRate: 0.02 }, graph)

    const updated = await storage.semantic.getById(highPrSemanticId)
    // Should be between 0.796 and 0.799 (reduced decay)
    expect(updated.confidence).toBeGreaterThan(0.795)
    expect(updated.confidence).toBeLessThan(0.800)
  })

  it('prunes edges with traversalCount = 0 older than 60 days from Neo4j', async () => {
    // Setup: TOPICAL edge with traversalCount = 0, createdAt = 90 days ago
    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    await graph.runCypherWrite(`
      MATCH (a:Memory {id: $aId}), (b:Memory {id: $bId})
      MERGE (a)-[r:TOPICAL]->(b)
      SET r.traversalCount = 0, r.createdAt = $oldDate, r.weight = 0.3
    `, { aId, bId, oldDate })

    const result = await decayPass(storage, {}, graph)

    expect(result.graphEdgesPruned).toBeGreaterThanOrEqual(1)

    const edgeCheck = await graph.runCypher(`
      MATCH (a:Memory {id: $aId})-[r:TOPICAL]->(b:Memory {id: $bId}) RETURN r
    `, { aId, bId })
    expect(edgeCheck.records.length).toBe(0)
  })

  it('does NOT prune DERIVES_FROM edges regardless of age or traversalCount', async () => {
    // Setup: DERIVES_FROM edge with traversalCount = 0, createdAt = 90 days ago
    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    await graph.runCypherWrite(`
      MATCH (d:Memory {id: $dId}), (ep:Memory {id: $epId})
      MERGE (d)-[r:DERIVES_FROM]->(ep)
      SET r.traversalCount = 0, r.createdAt = $oldDate
    `, { dId, epId, oldDate })

    await decayPass(storage, {}, graph)

    const edgeCheck = await graph.runCypher(`
      MATCH (d:Memory {id: $dId})-[r:DERIVES_FROM]->(ep:Memory {id: $epId}) RETURN r
    `, { dId, epId })
    expect(edgeCheck.records.length).toBe(1)  // still exists
  })

  it('sets confidence = 0.01 on isolated Memory nodes (zero relationships in Neo4j)', async () => {
    // Setup: a semantic memory node with no edges in Neo4j, confidence = 0.5 in SQL
    await graph.runCypherWrite(`MERGE (m:Memory {id: $id, memoryType: 'semantic'})`, { id: isolatedId })
    // Do NOT add any edges

    await decayPass(storage, {}, graph)

    const updated = await storage.semantic.getById(isolatedId)
    expect(updated.confidence).toBe(0.01)
    expect(result.isolatedNodesDeprioritized).toBeGreaterThanOrEqual(1)
  })
})
```

### Test: GDS utilities

**File:** `packages/graph/test/gds-utils.test.ts`

```typescript
describe('runWithProjectionCleanup', () => {
  it('drops and recreates a projection if it already exists', async () => {
    // First call creates 'test-graph' projection
    await graph.runCypher(`CALL gds.graph.project('test-graph', 'Memory', '*') YIELD graphName`)

    // runWithProjectionCleanup should detect 'already exists' error, drop, and recreate
    await expect(
      runWithProjectionCleanup(
        graph,
        `CALL gds.graph.project('test-graph', 'Memory', '*') YIELD graphName RETURN graphName`,
        `CALL gds.pageRank.write('test-graph', {writeProperty: 'pageRank'}) YIELD nodePropertiesWritten RETURN nodePropertiesWritten`,
        `CALL gds.graph.drop('test-graph') YIELD graphName RETURN graphName`
      )
    ).resolves.not.toThrow()
  })
})
```

### Test: Graph health MCP tool

**File:** `packages/graph/test/graph-health.test.ts`

```typescript
describe('memory_graph_health', () => {
  it('returns node counts by label', async () => {
    // Insert 3 Memory nodes and 1 Person node
    await graph.runCypherWrite(`
      MERGE (:Memory {id: 'm1'})
      MERGE (:Memory {id: 'm2'})
      MERGE (:Memory {id: 'm3'})
      MERGE (:Person {id: 'person:alice'})
    `)

    const health = await getGraphHealth(graph)

    const memoryCount = health.nodesByLabel.find(n => n.label === 'Memory')?.nodeCount
    expect(memoryCount).toBe(3)
  })

  it('returns community distribution after Louvain has run', async () => {
    // Setup nodes with communityId set
    await graph.runCypherWrite(`
      MERGE (m:Memory {id: 'm1', communityId: '0'})
      MERGE (m2:Memory {id: 'm2', communityId: '0'})
      MERGE (m3:Memory {id: 'm3', communityId: '1'})
    `)

    const health = await getGraphHealth(graph)

    expect(health.communities.totalCommunities).toBe(2)
  })

  it('returns error response when graph is null', async () => {
    const health = await getGraphHealth(null)
    expect(health.sqlOnlyMode).toBe(true)
    expect(health.error).toBeDefined()
  })
})
```

---

## Files Created or Modified

### Modified files

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add optional graph fields to `ConsolidateResult` |
| `packages/core/src/adapters/storage.ts` | Add `findEarliestInDigests()` to `EpisodeStorage`; add `batchDecayGradient()` to `SemanticStorage` and `ProceduralStorage` |
| `packages/core/src/memory.ts` | Pass `this._graph` to all four consolidation functions |
| `packages/core/src/consolidation/light-sleep.ts` | Add `graph?` param, Neo4j digest node creation |
| `packages/core/src/consolidation/deep-sleep.ts` | Add `graph?` param, Neo4j semantic/procedural node creation, temporal validity, supersession |
| `packages/core/src/consolidation/dream-cycle.ts` | Add `graph?` param, GDS Louvain, betweenness, replay, causal discovery |
| `packages/core/src/consolidation/decay-pass.ts` | Add `graph?` param, GDS PageRank, gradient decay, edge pruning, isolated node handling |
| `packages/sqlite/src/semantic.ts` | Implement `batchDecayGradient()` |
| `packages/sqlite/src/procedural.ts` | Implement `batchDecayGradient()` |
| `packages/sqlite/src/episodes.ts` | Implement `findEarliestInDigests()` |
| `packages/mcp/src/server.ts` | Register `memory_graph_health` tool |

### New files

| File | Purpose |
|------|---------|
| `packages/graph/src/gds-utils.ts` | `runWithProjectionCleanup()` utility |
| `packages/core/test/consolidation/light-sleep-graph.test.ts` | Light sleep Neo4j tests |
| `packages/core/test/consolidation/deep-sleep-graph.test.ts` | Deep sleep Neo4j tests |
| `packages/core/test/consolidation/dream-cycle-graph.test.ts` | Dream cycle GDS tests |
| `packages/core/test/consolidation/decay-pass-graph.test.ts` | Decay pass Neo4j tests |
| `packages/graph/test/gds-utils.test.ts` | GDS utility tests |
| `packages/graph/test/graph-health.test.ts` | Graph health tool tests |

### Files NOT created (by design)

| File | Reason not created |
|------|-------------------|
| `packages/sqlite/src/graph-storage.ts` | Neo4j IS the graph store — no SQL graph tables needed |
| `packages/core/src/adapters/graph-storage.ts` | Same reason — no SQL graph abstraction layer |
| Any migration adding `graph_nodes` or `graph_edges` tables | Eliminated. Neo4j persistence requires no SQL schema. |

---

## Post-Script: Implementation Notes and Ordering

### Implementation order

1. `packages/core/src/types.ts` — extend `ConsolidateResult` first (other files depend on it)
2. `packages/core/src/adapters/storage.ts` — add interface methods second (implementations depend on it)
3. `packages/sqlite/src/episodes.ts` — `findEarliestInDigests()` (needed by deep sleep before deep sleep is changed)
4. `packages/sqlite/src/semantic.ts` and `packages/sqlite/src/procedural.ts` — `batchDecayGradient()` (needed by decay pass)
5. `packages/graph/src/gds-utils.ts` — the retry utility (needed by dream cycle)
6. `packages/core/src/consolidation/light-sleep.ts` — first consolidation cycle
7. `packages/core/src/consolidation/deep-sleep.ts` — second
8. `packages/core/src/consolidation/dream-cycle.ts` — third (most complex)
9. `packages/core/src/consolidation/decay-pass.ts` — fourth
10. `packages/core/src/memory.ts` — pass `this._graph` to all four
11. `packages/mcp/src/server.ts` — graph health tool last

### Neo4j must be running before integration tests

All graph tests require `docker compose -f docker/docker-compose.neo4j.yml up -d` with the GDS plugin loaded. The `packages/graph/test/helpers/setup.ts` helper from Wave 1 handles connect/disconnect. Integration tests that require GDS should be in a separate test suite tagged `@gds` or guarded with `skipIf(!await graph.isGdsAvailable())` at the describe block level.

### Supabase adapter

The `batchDecayGradient()` method also needs to be implemented in `packages/supabase/src/semantic.ts` and `packages/supabase/src/procedural.ts`. The implementation uses Supabase's `.rpc()` or raw SQL via the service role key. The interface contract is the same. The implementing agent should add both implementations in the same step as the SQLite implementation.

`findEarliestInDigests()` for Supabase uses the `rpc` pattern or raw SQL with a JOIN against `digests` and `episodes`. Same logic as SQLite — JOIN via `json_each` equivalent in Postgres is `jsonb_array_elements_text`.

### GDS version compatibility

The Cypher in this plan uses GDS 2.x API (`gds.louvain.write`, `gds.betweenness.write`, `gds.pageRank.write`, `gds.graph.project` with the new map syntax). The Docker image `neo4j:5.26-community` with `NEO4J_PLUGINS: '["graph-data-science"]'` loads GDS 2.x automatically. If an older Neo4j image is used, `gds.graph.project` may require the legacy projection syntax — the implementing agent should verify against the running GDS version via `RETURN gds.version()` if tests fail.

### No new npm dependencies

Wave 3 adds zero new npm dependencies to any package. The GDS operations replace what would have been `graphology-communities-louvain` and `graphology-metrics`. All GDS calls go through the existing `neo4j-driver` via `NeuralGraph.runCypher()` and `NeuralGraph.runCypherWrite()`. The `gds-utils.ts` utility file is pure TypeScript with no additional dependencies.
