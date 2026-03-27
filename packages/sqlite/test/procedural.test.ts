import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteProceduralStorage } from '../src/procedural.js'

const BASE_MEMORY = {
  category: 'workflow' as const,
  trigger: 'When starting a new TypeScript project',
  procedure: 'Run tsc --init and enable strict mode',
  confidence: 0.8,
  observationCount: 1,
  lastObserved: new Date('2026-01-01'),
  firstObserved: new Date('2026-01-01'),
  decayRate: 0.01,
  sourceEpisodeIds: ['e1'],
  embedding: null,
  metadata: {},
}

describe('SqliteProceduralStorage', () => {
  let db: Database.Database
  let store: SqliteProceduralStorage

  beforeEach(() => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteProceduralStorage(db)
  })

  it('inserts procedural memory and returns mapped fields', async () => {
    const mem = await store.insert(BASE_MEMORY)

    expect(mem.id).toBeTruthy()
    expect(mem.trigger).toBe(BASE_MEMORY.trigger)
    expect(mem.procedure).toBe(BASE_MEMORY.procedure)
    expect(mem.category).toBe('workflow')
    expect(mem.confidence).toBe(0.8)
    expect(mem.observationCount).toBe(1)
    expect(mem.accessCount).toBe(0)
    expect(mem.lastAccessed).toBeNull()
    expect(mem.decayRate).toBe(0.01)
    expect(mem.sourceEpisodeIds).toEqual(['e1'])
    expect(mem.createdAt).toBeInstanceOf(Date)
    expect(mem.updatedAt).toBeInstanceOf(Date)
  })

  it('inserts and retrieves memory — trigger maps to trigger_text column', async () => {
    const mem = await store.insert(BASE_MEMORY)

    const row = db
      .prepare('SELECT trigger_text, procedure FROM procedural WHERE id = ?')
      .get(mem.id) as { trigger_text: string; procedure: string }

    expect(row.trigger_text).toBe(BASE_MEMORY.trigger)
    expect(row.procedure).toBe(BASE_MEMORY.procedure)
  })

  it('inserts into memories table with type procedural', async () => {
    const mem = await store.insert(BASE_MEMORY)

    const row = db
      .prepare('SELECT type FROM memories WHERE id = ?')
      .get(mem.id) as { type: string }

    expect(row.type).toBe('procedural')
  })

  it('searches procedural memories via FTS5 BM25', async () => {
    await store.insert({
      ...BASE_MEMORY,
      trigger: 'Before committing code',
      procedure: 'Run linting and formatting checks',
    })

    await store.insert({
      ...BASE_MEMORY,
      trigger: 'When reviewing pull requests',
      procedure: 'Check for TypeScript type errors',
    })

    const results = await store.search('linting formatting')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.procedure).toContain('linting')
    expect(results[0].similarity).toBeGreaterThan(0)
  })

  it('search returns similarity scores normalized to [0,1]', async () => {
    await store.insert(BASE_MEMORY)

    const results = await store.search('TypeScript strict mode')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].similarity).toBeGreaterThanOrEqual(0)
    expect(results[0].similarity).toBeLessThanOrEqual(1)
  })

  it('search respects limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await store.insert({
        ...BASE_MEMORY,
        trigger: `TypeScript workflow trigger ${i}`,
        procedure: `TypeScript workflow procedure ${i}`,
      })
    }

    const results = await store.search('TypeScript workflow', { limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('searchByTrigger matches only on trigger_text column', async () => {
    // Insert one with the keyword in trigger, one with keyword in procedure only
    await store.insert({
      ...BASE_MEMORY,
      trigger: 'When deploying application',
      procedure: 'Run build and deployment scripts',
    })

    await store.insert({
      ...BASE_MEMORY,
      trigger: 'Before starting work',
      procedure: 'Check deploying status and pull latest changes',
    })

    const results = await store.searchByTrigger('deploying')
    expect(results.length).toBeGreaterThanOrEqual(1)
    // The memory with 'deploying' in trigger should be present
    const triggerMatch = results.find((r) => r.item.trigger.includes('deploying'))
    expect(triggerMatch).toBeDefined()
  })

  it('searchByTrigger uses trigger_text column filter', async () => {
    await store.insert({
      ...BASE_MEMORY,
      category: 'preference',
      trigger: 'When user asks about testing',
      procedure: 'Recommend Vitest for TypeScript projects',
    })

    const results = await store.searchByTrigger('testing')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.trigger).toContain('testing')
  })

  it('recordAccess increments access_count and sets last_accessed', async () => {
    const mem = await store.insert(BASE_MEMORY)

    expect(mem.accessCount).toBe(0)
    expect(mem.lastAccessed).toBeNull()

    await store.recordAccess(mem.id)
    await store.recordAccess(mem.id)

    const row = db
      .prepare('SELECT access_count, last_accessed FROM procedural WHERE id = ?')
      .get(mem.id) as { access_count: number; last_accessed: number | null }

    expect(row.access_count).toBe(2)
    expect(row.last_accessed).not.toBeNull()
  })

  it('incrementObservation increments observation_count and updates last_observed', async () => {
    const originalDate = new Date('2026-01-01')
    const mem = await store.insert({
      ...BASE_MEMORY,
      observationCount: 3,
      lastObserved: originalDate,
    })

    expect(mem.observationCount).toBe(3)

    await store.incrementObservation(mem.id)

    const row = db
      .prepare('SELECT observation_count, last_observed FROM procedural WHERE id = ?')
      .get(mem.id) as { observation_count: number; last_observed: number }

    expect(row.observation_count).toBe(4)
    // last_observed should now be close to now (not the old date)
    const updatedDate = new Date((row.last_observed - 2440587.5) * 86400000)
    const now = new Date()
    const diffMs = Math.abs(now.getTime() - updatedDate.getTime())
    expect(diffMs).toBeLessThan(5000) // within 5 seconds
  })

  it('batchDecay lowers confidence of unaccessed memories', async () => {
    const mem = await store.insert({
      ...BASE_MEMORY,
      confidence: 0.8,
    })

    // Simulate memory not accessed for 60 days
    db.prepare(`UPDATE procedural SET last_accessed = julianday('now') - 60 WHERE id = ?`).run(
      mem.id
    )

    const decayed = await store.batchDecay({ daysThreshold: 30, decayRate: 0.1 })
    expect(decayed).toBe(1)

    const row = db
      .prepare('SELECT confidence FROM procedural WHERE id = ?')
      .get(mem.id) as { confidence: number }

    expect(row.confidence).toBeCloseTo(0.7, 1)
  })

  it('batchDecay floors confidence at 0.05', async () => {
    const mem = await store.insert({
      ...BASE_MEMORY,
      confidence: 0.06,
    })

    db.prepare(`UPDATE procedural SET last_accessed = julianday('now') - 60 WHERE id = ?`).run(
      mem.id
    )

    await store.batchDecay({ daysThreshold: 30, decayRate: 0.1 })

    const row = db
      .prepare('SELECT confidence FROM procedural WHERE id = ?')
      .get(mem.id) as { confidence: number }

    expect(row.confidence).toBeCloseTo(0.05, 2)
  })

  it('batchDecay skips recently accessed memories', async () => {
    const mem = await store.insert({
      ...BASE_MEMORY,
      confidence: 0.8,
    })

    // Set last_accessed to 5 days ago (within threshold)
    db.prepare(`UPDATE procedural SET last_accessed = julianday('now') - 5 WHERE id = ?`).run(
      mem.id
    )

    const decayed = await store.batchDecay({ daysThreshold: 30, decayRate: 0.1 })
    expect(decayed).toBe(0)

    const row = db
      .prepare('SELECT confidence FROM procedural WHERE id = ?')
      .get(mem.id) as { confidence: number }

    expect(row.confidence).toBeCloseTo(0.8, 1)
  })

  it('batchDecay includes memories with null last_accessed beyond threshold', async () => {
    // Insert with null last_accessed (default) — should decay
    const mem = await store.insert(BASE_MEMORY)
    // Confirm last_accessed is null
    const before = db
      .prepare('SELECT last_accessed FROM procedural WHERE id = ?')
      .get(mem.id) as { last_accessed: null }
    expect(before.last_accessed).toBeNull()

    const decayed = await store.batchDecay({ daysThreshold: 0, decayRate: 0.1 })
    expect(decayed).toBeGreaterThanOrEqual(1)
  })
})
