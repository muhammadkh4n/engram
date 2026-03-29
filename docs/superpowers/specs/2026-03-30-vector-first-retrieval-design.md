# Vector-First Retrieval Redesign

**Date:** 2026-03-30
**Status:** Design approved, pending implementation

## Problem

Engram's retrieval pipeline fails on vague queries. "What was that thing about blocking bots" returns zero results when the stored content says "Cloudflare Worker for detecting AI scrapers via behavioral fingerprinting" — zero keyword overlap.

Root cause: BM25 full-text search gets equal weight with vector search in a hybrid RRF system. BM25 uses AND semantics (`websearch_to_tsquery`), requiring all query terms to appear in the document. When BM25 returns nothing (which it does for any vague query), the episode gets at most half the possible RRF score. Additionally, 11 regex-based intent classifications gate retrieval quality — misclassification silently degrades recall.

Production systems (Mem0, Zep, MemGPT) all use vector search as the primary retriever. BM25 is supplementary.

## Design Decisions

Agreed with stakeholder during brainstorming:

1. **Vector search is the primary retriever.** BM25 is an additive boost, not co-equal.
2. **Unified cross-tier search.** One RPC returns results from episodes, digests, semantic, and procedural tiers in a single ranked list. Per-tier `search()` methods removed from the storage adapter.
3. **3 intent modes** (skip / light / deep) replace 11 regex-classified intents.
4. **LLM query expansion** on every `deep` recall. One cheap model call generates 3-5 keyword variants before search.
5. **Latency is acceptable.** Two LLM calls per deep recall (expand + embed) are OK for now.
6. **Full rearchitect.** No legacy paths. Storage adapter interface changes, old per-tier search removed.
7. **Cognitive systems untouched.** Sensory buffer, association walk, priming, reconsolidation, consolidation all stay.

## Architecture

### Retrieval Pipeline

```
Query
  → Classify intent (skip / light / deep)
  → [deep only] LLM query expansion (3-5 keyword variants)
  → Embed query (OpenAI text-embedding-3-small)
  → Unified vector search (one Supabase RPC, all tiers, top N by cosine similarity)
  → BM25 boost pass (separate RPC, OR semantics, adds score bonus to vector results)
  → Score + rank (recency, access count, role boost, priming boost)
  → [deep only] Association walk (2 hops from top 5 results)
  → Priming (extract keywords from results, prime sensory buffer for next turn)
  → Reconsolidation (fire-and-forget: record access, create co-recall edges)
```

### Intent System

3 modes with trivial classification:

| Mode | Trigger | maxResults | LLM expansion | Associations | Recency bias |
|------|---------|-----------|---------------|-------------|-------------|
| **skip** | Greetings, acks, < 10 chars | 0 | no | no | — |
| **light** | Everything not skip or deep | 8 | no | no | 0.4 |
| **deep** | Contains "?" or recall keywords (remember, recall, what did, did we, last time, previously) | 15 | yes | yes, 2 hops | 0.2 |

Classification logic: two regex checks, one fallback. No per-intent strategy table.

Types:

```typescript
type RecallMode = 'skip' | 'light' | 'deep'

interface RecallStrategy {
  mode: RecallMode
  maxResults: number
  associations: boolean
  associationHops: number
  expand: boolean
  recencyBias: number
}
```

`scoreSalience()` and `extractCues()` remain in the analyzer for ingest-time use.

### Storage Adapter Interface

```typescript
interface StorageAdapter {
  initialize(): Promise<void>
  dispose(): Promise<void>

  // Primary retrieval
  vectorSearch(embedding: number[], opts?: {
    limit?: number
    sessionId?: string
    tiers?: MemoryType[]
  }): Promise<SearchResult<TypedMemory>[]>

  // BM25 boost — OR semantics, returns IDs + boost scores only
  textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
  }): Promise<Array<{ id: string; boost: number }>>

  // Per-tier interfaces retain insert, getByIds, getBySession, etc.
  // search() removed from each
  episodes: Omit<EpisodeStorage, 'search'>
  digests: Omit<DigestStorage, 'search'>
  semantic: Omit<SemanticStorage, 'search'>
  procedural: Omit<ProceduralStorage, 'search'>
  associations: AssociationStorage

  getById(id: string, type: MemoryType): Promise<TypedMemory | null>
  getByIds(ids: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]>
  saveSensorySnapshot(sessionId: string, snapshot: SensorySnapshot): Promise<void>
  loadSensorySnapshot(sessionId: string): Promise<SensorySnapshot | null>
}
```

### IntelligenceAdapter Changes

```typescript
interface IntelligenceAdapter {
  embed(text: string): Promise<number[]>
  dimensions(): number
  expandQuery(query: string): Promise<string[]>           // NEW
  generateHypotheticalDoc?(query: string): Promise<string> // kept for HyDE fallback
}
```

`expandQuery()` uses a cheap model (gpt-4o-mini) with a tight prompt to generate 3-5 keyword variants. Expanded terms are used in two ways:

- **Vector search:** The original query is embedded as-is (not concatenated with expansions). Expansions are not separately embedded — they exist only to improve BM25 and HyDE. The original query embedding is the semantic anchor.
- **BM25 boost:** The original query terms PLUS all expansion terms are OR-joined into a single tsquery. This maximizes keyword coverage without requiring any single term to match.
- **HyDE (if triggered):** If top vector score < 0.3, the expansions are included in the hypothetical doc prompt for better generation context.

### Scoring Formula

```
baseScore     = cosineSimilarity                    // 0-1, from vector search
bm25Boost     = textBoostScore * 0.15               // 0-0.15, bonus when keywords match
recencyScore  = recencyBias * exp(-ageHours / 720)  // 0-0.4, 30-day half-life
accessBoost   = min(0.1, accessCount * 0.01)        // 0-0.1
primingBoost  = sensory.getPrimingBoost(content)     // 0-0.3, from previous turn
roleBoost     = (role === 'assistant') ? 0.05 : 0   // small boost for answers

finalScore    = baseScore + bm25Boost + recencyScore + accessBoost + primingBoost + roleBoost
```

No minRelevance threshold. Results ranked by finalScore, capped by maxResults. Token budget in `assemble()` handles truncation.

No cap at 1.0. Ranking order is what matters.

### SQL Layer

Two new Supabase RPC functions in migration `011_vector_first_search.sql`:

**`engram_vector_search`** — pure cosine similarity across all memory types:
- UNIONs across `memory_episodes`, `memory_digests`, `memory_semantic`, `memory_procedural`
- Similarity: `1 - (embedding <=> p_query_embedding)`
- Filters: `embedding IS NOT NULL`, optional session filter on episodes
- Returns: id, memory_type, content, role, salience, access_count, created_at, similarity, entities, metadata
- `ORDER BY similarity DESC LIMIT p_match_count`

**`engram_text_boost`** — OR-joined FTS, returns IDs and rank scores only:
- Same UNION across 4 tables
- Uses `to_tsquery('english', p_query_terms)` with caller-formatted OR terms
- Returns: id, memory_type, rank_score (`ts_rank_cd`)
- Lightweight — no content, no metadata

Old `engram_hybrid_recall` kept but unused. Can drop in a future migration.

Existing HNSW and GIN indexes are sufficient — no index changes.

### HyDE Fallback

Retained as a second pass. If top vector score < 0.3 after primary search:
1. Generate hypothetical document via `generateHypotheticalDoc()`
2. Embed the hypothetical document
3. Run `vectorSearch()` again with the hypothetical embedding
4. Merge results: keep highest score per ID across both passes

## Files Changed

### New
| File | Purpose |
|------|---------|
| `migrations/supabase/011_vector_first_search.sql` | `engram_vector_search` + `engram_text_boost` RPCs |
| `packages/core/src/retrieval/search.ts` | Unified retrieval: vector search → BM25 boost → score → rank |

### Rewritten
| File | What changes |
|------|-------------|
| `packages/core/src/retrieval/engine.ts` | Pipeline orchestration with 3-mode dispatch |
| `packages/core/src/intent/analyzer.ts` | 3-mode classifier, keep `scoreSalience()` and `extractCues()` |
| `packages/core/src/intent/intents.ts` | 3 strategies replace 11 |
| `packages/core/src/types.ts` | `RecallMode`, `RecallStrategy` replace old types, delete `TierPriority` |
| `packages/core/src/adapters/storage.ts` | Add `vectorSearch()`, `textBoost()`. Remove per-tier `search()` |
| `packages/core/src/memory.ts` | `recall()` passes intelligence adapter for expansion |
| `packages/supabase/src/episodes.ts` | Implement `vectorSearch()`, `textBoost()`. Remove hybrid/legacy search |
| `packages/sqlite/src/vector-search.ts` | Implement `vectorSearch()`, `textBoost()` for SQLite |
| `packages/openclaw/src/openclaw-plugin.ts` | `assemble()` and `engram_search` tool use new pipeline |
| `packages/core/src/adapters/intelligence.ts` | Add `expandQuery()` to interface |
| `packages/openai/src/index.ts` | Implement `expandQuery()` with cheap model call |

### Deleted
| File | Why |
|------|-----|
| `packages/core/src/retrieval/recall.ts` | Replaced by `search.ts` |

### Unchanged
| File | Status |
|------|--------|
| `packages/core/src/retrieval/association-walk.ts` | Operates on recalled results |
| `packages/core/src/retrieval/priming.ts` | Operates on recalled results |
| `packages/core/src/retrieval/reconsolidation.ts` | Fire-and-forget access tracking |
| `packages/core/src/systems/sensory-buffer.ts` | Unchanged |
| `packages/core/src/systems/association-manager.ts` | Unchanged |
| `packages/core/src/ingestion/content-parser.ts` | Unchanged |
| `packages/core/src/consolidation/` | Unchanged |

### Tests — rewrite needed
| File | Why |
|------|-----|
| `packages/core/test/intent/` | New 3-mode classifier |
| `packages/core/test/retrieval/` | New pipeline, new scoring |
| `packages/openclaw/test/e2e-plugin.test.ts` | Intent types change |
| `packages/supabase/test/` | New search methods |
| `packages/sqlite/test/` | New search methods |

## Success Criteria

Tested against production Supabase database:

1. **Exact query** ("scraper shield cloudflare worker") → finds stored content. Already works; must not regress.
2. **Vague query** ("that product idea about blocking bots") → finds stored content about scraper shield. Currently returns 0 results. Must return >= 1 relevant result.
3. **Cross-session recall** ("remind me why I rejected skills hub") → finds content from a different session. Currently fails. Must surface Rex's "skill registries are crowded" response.
4. **Header-polluted query** ("Node: RexBook ... scraper shield") → still finds content. Relies on header stripping fix already deployed.
5. **No false silencing** — removing minRelevance threshold must not flood context with garbage. Verify top-8 results for a generic query are relevant, not noise.
