import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sqliteAdapter } from '@engram/sqlite'
import { createMemory } from '../src/create-memory.js'
import { Memory } from '../src/memory.js'
import type { StorageAdapter } from '../src/adapters/storage.js'
import type { IntelligenceAdapter } from '../src/adapters/intelligence.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStorage(): StorageAdapter {
  return sqliteAdapter() // in-memory SQLite
}

function makeMemory(storage: StorageAdapter): Memory {
  return createMemory({ storage })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('Memory — lifecycle', () => {
  it('createMemory() returns a Memory instance', () => {
    const storage = makeStorage()
    const memory = makeMemory(storage)
    expect(memory).toBeInstanceOf(Memory)
  })

  it('throws if operations called before initialize()', async () => {
    const storage = makeStorage()
    const memory = makeMemory(storage)
    await expect(
      memory.ingest({ role: 'user', content: 'hello' })
    ).rejects.toThrow('not initialized')
  })

  it('initialize() + dispose() completes without error', async () => {
    const storage = makeStorage()
    const memory = makeMemory(storage)
    await memory.initialize()
    await expect(memory.dispose()).resolves.not.toThrow()
  })

  it('dispose() is safe to call multiple times', async () => {
    const storage = makeStorage()
    const memory = makeMemory(storage)
    await memory.initialize()
    await memory.dispose()
    await expect(memory.dispose()).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ingest()
// ---------------------------------------------------------------------------

describe('Memory — ingest()', () => {
  let storage: StorageAdapter
  let memory: Memory

  beforeEach(async () => {
    storage = makeStorage()
    memory = makeMemory(storage)
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('stores an episode with computed salience', async () => {
    await memory.ingest({ role: 'user', content: 'I prefer TypeScript over JavaScript' })

    const episodes = await storage.episodes.search('TypeScript', { limit: 10 })
    expect(episodes.length).toBeGreaterThan(0)

    const ep = episodes[0].item
    // "I prefer" → salience 0.85+
    expect(ep.salience).toBeGreaterThanOrEqual(0.85)
    expect(ep.role).toBe('user')
    expect(ep.content).toBe('I prefer TypeScript over JavaScript')
  })

  it('extracts entities from message content', async () => {
    await memory.ingest({ role: 'user', content: 'We are building with TypeScript and React' })

    const episodes = await storage.episodes.search('TypeScript', { limit: 10 })
    expect(episodes.length).toBeGreaterThan(0)

    const ep = episodes[0].item
    expect(ep.entities).toContain('TypeScript')
    expect(ep.entities).toContain('React')
  })

  it('uses default sessionId when message.sessionId is omitted', async () => {
    await memory.ingest({ role: 'user', content: 'hello world' })

    const episodes = await storage.episodes.search('hello', { limit: 10 })
    expect(episodes.length).toBeGreaterThan(0)
    expect(episodes[0].item.sessionId).toBe('default')
  })

  it('respects provided sessionId', async () => {
    await memory.ingest({ role: 'user', content: 'session content', sessionId: 'test-session' })

    const episodes = await storage.episodes.getBySession('test-session')
    expect(episodes.length).toBe(1)
    expect(episodes[0].sessionId).toBe('test-session')
  })

  it('stores metadata from message', async () => {
    await memory.ingest({ role: 'assistant', content: 'noted', metadata: { source: 'test' } })

    const episodes = await storage.episodes.search('noted', { limit: 10 })
    expect(episodes.length).toBeGreaterThan(0)
    expect(episodes[0].item.metadata).toMatchObject({ source: 'test' })
  })
})

// ---------------------------------------------------------------------------
// ingestBatch()
// ---------------------------------------------------------------------------

describe('Memory — ingestBatch()', () => {
  let memory: Memory
  let storage: StorageAdapter

  beforeEach(async () => {
    storage = makeStorage()
    memory = makeMemory(storage)
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('stores multiple episodes', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'first message', sessionId: 'batch-session' },
      { role: 'assistant', content: 'second message', sessionId: 'batch-session' },
      { role: 'user', content: 'third message', sessionId: 'batch-session' },
    ])

    const episodes = await storage.episodes.getBySession('batch-session')
    expect(episodes).toHaveLength(3)
  })

  it('empty batch completes without error', async () => {
    await expect(memory.ingestBatch([])).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ingest() with intelligence adapter — embedding
// ---------------------------------------------------------------------------

describe('Memory — ingest() with intelligence adapter', () => {
  it('stores embedding on episode when intelligence.embed is configured', async () => {
    const storage = makeStorage()

    // Build a minimal fake embedding vector
    const fakeVector = [0.1, 0.2, 0.3, 0.4]
    const embedFn = vi.fn().mockResolvedValue(fakeVector)

    const intelligence: IntelligenceAdapter = { embed: embedFn }
    const memory = createMemory({ storage, intelligence })
    await memory.initialize()

    await memory.ingest({ role: 'user', content: 'TypeScript strict mode rocks' })

    // embed() must have been called exactly once with the message content
    expect(embedFn).toHaveBeenCalledOnce()
    expect(embedFn).toHaveBeenCalledWith('TypeScript strict mode rocks')

    // The stored episode must carry the embedding.
    // Float32Array round-trip through SQLite BLOB loses double precision,
    // so compare element-wise with toBeCloseTo.
    const episodes = await storage.episodes.search('TypeScript', { limit: 10 })
    expect(episodes.length).toBeGreaterThan(0)
    const ep = episodes[0].item
    expect(ep.embedding).not.toBeNull()
    expect(ep.embedding!.length).toBe(fakeVector.length)
    for (let i = 0; i < fakeVector.length; i++) {
      expect(ep.embedding![i]).toBeCloseTo(fakeVector[i], 5)
    }

    await memory.dispose()
  })

  it('stores null embedding when no intelligence adapter is configured', async () => {
    const storage = makeStorage()
    const memory = makeMemory(storage) // no intelligence adapter
    await memory.initialize()

    await memory.ingest({ role: 'user', content: 'TypeScript strict mode rocks' })

    const episodes = await storage.episodes.search('TypeScript', { limit: 10 })
    expect(episodes.length).toBeGreaterThan(0)
    expect(episodes[0].item.embedding).toBeNull()

    await memory.dispose()
  })

  it('stores episode without embedding when embed() throws (non-fatal)', async () => {
    const storage = makeStorage()
    const embedFn = vi.fn().mockRejectedValue(new Error('embedding service down'))
    const intelligence: IntelligenceAdapter = { embed: embedFn }
    const memory = createMemory({ storage, intelligence })
    await memory.initialize()

    // Should not throw even though embed() rejects
    await expect(
      memory.ingest({ role: 'user', content: 'hello world' })
    ).resolves.not.toThrow()

    // Episode is still stored — just without embedding
    const episodes = await storage.episodes.search('hello', { limit: 10 })
    expect(episodes.length).toBeGreaterThan(0)
    expect(episodes[0].item.embedding).toBeNull()

    await memory.dispose()
  })

  it('embeds all messages in ingestBatch', async () => {
    const storage = makeStorage()
    const embedFn = vi.fn().mockImplementation((text: string) =>
      Promise.resolve([text.length * 0.01, 0.5, 0.3])
    )
    const intelligence: IntelligenceAdapter = { embed: embedFn }
    const memory = createMemory({ storage, intelligence })
    await memory.initialize()

    await memory.ingestBatch([
      { role: 'user', content: 'first message', sessionId: 'emb-batch' },
      { role: 'assistant', content: 'second message', sessionId: 'emb-batch' },
    ])

    // embed() called once per message
    expect(embedFn).toHaveBeenCalledTimes(2)

    const episodes = await storage.episodes.getBySession('emb-batch')
    expect(episodes).toHaveLength(2)
    for (const ep of episodes) {
      expect(ep.embedding).not.toBeNull()
      expect(Array.isArray(ep.embedding)).toBe(true)
    }

    await memory.dispose()
  })
})

// ---------------------------------------------------------------------------
// recall()
// ---------------------------------------------------------------------------

describe('Memory — recall()', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = createMemory({ storage: makeStorage() })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('QUESTION intent returns relevant memories after ingestion', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'What is the TypeScript strict mode?', sessionId: 's1' },
      { role: 'assistant', content: 'TypeScript strict mode enables strict type checking', sessionId: 's1' },
      { role: 'user', content: 'How do I enable strict mode?', sessionId: 's1' },
      { role: 'assistant', content: 'Set strict: true in tsconfig.json', sessionId: 's1' },
      { role: 'user', content: 'Does it affect performance?', sessionId: 's1' },
    ])

    const result = await memory.recall('What is TypeScript strict mode?')

    expect(result).toHaveProperty('memories')
    expect(result).toHaveProperty('associations')
    expect(result).toHaveProperty('intent')
    expect(result).toHaveProperty('primed')
    expect(result).toHaveProperty('estimatedTokens')
    expect(result).toHaveProperty('formatted')

    expect(result.intent.type).toBe('QUESTION')
    expect(result.memories.length).toBeGreaterThan(0)
  })

  it('SOCIAL intent returns empty memories', async () => {
    await memory.ingest({ role: 'user', content: 'hello there' })

    const result = await memory.recall('hi')

    expect(result.intent.type).toBe('SOCIAL')
    expect(result.memories).toHaveLength(0)
    expect(result.associations).toHaveLength(0)
    expect(result.formatted).toBe('')
  })

  it('recall result has correct shape', async () => {
    const result = await memory.recall('What is the status of the project?')

    expect(Array.isArray(result.memories)).toBe(true)
    expect(Array.isArray(result.associations)).toBe(true)
    expect(Array.isArray(result.primed)).toBe(true)
    expect(typeof result.estimatedTokens).toBe('number')
    expect(typeof result.formatted).toBe('string')
    expect(result.intent).toBeDefined()
  })

  it('ticks sensory buffer priming after each recall', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'I prefer TypeScript for all projects', sessionId: 'p1' },
      { role: 'user', content: 'TypeScript strict mode is essential', sessionId: 'p1' },
      { role: 'user', content: 'TypeScript generics are powerful', sessionId: 'p1' },
    ])

    // First recall primes topics
    const r1 = await memory.recall('Tell me about TypeScript features')
    // Second recall: sensory buffer ticked after first
    const r2 = await memory.recall('TypeScript best practices')

    // Both results are valid RecallResults
    expect(r1.intent).toBeDefined()
    expect(r2.intent).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// consolidate()
// ---------------------------------------------------------------------------

describe('Memory — consolidate()', () => {
  let memory: Memory
  let storage: StorageAdapter

  beforeEach(async () => {
    storage = makeStorage()
    memory = createMemory({ storage })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('consolidate(light) creates digests from sufficient episodes', async () => {
    // lightSleep requires minEpisodes=5 by default
    await memory.ingestBatch([
      { role: 'user', content: 'I prefer TypeScript over JavaScript for large projects', sessionId: 'cs1' },
      { role: 'assistant', content: 'TypeScript strict mode enables strict type checking everywhere', sessionId: 'cs1' },
      { role: 'user', content: 'Let us go with TypeScript for the entire backend', sessionId: 'cs1' },
      { role: 'assistant', content: 'TypeScript generics help create reusable components', sessionId: 'cs1' },
      { role: 'user', content: 'We decided to use TypeScript strict mode in tsconfig', sessionId: 'cs1' },
    ])

    const result = await memory.consolidate('light')

    expect(result.cycle).toBe('light')
    expect(result.digestsCreated).toBeGreaterThan(0)
    expect(result.episodesProcessed).toBeGreaterThanOrEqual(5)

    const digests = await storage.digests.getBySession('cs1')
    expect(digests.length).toBeGreaterThan(0)
  })

  it('consolidate(light) returns 0 digests when fewer than 5 episodes', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'hello', sessionId: 'small-session' },
      { role: 'assistant', content: 'hi', sessionId: 'small-session' },
    ])

    const result = await memory.consolidate('light')

    expect(result.cycle).toBe('light')
    expect(result.digestsCreated).toBe(0)
  })

  it('consolidate(deep) returns a result with cycle=deep', async () => {
    const result = await memory.consolidate('deep')
    expect(result.cycle).toBe('deep')
  })

  it('consolidate(dream) returns a result with cycle=dream', async () => {
    const result = await memory.consolidate('dream')
    expect(result.cycle).toBe('dream')
  })

  it('consolidate(decay) returns a result with cycle=decay', async () => {
    const result = await memory.consolidate('decay')
    expect(result.cycle).toBe('decay')
  })

  it('consolidate(all) runs all cycles and returns merged result', async () => {
    const result = await memory.consolidate('all')

    expect(result.cycle).toBe('all')
    expect(result).toHaveProperty('digestsCreated')
    expect(result).toHaveProperty('episodesProcessed')
    expect(result).toHaveProperty('promoted')
    expect(result).toHaveProperty('procedural')
    expect(result).toHaveProperty('associationsCreated')
    expect(result).toHaveProperty('semanticDecayed')
    expect(result).toHaveProperty('proceduralDecayed')
    expect(result).toHaveProperty('edgesPruned')
  })

  it('consolidate() with no argument defaults to all', async () => {
    const result = await memory.consolidate()
    expect(result.cycle).toBe('all')
  })
})

// ---------------------------------------------------------------------------
// expand()
// ---------------------------------------------------------------------------

describe('Memory — expand()', () => {
  let memory: Memory
  let storage: StorageAdapter

  beforeEach(async () => {
    storage = makeStorage()
    memory = createMemory({ storage })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('retrieves original episodes from a digest', async () => {
    // Ingest enough episodes to trigger light sleep consolidation
    await memory.ingestBatch([
      { role: 'user', content: 'I prefer TypeScript over JavaScript for large projects', sessionId: 'ex1' },
      { role: 'assistant', content: 'TypeScript strict mode enables type checking everywhere', sessionId: 'ex1' },
      { role: 'user', content: 'Let us go with TypeScript for the entire backend', sessionId: 'ex1' },
      { role: 'assistant', content: 'TypeScript generics help create reusable typed components', sessionId: 'ex1' },
      { role: 'user', content: 'We decided to use TypeScript strict mode in tsconfig', sessionId: 'ex1' },
    ])

    await memory.consolidate('light')

    const digests = await storage.digests.getBySession('ex1')
    expect(digests.length).toBeGreaterThan(0)

    const digest = digests[0]
    const { episodes } = await memory.expand(digest.id)

    expect(episodes.length).toBeGreaterThan(0)
    expect(episodes.length).toBe(digest.sourceEpisodeIds.length)

    // Each returned episode should be one of the source episodes
    const returnedIds = new Set(episodes.map(e => e.id))
    for (const sourceId of digest.sourceEpisodeIds) {
      expect(returnedIds.has(sourceId)).toBe(true)
    }
  })

  it('returns empty episodes for unknown memoryId', async () => {
    const { episodes } = await memory.expand('nonexistent-id')
    expect(episodes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// stats()
// ---------------------------------------------------------------------------

describe('Memory — stats()', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = createMemory({ storage: makeStorage() })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('returns zero counts on empty storage', async () => {
    const s = await memory.stats()

    expect(s.episodes).toBe(0)
    expect(s.digests).toBe(0)
    expect(s.semantic).toBe(0)
    expect(s.procedural).toBe(0)
    expect(typeof s.associations).toBe('number')
  })

  it('counts episodes after ingestion', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'message one', sessionId: 'stats-test' },
      { role: 'assistant', content: 'message two', sessionId: 'stats-test' },
      { role: 'user', content: 'message three', sessionId: 'stats-test' },
    ])

    const s = await memory.stats()
    expect(s.episodes).toBe(3)
  })

  it('counts digests after light sleep consolidation', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'I prefer TypeScript over JavaScript', sessionId: 'st2' },
      { role: 'assistant', content: 'TypeScript provides strict type checking', sessionId: 'st2' },
      { role: 'user', content: 'Let us go with TypeScript for the project', sessionId: 'st2' },
      { role: 'assistant', content: 'TypeScript generics are very powerful', sessionId: 'st2' },
      { role: 'user', content: 'We decided to use TypeScript strict mode', sessionId: 'st2' },
    ])

    await memory.consolidate('light')

    const s = await memory.stats()
    expect(s.episodes).toBe(5)
    expect(s.digests).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// forget()
// ---------------------------------------------------------------------------

describe('Memory — forget()', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = createMemory({ storage: makeStorage() })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('returns preview without modifying when confirm=false (default)', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'I prefer TypeScript over JavaScript', sessionId: 'forget-s1' },
      { role: 'assistant', content: 'TypeScript strict mode enables type checking', sessionId: 'forget-s1' },
      { role: 'user', content: 'TypeScript generics are powerful features', sessionId: 'forget-s1' },
    ])

    const result = await memory.forget('TypeScript')

    // Should return structured result
    expect(result).toHaveProperty('count')
    expect(result).toHaveProperty('previewed')
    expect(Array.isArray(result.previewed)).toBe(true)
    expect(typeof result.count).toBe('number')
    // Count should match previewed length
    expect(result.count).toBe(result.previewed.length)
  })

  it('confirm=false does not change memory counts', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'I prefer TypeScript', sessionId: 'forget-s2' },
      { role: 'assistant', content: 'TypeScript is great', sessionId: 'forget-s2' },
      { role: 'user', content: 'TypeScript strict mode is important', sessionId: 'forget-s2' },
    ])

    const statsBefore = await memory.stats()
    await memory.forget('TypeScript') // confirm=false by default
    const statsAfter = await memory.stats()

    // Episode count should not change
    expect(statsAfter.episodes).toBe(statsBefore.episodes)
  })

  it('confirm=true returns count of deprioritized memories', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'I prefer TypeScript', sessionId: 'forget-s3' },
      { role: 'assistant', content: 'TypeScript strict mode is useful', sessionId: 'forget-s3' },
      { role: 'user', content: 'TypeScript generics are powerful', sessionId: 'forget-s3' },
    ])

    const result = await memory.forget('TypeScript', { confirm: true })

    expect(result).toHaveProperty('count')
    expect(result).toHaveProperty('previewed')
    expect(typeof result.count).toBe('number')
    expect(result.count).toBe(result.previewed.length)
  })
})

// ---------------------------------------------------------------------------
// session()
// ---------------------------------------------------------------------------

describe('Memory — session()', () => {
  let memory: Memory
  let storage: StorageAdapter

  beforeEach(async () => {
    storage = makeStorage()
    memory = createMemory({ storage })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('creates a session handle with a sessionId', () => {
    const handle = memory.session('my-session')
    expect(handle.sessionId).toBe('my-session')
  })

  it('auto-generates sessionId when omitted', () => {
    const handle = memory.session()
    expect(typeof handle.sessionId).toBe('string')
    expect(handle.sessionId.length).toBeGreaterThan(0)
  })

  it('different calls with no sessionId generate unique IDs', () => {
    const h1 = memory.session()
    const h2 = memory.session()
    expect(h1.sessionId).not.toBe(h2.sessionId)
  })

  it('session.ingest() stores episode under the session ID', async () => {
    const handle = memory.session('session-scope')

    await handle.ingest({ role: 'user', content: 'session scoped message' })

    const episodes = await storage.episodes.getBySession('session-scope')
    expect(episodes).toHaveLength(1)
    expect(episodes[0].content).toBe('session scoped message')
    expect(episodes[0].sessionId).toBe('session-scope')
  })

  it('session.ingest() correctly tags all messages with session ID', async () => {
    const sid = 'tagged-session'
    const handle = memory.session(sid)

    await handle.ingest({ role: 'user', content: 'message alpha' })
    await handle.ingest({ role: 'assistant', content: 'message beta' })
    await handle.ingest({ role: 'user', content: 'message gamma' })

    const episodes = await storage.episodes.getBySession(sid)
    expect(episodes).toHaveLength(3)
    for (const ep of episodes) {
      expect(ep.sessionId).toBe(sid)
    }
  })

  it('session.recall() returns a RecallResult', async () => {
    const handle = memory.session('recall-session')

    await handle.ingest({ role: 'user', content: 'TypeScript strict mode is important' })
    await handle.ingest({ role: 'assistant', content: 'Enable strict in tsconfig.json' })

    const result = await handle.recall('TypeScript strict mode')

    expect(result).toHaveProperty('memories')
    expect(result).toHaveProperty('intent')
    expect(result).toHaveProperty('formatted')
  })
})
