import { vi } from 'vitest'
import type {
  StorageAdapter,
  EpisodeStorage,
  DigestStorage,
  SemanticStorage,
  ProceduralStorage,
  AssociationStorage,
} from '../../src/adapters/storage.js'
import type {
  Episode,
  Digest,
  SemanticMemory,
  ProceduralMemory,
  Association,
  MemoryType,
  DiscoveredEdge,
  SearchResult,
  SensorySnapshot,
  TypedMemory,
} from '../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0
export function nextId(prefix = 'mock'): string {
  return `${prefix}-${++_idCounter}`
}

export function resetIdCounter(): void {
  _idCounter = 0
}

function makeDate(): Date {
  return new Date('2026-03-27T00:00:00.000Z')
}

// ---------------------------------------------------------------------------
// Mock Episode Storage
// ---------------------------------------------------------------------------

export interface MockEpisodeStorage extends EpisodeStorage {
  _episodes: Episode[]
  _unconsolidatedSessions: string[]
}

export function makeMockEpisodeStorage(
  sessions: string[],
  episodesPerSession: Map<string, Episode[]>
): MockEpisodeStorage {
  return {
    _episodes: Array.from(episodesPerSession.values()).flat(),
    _unconsolidatedSessions: sessions,

    insert: vi.fn(async (data) => {
      const episode: Episode = {
        id: nextId('ep'),
        createdAt: makeDate(),
        ...data,
      }
      return episode
    }),

    search: vi.fn(async () => []),

    getByIds: vi.fn(async (ids) => {
      const all = Array.from(episodesPerSession.values()).flat()
      return all.filter(e => ids.includes(e.id))
    }),

    getBySession: vi.fn(async (sessionId) => {
      return episodesPerSession.get(sessionId) ?? []
    }),

    getUnconsolidated: vi.fn(async (sessionId) => {
      return (episodesPerSession.get(sessionId) ?? []).filter(e => e.consolidatedAt === null)
    }),

    getUnconsolidatedSessions: vi.fn(async () => sessions),

    markConsolidated: vi.fn(async (_ids) => {
      // In tests, we track the call but don't mutate fixture episodes
    }),

    recordAccess: vi.fn(async () => {}),
  }
}

// ---------------------------------------------------------------------------
// Mock Digest Storage
// ---------------------------------------------------------------------------

export interface MockDigestStorage extends DigestStorage {
  _digests: Digest[]
}

export function makeMockDigestStorage(initialDigests: Digest[] = []): MockDigestStorage {
  const digests: Digest[] = [...initialDigests]

  return {
    _digests: digests,

    insert: vi.fn(async (data) => {
      const digest: Digest = {
        id: nextId('dig'),
        createdAt: makeDate(),
        ...data,
      }
      digests.push(digest)
      return digest
    }),

    search: vi.fn(async () => []),

    getBySession: vi.fn(async (sessionId) => {
      return digests.filter(d => d.sessionId === sessionId)
    }),

    getRecent: vi.fn(async (_days) => {
      return digests
    }),

    getCountBySession: vi.fn(async () => {
      const counts: Record<string, number> = {}
      for (const d of digests) {
        counts[d.sessionId] = (counts[d.sessionId] ?? 0) + 1
      }
      return counts
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock Semantic Storage
// ---------------------------------------------------------------------------

export interface MockSemanticStorage extends SemanticStorage {
  _memories: SemanticMemory[]
}

export function makeMockSemanticStorage(
  initialMemories: SemanticMemory[] = [],
  searchResults: SearchResult<SemanticMemory>[] = []
): MockSemanticStorage {
  const memories: SemanticMemory[] = [...initialMemories]

  return {
    _memories: memories,

    insert: vi.fn(async (data) => {
      const mem: SemanticMemory = {
        id: nextId('sem'),
        createdAt: makeDate(),
        updatedAt: makeDate(),
        accessCount: 0,
        lastAccessed: null,
        ...data,
      }
      memories.push(mem)
      return mem
    }),

    search: vi.fn(async (_query, _opts) => searchResults),

    getUnaccessed: vi.fn(async () => memories),

    recordAccessAndBoost: vi.fn(async () => {}),

    markSuperseded: vi.fn(async () => {}),

    batchDecay: vi.fn(async () => memories.length),
  }
}

// ---------------------------------------------------------------------------
// Mock Procedural Storage
// ---------------------------------------------------------------------------

export interface MockProceduralStorage extends ProceduralStorage {
  _memories: ProceduralMemory[]
}

export function makeMockProceduralStorage(
  initialMemories: ProceduralMemory[] = [],
  searchResults: SearchResult<ProceduralMemory>[] = []
): MockProceduralStorage {
  const memories: ProceduralMemory[] = [...initialMemories]

  return {
    _memories: memories,

    insert: vi.fn(async (data) => {
      const mem: ProceduralMemory = {
        id: nextId('proc'),
        createdAt: makeDate(),
        updatedAt: makeDate(),
        accessCount: 0,
        lastAccessed: null,
        ...data,
      }
      memories.push(mem)
      return mem
    }),

    search: vi.fn(async (_query, _opts) => searchResults),

    searchByTrigger: vi.fn(async (_activity, _opts) => searchResults),

    recordAccess: vi.fn(async () => {}),

    incrementObservation: vi.fn(async () => {}),

    batchDecay: vi.fn(async () => memories.length),
  }
}

// ---------------------------------------------------------------------------
// Mock Association Storage
// ---------------------------------------------------------------------------

export interface MockAssociationStorage extends AssociationStorage {
  _associations: Association[]
}

export function makeMockAssociationStorage(
  discoveredEdges: DiscoveredEdge[] = []
): MockAssociationStorage {
  const associations: Association[] = []

  return {
    _associations: associations,

    insert: vi.fn(async (data) => {
      const assoc: Association = {
        id: nextId('assoc'),
        createdAt: makeDate(),
        ...data,
      }
      associations.push(assoc)
      return assoc
    }),

    walk: vi.fn(async () => []),

    upsertCoRecalled: vi.fn(async () => {}),

    pruneWeak: vi.fn(async () => 3),

    discoverTopicalEdges: vi.fn(async () => discoveredEdges),
  }
}

// ---------------------------------------------------------------------------
// Full MockStorageAdapter
// ---------------------------------------------------------------------------

export interface MockStorageAdapter extends StorageAdapter {
  episodes: MockEpisodeStorage
  digests: MockDigestStorage
  semantic: MockSemanticStorage
  procedural: MockProceduralStorage
  associations: MockAssociationStorage
}

export interface MockStorageOptions {
  sessions?: string[]
  episodesPerSession?: Map<string, Episode[]>
  initialDigests?: Digest[]
  initialSemanticMemories?: SemanticMemory[]
  semanticSearchResults?: SearchResult<SemanticMemory>[]
  initialProceduralMemories?: ProceduralMemory[]
  proceduralSearchResults?: SearchResult<ProceduralMemory>[]
  discoveredEdges?: DiscoveredEdge[]
}

export function makeMockStorage(opts: MockStorageOptions = {}): MockStorageAdapter {
  const sessions = opts.sessions ?? []
  const episodesPerSession = opts.episodesPerSession ?? new Map()

  return {
    initialize: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),

    episodes: makeMockEpisodeStorage(sessions, episodesPerSession),
    digests: makeMockDigestStorage(opts.initialDigests),
    semantic: makeMockSemanticStorage(opts.initialSemanticMemories, opts.semanticSearchResults),
    procedural: makeMockProceduralStorage(opts.initialProceduralMemories, opts.proceduralSearchResults),
    associations: makeMockAssociationStorage(opts.discoveredEdges),

    getById: vi.fn(async (_id: string, _type: MemoryType): Promise<TypedMemory | null> => null),

    getByIds: vi.fn(async (_ids: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]> => []),

    saveSensorySnapshot: vi.fn(async (_sessionId: string, _snapshot: SensorySnapshot): Promise<void> => {}),

    loadSensorySnapshot: vi.fn(async (_sessionId: string): Promise<SensorySnapshot | null> => null),
  }
}

// ---------------------------------------------------------------------------
// Episode fixture builder
// ---------------------------------------------------------------------------

export function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: nextId('ep'),
    sessionId: 'session-1',
    role: 'user',
    content: 'Some episode content',
    salience: 0.5,
    accessCount: 0,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: null,
    entities: [],
    metadata: {},
    createdAt: makeDate(),
    ...overrides,
  }
}

export function makeDigest(overrides: Partial<Digest> = {}): Digest {
  return {
    id: nextId('dig'),
    sessionId: 'session-1',
    summary: 'A digest summary',
    keyTopics: ['topic1'],
    sourceEpisodeIds: [],
    sourceDigestIds: [],
    level: 0,
    embedding: null,
    metadata: {},
    createdAt: makeDate(),
    ...overrides,
  }
}
