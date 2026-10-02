# @engram-mem/core

The brain of Engram. Core memory engine with 5 cognitive systems, intent-driven retrieval, and consolidation cycles.

## Installation

```bash
npm install @engram-mem/core
```

Requires a storage adapter. See @engram-mem/sqlite (local SQLite + BM25) or @engram-mem/postgrest (any PostgREST endpoint — hosted Supabase or self-hosted Postgres).

## Quick Example

```javascript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'

const memory = createMemory({ storage: sqliteAdapter() })
await memory.initialize()

// Ingest
await memory.ingest({ role: 'user', content: 'I prefer TypeScript' })

// Recall
const result = await memory.recall('What languages do you like?')
console.log(result.formatted)

await memory.dispose()
```

## API Reference

### createMemory(options)

Factory function that creates a Memory instance.

```typescript
interface MemoryOptions {
  storage: StorageAdapter           // Required: where to store memories
  intelligence?: IntelligenceAdapter // Optional: embeddings + summarization
  consolidation?: {
    schedule: 'auto' | 'manual'     // Default: 'manual'
  }
  tokenizer?: (text: string) => number  // For token budgets (optional)
}
```

### Memory Class

#### `initialize(): Promise<void>`

Initialize storage and restore sensory buffer snapshot. Must be called before any operations.

```javascript
await memory.initialize()
```

#### `ingest(message): Promise<void>`

Store a message. Auto-detects salience, extracts entities, creates temporal edges.

```typescript
interface Message {
  sessionId?: string  // Defaults to 'default'
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: Record<string, unknown>
}

await memory.ingest({
  role: 'user',
  content: 'My deploy target is AWS ECS',
  metadata: { source: 'slack' }
})
```

#### `ingestBatch(messages): Promise<void>`

Store multiple messages at once. More efficient than calling ingest repeatedly.

```javascript
const messages = [
  { role: 'user', content: 'Message 1' },
  { role: 'assistant', content: 'Response 1' },
  { role: 'user', content: 'Message 2' },
]
await memory.ingestBatch(messages)
```

#### `recall(query, opts?): Promise<RecallResult>`

Intent-analyzed, association-walked, primed recall. The core retrieval operation.

```typescript
interface RecallResult {
  memories: RetrievedMemory[]       // Directly matched memories
  associations: RetrievedMemory[]   // Found via association walk
  intent: IntentResult              // Detected intent
  primed: string[]                  // Topics now boosted for this session
  estimatedTokens: number           // Token count for assembled context
  formatted: string                 // Ready to inject into system prompt
  sessions?: SessionGroup[]         // v0.6: session-completeness ranking (additive)
  synthesis?: SynthesisBlock | null // v0.6: opt-in derived-from-memory block (see below)
}

interface RetrievedMemory {
  id: string
  type: 'episode' | 'digest' | 'semantic' | 'procedural'
  content: string
  relevance: number  // 0-1, including priming boost
  source: 'recall' | 'association' | 'priming'
  metadata: Record<string, unknown>
}

const result = await memory.recall('What are deployment preferences?')
console.log(`Found ${result.memories.length} direct memories`)
console.log(`Plus ${result.associations.length} associated memories`)
console.log(`Context tokens: ${result.estimatedTokens}`)
```

Options:

```typescript
interface RecallOptions {
  embedding?: number[]    // Pre-computed embedding (skip embedding service call)
  tokenBudget?: number    // Cap on estimateTokens(formatted); overrides ENGRAM_RECALL_TOKEN_BUDGET
  projectId?: string      // Per-call project scope (overrides the instance default)
  synthesize?: boolean | SynthesizeOpts  // Opt-in synthesis block (see below)
  now?: Date              // Anchor for now-relative temporal arithmetic in synthesis
  reconsolidate?: boolean // Default true; false makes the recall read-only
}

const result = await memory.recall(query, { tokenBudget: 2000 })
```

`tokenBudget` bounds the `formatted` text, not retrieval: `memories` and `associations` still hold the full ranked lists, and `result.payload` says what the text carried (`emittedMemories`, `emittedAssociations`, `emittedFaint`, `truncated`, and the character span of each emitted item). It must be a positive integer (a `RangeError` otherwise) and takes precedence over the `ENGRAM_RECALL_TOKEN_BUDGET` environment variable. Tokens are estimated as `ceil(chars / 4)`, headers included.

The text is assembled in a fixed section order: Recalled Memories, Related Memories, Knowledge Domain Context, Context, Faint Associations. Items are added in rank order and assembly stops at the first item that would exceed the budget (the prefix rule): later items and sections are not tried, so a smaller item never jumps a better-ranked one. The first item is always emitted whole. Two more environment variables shape the text: `ENGRAM_RECALL_EMIT_K` (emit only the first K Recalled memories) and `ENGRAM_RECALL_FAINT` (`on` by default, `off` drops the Faint Associations section). Unset, empty or absent, each means no limit, so `formatted` is the same unbounded text as before; a malformed value throws, naming the variable.

Ranking priors (read on every recall call; each is `on` or `off`, default `off`; any other value throws, naming the variable). With both off, ranking is unchanged.

- `ENGRAM_RECALL_HUB_DAMPING` — damps memories recalled far more often than their tier. For episode, semantic and procedural candidates, T = max(p99 of the tier's access_count, 10); the factor is 1 when access ≤ T, else `1 / (1 + ln(access / T))`. Digests get 1. The p99 comes from the storage's `accessCountQuantile` and is cached per storage instance for 10 minutes. On PostgREST it needs the `engram_access_count_quantile` function, so re-apply `packages/postgrest/schema.sql` before turning this on; with the function missing, hub damping is a no-op that logs one warning per process.
- `ENGRAM_RECALL_SEMANTIC_CONFIDENCE` — semantic candidates are scaled by `0.5 + 0.5 · clamp(confidence, 0, 1)`.

The prior is the product of the enabled factors. It multiplies each primary candidate's score, and after reranking it multiplies the rerank component again: `blended = w · rerank · prior + (1 − w) · relevance`. Graph associations are unaffected. A memory whose prior is not 1 carries it as `rankPrior`.

Exposure (`shown_count`, `last_shown`), co-recalled edges and graph edge weights are recorded only for the memories and associations the text emitted, with one `recordShown` call per tier. Recall never changes access counts or confidence: `access_count` counts recurrence (a near-duplicate ingest, a fact consolidation extracts again), so the ranking bonus it feeds is not raised by display. On PostgREST exposure needs the `engram_record_shown` function, so re-apply `packages/postgrest/schema.sql`; the SQLite store records no exposure. `reconsolidate: false` records nothing, for measurement harnesses and previews that must not change those counts.

Recall links (read on every recall call; a malformed value throws, naming the variable, before any search runs). Recall writes links because of what it displayed, and the association walk follows them on the next recall: a new `co_recalled` edge starts at strength 0.2, the walk's minimum. These switches turn each part off; their defaults are the behaviour above, and with all three at their defaults recall output and every storage and graph call are unchanged.

- `ENGRAM_RECALL_CORECALL` — `on` (default) or `off`. `off` creates and strengthens no `co_recalled` edge.
- `ENGRAM_RECALL_GRAPH_REINFORCE` — `on` (default) or `off`. `off` skips `strengthenTraversedEdges`, which otherwise adds weight to the graph relationships between consecutive emitted memories.
- `ENGRAM_RECALL_WALK_EXCLUDE` — a comma list of edge types (`temporal`, `causal`, `topical`, `supports`, `contradicts`, `elaborates`, `derives_from`, `co_recalled`) the SQL association walk does not follow at any hop, e.g. `co_recalled`. That walk runs when no graph is configured or the graph has no node for any seed; graph spreading activation is not affected. Unset or empty excludes nothing; an entry that is not an edge type throws. On PostgREST this needs `engram_association_walk` with the `p_exclude_types` parameter, so re-apply `packages/postgrest/schema.sql` before setting it; with nothing excluded the adapter sends the same request as before. The SQLite store's walk does not support the exclusion and follows every type.

Exposure is recorded whatever these are set to.

Fusion config (`ENGRAM_RECALL_FUSION`). The weights, thresholds and candidate counts that merge the vector and lexical legs, trigger the HyDE and pattern-completion passes and blend in the reranker are one validated config, resolved per recall and per key from, highest precedence first: the call's `strategyOverride: { fusion }` (a `Partial<FusionConfig>`), the `ENGRAM_RECALL_FUSION` environment variable (a JSON object, read on every call; empty means unset), and the defaults (`DEFAULT_FUSION_CONFIG`). With neither override set, ranking is byte-identical to the built-in constants. An unknown key, a non-number or an out-of-range value throws an error naming the key. The env variable is meant only for adopting a config that a measured grid (`packages/bench`, `fusion-grid`) has shown to beat the defaults, not for hand tuning.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `lexicalWeight` | `0.15` | [0, 1] | weight of the lexical boost added to a candidate's score |
| `lexicalCandidateFactor` | `5` | integer 1–50 | lexical candidates requested per result slot (`maxResults × factor`) |
| `vectorCandidateFactor` | `4` | integer 1–50 | vector candidates requested per result slot |
| `recencyDecayHours` | `720` | > 0 | time constant of the recency term, `recencyBias × exp(-ageHours / this)` |
| `accessBoostPerAccess` | `0.01` | [0, 1] | score added per recorded access |
| `accessBoostCap` | `0.1` | [0, 1] | upper bound of the summed access boost |
| `assistantRoleBoost` | `0.05` | [0, 1] | score added to assistant-role memories |
| `recallFailurePenalty` | `0.4` | [0, 1] | multiplier for an assistant message that only reports a failed recall |
| `lexicalReserveShare` | `0.5` | [0, 1] | share of `maxResults` reserved for lexical hits that missed the fused cut (only when a reranker follows) |
| `hydeTopScoreBelow` | `0.3` | ≥ 0 | HyDE fires when the top fused score is below this |
| `patternTopScoreBelow` | `0.2` | ≥ 0 | pattern completion fires when the top score after HyDE is below this |
| `rrfK` | `60` | ≥ 0 | k of the reciprocal-rank fusion of the direct and HyDE lists |
| `rerankWeight` | `0.7` | [0, 1] | reranker share of the blended score, single-hop queries |
| `rerankWeightMultiHop` | `0.85` | [0, 1] | reranker share of the blended score, multi-hop and temporal queries |

Thresholds are bounded below only because fused scores are sums of several terms and can exceed 1.

##### Synthesize mode (v0.6)

`synthesize: true` computes a **derived-from-memory block** over the recalled memories, returns it as `result.synthesis`, and appends its text to `formatted`. The `memories` array is byte-identical whether synthesis runs or not, and an explicit block header tells the answerer to verify against the memories above (abstention safety).

```typescript
const result = await memory.recall('write the commit message', { synthesize: true })
// result.synthesis?.text →
// ### Derived from memory (computed deterministically — verify against the memories above; …)
// - [constraint] Stated user preference (s42, 2026-07-01): "no attribution lines
//   in commit messages" Apply this stated preference when answering — do not
//   merely mention it.
```

By default only **preference constraint-surfacing** renders: stated user preferences quoted verbatim with session/date citations. This path is code-only — zero LLM calls at recall time — and it is the synthesis component with a significant judged gain under a current answerer (LongMemEval-S preference questions: 30.0% → 53.3% strict accuracy, p = 0.016).

```typescript
interface SynthesizeOpts {
  maxEvidenceSessions?: number   // Cap evidence to the first K distinct sessions (rank order)
  includeComputeNotes?: boolean  // Default false — see below
}
```

`includeComputeNotes: true` additionally renders the **temporal date-arithmetic** and **aggregation counting** sections: an LLM evidence-selection call per fired recall, deterministic arithmetic and template rendering, a date-anchoring hard guard (any block citing a calendar date absent from the source evidence is dropped), and no-LLM degradation tiers when no selection adapter is available. Leave it off for current thinking-tier answerers — they recompute dates and counts from the raw sessions themselves, and injected notes measured noise-level to slightly negative on judged benchmarks. Opt in for weak answerers that cannot do their own date/count arithmetic.

The structured block:

```typescript
interface SynthesisBlock {
  intent: 'temporal' | 'aggregation' | 'preference'
  method: 'date-arithmetic' | 'count-enumerate' | 'constraint-surface'
        | 'temporal-grounding' | 'evidence-index'   // last two = no-LLM degradation tier
  text: string                // Rendered block (also appended to `formatted`)
  items: SynthesisItem[]      // Machine-readable derivation trace with citations
  evidenceCount: number
  llmSelectionUsed: boolean
}
```

#### `expand(memoryId): Promise<{ episodes: Episode[] }>`

Drill into a digest to see original episodes. Useful for understanding summarized memories.

```javascript
const result = await memory.recall('deployment')
const digest = result.memories.find(m => m.type === 'digest')

if (digest) {
  const { episodes } = await memory.expand(digest.id)
  console.log(`This summary was created from ${episodes.length} original messages`)
}
```

#### `consolidate(cycle?): Promise<ConsolidateResult>`

Run consolidation cycles. Usually automatic, but can be called manually.

Cycles:
- `'light'` — Episodes → Digests (summaries)
- `'deep'` — Digests → Semantic & Procedural memories
- `'dream'` — Extract new associations between memories
- `'decay'` — Prune low-confidence items and stale edges
- `'all'` (default) — Run all cycles in sequence

```javascript
// Run light sleep consolidation
const result = await memory.consolidate('light')
console.log(`Created ${result.digestsCreated} digests`)

// Run all cycles
const fullResult = await memory.consolidate('all')
console.log(`Promoted ${fullResult.promoted} semantic memories`)
console.log(`Created ${fullResult.procedural} procedural memories`)
```

#### `stats(): Promise<MemoryStats>`

Get memory statistics across all systems.

```typescript
interface MemoryStats {
  episodes: number        // Raw conversation turns
  digests: number         // Session summaries
  semantic: number        // Extracted facts
  procedural: number      // Learned workflows
  associations: number    // Graph edges
}

const stats = await memory.stats()
console.log(`Memory contains ${stats.semantic} semantic facts`)
```

#### `forget(query, opts?)` and `forgetByIds(ids)`

Forgetting takes two steps. `forget(query)` only previews: it lists what the query matches and never writes. `forgetByIds(ids)` tombstones exactly the ids the caller approved. No relevance score decides a deletion. A tombstone hides a memory from every recall path; the row stays in storage, so it is reversible there.

```typescript
interface ForgetPreview {
  count: number
  candidates: Array<{
    id: string
    type: 'episode' | 'semantic' | 'procedural'
    content: string
    relevance: number
    projectId: string | null
    date: string | null            // YYYY-MM-DD
  }>
}

interface ForgetByIdsResult {
  forgotten: Array<{ id: string; type: 'episode' | 'semantic' | 'procedural' }>
  notFound: string[]
  outOfScope: string[]      // tagged with another project than a scoped instance's
  notForgettable: string[]  // digests have no tombstone
}

// 1. Preview (optional tier filter)
const preview = await memory.forget('legacy API endpoint', { tier: 'semantic' })

// 2. Tombstone the ones you approved (1–50 ids per call)
const approved = preview.candidates.filter(c => c.content.includes('/v1/export')).map(c => c.id)
const result = await memory.forgetByIds(approved)
console.log(`Forgot ${result.forgotten.length} memories`)
```

#### `session(sessionId?): SessionHandle`

Get or create a session-scoped handle. Sessions partition memories by conversation.

```typescript
interface SessionHandle {
  readonly sessionId: string
  ingest(message: Omit<Message, 'sessionId'>): Promise<void>
  recall(query: string, opts?: RecallOptions): Promise<RecallResult>
}

// Auto-generate sessionId
const sess = memory.session()
console.log(`Created session: ${sess.sessionId}`)

// Or provide your own
const sess2 = memory.session('user-123-conversation-abc')

// All ingests automatically tagged with sessionId
await sess.ingest({ role: 'user', content: 'Hello' })

// Recalls are still cross-session, but primed toward this session
const result = await sess.recall('previous context?')
```

#### `dispose(): Promise<void>`

Release resources. Persists sensory buffer snapshot to storage for restoration on next init.

```javascript
await memory.dispose()
```

## Memory Systems Explained

### Sensory Buffer (Working Memory)

In-memory store of the agent's current focus. ~100 items, volatile.

- **Items** — Extracted entities, topics, decisions, preferences
- **Primed Topics** — Boosted for future recalls, decay each turn
- **Active Intent** — Current goal driving retrieval strategy

Saved/restored on session boundaries.

### Episodic System

Lossless store of every conversation turn. Ground truth. Never deleted.

- Includes role (user/assistant/system), content, timestamp
- Auto-scored for salience (importance)
- Can be marked "consolidated" but stays retrievable
- Linked temporally to nearby episodes

### Semantic System

Extracted facts and concepts. The agent's knowledge.

- Decays by confidence score (0-1)
- Confidence floor at 0.05 (below retrieval threshold)
- Supersession tracking (newer facts replace older ones)
- Reconstructed from digests during deep sleep

### Procedural System

Learned workflows, preferences, habits. The agent's expertise.

- Category: workflow, preference, habit, pattern, convention
- Trigger: conditions that activate this procedure
- Procedure: what to do when triggered
- Confidence + observation count drive retrieval weight

### Associative Network

Graph edges between all memories. 8 edge types:

- **temporal** — Episodes that happened near in time
- **causal** — One event caused another
- **topical** — Share a topic/entity
- **supports** — One fact supports another
- **contradicts** — One fact contradicts another
- **elaborates** — One fact elaborates on another
- **derives_from** — Fact derives from procedure
- **co_recalled** — Often retrieved together

Followed during association walk phase of recall.

## Intent Types

Engram auto-detects query intent and chooses retrieval strategy:

- `TASK_START` — Beginning new task (procedure-heavy)
- `TASK_CONTINUE` — Continuing task (recent episodic)
- `QUESTION` — Information request (semantic + associations)
- `RECALL_EXPLICIT` — "Remember when..." (episodic)
- `DEBUGGING` — Problem-solving (procedural + semantic)
- `PREFERENCE` — User preferences (procedural)
- `REVIEW` — Reviewing past work (episodic + digests)
- `CONTEXT_SWITCH` — Switching topics (reset priming)
- `EMOTIONAL` — Emotional expression (limited recall)
- `SOCIAL` — Social interaction (limited recall)
- `INFORMATIONAL` — General information (semantic)

No manual tuning needed — intent is inferred from query text.

## Types Reference

See `src/types.ts` for full type definitions:

```typescript
// Core types
export type MemoryType = 'episode' | 'digest' | 'semantic' | 'procedural'
export type EdgeType = 'temporal' | 'causal' | 'topical' | 'supports' | 'contradicts' | 'elaborates' | 'derives_from' | 'co_recalled'
export type IntentType = /* 11 types listed above */

// Memory records
export interface Episode { /* ... */ }
export interface Digest { /* ... */ }
export interface SemanticMemory { /* ... */ }
export interface ProceduralMemory { /* ... */ }
export interface Association { /* ... */ }

// Results
export interface RecallResult { /* ... */ }
export interface ConsolidateResult { /* ... */ }

// Adapters
export interface StorageAdapter { /* ... */ }
export interface IntelligenceAdapter { /* ... */ }
```

## Performance Notes

- **SQLite backend** — Single-file, no server. Great for local agents. Can handle millions of memories.
- **BM25 search** — Keyword-based, instant. Embed into vectors for semantic search.
- **Intent analysis** — Heuristic (fast, local). Future LLM-powered version available at Level 3.
- **Consolidation** — CPU-bound. Light sleep: ~100ms per batch. Deep sleep: ~1-2s. Dream cycle: ~2-5s depending on graph size.

## Troubleshooting

**Q: Memory not initialized error**

A: Call `await memory.initialize()` before any operations.

**Q: No memories found on recall**

A: Check that messages were ingested with matching sessionId (or default). Wait for consolidation to run to create semantic/procedural memories from episodes.

**Q: High token estimate**

A: Pass `tokenBudget` (or set `ENGRAM_RECALL_TOKEN_BUDGET` / `ENGRAM_RECALL_EMIT_K`) to bound `formatted`. Memories are ranked by relevance and the text keeps a prefix of that ranking, so the top results always survive.

**Q: Sensory buffer not restored**

A: Snapshot is saved on `dispose()`. If process crashes, snapshot is lost. Ephemeral by design.

## Contributing

Contributions welcome! See [CONTRIBUTING.md](../../CONTRIBUTING.md) at repo root.

## License

MIT
