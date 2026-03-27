# @engram/core

The brain of Engram. Core memory engine with 5 cognitive systems, intent-driven retrieval, and consolidation cycles.

## Installation

```bash
npm install @engram/core
```

Requires a storage adapter. See @engram/sqlite (local) or @engram/supabase (cloud).

## Quick Example

```javascript
import { createMemory } from '@engram/core'
import { sqliteAdapter } from '@engram/sqlite'

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
  tokenBudget?: number    // Max tokens for assembled context
}

const result = await memory.recall(query, { tokenBudget: 2000 })
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

#### `forget(query, opts?): Promise<ForgetResult>`

Deprioritize memories matching a query. Lossless — memories are never deleted, only decayed below retrieval floor.

```typescript
interface ForgetResult {
  count: number                   // Memories matched
  previewed: RetrievedMemory[]   // Preview without confirm
}

interface ForgetOptions {
  tier?: 'episode' | 'digest' | 'semantic' | 'procedural'  // Optional filter
  confirm?: boolean  // Default: false (preview only)
}

// Preview what would be forgotten
const preview = await memory.forget('legacy API endpoint')
console.log(`Would deprioritize ${preview.count} memories`)

// Actually apply the forgetting
const result = await memory.forget('legacy API endpoint', { confirm: true })
console.log(`Deprioritized ${result.count} memories`)
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

A: Use `tokenBudget` option to limit results. Memories are ranked by relevance, so top results are most valuable.

**Q: Sensory buffer not restored**

A: Snapshot is saved on `dispose()`. If process crashes, snapshot is lost. Ephemeral by design.

## Contributing

Contributions welcome! See [CONTRIBUTING.md](../../CONTRIBUTING.md) at repo root.

## License

MIT
