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
