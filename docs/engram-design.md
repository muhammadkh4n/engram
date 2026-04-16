# Engram: A Brain-Inspired Cognitive Memory Engine

**Status**: Design Complete
**Author**: Muhammad Khan
**Date**: 2026-03-27
**Version**: 1.0

---

## 1. Vision

Engram is a standalone, brain-inspired memory engine for AI agents. While existing context engines (lossless-claw, MemOS, ClawMem) focus on compression and retrieval, Engram models five cognitive memory systems with consolidation cycles, associative networks, intent-driven recall, and reconsolidation on access.

**Positioning**: "LCM is the best compression engine. Engram is the best cognitive engine. Choose based on whether you want an agent that remembers or an agent that learns."

**Core principles**:
- **Lossless** — Memories are never deleted. They decay in priority, never in existence.
- **Cognitive** — Five memory systems modeled on neuroscience, not ad-hoc tiers.
- **Autonomous** — Intent analysis auto-triggers recall. Consolidation runs as sleep cycles. No manual memory management.
- **Zero-config** — Works out of the box with SQLite + BM25. No API keys required. Upgrades progressively.
- **Framework-agnostic** — Standalone library first. OpenClaw adapter is one integration among many.

---

## 2. Package Structure

Monorepo with scoped packages:

```
engram/
├── packages/
│   ├── core/                    # @engram-mem/core — the brain
│   │   ├── src/
│   │   │   ├── memory.ts        # createMemory() factory
│   │   │   ├── systems/         # 5 memory systems
│   │   │   │   ├── sensory-buffer.ts
│   │   │   │   ├── episodic.ts
│   │   │   │   ├── semantic.ts
│   │   │   │   ├── procedural.ts
│   │   │   │   └── association-manager.ts  # centralized edge policy
│   │   │   ├── intent/          # intent analyzer + salience detector
│   │   │   │   ├── analyzer.ts
│   │   │   │   ├── salience.ts
│   │   │   │   └── intents.ts
│   │   │   ├── retrieval/       # 4-stage recall engine
│   │   │   │   ├── recall.ts
│   │   │   │   ├── association-walk.ts
│   │   │   │   ├── priming.ts
│   │   │   │   └── reconsolidation.ts
│   │   │   ├── consolidation/   # sleep cycles
│   │   │   │   ├── scheduler.ts
│   │   │   │   ├── light-sleep.ts
│   │   │   │   ├── deep-sleep.ts
│   │   │   │   ├── dream-cycle.ts
│   │   │   │   └── decay-pass.ts
│   │   │   ├── adapters/        # interfaces
│   │   │   │   ├── storage.ts
│   │   │   │   └── intelligence.ts
│   │   │   ├── resilience/      # circuit breaker, timeout, retry
│   │   │   │   ├── circuit-breaker.ts
│   │   │   │   ├── timeout.ts
│   │   │   │   └── retry.ts
│   │   │   └── types.ts
│   │   ├── test/
│   │   └── package.json
│   │
│   ├── sqlite/                  # @engram-mem/sqlite — zero-config storage
│   │   ├── src/
│   │   │   ├── adapter.ts       # StorageAdapter implementation
│   │   │   ├── migrations.ts    # SQLite schema + FTS5
│   │   │   └── search.ts        # BM25 via FTS5
│   │   └── package.json
│   │
│   ├── supabase/                # @engram-mem/supabase — cloud storage
│   │   ├── src/
│   │   │   ├── adapter.ts       # StorageAdapter implementation
│   │   │   └── migrations/      # pgvector schema + RPC functions
│   │   └── package.json
│   │
│   ├── openai/                  # @engram-mem/openai — embeddings + LLM
│   │   ├── src/
│   │   │   ├── embeddings.ts    # OpenAI embedding adapter
│   │   │   └── summarizer.ts    # GPT-based summarization + intent
│   │   └── package.json
│   │
│   └── openclaw/                # @engram-mem/openclaw — plugin adapter
│       ├── src/
│       │   ├── plugin-entry.ts  # OpenClaw context engine wrapper
│       │   └── tools.ts         # memory_search, memory_expand, etc.
│       └── package.json
│
├── docs/
├── examples/
│   ├── zero-config/             # npm install @engram-mem/core @engram-mem/sqlite
│   ├── with-openai/             # + @engram-mem/openai
│   ├── with-supabase/           # + @engram-mem/supabase
│   └── openclaw-plugin/         # + @engram-mem/openclaw
└── package.json                 # monorepo root (turborepo)
```

---

## 3. Public API

### 3.1 Factory

```typescript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'

// Zero-config (SQLite + BM25, no API keys)
const memory = createMemory()

// Explicit configuration
const memory = createMemory({
  storage: sqliteAdapter({ path: './memory.db' }),
  intelligence: undefined, // heuristic mode
  consolidation: { schedule: 'manual' },
})
```

### 3.2 Core Methods

```typescript
interface Memory {
  /** Store a message. Auto-detects salience, extracts entities. */
  ingest(message: Message): Promise<void>

  /** Store multiple messages. Batch-optimized. */
  ingestBatch(messages: Message[]): Promise<void>

  /** Intent-analyzed, association-walked, primed recall. */
  recall(query: string, opts?: RecallOptions): Promise<RecallResult>

  /** Drill into a digest/summary to get original episodes. */
  expand(memoryId: string): Promise<ExpandResult>

  /** Run consolidation cycles. Usually automatic. */
  consolidate(cycle?: 'light' | 'deep' | 'dream' | 'decay' | 'all'): Promise<ConsolidateResult>

  /** Memory statistics and health. */
  stats(): Promise<MemoryStats>

  /** Deprioritize memories matching query (lossless — marks as forgotten, never deletes). */
  forget(query: string, opts?: ForgetOptions): Promise<ForgetResult>

  /** Get or create a session-scoped handle. Auto-generates sessionId if omitted. */
  session(sessionId?: string): SessionHandle

  /** Release resources, persist working memory. */
  dispose(): Promise<void>
}

interface SessionHandle {
  readonly sessionId: string
  ingest(message: Omit<Message, 'sessionId'>): Promise<void>
  recall(query: string, opts?: RecallOptions): Promise<RecallResult>
}
```

### 3.3 Recall Result

```typescript
interface RecallResult {
  /** Directly recalled memories, ranked by relevance. */
  memories: RetrievedMemory[]

  /** Memories found via association graph walk. */
  associations: RetrievedMemory[]

  /** Classified intent that drove the recall strategy. */
  intent: IntentResult

  /** Topics now primed for this session (boosted in future recalls). */
  primed: string[]

  /** Token estimate for the assembled context. */
  estimatedTokens: number

  /** Formatted context string (for injection into system prompt). */
  formatted: string
}

interface RetrievedMemory {
  id: string
  type: 'episode' | 'digest' | 'semantic' | 'procedural'
  content: string
  relevance: number       // 0-1, combined similarity + priming boost + recency
  source: 'recall' | 'association' | 'priming'
  metadata: Record<string, any>
}
```

### 3.4 Upgrade Path

```typescript
// Level 0: Zero-config (BM25 keyword search, heuristic summarization)
const memory = createMemory()

// Level 1: Add embeddings (semantic vector search)
import { openaiIntelligence } from '@engram-mem/openai'
const memory = createMemory({
  intelligence: openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY }),
})

// Level 2: Add cloud storage (distributed agents, shared memory)
import { supabaseAdapter } from '@engram-mem/supabase'
const memory = createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' }),
  intelligence: openaiIntelligence({ apiKey: '...' }),
})

// Level 3: Full cognitive engine (LLM-powered intent + consolidation)
const memory = createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' }),
  intelligence: openaiIntelligence({
    apiKey: '...',
    intentAnalysis: true,   // LLM-powered intent classification
    summarization: true,    // LLM-powered consolidation
  }),
  consolidation: { schedule: 'auto' },
})
```

---

## 4. The Five Memory Systems

### Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                   ASSOCIATIVE NETWORK                    │
│            (graph edges connecting everything)            │
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────┐   │
│  │  EPISODIC  │──│  SEMANTIC  │──│   PROCEDURAL    │   │
│  │  (events)  │  │  (facts)   │  │   (how-to)      │   │
│  └──────┬─────┘  └──────┬─────┘  └────────┬────────┘   │
│         └───────────────┼─────────────────┘             │
│                   ┌─────┴──────┐                        │
│                   │  SENSORY   │                        │
│                   │  BUFFER    │                        │
│                   └────────────┘                        │
└──────────────────────────────────────────────────────────┘
```

### 4.1 Sensory Buffer (Working Memory)

**Brain analogy**: Prefrontal cortex active workspace. ~7 items. Volatile. What you're "thinking about right now."

Session-scoped in-memory store. Holds active entities, primed topics from recent recalls, and the current intent classification. Evicts by importance when full.

```typescript
interface SensoryBuffer {
  items: Map<string, WorkingMemoryItem>    // max ~100 items
  primedTopics: Map<string, PrimedTopic>   // boosted by recent recalls
  activeIntent: IntentResult | null

  set(item: WorkingMemoryItem): void
  getPrimed(): PrimedTopic[]
  prime(topics: string[], boost: number, decayMs: number): void
  tick(): void                              // decay priming weights each turn
  snapshot(): SensorySnapshot
  restore(snapshot: SensorySnapshot): void
}

interface WorkingMemoryItem {
  key: string
  value: string
  category: 'entity' | 'topic' | 'decision' | 'preference' | 'context'
  importance: number    // 0-1
  timestamp: number
}

interface PrimedTopic {
  topic: string
  boost: number         // 0-1, added to similarity scores during recall
  decayRate: number     // how fast the boost fades per turn
  source: string        // which recall triggered this priming
  turnsRemaining: number
}
```

**Behaviors**:
- Evicts lowest-importance item when full (importance-weighted, not LRU)
- Primed topics decay each conversation turn (turn-based, not time-based)
- Persists snapshot to storage on session end via `dispose()`
- Restores from storage on session start
- Extracts entities/decisions/preferences from each ingested message via regex patterns

### 4.2 Episodic Memory (Events)

**Brain analogy**: Hippocampus. "I remember when..." Autobiographical events with context.

Lossless store of every conversation turn. The ground truth. Never deleted, only marked as consolidated.

```typescript
interface Episode {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string

  // Brain-inspired
  salience: number              // 0-1, assigned by salience detector on ingestion
  accessCount: number           // incremented on each recall
  lastAccessed: Date | null     // for reconsolidation
  consolidatedAt: Date | null   // when digested (episode is never deleted)

  // Indexing
  embedding: number[] | null    // null in Level 0 (BM25 mode)
  entities: string[]            // extracted people, tech, projects
  metadata: Record<string, any>
  createdAt: Date
}
```

**Behaviors**:
- **Lossless**: `consolidatedAt` marks digestion timestamp. The episode remains forever.
- **Salience scoring**: Assigned on ingestion by the salience detector (Section 5.2).
- **Reconsolidation**: On recall, `accessCount++` and `lastAccessed = now()`. Frequently recalled episodes get priority in future searches via relevance score boost: `relevance = similarity + (accessCount * 0.01)`.
- **Dual indexing**: FTS5 keyword index always present. Vector embedding added when intelligence adapter is configured.
- **Entity extraction**: People, technologies, projects extracted via regex on ingestion and stored in `entities[]` for association graph seeding.

### 4.3 Semantic Memory (Facts & Concepts)

**Brain analogy**: Neocortex long-term storage. "I know that..." Facts detached from when/where you learned them.

Distilled facts, entities, decisions extracted from episodes during consolidation. Confidence-scored with decay and strengthening dynamics.

```typescript
interface SemanticMemory {
  id: string
  topic: string                 // 'preference' | 'fact' | 'decision' | 'entity' | 'convention'
  content: string
  confidence: number            // 0-1, decays without access, boosts on recall

  // Provenance (lossless chain)
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]

  // Lifecycle
  accessCount: number
  lastAccessed: Date | null
  decayRate: number             // default 0.02 per decay pass
  supersedes: string | null     // ID of older knowledge this replaces
  supersededBy: string | null   // ID of newer knowledge that replaced this

  embedding: number[] | null
  metadata: Record<string, any>
  createdAt: Date
  updatedAt: Date
}
```

**Behaviors**:
- **Confidence decay**: Each decay pass (monthly), for unaccessed memories: `confidence = max(0.05, confidence - decayRate)`. Floor of 0.05 ensures lossless recall remains possible, just deprioritized.
- **Reconsolidation boost**: On retrieval, `confidence = min(1.0, confidence + 0.05)`. Spaced repetition: the more a fact is used, the stronger it gets.
- **Supersession**: When new knowledge contradicts existing (detected via KnowledgeExtractor), the old one gets `supersededBy` set, new one gets `supersedes` set. Both preserved. Superseded memories are deprioritized by 0.5x in recall scoring.
- **Extraction**: Created during deep sleep consolidation cycle via regex patterns for preferences ("I prefer X"), decisions ("we decided to Y"), entities ("my name is X"), and batch promotion (topic appears 3+ times in 7 days).

### 4.4 Procedural Memory (How-To)

**Brain analogy**: Basal ganglia + cerebellum. "I know how to..." Skills executed without conscious recall. In AI context: how the user prefers things done.

Workflows, patterns, habits, and operational preferences. Distinct from semantic: "TypeScript uses static typing" is semantic. "This user wants strict mode, prefers interfaces, and runs prettier before committing" is procedural.

```typescript
interface ProceduralMemory {
  id: string
  category: 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention'
  trigger: string               // when does this apply? "writing TypeScript", "before commit"
  procedure: string             // what to do: "use strict mode, prefer interfaces"
  confidence: number            // 0-1

  // Frequency-based learning
  observationCount: number      // how many times this pattern was observed
  lastObserved: Date
  firstObserved: Date

  // Lifecycle (same as semantic, but slower decay)
  accessCount: number
  lastAccessed: Date | null
  decayRate: number             // default 0.01 — half the semantic rate (procedural is stickier)

  sourceEpisodeIds: string[]
  embedding: number[] | null
  metadata: Record<string, any>
  createdAt: Date
  updatedAt: Date
}
```

**Behaviors**:
- **Slower decay**: In the brain, procedural memories are the most durable. Default `decayRate` is 0.01 (half of semantic's 0.02).
- **Observation-based strengthening**: Unlike semantic memory extracted from summaries, procedural memory strengthens when the same pattern is observed repeatedly. User runs `prettier` before every commit 5 times across sessions -> procedural memory: `{ trigger: "before commit", procedure: "run prettier", observationCount: 5, confidence: 0.85 }`.
- **Trigger matching**: During recall, the intent analyzer extracts the current activity. Procedural memories whose `trigger` matches are auto-recalled, even without an explicit query. "User is writing TypeScript" -> auto-recall all procedural memories with trigger containing "TypeScript."
- **Extraction patterns** (detected during deep sleep):
  - Explicit: "I always...", "My workflow is...", "Before deploying, I...", "Never use...", "Always run..."
  - Implicit: Repeated sequences across sessions detected by pattern mining (user consistently does A then B -> procedural: "after A, do B").

### 4.5 Associative Network (Memory Graph)

**Brain analogy**: Synaptic connections. Recalling "beach" activates "ocean", "sand", "sunscreen" — not by vector similarity, but because they were experienced together or causally linked.

Typed graph edges between any two memories across any system. Enables association walking during retrieval.

```typescript
interface Association {
  id: string
  sourceId: string
  sourceType: MemoryType        // 'episode' | 'semantic' | 'procedural' | 'digest'
  targetId: string
  targetType: MemoryType

  edgeType: EdgeType
  strength: number              // 0-1

  createdAt: Date
  lastActivated: Date | null
  metadata: Record<string, any>
}

type MemoryType = 'episode' | 'digest' | 'semantic' | 'procedural'

type EdgeType =
  | 'temporal'       // occurred close in time
  | 'causal'         // A caused or led to B
  | 'topical'        // share a topic or entity
  | 'supports'       // A provides evidence for B
  | 'contradicts'    // A conflicts with B
  | 'elaborates'     // A adds detail to B
  | 'derives_from'   // B was extracted/consolidated from A (provenance)
  | 'co_recalled'    // A and B were retrieved in the same session (implicit learning)
```

**Edge creation rules**:

| Edge Type | When Created | Initial Strength |
|-----------|-------------|-----------------|
| `derives_from` | During consolidation (episode->digest, digest->semantic) | 0.8 |
| `temporal` | Episodes in same session, within 5 turns of each other | 0.3 |
| `topical` | Two memories share 2+ extracted entities | 0.4 |
| `co_recalled` | Two memories returned in the same recall result | 0.2 |
| `supports` | New knowledge consistent with existing on same topic | 0.5 |
| `contradicts` | Supersession detected between two semantic memories | 0.7 |
| `elaborates` | New episode adds detail to existing knowledge | 0.4 |
| `causal` | Explicit causal language detected ("because", "led to", "caused") | 0.6 |

**Strength dynamics**:
- **Co-retrieval boost**: When both ends of an edge are recalled in the same session, `strength = min(1.0, strength + 0.1)`.
- **Dream cycle discovery**: Weekly scan finds memories sharing entities/topics that lack edges. Creates `topical` associations.
- **Decay**: Edges with `strength < 0.05` and `lastActivated` older than 90 days are pruned. This is the only deletion in the system — weak associations, not memories.

### 4.6 Digest Layer (Consolidation Artifact)

Digests are not a cognitive memory system. They are an engineering artifact of consolidation — compressed summaries that exist because LLMs have token limits. They serve as an intermediate tier between episodes and semantic/procedural memory.

```typescript
interface Digest {
  id: string
  sessionId: string
  summary: string
  keyTopics: string[]

  // Lossless provenance
  sourceEpisodeIds: string[]
  sourceDigestIds: string[]     // for hierarchical digests

  // Hierarchy
  level: number                 // 0 = from episodes, 1 = digest of digests, etc.

  embedding: number[] | null
  metadata: Record<string, any>
  createdAt: Date
}
```

**Hierarchical digests**: When digest count per session exceeds 100, groups of 20 are re-summarized into level-1 digests. This scales logarithmically — 10,000 episodes produce ~500 level-0 digests and ~25 level-1 digests.

---

## 5. Intent Analyzer & Salience Detector

### 5.1 Intent Analyzer (The Prefrontal Cortex)

The prefrontal cortex reads the current situation, determines the goal, and sends targeted retrieval cues to memory systems. The intent analyzer replaces the current simplistic RetrievalGate + TierRouter with a unified system that determines *whether*, *how*, and *where* to recall.

```typescript
interface IntentAnalyzer {
  /** Classify the intent of a message and produce a retrieval strategy. */
  analyze(message: string, context: AnalysisContext): IntentResult
}

interface AnalysisContext {
  recentMessages: Message[]       // last 3-5 messages for context
  activeIntent: IntentResult | null  // previous intent (for continuation detection)
  primedTopics: string[]          // currently primed topics
}

interface IntentResult {
  type: IntentType
  confidence: number              // 0-1
  strategy: RetrievalStrategy
  extractedCues: string[]         // entities, topics, temporal refs extracted
  salience: number                // how important is this message for memory formation
}

interface RetrievalStrategy {
  shouldRecall: boolean           // false for greetings, simple acks
  tiers: TierPriority[]          // ordered list of which systems to query
  queryTransform: string | null   // rewritten query optimized for search (null = use raw)
  maxResults: number
  minRelevance: number
  includeAssociations: boolean
  associationHops: number         // 0-2
  boostProcedural: boolean        // auto-recall matching procedural memories
}

interface TierPriority {
  tier: 'episode' | 'digest' | 'semantic' | 'procedural'
  weight: number                  // multiplier for this tier's results (0.5-2.0)
  recencyBias: number             // 0-1, how much to favor recent memories in this tier
}
```

### Intent Types & Strategies

```typescript
type IntentType =
  | 'TASK_START'        // "Let's build X", "I need to implement Y"
  | 'TASK_CONTINUE'     // "Next step", "Continue", "Where were we"
  | 'QUESTION'          // "What is X?", "How does Y work?"
  | 'RECALL_EXPLICIT'   // "Remember when...", "What did we decide about..."
  | 'DEBUGGING'         // "Error:", "This isn't working", "Bug in"
  | 'PREFERENCE'        // "I prefer X", "Don't do Y", "Always use Z"
  | 'REVIEW'            // "Review this", "Check my code"
  | 'CONTEXT_SWITCH'    // "Actually let's talk about Y", "Switching to"
  | 'EMOTIONAL'         // "This is critical!", "Urgent", "Frustrated"
  | 'SOCIAL'            // "Hi", "Thanks", "Ok"
  | 'INFORMATIONAL'     // User providing information, no recall needed
```

**Strategy table** (heuristic mode):

| Intent | shouldRecall | Tier Priority | Associations | Procedural Boost |
|--------|-------------|--------------|--------------|-----------------|
| TASK_START | true | semantic(1.5) > procedural(1.5) > episode(0.8) | yes, 2 hops | yes |
| TASK_CONTINUE | true | episode(1.5) > digest(1.0) | yes, 1 hop | yes |
| QUESTION | true | semantic(1.5) > episode(1.0) > digest(0.8) | yes, 1 hop | no |
| RECALL_EXPLICIT | true | all tiers(1.0) | yes, 2 hops | no |
| DEBUGGING | true | episode(1.5) > semantic(1.2) > procedural(0.8) | yes, 1 hop | yes |
| PREFERENCE | true (check contradictions) | semantic(1.5, topic=preference) | no | no |
| REVIEW | true | procedural(1.5) > semantic(1.0) | no | yes |
| CONTEXT_SWITCH | true (flush priming, new topic) | semantic(1.2) > episode(1.0) | yes, 1 hop | yes |
| EMOTIONAL | true (expanded search) | all tiers(1.2) | yes, 2 hops | yes |
| SOCIAL | false | - | - | - |
| INFORMATIONAL | false (but high salience for ingestion) | - | - | - |

### Heuristic Classification (Level 0-1, no LLM)

```typescript
// Pattern-based intent detection (fast, no API calls)
const INTENT_PATTERNS: Record<IntentType, RegExp[]> = {
  TASK_START: [
    /\b(let'?s|i need to|i want to|we should|build|create|implement|add|make)\b/i,
    /\b(start|begin|set up|initialize)\b.*\b(project|feature|module|component)\b/i,
  ],
  TASK_CONTINUE: [
    /\b(next|continue|proceed|go on|where were we|what'?s next)\b/i,
    /\b(step \d|move on|keep going)\b/i,
  ],
  QUESTION: [
    /\?$/,
    /\b(what|who|where|when|why|how|which|explain|describe|tell me)\b/i,
  ],
  RECALL_EXPLICIT: [
    /\b(remember|recall|we (discussed|talked|decided|agreed)|last time|previously)\b/i,
    /\b(what did (we|i|you)|did we ever|have we)\b/i,
  ],
  DEBUGGING: [
    /\b(error|bug|broken|fail|crash|exception|not working|issue|wrong)\b/i,
    /\b(debug|fix|troubleshoot|investigate)\b/i,
    /^(Error|TypeError|ReferenceError|SyntaxError):/,
  ],
  PREFERENCE: [
    /\b(i (prefer|like|want|hate|dislike|never|always))\b/i,
    /\b(don'?t (use|do|make|add)|please (always|never))\b/i,
  ],
  REVIEW: [
    /\b(review|check|look at|audit|inspect|lgtm)\b/i,
    /\b(code review|pr review|pull request)\b/i,
  ],
  CONTEXT_SWITCH: [
    /\b(actually|instead|switch|change topic|different thing|forget that)\b/i,
    /\b(let'?s talk about|moving on to|pivoting to)\b/i,
  ],
  EMOTIONAL: [
    /\b(critical|urgent|asap|important|priority|production( is)? down)\b/i,
    /\b(frustrated|confused|stuck|blocked|desperate)\b/i,
    /!{2,}/, // multiple exclamation marks
  ],
  SOCIAL: [
    /^(hi|hey|hello|thanks|thank you|ok|okay|sure|yes|no|yep|nope|lol|haha)\s*[.!]?$/i,
    /^[\p{Emoji}\s]+$/u,
  ],
  INFORMATIONAL: [], // default fallback
}
```

**Classification logic**:
1. Check SOCIAL first (if match and message < 20 chars, classify as SOCIAL)
2. Check EMOTIONAL (if match, classify as EMOTIONAL regardless of other patterns)
3. Check all other patterns, score by match count
4. If multiple match, prefer the one with more pattern hits
5. If no match and message > 15 chars, classify as INFORMATIONAL
6. If no match and message <= 15 chars, classify as SOCIAL

### LLM-Powered Classification (Level 3)

When `intelligence.intentAnalysis = true`, ambiguous messages are sent to a fast model (GPT-4o-mini / Haiku) for classification. The heuristic pass still runs first; LLM is only called when heuristic confidence < 0.6.

```typescript
const INTENT_CLASSIFICATION_PROMPT = `
Classify the user's intent. Return JSON:
{
  "type": "TASK_START|TASK_CONTINUE|QUESTION|RECALL_EXPLICIT|DEBUGGING|PREFERENCE|REVIEW|CONTEXT_SWITCH|EMOTIONAL|SOCIAL|INFORMATIONAL",
  "confidence": 0.0-1.0,
  "cues": ["extracted", "key", "topics"],
  "salience": 0.0-1.0
}

Recent context:
{context}

Current message:
{message}
`
```

### 5.2 Salience Detector (The Amygdala)

The amygdala tags experiences with emotional significance, determining encoding strength. The salience detector scores every ingested message to determine how strongly it should be encoded in memory.

```typescript
interface SalienceDetector {
  /** Score a message's importance for memory formation. */
  score(message: Message, context: SalienceContext): number
}

interface SalienceContext {
  recentMessages: Message[]
  existingPreferences: string[]   // for contradiction detection
}
```

**Salience signals and weights**:

| Signal | Detection | Score |
|--------|----------|-------|
| Explicit flag | "remember this", "important", "note:" | 0.95 |
| Decision | "let's go with", "we decided", "the plan is" | 0.90 |
| Correction | "no actually", "that's wrong", "not like that" | 0.85 |
| Preference | "I prefer", "I always", "I never" | 0.85 |
| Emotional | "frustrated", "critical", "urgent", "excited" | 0.80 |
| Repetition | Same topic seen 3+ times in recent context | 0.75 |
| Question | Direct question (ends with ?) | 0.60 |
| Code block | Contains ``` or indented code | 0.50 |
| Long message | >200 chars | 0.40 |
| Default | No signals detected | 0.30 |
| Acknowledgment | "ok", "thanks", "sure" | 0.10 |

**Combination rule**: If multiple signals match, take `max(signals) + 0.05 * (count - 1)`, capped at 0.99.

**High salience effects**:
- Salience >= 0.8: Episode gets richer entity extraction, protected from decay in early consolidation passes
- Salience >= 0.6: Normal processing
- Salience < 0.3: Minimal processing, lowest priority for consolidation

---

## 6. Retrieval Engine (Four-Stage Recall)

The retrieval engine replaces the current flat search with a four-stage cognitive recall process.

```
Message → Intent Analyzer → Strategy
                               ↓
                     ┌─── Stage 1: Recall ───┐
                     │  (vector/BM25 search)  │
                     └────────┬───────────────┘
                              ↓
                     ┌─── Stage 2: Associate ─┐
                     │  (graph edge walk)      │
                     └────────┬───────────────┘
                              ↓
                     ┌─── Stage 3: Prime ─────┐
                     │  (boost session cache)  │
                     └────────┬───────────────┘
                              ↓
                     ┌─── Stage 4: Update ────┐
                     │  (reconsolidation)      │
                     └────────┬───────────────┘
                              ↓
                        RecallResult
```

### Stage 1: Recall (Search)

Execute searches across memory systems according to the intent strategy.

```typescript
async function stageRecall(
  query: string,
  strategy: RetrievalStrategy,
  storage: StorageAdapter,
  sensory: SensoryBuffer
): Promise<ScoredMemory[]> {
  if (!strategy.shouldRecall) return []

  // Build queries per tier
  const searches = strategy.tiers.map(tier => ({
    tier: tier.tier,
    promise: storage[tier.tier].search(
      strategy.queryTransform || query,
      {
        limit: strategy.maxResults,
        minScore: strategy.minRelevance,
      }
    ),
    weight: tier.weight,
    recencyBias: tier.recencyBias,
  }))

  // Execute in parallel
  const results = await Promise.allSettled(searches.map(s => s.promise))

  // Merge, weight, and rank
  const scored: ScoredMemory[] = []
  for (let i = 0; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue
    const items = results[i].value
    const { weight, recencyBias, tier } = searches[i]

    for (const item of items) {
      // Apply priming boost from sensory buffer
      const primingBoost = sensory.getPrimingBoost(item.content, item.metadata)

      // Apply recency bias
      const ageHours = (Date.now() - item.createdAt.getTime()) / 3_600_000
      const recencyScore = recencyBias * Math.exp(-ageHours / 720) // 30-day half-life

      // Apply access frequency boost (reconsolidation effect)
      const accessBoost = Math.min(0.1, (item.accessCount || 0) * 0.01)

      const finalScore = (item.similarity * weight) + primingBoost + recencyScore + accessBoost

      scored.push({
        ...item,
        tier: tier.tier,
        relevance: Math.min(1.0, finalScore),
        source: 'recall',
      })
    }
  }

  return scored.sort((a, b) => b.relevance - a.relevance).slice(0, strategy.maxResults)
}
```

### Stage 2: Association Walk

Follow graph edges from recalled memories to find contextually related memories that vector similarity misses.

```typescript
async function stageAssociate(
  recalled: ScoredMemory[],
  strategy: RetrievalStrategy,
  storage: StorageAdapter
): Promise<ScoredMemory[]> {
  if (!strategy.includeAssociations || strategy.associationHops === 0) return []

  // Collect IDs of recalled memories
  const recalledIds = new Set(recalled.map(m => m.id))

  // Walk edges from top-N recalled memories (not all — expensive)
  const topN = recalled.slice(0, 5)
  const associated: ScoredMemory[] = []

  for (const memory of topN) {
    const edges = await storage.associations.getForMemory(memory.id, {
      maxHops: strategy.associationHops,
      minStrength: 0.2,
    })

    for (const edge of edges) {
      // Skip if already in recalled set
      const targetId = edge.sourceId === memory.id ? edge.targetId : edge.sourceId
      if (recalledIds.has(targetId)) continue

      // Fetch the target memory
      const target = await storage.getById(targetId, edge.targetType)
      if (!target) continue

      // Score based on edge strength and original memory's relevance
      const relevance = memory.relevance * edge.strength * 0.8 // dampen by 0.8 per hop

      associated.push({
        ...target,
        relevance,
        source: 'association',
        metadata: {
          ...target.metadata,
          associatedVia: edge.edgeType,
          associatedFrom: memory.id,
        },
      })

      recalledIds.add(targetId) // prevent duplicates
    }
  }

  return associated.sort((a, b) => b.relevance - a.relevance).slice(0, 10)
}
```

### Stage 3: Priming

Inject topics from recalled + associated memories into the sensory buffer. Future queries in this session will get a relevance boost for these topics.

```typescript
function stagePrime(
  recalled: ScoredMemory[],
  associated: ScoredMemory[],
  sensory: SensoryBuffer
): string[] {
  // Extract topics from all retrieved memories
  const topicCounts = new Map<string, number>()

  for (const memory of [...recalled, ...associated]) {
    const topics = extractTopics(memory) // from entities, keyTopics, content keywords
    for (const topic of topics) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1)
    }
  }

  // Prime topics that appear in 2+ recalled memories (strong signal)
  const primedTopics: string[] = []
  for (const [topic, count] of topicCounts) {
    if (count >= 2) {
      sensory.prime(
        [topic],
        0.15 * Math.min(count, 5),  // boost: 0.15-0.75 based on frequency
        5                             // decay over 5 turns
      )
      primedTopics.push(topic)
    }
  }

  return primedTopics
}
```

### Stage 4: Reconsolidation

Update retrieved memories to reflect that they were accessed. This is how memories strengthen through use.

```typescript
async function stageReconsolidate(
  recalled: ScoredMemory[],
  associated: ScoredMemory[],
  storage: StorageAdapter
): Promise<void> {
  const allMemories = [...recalled, ...associated]

  // Update access counts and timestamps (fire-and-forget, don't block recall)
  const updates = allMemories.map(async (memory) => {
    if (memory.tier === 'semantic') {
      await storage.semantic.recordAccess(memory.id)
      // Confidence boost: min(1.0, confidence + 0.05)
      await storage.semantic.boostConfidence(memory.id, 0.05)
    } else if (memory.tier === 'procedural') {
      await storage.procedural.recordAccess(memory.id)
    } else if (memory.tier === 'episode') {
      await storage.episodes.recordAccess(memory.id)
    }
  })

  // Create co_recalled edges between memories retrieved together
  for (let i = 0; i < allMemories.length; i++) {
    for (let j = i + 1; j < Math.min(allMemories.length, i + 5); j++) {
      await storage.associations.upsertCoRecalled(
        allMemories[i].id, allMemories[i].tier,
        allMemories[j].id, allMemories[j].tier
      )
    }
  }

  // Don't await — this is background work
  Promise.allSettled(updates).catch(() => {})
}
```

---

## 7. Consolidation Engine (Sleep Cycles)

The consolidation engine transforms raw experiences into structured knowledge through four cycles modeled on sleep neuroscience.

```
┌──────────────────────────────────────────────────┐
│              CONSOLIDATION ENGINE                 │
│                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐ │
│  │  LIGHT   │  │   DEEP    │  │    DREAM     │ │
│  │  SLEEP   │  │   SLEEP   │  │    CYCLE     │ │
│  │  (daily) │  │  (weekly) │  │   (weekly)   │ │
│  │          │  │           │  │              │ │
│  │ Episode  │  │ Digest →  │  │ Discover new │ │
│  │ → Digest │  │ Semantic  │  │ associations │ │
│  │          │  │ → Proced. │  │              │ │
│  └──────────┘  └───────────┘  └──────────────┘ │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │            DECAY PASS (monthly)           │   │
│  │  Lower confidence of unaccessed memories  │   │
│  │  Prune weak association edges             │   │
│  └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

### 7.1 Consolidation Scheduler

```typescript
interface ConsolidationScheduler {
  /** Start automatic consolidation on intervals. */
  start(): void

  /** Stop automatic consolidation. */
  stop(): void

  /** Manually trigger a specific cycle. */
  runCycle(cycle: CycleType): Promise<ConsolidateResult>
}

type CycleType = 'light' | 'deep' | 'dream' | 'decay' | 'all'

interface ConsolidationConfig {
  schedule: 'auto' | 'manual'
  lightSleep: {
    intervalMs: number          // default: 24h
    batchSize: number           // default: 20 episodes per digest
    minEpisodes: number         // default: 5 (skip if fewer)
  }
  deepSleep: {
    intervalMs: number          // default: 7 days
    minDigests: number          // default: 3
  }
  dreamCycle: {
    intervalMs: number          // default: 7 days
    maxNewAssociations: number  // default: 50 per cycle
  }
  decayPass: {
    intervalMs: number          // default: 30 days
    semanticDecayRate: number   // default: 0.02
    proceduralDecayRate: number // default: 0.01
    edgePruneThreshold: number  // default: 0.05
  }
}
```

### 7.2 Light Sleep (Daily) — Episodes -> Digests

**Brain analogy**: Hippocampal replay during NREM sleep. Recent experiences are replayed and transferred toward neocortex.

Takes unsummarized episodes from the last 24 hours and creates digests. Salience-weighted: high-salience episodes get richer summaries.

```typescript
async function lightSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter,
  config: ConsolidationConfig
): Promise<LightSleepResult> {
  let digestsCreated = 0
  let episodesProcessed = 0

  // Get sessions with unconsolidated episodes
  const sessions = await storage.episodes.getUnconsolidatedSessions()

  for (const sessionId of sessions) {
    const episodes = await storage.episodes.getUnconsolidated(sessionId)
    if (episodes.length < config.lightSleep.minEpisodes) continue

    // Sort by salience (high-salience episodes get more attention)
    episodes.sort((a, b) => b.salience - a.salience)

    // Batch into groups
    for (let i = 0; i < episodes.length; i += config.lightSleep.batchSize) {
      const batch = episodes.slice(i, i + config.lightSleep.batchSize)

      // Summarize with salience-awareness
      const avgSalience = batch.reduce((s, e) => s + e.salience, 0) / batch.length
      const summary = await summarizeWithEscalation(batch, intelligence, {
        detailLevel: avgSalience > 0.7 ? 'high' : avgSalience > 0.4 ? 'medium' : 'low',
      })

      // Create digest
      const digest = await storage.digests.insert({
        sessionId,
        summary: summary.text,
        keyTopics: summary.topics,
        sourceEpisodeIds: batch.map(e => e.id),
        sourceDigestIds: [],
        level: 0,
        metadata: {
          source: 'light_sleep',
          avgSalience,
          entities: summary.entities,
          decisions: summary.decisions,
        },
      })

      // Mark episodes as consolidated (not deleted — lossless)
      await storage.episodes.markConsolidated(batch.map(e => e.id))

      // Create derives_from associations
      for (const episode of batch) {
        await storage.associations.insert({
          sourceId: episode.id,
          sourceType: 'episode',
          targetId: digest.id,
          targetType: 'digest',
          edgeType: 'derives_from',
          strength: 0.8,
        })
      }

      digestsCreated++
      episodesProcessed += batch.length
    }
  }

  // Hierarchical digests: if session has >100 digests, create level-1
  await createHierarchicalDigests(storage, intelligence)

  return { digestsCreated, episodesProcessed }
}
```

### Three-Level Summarization Escalation

Guarantees summarization always converges. Prevents infinite loops when LLM refuses to condense.

```typescript
async function summarizeWithEscalation(
  episodes: Episode[],
  intelligence: IntelligenceAdapter,
  opts: { detailLevel: 'high' | 'medium' | 'low'; targetTokens?: number }
): Promise<SummaryResult> {
  const content = episodes.map(e => `[${e.role}]: ${e.content}`).join('\n')
  const targetTokens = opts.targetTokens || 1200

  // Level 1: Detail-preserving (LLM or heuristic)
  if (intelligence.summarize) {
    const level1 = await intelligence.summarize(content, {
      mode: 'preserve_details',
      targetTokens,
      detailLevel: opts.detailLevel,
    })
    if (estimateTokens(level1.text) <= targetTokens) return level1
  }

  // Level 2: Aggressive bullet points
  if (intelligence.summarize) {
    const level2 = await intelligence.summarize(content, {
      mode: 'bullet_points',
      targetTokens: Math.floor(targetTokens * 0.8),
    })
    if (estimateTokens(level2.text) <= targetTokens) return level2
  }

  // Level 3: Deterministic extraction (no LLM, guaranteed to terminate)
  return heuristicSummarize(episodes, targetTokens)
}

function heuristicSummarize(episodes: Episode[], targetTokens: number): SummaryResult {
  // Extract key sentences using TF-IDF scoring
  const sentences = episodes.flatMap(e => e.content.split(/[.!?]+/).filter(s => s.trim()))
  const scored = sentences.map(s => ({
    text: s.trim(),
    score: tfidfScore(s, sentences),
  }))
  scored.sort((a, b) => b.score - a.score)

  // Take top sentences until token budget
  let tokens = 0
  const selected: string[] = []
  for (const s of scored) {
    const t = estimateTokens(s.text)
    if (tokens + t > targetTokens) break
    selected.push(s.text)
    tokens += t
  }

  // Extract topics from high-scoring sentences
  const topics = extractKeywords(selected.join(' '), 10)

  return {
    text: selected.join('. ') + '.',
    topics,
    entities: [],
    decisions: [],
  }
}
```

### 7.3 Deep Sleep (Weekly) — Digests -> Semantic + Procedural

**Brain analogy**: Slow-wave sleep. Deep processing that transfers memories from hippocampus to neocortex, extracting patterns and rules.

Processes recent digests to extract semantic knowledge and procedural memory. Uses pattern detection, deduplication, and supersession checking.

```typescript
async function deepSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter,
  config: ConsolidationConfig
): Promise<DeepSleepResult> {
  const digests = await storage.digests.getRecent(7) // last 7 days
  if (digests.length < config.deepSleep.minDigests) {
    return { promoted: 0, procedural: 0, deduplicated: 0, superseded: 0 }
  }

  let promoted = 0, procedural = 0, deduplicated = 0, superseded = 0

  // --- Semantic Knowledge Extraction ---
  const candidates = await extractKnowledgeCandidates(digests, intelligence)

  for (const candidate of candidates) {
    // Check deduplication (cosine similarity or keyword overlap)
    const existing = await storage.semantic.search(candidate.content, { limit: 5 })
    const duplicate = existing.find(e => e.similarity > 0.92)

    if (duplicate) {
      // Boost existing knowledge's confidence instead of inserting duplicate
      await storage.semantic.boostConfidence(duplicate.item.id, 0.1)
      deduplicated++
      continue
    }

    // Check supersession (contradicting existing knowledge)
    const supersededId = await checkSupersession(candidate, existing)
    if (supersededId) {
      await storage.semantic.markSuperseded(supersededId, candidate.id)
      superseded++
    }

    // Insert new semantic memory
    const knowledge = await storage.semantic.insert({
      topic: candidate.topic,
      content: candidate.content,
      confidence: candidate.confidence,
      sourceDigestIds: candidate.sourceDigestIds,
      sourceEpisodeIds: candidate.sourceEpisodeIds,
      decayRate: 0.02,
    })

    // Create derives_from associations
    for (const digestId of candidate.sourceDigestIds) {
      await storage.associations.insert({
        sourceId: digestId, sourceType: 'digest',
        targetId: knowledge.id, targetType: 'semantic',
        edgeType: 'derives_from',
        strength: 0.8,
      })
    }

    promoted++
  }

  // --- Procedural Memory Extraction ---
  const procedures = await extractProceduralCandidates(digests, storage, intelligence)

  for (const proc of procedures) {
    // Check if similar procedure already exists
    const existing = await storage.procedural.search(proc.trigger + ' ' + proc.procedure, { limit: 3 })
    const match = existing.find(e => e.similarity > 0.85)

    if (match) {
      // Strengthen existing procedure
      await storage.procedural.incrementObservation(match.item.id)
      continue
    }

    await storage.procedural.insert({
      category: proc.category,
      trigger: proc.trigger,
      procedure: proc.procedure,
      confidence: proc.confidence,
      observationCount: proc.observationCount,
      decayRate: 0.01,
      sourceEpisodeIds: proc.sourceEpisodeIds,
    })
    procedural++
  }

  return { promoted, procedural, deduplicated, superseded }
}
```

**Procedural extraction patterns**:

```typescript
const PROCEDURAL_PATTERNS = [
  // Explicit workflow declarations
  { pattern: /\b(my workflow is|i usually|my process is|i always)\b(.+)/i, category: 'workflow' },
  { pattern: /\b(before (i|we) \w+, (i|we))\b(.+)/i, category: 'workflow' },
  { pattern: /\b(after (i|we) \w+, (i|we))\b(.+)/i, category: 'workflow' },

  // Explicit preferences
  { pattern: /\b(i prefer|i like to|i want|i need)\b(.+)/i, category: 'preference' },
  { pattern: /\b(don'?t|never|avoid|stop)\b(.+)/i, category: 'preference' },
  { pattern: /\b(always|make sure to|ensure)\b(.+)/i, category: 'convention' },

  // Implicit patterns (detected across sessions)
  // These are extracted by comparing sequences of user actions across digests
  // e.g., "User wrote code" followed by "User asked for tests" 3+ times -> procedural
]
```

### 7.4 Dream Cycle (Weekly) — Association Discovery

**Brain analogy**: REM sleep. The brain creates unexpected connections between memories, sometimes surfacing insights. Dreams combine disparate experiences.

Scans recent memories for shared entities/topics that lack explicit associations, and creates `topical` edges.

```typescript
async function dreamCycle(
  storage: StorageAdapter,
  config: ConsolidationConfig
): Promise<DreamCycleResult> {
  let associationsCreated = 0

  // Get all recent memories (last 30 days) with their entities
  const recentMemories = await storage.getAllRecent(30) // across all tiers

  // Build entity -> memory map
  const entityMap = new Map<string, { id: string; type: MemoryType }[]>()
  for (const memory of recentMemories) {
    const entities = memory.entities || extractEntities(memory.content)
    for (const entity of entities) {
      const normalized = entity.toLowerCase()
      if (!entityMap.has(normalized)) entityMap.set(normalized, [])
      entityMap.get(normalized)!.push({ id: memory.id, type: memory.type })
    }
  }

  // For each entity shared by 2+ memories, check if association exists
  for (const [entity, memories] of entityMap) {
    if (memories.length < 2) continue

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        if (associationsCreated >= config.dreamCycle.maxNewAssociations) break

        const existing = await storage.associations.exists(
          memories[i].id, memories[j].id
        )
        if (existing) continue

        // Create topical association
        await storage.associations.insert({
          sourceId: memories[i].id,
          sourceType: memories[i].type,
          targetId: memories[j].id,
          targetType: memories[j].type,
          edgeType: 'topical',
          strength: 0.3 + (0.1 * Math.min(memories.length, 5)), // stronger if entity is widespread
          metadata: { discoveredVia: entity },
        })
        associationsCreated++
      }
    }
  }

  return { associationsCreated }
}
```

### 7.5 Decay Pass (Monthly) — Ebbinghaus Forgetting Curve

**Brain analogy**: Synaptic pruning. Unused neural pathways weaken. The brain doesn't delete — it deprioritizes.

Lowers confidence of unaccessed memories and prunes weak association edges. Nothing is deleted except edges below minimum strength threshold.

```typescript
async function decayPass(
  storage: StorageAdapter,
  config: ConsolidationConfig
): Promise<DecayPassResult> {
  let semanticDecayed = 0
  let proceduralDecayed = 0
  let edgesPruned = 0

  // Decay semantic memories not accessed since last pass
  const semanticUnaccessed = await storage.semantic.getUnaccessed(30) // 30 days
  for (const memory of semanticUnaccessed) {
    const newConfidence = Math.max(0.05, memory.confidence - config.decayPass.semanticDecayRate)
    if (newConfidence !== memory.confidence) {
      await storage.semantic.updateConfidence(memory.id, newConfidence)
      semanticDecayed++
    }
  }

  // Decay procedural memories (slower rate)
  const proceduralUnaccessed = await storage.procedural.getUnaccessed(60) // 60 days (stickier)
  for (const memory of proceduralUnaccessed) {
    const newConfidence = Math.max(0.05, memory.confidence - config.decayPass.proceduralDecayRate)
    if (newConfidence !== memory.confidence) {
      await storage.procedural.updateConfidence(memory.id, newConfidence)
      proceduralDecayed++
    }
  }

  // Prune weak association edges (the ONLY deletion in the system)
  edgesPruned = await storage.associations.pruneWeak({
    maxStrength: config.decayPass.edgePruneThreshold,
    olderThan: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days
  })

  return { semanticDecayed, proceduralDecayed, edgesPruned }
}
```

---

## 8. Storage Adapter Interface

The storage adapter abstracts all persistence. Each adapter handles search internally — SQLite uses FTS5, Supabase uses pgvector. The interface is split into composable per-system interfaces so adapters can be built incrementally.

### 8.0 Composable Interface Design

```typescript
// Each system is a separate interface — adapters can implement incrementally
interface EpisodeStorage {
  insert(episode: Omit<Episode, 'id' | 'createdAt'>): Promise<Episode>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<Episode>[]>
  getByIds(ids: string[]): Promise<Episode[]>
  getBySession(sessionId: string, opts?: { since?: Date }): Promise<Episode[]>
  getUnconsolidated(sessionId: string): Promise<Episode[]>
  getUnconsolidatedSessions(): Promise<string[]>
  markConsolidated(ids: string[]): Promise<void>
  recordAccess(id: string): Promise<void>
}

interface DigestStorage {
  insert(digest: Omit<Digest, 'id' | 'createdAt'>): Promise<Digest>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<Digest>[]>
  getBySession(sessionId: string): Promise<Digest[]>
  getRecent(days: number): Promise<Digest[]>
  getCountBySession(): Promise<Record<string, number>>
}

interface SemanticStorage {
  insert(memory: Omit<SemanticMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>): Promise<SemanticMemory>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<SemanticMemory>[]>
  getUnaccessed(days: number): Promise<SemanticMemory[]>
  /** Atomic: increment access_count + update last_accessed + boost confidence in one operation. */
  recordAccessAndBoost(id: string, confidenceBoost: number): Promise<void>
  markSuperseded(id: string, supersededBy: string): Promise<void>
  /** Batch decay: single UPDATE for all unaccessed memories. */
  batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number>
}

interface ProceduralStorage {
  insert(memory: Omit<ProceduralMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>): Promise<ProceduralMemory>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]>
  searchByTrigger(activity: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]>
  recordAccess(id: string): Promise<void>
  incrementObservation(id: string): Promise<void>
  /** Batch decay: single UPDATE for all unaccessed memories. */
  batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number>
}

interface AssociationStorage {
  insert(association: Omit<Association, 'id' | 'createdAt'>): Promise<Association>
  /** Graph walk via recursive CTE — replaces N+1 individual queries. */
  walk(seedIds: string[], opts?: { maxHops?: number; minStrength?: number; types?: EdgeType[] }): Promise<WalkResult[]>
  upsertCoRecalled(sourceId: string, sourceType: MemoryType, targetId: string, targetType: MemoryType): Promise<void>
  pruneWeak(opts: { maxStrength: number; olderThanDays: number }): Promise<number>
  /** SQL-side dream cycle: entity co-occurrence with NOT EXISTS anti-join. */
  discoverTopicalEdges(opts: { daysLookback: number; maxNew: number }): Promise<DiscoveredEdge[]>
}

// Composed full adapter
interface StorageAdapter {
  initialize(): Promise<void>
  dispose(): Promise<void>
  episodes: EpisodeStorage
  digests: DigestStorage
  semantic: SemanticStorage
  procedural: ProceduralStorage
  associations: AssociationStorage
  /** Fetch any memory by ID — returns discriminated union, not `any`. */
  getById(id: string, type: MemoryType): Promise<TypedMemory | null>
  /** Batch fetch by IDs across all tiers (for association walk target resolution). */
  getByIds(ids: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]>
  /** Sensory buffer persistence. */
  saveSensorySnapshot(sessionId: string, snapshot: SensorySnapshot): Promise<void>
  loadSensorySnapshot(sessionId: string): Promise<SensorySnapshot | null>
}

// Discriminated union — no `any` in the retrieval pipeline
type TypedMemory =
  | { type: 'episode'; data: Episode }
  | { type: 'digest'; data: Digest }
  | { type: 'semantic'; data: SemanticMemory }
  | { type: 'procedural'; data: ProceduralMemory }

interface WalkResult {
  memoryId: string
  memoryType: MemoryType
  depth: number
  pathStrength: number
}

interface DiscoveredEdge {
  sourceId: string
  sourceType: MemoryType
  targetId: string
  targetType: MemoryType
  sharedEntity: string
  entityCount: number
}

interface SearchOptions {
  limit?: number            // default: 10
  minScore?: number         // default: 0.3
  sessionId?: string        // filter to specific session
  embedding?: number[]      // pre-computed embedding (skips re-embedding the query 4x)
}

interface SearchResult<T> {
  item: T
  similarity: number        // 0-1
}
```

### 8.1 Universal Memory ID Pool

All memory tables reference a `memories` table as the sole ID authority. This solves the polymorphic association FK problem — `associations.source_id` and `target_id` both get real foreign key constraints.

IDs use UUID v7 (time-ordered) for monotonic B-tree insert performance, replacing UUID v4 which causes 50% page splits.

### 8.2 SQLite Adapter (@engram-mem/sqlite)

Zero-config storage using better-sqlite3 with FTS5 full-text search.

**Complete production-ready schema**: See `docs/engram-db-audit.md` Section 7a for the full schema including:
- `memories` table for FK enforcement
- Julian Day timestamps (`REAL`) instead of TEXT — monotonically comparable, arithmetic-friendly
- NOT NULL on all columns with defaults
- CHECK constraints on all enums and bounded values
- Generated columns for FTS-safe entity text (strips JSON punctuation)
- FTS5 with `porter unicode61 remove_diacritics 1` tokenizer + `prefix="2 3"`
- All FTS5 sync triggers (AFTER INSERT/UPDATE/DELETE on every base table)
- Composite indexes for all hot query patterns
- Partial indexes for decay pass and weak edge pruning
- `consolidation_runs` table for idempotent crash recovery
- `sensory_snapshots` table for buffer persistence

**Required pragmas** (set at connection open, not in schema):

```sql
PRAGMA journal_mode = WAL;       -- concurrent reads during writes
PRAGMA synchronous = NORMAL;     -- safe with WAL, faster than FULL
PRAGMA foreign_keys = ON;        -- enforce FK constraints
PRAGMA cache_size = -65536;      -- 64MB page cache
PRAGMA temp_store = MEMORY;      -- temp tables in RAM
PRAGMA mmap_size = 268435456;    -- 256MB memory-mapped I/O
PRAGMA wal_autocheckpoint = 1000; -- prevent unbounded WAL growth
```

**Search implementation**: BM25 via FTS5. When an embedding provider is configured, runs BM25 and vector search in parallel (not fallback — parallel merge). Vector embeddings stored as raw Float32 BLOB (`Buffer.from(new Float32Array(embedding).buffer)`), not JSON-stringified.

**Level 0 quality note**: BM25 keyword search without embeddings will produce lower recall quality than vector search for paraphrase queries. Level 0 is suitable for demos and low-stakes use. Level 1+ (with embeddings) is recommended for production.

### 8.3 Supabase Adapter (@engram-mem/supabase)

Cloud storage using PostgreSQL 15+ with pgvector and HNSW indexes.

**Complete production-ready schema**: See `docs/engram-db-audit.md` Section 7b for the full schema including:
- `memories` table for FK enforcement
- HNSW vector indexes (`m=16, ef_construction=64`) replacing ivfflat
- Partial vector indexes (`WHERE embedding IS NOT NULL AND superseded_by IS NULL`)
- GIN indexes on array columns (entities, key_topics, source_episode_ids)
- pg_trgm indexes for text search fallback
- RPC functions: `engram_recall` (unified cross-tier search), `engram_association_walk` (recursive CTE), `engram_record_access` (atomic reconsolidation), `engram_upsert_co_recalled`, `engram_decay_pass` (batch), `engram_dream_cycle` (SQL-side entity co-occurrence)
- RLS policies with `auth.uid()` for user isolation (not just enabled — actual policies)
- `schema_migrations` table with content checksums
- Migration scripts from current schema (004-007)

**Connection note**: Use pgbouncer transaction mode (port 6543) for the storage client to allow connection multiplexing during concurrent recall + reconsolidation.

---

## 9. Intelligence Adapter Interface

The intelligence adapter provides optional AI capabilities. When absent, the system falls back to heuristics.

```typescript
interface IntelligenceAdapter {
  /** Generate embedding vector for text. */
  embed?(text: string): Promise<number[]>

  /** Batch embed multiple texts. */
  embedBatch?(texts: string[]): Promise<number[][]>

  /** Embedding dimensions (for storage schema). */
  dimensions?(): number

  /** LLM-powered summarization. */
  summarize?(content: string, opts: SummarizeOptions): Promise<SummaryResult>

  /** LLM-powered knowledge extraction. */
  extractKnowledge?(content: string): Promise<KnowledgeCandidate[]>

  /** LLM-powered intent classification. */
  classifyIntent?(message: string, context: string[]): Promise<IntentResult>
}

interface SummarizeOptions {
  mode: 'preserve_details' | 'bullet_points'
  targetTokens: number
  detailLevel?: 'high' | 'medium' | 'low'
}

interface SummaryResult {
  text: string
  topics: string[]
  entities: string[]
  decisions: string[]
}

interface KnowledgeCandidate {
  topic: string
  content: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
}
```

**Built-in heuristic fallbacks** (used when adapter methods are undefined):

| Capability | Heuristic Implementation |
|-----------|-------------------------|
| Search | FTS5 BM25 ranking (always available) |
| Summarization | TF-IDF sentence scoring + extractive summary |
| Knowledge extraction | Regex patterns (existing: preferences, decisions, entities) |
| Intent classification | Pattern matching (Section 5.1 heuristic patterns) |
| Embeddings | Not available in Level 0; search uses BM25 only |

### 9.1 OpenAI Adapter (@engram-mem/openai)

```typescript
import { openaiIntelligence } from '@engram-mem/openai'

const intelligence = openaiIntelligence({
  apiKey: process.env.OPENAI_API_KEY,
  embeddingModel: 'text-embedding-3-small',    // default
  embeddingDimensions: 768,                     // default
  summarizationModel: 'gpt-4o-mini',           // default
  intentAnalysis: false,                         // opt-in
})
```

Wraps OpenAI's embedding and chat completion APIs with circuit breaker + timeout + retry (existing resilience code).

---

## 10. OpenClaw Adapter (@engram-mem/openclaw)

Thin wrapper that maps OpenClaw's ContextEngine lifecycle to Engram's API.

```typescript
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { createMemory } from '@engram-mem/core'

export default definePluginEntry({
  id: 'engram',
  name: 'Engram Cognitive Memory',

  register(api) {
    const memory = createMemory({
      storage: resolveStorage(api.config),
      intelligence: resolveIntelligence(api.config),
      consolidation: { schedule: 'auto' },
    })

    api.registerContextEngine('engram', () => ({
      info: { id: 'engram', name: 'Engram', ownsCompaction: true },

      async bootstrap() {
        // Restore sensory buffer from last session
      },

      async ingest({ sessionId, message }) {
        await memory.ingest({ ...message, sessionId })
      },

      async ingestBatch({ sessionId, messages }) {
        await memory.ingestBatch(messages.map(m => ({ ...m, sessionId })))
      },

      async assemble({ messages, tokenBudget, prompt }) {
        const query = extractQuery(messages, prompt)
        const result = await memory.recall(query, { tokenBudget })
        return {
          messages,
          estimatedTokens: result.estimatedTokens,
          systemPromptAddition: result.formatted,
        }
      },

      async compact({ sessionId }) {
        await memory.consolidate('light')
      },

      async afterTurn(turn) {
        // Background: update priming, check consolidation schedule
      },

      async prepareSubagentSpawn(parentContext) {
        // Slice relevant memories for sub-agent context
      },

      async dispose() {
        await memory.dispose()
      },
    }))

    // Register agent tools
    api.registerTool(createSearchTool(memory))
    api.registerTool(createExpandTool(memory))
    api.registerTool(createStatsTool(memory))
    api.registerTool(createForgetTool(memory))
  },
})
```

**Tools registered**:

| Tool | Description | Access |
|------|------------|--------|
| `engram_search` | Deep search across all memory systems with intent analysis | All agents |
| `engram_expand` | Drill into digest to retrieve original episodes | Sub-agents only (token control) |
| `engram_stats` | Memory counts, hierarchy depth, association density | All agents |
| `engram_forget` | Deprioritize memories by topic (preview + confirm) | Main agent only |

---

## 11. Resilience

Carried forward from the existing codebase and enhanced:

### Circuit Breakers

Separate breakers per external service (fixing audit H5):

| Breaker | Threshold | Cooldown | Protects |
|---------|----------|---------|----------|
| Storage (retrieval) | 5 failures | 30s | Read queries |
| Storage (write) | 10 failures | 60s | Inserts/updates |
| Embedding API | 5 failures | 30s | OpenAI embeddings |
| Summarization API | 3 failures | 60s | OpenAI chat completions |

### Timeouts

| Operation | Timeout | Rationale |
|-----------|---------|-----------|
| Recall (total) | 2000ms | Must not block response path |
| Single tier search | 500ms | Per-tier cap within recall budget |
| Embedding (retrieval) | 500ms | Skip if slow, fall back to BM25 |
| Embedding (storage) | 30s | Background, don't lose data |
| Summarization | 60s | Background consolidation |
| Association walk | 200ms | Supplement, not critical path |

### Graceful Degradation

| Failure | Behavior |
|---------|----------|
| Embedding API down | Fall back to BM25 keyword search |
| Summarization API down | Use heuristic extractive summarizer (Level 3 escalation) |
| Storage read timeout | Return empty results, log warning |
| Storage write failure | Queue in write buffer with exponential backoff |
| Association walk timeout | Return recall results without associations |
| All external services down | Full heuristic mode — BM25 search, extractive summaries, regex extraction |

---

## 12. Migration Path from Current Codebase

The existing openclaw-memory codebase contains substantial working code that maps directly to Engram's architecture.

### Code Reuse Map

| Existing File | Maps To | Changes Needed |
|--------------|---------|---------------|
| `src/tiers/episodes.ts` | `core/systems/episodic.ts` | Add salience, accessCount, lossless consolidation. Extract StorageAdapter. |
| `src/tiers/digests.ts` | `core/systems/` (used by consolidation) | Add hierarchy level, sourceDigestIds. Extract StorageAdapter. |
| `src/tiers/knowledge.ts` | `core/systems/semantic.ts` | Add decay, reconsolidation, supersession tracking. Extract StorageAdapter. |
| `src/tiers/working-memory.ts` | `core/systems/sensory-buffer.ts` | Add priming, tick(), intent tracking. |
| `src/tiers/summarizer.ts` | `core/consolidation/` + `openai/summarizer.ts` | Split: heuristic fallback stays in core, LLM goes to openai adapter. |
| `src/tiers/knowledge-extractor.ts` | `core/consolidation/deep-sleep.ts` | Add procedural extraction patterns. Keep regex patterns. |
| `src/retrieval/gate.ts` | `core/intent/analyzer.ts` | Subsume into intent analyzer (gate's skip/trigger patterns become intent classification). |
| `src/retrieval/tier-router.ts` | `core/intent/analyzer.ts` | Subsume into intent strategy (router's tier selection becomes per-intent strategy). |
| `src/utils/circuit-breaker.ts` | `core/resilience/circuit-breaker.ts` | Direct port. |
| `src/utils/timeout.ts` | `core/resilience/timeout.ts` | Fix timeouts (audit H1/H2). |
| `src/utils/embeddings.ts` | `openai/embeddings.ts` | Move to openai adapter. Add retry (audit H4). |
| `src/utils/deduplicator.ts` | `core/consolidation/deep-sleep.ts` | Inline into deep sleep cycle. |
| `src/utils/entity-extractor.ts` | `core/systems/episodic.ts` | Use during ingestion for entity extraction. |
| `src/utils/batch-embedder.ts` | `openai/embeddings.ts` | Move to openai adapter, wire into batch operations. |
| `src/ingestion/write-buffer.ts` | `core/resilience/write-buffer.ts` | Direct port. |
| `src/ingestion/async-ingest.ts` | `core/memory.ts` | Inline into Memory.ingest(). |
| `src/ingestion/compaction-handler.ts` | `openclaw/plugin-entry.ts` | Use in OpenClaw compact() hook. |
| `src/cron/daily-summarizer.ts` | `core/consolidation/light-sleep.ts` | Rewrite with salience-weighting. |
| `src/cron/weekly-promoter.ts` | `core/consolidation/deep-sleep.ts` | Add procedural extraction. |
| `src/cron/cleanup.ts` | `core/consolidation/decay-pass.ts` | Rewrite as Ebbinghaus decay. |
| `src/plugin-entry.ts` | `openclaw/plugin-entry.ts` | Thin wrapper calling Memory API. |

### New Code Required

| Component | Effort | Description |
|-----------|--------|-------------|
| `core/systems/procedural.ts` | Medium | New memory system with trigger matching |
| `core/systems/associative.ts` | High | Graph operations, edge walk, co-recall tracking |
| `core/retrieval/association-walk.ts` | Medium | BFS/DFS edge traversal with strength filtering |
| `core/retrieval/priming.ts` | Low | Topic boost injection into sensory buffer |
| `core/retrieval/reconsolidation.ts` | Low | Access counting + confidence boost |
| `core/consolidation/dream-cycle.ts` | Medium | Entity-based association discovery |
| `core/intent/salience.ts` | Low | Regex-based salience scoring |
| `sqlite/adapter.ts` | High | Full StorageAdapter over better-sqlite3 + FTS5 |
| `sqlite/migrations.ts` | Medium | Schema creation + FTS5 triggers |
| `supabase/adapter.ts` | Medium | Refactor existing Supabase code into adapter |
| Monorepo setup | Low | Turborepo config, package boundaries |

### Audit Fixes (Integrated)

| Audit Item | Resolution |
|------------|-----------|
| C1: Dimension mismatch | IntelligenceAdapter.dimensions() drives schema. SQLite adapter stores BLOB. |
| C2: RLS without policies | Supabase adapter includes actual policies in migrations. |
| C3: 70% dead code | All components wired into Memory lifecycle. Nothing disconnected. |
| H1: 200ms retrieval timeout | Increased to 500ms per tier, 2000ms total. |
| H2: Unused EMBEDDING timeout | Applied correctly: 500ms retrieval, 30s storage. |
| H3: memory_forget unpredictable | Preview shows content, not just count. Threshold param added. |
| H4: No retry for embeddings | OpenAI adapter includes exponential backoff. |
| H5: Single circuit breaker | Separate breakers per service. |
| M1: Sequential embedding | Batch embedder wired into ingest pipeline. |
| M5: patternCounts not persisted | Observation count stored in procedural memory table. |

---

## 13. Success Criteria

### Functional

- [ ] `createMemory()` with zero arguments produces a working memory engine (SQLite + BM25)
- [ ] `memory.ingest()` stores episodes with salience scoring and entity extraction
- [ ] `memory.recall()` returns intent-analyzed, association-walked, primed results
- [ ] `memory.consolidate('light')` creates salience-weighted digests from episodes
- [ ] `memory.consolidate('deep')` extracts semantic + procedural memory from digests
- [ ] `memory.consolidate('dream')` discovers and creates associations between memories
- [ ] `memory.consolidate('decay')` decays unaccessed memories and prunes weak edges
- [ ] `memory.expand()` drills into digests to retrieve original episodes (lossless)
- [ ] Procedural memories auto-recall when intent matches their trigger
- [ ] Association walk finds contextually related memories across tiers
- [ ] Priming boosts related topics in subsequent recalls within the same session
- [ ] Reconsolidation strengthens frequently-accessed memories
- [ ] All operations degrade gracefully when external services are unavailable
- [ ] OpenClaw adapter passes all ContextEngine lifecycle hooks correctly

### Non-Functional

- [ ] Recall latency < 2000ms (p95) with SQLite, < 500ms with Supabase
- [ ] Ingestion never blocks the response path (fire-and-forget)
- [ ] Zero API keys required for Level 0 operation
- [ ] Memory scales to 100K+ episodes without degradation (hierarchical digests)
- [ ] All existing tests pass after migration
- [ ] New test coverage for all five memory systems, intent analyzer, consolidation cycles

---

## 14. What This Design Intentionally Excludes

| Feature | Reason | Revisit When |
|---------|--------|-------------|
| Large file handling | Not differentiating. Can be added as middleware. | User demand |
| Operator-level recursion (llm_map, agentic_map) | Complex, niche. LCM already owns this. | v2.0 if needed |
| Multi-user / team memory | Architectural complexity. Focus on single-agent first. | v2.0 |
| Custom edge types | The 8 built-in types cover known use cases. | User request |
| Real-time sync between agents | Supabase adapter enables this implicitly via shared DB. | Explicit demand |
| Streaming recall | Recall is fast enough (<2s). Streaming adds complexity. | Latency issues |

---

## 15. Naming Decision

**Name**: `engram`

**Reason**: An engram is the neuroscience term for the physical trace a memory leaves in a substrate — the hypothetical means by which memories are stored. It is the exact concept this library implements: persistent, strengthening, decaying traces of experience in a computational substrate.

**Package names**: `@engram-mem/core`, `@engram-mem/sqlite`, `@engram-mem/supabase`, `@engram-mem/openai`, `@engram-mem/openclaw`

---

## 16. Audit Resolutions

Four independent audits were conducted on this spec: Architecture Review, Critical Code Audit, Performance Analysis, and Database Architecture Audit. This section documents every finding and its resolution. All changes below are integrated into the spec above or the referenced schema files.

### 16.1 Critical Fixes (Must-Have for v1.0)

| # | Finding | Source | Resolution |
|---|---------|--------|------------|
| C1 | Architecture is a ~50% rewrite, not 70% migration | Arch, Code | Acknowledged. Section 12 updated: algorithm-level code ports (regex patterns, circuit breaker, dedup), structural code is rewritten. Plan accordingly. |
| C2 | StorageAdapter too broad (34 methods) | Arch | Split into composable per-system interfaces (Section 8.0). Adapters can implement incrementally matching Level 0-3 upgrade path. |
| C3 | Polymorphic association FK gap | DB | Added `memories` table as universal ID pool. All tables FK to it. Associations get real referential integrity. (Section 8.1, DB audit Section 7) |
| C4 | Fire-and-forget ingestion drops messages | Code | Wire existing `WriteBuffer` class into ingestion path. Episodes must be durably queued before returning success. |
| C5 | Embedding dimension mismatch (1536 vs 768) | DB, Prior audit | `IntelligenceAdapter.dimensions()` drives schema. SQLite uses BLOB (dimension-agnostic). PostgreSQL schema uses configurable dimension. |
| C6 | RLS enabled without policies | DB, Prior audit | Full RLS policies included in PostgreSQL schema (DB audit Section 7b) using `auth.uid()` for user isolation. |
| C7 | `memory_forget` does hard DELETE | Code | Rewritten: `forget()` sets confidence to 0.05 (floor) and marks `metadata.forgotten = true`. Never deletes. Lossless. |
| C8 | No SQLite WAL mode | DB, Perf | Required pragmas defined in Section 8.2. Set at connection open. Without WAL, concurrent consolidation + recall deadlocks. |
| C9 | FTS5 sync triggers absent | DB | All 12 triggers (INSERT/UPDATE/DELETE × 4 tables) included in SQLite schema (DB audit Section 7a). |
| C10 | No schema migration system | Arch, DB | SQLite: `PRAGMA user_version`. PostgreSQL: `schema_migrations` table with checksums. Both in DB audit Section 5. |

### 16.2 Algorithmic Fixes

| # | Finding | Source | Resolution |
|---|---------|--------|------------|
| A1 | Association walk does N+1 serial `getById` calls | Perf, Code | Replaced with recursive CTE (single SQL query). SQLite and PostgreSQL versions in DB audit Section 3.2. `AssociationStorage.walk()` replaces per-edge queries. |
| A2 | Dream cycle O(n^2) existence checks | Perf, Code | Moved to SQL-side entity co-occurrence with NOT EXISTS anti-join. `AssociationStorage.discoverTopicalEdges()` in DB audit Section 3.3. Single query replaces 1M+ round-trips. |
| A3 | Decay pass loops individual UPDATEs | Perf, DB | Replaced with batch SQL: `SemanticStorage.batchDecay()` and `ProceduralStorage.batchDecay()`. Single UPDATE per tier per pass. DB audit Section 3.4. |
| A4 | Query embedding computed 4x (once per tier) | Perf | `SearchOptions.embedding` accepts pre-computed vector. Recall Stage 1 embeds once, passes to all tier searches. |
| A5 | Priming feedback loop — accessBoost is permanent and monotonically increasing | Code | Fixed: `accessBoost = min(0.1, accessCount * 0.01)` is now capped at 0.1 absolute. Combined with priming cap of 0.3 (reduced from 0.75), maximum non-similarity boost is 0.4. Prevents irrelevant memories from dominating. |
| A6 | Reconsolidation: separate `recordAccess` + `boostConfidence` writes | Perf | Combined into single `recordAccessAndBoost()` method. One UPDATE per semantic memory per recall instead of two. |
| A7 | co_recalled edges created for all result pairs | Perf, DB | Capped to top-5 recalled memories only. Maximum 10 edge upserts per recall (down from 50). Added per-memory edge cap: skip if source already has >100 co_recalled edges. |

### 16.3 Schema Fixes

| # | Finding | Source | Resolution |
|---|---------|--------|------------|
| S1 | SQLite timestamps as TEXT | DB | All timestamps use `REAL` (Julian Day numbers) via `julianday('now')`. Monotonically comparable, arithmetic-friendly. |
| S2 | 23 missing NOT NULL constraints | DB | All columns with defaults are now NOT NULL. See DB audit Section 1.5 for full list. |
| S3 | Missing CHECK constraints on enums | DB | Added: `source_type`, `target_type`, `edge_type`, `level`, `decay_rate`, `strength` all bounded. |
| S4 | UUID v4 B-tree fragmentation | DB | Use UUID v7 (time-ordered) for all IDs. Monotonic insert performance. |
| S5 | FTS5 indexes JSON brackets from entities | DB | Added generated column `entities_fts` that strips JSON punctuation. FTS5 indexes the cleaned text. |
| S6 | FTS5 tokenizer not configured | DB | `tokenize="porter unicode61 remove_diacritics 1"` with `prefix="2 3"` for stemming + prefix search. |
| S7 | Wrong/useless indexes | DB | Dropped: `idx_assoc_strength` (standalone), `idx_digests_level`. Replaced ivfflat with HNSW. Added 15+ composite and partial indexes. |
| S8 | No consolidation idempotency | DB, Arch | Added `consolidation_runs` table + `episode_batch_hash UNIQUE` on digests. Crash-safe resumption via unique constraint. |
| S9 | `getById` returns `any` | Arch | Returns `TypedMemory` discriminated union. Type-safe through entire retrieval pipeline. |
| S10 | PostgreSQL ivfflat wrong for any scale | DB | Replaced with HNSW (`m=16, ef_construction=64`). Partial indexes: `WHERE embedding IS NOT NULL`. |

### 16.4 Architectural Fixes

| # | Finding | Source | Resolution |
|---|---------|--------|------------|
| AR1 | Associative Network is a "god subsystem" | Arch | Centralized into `AssociationManager` class in `core/systems/association-manager.ts`. Owns all edge creation policy. Storage adapter handles CRUD; manager handles when/how/why. |
| AR2 | Procedural vs Semantic extraction overlap | Arch | Single extraction pass with disambiguation rule: if pattern implies a trigger/context ("before X", "when doing Y"), it is procedural. If standalone fact/preference ("I prefer X"), it is semantic. Never extract same content into both. |
| AR3 | Digest treated as first-class in adapter but called "not a memory system" | Arch | Kept as separate interface (`DigestStorage`) for practical reasons — digests are queried during recall. But consolidation engine owns their lifecycle, not the public API. |
| AR4 | Missing session management for standalone API | Arch | Added `memory.session(sessionId?)` returning `SessionHandle`. Auto-generates UUIDv7 session IDs when omitted. |
| AR5 | Working memory persists as digest, polluting search | Code | Moved to dedicated `sensory_snapshots` table. No longer stored as digests. |
| AR6 | No token estimation function | Arch | Use `Math.ceil(text.length / 4)` approximation for v1.0. Configurable via `createMemory({ tokenizer: (text) => number })`. |

### 16.5 Security & Integrity

| # | Finding | Source | Resolution |
|---|---------|--------|------------|
| SEC1 | PII flows unfiltered to OpenAI embeddings | Code | Document in README: all message content is sent to embedding provider. Add `intelligence.redact?: (text: string) => string` hook for PII stripping. Not implemented in v1.0 core but interface supports it. |
| SEC2 | FTS5 injection risk | DB | Sanitize FTS5 queries: escape `AND`, `OR`, `NOT`, `NEAR`, column filter syntax. Use parameterized queries with `MATCH ?` not string interpolation. |
| SEC3 | `derives_from` edges exempt from pruning | Code | Added: decay pass skips edges with `edge_type = 'derives_from'` (provenance must be permanent). |
| SEC4 | Circuit breaker half-open has no concurrency control | Code | Add mutex flag: only one request proceeds in half-open state. Others fail fast. |

### 16.6 Performance Characteristics

Based on the performance audit, expected latency by scale:

| Scale | Recall p50 (SQLite) | Recall p95 (SQLite) | Recall p50 (Supabase) | Recall p95 (Supabase) |
|-------|--------------------|--------------------|----------------------|----------------------|
| 1K memories | ~15ms | ~40ms | ~120ms | ~200ms |
| 10K memories | ~30ms | ~80ms | ~200ms | ~350ms |
| 100K memories | ~60ms | ~150ms | ~400ms | ~800ms |
| 1M memories | ~100ms | ~300ms | ~720ms | ~2000ms |

SQLite is ~10x faster on association walk due to no network latency. Supabase's p95 at 1M approaches the 2000ms budget — HNSW indexes and recursive CTE walks (replacing serial getById) are required to stay within budget.

**Write amplification per recall**: ~15 writes (down from 55 after audit fixes). Breakdown: ~10 `recordAccess` updates + ~5 `co_recalled` upserts (capped). Sustainable at 10+ recalls/second on SQLite, 5 recalls/second on Supabase free tier.

### 16.7 Maintenance Operations

| Operation | Frequency | What It Does |
|-----------|-----------|-------------|
| FTS5 optimize | Monthly (in decay pass) | `INSERT INTO *_fts(*_fts) VALUES('optimize')` for all 4 FTS tables |
| SQLite incremental vacuum | Monthly (in decay pass) | `PRAGMA incremental_vacuum(100)` reclaims pages from pruned edges |
| HNSW reindex | Never (automatic) | HNSW indexes are maintained incrementally on insert |
| Consolidation run cleanup | Monthly | Delete `consolidation_runs` older than 90 days with status `completed` |

---

## 17. Supporting Documents

| Document | Purpose |
|----------|---------|
| `docs/engram-db-audit.md` | Complete database architecture audit with production-ready SQLite and PostgreSQL schemas, query patterns, RPC functions, RLS policies, and migration scripts |
| `docs/lcm-comparison.md` | Feature-by-feature comparison with lossless-claw (LCM) |
| `docs/audit-report.md` | Original code audit of the v0.1 codebase |
| `docs/implementation-plan.md` | Prior implementation plan (superseded by this design) |

---

*End of Design Document*
