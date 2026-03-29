import { vi } from 'vitest'
import type {
  Episode,
  Digest,
  SemanticMemory,
  ProceduralMemory,
  Association,
  SearchResult,
  TypedMemory,
  WalkResult,
  DiscoveredEdge,
  MemoryType,
} from '../../src/types.js'
import type {
  StorageAdapter,
  EpisodeStorage,
  DigestStorage,
  SemanticStorage,
  ProceduralStorage,
  AssociationStorage,
} from '../../src/adapters/storage.js'

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

export const MOCK_EPISODE: Episode = {
  id: 'ep-1',
  sessionId: 'sess-1',
  role: 'user',
  content: 'We discussed TypeScript strict mode configuration',
  salience: 0.8,
  accessCount: 2,
  lastAccessed: null,
  consolidatedAt: null,
  embedding: null,
  entities: ['typescript', 'strict'],
  metadata: {},
  createdAt: new Date(Date.now() - 3_600_000), // 1 hour ago
}

export const MOCK_EPISODE_2: Episode = {
  id: 'ep-2',
  sessionId: 'sess-1',
  role: 'assistant',
  content: 'TypeScript strict mode enables noImplicitAny and strictNullChecks',
  salience: 0.7,
  accessCount: 1,
  lastAccessed: null,
  consolidatedAt: null,
  embedding: null,
  entities: ['typescript', 'noImplicitAny'],
  metadata: {},
  createdAt: new Date(Date.now() - 7_200_000), // 2 hours ago
}

export const MOCK_DIGEST: Digest = {
  id: 'dig-1',
  sessionId: 'sess-1',
  summary: 'Session focused on TypeScript configuration and strict mode settings',
  keyTopics: ['typescript', 'configuration', 'strict'],
  sourceEpisodeIds: ['ep-1'],
  sourceDigestIds: [],
  level: 1,
  embedding: null,
  metadata: {},
  createdAt: new Date(Date.now() - 86_400_000), // 1 day ago
}

export const MOCK_SEMANTIC: SemanticMemory = {
  id: 'sem-1',
  topic: 'TypeScript strict mode',
  content: 'TypeScript strict mode should always be enabled for new projects',
  confidence: 0.9,
  sourceDigestIds: ['dig-1'],
  sourceEpisodeIds: ['ep-1'],
  accessCount: 5,
  lastAccessed: null,
  decayRate: 0.01,
  supersedes: null,
  supersededBy: null,
  embedding: null,
  metadata: {},
  createdAt: new Date(Date.now() - 172_800_000), // 2 days ago
  updatedAt: new Date(Date.now() - 172_800_000),
}

export const MOCK_PROCEDURAL: ProceduralMemory = {
  id: 'proc-1',
  category: 'convention',
  trigger: 'creating TypeScript project',
  procedure: 'Always enable strict mode in tsconfig.json',
  confidence: 0.85,
  observationCount: 3,
  lastObserved: new Date(Date.now() - 86_400_000),
  firstObserved: new Date(Date.now() - 604_800_000),
  accessCount: 2,
  lastAccessed: null,
  decayRate: 0.01,
  sourceEpisodeIds: ['ep-1'],
  embedding: null,
  metadata: {},
  createdAt: new Date(Date.now() - 604_800_000),
  updatedAt: new Date(Date.now() - 86_400_000),
}

export const MOCK_ASSOCIATED_EPISODE: Episode = {
  id: 'ep-assoc-1',
  sessionId: 'sess-2',
  role: 'user',
  content: 'TypeScript compiler options for better type safety',
  salience: 0.6,
  accessCount: 1,
  lastAccessed: null,
  consolidatedAt: null,
  embedding: null,
  entities: ['typescript', 'compiler'],
  metadata: {},
  createdAt: new Date(Date.now() - 3_600_000 * 48),
}

// ---------------------------------------------------------------------------
// Default search results
// ---------------------------------------------------------------------------

export const EPISODE_SEARCH_RESULTS: SearchResult<Episode>[] = [
  { item: MOCK_EPISODE, similarity: 0.85 },
  { item: MOCK_EPISODE_2, similarity: 0.75 },
]

export const DIGEST_SEARCH_RESULTS: SearchResult<Digest>[] = [
  { item: MOCK_DIGEST, similarity: 0.72 },
]

export const SEMANTIC_SEARCH_RESULTS: SearchResult<SemanticMemory>[] = [
  { item: MOCK_SEMANTIC, similarity: 0.9 },
]

export const PROCEDURAL_SEARCH_RESULTS: SearchResult<ProceduralMemory>[] = [
  { item: MOCK_PROCEDURAL, similarity: 0.8 },
]

export const WALK_RESULTS: WalkResult[] = [
  { memoryId: 'ep-assoc-1', memoryType: 'episode', depth: 1, pathStrength: 0.7 },
]

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

export interface MockStorageOptions {
  episodeResults?: SearchResult<Episode>[]
  digestResults?: SearchResult<Digest>[]
  semanticResults?: SearchResult<SemanticMemory>[]
  proceduralResults?: SearchResult<ProceduralMemory>[]
  walkResults?: WalkResult[]
}

export function createMockStorage(opts: MockStorageOptions = {}): StorageAdapter {
  const episodeResults = opts.episodeResults ?? EPISODE_SEARCH_RESULTS
  const digestResults = opts.digestResults ?? DIGEST_SEARCH_RESULTS
  const semanticResults = opts.semanticResults ?? SEMANTIC_SEARCH_RESULTS
  const proceduralResults = opts.proceduralResults ?? PROCEDURAL_SEARCH_RESULTS
  const walkResults = opts.walkResults ?? WALK_RESULTS

  // Build a lookup map for getById
  const memoryMap = new Map<string, TypedMemory>([
    ['ep-1', { type: 'episode', data: MOCK_EPISODE }],
    ['ep-2', { type: 'episode', data: MOCK_EPISODE_2 }],
    ['dig-1', { type: 'digest', data: MOCK_DIGEST }],
    ['sem-1', { type: 'semantic', data: MOCK_SEMANTIC }],
    ['proc-1', { type: 'procedural', data: MOCK_PROCEDURAL }],
    ['ep-assoc-1', { type: 'episode', data: MOCK_ASSOCIATED_EPISODE }],
  ])

  const episodes: EpisodeStorage = {
    insert: vi.fn(),
    search: vi.fn().mockResolvedValue(episodeResults),
    getByIds: vi.fn().mockResolvedValue([]),
    getBySession: vi.fn().mockResolvedValue([]),
    getUnconsolidated: vi.fn().mockResolvedValue([]),
    getUnconsolidatedSessions: vi.fn().mockResolvedValue([]),
    markConsolidated: vi.fn().mockResolvedValue(undefined),
    recordAccess: vi.fn().mockResolvedValue(undefined),
  }

  const digests: DigestStorage = {
    insert: vi.fn(),
    search: vi.fn().mockResolvedValue(digestResults),
    getBySession: vi.fn().mockResolvedValue([]),
    getRecent: vi.fn().mockResolvedValue([]),
    getCountBySession: vi.fn().mockResolvedValue({}),
  }

  const semantic: SemanticStorage = {
    insert: vi.fn(),
    search: vi.fn().mockResolvedValue(semanticResults),
    getUnaccessed: vi.fn().mockResolvedValue([]),
    recordAccessAndBoost: vi.fn().mockResolvedValue(undefined),
    markSuperseded: vi.fn().mockResolvedValue(undefined),
    batchDecay: vi.fn().mockResolvedValue(0),
  }

  const procedural: ProceduralStorage = {
    insert: vi.fn(),
    search: vi.fn().mockResolvedValue(proceduralResults),
    searchByTrigger: vi.fn().mockResolvedValue([]),
    recordAccess: vi.fn().mockResolvedValue(undefined),
    incrementObservation: vi.fn().mockResolvedValue(undefined),
    batchDecay: vi.fn().mockResolvedValue(0),
  }

  const associations: AssociationStorage = {
    insert: vi.fn(),
    walk: vi.fn().mockResolvedValue(walkResults),
    upsertCoRecalled: vi.fn().mockResolvedValue(undefined),
    pruneWeak: vi.fn().mockResolvedValue(0),
    discoverTopicalEdges: vi.fn().mockResolvedValue([] as DiscoveredEdge[]),
  }

  const adapter: StorageAdapter = {
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    episodes,
    digests,
    semantic,
    procedural,
    associations,
    getById: vi.fn().mockImplementation(
      async (id: string, _type: MemoryType): Promise<TypedMemory | null> => {
        return memoryMap.get(id) ?? null
      }
    ),
    getByIds: vi.fn().mockImplementation(
      async (refs: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]> => {
        return refs.flatMap((r) => {
          const m = memoryMap.get(r.id)
          return m ? [m] : []
        })
      }
    ),
    saveSensorySnapshot: vi.fn().mockResolvedValue(undefined),
    loadSensorySnapshot: vi.fn().mockResolvedValue(null),
    vectorSearch: vi.fn().mockResolvedValue([]),
    textBoost: vi.fn().mockResolvedValue([]),
  }

  return adapter
}
