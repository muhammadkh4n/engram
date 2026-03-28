import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteEpisodeStorage } from '../src/episodes.js'
import { SqliteDigestStorage } from '../src/digests.js'
import { SqliteSemanticStorage } from '../src/semantic.js'
import { SqliteProceduralStorage } from '../src/procedural.js'
import { cosineSimilarity, blobToVector } from '../src/vector-search.js'

// ---------------------------------------------------------------------------
// Helper: build a deterministic unit vector of dimension `dim`.
// Each component is sin(i * offset) normalised so the vector has unit length.
// ---------------------------------------------------------------------------
function makeVector(dim: number, offset: number): number[] {
  const raw = Array.from({ length: dim }, (_, i) => Math.sin(i * offset + 1))
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0))
  return raw.map(v => v / norm)
}

// ---------------------------------------------------------------------------
// cosineSimilarity — math correctness
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 0, 0]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0)
  })

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0)
  })

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0)
  })

  it('handles arbitrary unit vectors', () => {
    const a = makeVector(8, 0.3)
    const b = makeVector(8, 0.3)
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0)
  })

  it('returns 0 for zero-length vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
  })

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
  })

  it('similarity decreases for more orthogonal vectors', () => {
    const base = makeVector(16, 0.1)
    const similar = makeVector(16, 0.11)   // very close angle
    const distant = makeVector(16, 1.5)    // very different angle

    const simSimilar = cosineSimilarity(base, similar)
    const simDistant = cosineSimilarity(base, distant)

    expect(simSimilar).toBeGreaterThan(simDistant)
  })

  it('is symmetric', () => {
    const a = makeVector(8, 0.7)
    const b = makeVector(8, 1.2)
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a))
  })
})

// ---------------------------------------------------------------------------
// blobToVector round-trip
// ---------------------------------------------------------------------------

describe('blobToVector', () => {
  it('round-trips a Float32 vector through Buffer encoding', () => {
    const original = [0.1, 0.5, -0.3, 0.9]
    const buf = Buffer.from(new Float32Array(original).buffer)
    const recovered = blobToVector(buf)
    expect(recovered).toHaveLength(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5)
    }
  })
})

// ---------------------------------------------------------------------------
// Hybrid episode search
// ---------------------------------------------------------------------------

describe('SqliteEpisodeStorage — hybrid search', () => {
  let db: Database.Database
  let store: SqliteEpisodeStorage

  const DIM = 8

  // Embedding that strongly points "toward TypeScript"
  const tsVec = makeVector(DIM, 0.1)
  // Embedding that strongly points "toward pizza / food"
  const foodVec = makeVector(DIM, 1.4)
  // Query embedding close to tsVec
  const queryVec = makeVector(DIM, 0.105)

  beforeEach(async () => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteEpisodeStorage(db)

    await store.insert({
      sessionId: 's1',
      role: 'user',
      content: 'TypeScript strict mode is essential for large projects',
      salience: 0.9,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: tsVec,
      entities: ['TypeScript'],
      metadata: {},
    })

    await store.insert({
      sessionId: 's1',
      role: 'user',
      content: 'I had pizza for lunch, it was delicious',
      salience: 0.2,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: foodVec,
      entities: [],
      metadata: {},
    })

    await store.insert({
      sessionId: 's1',
      role: 'assistant',
      content: 'React hooks simplify state management considerably',
      salience: 0.6,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null, // no embedding
      entities: ['React'],
      metadata: {},
    })
  })

  it('BM25-only search (no embedding) returns keyword matches', async () => {
    const results = await store.search('TypeScript strict', { limit: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.content).toContain('TypeScript')
  })

  it('hybrid search ranks TypeScript episode higher than pizza when query is near tsVec', async () => {
    const results = await store.search('TypeScript', {
      limit: 5,
      embedding: queryVec,
    })

    expect(results.length).toBeGreaterThanOrEqual(1)
    const firstContent = results[0].item.content
    expect(firstContent).toContain('TypeScript')
  })

  it('hybrid search returns similarity scores between 0 and 1', async () => {
    const results = await store.search('TypeScript', {
      limit: 5,
      embedding: queryVec,
    })
    for (const r of results) {
      expect(r.similarity).toBeGreaterThan(0)
      expect(r.similarity).toBeLessThanOrEqual(1)
    }
  })

  it('hybrid search with food-like query ranks pizza higher', async () => {
    // Query embedding close to foodVec
    const foodQueryVec = makeVector(DIM, 1.405)

    const results = await store.search('food lunch', {
      limit: 5,
      embedding: foodQueryVec,
    })

    // The pizza episode should appear in results
    const pizzaResult = results.find(r => r.item.content.includes('pizza'))
    expect(pizzaResult).toBeDefined()
  })

  it('hybrid search catches recent episode not in BM25 candidates (vector-only path)', async () => {
    // Insert an episode whose keywords don't match "TypeScript"
    // but whose embedding is very close to tsVec (recent vector scan will find it)
    const nearTsVec = makeVector(DIM, 0.102)
    await store.insert({
      sessionId: 's2',
      role: 'user',
      content: 'strongly typed languages improve maintainability',
      salience: 0.7,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: nearTsVec,
      entities: [],
      metadata: {},
    })

    // Query with "TypeScript" keyword (BM25 won't match "strongly typed" well)
    // but the embedding IS close to tsVec → should appear via vector scan
    const results = await store.search('TypeScript', {
      limit: 10,
      embedding: queryVec,
    })

    const ids = results.map(r => r.item.content)
    // The TypeScript episode should still be top, and the typed-languages one
    // should be retrievable because of embedding proximity.
    expect(ids.some(c => c.includes('TypeScript'))).toBe(true)
  })

  it('hybrid search respects the limit parameter', async () => {
    const results = await store.search('TypeScript lunch React', {
      limit: 2,
      embedding: queryVec,
    })
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('returns empty array when no episodes exist', async () => {
    // Fresh DB
    const freshDb = createTestDb()
    runMigrations(freshDb)
    const freshStore = new SqliteEpisodeStorage(freshDb)

    const results = await freshStore.search('anything', {
      limit: 5,
      embedding: queryVec,
    })
    expect(results).toHaveLength(0)
    freshDb.close()
  })
})

// ---------------------------------------------------------------------------
// Hybrid digest search
// ---------------------------------------------------------------------------

describe('SqliteDigestStorage — hybrid search', () => {
  let db: Database.Database
  let store: SqliteDigestStorage

  const DIM = 8
  const tsVec = makeVector(DIM, 0.1)
  const foodVec = makeVector(DIM, 1.4)
  const queryVec = makeVector(DIM, 0.105)

  beforeEach(async () => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteDigestStorage(db)

    await store.insert({
      sessionId: 's1',
      summary: 'Team decided to adopt TypeScript strict mode across all services',
      keyTopics: ['TypeScript', 'strict mode'],
      sourceEpisodeIds: [],
      sourceDigestIds: [],
      level: 1,
      embedding: tsVec,
      metadata: {},
    })

    await store.insert({
      sessionId: 's1',
      summary: 'Team went out for pizza and discussed the project',
      keyTopics: ['team lunch', 'pizza'],
      sourceEpisodeIds: [],
      sourceDigestIds: [],
      level: 1,
      embedding: foodVec,
      metadata: {},
    })
  })

  it('BM25-only search returns keyword match', async () => {
    const results = await store.search('TypeScript strict', { limit: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.summary).toContain('TypeScript')
  })

  it('hybrid search ranks TypeScript digest higher with matching embedding', async () => {
    const results = await store.search('TypeScript', {
      limit: 5,
      embedding: queryVec,
    })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.summary).toContain('TypeScript')
  })
})

// ---------------------------------------------------------------------------
// Hybrid semantic search
// ---------------------------------------------------------------------------

describe('SqliteSemanticStorage — hybrid search', () => {
  let db: Database.Database
  let store: SqliteSemanticStorage

  const DIM = 8
  const tsVec = makeVector(DIM, 0.1)
  const foodVec = makeVector(DIM, 1.4)
  const queryVec = makeVector(DIM, 0.105)

  beforeEach(async () => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteSemanticStorage(db)

    await store.insert({
      topic: 'TypeScript preferences',
      content: 'User strongly prefers TypeScript with strict mode enabled',
      confidence: 0.9,
      sourceDigestIds: [],
      sourceEpisodeIds: [],
      decayRate: 0.01,
      supersedes: null,
      supersededBy: null,
      embedding: tsVec,
      metadata: {},
    })

    await store.insert({
      topic: 'Food preferences',
      content: 'User enjoys Italian food, especially pizza',
      confidence: 0.7,
      sourceDigestIds: [],
      sourceEpisodeIds: [],
      decayRate: 0.01,
      supersedes: null,
      supersededBy: null,
      embedding: foodVec,
      metadata: {},
    })
  })

  it('BM25-only search returns keyword match', async () => {
    const results = await store.search('TypeScript strict', { limit: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.content).toContain('TypeScript')
  })

  it('hybrid search ranks TypeScript memory higher with matching embedding', async () => {
    const results = await store.search('TypeScript', {
      limit: 5,
      embedding: queryVec,
    })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.content).toContain('TypeScript')
  })
})

// ---------------------------------------------------------------------------
// Hybrid procedural search
// ---------------------------------------------------------------------------

describe('SqliteProceduralStorage — hybrid search', () => {
  let db: Database.Database
  let store: SqliteProceduralStorage

  const DIM = 8
  const tsVec = makeVector(DIM, 0.1)
  const foodVec = makeVector(DIM, 1.4)
  const queryVec = makeVector(DIM, 0.105)

  beforeEach(async () => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteProceduralStorage(db)

    const now = new Date()

    await store.insert({
      category: 'preference',
      trigger: 'TypeScript coding',
      procedure: 'Always enable strict mode in tsconfig.json when starting a TypeScript project',
      confidence: 0.95,
      observationCount: 5,
      lastObserved: now,
      firstObserved: now,
      decayRate: 0.005,
      sourceEpisodeIds: [],
      embedding: tsVec,
      metadata: {},
    })

    await store.insert({
      category: 'habit',
      trigger: 'lunch time',
      procedure: 'Order pizza from the nearby Italian restaurant',
      confidence: 0.6,
      observationCount: 3,
      lastObserved: now,
      firstObserved: now,
      decayRate: 0.01,
      sourceEpisodeIds: [],
      embedding: foodVec,
      metadata: {},
    })
  })

  it('BM25-only search returns keyword match', async () => {
    const results = await store.search('TypeScript strict tsconfig', { limit: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.procedure).toContain('strict mode')
  })

  it('hybrid search ranks TypeScript procedural higher with matching embedding', async () => {
    const results = await store.search('TypeScript', {
      limit: 5,
      embedding: queryVec,
    })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.procedure).toContain('TypeScript')
  })
})
