import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteStorageAdapter } from '../src/adapter.js'
import type { SensorySnapshot } from '@engram-mem/core'

describe('SqliteStorageAdapter', () => {
  let adapter: SqliteStorageAdapter

  beforeEach(async () => {
    adapter = new SqliteStorageAdapter()
    await adapter.initialize()
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  it('initializes without error and exposes all sub-stores', () => {
    expect(adapter.episodes).toBeDefined()
    expect(adapter.digests).toBeDefined()
    expect(adapter.semantic).toBeDefined()
    expect(adapter.procedural).toBeDefined()
    expect(adapter.associations).toBeDefined()
  })

  it('throws before initialize() is called', async () => {
    const uninit = new SqliteStorageAdapter()
    expect(() => uninit.episodes).toThrow()
  })

  // ---------------------------------------------------------------------------
  // getById — discriminated union per type
  // ---------------------------------------------------------------------------

  it('getById returns null for a missing id', async () => {
    const result = await adapter.getById('does-not-exist', 'episode')
    expect(result).toBeNull()
  })

  it('getById returns correct TypedMemory for an episode', async () => {
    const ep = await adapter.episodes.insert({
      sessionId: 'session-a',
      role: 'user',
      content: 'TypeScript makes me happy',
      salience: 0.7,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null,
      entities: ['TypeScript'],
      metadata: {},
    })

    const result = await adapter.getById(ep.id, 'episode')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('episode')
    if (result!.type === 'episode') {
      expect(result.data.id).toBe(ep.id)
      expect(result.data.content).toBe('TypeScript makes me happy')
      expect(result.data.sessionId).toBe('session-a')
    }
  })

  it('getById returns correct TypedMemory for a digest', async () => {
    const digest = await adapter.digests.insert({
      sessionId: 'session-b',
      summary: 'Discussion about TypeScript best practices',
      keyTopics: ['TypeScript', 'best practices'],
      sourceEpisodeIds: [],
      sourceDigestIds: [],
      level: 0,
      embedding: null,
      metadata: {},
    })

    const result = await adapter.getById(digest.id, 'digest')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('digest')
    if (result!.type === 'digest') {
      expect(result.data.id).toBe(digest.id)
      expect(result.data.summary).toBe('Discussion about TypeScript best practices')
    }
  })

  it('getById returns correct TypedMemory for a semantic memory', async () => {
    const sem = await adapter.semantic.insert({
      topic: 'TypeScript strict mode',
      content: 'Always enable strict mode in tsconfig.json',
      confidence: 0.9,
      sourceDigestIds: [],
      sourceEpisodeIds: [],
      decayRate: 0.02,
      supersedes: null,
      supersededBy: null,
      embedding: null,
      metadata: {},
    })

    const result = await adapter.getById(sem.id, 'semantic')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('semantic')
    if (result!.type === 'semantic') {
      expect(result.data.id).toBe(sem.id)
      expect(result.data.topic).toBe('TypeScript strict mode')
      expect(result.data.confidence).toBe(0.9)
    }
  })

  it('getById returns correct TypedMemory for a procedural memory', async () => {
    const proc = await adapter.procedural.insert({
      category: 'workflow',
      trigger: 'starting a new TypeScript project',
      procedure: 'Run tsc --init and enable strict mode',
      confidence: 0.8,
      observationCount: 3,
      lastObserved: new Date(),
      firstObserved: new Date(),
      decayRate: 0.01,
      sourceEpisodeIds: [],
      embedding: null,
      metadata: {},
    })

    const result = await adapter.getById(proc.id, 'procedural')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('procedural')
    if (result!.type === 'procedural') {
      expect(result.data.id).toBe(proc.id)
      expect(result.data.trigger).toBe('starting a new TypeScript project')
    }
  })

  // ---------------------------------------------------------------------------
  // getByIds — batch mixed-type fetch
  // ---------------------------------------------------------------------------

  it('getByIds returns empty array for empty input', async () => {
    const results = await adapter.getByIds([])
    expect(results).toEqual([])
  })

  it('getByIds batch-fetches mixed memory types', async () => {
    const ep = await adapter.episodes.insert({
      sessionId: 's1', role: 'user', content: 'episode content',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    const sem = await adapter.semantic.insert({
      topic: 'batch fetch topic',
      content: 'semantic content for batch',
      confidence: 0.7,
      sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    const proc = await adapter.procedural.insert({
      category: 'habit',
      trigger: 'writing tests',
      procedure: 'always write tests first',
      confidence: 0.85,
      observationCount: 5,
      lastObserved: new Date(),
      firstObserved: new Date(),
      decayRate: 0.01,
      sourceEpisodeIds: [], embedding: null, metadata: {},
    })

    const results = await adapter.getByIds([
      { id: ep.id, type: 'episode' },
      { id: sem.id, type: 'semantic' },
      { id: proc.id, type: 'procedural' },
    ])

    expect(results).toHaveLength(3)
    const types = results.map((r) => r.type).sort()
    expect(types).toEqual(['episode', 'procedural', 'semantic'])

    const epResult = results.find((r) => r.type === 'episode')
    const semResult = results.find((r) => r.type === 'semantic')
    const procResult = results.find((r) => r.type === 'procedural')

    expect(epResult?.type === 'episode' && epResult.data.content).toBe('episode content')
    expect(semResult?.type === 'semantic' && semResult.data.topic).toBe('batch fetch topic')
    expect(procResult?.type === 'procedural' && procResult.data.trigger).toBe('writing tests')
  })

  it('getByIds includes digests in batch fetch', async () => {
    const digest = await adapter.digests.insert({
      sessionId: 's-digest',
      summary: 'digest for batch test',
      keyTopics: ['batch'],
      sourceEpisodeIds: [], sourceDigestIds: [],
      level: 0, embedding: null, metadata: {},
    })

    const results = await adapter.getByIds([{ id: digest.id, type: 'digest' }])
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('digest')
    if (results[0].type === 'digest') {
      expect(results[0].data.summary).toBe('digest for batch test')
    }
  })

  // ---------------------------------------------------------------------------
  // Sensory snapshot round-trip
  // ---------------------------------------------------------------------------

  it('saveSensorySnapshot and loadSensorySnapshot round-trip', async () => {
    const snapshot: SensorySnapshot = {
      sessionId: 'session-snap',
      items: [
        {
          key: 'current-task',
          value: 'implementing adapter tests',
          category: 'task',
          importance: 0.9,
          timestamp: Date.now(),
        },
      ],
      primedTopics: [
        {
          topic: 'TypeScript',
          boost: 0.5,
          decayRate: 0.1,
          source: 'user',
          turnsRemaining: 3,
        },
      ],
      savedAt: new Date('2026-03-27T12:00:00Z'),
    }

    await adapter.saveSensorySnapshot('session-snap', snapshot)
    const loaded = await adapter.loadSensorySnapshot('session-snap')

    expect(loaded).not.toBeNull()
    expect(loaded!.sessionId).toBe('session-snap')
    expect(loaded!.items).toHaveLength(1)
    expect(loaded!.items[0].key).toBe('current-task')
    expect(loaded!.items[0].value).toBe('implementing adapter tests')
    expect(loaded!.primedTopics).toHaveLength(1)
    expect(loaded!.primedTopics[0].topic).toBe('TypeScript')
    expect(loaded!.primedTopics[0].turnsRemaining).toBe(3)
  })

  it('loadSensorySnapshot returns null for unknown session', async () => {
    const result = await adapter.loadSensorySnapshot('no-such-session')
    expect(result).toBeNull()
  })

  it('saveSensorySnapshot is idempotent (INSERT OR REPLACE)', async () => {
    const snap1: SensorySnapshot = {
      sessionId: 'upsert-session',
      items: [{ key: 'k1', value: 'v1', category: 'context', importance: 0.5, timestamp: 1 }],
      primedTopics: [],
      savedAt: new Date(),
    }
    const snap2: SensorySnapshot = {
      sessionId: 'upsert-session',
      items: [{ key: 'k2', value: 'v2', category: 'entity', importance: 0.8, timestamp: 2 }],
      primedTopics: [],
      savedAt: new Date(),
    }

    await adapter.saveSensorySnapshot('upsert-session', snap1)
    await adapter.saveSensorySnapshot('upsert-session', snap2)

    const loaded = await adapter.loadSensorySnapshot('upsert-session')
    expect(loaded!.items[0].key).toBe('k2')
  })
})

// ---------------------------------------------------------------------------
// Integration: full lifecycle test (Task 11)
// ---------------------------------------------------------------------------

describe('SqliteStorageAdapter — full lifecycle integration', () => {
  let adapter: SqliteStorageAdapter

  beforeEach(async () => {
    adapter = new SqliteStorageAdapter()
    await adapter.initialize()
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  it('end-to-end: insert → search → associations → decay → snapshot → dispose', async () => {
    // Step 1: Insert 10 episodes across 2 sessions
    const session1 = 'session-alpha'
    const session2 = 'session-beta'

    const ep1 = await adapter.episodes.insert({
      sessionId: session1, role: 'user',
      content: 'I love using TypeScript for large projects',
      salience: 0.8, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['TypeScript'], metadata: {},
    })
    const ep2 = await adapter.episodes.insert({
      sessionId: session1, role: 'assistant',
      content: 'TypeScript provides excellent type safety and tooling',
      salience: 0.75, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['TypeScript', 'type safety'], metadata: {},
    })
    const ep3 = await adapter.episodes.insert({
      sessionId: session1, role: 'user',
      content: 'Can you show me how to configure vitest?',
      salience: 0.6, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['vitest'], metadata: {},
    })
    await adapter.episodes.insert({
      sessionId: session1, role: 'assistant',
      content: 'Sure, vitest configuration is straightforward',
      salience: 0.6, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['vitest'], metadata: {},
    })
    await adapter.episodes.insert({
      sessionId: session1, role: 'user',
      content: 'What is the best way to handle errors in TypeScript?',
      salience: 0.7, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['TypeScript', 'errors'], metadata: {},
    })

    await adapter.episodes.insert({
      sessionId: session2, role: 'user',
      content: 'I want to learn about React hooks',
      salience: 0.65, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['React', 'hooks'], metadata: {},
    })
    await adapter.episodes.insert({
      sessionId: session2, role: 'assistant',
      content: 'React hooks simplify state management in functional components',
      salience: 0.7, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['React', 'hooks', 'state'], metadata: {},
    })
    await adapter.episodes.insert({
      sessionId: session2, role: 'user',
      content: 'How does useEffect work exactly?',
      salience: 0.6, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['React', 'useEffect'], metadata: {},
    })
    await adapter.episodes.insert({
      sessionId: session2, role: 'assistant',
      content: 'useEffect runs after every render by default',
      salience: 0.65, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['React', 'useEffect'], metadata: {},
    })
    const ep10 = await adapter.episodes.insert({
      sessionId: session2, role: 'user',
      content: 'Can useEffect depend on a TypeScript type?',
      salience: 0.75, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['React', 'TypeScript'], metadata: {},
    })

    // Step 2: Search via FTS5
    const tsResults = await adapter.episodes.search('TypeScript')
    expect(tsResults.length).toBeGreaterThanOrEqual(1)
    expect(tsResults[0].similarity).toBeGreaterThan(0)

    const reactResults = await adapter.episodes.search('React hooks')
    expect(reactResults.length).toBeGreaterThanOrEqual(1)

    // Step 3: Insert 3 semantic memories
    const sem1 = await adapter.semantic.insert({
      topic: 'TypeScript',
      content: 'TypeScript is a typed superset of JavaScript',
      confidence: 0.95,
      sourceDigestIds: [], sourceEpisodeIds: [ep1.id, ep2.id],
      decayRate: 0.01, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })
    const sem2 = await adapter.semantic.insert({
      topic: 'Testing',
      content: 'Vitest is a fast unit test framework for Vite projects',
      confidence: 0.85,
      sourceDigestIds: [], sourceEpisodeIds: [ep3.id],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })
    await adapter.semantic.insert({
      topic: 'React',
      content: 'React hooks allow using state in functional components',
      confidence: 0.9,
      sourceDigestIds: [], sourceEpisodeIds: [ep10.id],
      decayRate: 0.015, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    // Step 4: Insert 2 procedural memories
    const proc1 = await adapter.procedural.insert({
      category: 'workflow',
      trigger: 'starting a new TypeScript project',
      procedure: 'Initialize with strict tsconfig, install vitest for testing',
      confidence: 0.8,
      observationCount: 5,
      lastObserved: new Date(),
      firstObserved: new Date(Date.now() - 7 * 86400000),
      decayRate: 0.01,
      sourceEpisodeIds: [ep1.id],
      embedding: null, metadata: {},
    })
    const proc2 = await adapter.procedural.insert({
      category: 'preference',
      trigger: 'choosing testing framework',
      procedure: 'Prefer vitest over jest for new TypeScript projects',
      confidence: 0.75,
      observationCount: 3,
      lastObserved: new Date(),
      firstObserved: new Date(Date.now() - 14 * 86400000),
      decayRate: 0.01,
      sourceEpisodeIds: [ep3.id],
      embedding: null, metadata: {},
    })

    // Step 5: Create association edges
    await adapter.associations.insert({
      sourceId: ep1.id,
      sourceType: 'episode',
      targetId: sem1.id,
      targetType: 'semantic',
      edgeType: 'derives_from',
      strength: 0.8,
      lastActivated: new Date(),
      metadata: {},
    })
    await adapter.associations.insert({
      sourceId: sem2.id,
      sourceType: 'semantic',
      targetId: proc1.id,
      targetType: 'procedural',
      edgeType: 'supports',
      strength: 0.7,
      lastActivated: new Date(),
      metadata: {},
    })
    await adapter.associations.insert({
      sourceId: proc1.id,
      sourceType: 'procedural',
      targetId: proc2.id,
      targetType: 'procedural',
      edgeType: 'topical',
      strength: 0.6,
      lastActivated: new Date(),
      metadata: {},
    })

    // Step 6: Walk the graph from ep1
    const walkResults = await adapter.associations.walk([ep1.id], { maxHops: 3, minStrength: 0.1 })
    expect(walkResults.length).toBeGreaterThanOrEqual(1)
    // Should find sem1 at depth 1
    const sem1Walk = walkResults.find((w) => w.memoryId === sem1.id)
    expect(sem1Walk).toBeDefined()
    expect(sem1Walk!.depth).toBe(1)

    // Step 7: Run batch decay on semantic and procedural
    // Decay with 0 days threshold so all records qualify
    const semanticDecayed = await adapter.semantic.batchDecay({ daysThreshold: 0, decayRate: 0.1 })
    const proceduralDecayed = await adapter.procedural.batchDecay({ daysThreshold: 0, decayRate: 0.1 })

    expect(semanticDecayed).toBeGreaterThanOrEqual(1)
    expect(proceduralDecayed).toBeGreaterThanOrEqual(1)

    // Verify semantic confidence dropped
    const sem1After = await adapter.getById(sem1.id, 'semantic')
    expect(sem1After!.type).toBe('semantic')
    if (sem1After!.type === 'semantic') {
      expect(sem1After.data.confidence).toBeLessThan(0.95)
    }

    // Step 8: Save and load sensory snapshot
    const snapshot: SensorySnapshot = {
      sessionId: session1,
      items: [
        { key: 'active-topic', value: 'TypeScript', category: 'topic', importance: 0.9, timestamp: Date.now() },
        { key: 'user-goal', value: 'learn testing', category: 'context', importance: 0.8, timestamp: Date.now() },
      ],
      primedTopics: [
        { topic: 'TypeScript', boost: 0.6, decayRate: 0.1, source: 'user', turnsRemaining: 5 },
        { topic: 'vitest', boost: 0.4, decayRate: 0.15, source: 'context', turnsRemaining: 3 },
      ],
      savedAt: new Date(),
    }

    await adapter.saveSensorySnapshot(session1, snapshot)
    const loadedSnap = await adapter.loadSensorySnapshot(session1)

    expect(loadedSnap).not.toBeNull()
    expect(loadedSnap!.items).toHaveLength(2)
    expect(loadedSnap!.primedTopics).toHaveLength(2)
    expect(loadedSnap!.primedTopics[0].topic).toBe('TypeScript')
    expect(loadedSnap!.primedTopics[1].topic).toBe('vitest')
    expect(loadedSnap!.items[0].key).toBe('active-topic')

    // Step 9: getById and getByIds cross-checks
    const epById = await adapter.getById(ep1.id, 'episode')
    expect(epById!.type).toBe('episode')

    const batchResults = await adapter.getByIds([
      { id: ep1.id, type: 'episode' },
      { id: sem1.id, type: 'semantic' },
      { id: proc2.id, type: 'procedural' },
    ])
    expect(batchResults).toHaveLength(3)

    // All types present
    const batchTypes = batchResults.map((r) => r.type).sort()
    expect(batchTypes).toEqual(['episode', 'procedural', 'semantic'])
  })
})
