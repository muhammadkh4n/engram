# Wave 2: Rewire Ingestion & Retrieval Pipeline (Neo4j)

**Status**: Ready for implementation
**Depends on**: Wave 1 complete (`@engram-mem/graph` package exists with NeuralGraph wrapping `neo4j-driver`, SpreadingActivation via Cypher, node/edge types)
**Produces**: Graph-enriched ingestion into Neo4j, spreading-activation retrieval via Cypher variable-length paths, composite memory output with environmental context

---

## Pre-Script: Full Project Context

### What Engram Is

Engram is a TypeScript monorepo cognitive memory engine for AI agents. Its central thesis is that current agent memory systems (vector RAG, compressed summaries, filesystem tools) treat memory as a retrieval problem. Engram treats it as a neuroscience problem.

The neuroscience vision comes from five empirically-validated principles:

1. **Complementary Learning Systems (CLS)** — The hippocampus captures episodic episodes rapidly and losslessly. The neocortex slowly extracts semantic generalizations. Both are necessary. Engram models this as episodic storage (raw exchanges) + semantic storage (extracted facts) with explicit sleep-cycle consolidation.

2. **Spreading Activation** — Human memory retrieval does not just find the single best match. It fans outward: recalling "coffee" activates "morning", "office", "colleague", "project X". This is modeled in ACT-R as `A_i = B_i + sum_j(W_j * S_ji) + P_i + epsilon` where S_ji encodes how strongly context j activates chunk i. Wave 2 implements this via Cypher variable-length path traversal in Neo4j.

3. **Reconsolidation** — Memories are not static. Every time a memory is recalled, it becomes labile and gets slightly strengthened. Wave 2 implements edge weight strengthening on traversal via Neo4j relationship property updates.

4. **Emotional Tagging (Amygdala Model)** — Emotionally-charged events are encoded more strongly and retrieved more readily. Wave 2 connects emotion to the graph as `(:Emotion)` nodes so emotional context is retrievable alongside memory content.

5. **Context-Dependent Memory** — Memories encoded in a particular context (session, emotional state, intent, conversation partner) are more easily recalled when that context is re-active. Wave 2 makes this explicit: `(:Session)`, `(:Person)`, `(:Emotion)`, and `(:Intent)` become retrievable environmental context, not just metadata.

### Monorepo Package Map

```
packages/
  core/       @engram-mem/core     — The brain. Memory class, 5 memory systems, 4 consolidation
                                  cycles, 11-type intent classification, hybrid retrieval
  sqlite/     @engram-mem/sqlite   — SQLite storage (vector cosine sim + BM25 FTS5)
  supabase/   @engram-mem/supabase — Supabase/Postgres storage (pgvector)
  openai/     @engram-mem/openai   — OpenAI intelligence adapter
  mcp/        @engram-mem/mcp      — MCP server (memory_recall, memory_ingest, memory_forget)
  graph/      @engram-mem/graph    — NEW from Wave 1 (Neo4j-backed NeuralGraph)
```

### What Wave 1 Built (Neo4j Version)

Wave 1 created `packages/graph/` containing `@engram-mem/graph`. An implementing agent must treat the following as ground truth about what exists in that package.

**Infrastructure**: Neo4j Community Edition runs in Docker, Bolt port 7687. The package wraps `neo4j-driver` (not an in-process graph — all graph state lives in Neo4j, not in JavaScript memory).

**NeuralGraph class** wrapping `neo4j-driver`:

```typescript
// Factory function — returns a connected NeuralGraph
export function createNeuralGraph(opts?: {
  uri?: string      // default: 'bolt://localhost:7687'
  username?: string // default: 'neo4j'
  password?: string // default: 'engram-dev'
}): NeuralGraph

export class NeuralGraph {
  // Session management
  async connect(): Promise<void>                // verify connectivity + run constraint migrations
  async disconnect(): Promise<void>             // close Neo4j driver

  // Primary ingestion entry point
  async decomposeEpisode(episode: EpisodeInput): Promise<void>
  //   EpisodeInput = { id, sessionId, role, content, salience, entities, createdAt }
  //   Creates ALL nodes/edges for one episode in a SINGLE Neo4j transaction.

  // Spreading activation (primary retrieval mechanism in Wave 2)
  async spreadActivation(opts: SpreadActivationOpts): Promise<ActivatedNode[]>
  //   SpreadActivationOpts = { seedNodeIds, seedActivations, maxHops, decay, threshold, edgeFilter }

  // Entity-based seed lookup (independent graph retrieval path)
  async lookupEntityNodes(names: string[]): Promise<EntitySeedResult[]>
  //   Returns { nodeId, nodeType, name } for any Person/Entity/Topic matching names[]

  // Batch content loader (for resolved Memory nodes only)
  // NOT a content store — graph has node IDs, SQL has content
  async getMemoryNodeIds(nodeIds: string[]): Promise<string[]>
  //   Filters nodeIds to those that are Memory nodes; returns their memoryId values

  // Edge strengthening (reconsolidation)
  async strengthenTraversedEdges(traversedEdgePairs: Array<[string, string]>): Promise<void>
  //   For each (sourceId, targetId) pair: SET r.weight = min(r.weight + 0.02, 1.0)

  // Health check
  async isAvailable(): Promise<boolean>
}
```

**8 Node Labels** (Neo4j uses labels, not types):

```
:Memory       — pointer to a SQL episode/digest/semantic/procedural row
:Person       — named conversation participant (singleton by name)
:Topic        — subject area (singleton by normalized name)
:Entity       — technology/project/concept (singleton by normalized name)
:Emotion      — classified emotional tone (singleton by label)
:Intent       — content intent (singleton by intentType)
:Session      — conversation session (singleton by sessionId)
:TimeContext  — temporal anchor (singleton by yearWeek + dayOfWeek + timeOfDay)
```

**Node ID Convention** (used as `id` property in Neo4j, not Neo4j's internal node ID):

| Label        | ID Format                          | Example                      |
|-------------|-------------------------------------|------------------------------|
| Memory       | SQL primary key (UUID v7)           | `019587a3-...`               |
| Person       | `person:{lowercase_name}`           | `person:muhammad`            |
| Topic        | `topic:{lowercase_name}`            | `topic:engram`               |
| Entity       | `entity:{lowercase_name}`           | `entity:typescript`          |
| Emotion      | `emotion:{label}`                   | `emotion:frustrated`         |
| Intent       | `intent:{intentType}`               | `intent:DEBUGGING`           |
| Session      | `session:{sessionId}`               | `session:abc123`             |
| TimeContext  | `time:{yearWeek}:{dayOfWeek}:{tod}` | `time:2026-W14:monday:night` |

All context nodes are created via `MERGE` on `id`. This makes them singletons: the same `Person` node for "Muhammad" is reused by every episode mentioning Muhammad. This is the engram cell property — shared context nodes form implicit associative links between memories that share that context.

**13 Relationship Types**:

```
TEMPORAL      — (:Memory)-[:TEMPORAL]->(:Memory)             adjacent episodes in session
CAUSAL        — (:Memory)-[:CAUSAL]->(:Memory)               A caused B
TOPICAL       — (:Memory)-[:TOPICAL]->(:Memory)              entity co-occurrence
SUPPORTS      — (:Memory)-[:SUPPORTS]->(:Memory)             A reinforces B
CONTRADICTS   — (:Memory)-[:CONTRADICTS]->(:Memory)          A conflicts with B
ELABORATES    — (:Memory)-[:ELABORATES]->(:Memory)           A adds detail to B
DERIVES_FROM  — (:Memory)-[:DERIVES_FROM]->(:Memory)         digest←episode, semantic←digest
CO_RECALLED   — (:Memory)-[:CO_RECALLED]->(:Memory)          recalled together
SPOKE         — (:Person)-[:SPOKE]->(:Memory)                person authored/mentioned
CONTEXTUAL    — (:Memory)-[:CONTEXTUAL]->(:Entity|:Topic)    entity appeared in memory
EMOTIONAL     — (:Memory)-[:EMOTIONAL]->(:Emotion)           memory had this tone
INTENTIONAL   — (:Memory)-[:INTENTIONAL]->(:Intent)          memory had this purpose
OCCURRED_IN   — (:Memory)-[:OCCURRED_IN]->(:Session)         memory belongs to session
```

**All relationships carry**: `weight FLOAT`, `createdAt STRING`, `lastTraversed STRING`, `traversalCount INTEGER`.

**SpreadingActivation** uses Cypher variable-length path traversal:

```cypher
MATCH path = (seed)-[*1..{maxHops}]->(activated)
WHERE seed.id IN $seedIds
  AND ALL(r IN relationships(path) WHERE r.weight >= $minWeight)
RETURN activated.id AS nodeId,
       labels(activated)[0] AS nodeType,
       length(path) AS depth,
       reduce(w = 1.0, r IN relationships(path) | w * r.weight * $decay) AS activation
ORDER BY activation DESC
LIMIT $budget
```

This is NOT manual BFS in JavaScript. The Cypher engine handles traversal. The `SpreadingActivation` class in `@engram-mem/graph` wraps this query with the correct parameter mapping.

**Context extraction functions** (pure TypeScript, no I/O, re-exported from `@engram-mem/graph`):

```typescript
// From packages/graph/src/context-extractors.ts

// Extract person names from content — returns PersonNodeData[]
function extractPersons(content: string, role?: string): PersonNodeData[]

// Classify emotional tone — returns EmotionNodeData with label + intensity
function classifyEmotion(content: string): EmotionNodeData

// Classify content intent (same 11-type taxonomy as query intent, applied to stored content)
function classifyContentIntent(content: string): IntentNodeData
```

**`decomposeEpisode` contract** — all of the following happens in a single Neo4j write transaction:

1. `MERGE (:Memory {id: episode.id})` SET all properties
2. For each person extracted from content: `MERGE (:Person {id: 'person:{name}'})`, create `SPOKE` edge
3. For each entity in `episode.entities[]`: `MERGE (:Entity {id: 'entity:{name}'})`, create `CONTEXTUAL` edge
4. For entities that look like topics (projects, domains): `MERGE (:Topic {id: 'topic:{name}'})`, create `CONTEXTUAL` edge
5. `MERGE (:Emotion {id: 'emotion:{label}'})`, create `EMOTIONAL` edge with weight scaled by intensity
6. `MERGE (:Intent {id: 'intent:{intentType}'})`, create `INTENTIONAL` edge
7. `MERGE (:Session {id: 'session:{sessionId}'})`, create `OCCURRED_IN` edge
8. `MERGE (:TimeContext {id: 'time:{yearWeek}:{dayOfWeek}:{timeOfDay}'})`, create `CONTEXTUAL` edge
9. If previous episode ID is provided: `MERGE (:Memory {id: prevId})-[:TEMPORAL]->(:Memory {id: episode.id})`

All nine steps run in one `session.writeTransaction()` call. If any step fails, the whole transaction rolls back. The calling code in `memory.ts` catches the failure and logs a warning — ingestion still completes via SQL.

---

## Wave 2 Scope

Wave 2 has two jobs:

1. **Rewire ingestion** — Every ingested episode gets decomposed into Neo4j nodes + edges via `NeuralGraph.decomposeEpisode()`. Fire-and-forget, non-blocking. SQL remains the durable store.

2. **Rewire retrieval** — Add entity-based seed injection (the independent graph retrieval path). Replace the old SQL association walk (`stageAssociate`) with `stageActivate` which calls Neo4j spreading activation. Assemble `CompositeMemory` from activated context nodes. Full fallback to SQL walk when Neo4j is unavailable or has sparse coverage.

### Dual Storage Architecture

**AUDIT FIX — Dual Edge Systems**: SQL temporal associations and Neo4j graph edges are both created. They are NOT redundant — they serve different roles:

- **SQL `associations` table** is the durable source of truth. It survives Neo4j being down, reset, or migrated. The existing `stageAssociate` walk uses it. Decay Pass prunes it. Dream Cycle writes to it. It is always written.
- **Neo4j graph** is the acceleration layer. It enables spreading activation through heterogeneous node types (Person, Topic, Emotion) that SQL has no concept of. It enables entity-based seed injection. It enables variable-depth traversal without recursive CTEs. It is written on a best-effort basis.

The agent implementing Wave 2 must NOT remove the SQL `associations.createTemporalEdges()` call in `ingest()`. Neo4j decomposition is an addition, not a replacement.

---

## Section 1: Changes to `packages/core/src/memory.ts`

### 1.1 New Instance Variables

In the `Memory` class body, add after the existing `_associations` declaration (line 49):

```typescript
// Graph is optional. null = Neo4j unavailable or not configured.
// All graph operations null-check this field. Ingestion and retrieval
// fall back gracefully to SQL-only mode when graph is null.
private _graph: NeuralGraph | null = null
```

`NeuralGraph` is imported as a type only to keep `@engram-mem/graph` an optional peer dependency:

```typescript
// At top of file, after existing imports (line 16):
import type { NeuralGraph } from '@engram-mem/graph'
```

The concrete instance is created via dynamic import inside `initialize()` so the import never fails when `@engram-mem/graph` is absent.

### 1.2 Updated `MemoryOptions` Interface

Add an optional `graph` field to `MemoryOptions` (around line 22):

```typescript
export interface MemoryOptions {
  storage: StorageAdapter
  intelligence?: IntelligenceAdapter
  consolidation?: { schedule: 'auto' | 'manual' }
  tokenizer?: (text: string) => number
  // Optional Neo4j graph. When provided, enables graph decomposition on
  // ingest and spreading activation on recall. When omitted, the system
  // operates in SQL-only mode with the legacy association walk.
  graph?: NeuralGraph
}
```

The `graph` option accepts a pre-constructed `NeuralGraph` instance (the caller already ran `createNeuralGraph()` and `connect()`). This keeps initialization order explicit: the caller connects to Neo4j, verifies it, then passes the instance in. The `Memory` class does not manage the Neo4j driver lifecycle.

### 1.3 Constructor Change

Update the constructor (lines 51–56) to accept the optional graph:

```typescript
constructor(opts: MemoryOptions) {
  this.storage = opts.storage
  this.intelligence = opts.intelligence
  this.sensory = new SensoryBuffer()
  this.intentAnalyzer = new HeuristicIntentAnalyzer()
  // Null when not provided. isAvailable() check happens in initialize().
  this._graph = opts.graph ?? null
}
```

### 1.4 Updated `initialize()`

Extend `initialize()` to verify graph connectivity. If the graph was provided but Neo4j is unreachable, log a warning and set `_graph` to null rather than crashing:

```typescript
async initialize(): Promise<void> {
  await this.storage.initialize()
  this.initialized = true

  // Verify graph connectivity. If Neo4j is down, degrade gracefully to
  // SQL-only mode. Ingestion and retrieval still work — they just use the
  // legacy association walk instead of spreading activation.
  if (this._graph !== null) {
    try {
      const available = await this._graph.isAvailable()
      if (!available) {
        console.warn('[engram] Neo4j unavailable — running in SQL-only mode')
        this._graph = null
      }
    } catch (err) {
      console.warn('[engram] Neo4j connectivity check failed, degrading to SQL-only:', err)
      this._graph = null
    }
  }
}
```

### 1.5 Changes to `ingest()` (lines 90–164)

The existing `ingest()` logic runs unchanged through line 163 (the `recentIds` temporal association block). After the `this.associations.createTemporalEdges(...)` call, add the Neo4j decomposition block:

```typescript
// --- Graph decomposition (Neo4j, fire-and-forget) ---
// Runs AFTER SQL episode insert succeeds. Non-blocking: does NOT await.
// If Neo4j is down or decomposeEpisode throws, the warning is logged but
// ingest() completes normally with the SQL record intact.
//
// AUDIT FIX — Dual edge systems: SQL temporal associations above are still
// created. Neo4j edges are created IN ADDITION. SQL is the durable source
// of truth. Neo4j is the acceleration layer. Both always get written.
if (this._graph !== null) {
  const previousEpisodeId = recentIds.length > 0 ? recentIds[recentIds.length - 1] : undefined

  this._graph.decomposeEpisode({
    id: episode.id,
    sessionId,
    role: message.role,
    content: cleanText,
    salience: episode.salience,
    entities: entities,
    createdAt: episode.createdAt.toISOString(),
    previousEpisodeId,
  }).catch((err: unknown) => {
    console.warn('[engram] graph decomposition failed (non-fatal):', err)
  })
}
```

The `.catch()` swallows errors without rethrowing. The `void` return of the decomposeEpisode call means `ingest()` does not await it — the SQL path is already complete by this point.

**Why fire-and-forget**: Neo4j writes are supplementary. A 10–50ms Neo4j write latency would add noticeable overhead to every ingest call. The SQL store is durable. If Neo4j loses a few episodes during a brief outage, those episodes simply have no graph nodes — retrieval falls back to the SQL walk for them (see the mixed population fallback in Section 2.3).

### 1.6 Changes to `recall()` (lines 180–222)

The `recall()` method passes the graph reference into `engineRecall`. Update the `engineRecall` call (around line 204):

```typescript
const result = await engineRecall(query, this.storage, this.sensory, {
  strategy,
  embedding: embedding ?? [],
  tokenBudget: opts?.tokenBudget,
  intelligence: this.intelligence,
  graph: this._graph,  // null when Neo4j unavailable — triggers SQL fallback in engine
})
```

### 1.7 Changes to `forget()` (lines 363–411)

**AUDIT FIX — forget() passes graph**: `forget()` calls `engineRecall` internally. Pass the graph there too so it can use graph-aware retrieval when finding what to forget:

```typescript
const result = await engineRecall(query, this.storage, this.sensory, {
  strategy: RECALL_STRATEGIES['deep'],
  embedding: [],
  graph: this._graph,  // AUDIT FIX: was missing graph parameter
})
```

This is purely additive — it does not change the forgetting logic, only the quality of what gets found.

---

## Section 2: Changes to `packages/core/src/retrieval/engine.ts`

### 2.1 Updated `RecallOpts` Interface

Add the `graph` field (after the existing `tokenBudget` field, around line 31):

```typescript
export interface RecallOpts {
  strategy: RecallStrategy
  embedding: number[]
  intelligence?: IntelligenceAdapter
  sessionId?: string
  tokenBudget?: number
  // Optional Neo4j graph. When null, spreading activation is skipped and
  // the legacy SQL association walk (stageAssociate) is used instead.
  // AUDIT FIX: defaults to null so existing callers need no changes.
  graph?: NeuralGraph | null
}
```

The `graph` field is optional with no default — TypeScript treats it as `NeuralGraph | null | undefined`. All internal code normalizes it to `graph ?? null` on first use.

### 2.2 New Import in `engine.ts`

Add at the top of `engine.ts`, alongside existing imports:

```typescript
import type { NeuralGraph } from '@engram-mem/graph'
import { stageActivate } from './spreading-activation.js'
import { assembleContext } from './context-assembly.js'
```

`stageActivate` and `assembleContext` are new files defined in Sections 3.1 and 3.2 below.

### 2.3 Revised `recall()` Function Body

The full revised `recall()` function in `engine.ts`. Lines that are unchanged from the existing code are noted with comments. Changed sections are written in full.

```typescript
export async function recall(
  query: string,
  storage: StorageAdapter,
  sensory: SensoryBuffer,
  opts: RecallOpts
): Promise<RecallResult> {
  const { strategy, embedding, intelligence, sessionId } = opts
  // AUDIT FIX: normalize graph — undefined and null both mean "no graph"
  const graph = opts.graph ?? null

  // --- Unchanged: skip mode ---
  if (strategy.mode === 'skip') {
    return {
      memories: [],
      associations: [],
      strategy,
      primed: [],
      estimatedTokens: 0,
      formatted: '',
    }
  }

  // --- Unchanged: query expansion ---
  let expandedTerms: string[] | undefined
  if (strategy.expand && intelligence?.expandQuery) {
    try {
      expandedTerms = await intelligence.expandQuery(query)
    } catch {
      // expansion failed — proceed without it
    }
  }

  // --- Unchanged: Stage 1 — Unified vector-first search ---
  // Vector + BM25 results are now SEED generators for spreading activation,
  // not the final result set. They still run the same way.
  let memories = await unifiedSearch({
    query,
    embedding,
    strategy,
    storage,
    sensory,
    sessionId,
    expandedTerms,
  })

  // --- Unchanged: HyDE fallback ---
  const topScore = memories[0]?.relevance ?? 0
  if (topScore < 0.3 && intelligence?.generateHypotheticalDoc && intelligence?.embed) {
    try {
      const hydeDoc = await intelligence.generateHypotheticalDoc(query)
      const hydeEmbedding = await intelligence.embed(hydeDoc)
      const hydeMemories = await unifiedSearch({
        query,
        embedding: hydeEmbedding,
        strategy,
        storage,
        sensory,
        sessionId,
        expandedTerms,
      })
      const merged = new Map<string, RetrievedMemory>()
      for (const m of [...memories, ...hydeMemories]) {
        const existing = merged.get(m.id)
        if (!existing || m.relevance > existing.relevance) {
          merged.set(m.id, m)
        }
      }
      memories = Array.from(merged.values())
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, strategy.maxResults)
    } catch (err) {
      console.error('[engram] HyDE fallback error:', err)
    }
  }

  // --- Stage 2: Association expansion ---
  // NEW: Try Neo4j spreading activation. Fall back to SQL walk if:
  //   (a) graph is null (Neo4j unavailable or not configured), OR
  //   (b) stageActivate returns null (no seeds mapped to graph nodes —
  //       mixed population scenario where old episodes predate Wave 2)
  //
  // AUDIT FIX — Mixed population fallback: this is the gate. The SQL
  // stageAssociate is NOT removed — it runs whenever the graph cannot help.
  let associations: RetrievedMemory[] = []
  let compositeContext: CompositeMemory | null = null

  if (strategy.associations && graph !== null) {
    const activationResult = await stageActivate(memories, query, graph, strategy)
    if (activationResult === null) {
      // Graph has no nodes for any of the vector seeds — old data.
      // Fall back to SQL association walk for this request.
      const legacyStrategy = toRetrievalStrategy(strategy)
      associations = await stageAssociate(memories, legacyStrategy, storage)
    } else {
      associations = activationResult.associations
      compositeContext = activationResult.context
    }
  } else if (strategy.associations) {
    // No graph — SQL association walk
    const legacyStrategy = toRetrievalStrategy(strategy)
    associations = await stageAssociate(memories, legacyStrategy, storage)
  }

  // --- Unchanged: Stage 3 — Topic priming ---
  const primed = stagePrime(memories, associations, sensory)

  // --- Stage 4: Reconsolidation (fire-and-forget) ---
  // AUDIT FIX: stageReconsolidate signature now accepts optional graph parameter.
  // When graph is non-null, also strengthen traversed Neo4j edges.
  const manager = new AssociationManager(storage.associations)
  stageReconsolidate(memories, associations, storage, manager, graph)

  // --- Format results ---
  const formatted = formatMemories(memories, associations, compositeContext)
  const estimatedTokens = estimateTokens(formatted)

  return {
    memories,
    associations,
    strategy,
    primed,
    estimatedTokens,
    formatted,
  }
}
```

### 2.4 Updated `formatMemories()`

Extend `formatMemories()` to include the `CompositeMemory` context section when available. The existing memory/association sections are unchanged.

```typescript
function formatMemories(
  memories: RetrievedMemory[],
  associations: RetrievedMemory[],
  context: CompositeMemory | null
): string {
  if (memories.length === 0 && associations.length === 0) return ''

  const lines: string[] = [
    '## Engram — Recalled Conversation Memory',
    '',
    'IMPORTANT: The following are memories retrieved from past conversations. If the answer to the user\'s question is found below, USE IT directly. Do not say "I don\'t have this information" if it appears here.',
    'Context tags (type, role, device, date) are for your reference — do not include them in responses unless the user asks about when/where/who.',
    '',
  ]

  if (memories.length > 0) {
    lines.push('### Recalled Memories\n')
    for (const m of memories) {
      lines.push(`- [${formatTag(m)}] ${m.content}`)
    }
  }

  if (associations.length > 0) {
    lines.push('\n### Related Memories\n')
    for (const a of associations) {
      lines.push(`- [${formatTag(a)}] ${a.content}`)
    }
  }

  // Graph context section — only present when Neo4j spreading activation ran.
  // Backward compatible: when context is null, these sections are omitted.
  if (context !== null) {
    lines.push('\n### Context\n')

    if (context.speakers.length > 0) {
      lines.push(`- Speakers: ${context.speakers.map(s => s.name).join(', ')}`)
    }
    if (context.emotionalContext.length > 0) {
      lines.push(`- Tone: ${context.emotionalContext.map(e => e.label).join(', ')}`)
    }
    if (context.relatedTopics.length > 0) {
      lines.push(`- Related topics: ${context.relatedTopics.join(', ')}`)
    }
    if (context.temporalContext.length > 0) {
      const tc = context.temporalContext[0]
      lines.push(`- Time: ${tc.timeOfDay}, ${tc.session}`)
    }

    if (context.faintAssociations.length > 0) {
      lines.push('\n### Faint Associations\n')
      for (const f of context.faintAssociations) {
        lines.push(`- [${formatTag(f)}] ${f.content}`)
      }
    }
  }

  return lines.join('\n')
}
```

---

## Section 3: New File — `packages/core/src/retrieval/spreading-activation.ts`

This file contains `stageActivate()`, which bridges the retrieval pipeline to the Neo4j spreading activation engine.

### 3.1 `CompositeMemory` Type

Define `CompositeMemory` at the top of this file. It is also exported from the file for use in `context-assembly.ts` and `engine.ts`.

```typescript
// packages/core/src/retrieval/spreading-activation.ts

import type { NeuralGraph } from '@engram-mem/graph'
import type { RetrievedMemory } from '../types.js'
import type { RecallStrategy } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import { extractEntities } from '../ingestion/entity-extractor.js'
import { assembleContext } from './context-assembly.js'

// ---------------------------------------------------------------------------
// CompositeMemory
// ---------------------------------------------------------------------------

/**
 * The structured environmental context assembled from graph activation.
 * Returned alongside core memories and associations when Neo4j is available.
 *
 * AUDIT FIX: dominantIntent renamed from 'intent' to avoid collision with
 * RecallResult.intent (which holds the HeuristicIntentAnalyzer result).
 *
 * AUDIT FIX: temporalContext is an array, not a single object — a recall
 * result may span multiple sessions/times.
 */
export interface CompositeMemory {
  /** The primary recalled memories (same as RecallResult.memories). */
  coreMemories: RetrievedMemory[]
  /** Named participants found via Person nodes. */
  speakers: Array<{ name: string; role: string }>
  /** Emotional tones found via Emotion nodes. */
  emotionalContext: Array<{ label: string; intensity: number }>
  /**
   * The dominant content intent across activated Memory nodes.
   * AUDIT FIX: named dominantIntent (not 'intent') to avoid collision
   * with RecallResult.intent which is an IntentResult from HeuristicIntentAnalyzer.
   */
  dominantIntent: string
  /**
   * Temporal contexts (session + time-of-day + date).
   * AUDIT FIX: array — a single query may recall memories from multiple sessions.
   */
  temporalContext: Array<{ session: string; timeOfDay: string; date: string }>
  /** Topic/entity nodes that appeared in activated memories. */
  relatedTopics: string[]
  /**
   * Low-activation memories (below primary threshold but above faint threshold).
   * These are memories the graph connected to but with weak signal.
   */
  faintAssociations: RetrievedMemory[]
}
```

### 3.2 Activation Parameters Per Intent Type

These parameters control how aggressively spreading activation searches the graph. They are tuned per query intent type to match the retrieval behavior each intent requires.

```typescript
// ---------------------------------------------------------------------------
// Activation parameter table (tuned per intent type)
// ---------------------------------------------------------------------------

interface ActivationParams {
  maxHops: number
  decay: number
  threshold: number      // min activation for a node to be included in results
  faintThreshold: number // min activation for faint associations (below threshold)
  budget: number         // max nodes Neo4j traversal visits before stopping
  // Edge types to filter traversal. Empty array = all types allowed.
  preferredEdges: string[]
}

const DEFAULT_PARAMS: ActivationParams = {
  maxHops: 2,
  decay: 0.6,
  threshold: 0.1,
  faintThreshold: 0.03,
  budget: 100,
  preferredEdges: [],
}

/**
 * Activation parameters per query IntentType.
 *
 * Design rationale for each row:
 *
 * TASK_START: Narrow context. You are starting something new. Retrieve
 *   recent procedural patterns and who said what (SPOKE + CONTEXTUAL).
 *   2 hops, moderate decay — don't wander into unrelated sessions.
 *
 * DEBUGGING: Follow cause-effect chains. CAUSAL and TEMPORAL edges lead
 *   to the sequence of events that caused the bug. 3 hops needed because
 *   root causes are often 2–3 steps removed from the symptom.
 *
 * RECALL_EXPLICIT: The user is explicitly asking to remember something.
 *   Maximum breadth. All edge types. 3 hops. Low decay so weak connections
 *   are still surfaced.
 *
 * QUESTION: Stay on topic. TOPICAL and SUPPORTS edges keep the traversal
 *   anchored to factual/semantic content. SPOKE for person attribution.
 *
 * PREFERENCE: Who said what and how they felt about it. SPOKE and EMOTIONAL
 *   edges. Narrow — preferences are person-specific.
 *
 * EMOTIONAL: Context-heavy retrieval. Follow emotional threads and the
 *   people involved. EMOTIONAL + SPOKE. 3 hops for rich context.
 *
 * SOCIAL: Minimal graph traversal. Social exchanges don't need deep context.
 *   1 hop, high decay — only the immediately adjacent node.
 */
const ACTIVATION_PARAMS: Record<string, ActivationParams> = {
  TASK_START: {
    maxHops: 2,
    decay: 0.5,
    threshold: 0.1,
    faintThreshold: 0.03,
    budget: 80,
    preferredEdges: ['SPOKE', 'CONTEXTUAL'],
  },
  DEBUGGING: {
    maxHops: 3,
    decay: 0.6,
    threshold: 0.08,
    faintThreshold: 0.02,
    budget: 120,
    preferredEdges: ['CAUSAL', 'TEMPORAL'],
  },
  RECALL_EXPLICIT: {
    maxHops: 3,
    decay: 0.7,
    threshold: 0.08,
    faintThreshold: 0.02,
    budget: 150,
    preferredEdges: [], // all edge types
  },
  QUESTION: {
    maxHops: 2,
    decay: 0.6,
    threshold: 0.1,
    faintThreshold: 0.03,
    budget: 100,
    preferredEdges: ['TOPICAL', 'SUPPORTS', 'SPOKE'],
  },
  PREFERENCE: {
    maxHops: 2,
    decay: 0.5,
    threshold: 0.1,
    faintThreshold: 0.03,
    budget: 80,
    preferredEdges: ['SPOKE', 'EMOTIONAL'],
  },
  EMOTIONAL: {
    maxHops: 3,
    decay: 0.7,
    threshold: 0.08,
    faintThreshold: 0.02,
    budget: 120,
    preferredEdges: ['EMOTIONAL', 'SPOKE'],
  },
  SOCIAL: {
    maxHops: 1,
    decay: 0.3,
    threshold: 0.15,
    faintThreshold: 0.05,
    budget: 30,
    preferredEdges: ['SPOKE'],
  },
}

function getActivationParams(strategy: RecallStrategy): ActivationParams {
  // strategy.mode is 'light' | 'deep' | 'skip'. For light mode, use tighter
  // params regardless of intent. For deep mode, check if we have intent-specific
  // params. The strategy does not carry IntentType directly — we use the mode
  // as a proxy: deep → RECALL_EXPLICIT defaults (broadest), light → tighter.
  if (strategy.mode === 'light') {
    return { ...DEFAULT_PARAMS, maxHops: 2, decay: 0.5, budget: 60 }
  }
  return DEFAULT_PARAMS
}
```

**Note on intent-to-mode mapping**: The existing `RecallStrategy` does not carry `IntentType`. The strategy is derived from `classifyMode()` which returns `'skip' | 'light' | 'deep'`. The `IntentType` is classified by `HeuristicIntentAnalyzer` and lives on `RecallResult.intent`. For Wave 2, activation params are indexed by `RecallMode` (light = conservative, deep = broad). Exposing `IntentType` to `stageActivate` is a Wave 3 enhancement — the table above documents target behavior for when that is wired up.

### 3.3 Entity-Based Seed Injection

**AUDIT FIX — Independent graph retrieval path**: Without entity-based seed injection, the graph only amplifies vector search results. This is problematic when the query mentions a person by name but no vector result happens to mention them — the Person node never becomes a seed, so the graph contributes nothing independent.

Entity seed injection extracts names from the QUERY (not the retrieved memories) and looks them up in Neo4j. If "Sarah" is in the query, `lookupEntityNodes(['Sarah'])` returns Sarah's Person node, which becomes an additional seed with an initial activation of 0.7. The spreading activation then fans out from Sarah's node independently of what the vector search returned.

```typescript
// ---------------------------------------------------------------------------
// Entity seed injection
// ---------------------------------------------------------------------------

/**
 * Extract query entities and look them up in Neo4j to generate additional seeds.
 *
 * AUDIT FIX — Independent graph retrieval path: This creates seeds from the
 * QUERY, not from vector results. Without this, the graph only amplifies
 * what vector search already found — it adds no independent signal.
 *
 * @returns Map of graphNodeId → initial activation (0.7 for person/entity hits)
 */
async function getEntitySeeds(
  query: string,
  graph: NeuralGraph
): Promise<Map<string, number>> {
  const seeds = new Map<string, number>()

  try {
    // extractEntities returns flat string[] of people, technologies, projects
    const entityNames = extractEntities(query)
    if (entityNames.length === 0) return seeds

    // Cypher used by lookupEntityNodes:
    //   UNWIND $entityNames AS name
    //   MATCH (n) WHERE (n:Person AND n.name = name)
    //              OR (n:Entity AND toLower(n.name) = toLower(name))
    //              OR (n:Topic AND toLower(n.name) = toLower(name))
    //   RETURN n.id AS nodeId, labels(n)[0] AS nodeType, n.name AS name
    const found = await graph.lookupEntityNodes(entityNames)

    for (const result of found) {
      // Person nodes get the highest initial activation — person attribution
      // is the strongest contextual signal we have.
      const activation = result.nodeType === 'Person' ? 0.7 : 0.5
      seeds.set(result.nodeId, activation)
    }
  } catch (err) {
    // lookupEntityNodes failure is non-fatal — seeds map stays empty
    console.warn('[engram] entity seed lookup failed:', err)
  }

  return seeds
}
```

The Cypher inside `lookupEntityNodes` (implemented in Wave 1's `@engram-mem/graph` package):

```cypher
UNWIND $entityNames AS name
MATCH (n)
WHERE (n:Person AND n.name = name)
   OR (n:Entity AND toLower(n.name) = toLower(name))
   OR (n:Topic AND toLower(n.name) = toLower(name))
RETURN n.id AS nodeId, labels(n)[0] AS nodeType, n.name AS name
```

### 3.4 `stageActivate()` Function

```typescript
// ---------------------------------------------------------------------------
// stageActivate
// ---------------------------------------------------------------------------

export interface ActivationResultSet {
  associations: RetrievedMemory[]
  context: CompositeMemory
}

/**
 * Run Neo4j spreading activation from vector search seeds + entity seeds.
 *
 * Returns null when no seeds map to graph nodes (mixed population scenario
 * where vector results are old episodes without graph nodes). The caller
 * then falls back to the legacy SQL association walk.
 *
 * AUDIT FIX — Mixed population fallback: returning null (not empty results)
 * signals "graph could not help" vs "graph ran and found nothing". These
 * have different implications for the caller.
 *
 * @param recalled  Vector + BM25 search results (the seed candidates)
 * @param query     The original user query (for entity seed injection)
 * @param graph     Neo4j NeuralGraph instance
 * @param strategy  RecallStrategy from intent classification
 * @param storage   SQL storage for batched content loading
 */
export async function stageActivate(
  recalled: RetrievedMemory[],
  query: string,
  graph: NeuralGraph,
  strategy: RecallStrategy,
  storage: StorageAdapter
): Promise<ActivationResultSet | null> {
  const params = getActivationParams(strategy)

  // --- Build seed map from vector results ---
  // Memory nodes in Neo4j have id = episode.id (same UUID as SQL).
  // A recalled memory may or may not have a graph node (mixed population).
  const seedActivations = new Map<string, number>()
  for (const m of recalled.slice(0, 8)) {
    // Memory node IDs in Neo4j ARE the SQL episode IDs — no translation needed
    seedActivations.set(m.id, m.relevance)
  }

  // --- AUDIT FIX: Entity-based seeds (independent graph retrieval path) ---
  // Extract entities from the QUERY and find matching Person/Entity/Topic nodes.
  // These seeds are independent of vector results — they surface memories
  // connected to named entities even when those memories scored low on cosine sim.
  const entitySeeds = await getEntitySeeds(query, graph)
  for (const [nodeId, activation] of entitySeeds) {
    // Don't override a vector seed if the same node already appears
    if (!seedActivations.has(nodeId)) {
      seedActivations.set(nodeId, activation)
    }
  }

  if (seedActivations.size === 0) {
    // No seeds at all — nothing to activate from
    return null
  }

  // --- Run spreading activation via Cypher ---
  let activatedNodes: Awaited<ReturnType<NeuralGraph['spreadActivation']>>
  try {
    activatedNodes = await graph.spreadActivation({
      seedNodeIds: Array.from(seedActivations.keys()),
      seedActivations,
      maxHops: params.maxHops,
      decay: params.decay,
      threshold: params.faintThreshold, // use faint threshold to get full result set
      edgeFilter: params.preferredEdges,
    })
  } catch (err) {
    console.warn('[engram] spreadActivation failed:', err)
    return null
  }

  // --- Check: did any seeds map to actual Memory nodes? ---
  // If activatedNodes only contains context nodes (Person, Topic, etc.) but
  // no Memory nodes from the seeds, the graph has no records for these episodes.
  // This is the mixed population case.
  const activatedMemoryNodes = activatedNodes.filter(n => n.nodeType === 'Memory')
  if (activatedMemoryNodes.length === 0 && entitySeeds.size === 0) {
    // Pure vector seeds, no graph nodes, no entity hits — fall back
    return null
  }

  // --- Separate primary results from faint associations ---
  const primaryNodes = activatedNodes.filter(
    n => n.nodeType === 'Memory' && n.activation >= params.threshold
  )
  const faintNodes = activatedNodes.filter(
    n => n.nodeType === 'Memory'
      && n.activation >= params.faintThreshold
      && n.activation < params.threshold
  )

  // --- AUDIT FIX: Batched content loading ---
  // Load full episode content from SQL using getByIds (one query for all IDs),
  // NOT sequential getById calls (which would be N round-trips to SQLite).
  const recalledIdSet = new Set(recalled.map(m => m.id))

  const primaryIds = primaryNodes
    .map(n => n.nodeId)
    .filter(id => !recalledIdSet.has(id))

  const faintIds = faintNodes
    .map(n => n.nodeId)
    .filter(id => !recalledIdSet.has(id) && !primaryIds.includes(id))

  // getByIds on EpisodeStorage returns Episode[] for the provided IDs.
  // IDs not found (type mismatch, deleted) are silently omitted.
  const [primaryEpisodes, faintEpisodes] = await Promise.all([
    primaryIds.length > 0 ? storage.episodes.getByIds(primaryIds) : Promise.resolve([]),
    faintIds.length > 0 ? storage.episodes.getByIds(faintIds) : Promise.resolve([]),
  ])

  // Build activation lookup for scoring
  const activationByNodeId = new Map(activatedNodes.map(n => [n.nodeId, n.activation]))

  function toRetrievedMemory(episode: Episode): RetrievedMemory {
    const activation = activationByNodeId.get(episode.id) ?? 0
    return {
      id: episode.id,
      type: 'episode' as const,
      content: episode.content,
      relevance: activation,
      source: 'association' as const,
      metadata: {
        ...episode.metadata,
        graphActivation: activation,
        activationSource: 'spreading_activation',
      },
    }
  }

  const associations = primaryEpisodes.map(toRetrievedMemory)
    .sort((a, b) => b.relevance - a.relevance)

  const faintAssociations = faintEpisodes.map(toRetrievedMemory)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 5) // cap faint associations at 5

  // --- Assemble context from non-Memory activated nodes ---
  const context = assembleContext(
    recalled,
    associations,
    faintAssociations,
    activatedNodes
  )

  return { associations, context }
}
```

**Important note on Episode type**: The `Episode` type is imported from `@engram-mem/core`. The `storage.episodes.getByIds(ids: string[])` method exists on `EpisodeStorage` — it returns `Episode[]`. This is the batched path. Do NOT call `storage.getById(id, 'episode')` in a loop.

---

## Section 4: New File — `packages/core/src/retrieval/context-assembly.ts`

### 4.1 `assembleContext()` Function

```typescript
// packages/core/src/retrieval/context-assembly.ts

import type { RetrievedMemory } from '../types.js'
import type { CompositeMemory } from './spreading-activation.js'

// ActivatedNode is the return type of NeuralGraph.spreadActivation()
interface ActivatedNode {
  nodeId: string
  nodeType: string       // 'Memory' | 'Person' | 'Topic' | 'Entity' | 'Emotion' | 'Intent' | 'Session' | 'TimeContext'
  activation: number
  depth: number
  // Properties available depend on nodeType — the graph returns them as a generic object
  properties: Record<string, unknown>
}

/**
 * Assemble CompositeMemory from activated graph nodes.
 *
 * After spreading activation, the result set includes both Memory nodes
 * (the actual recalled content) and context nodes (Person, Topic, Emotion,
 * Session, TimeContext, Intent). This function extracts the context nodes
 * and builds the structured environmental context for the MCP response.
 *
 * AUDIT FIX — temporalContext is an array: a single recall may span
 * multiple sessions, so we collect all TimeContext nodes found.
 *
 * AUDIT FIX — dominantIntent vs intent: named 'dominantIntent' to avoid
 * collision with RecallResult.intent (which is an IntentResult object
 * from HeuristicIntentAnalyzer, not a string).
 */
export function assembleContext(
  coreMemories: RetrievedMemory[],
  associations: RetrievedMemory[],
  faintAssociations: RetrievedMemory[],
  activatedNodes: ActivatedNode[]
): CompositeMemory {
  const speakers: Array<{ name: string; role: string }> = []
  const emotionalContext: Array<{ label: string; intensity: number }> = []
  const temporalContext: Array<{ session: string; timeOfDay: string; date: string }> = []
  const relatedTopics: string[] = []
  const intentCounts = new Map<string, number>()

  for (const node of activatedNodes) {
    switch (node.nodeType) {
      case 'Person': {
        const name = node.properties.name as string | undefined
        if (name) {
          speakers.push({ name, role: (node.properties.role as string | undefined) ?? 'unknown' })
        }
        break
      }
      case 'Emotion': {
        const label = node.properties.emotionLabel as string | undefined
        const intensity = node.properties.intensity as number | undefined
        if (label) {
          emotionalContext.push({ label, intensity: intensity ?? 0.5 })
        }
        break
      }
      case 'Session': {
        const sessionId = node.properties.sessionId as string | undefined
        if (sessionId) {
          // TimeContext nodes are peers — match them to this session
          temporalContext.push({
            session: sessionId,
            timeOfDay: 'unknown', // TimeContext node populates this in the next case
            date: 'unknown',
          })
        }
        break
      }
      case 'TimeContext': {
        // AUDIT FIX: update the most recent temporalContext entry with real data
        // rather than creating a new entry (session already added by Session node).
        const dayOfWeek = node.properties.dayOfWeek as string | undefined
        const timeOfDay = node.properties.timeOfDay as string | undefined
        const timestamp = node.properties.timestamp as string | undefined
        if (temporalContext.length > 0 && (timeOfDay || timestamp)) {
          const last = temporalContext[temporalContext.length - 1]
          if (timeOfDay) last.timeOfDay = timeOfDay
          if (timestamp) {
            try {
              last.date = new Date(timestamp).toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
              })
            } catch {
              last.date = timestamp.slice(0, 10)
            }
          }
          if (dayOfWeek && last.timeOfDay === 'unknown') {
            last.timeOfDay = dayOfWeek
          }
        } else if (timeOfDay || timestamp) {
          // TimeContext arrived before Session node — create standalone entry
          temporalContext.push({
            session: 'unknown',
            timeOfDay: timeOfDay ?? 'unknown',
            date: timestamp ? timestamp.slice(0, 10) : 'unknown',
          })
        }
        break
      }
      case 'Topic':
      case 'Entity': {
        const label = (node.properties.label ?? node.properties.name) as string | undefined
        if (label && !relatedTopics.includes(label)) {
          relatedTopics.push(label)
        }
        break
      }
      case 'Intent': {
        const intentType = node.properties.intentType as string | undefined
        if (intentType) {
          intentCounts.set(intentType, (intentCounts.get(intentType) ?? 0) + 1)
        }
        break
      }
    }
  }

  // Determine dominant intent: the IntentType appearing in the most activated Intent nodes
  let dominantIntent = 'INFORMATIONAL'
  let maxCount = 0
  for (const [intentType, count] of intentCounts) {
    if (count > maxCount) {
      maxCount = count
      dominantIntent = intentType
    }
  }

  // Deduplicate speakers by name (same person may appear via multiple Memory nodes)
  const uniqueSpeakers = Array.from(
    new Map(speakers.map(s => [s.name.toLowerCase(), s])).values()
  )

  // Sort topics by relevance (emotional context → topics from high-activation nodes first)
  const sortedTopics = relatedTopics.slice(0, 10) // cap at 10

  return {
    coreMemories,
    speakers: uniqueSpeakers,
    emotionalContext,
    dominantIntent,
    temporalContext,
    relatedTopics: sortedTopics,
    faintAssociations,
  }
}
```

---

## Section 5: Changes to `packages/core/src/retrieval/reconsolidation.ts`

**AUDIT FIX — `stageReconsolidate` graph parameter**: The existing signature is:

```typescript
export function stageReconsolidate(
  recalled: RetrievedMemory[],
  associated: RetrievedMemory[],
  storage: StorageAdapter,
  manager: AssociationManager
): void
```

Add the optional `graph` parameter. This is a non-breaking change — existing callers that do not pass `graph` continue to work exactly as before:

```typescript
export function stageReconsolidate(
  recalled: RetrievedMemory[],
  associated: RetrievedMemory[],
  storage: StorageAdapter,
  manager: AssociationManager,
  // AUDIT FIX: optional graph parameter — defaults to null, no signature break.
  // When non-null, strengthens Neo4j edges that were traversed during activation.
  graph: NeuralGraph | null = null
): void {
  // --- Unchanged: SQL access records + co_recalled edges ---
  const accessUpdates = [...recalled, ...associated].map(async (memory) => {
    switch (memory.type) {
      case 'semantic':
        await storage.semantic.recordAccessAndBoost(memory.id, 0.05)
        break
      case 'procedural':
        await storage.procedural.recordAccess(memory.id)
        break
      case 'episode':
        await storage.episodes.recordAccess(memory.id)
        break
      case 'digest':
        break
    }
  })

  const coRecalledUpdate = manager.createCoRecalledEdges(
    recalled.slice(0, 5).map((m) => ({ id: m.id, type: m.type }))
  )

  // --- NEW: Neo4j edge strengthening ---
  // Strengthen edges traversed during spreading activation.
  // Each traversed edge gets weight += 0.02 (capped at 1.0).
  // This is the graph analog of reconsolidation: edges used to recall
  // memories become slightly stronger, making future retrieval faster.
  //
  // We strengthen edges between consecutive memory nodes in the recalled + associated
  // sets (in activation order). The graph tracks full traversal paths — this is
  // a pragmatic approximation: strengthen the edges between the memories we
  // actually returned, not the full traversal path.
  const allReturned = [...recalled.slice(0, 5), ...associated.slice(0, 5)]
  let graphUpdate: Promise<void> = Promise.resolve()

  if (graph !== null && allReturned.length >= 2) {
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < allReturned.length - 1; i++) {
      const curr = allReturned[i]
      const next = allReturned[i + 1]
      if (curr !== undefined && next !== undefined) {
        pairs.push([curr.id, next.id])
      }
    }
    if (pairs.length > 0) {
      graphUpdate = graph.strengthenTraversedEdges(pairs).catch((err: unknown) => {
        console.warn('[engram] edge strengthening failed (non-fatal):', err)
      })
    }
  }

  // Fire and forget — don't await, swallow errors silently
  Promise.allSettled([...accessUpdates, coRecalledUpdate, graphUpdate]).catch(() => {})
}
```

---

## Section 6: Backward Compatibility Guarantees

Every change in Wave 2 is designed so that existing code paths survive without modification. This section documents each compatibility decision.

### 6.1 `@engram-mem/graph` Is Optional

`memory.ts` imports `NeuralGraph` as a type (`import type { NeuralGraph } from '@engram-mem/graph'`). The actual package is never `require()`d at runtime unless `opts.graph` is provided by the caller. Callers that do not install `@engram-mem/graph` see no error. Callers that do not pass `graph` in `MemoryOptions` get `_graph = null` and the system runs in SQL-only mode identically to pre-Wave-2 behavior.

### 6.2 `RecallOpts.graph` Is Optional

The `graph` field on `RecallOpts` is `graph?: NeuralGraph | null`. TypeScript allows callers to omit it. `engine.ts` normalizes `opts.graph ?? null` before any null-check. All existing test setups that construct `RecallOpts` without `graph` continue to compile and pass.

### 6.3 `stageReconsolidate` Signature Is Backward Compatible

The `graph` parameter has a default value of `null`. Existing callers that pass 4 arguments compile without changes. The only caller in `engine.ts` passes 5 arguments (the new signature). No other callers exist in the current codebase.

### 6.4 Mixed Population Fallback (Old Episodes)

Episodes ingested before Wave 2 have SQL records but no Neo4j graph nodes. When the vector search returns these old episodes as seeds:

1. `stageActivate` calls `graph.spreadActivation()` with those episode IDs as seeds
2. Neo4j finds no `(:Memory)` nodes with those IDs — returns empty result
3. Entity seeds may still produce results if entity names appear in the query
4. If `activatedNodes` contains zero Memory nodes AND `entitySeeds.size === 0`, `stageActivate` returns `null`
5. `recall()` detects `null` → falls back to `stageAssociate(memories, legacyStrategy, storage)`
6. The legacy SQL walk runs exactly as it did before Wave 2

Old episodes are NOT second-class citizens. They just use the SQL path. As new episodes are ingested with graph nodes, those new episodes gain full graph-accelerated retrieval. Mixed sessions (some old, some new episodes) benefit from graph retrieval for the new portions and SQL walk for the old.

### 6.5 Neo4j Down During Retrieval

If `graph.spreadActivation()` throws (Neo4j crashed mid-request):

1. `stageActivate` catches the error, logs a warning, returns `null`
2. `recall()` sees `null` → runs SQL fallback
3. `formatMemories()` receives `context = null` → omits Context and Faint Associations sections from the formatted output
4. The MCP response looks identical to a pre-Wave-2 response

This is fully transparent to the caller.

---

## Section 7: Test Specifications

All tests live in `packages/core/test/retrieval/` unless otherwise specified. Each test description is a complete spec — the implementing agent should write the test exactly as described.

### Test 7.1 — Ingestion: Graph Decomposition

**File**: `packages/core/test/retrieval/graph-ingest.test.ts`
**Setup**: Create a mock `NeuralGraph` with a spy on `decomposeEpisode`. Instantiate `Memory` with the mock graph. Call `memory.ingest()`.
**Assertions**:
1. `decomposeEpisode` was called once with an object matching `{ id: episode.id, sessionId, role, content, salience }`.
2. `decomposeEpisode` receives `entities[]` that matches what `extractEntities(content)` returns.
3. `decomposeEpisode` receives `previousEpisodeId` when a second message is ingested in the same session within 30 minutes.
4. `decomposeEpisode` does NOT receive `previousEpisodeId` for the first message.
5. If `decomposeEpisode` rejects (throws), `ingest()` still resolves without error — the episode is in SQL.

**Neo4j integration version** (requires running Neo4j): Ingest 10 episodes into a real `Memory` instance with a real connected `NeuralGraph`. Query Neo4j:
```cypher
MATCH (m:Memory) RETURN count(m) AS count
```
Verify count equals 10. Query:
```cypher
MATCH (m:Memory)-[:TEMPORAL]->(m2:Memory) RETURN count(*) AS edges
```
Verify edges equals 9 (chain linking all 10 in order).

### Test 7.2 — Entity-Based Seed Injection

**File**: `packages/core/test/retrieval/entity-seeds.test.ts`
**Setup**: Create a Neo4j graph with 5 episodes. Episode 3 has Sarah as a speaker (`:Person {id: 'person:sarah'}` with a `SPOKE` edge to `Memory {id: ep3.id}`). Vector search returns episodes 1 and 2 (which do NOT mention Sarah).
**Query**: "What did Sarah say about the deployment?"
**Assertions**:
1. `graph.lookupEntityNodes(['Sarah', ...])` is called (verify via spy).
2. The returned seeds include `'person:sarah'` with activation `0.7`.
3. `graph.spreadActivation()` receives seed IDs that include `'person:sarah'`.
4. `stageActivate` returns an `ActivationResultSet` (not null) — the entity seed kept it alive even though vector seeds had no graph nodes.
5. The `associations` in the result include episode 3 (found via Sarah's Person node).

### Test 7.3 — Mixed Population Fallback

**File**: `packages/core/test/retrieval/mixed-population.test.ts`
**Setup**: SQL has 20 episodes. Neo4j has graph nodes for episodes 11–20 only (episodes 1–10 are "old data"). Vector search returns episodes 1–5 (all old, no graph nodes). Entity seeds return empty (no named entities in query).
**Assertions**:
1. `stageActivate` returns `null`.
2. `recall()` calls `stageAssociate` (the legacy SQL walk).
3. `recall()` result has `associations` populated by the SQL walk.
4. `formatMemories` does NOT include a Context section (compositeContext is null).

**Second scenario**: Vector search returns episode 12 (has a graph node). Entity seeds return empty.
**Assertions**:
1. `stageActivate` returns an `ActivationResultSet` (not null).
2. `stageAssociate` is NOT called.

### Test 7.4 — Context Assembly

**File**: `packages/core/test/retrieval/context-assembly.test.ts`
**Setup**: Construct a synthetic `ActivatedNode[]` array with:
- 2 Memory nodes (activation 0.5, 0.3)
- 1 Person node (name: "Muhammad", role: "user")
- 1 Emotion node (label: "frustrated", intensity: 0.8)
- 1 Topic node (label: "TypeScript")
- 1 Session node (sessionId: "sess-001")
- 1 TimeContext node (dayOfWeek: "tuesday", timeOfDay: "evening", timestamp: "2026-04-01T19:00:00Z")
- 1 Intent node (intentType: "DEBUGGING")
**Call**: `assembleContext(coreMemories, associations, faintAssociations, activatedNodes)`
**Assertions**:
1. `result.speakers` contains `{ name: "Muhammad", role: "user" }`.
2. `result.emotionalContext` contains `{ label: "frustrated", intensity: 0.8 }`.
3. `result.relatedTopics` contains "TypeScript".
4. `result.dominantIntent` equals "DEBUGGING".
5. `result.temporalContext` has length 1, with `timeOfDay: "evening"` and a non-empty `date` string.
6. `result.speakers` has no duplicates when the same person appears twice in `activatedNodes`.

### Test 7.5 — Neo4j Unavailable (Graceful Degradation)

**File**: `packages/core/test/retrieval/graph-unavailable.test.ts`
**Setup**: Create a `NeuralGraph` mock where `isAvailable()` returns `false`. Pass it in `MemoryOptions`.
**Assertions — Ingestion**:
1. `memory.initialize()` resolves without throwing.
2. `memory._graph` is `null` after initialize.
3. `memory.ingest()` resolves without calling `decomposeEpisode`.
4. The episode is stored in SQL (verify via `storage.episodes.getByIds`).

**Setup — Retrieval**: Create a `NeuralGraph` mock where `spreadActivation` throws. Pass it directly to `recall()` via `RecallOpts.graph`.
**Assertions**:
1. `recall()` resolves without throwing.
2. The result has `memories` and `associations` (from SQL walk).
3. The `formatted` string does NOT contain `### Context`.

### Test 7.6 — Backward Compatibility: graph=null

**File**: `packages/core/test/retrieval/graph-null-compat.test.ts`
**Setup**: Instantiate `Memory` WITHOUT the `graph` option. Ingest 5 episodes, deep-mode recall.
**Assertions**:
1. `recall()` resolves normally.
2. `result.associations` is populated via `stageAssociate` (SQL walk). Spy on `stageAssociate` to confirm it was called.
3. `stageActivate` was NOT called (verify via spy or coverage).
4. `result.formatted` has no `### Context` section.
5. `stageReconsolidate` was called with `graph = null` (no error thrown by the default parameter).

### Test 7.7 — Batched Content Loading

**File**: `packages/core/test/retrieval/batched-load.test.ts`
**Setup**: Spy on `storage.episodes.getByIds`. Create a graph with activation results for 8 Memory nodes.
**Call**: `stageActivate()` with 8 activated Memory nodes in results.
**Assertions**:
1. `storage.episodes.getByIds` was called exactly TWICE total (once for primary nodes, once for faint nodes).
2. `storage.episodes.getByIds` was NEVER called with a single-element array in a loop (i.e., `storage.getById` was not called at all for activation results).
3. The returned `associations` contains the correct `RetrievedMemory[]` objects with `source: 'association'`.

---

## Section 8: File Change Summary

The implementing agent must modify or create exactly these files. No other files need changes.

### Modified Files

**`/packages/core/src/memory.ts`**
- Add `import type { NeuralGraph } from '@engram-mem/graph'` at line 17
- Add `graph?: NeuralGraph` to `MemoryOptions`
- Add `private _graph: NeuralGraph | null = null` instance variable
- Update constructor to store `opts.graph ?? null`
- Update `initialize()` to call `this._graph.isAvailable()` and null out on failure
- Update `ingest()` to call `this._graph.decomposeEpisode(...)` fire-and-forget after SQL insert
- Update `recall()` to pass `graph: this._graph` to `engineRecall`
- Update `forget()` to pass `graph: this._graph` to `engineRecall`

**`/packages/core/src/retrieval/engine.ts`**
- Add `import type { NeuralGraph } from '@engram-mem/graph'`
- Add `import { stageActivate } from './spreading-activation.js'`
- Add `import { assembleContext } from './context-assembly.js'`
- Add `graph?: NeuralGraph | null` to `RecallOpts`
- Update `recall()` body per Section 2.3
- Update `formatMemories()` to accept and render `CompositeMemory | null`

**`/packages/core/src/retrieval/reconsolidation.ts`**
- Add `import type { NeuralGraph } from '@engram-mem/graph'`
- Add `graph: NeuralGraph | null = null` parameter to `stageReconsolidate`
- Add Neo4j edge strengthening block per Section 5

### New Files

**`/packages/core/src/retrieval/spreading-activation.ts`**
- `CompositeMemory` interface
- `ActivationParams` interface and `ACTIVATION_PARAMS` table
- `getActivationParams()` function
- `getEntitySeeds()` function
- `ActivationResultSet` interface
- `stageActivate()` function

**`/packages/core/src/retrieval/context-assembly.ts`**
- `ActivatedNode` interface (local to this file)
- `assembleContext()` function

### Test Files (New)

- `packages/core/test/retrieval/graph-ingest.test.ts`
- `packages/core/test/retrieval/entity-seeds.test.ts`
- `packages/core/test/retrieval/mixed-population.test.ts`
- `packages/core/test/retrieval/context-assembly.test.ts`
- `packages/core/test/retrieval/graph-unavailable.test.ts`
- `packages/core/test/retrieval/graph-null-compat.test.ts`
- `packages/core/test/retrieval/batched-load.test.ts`

---

## Post-Script: What Wave 3 Builds

Wave 3 makes all four consolidation cycles graph-aware. Where Wave 2 wires the graph into real-time ingestion and retrieval, Wave 3 wires it into the offline processing cycles that run between conversations.

### Wave 3 Jobs

**Light Sleep** currently inserts `Digest` rows from episode batches and creates `derives_from` SQL edges. Wave 3 additionally: creates `(:Digest)` Memory nodes in Neo4j (one per digest), creates `DERIVES_FROM` Neo4j edges from each source episode's Memory node to the digest's Memory node, and updates `TopicNode` descriptions from the digest's `keyTopics[]`.

**Deep Sleep** currently extracts `SemanticMemory` and `ProceduralMemory` from digest content. Wave 3 additionally: creates Neo4j Memory nodes for each new semantic/procedural memory, connects them to the Topic/Entity nodes that match their `topic` field, and creates `DERIVES_FROM` edges from source digest nodes.

**Dream Cycle** currently calls `storage.associations.discoverTopicalEdges()` which runs a SQL entity co-occurrence scan. Wave 3 replaces this with a Neo4j community detection query: episodes that share 2+ common Person/Entity/Topic context nodes are strongly associated. The Cypher uses the shared neighbor count as edge weight. This is structurally superior to the SQL scan because it operates on the graph topology, not raw entity string matching.

**Decay Pass** currently prunes SQL association edges where `strength < 0.05`. Wave 3 adds: decrement `traversalCount` on Neo4j edges older than 90 days with `traversalCount = 0` (never used). Remove Neo4j Memory nodes for SQL episodes that have been hard-deleted (currently none, but the interface is built).

### Wave 3 Architecture Decision: Graph Persistence

Wave 1 created Neo4j as the graph backend — there is no JSON snapshot to replace (unlike the graphology Wave 1 which used a `graph_snapshots` blob table). Wave 3 instead focuses on:

1. Neo4j constraint migrations for new node labels introduced during consolidation (`:Digest`, `:SemanticMemory`, `:ProceduralMemory` as subtypes of `:Memory`)
2. Incremental sync verification — a reconciliation job that compares SQL episode IDs against Neo4j Memory node IDs and enqueues missing episodes for decomposition
3. Index optimization — after 3+ months of production use, the `id` property index and the `name` property index on `:Person`/`:Entity`/`:Topic` may need review based on query explain plans

### Wave 3 Timeline Constraint

Wave 3 consolidation changes must NOT be implemented until Wave 2's retrieval pipeline is verified in production with real conversation data. The specific verification criterion: at least 500 real episodes must be ingested via Wave 2's `decomposeEpisode()` path, and `stageActivate()` must produce non-null results for at least 60% of deep-mode recall queries. If this criterion is not met, the graph has insufficient coverage and Wave 3 consolidation changes would be premature.
