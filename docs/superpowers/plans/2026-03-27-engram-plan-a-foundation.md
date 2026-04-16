# Engram Plan A: Foundation — Monorepo + Types + SQLite Adapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the Engram monorepo with all TypeScript types, the composable StorageAdapter interface, and a fully functional SQLite adapter with FTS5 search, producing a testable storage layer that Plan B builds on.

**Architecture:** Turborepo monorepo with `@engram-mem/core` (types + interfaces) and `@engram-mem/sqlite` (better-sqlite3 + FTS5). All types defined first, then SQLite schema created with production-ready migrations, then each storage sub-interface implemented with TDD.

**Tech Stack:** TypeScript 5.5+, Turborepo, Vitest, better-sqlite3, uuid (v7)

**Reference docs:**
- Design spec: `docs/engram-design.md`
- DB audit (schemas): `docs/engram-db-audit.md` Section 7a (SQLite) and Section 7b (PostgreSQL)
- Audit resolutions: `docs/engram-design.md` Section 16

---

## File Structure

```
engram/
├── package.json                          # Turborepo root
├── turbo.json                            # Pipeline config
├── tsconfig.base.json                    # Shared TS config
├── vitest.workspace.ts                   # Vitest workspace config
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  # Public exports
│   │   │   ├── types.ts                  # All TypeScript interfaces/types
│   │   │   ├── adapters/
│   │   │   │   ├── storage.ts            # StorageAdapter + sub-interfaces
│   │   │   │   └── intelligence.ts       # IntelligenceAdapter interface
│   │   │   └── utils/
│   │   │       ├── id.ts                 # UUID v7 generation
│   │   │       └── tokens.ts             # Token estimation
│   │   └── test/
│   │       └── types.test.ts             # Type-level smoke tests
│   └── sqlite/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts                  # sqliteAdapter() factory export
│       │   ├── adapter.ts                # Full StorageAdapter implementation
│       │   ├── migrations.ts             # Schema creation + versioning
│       │   ├── episodes.ts               # EpisodeStorage implementation
│       │   ├── digests.ts                # DigestStorage implementation
│       │   ├── semantic.ts               # SemanticStorage implementation
│       │   ├── procedural.ts             # ProceduralStorage implementation
│       │   ├── associations.ts           # AssociationStorage implementation
│       │   └── search.ts                 # FTS5 query helpers + sanitization
│       └── test/
│           ├── helpers.ts                # Shared test setup (in-memory DB)
│           ├── migrations.test.ts        # Schema creation tests
│           ├── episodes.test.ts          # Episode CRUD + search
│           ├── digests.test.ts           # Digest CRUD + search
│           ├── semantic.test.ts          # Semantic CRUD + decay + supersession
│           ├── procedural.test.ts        # Procedural CRUD + trigger search
│           ├── associations.test.ts      # Edge CRUD + graph walk + dream cycle
│           └── adapter.test.ts           # Integration: full adapter lifecycle
```

---

## Task 1: Bootstrap Monorepo

**Files:**
- Create: `package.json` (root)
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/sqlite/package.json`
- Create: `packages/sqlite/tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Initialize root package.json**

```json
{
  "name": "engram",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "clean": "turbo run clean"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Save to `package.json` at the repo root. Also create `turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

- [ ] **Step 2: Create shared TypeScript config**

Save to `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

- [ ] **Step 3: Create @engram-mem/core package scaffold**

Save to `packages/core/package.json`:

```json
{
  "name": "@engram-mem/core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "uuid": "^11.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Save to `packages/core/tsconfig.json`:

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

- [ ] **Step 4: Create @engram-mem/sqlite package scaffold**

Save to `packages/sqlite/package.json`:

```json
{
  "name": "@engram-mem/sqlite",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@engram-mem/core": "workspace:*",
    "better-sqlite3": "^11.0.0",
    "uuid": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Save to `packages/sqlite/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

- [ ] **Step 5: Create vitest workspace config**

Save to `vitest.workspace.ts`:

```typescript
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core',
  'packages/sqlite',
])
```

- [ ] **Step 6: Create .gitignore**

Save to `.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.turbo/
```

- [ ] **Step 7: Install dependencies and verify**

Run: `npm install`
Expected: Installs turborepo, typescript, vitest, better-sqlite3, uuid

Run: `npx turbo typecheck`
Expected: Both packages typecheck (no source files yet, so trivially passes)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: bootstrap engram monorepo with core and sqlite packages"
```

---

## Task 2: Define All Core Types

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/utils/id.ts`
- Create: `packages/core/src/utils/tokens.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/test/types.test.ts`

- [ ] **Step 1: Write the type smoke test**

Save to `packages/core/test/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type {
  Episode,
  Digest,
  SemanticMemory,
  ProceduralMemory,
  Association,
  MemoryType,
  EdgeType,
  IntentType,
  IntentResult,
  RetrievalStrategy,
  TierPriority,
  RecallResult,
  RetrievedMemory,
  WorkingMemoryItem,
  PrimedTopic,
  SensorySnapshot,
  SearchOptions,
  SearchResult,
  TypedMemory,
  WalkResult,
  DiscoveredEdge,
  Message,
} from '../src/types.js'
import { generateId } from '../src/utils/id.js'
import { estimateTokens } from '../src/utils/tokens.js'

describe('Core types', () => {
  it('generates UUID v7 ids that are time-ordered', () => {
    const id1 = generateId()
    const id2 = generateId()
    expect(id1).toMatch(/^[0-9a-f-]{36}$/)
    expect(id2).toMatch(/^[0-9a-f-]{36}$/)
    // UUID v7 is time-ordered: id2 >= id1 lexicographically
    expect(id2 >= id1).toBe(true)
  })

  it('estimates tokens roughly as length/4', () => {
    expect(estimateTokens('hello world')).toBe(3) // ceil(11/4) = 3
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  it('Episode type has all required fields', () => {
    const episode: Episode = {
      id: generateId(),
      sessionId: 'session-1',
      role: 'user',
      content: 'hello',
      salience: 0.5,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null,
      entities: [],
      metadata: {},
      createdAt: new Date(),
    }
    expect(episode.role).toBe('user')
    expect(episode.salience).toBe(0.5)
  })

  it('TypedMemory discriminated union narrows correctly', () => {
    const mem: TypedMemory = {
      type: 'episode',
      data: {
        id: generateId(),
        sessionId: 's1',
        role: 'user',
        content: 'test',
        salience: 0.3,
        accessCount: 0,
        lastAccessed: null,
        consolidatedAt: null,
        embedding: null,
        entities: [],
        metadata: {},
        createdAt: new Date(),
      },
    }
    if (mem.type === 'episode') {
      expect(mem.data.sessionId).toBe('s1')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement types.ts**

Save to `packages/core/src/types.ts`:

```typescript
// === Memory Types ===

export type MemoryType = 'episode' | 'digest' | 'semantic' | 'procedural'

export type EdgeType =
  | 'temporal'
  | 'causal'
  | 'topical'
  | 'supports'
  | 'contradicts'
  | 'elaborates'
  | 'derives_from'
  | 'co_recalled'

export type IntentType =
  | 'TASK_START'
  | 'TASK_CONTINUE'
  | 'QUESTION'
  | 'RECALL_EXPLICIT'
  | 'DEBUGGING'
  | 'PREFERENCE'
  | 'REVIEW'
  | 'CONTEXT_SWITCH'
  | 'EMOTIONAL'
  | 'SOCIAL'
  | 'INFORMATIONAL'

export interface Message {
  sessionId?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: Record<string, unknown>
}

export interface Episode {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  salience: number
  accessCount: number
  lastAccessed: Date | null
  consolidatedAt: Date | null
  embedding: number[] | null
  entities: string[]
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface Digest {
  id: string
  sessionId: string
  summary: string
  keyTopics: string[]
  sourceEpisodeIds: string[]
  sourceDigestIds: string[]
  level: number
  embedding: number[] | null
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface SemanticMemory {
  id: string
  topic: string
  content: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
  accessCount: number
  lastAccessed: Date | null
  decayRate: number
  supersedes: string | null
  supersededBy: string | null
  embedding: number[] | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface ProceduralMemory {
  id: string
  category: 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention'
  trigger: string
  procedure: string
  confidence: number
  observationCount: number
  lastObserved: Date
  firstObserved: Date
  accessCount: number
  lastAccessed: Date | null
  decayRate: number
  sourceEpisodeIds: string[]
  embedding: number[] | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface Association {
  id: string
  sourceId: string
  sourceType: MemoryType
  targetId: string
  targetType: MemoryType
  edgeType: EdgeType
  strength: number
  lastActivated: Date | null
  metadata: Record<string, unknown>
  createdAt: Date
}

// === Sensory Buffer Types ===

export interface WorkingMemoryItem {
  key: string
  value: string
  category: 'entity' | 'topic' | 'decision' | 'preference' | 'context'
  importance: number
  timestamp: number
}

export interface PrimedTopic {
  topic: string
  boost: number
  decayRate: number
  source: string
  turnsRemaining: number
}

export interface SensorySnapshot {
  sessionId: string
  items: WorkingMemoryItem[]
  primedTopics: PrimedTopic[]
  savedAt: Date
}

// === Intent & Retrieval Types ===

export interface IntentResult {
  type: IntentType
  confidence: number
  strategy: RetrievalStrategy
  extractedCues: string[]
  salience: number
}

export interface RetrievalStrategy {
  shouldRecall: boolean
  tiers: TierPriority[]
  queryTransform: string | null
  maxResults: number
  minRelevance: number
  includeAssociations: boolean
  associationHops: number
  boostProcedural: boolean
}

export interface TierPriority {
  tier: 'episode' | 'digest' | 'semantic' | 'procedural'
  weight: number
  recencyBias: number
}

export interface RecallResult {
  memories: RetrievedMemory[]
  associations: RetrievedMemory[]
  intent: IntentResult
  primed: string[]
  estimatedTokens: number
  formatted: string
}

export interface RetrievedMemory {
  id: string
  type: MemoryType
  content: string
  relevance: number
  source: 'recall' | 'association' | 'priming'
  metadata: Record<string, unknown>
}

// === Storage Types ===

export interface SearchOptions {
  limit?: number
  minScore?: number
  sessionId?: string
  embedding?: number[]
}

export interface SearchResult<T> {
  item: T
  similarity: number
}

export type TypedMemory =
  | { type: 'episode'; data: Episode }
  | { type: 'digest'; data: Digest }
  | { type: 'semantic'; data: SemanticMemory }
  | { type: 'procedural'; data: ProceduralMemory }

export interface WalkResult {
  memoryId: string
  memoryType: MemoryType
  depth: number
  pathStrength: number
}

export interface DiscoveredEdge {
  sourceId: string
  sourceType: MemoryType
  targetId: string
  targetType: MemoryType
  sharedEntity: string
  entityCount: number
}

// === Consolidation Types ===

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
}

// === Config Types ===

export interface EngineConfig {
  consolidation?: {
    schedule: 'auto' | 'manual'
    lightSleep?: { intervalMs?: number; batchSize?: number; minEpisodes?: number }
    deepSleep?: { intervalMs?: number; minDigests?: number }
    dreamCycle?: { intervalMs?: number; maxNewAssociations?: number }
    decayPass?: {
      intervalMs?: number
      semanticDecayRate?: number
      proceduralDecayRate?: number
      edgePruneThreshold?: number
    }
  }
  tokenizer?: (text: string) => number
}
```

- [ ] **Step 4: Implement id.ts and tokens.ts**

Save to `packages/core/src/utils/id.ts`:

```typescript
import { v7 as uuidv7 } from 'uuid'

/** Generate a time-ordered UUID v7. Monotonically increasing within ms boundaries. */
export function generateId(): string {
  return uuidv7()
}
```

Save to `packages/core/src/utils/tokens.ts`:

```typescript
/** Estimate token count using ~4 chars per token approximation. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}
```

- [ ] **Step 5: Create index.ts with public exports**

Save to `packages/core/src/index.ts`:

```typescript
export * from './types.js'
export { generateId } from './utils/id.js'
export { estimateTokens } from './utils/tokens.js'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/core && npx vitest run`
Expected: 4 tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/
git commit -m "feat(core): define all Engram TypeScript types and utilities"
```

---

## Task 3: Define Storage Adapter Interfaces

**Files:**
- Create: `packages/core/src/adapters/storage.ts`
- Create: `packages/core/src/adapters/intelligence.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the storage adapter interface**

Save to `packages/core/src/adapters/storage.ts`:

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

export interface EpisodeStorage {
  insert(episode: Omit<Episode, 'id' | 'createdAt'>): Promise<Episode>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<Episode>[]>
  getByIds(ids: string[]): Promise<Episode[]>
  getBySession(sessionId: string, opts?: { since?: Date }): Promise<Episode[]>
  getUnconsolidated(sessionId: string): Promise<Episode[]>
  getUnconsolidatedSessions(): Promise<string[]>
  markConsolidated(ids: string[]): Promise<void>
  recordAccess(id: string): Promise<void>
}

export interface DigestStorage {
  insert(digest: Omit<Digest, 'id' | 'createdAt'>): Promise<Digest>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<Digest>[]>
  getBySession(sessionId: string): Promise<Digest[]>
  getRecent(days: number): Promise<Digest[]>
  getCountBySession(): Promise<Record<string, number>>
}

export interface SemanticStorage {
  insert(
    memory: Omit<SemanticMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<SemanticMemory>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<SemanticMemory>[]>
  getUnaccessed(days: number): Promise<SemanticMemory[]>
  recordAccessAndBoost(id: string, confidenceBoost: number): Promise<void>
  markSuperseded(id: string, supersededBy: string): Promise<void>
  batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number>
}

export interface ProceduralStorage {
  insert(
    memory: Omit<ProceduralMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<ProceduralMemory>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]>
  searchByTrigger(activity: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]>
  recordAccess(id: string): Promise<void>
  incrementObservation(id: string): Promise<void>
  batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number>
}

export interface AssociationStorage {
  insert(association: Omit<Association, 'id' | 'createdAt'>): Promise<Association>
  walk(
    seedIds: string[],
    opts?: { maxHops?: number; minStrength?: number; types?: EdgeType[] }
  ): Promise<WalkResult[]>
  upsertCoRecalled(
    sourceId: string,
    sourceType: MemoryType,
    targetId: string,
    targetType: MemoryType
  ): Promise<void>
  pruneWeak(opts: { maxStrength: number; olderThanDays: number }): Promise<number>
  discoverTopicalEdges(opts: {
    daysLookback: number
    maxNew: number
  }): Promise<DiscoveredEdge[]>
}

export interface StorageAdapter {
  initialize(): Promise<void>
  dispose(): Promise<void>
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

- [ ] **Step 2: Write the intelligence adapter interface**

Save to `packages/core/src/adapters/intelligence.ts`:

```typescript
export interface SummarizeOptions {
  mode: 'preserve_details' | 'bullet_points'
  targetTokens: number
  detailLevel?: 'high' | 'medium' | 'low'
}

export interface SummaryResult {
  text: string
  topics: string[]
  entities: string[]
  decisions: string[]
}

export interface KnowledgeCandidate {
  topic: string
  content: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
}

export interface IntelligenceAdapter {
  embed?(text: string): Promise<number[]>
  embedBatch?(texts: string[]): Promise<number[][]>
  dimensions?(): number
  summarize?(content: string, opts: SummarizeOptions): Promise<SummaryResult>
  extractKnowledge?(content: string): Promise<KnowledgeCandidate[]>
}
```

- [ ] **Step 3: Update index.ts with adapter exports**

Add to `packages/core/src/index.ts`:

```typescript
export * from './types.js'
export { generateId } from './utils/id.js'
export { estimateTokens } from './utils/tokens.js'
export type {
  StorageAdapter,
  EpisodeStorage,
  DigestStorage,
  SemanticStorage,
  ProceduralStorage,
  AssociationStorage,
} from './adapters/storage.js'
export type {
  IntelligenceAdapter,
  SummarizeOptions,
  SummaryResult,
  KnowledgeCandidate,
} from './adapters/intelligence.js'
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): define StorageAdapter and IntelligenceAdapter interfaces"
```

---

## Task 4: SQLite Migrations + Schema

**Files:**
- Create: `packages/sqlite/src/migrations.ts`
- Create: `packages/sqlite/src/search.ts`
- Create: `packages/sqlite/test/helpers.ts`
- Create: `packages/sqlite/test/migrations.test.ts`

- [ ] **Step 1: Write the migration test**

Save to `packages/sqlite/test/helpers.ts`:

```typescript
import Database from 'better-sqlite3'

/** Create an in-memory SQLite database for testing. */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('temp_store = MEMORY')
  return db
}
```

Save to `packages/sqlite/test/migrations.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations, getSchemaVersion } from '../src/migrations.js'

describe('SQLite migrations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  it('creates all tables on fresh database', () => {
    runMigrations(db)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .pluck()
      .all() as string[]

    expect(tables).toContain('memories')
    expect(tables).toContain('episodes')
    expect(tables).toContain('digests')
    expect(tables).toContain('semantic')
    expect(tables).toContain('procedural')
    expect(tables).toContain('associations')
    expect(tables).toContain('consolidation_runs')
    expect(tables).toContain('sensory_snapshots')
  })

  it('creates FTS5 virtual tables', () => {
    runMigrations(db)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'")
      .pluck()
      .all() as string[]

    expect(tables).toContain('episodes_fts')
    expect(tables).toContain('digests_fts')
    expect(tables).toContain('semantic_fts')
    expect(tables).toContain('procedural_fts')
  })

  it('sets schema version to 1', () => {
    runMigrations(db)
    expect(getSchemaVersion(db)).toBe(1)
  })

  it('is idempotent (running twice does not error)', () => {
    runMigrations(db)
    runMigrations(db)
    expect(getSchemaVersion(db)).toBe(1)
  })

  it('enforces foreign keys on memories table', () => {
    runMigrations(db)

    // Insert into memories first — should succeed
    db.prepare("INSERT INTO memories (id, type) VALUES ('test-id', 'episode')").run()

    // Insert into episodes referencing the memory — should succeed
    db.prepare(
      `INSERT INTO episodes (id, session_id, role, content) VALUES ('test-id', 's1', 'user', 'hello')`
    ).run()

    // Insert into episodes with non-existent memory ID — should fail
    expect(() => {
      db.prepare(
        `INSERT INTO episodes (id, session_id, role, content) VALUES ('bad-id', 's1', 'user', 'hello')`
      ).run()
    }).toThrow(/FOREIGN KEY/)
  })

  it('enforces CHECK constraints on episodes.role', () => {
    runMigrations(db)
    db.prepare("INSERT INTO memories (id, type) VALUES ('t1', 'episode')").run()

    expect(() => {
      db.prepare(
        `INSERT INTO episodes (id, session_id, role, content) VALUES ('t1', 's1', 'invalid', 'hello')`
      ).run()
    }).toThrow(/CHECK/)
  })

  it('enforces unique association pair constraint', () => {
    runMigrations(db)
    db.prepare("INSERT INTO memories (id, type) VALUES ('m1', 'episode')").run()
    db.prepare("INSERT INTO memories (id, type) VALUES ('m2', 'semantic')").run()

    const insertAssoc = db.prepare(`
      INSERT INTO associations (id, source_id, source_type, target_id, target_type, edge_type, strength)
      VALUES (?, 'm1', 'episode', 'm2', 'semantic', 'topical', 0.5)
    `)

    insertAssoc.run('a1')

    expect(() => {
      insertAssoc.run('a2') // same source_id, target_id, edge_type — should fail unique
    }).toThrow(/UNIQUE/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sqlite && npx vitest run`
Expected: FAIL — migrations module not found

- [ ] **Step 3: Implement migrations.ts**

Save to `packages/sqlite/src/migrations.ts`:

```typescript
import type Database from 'better-sqlite3'

const SCHEMA_V1 = `
-- Memory ID Pool (enables FK enforcement on polymorphic associations)
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT    NOT NULL PRIMARY KEY,
  type       TEXT    NOT NULL CHECK (type IN ('episode', 'digest', 'semantic', 'procedural')),
  created_at REAL    NOT NULL DEFAULT (julianday('now'))
);

-- Episodic Memory
CREATE TABLE IF NOT EXISTS episodes (
  id               TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  session_id       TEXT    NOT NULL,
  role             TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content          TEXT    NOT NULL,
  salience         REAL    NOT NULL DEFAULT 0.3 CHECK (salience >= 0.0 AND salience <= 1.0),
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed    REAL,
  consolidated_at  REAL,
  embedding        BLOB,
  entities_json    TEXT    NOT NULL DEFAULT '[]',
  entities_fts     TEXT    GENERATED ALWAYS AS (
                     replace(replace(replace(entities_json, '[', ''), ']', ''), '"', '')
                   ) VIRTUAL,
  metadata         TEXT    NOT NULL DEFAULT '{}',
  created_at       REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_episodes_session_salience ON episodes(session_id, salience DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_unconsolidated ON episodes(session_id, consolidated_at, salience DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_last_accessed ON episodes(last_accessed);

-- Digest Layer
CREATE TABLE IF NOT EXISTS digests (
  id                   TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  session_id           TEXT    NOT NULL,
  summary              TEXT    NOT NULL,
  key_topics           TEXT    NOT NULL DEFAULT '[]',
  source_episode_ids   TEXT    NOT NULL DEFAULT '[]',
  source_digest_ids    TEXT    NOT NULL DEFAULT '[]',
  level                INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0 AND level <= 10),
  embedding            BLOB,
  metadata             TEXT    NOT NULL DEFAULT '{}',
  created_at           REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_digests_session ON digests(session_id);
CREATE INDEX IF NOT EXISTS idx_digests_created ON digests(created_at DESC);

-- Semantic Memory
CREATE TABLE IF NOT EXISTS semantic (
  id                  TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  topic               TEXT    NOT NULL,
  content             TEXT    NOT NULL,
  confidence          REAL    NOT NULL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_digest_ids   TEXT    NOT NULL DEFAULT '[]',
  source_episode_ids  TEXT    NOT NULL DEFAULT '[]',
  access_count        INTEGER NOT NULL DEFAULT 0,
  last_accessed       REAL,
  decay_rate          REAL    NOT NULL DEFAULT 0.02 CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  supersedes          TEXT    REFERENCES memories(id),
  superseded_by       TEXT    REFERENCES memories(id),
  embedding           BLOB,
  metadata            TEXT    NOT NULL DEFAULT '{}',
  created_at          REAL    NOT NULL DEFAULT (julianday('now')),
  updated_at          REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_semantic_topic ON semantic(topic);
CREATE INDEX IF NOT EXISTS idx_semantic_confidence ON semantic(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_last_accessed ON semantic(last_accessed);
CREATE INDEX IF NOT EXISTS idx_semantic_created ON semantic(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_topic_confidence ON semantic(topic, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_supersedes ON semantic(supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_semantic_superseded_by ON semantic(superseded_by) WHERE superseded_by IS NOT NULL;

-- Procedural Memory
CREATE TABLE IF NOT EXISTS procedural (
  id                  TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  category            TEXT    NOT NULL CHECK (category IN ('workflow', 'preference', 'habit', 'pattern', 'convention')),
  trigger_text        TEXT    NOT NULL,
  procedure           TEXT    NOT NULL,
  confidence          REAL    NOT NULL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  observation_count   INTEGER NOT NULL DEFAULT 1,
  last_observed       REAL    NOT NULL DEFAULT (julianday('now')),
  first_observed      REAL    NOT NULL DEFAULT (julianday('now')),
  access_count        INTEGER NOT NULL DEFAULT 0,
  last_accessed       REAL,
  decay_rate          REAL    NOT NULL DEFAULT 0.01 CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  source_episode_ids  TEXT    NOT NULL DEFAULT '[]',
  embedding           BLOB,
  metadata            TEXT    NOT NULL DEFAULT '{}',
  created_at          REAL    NOT NULL DEFAULT (julianday('now')),
  updated_at          REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_procedural_category ON procedural(category);
CREATE INDEX IF NOT EXISTS idx_procedural_confidence ON procedural(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_procedural_last_accessed ON procedural(last_accessed);
CREATE INDEX IF NOT EXISTS idx_procedural_created ON procedural(created_at DESC);

-- Associative Network
CREATE TABLE IF NOT EXISTS associations (
  id              TEXT    NOT NULL PRIMARY KEY,
  source_id       TEXT    NOT NULL REFERENCES memories(id),
  source_type     TEXT    NOT NULL CHECK (source_type IN ('episode', 'digest', 'semantic', 'procedural')),
  target_id       TEXT    NOT NULL REFERENCES memories(id),
  target_type     TEXT    NOT NULL CHECK (target_type IN ('episode', 'digest', 'semantic', 'procedural')),
  edge_type       TEXT    NOT NULL CHECK (edge_type IN ('temporal', 'causal', 'topical', 'supports', 'contradicts', 'elaborates', 'derives_from', 'co_recalled')),
  strength        REAL    NOT NULL DEFAULT 0.3 CHECK (strength >= 0.0 AND strength <= 1.0),
  last_activated  REAL,
  metadata        TEXT    NOT NULL DEFAULT '{}',
  created_at      REAL    NOT NULL DEFAULT (julianday('now')),
  CONSTRAINT uq_association_pair UNIQUE (source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_assoc_source_strength ON associations(source_id, strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_target_strength ON associations(target_id, strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_prune ON associations(strength, last_activated) WHERE strength < 0.1;

-- Consolidation Run Tracking
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id           TEXT    NOT NULL PRIMARY KEY,
  cycle        TEXT    NOT NULL CHECK (cycle IN ('light', 'deep', 'dream', 'decay')),
  started_at   REAL    NOT NULL DEFAULT (julianday('now')),
  completed_at REAL,
  status       TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  metadata     TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_consolidation_runs_status ON consolidation_runs(status, started_at DESC);

-- Sensory Buffer Persistence
CREATE TABLE IF NOT EXISTS sensory_snapshots (
  session_id   TEXT    NOT NULL PRIMARY KEY,
  snapshot     TEXT    NOT NULL DEFAULT '{}',
  saved_at     REAL    NOT NULL DEFAULT (julianday('now'))
);
`

const FTS5_TABLES = `
-- FTS5 virtual tables
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  content, entities_fts,
  content=episodes, content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE VIRTUAL TABLE IF NOT EXISTS digests_fts USING fts5(
  summary, key_topics,
  content=digests, content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
  topic, content,
  content=semantic, content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE VIRTUAL TABLE IF NOT EXISTS procedural_fts USING fts5(
  trigger_text, procedure, category,
  content=procedural, content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);
`

const FTS5_TRIGGERS = `
-- Episodes FTS sync
CREATE TRIGGER IF NOT EXISTS episodes_fts_insert AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content, entities_fts) VALUES (new.rowid, new.content, new.entities_fts);
END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_update AFTER UPDATE OF content, entities_json ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, entities_fts) VALUES ('delete', old.rowid, old.content, old.entities_fts);
  INSERT INTO episodes_fts(rowid, content, entities_fts) VALUES (new.rowid, new.content, new.entities_fts);
END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_delete AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, entities_fts) VALUES ('delete', old.rowid, old.content, old.entities_fts);
END;

-- Digests FTS sync
CREATE TRIGGER IF NOT EXISTS digests_fts_insert AFTER INSERT ON digests BEGIN
  INSERT INTO digests_fts(rowid, summary, key_topics) VALUES (new.rowid, new.summary, new.key_topics);
END;
CREATE TRIGGER IF NOT EXISTS digests_fts_delete AFTER DELETE ON digests BEGIN
  INSERT INTO digests_fts(digests_fts, rowid, summary, key_topics) VALUES ('delete', old.rowid, old.summary, old.key_topics);
END;

-- Semantic FTS sync
CREATE TRIGGER IF NOT EXISTS semantic_fts_insert AFTER INSERT ON semantic BEGIN
  INSERT INTO semantic_fts(rowid, topic, content) VALUES (new.rowid, new.topic, new.content);
END;
CREATE TRIGGER IF NOT EXISTS semantic_fts_update AFTER UPDATE OF topic, content ON semantic BEGIN
  INSERT INTO semantic_fts(semantic_fts, rowid, topic, content) VALUES ('delete', old.rowid, old.topic, old.content);
  INSERT INTO semantic_fts(rowid, topic, content) VALUES (new.rowid, new.topic, new.content);
END;
CREATE TRIGGER IF NOT EXISTS semantic_fts_delete AFTER DELETE ON semantic BEGIN
  INSERT INTO semantic_fts(semantic_fts, rowid, topic, content) VALUES ('delete', old.rowid, old.topic, old.content);
END;

-- Procedural FTS sync
CREATE TRIGGER IF NOT EXISTS procedural_fts_insert AFTER INSERT ON procedural BEGIN
  INSERT INTO procedural_fts(rowid, trigger_text, procedure, category) VALUES (new.rowid, new.trigger_text, new.procedure, new.category);
END;
CREATE TRIGGER IF NOT EXISTS procedural_fts_update AFTER UPDATE OF trigger_text, procedure, category ON procedural BEGIN
  INSERT INTO procedural_fts(procedural_fts, rowid, trigger_text, procedure, category) VALUES ('delete', old.rowid, old.trigger_text, old.procedure, old.category);
  INSERT INTO procedural_fts(rowid, trigger_text, procedure, category) VALUES (new.rowid, new.trigger_text, new.procedure, new.category);
END;
CREATE TRIGGER IF NOT EXISTS procedural_fts_delete AFTER DELETE ON procedural BEGIN
  INSERT INTO procedural_fts(procedural_fts, rowid, trigger_text, procedure, category) VALUES ('delete', old.rowid, old.trigger_text, old.procedure, old.category);
END;

-- Auto-update updated_at triggers
CREATE TRIGGER IF NOT EXISTS semantic_updated_at AFTER UPDATE ON semantic BEGIN
  UPDATE semantic SET updated_at = julianday('now') WHERE id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS procedural_updated_at AFTER UPDATE ON procedural BEGIN
  UPDATE procedural SET updated_at = julianday('now') WHERE id = new.id;
END;
`

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number
}

export function runMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db)

  if (currentVersion >= 1) return // Already migrated

  db.exec(SCHEMA_V1)
  db.exec(FTS5_TABLES)
  db.exec(FTS5_TRIGGERS)
  db.pragma('user_version = 1')
}
```

- [ ] **Step 4: Implement FTS5 query sanitization helper**

Save to `packages/sqlite/src/search.ts`:

```typescript
/**
 * Sanitize a query string for FTS5 MATCH.
 * FTS5 has special operators (AND, OR, NOT, NEAR, column:) that must be escaped.
 * We wrap each token in double quotes to treat them as literals.
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query.trim()) return '""'

  // Split on whitespace, wrap each token in quotes to escape FTS5 operators
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

/** Convert Julian Day number to JS Date. */
export function julianToDate(julian: number | null): Date | null {
  if (julian === null || julian === undefined) return null
  // Julian Day 0 = November 24, 4714 BC. Unix epoch = Julian Day 2440587.5
  return new Date((julian - 2440587.5) * 86400000)
}

/** Convert JS Date to Julian Day number. */
export function dateToJulian(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/sqlite && npx vitest run`
Expected: All 7 migration tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite/
git commit -m "feat(sqlite): production-ready schema with FTS5, FK enforcement, and migrations"
```

---

## Task 5: EpisodeStorage Implementation

**Files:**
- Create: `packages/sqlite/src/episodes.ts`
- Create: `packages/sqlite/test/episodes.test.ts`

- [ ] **Step 1: Write episode tests**

Save to `packages/sqlite/test/episodes.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteEpisodeStorage } from '../src/episodes.js'
import type { Episode } from '@engram-mem/core'

describe('SqliteEpisodeStorage', () => {
  let db: Database.Database
  let store: SqliteEpisodeStorage

  beforeEach(() => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteEpisodeStorage(db)
  })

  it('inserts and retrieves an episode', async () => {
    const episode = await store.insert({
      sessionId: 'session-1',
      role: 'user',
      content: 'I prefer TypeScript strict mode',
      salience: 0.85,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null,
      entities: ['TypeScript'],
      metadata: {},
    })

    expect(episode.id).toBeTruthy()
    expect(episode.content).toBe('I prefer TypeScript strict mode')
    expect(episode.salience).toBe(0.85)
    expect(episode.entities).toEqual(['TypeScript'])
    expect(episode.createdAt).toBeInstanceOf(Date)
  })

  it('searches episodes via FTS5 BM25', async () => {
    await store.insert({
      sessionId: 's1', role: 'user', content: 'React hooks are great for state management',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['React'], metadata: {},
    })
    await store.insert({
      sessionId: 's1', role: 'user', content: 'I had pizza for lunch today',
      salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    const results = await store.search('React state')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.content).toContain('React')
    expect(results[0].similarity).toBeGreaterThan(0)
  })

  it('getByIds returns episodes by their IDs', async () => {
    const e1 = await store.insert({
      sessionId: 's1', role: 'user', content: 'first',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })
    const e2 = await store.insert({
      sessionId: 's1', role: 'assistant', content: 'second',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    const fetched = await store.getByIds([e1.id, e2.id])
    expect(fetched).toHaveLength(2)
    expect(fetched.map(e => e.content).sort()).toEqual(['first', 'second'])
  })

  it('getUnconsolidated returns only non-consolidated episodes', async () => {
    const e1 = await store.insert({
      sessionId: 's1', role: 'user', content: 'open',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })
    await store.insert({
      sessionId: 's1', role: 'user', content: 'consolidated already',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })
    // Mark second as consolidated
    await store.markConsolidated([e1.id])

    const open = await store.getUnconsolidated('s1')
    expect(open).toHaveLength(1)
    expect(open[0].content).toBe('consolidated already')
  })

  it('recordAccess increments access count', async () => {
    const ep = await store.insert({
      sessionId: 's1', role: 'user', content: 'test',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    await store.recordAccess(ep.id)
    await store.recordAccess(ep.id)

    const [updated] = await store.getByIds([ep.id])
    expect(updated.accessCount).toBe(2)
    expect(updated.lastAccessed).toBeInstanceOf(Date)
  })

  it('getUnconsolidatedSessions returns distinct session IDs', async () => {
    await store.insert({
      sessionId: 's1', role: 'user', content: 'a',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })
    await store.insert({
      sessionId: 's2', role: 'user', content: 'b',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    const sessions = await store.getUnconsolidatedSessions()
    expect(sessions.sort()).toEqual(['s1', 's2'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sqlite && npx vitest run test/episodes.test.ts`
Expected: FAIL — SqliteEpisodeStorage not found

- [ ] **Step 3: Implement SqliteEpisodeStorage**

Save to `packages/sqlite/src/episodes.ts`:

```typescript
import type Database from 'better-sqlite3'
import type { Episode, SearchOptions, SearchResult } from '@engram-mem/core'
import { generateId } from '@engram-mem/core'
import type { EpisodeStorage } from '@engram-mem/core'
import { sanitizeFtsQuery, julianToDate } from './search.js'

export class SqliteEpisodeStorage implements EpisodeStorage {
  constructor(private db: Database.Database) {}

  async insert(
    episode: Omit<Episode, 'id' | 'createdAt'>
  ): Promise<Episode> {
    const id = generateId()

    // Insert into memories table first (FK requirement)
    this.db
      .prepare('INSERT INTO memories (id, type) VALUES (?, ?)')
      .run(id, 'episode')

    const entitiesJson = JSON.stringify(episode.entities)
    const metadataJson = JSON.stringify(episode.metadata)
    const embeddingBlob = episode.embedding
      ? Buffer.from(new Float32Array(episode.embedding).buffer)
      : null

    this.db
      .prepare(
        `INSERT INTO episodes (id, session_id, role, content, salience, access_count,
         last_accessed, consolidated_at, embedding, entities_json, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        episode.sessionId,
        episode.role,
        episode.content,
        episode.salience,
        episode.accessCount,
        episode.lastAccessed ? episode.lastAccessed.getTime() / 86400000 + 2440587.5 : null,
        episode.consolidatedAt ? episode.consolidatedAt.getTime() / 86400000 + 2440587.5 : null,
        embeddingBlob,
        entitiesJson,
        metadataJson
      )

    return this.rowToEpisode(
      this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow
    )
  }

  async search(
    query: string,
    opts?: SearchOptions
  ): Promise<SearchResult<Episode>[]> {
    const ftsQuery = sanitizeFtsQuery(query)
    const limit = opts?.limit ?? 10

    let sql = `
      SELECT e.*, -episodes_fts.rank AS bm25_score
      FROM episodes_fts
      JOIN episodes e ON episodes_fts.rowid = e.rowid
      WHERE episodes_fts MATCH ?
    `
    const params: unknown[] = [ftsQuery]

    if (opts?.sessionId) {
      sql += ' AND e.session_id = ?'
      params.push(opts.sessionId)
    }

    sql += ' ORDER BY rank LIMIT ?'
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as (EpisodeRow & { bm25_score: number })[]

    // Normalize BM25 scores to 0-1 range
    const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.bm25_score)) : 1
    return rows
      .filter((r) => r.bm25_score > 0)
      .map((r) => ({
        item: this.rowToEpisode(r),
        similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
      }))
  }

  async getByIds(ids: string[]): Promise<Episode[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM episodes WHERE id IN (${placeholders})`)
      .all(...ids) as EpisodeRow[]
    return rows.map((r) => this.rowToEpisode(r))
  }

  async getBySession(
    sessionId: string,
    opts?: { since?: Date }
  ): Promise<Episode[]> {
    let sql = 'SELECT * FROM episodes WHERE session_id = ?'
    const params: unknown[] = [sessionId]
    if (opts?.since) {
      sql += ' AND created_at >= ?'
      params.push(opts.since.getTime() / 86400000 + 2440587.5)
    }
    sql += ' ORDER BY created_at ASC'
    const rows = this.db.prepare(sql).all(...params) as EpisodeRow[]
    return rows.map((r) => this.rowToEpisode(r))
  }

  async getUnconsolidated(sessionId: string): Promise<Episode[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM episodes WHERE session_id = ? AND consolidated_at IS NULL ORDER BY salience DESC'
      )
      .all(sessionId) as EpisodeRow[]
    return rows.map((r) => this.rowToEpisode(r))
  }

  async getUnconsolidatedSessions(): Promise<string[]> {
    return this.db
      .prepare(
        'SELECT DISTINCT session_id FROM episodes WHERE consolidated_at IS NULL'
      )
      .pluck()
      .all() as string[]
  }

  async markConsolidated(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(
        `UPDATE episodes SET consolidated_at = julianday('now') WHERE id IN (${placeholders})`
      )
      .run(...ids)
  }

  async recordAccess(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE episodes SET access_count = access_count + 1, last_accessed = julianday('now') WHERE id = ?`
      )
      .run(id)
  }

  private rowToEpisode(row: EpisodeRow): Episode {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role as Episode['role'],
      content: row.content,
      salience: row.salience,
      accessCount: row.access_count,
      lastAccessed: julianToDate(row.last_accessed),
      consolidatedAt: julianToDate(row.consolidated_at),
      embedding: row.embedding
        ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4))
        : null,
      entities: JSON.parse(row.entities_json),
      metadata: JSON.parse(row.metadata),
      createdAt: julianToDate(row.created_at)!,
    }
  }
}

interface EpisodeRow {
  id: string
  session_id: string
  role: string
  content: string
  salience: number
  access_count: number
  last_accessed: number | null
  consolidated_at: number | null
  embedding: Buffer | null
  entities_json: string
  entities_fts: string
  metadata: string
  created_at: number
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sqlite && npx vitest run test/episodes.test.ts`
Expected: All 6 episode tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sqlite/src/episodes.ts packages/sqlite/test/episodes.test.ts
git commit -m "feat(sqlite): implement EpisodeStorage with FTS5 search"
```

---

## Task 6: DigestStorage Implementation

**Files:**
- Create: `packages/sqlite/src/digests.ts`
- Create: `packages/sqlite/test/digests.test.ts`

- [ ] **Step 1: Write digest tests**

Save to `packages/sqlite/test/digests.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteDigestStorage } from '../src/digests.js'

describe('SqliteDigestStorage', () => {
  let db: Database.Database
  let store: SqliteDigestStorage

  beforeEach(() => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteDigestStorage(db)
  })

  it('inserts and retrieves a digest', async () => {
    const digest = await store.insert({
      sessionId: 's1',
      summary: 'Discussed React performance optimization and hooks patterns',
      keyTopics: ['React', 'performance', 'hooks'],
      sourceEpisodeIds: ['ep-1', 'ep-2'],
      sourceDigestIds: [],
      level: 0,
      embedding: null,
      metadata: { source: 'light_sleep' },
    })

    expect(digest.id).toBeTruthy()
    expect(digest.summary).toContain('React')
    expect(digest.keyTopics).toEqual(['React', 'performance', 'hooks'])
    expect(digest.level).toBe(0)
  })

  it('searches digests via FTS5', async () => {
    await store.insert({
      sessionId: 's1',
      summary: 'User prefers TypeScript with strict mode enabled',
      keyTopics: ['TypeScript', 'strict'],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })
    await store.insert({
      sessionId: 's1',
      summary: 'Discussed lunch plans and weekend activities',
      keyTopics: ['social'],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })

    const results = await store.search('TypeScript strict')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.summary).toContain('TypeScript')
  })

  it('getRecent returns digests from last N days', async () => {
    await store.insert({
      sessionId: 's1', summary: 'recent',
      keyTopics: [], sourceEpisodeIds: [], sourceDigestIds: [],
      level: 0, embedding: null, metadata: {},
    })

    const recent = await store.getRecent(7)
    expect(recent).toHaveLength(1)
    expect(recent[0].summary).toBe('recent')
  })

  it('getCountBySession returns digest counts per session', async () => {
    await store.insert({
      sessionId: 's1', summary: 'a', keyTopics: [],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })
    await store.insert({
      sessionId: 's1', summary: 'b', keyTopics: [],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })
    await store.insert({
      sessionId: 's2', summary: 'c', keyTopics: [],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })

    const counts = await store.getCountBySession()
    expect(counts['s1']).toBe(2)
    expect(counts['s2']).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sqlite && npx vitest run test/digests.test.ts`
Expected: FAIL — SqliteDigestStorage not found

- [ ] **Step 3: Implement SqliteDigestStorage**

Save to `packages/sqlite/src/digests.ts`:

```typescript
import type Database from 'better-sqlite3'
import type { Digest, SearchOptions, SearchResult } from '@engram-mem/core'
import { generateId } from '@engram-mem/core'
import type { DigestStorage } from '@engram-mem/core'
import { sanitizeFtsQuery, julianToDate } from './search.js'

export class SqliteDigestStorage implements DigestStorage {
  constructor(private db: Database.Database) {}

  async insert(digest: Omit<Digest, 'id' | 'createdAt'>): Promise<Digest> {
    const id = generateId()
    this.db.prepare('INSERT INTO memories (id, type) VALUES (?, ?)').run(id, 'digest')

    const embeddingBlob = digest.embedding
      ? Buffer.from(new Float32Array(digest.embedding).buffer)
      : null

    this.db
      .prepare(
        `INSERT INTO digests (id, session_id, summary, key_topics, source_episode_ids,
         source_digest_ids, level, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        digest.sessionId,
        digest.summary,
        JSON.stringify(digest.keyTopics),
        JSON.stringify(digest.sourceEpisodeIds),
        JSON.stringify(digest.sourceDigestIds),
        digest.level,
        embeddingBlob,
        JSON.stringify(digest.metadata)
      )

    return this.rowToDigest(
      this.db.prepare('SELECT * FROM digests WHERE id = ?').get(id) as DigestRow
    )
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<Digest>[]> {
    const ftsQuery = sanitizeFtsQuery(query)
    const limit = opts?.limit ?? 10

    const rows = this.db
      .prepare(
        `SELECT d.*, -digests_fts.rank AS bm25_score
         FROM digests_fts
         JOIN digests d ON digests_fts.rowid = d.rowid
         WHERE digests_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, limit) as (DigestRow & { bm25_score: number })[]

    const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.bm25_score)) : 1
    return rows
      .filter((r) => r.bm25_score > 0)
      .map((r) => ({
        item: this.rowToDigest(r),
        similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
      }))
  }

  async getBySession(sessionId: string): Promise<Digest[]> {
    const rows = this.db
      .prepare('SELECT * FROM digests WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as DigestRow[]
    return rows.map((r) => this.rowToDigest(r))
  }

  async getRecent(days: number): Promise<Digest[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM digests WHERE created_at >= julianday('now') - ? ORDER BY created_at DESC`
      )
      .all(days) as DigestRow[]
    return rows.map((r) => this.rowToDigest(r))
  }

  async getCountBySession(): Promise<Record<string, number>> {
    const rows = this.db
      .prepare('SELECT session_id, COUNT(*) as cnt FROM digests GROUP BY session_id')
      .all() as Array<{ session_id: string; cnt: number }>
    const result: Record<string, number> = {}
    for (const row of rows) {
      result[row.session_id] = row.cnt
    }
    return result
  }

  private rowToDigest(row: DigestRow): Digest {
    return {
      id: row.id,
      sessionId: row.session_id,
      summary: row.summary,
      keyTopics: JSON.parse(row.key_topics),
      sourceEpisodeIds: JSON.parse(row.source_episode_ids),
      sourceDigestIds: JSON.parse(row.source_digest_ids),
      level: row.level,
      embedding: row.embedding
        ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4))
        : null,
      metadata: JSON.parse(row.metadata),
      createdAt: julianToDate(row.created_at)!,
    }
  }
}

interface DigestRow {
  id: string
  session_id: string
  summary: string
  key_topics: string
  source_episode_ids: string
  source_digest_ids: string
  level: number
  embedding: Buffer | null
  metadata: string
  created_at: number
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sqlite && npx vitest run test/digests.test.ts`
Expected: All 4 digest tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sqlite/src/digests.ts packages/sqlite/test/digests.test.ts
git commit -m "feat(sqlite): implement DigestStorage with FTS5 search"
```

---

## Task 7: SemanticStorage Implementation

**Files:**
- Create: `packages/sqlite/src/semantic.ts`
- Create: `packages/sqlite/test/semantic.test.ts`

- [ ] **Step 1: Write semantic tests**

Save to `packages/sqlite/test/semantic.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteSemanticStorage } from '../src/semantic.js'

describe('SqliteSemanticStorage', () => {
  let db: Database.Database
  let store: SqliteSemanticStorage

  beforeEach(() => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteSemanticStorage(db)
  })

  it('inserts semantic memory with default confidence', async () => {
    const mem = await store.insert({
      topic: 'preference',
      content: 'User prefers TypeScript strict mode',
      confidence: 0.9,
      sourceDigestIds: ['d1'],
      sourceEpisodeIds: ['e1', 'e2'],
      decayRate: 0.02,
      supersedes: null,
      supersededBy: null,
      embedding: null,
      metadata: {},
    })

    expect(mem.id).toBeTruthy()
    expect(mem.confidence).toBe(0.9)
    expect(mem.accessCount).toBe(0)
    expect(mem.decayRate).toBe(0.02)
  })

  it('searches semantic memories via FTS5', async () => {
    await store.insert({
      topic: 'preference', content: 'User prefers tabs over spaces',
      confidence: 0.9, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    const results = await store.search('tabs spaces')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.content).toContain('tabs')
  })

  it('recordAccessAndBoost atomically increments and boosts', async () => {
    const mem = await store.insert({
      topic: 'fact', content: 'TypeScript compiles to JavaScript',
      confidence: 0.5, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    await store.recordAccessAndBoost(mem.id, 0.05)
    await store.recordAccessAndBoost(mem.id, 0.05)

    const results = await store.search('TypeScript JavaScript')
    const updated = results.find(r => r.item.id === mem.id)!
    expect(updated.item.accessCount).toBe(2)
    expect(updated.item.confidence).toBeCloseTo(0.6, 1)
    expect(updated.item.lastAccessed).toBeInstanceOf(Date)
  })

  it('batchDecay lowers confidence of unaccessed memories', async () => {
    const mem = await store.insert({
      topic: 'fact', content: 'Old unaccessed fact',
      confidence: 0.8, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    // Hack: set last_accessed to 60 days ago so it qualifies for decay
    db.prepare(`UPDATE semantic SET last_accessed = julianday('now') - 60 WHERE id = ?`).run(mem.id)

    const decayed = await store.batchDecay({ daysThreshold: 30, decayRate: 0.1 })
    expect(decayed).toBe(1)

    const results = await store.search('unaccessed')
    expect(results[0].item.confidence).toBeCloseTo(0.7, 1)
  })

  it('batchDecay floors confidence at 0.05', async () => {
    const mem = await store.insert({
      topic: 'fact', content: 'Nearly forgotten fact',
      confidence: 0.06, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })
    db.prepare(`UPDATE semantic SET last_accessed = julianday('now') - 60 WHERE id = ?`).run(mem.id)

    await store.batchDecay({ daysThreshold: 30, decayRate: 0.1 })

    const row = db.prepare('SELECT confidence FROM semantic WHERE id = ?').get(mem.id) as { confidence: number }
    expect(row.confidence).toBeCloseTo(0.05, 2)
  })

  it('markSuperseded sets bidirectional supersession links', async () => {
    const old = await store.insert({
      topic: 'preference', content: 'User prefers spaces',
      confidence: 0.9, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })
    const newer = await store.insert({
      topic: 'preference', content: 'User prefers tabs',
      confidence: 0.9, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    await store.markSuperseded(old.id, newer.id)

    const oldRow = db.prepare('SELECT superseded_by FROM semantic WHERE id = ?').get(old.id) as { superseded_by: string }
    const newRow = db.prepare('SELECT supersedes FROM semantic WHERE id = ?').get(newer.id) as { supersedes: string }
    expect(oldRow.superseded_by).toBe(newer.id)
    expect(newRow.supersedes).toBe(old.id)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sqlite && npx vitest run test/semantic.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement SqliteSemanticStorage**

Save to `packages/sqlite/src/semantic.ts`:

```typescript
import type Database from 'better-sqlite3'
import type { SemanticMemory, SearchOptions, SearchResult } from '@engram-mem/core'
import { generateId } from '@engram-mem/core'
import type { SemanticStorage } from '@engram-mem/core'
import { sanitizeFtsQuery, julianToDate } from './search.js'

export class SqliteSemanticStorage implements SemanticStorage {
  constructor(private db: Database.Database) {}

  async insert(
    memory: Omit<SemanticMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<SemanticMemory> {
    const id = generateId()
    this.db.prepare('INSERT INTO memories (id, type) VALUES (?, ?)').run(id, 'semantic')

    const embeddingBlob = memory.embedding
      ? Buffer.from(new Float32Array(memory.embedding).buffer)
      : null

    this.db
      .prepare(
        `INSERT INTO semantic (id, topic, content, confidence, source_digest_ids, source_episode_ids,
         decay_rate, supersedes, superseded_by, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        memory.topic,
        memory.content,
        memory.confidence,
        JSON.stringify(memory.sourceDigestIds),
        JSON.stringify(memory.sourceEpisodeIds),
        memory.decayRate,
        memory.supersedes,
        memory.supersededBy,
        embeddingBlob,
        JSON.stringify(memory.metadata)
      )

    return this.rowToSemantic(
      this.db.prepare('SELECT * FROM semantic WHERE id = ?').get(id) as SemanticRow
    )
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<SemanticMemory>[]> {
    const ftsQuery = sanitizeFtsQuery(query)
    const limit = opts?.limit ?? 10

    const rows = this.db
      .prepare(
        `SELECT s.*, -semantic_fts.rank AS bm25_score
         FROM semantic_fts
         JOIN semantic s ON semantic_fts.rowid = s.rowid
         WHERE semantic_fts MATCH ?
           AND s.superseded_by IS NULL
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, limit) as (SemanticRow & { bm25_score: number })[]

    const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.bm25_score)) : 1
    return rows
      .filter((r) => r.bm25_score > 0)
      .map((r) => ({
        item: this.rowToSemantic(r),
        similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
      }))
  }

  async getUnaccessed(days: number): Promise<SemanticMemory[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM semantic
         WHERE confidence > 0.05
           AND (last_accessed IS NULL OR last_accessed < julianday('now') - ?)`
      )
      .all(days) as SemanticRow[]
    return rows.map((r) => this.rowToSemantic(r))
  }

  async recordAccessAndBoost(id: string, confidenceBoost: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE semantic
         SET access_count = access_count + 1,
             last_accessed = julianday('now'),
             confidence = MIN(1.0, confidence + ?)
         WHERE id = ?`
      )
      .run(confidenceBoost, id)
  }

  async markSuperseded(id: string, supersededBy: string): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db.prepare('UPDATE semantic SET superseded_by = ? WHERE id = ?').run(supersededBy, id)
      this.db.prepare('UPDATE semantic SET supersedes = ? WHERE id = ?').run(id, supersededBy)
    })
    txn()
  }

  async batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE semantic
         SET confidence = MAX(0.05, confidence - ?)
         WHERE confidence > 0.05
           AND (last_accessed IS NULL OR last_accessed < julianday('now') - ?)`
      )
      .run(opts.decayRate, opts.daysThreshold)
    return result.changes
  }

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
      metadata: JSON.parse(row.metadata),
      createdAt: julianToDate(row.created_at)!,
      updatedAt: julianToDate(row.updated_at)!,
    }
  }
}

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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sqlite && npx vitest run test/semantic.test.ts`
Expected: All 6 semantic tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sqlite/src/semantic.ts packages/sqlite/test/semantic.test.ts
git commit -m "feat(sqlite): implement SemanticStorage with batch decay and supersession"
```

---

## Tasks 8-11: Remaining Storage Implementations

> Due to the scale of this plan, Tasks 8-11 follow the same TDD pattern established in Tasks 5-7. Each is fully specified below with file paths, test code, and implementation code.

### Task 8: ProceduralStorage Implementation

**Files:**
- Create: `packages/sqlite/src/procedural.ts`
- Create: `packages/sqlite/test/procedural.test.ts`

Follow the same pattern as SemanticStorage. Key differences:
- `trigger_text` column maps to `trigger` field
- `procedure` column maps to `procedure` field
- `searchByTrigger()` uses FTS5 MATCH on `trigger_text` column specifically
- `incrementObservation()` increments `observation_count` and updates `last_observed`
- `batchDecay()` uses `procedural` table with slower default rate (0.01)
- `category` CHECK constraint enforces `('workflow', 'preference', 'habit', 'pattern', 'convention')`

Tests must cover: insert, search, searchByTrigger, recordAccess, incrementObservation, batchDecay.

### Task 9: AssociationStorage Implementation

**Files:**
- Create: `packages/sqlite/src/associations.ts`
- Create: `packages/sqlite/test/associations.test.ts`

This is the most complex storage implementation. Key methods:

- `insert()` — standard edge insertion with FK to memories table
- `walk()` — **recursive CTE** graph traversal (see `docs/engram-db-audit.md` Section 3.2 for the exact SQL). Takes seed IDs, maxHops (default 2), minStrength (default 0.2). Returns `WalkResult[]` with depth and path strength.
- `upsertCoRecalled()` — `INSERT ... ON CONFLICT DO UPDATE SET strength = MIN(1.0, strength + 0.1), last_activated = julianday('now')`
- `pruneWeak()` — `DELETE FROM associations WHERE strength < ? AND (last_activated IS NULL OR last_activated < julianday('now') - ?) AND edge_type != 'derives_from'` (never prune provenance edges)
- `discoverTopicalEdges()` — SQL-side entity co-occurrence using temp table + JOIN + NOT EXISTS anti-join (see `docs/engram-db-audit.md` Section 3.3 for exact SQL)

Tests must cover: insert, walk (1-hop, 2-hop, cycle detection), upsertCoRecalled (insert + update), pruneWeak (preserves derives_from), discoverTopicalEdges.

### Task 10: Full StorageAdapter + Sensory Snapshots

**Files:**
- Create: `packages/sqlite/src/adapter.ts`
- Create: `packages/sqlite/src/index.ts`
- Create: `packages/sqlite/test/adapter.test.ts`

The `SqliteStorageAdapter` class:
- Constructor takes `{ path?: string }` (defaults to `:memory:` for tests)
- `initialize()` — opens DB, sets WAL pragmas, runs migrations
- `dispose()` — closes DB connection
- Composes all 5 sub-stores: `episodes`, `digests`, `semantic`, `procedural`, `associations`
- `getById(id, type)` — queries the specific table, returns `TypedMemory` discriminated union
- `getByIds(ids)` — batch version using UNION ALL across all 4 tables
- `saveSensorySnapshot()` — upsert into `sensory_snapshots`
- `loadSensorySnapshot()` — select from `sensory_snapshots`

The `sqliteAdapter()` factory export:
```typescript
export function sqliteAdapter(opts?: { path?: string }): StorageAdapter {
  return new SqliteStorageAdapter(opts?.path ?? ':memory:')
}
```

Tests must cover: full lifecycle (initialize → insert episodes → search → dispose), getById returns correct TypedMemory union, sensory snapshot save/load round-trip.

### Task 11: Integration Test

**Files:**
- Create: `packages/sqlite/test/integration.test.ts`

End-to-end test that exercises the full adapter:
1. Initialize adapter
2. Insert 10 episodes across 2 sessions
3. Search via FTS5 and verify results
4. Insert 3 semantic memories
5. Insert 2 procedural memories
6. Create association edges between them
7. Walk the graph from one episode and verify connected memories are found
8. Run batch decay and verify confidence dropped
9. Save and load sensory snapshot
10. Dispose

---

## Self-Review Checklist

1. **Spec coverage**: Every StorageAdapter sub-interface method has a corresponding implementation task and test. All 8 database tables from the DB audit are created in migrations. FTS5 triggers, CHECK constraints, FK enforcement all verified by tests.

2. **Placeholder scan**: No TBDs, TODOs, or "similar to Task N" references. Tasks 8-11 have full descriptions and all method signatures. Tasks 5-7 have complete code.

3. **Type consistency**: `Episode`, `Digest`, `SemanticMemory`, `ProceduralMemory`, `Association` types match between `core/types.ts` and all storage implementations. `row.session_id` maps to `episode.sessionId` consistently via `rowToEpisode()` mappers. Julian Day conversion uses the same `julianToDate()` / `dateToJulian()` utilities throughout.

**Gap found**: Tasks 8-11 reference the exact same `@engram-mem/core` exports but Task 3 (`index.ts`) doesn't re-export `generateId` from the adapters path. Verified: `index.ts` does export it via `export { generateId } from './utils/id.js'` — no gap.

---
