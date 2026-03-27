import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteAssociationStorage } from '../src/associations.js'

// ---------------------------------------------------------------------------
// Helpers — insert minimal rows that satisfy FK constraints
// ---------------------------------------------------------------------------

function insertMemory(
  db: Database.Database,
  id: string,
  type: 'episode' | 'digest' | 'semantic' | 'procedural'
): void {
  db.prepare('INSERT INTO memories (id, type) VALUES (?, ?)').run(id, type)
}

function insertEpisode(
  db: Database.Database,
  id: string,
  opts: { sessionId?: string; entities?: string[] } = {}
): void {
  insertMemory(db, id, 'episode')
  db.prepare(
    `INSERT INTO episodes
       (id, session_id, role, content, entities_json)
     VALUES (?, ?, 'user', 'test content', ?)`
  ).run(id, opts.sessionId ?? 'session-1', JSON.stringify(opts.entities ?? []))
}

function insertSemantic(db: Database.Database, id: string): void {
  insertMemory(db, id, 'semantic')
  db.prepare(
    `INSERT INTO semantic
       (id, topic, content, confidence, source_digest_ids, source_episode_ids, decay_rate, metadata)
     VALUES (?, 'test-topic', 'semantic content', 0.7, '[]', '[]', 0.02, '{}')`
  ).run(id)
}

function insertProcedural(db: Database.Database, id: string): void {
  insertMemory(db, id, 'procedural')
  db.prepare(
    `INSERT INTO procedural
       (id, category, trigger_text, procedure, confidence, source_episode_ids, metadata)
     VALUES (?, 'workflow', 'test trigger', 'do this', 0.6, '[]', '{}')`
  ).run(id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SqliteAssociationStorage', () => {
  let db: Database.Database
  let store: SqliteAssociationStorage

  beforeEach(() => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteAssociationStorage(db)
  })

  // -------------------------------------------------------------------------
  // insert
  // -------------------------------------------------------------------------

  it('insert: creates an edge between two memories', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')

    const assoc = await store.insert({
      sourceId: 'ep-1',
      sourceType: 'episode',
      targetId: 'sem-1',
      targetType: 'semantic',
      edgeType: 'topical',
      strength: 0.8,
      lastActivated: null,
      metadata: {},
    })

    expect(assoc.id).toBeTruthy()
    expect(assoc.sourceId).toBe('ep-1')
    expect(assoc.targetId).toBe('sem-1')
    expect(assoc.edgeType).toBe('topical')
    expect(assoc.strength).toBe(0.8)
    expect(assoc.createdAt).toBeInstanceOf(Date)
    expect(assoc.lastActivated).toBeNull()
  })

  // -------------------------------------------------------------------------
  // walk — 1-hop
  // -------------------------------------------------------------------------

  it('walk 1-hop: finds directly connected memory', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')

    await store.insert({
      sourceId: 'ep-1',
      sourceType: 'episode',
      targetId: 'sem-1',
      targetType: 'semantic',
      edgeType: 'topical',
      strength: 0.8,
      lastActivated: null,
      metadata: {},
    })

    const results = await store.walk(['ep-1'], { maxHops: 1 })

    expect(results).toHaveLength(1)
    expect(results[0].memoryId).toBe('sem-1')
    expect(results[0].memoryType).toBe('semantic')
    expect(results[0].depth).toBe(1)
    expect(results[0].pathStrength).toBeCloseTo(0.8)
  })

  // -------------------------------------------------------------------------
  // walk — 2-hop
  // -------------------------------------------------------------------------

  it('walk 2-hop: traverses episode→semantic→procedural chain', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')
    insertProcedural(db, 'proc-1')

    // ep-1 → sem-1
    await store.insert({
      sourceId: 'ep-1',
      sourceType: 'episode',
      targetId: 'sem-1',
      targetType: 'semantic',
      edgeType: 'topical',
      strength: 0.9,
      lastActivated: null,
      metadata: {},
    })

    // sem-1 → proc-1
    await store.insert({
      sourceId: 'sem-1',
      sourceType: 'semantic',
      targetId: 'proc-1',
      targetType: 'procedural',
      edgeType: 'causal',
      strength: 0.8,
      lastActivated: null,
      metadata: {},
    })

    const results = await store.walk(['ep-1'], { maxHops: 2 })

    const ids = results.map((r) => r.memoryId)
    expect(ids).toContain('sem-1')
    expect(ids).toContain('proc-1')

    const procResult = results.find((r) => r.memoryId === 'proc-1')!
    expect(procResult.depth).toBe(2)
    // path strength = 0.9 * 0.8 = 0.72
    expect(procResult.pathStrength).toBeCloseTo(0.72)
  })

  it('walk 2-hop: does NOT find 2nd-hop node when maxHops=1', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')
    insertProcedural(db, 'proc-1')

    await store.insert({
      sourceId: 'ep-1',
      sourceType: 'episode',
      targetId: 'sem-1',
      targetType: 'semantic',
      edgeType: 'topical',
      strength: 0.9,
      lastActivated: null,
      metadata: {},
    })
    await store.insert({
      sourceId: 'sem-1',
      sourceType: 'semantic',
      targetId: 'proc-1',
      targetType: 'procedural',
      edgeType: 'causal',
      strength: 0.8,
      lastActivated: null,
      metadata: {},
    })

    const results = await store.walk(['ep-1'], { maxHops: 1 })
    const ids = results.map((r) => r.memoryId)
    expect(ids).toContain('sem-1')
    expect(ids).not.toContain('proc-1')
  })

  // -------------------------------------------------------------------------
  // walk — cycle detection
  // -------------------------------------------------------------------------

  it('walk cycle detection: A→B and B→A does not loop infinitely', async () => {
    insertEpisode(db, 'ep-a')
    insertEpisode(db, 'ep-b')

    await store.insert({
      sourceId: 'ep-a',
      sourceType: 'episode',
      targetId: 'ep-b',
      targetType: 'episode',
      edgeType: 'temporal',
      strength: 0.7,
      lastActivated: null,
      metadata: {},
    })

    await store.insert({
      sourceId: 'ep-b',
      sourceType: 'episode',
      targetId: 'ep-a',
      targetType: 'episode',
      edgeType: 'temporal',
      strength: 0.7,
      lastActivated: null,
      metadata: {},
    })

    // Should complete without error and return only ep-b (depth 1), not loop
    const results = await store.walk(['ep-a'], { maxHops: 3 })
    const ids = results.map((r) => r.memoryId)

    // ep-a is the seed — must not appear as a result
    expect(ids).not.toContain('ep-a')
    // ep-b should appear exactly once
    expect(ids.filter((id) => id === 'ep-b')).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // upsertCoRecalled
  // -------------------------------------------------------------------------

  it('upsertCoRecalled: first call creates edge with strength 0.2', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')

    await store.upsertCoRecalled('ep-1', 'episode', 'sem-1', 'semantic')

    const row = db
      .prepare(
        `SELECT strength, edge_type FROM associations
         WHERE source_id = ? AND target_id = ? AND edge_type = 'co_recalled'`
      )
      .get('ep-1', 'sem-1') as { strength: number; edge_type: string } | undefined

    expect(row).toBeDefined()
    expect(row!.edge_type).toBe('co_recalled')
    expect(row!.strength).toBeCloseTo(0.2)
  })

  it('upsertCoRecalled: second call strengthens edge to 0.3', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')

    await store.upsertCoRecalled('ep-1', 'episode', 'sem-1', 'semantic')
    await store.upsertCoRecalled('ep-1', 'episode', 'sem-1', 'semantic')

    const row = db
      .prepare(
        `SELECT strength FROM associations
         WHERE source_id = ? AND target_id = ? AND edge_type = 'co_recalled'`
      )
      .get('ep-1', 'sem-1') as { strength: number } | undefined

    expect(row).toBeDefined()
    expect(row!.strength).toBeCloseTo(0.3)
  })

  it('upsertCoRecalled: caps strength at 1.0', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')

    // Call 10 times — would reach 1.1 without the MIN cap
    for (let i = 0; i < 10; i++) {
      await store.upsertCoRecalled('ep-1', 'episode', 'sem-1', 'semantic')
    }

    const row = db
      .prepare(
        `SELECT strength FROM associations
         WHERE source_id = ? AND target_id = ? AND edge_type = 'co_recalled'`
      )
      .get('ep-1', 'sem-1') as { strength: number } | undefined

    expect(row!.strength).toBeLessThanOrEqual(1.0)
  })

  // -------------------------------------------------------------------------
  // pruneWeak
  // -------------------------------------------------------------------------

  it('pruneWeak: deletes weak old edges', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')

    // Insert a very weak edge with no last_activated (treated as ancient)
    db.prepare(
      `INSERT INTO associations
         (id, source_id, source_type, target_id, target_type, edge_type, strength, metadata)
       VALUES ('weak-edge', 'ep-1', 'episode', 'sem-1', 'semantic', 'co_recalled', 0.04, '{}')`
    ).run()

    const deleted = await store.pruneWeak({ maxStrength: 0.1, olderThanDays: 0 })

    expect(deleted).toBe(1)
    const row = db
      .prepare("SELECT id FROM associations WHERE id = 'weak-edge'")
      .get()
    expect(row).toBeUndefined()
  })

  it('pruneWeak: preserves derives_from edges regardless of strength', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')

    // Insert a very weak derives_from edge — must survive pruning
    db.prepare(
      `INSERT INTO associations
         (id, source_id, source_type, target_id, target_type, edge_type, strength, metadata)
       VALUES ('provenance-edge', 'ep-1', 'episode', 'sem-1', 'semantic', 'derives_from', 0.04, '{}')`
    ).run()

    const deleted = await store.pruneWeak({ maxStrength: 0.1, olderThanDays: 0 })

    expect(deleted).toBe(0)
    const row = db
      .prepare("SELECT id FROM associations WHERE id = 'provenance-edge'")
      .get()
    expect(row).toBeDefined()
  })

  it('pruneWeak: does not delete edges that are strong enough', async () => {
    insertEpisode(db, 'ep-1')
    insertSemantic(db, 'sem-1')

    db.prepare(
      `INSERT INTO associations
         (id, source_id, source_type, target_id, target_type, edge_type, strength, metadata)
       VALUES ('strong-edge', 'ep-1', 'episode', 'sem-1', 'semantic', 'topical', 0.5, '{}')`
    ).run()

    const deleted = await store.pruneWeak({ maxStrength: 0.1, olderThanDays: 0 })

    expect(deleted).toBe(0)
  })

  // -------------------------------------------------------------------------
  // discoverTopicalEdges
  // -------------------------------------------------------------------------

  it('discoverTopicalEdges: finds episodes sharing an entity with no existing association', async () => {
    // Two episodes both mention "React" but have no association
    insertEpisode(db, 'ep-react-1', { entities: ['React', 'TypeScript'] })
    insertEpisode(db, 'ep-react-2', { entities: ['React', 'hooks'] })

    const edges = await store.discoverTopicalEdges({ daysLookback: 30, maxNew: 10 })

    expect(edges.length).toBeGreaterThanOrEqual(1)

    const pair = edges.find(
      (e) =>
        (e.sourceId === 'ep-react-1' && e.targetId === 'ep-react-2') ||
        (e.sourceId === 'ep-react-2' && e.targetId === 'ep-react-1')
    )
    expect(pair).toBeDefined()
    expect(pair!.sharedEntity).toBe('react') // lowercased
    expect(pair!.entityCount).toBeGreaterThanOrEqual(1)
    expect(pair!.sourceType).toBe('episode')
    expect(pair!.targetType).toBe('episode')
  })

  it('discoverTopicalEdges: excludes pairs that already have an association', async () => {
    insertEpisode(db, 'ep-a', { entities: ['Vue'] })
    insertEpisode(db, 'ep-b', { entities: ['Vue'] })

    // Pre-existing association between the two
    await store.insert({
      sourceId: 'ep-a',
      sourceType: 'episode',
      targetId: 'ep-b',
      targetType: 'episode',
      edgeType: 'topical',
      strength: 0.5,
      lastActivated: null,
      metadata: {},
    })

    const edges = await store.discoverTopicalEdges({ daysLookback: 30, maxNew: 10 })

    const pair = edges.find(
      (e) =>
        (e.sourceId === 'ep-a' && e.targetId === 'ep-b') ||
        (e.sourceId === 'ep-b' && e.targetId === 'ep-a')
    )
    expect(pair).toBeUndefined()
  })

  it('discoverTopicalEdges: returns empty when no entities match', async () => {
    insertEpisode(db, 'ep-x', { entities: ['Angular'] })
    insertEpisode(db, 'ep-y', { entities: ['Svelte'] })

    const edges = await store.discoverTopicalEdges({ daysLookback: 30, maxNew: 10 })
    expect(edges).toHaveLength(0)
  })

  it('discoverTopicalEdges: respects maxNew limit', async () => {
    // Insert 5 episodes all sharing 'SharedTopic'
    for (let i = 1; i <= 5; i++) {
      insertEpisode(db, `ep-shared-${i}`, { entities: ['SharedTopic'] })
    }

    const edges = await store.discoverTopicalEdges({ daysLookback: 30, maxNew: 3 })
    expect(edges.length).toBeLessThanOrEqual(3)
  })
})
