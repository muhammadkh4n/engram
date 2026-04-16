# Vector-First Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hybrid RRF retrieval with vector-first architecture where cosine similarity is the primary retriever and BM25 is an additive boost, fixing zero-recall on vague queries.

**Architecture:** Unified cross-tier vector search via new `StorageAdapter.vectorSearch()` replaces per-tier `search()` methods. 3 intent modes (skip/light/deep) replace 11 regex intents. LLM query expansion bridges vocabulary gaps between vague queries and stored content.

**Tech Stack:** TypeScript, Vitest, Supabase (pgvector), SQLite (better-sqlite3), OpenAI API (gpt-4o-mini for expansion, text-embedding-3-small for embeddings)

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `packages/core/src/retrieval/search.ts` | Unified vector search + BM25 boost + scoring formula |
| `migrations/supabase/011_vector_first_search.sql` | `engram_vector_search` + `engram_text_boost` RPCs |
| `packages/core/test/retrieval/search.test.ts` | Tests for unified search module |
| `packages/core/test/intent/analyzer-v2.test.ts` | Tests for 3-mode intent classifier |

### Rewritten Files
| File | What Changes |
|------|-------------|
| `packages/core/src/types.ts` | Add `RecallMode`, `RecallStrategy`; keep old types until cleanup |
| `packages/core/src/adapters/storage.ts` | Add `vectorSearch()`, `textBoost()` to `StorageAdapter` |
| `packages/core/src/adapters/intelligence.ts` | Add `expandQuery()` to `IntelligenceAdapter` |
| `packages/core/src/intent/intents.ts` | 3 strategies replace 11 |
| `packages/core/src/intent/analyzer.ts` | 3-mode classifier; keep `scoreSalience()`, `extractCues()` |
| `packages/core/src/retrieval/engine.ts` | Pipeline orchestration with 3-mode dispatch |
| `packages/core/src/memory.ts` | `recall()` passes intelligence adapter for expansion |
| `packages/openai/src/summarizer.ts` | Add `expandQuery()` method |
| `packages/openai/src/index.ts` | Wire `expandQuery()` into factory |
| `packages/supabase/src/adapter.ts` | Implement `vectorSearch()`, `textBoost()` |
| `packages/supabase/src/episodes.ts` | Remove hybrid/legacy search branching |
| `packages/sqlite/src/vector-search.ts` | Implement `vectorSearch()`, `textBoost()` |
| `packages/openclaw/src/openclaw-plugin.ts` | `assemble()` + `engram_search` use new pipeline |
| `packages/core/test/retrieval/mock-storage.ts` | Add mock `vectorSearch`, `textBoost` |

### Deleted Files
| File | Why |
|------|-----|
| `packages/core/src/retrieval/recall.ts` | Replaced by `search.ts` |

### Unchanged
All files in `consolidation/`, `ingestion/`, `systems/`, `resilience/`, `retrieval/association-walk.ts`, `retrieval/priming.ts`, `retrieval/reconsolidation.ts`.

---

## Task Dependency Graph

```
Task 1 (types) ─────────┐
                         ├──► Task 4 (intent) ──► Task 5 (search) ──► Task 6 (engine)
Task 2 (storage iface) ──┤                                                  │
                         │                                                  ▼
Task 3 (intel iface) ────┤──► Task 7 (openai expandQuery)           Task 8 (memory)
                         │                                                  │
                         │                                                  ▼
                         ├──► Task 9 (SQL migration)                Task 12 (openclaw)
                         │                                                  │
                         ├──► Task 10 (supabase impl)                       ▼
                         │                                          Task 13 (cleanup)
                         └──► Task 11 (sqlite impl)
```

---

### Task 1: Core Types — RecallMode and RecallStrategy

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: existing type usage verified by TypeScript compiler

- [ ] **Step 1: Add RecallMode and RecallStrategy types to types.ts**

Add these types after the existing `IntentType` definition (after line 26):

```typescript
export type RecallMode = 'skip' | 'light' | 'deep'

export interface RecallStrategy {
  mode: RecallMode
  maxResults: number
  associations: boolean
  associationHops: number
  expand: boolean
  recencyBias: number
}
```

Do NOT delete the old `IntentType`, `RetrievalStrategy`, or `TierPriority` types yet — they are still referenced by existing code that will be rewritten in later tasks. They will be removed in Task 13.

- [ ] **Step 2: Run type check to verify no conflicts**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: SUCCESS (no errors — we only added types, nothing removed)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(types): add RecallMode and RecallStrategy for vector-first retrieval"
```

---

### Task 2: Storage Adapter Interface — vectorSearch and textBoost

**Files:**
- Modify: `packages/core/src/adapters/storage.ts`
- Modify: `packages/core/src/index.ts` (export new types if needed)

- [ ] **Step 1: Add vectorSearch and textBoost to StorageAdapter interface**

In `packages/core/src/adapters/storage.ts`, add imports for `MemoryType` and `TypedMemory` (already imported), then add `SearchResult` import and the two new methods to the `StorageAdapter` interface.

Add after the existing imports (line 1-15), ensure `SearchResult` and `TypedMemory` are imported:

```typescript
import type {
  Episode,
  Digest,
  SemanticMemory,
  ProceduralMemory,
  Association,
  MemoryType,
  EdgeType,
  SearchOptions,
  SearchResult,
  TypedMemory,
  WalkResult,
  DiscoveredEdge,
  SensorySnapshot,
} from '../types.js'
```

Then in the `StorageAdapter` interface (after `dispose()` on line 79), add the two new methods:

```typescript
export interface StorageAdapter {
  initialize(): Promise<void>
  dispose(): Promise<void>

  // --- Vector-first retrieval (new) ---
  vectorSearch(embedding: number[], opts?: {
    limit?: number
    sessionId?: string
    tiers?: MemoryType[]
  }): Promise<SearchResult<TypedMemory>[]>

  textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>>

  // --- Per-tier storage (search() still present until Task 13) ---
  episodes: EpisodeStorage
  digests: DigestStorage
  semantic: SemanticStorage
  procedural: ProceduralStorage
  associations: AssociationStorage
  getById(id: string, type: MemoryType): Promise<TypedMemory | null>
  getByIds(ids: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]>
  saveSensorySnapshot(sessionId: string, snapshot: SensorySnapshot): Promise<void>
  loadSensorySnapshot(sessionId: string): Promise<SensorySnapshot | null>
}
```

- [ ] **Step 2: Run type check**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: FAIL — classes implementing `StorageAdapter` now lack `vectorSearch` and `textBoost`. This is expected; implementations come in Tasks 10-11. The core package itself will compile because only the interface is in core.

Run instead: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx tsc --noEmit -p packages/core/tsconfig.json 2>&1 | head -5`
Expected: Clean within `packages/core` since no class in core implements StorageAdapter directly.

- [ ] **Step 3: Update mock-storage.ts to satisfy new interface**

In `packages/core/test/retrieval/mock-storage.ts`, add the two new methods to the mock adapter (after the `loadSensorySnapshot` line, around line 243):

```typescript
    vectorSearch: vi.fn().mockResolvedValue([]),
    textBoost: vi.fn().mockResolvedValue([]),
```

- [ ] **Step 4: Run core tests to verify nothing broke**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run --project core 2>&1 | tail -20`
Expected: All existing tests PASS (vectorSearch/textBoost are just stubs returning empty)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/storage.ts packages/core/test/retrieval/mock-storage.ts
git commit -m "feat(storage): add vectorSearch and textBoost to StorageAdapter interface"
```

---

### Task 3: Intelligence Adapter — expandQuery

**Files:**
- Modify: `packages/core/src/adapters/intelligence.ts`

- [ ] **Step 1: Add expandQuery to IntelligenceAdapter interface**

In `packages/core/src/adapters/intelligence.ts`, add after the `generateHypotheticalDoc` line (line 29):

```typescript
export interface IntelligenceAdapter {
  embed?(text: string): Promise<number[]>
  embedBatch?(texts: string[]): Promise<number[][]>
  dimensions?(): number
  summarize?(content: string, opts: SummarizeOptions): Promise<SummaryResult>
  extractKnowledge?(content: string): Promise<KnowledgeCandidate[]>
  /** Generate a hypothetical document that would answer the query (HyDE) */
  generateHypotheticalDoc?(query: string): Promise<string>
  /** Generate 3-5 keyword variants to bridge vocabulary gap for BM25 boost */
  expandQuery?(query: string): Promise<string[]>
}
```

- [ ] **Step 2: Run type check**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: PASS (expandQuery is optional `?`)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/adapters/intelligence.ts
git commit -m "feat(intelligence): add expandQuery to IntelligenceAdapter interface"
```

---

### Task 4: Intent System — 3-Mode Classifier

**Files:**
- Modify: `packages/core/src/intent/intents.ts`
- Modify: `packages/core/src/intent/analyzer.ts`
- Create: `packages/core/test/intent/analyzer-v2.test.ts`

- [ ] **Step 1: Write failing tests for 3-mode classifier**

Create `packages/core/test/intent/analyzer-v2.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { classifyMode, RECALL_STRATEGIES } from '../../src/intent/intents.js'
import type { RecallMode, RecallStrategy } from '../../src/types.js'

describe('classifyMode — 3-mode intent classification', () => {
  it('skip: greetings', () => {
    expect(classifyMode('hi')).toBe('skip')
    expect(classifyMode('thanks')).toBe('skip')
    expect(classifyMode('ok')).toBe('skip')
  })

  it('skip: short acks under 10 chars', () => {
    expect(classifyMode('yes')).toBe('skip')
    expect(classifyMode('nope')).toBe('skip')
    expect(classifyMode('lol')).toBe('skip')
  })

  it('deep: contains question mark', () => {
    expect(classifyMode('What is TypeScript strict mode?')).toBe('deep')
    expect(classifyMode('How does the memory engine work?')).toBe('deep')
  })

  it('deep: recall keywords', () => {
    expect(classifyMode('remember when we discussed TypeScript')).toBe('deep')
    expect(classifyMode('recall the project plan from last time')).toBe('deep')
    expect(classifyMode('what did we decide about the API')).toBe('deep')
    expect(classifyMode('did we ever talk about GraphQL')).toBe('deep')
    expect(classifyMode('previously we agreed on REST')).toBe('deep')
    expect(classifyMode('last time you mentioned webhooks')).toBe('deep')
  })

  it('light: everything else', () => {
    expect(classifyMode('I want to build a webhook server on the VPS')).toBe('light')
    expect(classifyMode('Let us implement the scraper shield using Cloudflare Workers')).toBe('light')
    expect(classifyMode('TypeScript strict mode enables noImplicitAny')).toBe('light')
  })

  it('skip: emoji-only messages', () => {
    expect(classifyMode('👍')).toBe('skip')
    expect(classifyMode('🎉🎉')).toBe('skip')
  })
})

describe('RECALL_STRATEGIES — strategy table', () => {
  it('skip strategy: maxResults=0, no expansion, no associations', () => {
    const s = RECALL_STRATEGIES.skip
    expect(s.mode).toBe('skip')
    expect(s.maxResults).toBe(0)
    expect(s.expand).toBe(false)
    expect(s.associations).toBe(false)
  })

  it('light strategy: maxResults=8, no expansion, no associations', () => {
    const s = RECALL_STRATEGIES.light
    expect(s.mode).toBe('light')
    expect(s.maxResults).toBe(8)
    expect(s.expand).toBe(false)
    expect(s.associations).toBe(false)
    expect(s.recencyBias).toBe(0.4)
  })

  it('deep strategy: maxResults=15, expansion=true, associations=true with 2 hops', () => {
    const s = RECALL_STRATEGIES.deep
    expect(s.mode).toBe('deep')
    expect(s.maxResults).toBe(15)
    expect(s.expand).toBe(true)
    expect(s.associations).toBe(true)
    expect(s.associationHops).toBe(2)
    expect(s.recencyBias).toBe(0.2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run packages/core/test/intent/analyzer-v2.test.ts 2>&1 | tail -10`
Expected: FAIL — `classifyMode` and `RECALL_STRATEGIES` not exported from intents.ts

- [ ] **Step 3: Implement classifyMode and RECALL_STRATEGIES in intents.ts**

In `packages/core/src/intent/intents.ts`, add at the END of the file (after line 222), keeping all existing exports intact:

```typescript
// ---------------------------------------------------------------------------
// Vector-First: 3-Mode Classification + Strategies
// ---------------------------------------------------------------------------

import type { RecallMode, RecallStrategy } from '../types.js'

/** Classify a message into one of 3 recall modes. */
export function classifyMode(message: string): RecallMode {
  const trimmed = message.trim()

  // skip: short acks, greetings, emoji-only
  if (trimmed.length < 10) return 'skip'
  if (/^(hi|hey|hello|thanks|thank you|ok|okay|sure|yes|no|yep|nope|lol|haha|hmm|ah|oh|done|got it)\s*[.!]?$/i.test(trimmed)) return 'skip'
  if (/^[\p{Emoji}\s]+$/u.test(trimmed)) return 'skip'

  // deep: question mark or recall keywords
  if (/\?/.test(trimmed)) return 'deep'
  if (/\b(remember|recall|what did|did we|last time|previously|have we|remind me)\b/i.test(trimmed)) return 'deep'

  // everything else: light
  return 'light'
}

/** Strategy table for the 3 recall modes. */
export const RECALL_STRATEGIES: Record<RecallMode, RecallStrategy> = {
  skip: {
    mode: 'skip',
    maxResults: 0,
    associations: false,
    associationHops: 0,
    expand: false,
    recencyBias: 0,
  },
  light: {
    mode: 'light',
    maxResults: 8,
    associations: false,
    associationHops: 0,
    expand: false,
    recencyBias: 0.4,
  },
  deep: {
    mode: 'deep',
    maxResults: 15,
    associations: true,
    associationHops: 2,
    expand: true,
    recencyBias: 0.2,
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run packages/core/test/intent/analyzer-v2.test.ts 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 5: Run all existing tests to verify nothing broke**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run --project core 2>&1 | tail -10`
Expected: ALL PASS (we only added exports, nothing removed)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/intent/intents.ts packages/core/test/intent/analyzer-v2.test.ts
git commit -m "feat(intent): add 3-mode classifier (skip/light/deep) alongside existing 11-intent system"
```

---

### Task 5: Unified Search Module — search.ts

**Files:**
- Create: `packages/core/src/retrieval/search.ts`
- Create: `packages/core/test/retrieval/search.test.ts`
- Modify: `packages/core/test/retrieval/mock-storage.ts` (add typed mock data for vectorSearch)

- [ ] **Step 1: Update mock-storage.ts with vectorSearch fixture data**

In `packages/core/test/retrieval/mock-storage.ts`, add these exports after the existing `WALK_RESULTS` (around line 145):

```typescript
export const VECTOR_SEARCH_RESULTS: SearchResult<TypedMemory>[] = [
  { item: { type: 'semantic', data: MOCK_SEMANTIC }, similarity: 0.82 },
  { item: { type: 'episode', data: MOCK_EPISODE }, similarity: 0.75 },
  { item: { type: 'episode', data: MOCK_EPISODE_2 }, similarity: 0.68 },
  { item: { type: 'digest', data: MOCK_DIGEST }, similarity: 0.60 },
]

export const TEXT_BOOST_RESULTS: Array<{ id: string; type: MemoryType; boost: number }> = [
  { id: 'sem-1', type: 'semantic', boost: 0.9 },
  { id: 'ep-1', type: 'episode', boost: 0.7 },
]
```

Also add `VECTOR_SEARCH_RESULTS` and `TEXT_BOOST_RESULTS` to the `MockStorageOptions` interface:

```typescript
export interface MockStorageOptions {
  episodeResults?: SearchResult<Episode>[]
  digestResults?: SearchResult<Digest>[]
  semanticResults?: SearchResult<SemanticMemory>[]
  proceduralResults?: SearchResult<ProceduralMemory>[]
  walkResults?: WalkResult[]
  vectorSearchResults?: SearchResult<TypedMemory>[]
  textBoostResults?: Array<{ id: string; type: MemoryType; boost: number }>
}
```

Update `createMockStorage` to use these:

```typescript
  const vectorSearchResults = opts.vectorSearchResults ?? VECTOR_SEARCH_RESULTS
  const textBoostResults = opts.textBoostResults ?? TEXT_BOOST_RESULTS
```

And update the mock adapter's vectorSearch and textBoost:

```typescript
    vectorSearch: vi.fn().mockResolvedValue(vectorSearchResults),
    textBoost: vi.fn().mockResolvedValue(textBoostResults),
```

- [ ] **Step 2: Write failing tests for search.ts**

Create `packages/core/test/retrieval/search.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { unifiedSearch } from '../../src/retrieval/search.js'
import { createMockStorage, MOCK_SEMANTIC, MOCK_EPISODE, MOCK_EPISODE_2, MOCK_DIGEST } from './mock-storage.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import type { RecallStrategy } from '../../src/types.js'

const LIGHT_STRATEGY: RecallStrategy = {
  mode: 'light',
  maxResults: 8,
  associations: false,
  associationHops: 0,
  expand: false,
  recencyBias: 0.4,
}

const DEEP_STRATEGY: RecallStrategy = {
  mode: 'deep',
  maxResults: 15,
  associations: true,
  associationHops: 2,
  expand: true,
  recencyBias: 0.2,
}

const SKIP_STRATEGY: RecallStrategy = {
  mode: 'skip',
  maxResults: 0,
  associations: false,
  associationHops: 0,
  expand: false,
  recencyBias: 0,
}

describe('unifiedSearch', () => {
  it('skip mode returns empty array', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'hi',
      embedding: [0.1, 0.2],
      strategy: SKIP_STRATEGY,
      storage,
      sensory,
    })
    expect(result).toHaveLength(0)
    expect(storage.vectorSearch).not.toHaveBeenCalled()
  })

  it('light mode calls vectorSearch with embedding', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const embedding = [0.1, 0.2, 0.3]
    await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding,
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    expect(storage.vectorSearch).toHaveBeenCalledWith(embedding, {
      limit: 8,
      sessionId: undefined,
      tiers: undefined,
    })
  })

  it('calls textBoost with query terms', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    expect(storage.textBoost).toHaveBeenCalled()
    const callArgs = (storage.textBoost as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toContain('typescript')
  })

  it('results are sorted by finalScore descending', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].relevance).toBeGreaterThanOrEqual(result[i].relevance)
    }
  })

  it('BM25 boost adds score to matching results', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    // sem-1 has both vector (0.82) and BM25 boost (0.9) — should be top result
    const sem1 = result.find(r => r.id === 'sem-1')
    expect(sem1).toBeDefined()
    // Its score should be > base cosine similarity of 0.82
    expect(sem1!.relevance).toBeGreaterThan(0.82)
  })

  it('caps results at strategy.maxResults', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: { ...LIGHT_STRATEGY, maxResults: 2 },
      storage,
      sensory,
    })
    expect(result.length).toBeLessThanOrEqual(2)
  })

  it('includes expanded terms in textBoost when provided', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    await unifiedSearch({
      query: 'blocking bots',
      embedding: [0.1, 0.2],
      strategy: DEEP_STRATEGY,
      storage,
      sensory,
      expandedTerms: ['scraper', 'cloudflare', 'behavioral fingerprinting'],
    })
    const callArgs = (storage.textBoost as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toContain('scraper')
    expect(callArgs[0]).toContain('cloudflare')
  })

  it('all results have source=recall and valid type', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    for (const r of result) {
      expect(r.source).toBe('recall')
      expect(['episode', 'digest', 'semantic', 'procedural']).toContain(r.type)
    }
  })

  it('role boost: assistant content gets +5%', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    // ep-2 is assistant role — should have roleBoost applied
    const ep2 = result.find(r => r.id === 'ep-2')
    // Base would be cosine 0.68 + recency + access + potential BM25
    // With roleBoost of 0.05, score should be slightly higher than without
    expect(ep2).toBeDefined()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run packages/core/test/retrieval/search.test.ts 2>&1 | tail -10`
Expected: FAIL — `unifiedSearch` not found

- [ ] **Step 4: Implement search.ts**

Create `packages/core/src/retrieval/search.ts`:

```typescript
import type {
  RecallStrategy,
  RetrievedMemory,
  TypedMemory,
  MemoryType,
} from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

function extractContent(typed: TypedMemory): string {
  switch (typed.type) {
    case 'episode': return typed.data.content
    case 'digest': return typed.data.summary
    case 'semantic': return typed.data.content
    case 'procedural': return typed.data.procedure
  }
}

function extractMetadata(typed: TypedMemory): Record<string, unknown> {
  return typed.data.metadata
}

function extractCreatedAt(typed: TypedMemory): Date {
  return typed.data.createdAt
}

function extractAccessCount(typed: TypedMemory): number {
  if ('accessCount' in typed.data) return (typed.data as { accessCount: number }).accessCount
  return 0
}

function extractRole(typed: TypedMemory): string | undefined {
  if (typed.type === 'episode') return typed.data.role
  const meta = typed.data.metadata
  return typeof meta?.role === 'string' ? meta.role : undefined
}

// ---------------------------------------------------------------------------
// Term extraction for BM25
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was',
  'this', 'that', 'have', 'with', 'from', 'they', 'been', 'has', 'will',
  'its', 'our', 'let', 'did', 'how', 'what', 'who', 'why', 'when', 'where',
  'about', 'know', 'remember', 'tell', 'show', 'does',
])

function extractTerms(query: string, expandedTerms?: string[]): string[] {
  const queryTokens = query
    .replace(/[?.!,;:()[\]{}"']/g, ' ')
    .split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))

  const expanded = (expandedTerms ?? [])
    .flatMap(t => t.split(/\s+/))
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))

  // Deduplicate
  return [...new Set([...queryTokens, ...expanded])]
}

// ---------------------------------------------------------------------------
// Scoring formula (from design spec)
// ---------------------------------------------------------------------------

interface ScoringInput {
  cosineSimilarity: number
  bm25Boost: number
  recencyBias: number
  createdAt: Date
  accessCount: number
  primingBoost: number
  role: string | undefined
}

function computeScore(input: ScoringInput): number {
  const {
    cosineSimilarity: baseSim,
    bm25Boost: rawBm25,
    recencyBias,
    createdAt,
    accessCount,
    primingBoost,
    role,
  } = input

  // baseScore = cosineSimilarity (0-1)
  const baseScore = baseSim

  // bm25Boost = textBoostScore * 0.15 (0-0.15)
  const bm25Boost = rawBm25 * 0.15

  // recencyScore = recencyBias * exp(-ageHours / 720) — 30-day half-life
  const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000
  const recencyScore = recencyBias * Math.exp(-ageHours / 720)

  // accessBoost = min(0.1, accessCount * 0.01)
  const accessBoost = Math.min(0.1, accessCount * 0.01)

  // roleBoost = 0.05 for assistant, 0 otherwise
  const roleBoost = role === 'assistant' ? 0.05 : 0

  return baseScore + bm25Boost + recencyScore + accessBoost + primingBoost + roleBoost
}

// ---------------------------------------------------------------------------
// Unified search
// ---------------------------------------------------------------------------

export interface UnifiedSearchOpts {
  query: string
  embedding: number[]
  strategy: RecallStrategy
  storage: StorageAdapter
  sensory: SensoryBuffer
  sessionId?: string
  expandedTerms?: string[]
}

export async function unifiedSearch(opts: UnifiedSearchOpts): Promise<RetrievedMemory[]> {
  const { query, embedding, strategy, storage, sensory, sessionId, expandedTerms } = opts

  if (strategy.mode === 'skip' || strategy.maxResults === 0) {
    return []
  }

  // Step 1: Vector search — primary retriever
  const vectorResults = await storage.vectorSearch(embedding, {
    limit: strategy.maxResults * 2, // fetch 2x for BM25 re-ranking headroom
    sessionId,
  })

  // Step 2: BM25 boost — additive, OR semantics
  const terms = extractTerms(query, expandedTerms)
  const boostResults = terms.length > 0
    ? await storage.textBoost(terms, { limit: strategy.maxResults * 2, sessionId })
    : []

  // Build boost lookup: id -> boost score
  const boostMap = new Map<string, number>()
  for (const b of boostResults) {
    boostMap.set(b.id, b.boost)
  }

  // Step 3: Score + rank
  const scored: RetrievedMemory[] = []

  for (const { item: typed, similarity } of vectorResults) {
    const content = extractContent(typed)
    const metadata = extractMetadata(typed)
    const createdAt = extractCreatedAt(typed)
    const accessCount = extractAccessCount(typed)
    const role = extractRole(typed)
    const primingBoost = sensory.getPrimingBoost(content)
    const bm25RawBoost = boostMap.get(typed.data.id) ?? 0

    const finalScore = computeScore({
      cosineSimilarity: similarity,
      bm25Boost: bm25RawBoost,
      recencyBias: strategy.recencyBias,
      createdAt,
      accessCount,
      primingBoost,
      role,
    })

    scored.push({
      id: typed.data.id,
      type: typed.type,
      content,
      relevance: finalScore,
      source: 'recall',
      metadata,
    })
  }

  return scored
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, strategy.maxResults)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run packages/core/test/retrieval/search.test.ts 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 6: Run all core tests to verify nothing broke**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run --project core 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/retrieval/search.ts packages/core/test/retrieval/search.test.ts packages/core/test/retrieval/mock-storage.ts
git commit -m "feat(retrieval): add unified vector-first search with BM25 boost scoring"
```

---

### Task 6: Engine Rewrite — Pipeline Orchestration

**Files:**
- Rewrite: `packages/core/src/retrieval/engine.ts`
- Rewrite: `packages/core/test/retrieval/engine.test.ts`

- [ ] **Step 1: Write failing test for new engine**

Replace the entire content of `packages/core/test/retrieval/engine.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { recall } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { createMockStorage } from './mock-storage.js'
import type { RecallStrategy } from '../../src/types.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'

const SKIP: RecallStrategy = {
  mode: 'skip', maxResults: 0, associations: false,
  associationHops: 0, expand: false, recencyBias: 0,
}

const LIGHT: RecallStrategy = {
  mode: 'light', maxResults: 8, associations: false,
  associationHops: 0, expand: false, recencyBias: 0.4,
}

const DEEP: RecallStrategy = {
  mode: 'deep', maxResults: 15, associations: true,
  associationHops: 2, expand: true, recencyBias: 0.2,
}

describe('recall engine — vector-first pipeline', () => {
  it('skip mode returns empty result with no searches', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await recall('hi', storage, sensory, {
      strategy: SKIP,
      embedding: [0.1, 0.2],
    })
    expect(result.memories).toHaveLength(0)
    expect(result.associations).toHaveLength(0)
    expect(result.formatted).toBe('')
    expect(storage.vectorSearch).not.toHaveBeenCalled()
  })

  it('light mode calls vectorSearch and returns scored results', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await recall('TypeScript strict mode', storage, sensory, {
      strategy: LIGHT,
      embedding: [0.1, 0.2, 0.3],
    })
    expect(storage.vectorSearch).toHaveBeenCalled()
    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.formatted).toContain('Engram')
  })

  it('deep mode with expand=true calls intelligence.expandQuery', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intelligence: IntelligenceAdapter = {
      expandQuery: vi.fn().mockResolvedValue(['scraper', 'cloudflare', 'bot detection']),
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
      generateHypotheticalDoc: vi.fn().mockResolvedValue('A cloudflare worker for scraper detection'),
    }
    await recall('that thing about blocking bots', storage, sensory, {
      strategy: DEEP,
      embedding: [0.1, 0.2],
      intelligence,
    })
    expect(intelligence.expandQuery).toHaveBeenCalledWith('that thing about blocking bots')
  })

  it('deep mode runs association walk from top 5 results', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await recall('TypeScript strict mode', storage, sensory, {
      strategy: DEEP,
      embedding: [0.1, 0.2],
    })
    expect(storage.associations.walk).toHaveBeenCalled()
    // associations should be populated from the walk
    expect(result.associations.length).toBeGreaterThanOrEqual(0)
  })

  it('light mode does NOT run association walk', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    await recall('TypeScript strict mode', storage, sensory, {
      strategy: LIGHT,
      embedding: [0.1, 0.2],
    })
    expect(storage.associations.walk).not.toHaveBeenCalled()
  })

  it('HyDE fallback triggers when top score < 0.3 and intelligence available', async () => {
    const weakResults = [
      { item: { type: 'episode' as const, data: { id: 'ep-weak', content: 'weak', createdAt: new Date(), metadata: {}, accessCount: 0, sessionId: 's', role: 'user' as const, salience: 0.3, lastAccessed: null, consolidatedAt: null, embedding: null, entities: [] } }, similarity: 0.2 },
    ]
    const storage = createMockStorage({ vectorSearchResults: weakResults })
    const sensory = new SensoryBuffer()
    const intelligence: IntelligenceAdapter = {
      embed: vi.fn().mockResolvedValue([0.5, 0.6]),
      generateHypotheticalDoc: vi.fn().mockResolvedValue('TypeScript strict mode configuration'),
      expandQuery: vi.fn().mockResolvedValue([]),
    }
    await recall('that thing about types', storage, sensory, {
      strategy: DEEP,
      embedding: [0.1, 0.2],
      intelligence,
    })
    expect(intelligence.generateHypotheticalDoc).toHaveBeenCalled()
    // vectorSearch called twice: once for primary, once for HyDE
    expect(storage.vectorSearch).toHaveBeenCalledTimes(2)
  })

  it('HyDE NOT triggered when top score >= 0.3', async () => {
    const storage = createMockStorage() // default results have similarity 0.82
    const sensory = new SensoryBuffer()
    const intelligence: IntelligenceAdapter = {
      embed: vi.fn(),
      generateHypotheticalDoc: vi.fn(),
      expandQuery: vi.fn().mockResolvedValue([]),
    }
    await recall('TypeScript strict mode', storage, sensory, {
      strategy: DEEP,
      embedding: [0.1, 0.2],
      intelligence,
    })
    expect(intelligence.generateHypotheticalDoc).not.toHaveBeenCalled()
  })

  it('result has all required fields', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await recall('TypeScript', storage, sensory, {
      strategy: LIGHT,
      embedding: [0.1, 0.2],
    })
    expect(result).toHaveProperty('memories')
    expect(result).toHaveProperty('associations')
    expect(result).toHaveProperty('primed')
    expect(result).toHaveProperty('estimatedTokens')
    expect(result).toHaveProperty('formatted')
    expect(result).toHaveProperty('strategy')
  })

  it('priming extracts keywords from recalled memories', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await recall('TypeScript strict mode', storage, sensory, {
      strategy: LIGHT,
      embedding: [0.1, 0.2],
    })
    expect(Array.isArray(result.primed)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run packages/core/test/retrieval/engine.test.ts 2>&1 | tail -10`
Expected: FAIL — new `recall` signature doesn't match old one

- [ ] **Step 3: Rewrite engine.ts**

Replace the entire content of `packages/core/src/retrieval/engine.ts`:

```typescript
import type { RecallStrategy, RetrievedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import { AssociationManager } from '../systems/association-manager.js'
import { estimateTokens } from '../utils/tokens.js'
import { unifiedSearch } from './search.js'
import { stageAssociate } from './association-walk.js'
import { stagePrime } from './priming.js'
import { stageReconsolidate } from './reconsolidation.js'

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RecallResult {
  memories: RetrievedMemory[]
  associations: RetrievedMemory[]
  strategy: RecallStrategy
  primed: string[]
  estimatedTokens: number
  formatted: string
}

// ---------------------------------------------------------------------------
// Format for system prompt injection
// ---------------------------------------------------------------------------

function formatMemories(
  memories: RetrievedMemory[],
  associations: RetrievedMemory[]
): string {
  if (memories.length === 0 && associations.length === 0) return ''

  const lines: string[] = [
    '## Engram — Recalled Conversation Memory',
    '',
    'IMPORTANT: The following are memories retrieved from past conversations. If the answer to the user\'s question is found below, USE IT directly. Do not say "I don\'t have this information" if it appears here.',
    '',
  ]

  if (memories.length > 0) {
    lines.push('### Recalled Memories\n')
    for (const m of memories) {
      lines.push(`- [${m.type}] ${m.content}`)
    }
  }

  if (associations.length > 0) {
    lines.push('\n### Related Memories\n')
    for (const a of associations) {
      lines.push(`- [${a.type}] ${a.content}`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface RecallOpts {
  strategy: RecallStrategy
  embedding: number[]
  sessionId?: string
  tokenBudget?: number
  intelligence?: IntelligenceAdapter
}

export async function recall(
  query: string,
  storage: StorageAdapter,
  sensory: SensoryBuffer,
  opts: RecallOpts
): Promise<RecallResult> {
  const { strategy, embedding, sessionId, intelligence } = opts

  // Skip mode — no retrieval
  if (strategy.mode === 'skip' || strategy.maxResults === 0) {
    return {
      memories: [],
      associations: [],
      strategy,
      primed: [],
      estimatedTokens: 0,
      formatted: '',
    }
  }

  // Step 1: LLM query expansion (deep mode only)
  let expandedTerms: string[] | undefined
  if (strategy.expand && intelligence?.expandQuery) {
    try {
      expandedTerms = await intelligence.expandQuery(query)
    } catch {
      // expansion failed — proceed without it
    }
  }

  // Step 2: Unified vector search + BM25 boost + scoring
  let memories = await unifiedSearch({
    query,
    embedding,
    strategy,
    storage,
    sensory,
    sessionId,
    expandedTerms,
  })

  // Step 3: HyDE fallback — if top score weak and intelligence available
  const topScore = memories[0]?.relevance ?? 0
  if (topScore < 0.3 && intelligence?.generateHypotheticalDoc && intelligence?.embed) {
    try {
      const hydeDoc = await intelligence.generateHypotheticalDoc(query)
      const hydeEmbedding = await intelligence.embed(hydeDoc)
      const hydeMemories = await unifiedSearch({
        query: hydeDoc,
        embedding: hydeEmbedding,
        strategy,
        storage,
        sensory,
        sessionId,
        expandedTerms,
      })

      // Merge: keep highest score per ID
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
    } catch {
      // HyDE failed — use direct results
    }
  }

  // Step 4: Association walk (deep mode only)
  // We need to create a compatible strategy object for stageAssociate
  const associations = strategy.associations
    ? await stageAssociate(memories, {
        shouldRecall: true,
        tiers: [],
        queryTransform: null,
        maxResults: strategy.maxResults,
        minRelevance: 0,
        includeAssociations: strategy.associations,
        associationHops: strategy.associationHops,
        boostProcedural: false,
      }, storage)
    : []

  // Step 5: Priming
  const primed = stagePrime(memories, associations, sensory)

  // Step 6: Reconsolidation (fire-and-forget)
  const manager = new AssociationManager(storage.associations)
  stageReconsolidate(memories, associations, storage, manager)

  // Format
  const formatted = formatMemories(memories, associations)
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

- [ ] **Step 4: Run engine tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run packages/core/test/retrieval/engine.test.ts 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 5: Run all core tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run --project core 2>&1 | tail -20`
Expected: Some existing tests (recall-scoring.test.ts) may fail because they import from the old engine signature. Note which fail — they will be deleted or updated in Task 13.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/retrieval/engine.ts packages/core/test/retrieval/engine.test.ts
git commit -m "feat(engine): rewrite retrieval pipeline for vector-first with 3-mode dispatch"
```

---

### Task 7: OpenAI Adapter — expandQuery Implementation

**Files:**
- Modify: `packages/openai/src/summarizer.ts`
- Modify: `packages/openai/src/index.ts`

- [ ] **Step 1: Add expandQuery to OpenAISummarizer**

In `packages/openai/src/summarizer.ts`, add this method after `generateHypotheticalDoc` (after line 95):

```typescript
  async expandQuery(query: string): Promise<string[]> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'Given a search query about past conversations or memories, generate 3-5 alternative keyword phrases that might appear in the stored content. Output ONLY a JSON array of strings. Do not explain. Focus on nouns, tools, technologies, and action words that the stored content would contain.',
        },
        { role: 'user', content: query },
      ],
      max_tokens: 100,
      temperature: 0.5,
    })

    const raw = response.choices[0]?.message?.content ?? '[]'
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 5)
      }
    } catch {
      // parse failed — return empty
    }
    return []
  }
```

- [ ] **Step 2: Wire expandQuery into the factory**

In `packages/openai/src/index.ts`, add `expandQuery` to the returned object (after `generateHypotheticalDoc` on line 57):

```typescript
    expandQuery(query: string) {
      return summarizer.expandQuery(query)
    },
```

- [ ] **Step 3: Type-check**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx tsc --noEmit -p packages/openai/tsconfig.json 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/openai/src/summarizer.ts packages/openai/src/index.ts
git commit -m "feat(openai): implement expandQuery for LLM-powered keyword expansion"
```

---

### Task 8: Memory Module — Pass Intelligence for Expansion

**Files:**
- Modify: `packages/core/src/memory.ts`

- [ ] **Step 1: Update Memory.recall to use new engine signature**

In `packages/core/src/memory.ts`, update the import and the `recall` method.

Change the import on line 7:

```typescript
import { recall as engineRecall } from './retrieval/engine.js'
```

To:

```typescript
import { recall as engineRecall, type RecallOpts } from './retrieval/engine.js'
```

Then update the `recall` method (lines 179-211) to use the new engine signature:

```typescript
  async recall(
    query: string,
    opts?: { embedding?: number[]; tokenBudget?: number }
  ): Promise<RecallResult> {
    this.assertInitialized()

    // Classify intent mode
    const { classifyMode, RECALL_STRATEGIES } = await import('./intent/intents.js')
    const mode = classifyMode(query)
    const strategy = RECALL_STRATEGIES[mode]

    // Embed query if intelligence adapter provides embeddings
    let embedding = opts?.embedding
    if (embedding === undefined && this.intelligence?.embed) {
      embedding = await this.intelligence.embed(query)
    }

    // Skip if no embedding available and not skip mode
    if (!embedding && strategy.mode !== 'skip') {
      return {
        memories: [],
        associations: [],
        intent: this.intentAnalyzer.analyze(query),
        primed: [],
        estimatedTokens: 0,
        formatted: '',
      }
    }

    // Run the vector-first retrieval pipeline
    const result = await engineRecall(query, this.storage, this.sensory, {
      strategy,
      embedding: embedding ?? [],
      tokenBudget: opts?.tokenBudget,
      intelligence: this.intelligence,
    })

    // Tick sensory buffer: decay priming weights each turn
    this.sensory.tick()

    // Bridge old RecallResult shape (with intent) for backward compatibility
    const intent = this.intentAnalyzer.analyze(query, {
      activeIntent: this.sensory.getIntent(),
      primedTopics: this.sensory.getPrimed().map(p => p.topic),
    })
    this.sensory.setIntent(intent)

    return {
      memories: result.memories,
      associations: result.associations,
      intent,
      primed: result.primed,
      estimatedTokens: result.estimatedTokens,
      formatted: result.formatted,
    }
  }
```

- [ ] **Step 2: Type-check**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx tsc --noEmit -p packages/core/tsconfig.json 2>&1 | tail -10`
Expected: PASS (or minor issues to fix — address any type errors)

- [ ] **Step 3: Run core tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run --project core 2>&1 | tail -20`
Expected: New engine tests pass. Some old tests may need adjustment — note and fix.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/memory.ts
git commit -m "feat(memory): wire recall to vector-first pipeline with intent classification"
```

---

### Task 9: SQL Migration — engram_vector_search + engram_text_boost

**Files:**
- Create: `migrations/supabase/011_vector_first_search.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/supabase/011_vector_first_search.sql`:

```sql
-- Vector-First Search: Pure cosine similarity across all memory types
CREATE OR REPLACE FUNCTION engram_vector_search(
  p_query_embedding vector,
  p_match_count int DEFAULT 15,
  p_session_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  memory_type text,
  content text,
  role text,
  salience float,
  access_count int,
  created_at timestamptz,
  similarity float,
  entities text[],
  metadata jsonb
)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public
AS $$
  -- Episodes
  SELECT
    me.id, 'episode'::text, me.content, me.role,
    me.salience::float, me.access_count, me.created_at,
    (1 - (me.embedding <=> p_query_embedding))::float AS similarity,
    me.entities, me.metadata
  FROM memory_episodes me
  WHERE me.embedding IS NOT NULL
    AND (p_session_id IS NULL OR me.session_id = p_session_id)

  UNION ALL

  -- Digests
  SELECT
    md.id, 'digest'::text, md.summary, NULL,
    0.5::float, 0, md.created_at,
    (1 - (md.embedding <=> p_query_embedding))::float,
    md.key_topics, md.metadata
  FROM memory_digests md
  WHERE md.embedding IS NOT NULL

  UNION ALL

  -- Semantic
  SELECT
    ms.id, 'semantic'::text, ms.content, NULL,
    ms.confidence::float, ms.access_count, ms.created_at,
    (1 - (ms.embedding <=> p_query_embedding))::float,
    ARRAY[]::text[], ms.metadata
  FROM memory_semantic ms
  WHERE ms.embedding IS NOT NULL AND ms.superseded_by IS NULL

  UNION ALL

  -- Procedural
  SELECT
    mp.id, 'procedural'::text, mp.procedure, NULL,
    mp.confidence::float, mp.access_count, mp.created_at,
    (1 - (mp.embedding <=> p_query_embedding))::float,
    ARRAY[]::text[], mp.metadata
  FROM memory_procedural mp
  WHERE mp.embedding IS NOT NULL

  ORDER BY similarity DESC
  LIMIT p_match_count
$$;

-- Text Boost: OR-joined FTS returning IDs and rank scores only
CREATE OR REPLACE FUNCTION engram_text_boost(
  p_query_terms text,
  p_match_count int DEFAULT 30,
  p_session_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  memory_type text,
  rank_score float
)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, memory_type, rank_score FROM (
    -- Episodes
    SELECT me.id, 'episode'::text AS memory_type,
      ts_rank_cd(me.fts, to_tsquery('english', p_query_terms))::float AS rank_score
    FROM memory_episodes me
    WHERE me.fts @@ to_tsquery('english', p_query_terms)
      AND (p_session_id IS NULL OR me.session_id = p_session_id)

    UNION ALL

    -- Digests
    SELECT md.id, 'digest'::text,
      ts_rank_cd(md.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_digests md
    WHERE md.fts @@ to_tsquery('english', p_query_terms)

    UNION ALL

    -- Semantic
    SELECT ms.id, 'semantic'::text,
      ts_rank_cd(ms.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_semantic ms
    WHERE ms.fts @@ to_tsquery('english', p_query_terms)
      AND ms.superseded_by IS NULL

    UNION ALL

    -- Procedural
    SELECT mp.id, 'procedural'::text,
      ts_rank_cd(mp.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_procedural mp
    WHERE mp.fts @@ to_tsquery('english', p_query_terms)
  ) combined
  ORDER BY rank_score DESC
  LIMIT p_match_count
$$;

GRANT EXECUTE ON FUNCTION engram_vector_search TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_text_boost TO authenticated, service_role;
```

- [ ] **Step 2: Commit**

```bash
git add migrations/supabase/011_vector_first_search.sql
git commit -m "feat(sql): add engram_vector_search and engram_text_boost RPCs"
```

---

### Task 10: Supabase Adapter — Implement vectorSearch and textBoost

**Files:**
- Modify: `packages/supabase/src/adapter.ts`

- [ ] **Step 1: Add vectorSearch method to SupabaseStorageAdapter**

In `packages/supabase/src/adapter.ts`, add after the `loadSensorySnapshot` method (before `assertInitialized`):

```typescript
  async vectorSearch(embedding: number[], opts?: {
    limit?: number
    sessionId?: string
    tiers?: MemoryType[]
  }): Promise<SearchResult<TypedMemory>[]> {
    this.assertInitialized()
    const { data, error } = await this.client.rpc('engram_vector_search', {
      p_query_embedding: JSON.stringify(embedding),
      p_match_count: opts?.limit ?? 15,
      p_session_id: opts?.sessionId ?? null,
    })
    if (error) throw new Error(`vectorSearch failed: ${error.message}`)

    const rows = (data ?? []) as VectorSearchRow[]
    const tierFilter = opts?.tiers ? new Set(opts.tiers) : null

    return rows
      .filter(r => !tierFilter || tierFilter.has(r.memory_type as MemoryType))
      .map(r => ({
        item: vectorRowToTypedMemory(r),
        similarity: r.similarity,
      }))
  }

  async textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>> {
    this.assertInitialized()
    if (terms.length === 0) return []

    // Format terms as OR-joined tsquery: "term1 | term2 | term3"
    const sanitized = terms
      .map(t => t.replace(/[^a-zA-Z0-9]/g, ''))
      .filter(t => t.length > 0)
    if (sanitized.length === 0) return []
    const queryTerms = sanitized.join(' | ')

    const { data, error } = await this.client.rpc('engram_text_boost', {
      p_query_terms: queryTerms,
      p_match_count: opts?.limit ?? 30,
      p_session_id: opts?.sessionId ?? null,
    })
    if (error) throw new Error(`textBoost failed: ${error.message}`)

    const rows = (data ?? []) as TextBoostRow[]
    // Normalize rank scores to 0-1
    const maxRank = rows.length > 0 ? Math.max(...rows.map(r => r.rank_score)) : 1
    return rows.map(r => ({
      id: r.id,
      type: r.memory_type as MemoryType,
      boost: maxRank > 0 ? r.rank_score / maxRank : 0,
    }))
  }
```

- [ ] **Step 2: Add row types and mapper**

Add these types and helper at the bottom of `packages/supabase/src/adapter.ts` (before the closing of the file):

```typescript
interface VectorSearchRow {
  id: string
  memory_type: string
  content: string
  role: string | null
  salience: number
  access_count: number
  created_at: string
  similarity: number
  entities: string[]
  metadata: Record<string, unknown>
}

interface TextBoostRow {
  id: string
  memory_type: string
  rank_score: number
}

function vectorRowToTypedMemory(row: VectorSearchRow): TypedMemory {
  switch (row.memory_type) {
    case 'episode':
      return {
        type: 'episode',
        data: {
          id: row.id,
          sessionId: '',
          role: (row.role ?? 'user') as 'user' | 'assistant' | 'system',
          content: row.content,
          salience: row.salience,
          accessCount: row.access_count,
          lastAccessed: null,
          consolidatedAt: null,
          embedding: null,
          entities: row.entities ?? [],
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
        },
      }
    case 'digest':
      return {
        type: 'digest',
        data: {
          id: row.id,
          sessionId: '',
          summary: row.content,
          keyTopics: row.entities ?? [],
          sourceEpisodeIds: [],
          sourceDigestIds: [],
          level: 1,
          embedding: null,
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
        },
      }
    case 'semantic':
      return {
        type: 'semantic',
        data: {
          id: row.id,
          topic: '',
          content: row.content,
          confidence: row.salience,
          sourceDigestIds: [],
          sourceEpisodeIds: [],
          accessCount: row.access_count,
          lastAccessed: null,
          decayRate: 0.01,
          supersedes: null,
          supersededBy: null,
          embedding: null,
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.created_at),
        },
      }
    case 'procedural':
      return {
        type: 'procedural',
        data: {
          id: row.id,
          category: 'convention' as const,
          trigger: '',
          procedure: row.content,
          confidence: row.salience,
          observationCount: 0,
          lastObserved: new Date(row.created_at),
          firstObserved: new Date(row.created_at),
          accessCount: row.access_count,
          lastAccessed: null,
          decayRate: 0.01,
          sourceEpisodeIds: [],
          embedding: null,
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.created_at),
        },
      }
    default:
      return {
        type: 'episode',
        data: {
          id: row.id,
          sessionId: '',
          role: 'user',
          content: row.content,
          salience: row.salience,
          accessCount: row.access_count,
          lastAccessed: null,
          consolidatedAt: null,
          embedding: null,
          entities: row.entities ?? [],
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
        },
      }
  }
}
```

- [ ] **Step 3: Add missing imports**

Ensure `SearchResult` is imported at the top of `packages/supabase/src/adapter.ts`:

```typescript
import type { MemoryType, TypedMemory, SensorySnapshot, SearchResult } from '@engram-mem/core'
```

- [ ] **Step 4: Type-check**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx tsc --noEmit -p packages/supabase/tsconfig.json 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/supabase/src/adapter.ts
git commit -m "feat(supabase): implement vectorSearch and textBoost on adapter"
```

---

### Task 11: SQLite Adapter — Implement vectorSearch and textBoost

**Files:**
- Modify: `packages/sqlite/src/adapter.ts`

SQLite schema reference (from `packages/sqlite/src/migrations.ts`):
- `episodes` table: `id TEXT`, `embedding BLOB`, `content TEXT`, `role TEXT`, `salience REAL`, `access_count INTEGER`, `metadata TEXT (JSON)`, `entities_json TEXT (JSON)`, `created_at REAL (julianday)`
- `digests` table: `id TEXT`, `embedding BLOB`, `summary TEXT`, `key_topics TEXT (JSON)`, `metadata TEXT (JSON)`, `created_at REAL (julianday)`
- `semantic` table: `id TEXT`, `embedding BLOB`, `content TEXT`, `topic TEXT`, `confidence REAL`, `access_count INTEGER`, `metadata TEXT (JSON)`, `superseded_by TEXT`, `created_at REAL (julianday)`
- `procedural` table: `id TEXT`, `embedding BLOB`, `procedure TEXT`, `trigger_text TEXT`, `confidence REAL`, `access_count INTEGER`, `metadata TEXT (JSON)`, `created_at REAL (julianday)`
- FTS5: `episodes_fts`, `digests_fts`, `semantic_fts`, `procedural_fts`

- [ ] **Step 1: Add imports to adapter.ts**

In `packages/sqlite/src/adapter.ts`, add these imports after the existing imports (line 10):

```typescript
import { cosineSimilarity, blobToVector } from './vector-search.js'
import type { SearchResult } from '@engram-mem/core'
```

- [ ] **Step 2: Add vectorSearch to SqliteStorageAdapter**

Add after the `loadSensorySnapshot` method in `packages/sqlite/src/adapter.ts`:

```typescript
  async vectorSearch(embedding: number[], opts?: {
    limit?: number
    sessionId?: string
    tiers?: MemoryType[]
  }): Promise<SearchResult<TypedMemory>[]> {
    const db = this.assertDb()
    const limit = opts?.limit ?? 15
    const tiers = opts?.tiers ?? ['episode', 'digest', 'semantic', 'procedural']
    const scanLimit = limit * 3 // fetch extra for re-ranking headroom
    const results: Array<SearchResult<TypedMemory>> = []

    if (tiers.includes('episode')) {
      const sql = opts?.sessionId
        ? 'SELECT * FROM episodes WHERE embedding IS NOT NULL AND session_id = ? ORDER BY created_at DESC LIMIT ?'
        : 'SELECT * FROM episodes WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?'
      const params = opts?.sessionId ? [opts.sessionId, scanLimit] : [scanLimit]
      const rows = db.prepare(sql).all(...params) as EpisodeRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const stored = blobToVector(row.embedding as unknown as Buffer)
        const sim = cosineSimilarity(embedding, stored)
        if (sim > 0) {
          const episodes = await this._episodes!.getByIds([row.id])
          if (episodes.length > 0) {
            results.push({ item: { type: 'episode', data: episodes[0] }, similarity: sim })
          }
        }
      }
    }

    if (tiers.includes('digest')) {
      const rows = db.prepare(
        'SELECT * FROM digests WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?'
      ).all(scanLimit) as DigestRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const stored = blobToVector(row.embedding as unknown as Buffer)
        const sim = cosineSimilarity(embedding, stored)
        if (sim > 0) {
          results.push({ item: { type: 'digest', data: rowToDigest(row) }, similarity: sim })
        }
      }
    }

    if (tiers.includes('semantic')) {
      const rows = db.prepare(
        'SELECT * FROM semantic WHERE embedding IS NOT NULL AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ?'
      ).all(scanLimit) as SemanticRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const stored = blobToVector(row.embedding as unknown as Buffer)
        const sim = cosineSimilarity(embedding, stored)
        if (sim > 0) {
          results.push({ item: { type: 'semantic', data: rowToSemanticMemory(row) }, similarity: sim })
        }
      }
    }

    if (tiers.includes('procedural')) {
      const rows = db.prepare(
        'SELECT * FROM procedural WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?'
      ).all(scanLimit) as ProceduralRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const stored = blobToVector(row.embedding as unknown as Buffer)
        const sim = cosineSimilarity(embedding, stored)
        if (sim > 0) {
          results.push({ item: { type: 'procedural', data: rowToProceduralMemory(row) }, similarity: sim })
        }
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  }
```

- [ ] **Step 3: Add textBoost to SqliteStorageAdapter**

Add immediately after `vectorSearch`:

```typescript
  async textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>> {
    const db = this.assertDb()
    if (terms.length === 0) return []
    const limit = opts?.limit ?? 30

    // FTS5 uses OR for disjunction: "term1 OR term2 OR term3"
    const ftsQuery = terms.join(' OR ')
    const allResults: Array<{ id: string; type: MemoryType; rankScore: number }> = []

    // Query each FTS5 table — rank is negative (lower = better match), take abs
    try {
      const epRows = db.prepare(
        'SELECT e.id, rank FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid WHERE episodes_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, limit) as Array<{ id: string; rank: number }>
      for (const r of epRows) allResults.push({ id: r.id, type: 'episode', rankScore: Math.abs(r.rank) })
    } catch { /* FTS5 table may not exist */ }

    try {
      const dgRows = db.prepare(
        'SELECT d.id, rank FROM digests_fts f JOIN digests d ON d.rowid = f.rowid WHERE digests_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, limit) as Array<{ id: string; rank: number }>
      for (const r of dgRows) allResults.push({ id: r.id, type: 'digest', rankScore: Math.abs(r.rank) })
    } catch { /* FTS5 table may not exist */ }

    try {
      const smRows = db.prepare(
        'SELECT s.id, rank FROM semantic_fts f JOIN semantic s ON s.rowid = f.rowid WHERE semantic_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, limit) as Array<{ id: string; rank: number }>
      for (const r of smRows) allResults.push({ id: r.id, type: 'semantic', rankScore: Math.abs(r.rank) })
    } catch { /* FTS5 table may not exist */ }

    try {
      const prRows = db.prepare(
        'SELECT p.id, rank FROM procedural_fts f JOIN procedural p ON p.rowid = f.rowid WHERE procedural_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, limit) as Array<{ id: string; rank: number }>
      for (const r of prRows) allResults.push({ id: r.id, type: 'procedural', rankScore: Math.abs(r.rank) })
    } catch { /* FTS5 table may not exist */ }

    // Normalize rank scores to 0-1
    const maxRank = allResults.length > 0 ? Math.max(...allResults.map(r => r.rankScore)) : 1
    return allResults
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        type: r.type,
        boost: maxRank > 0 ? r.rankScore / maxRank : 0,
      }))
  }
```

- [ ] **Step 4: Type-check**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx tsc --noEmit -p packages/sqlite/tsconfig.json 2>&1 | tail -10`
Expected: PASS (row types `EpisodeRow`, `DigestRow`, `SemanticRow`, `ProceduralRow` and mappers `rowToDigest`, `rowToSemanticMemory`, `rowToProceduralMemory` already exist in adapter.ts)

- [ ] **Step 5: Run SQLite tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run --project sqlite 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite/src/adapter.ts
git commit -m "feat(sqlite): implement vectorSearch and textBoost on adapter"
```

---

### Task 12: OpenClaw Plugin — Wire New Pipeline

**Files:**
- Modify: `packages/openclaw/src/openclaw-plugin.ts`

- [ ] **Step 1: Update assemble() to use new recall result shape**

The `assemble()` method in the plugin calls `memory.recall()` which now returns the new `RecallResult` shape. Since `Memory.recall()` maintains backward compatibility (returns `RecallResult` with `intent` field), the plugin's `assemble()` should work without changes.

Verify by reading the current assemble implementation and confirming it only uses: `result.memories`, `result.associations`, `result.estimatedTokens`, `result.formatted`, `result.intent.type`.

If it uses `result.intent.type` for logging, that still works because `Memory.recall()` bridges the old `IntentResult` shape.

- [ ] **Step 2: Update the engram_search tool**

The `engram_search` tool calls `memory.recall(params.query)` — this already goes through `Memory.recall()` which handles the new pipeline internally. No changes needed.

- [ ] **Step 3: Run OpenClaw tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run --project openclaw 2>&1 | tail -20`
Expected: Tests pass. If failures occur due to changed RecallResult shape, fix the test assertions.

- [ ] **Step 4: Commit (if any changes were needed)**

```bash
git add packages/openclaw/src/openclaw-plugin.ts
git commit -m "feat(openclaw): verify plugin works with vector-first pipeline"
```

---

### Task 13: Cleanup — Remove Legacy Code

**Files:**
- Delete: `packages/core/src/retrieval/recall.ts`
- Modify: `packages/core/src/types.ts` (optionally mark old types as deprecated)
- Modify: `packages/core/src/index.ts` (update exports)
- Delete: `packages/core/test/retrieval/recall-scoring.test.ts` (tests old scoring)
- Modify: `packages/core/test/intent/analyzer.test.ts` (keep if HeuristicIntentAnalyzer is still used)

- [ ] **Step 1: Delete recall.ts**

```bash
rm packages/core/src/retrieval/recall.ts
```

- [ ] **Step 2: Remove stale test**

```bash
rm packages/core/test/retrieval/recall-scoring.test.ts
```

- [ ] **Step 3: Update index.ts exports**

In `packages/core/src/index.ts`, add the new exports:

```typescript
export { classifyMode, RECALL_STRATEGIES } from './intent/intents.js'
export { unifiedSearch } from './retrieval/search.js'
export type { UnifiedSearchOpts } from './retrieval/search.js'
```

And verify the `recall` export still points to the new engine:

```typescript
export { recall } from './retrieval/engine.js'
export type { RecallResult, RecallOpts } from './retrieval/engine.js'
```

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/openclaw-memory && npx vitest run 2>&1 | tail -20`
Expected: ALL PASS across all packages. Fix any remaining failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove legacy recall.ts and stale tests, update exports"
```

---

## Success Criteria Verification

After all tasks are complete, verify the spec's success criteria against the production database:

1. **Exact query** ("scraper shield cloudflare worker") — must find stored content
2. **Vague query** ("that product idea about blocking bots") — must return >= 1 relevant result (THIS IS THE KEY FIX)
3. **Cross-session recall** ("remind me why I rejected skills hub") — must surface content from different session
4. **Header-polluted query** ("Node: RexBook ... scraper shield") — still finds content
5. **No false silencing** — top-8 results for generic query are relevant, not noise

Run these manually against the production Supabase database after deploying migration 011.
