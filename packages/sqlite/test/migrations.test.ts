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

  it('sets schema version to 7 after all migrations', () => {
    runMigrations(db)
    expect(getSchemaVersion(db)).toBe(7)
  })

  it('v5 adds forgotten_at to the recallable memory tables', () => {
    runMigrations(db)
    for (const table of ['episodes', 'semantic', 'procedural']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      expect(cols.some((c) => c.name === 'forgotten_at')).toBe(true)
    }
  })

  it('drops the unused episode_parts table and its index', () => {
    runMigrations(db)

    const objects = db
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('episode_parts', 'idx_episode_parts_episode')")
      .pluck()
      .all() as string[]

    expect(objects).toEqual([])
  })

  it('v7 stamps the digests that already exist and leaves later ones pending', () => {
    runMigrations(db)
    db.exec('DROP INDEX idx_digests_facts_pending')
    db.exec('ALTER TABLE digests DROP COLUMN facts_extracted_at')
    db.pragma('user_version = 6')

    const insertDigest = (id: string, createdAt: number) => {
      db.prepare('INSERT INTO memories (id, type) VALUES (?, ?)').run(id, 'digest')
      db.prepare(
        `INSERT INTO digests (id, session_id, summary, key_topics, source_episode_ids,
         source_digest_ids, level, metadata, created_at)
         VALUES (?, 's1', 'summary', '[]', '[]', '[]', 0, '{}', ?)`,
      ).run(id, createdAt)
    }
    insertDigest('old-1', 2461000.25)
    insertDigest('old-2', 2461001.5)

    runMigrations(db)
    expect(getSchemaVersion(db)).toBe(7)

    insertDigest('new-1', 2461002.75)
    const rows = db
      .prepare('SELECT id, created_at, facts_extracted_at FROM digests ORDER BY id')
      .all() as Array<{ id: string; created_at: number; facts_extracted_at: number | null }>

    expect(rows).toEqual([
      { id: 'new-1', created_at: 2461002.75, facts_extracted_at: null },
      { id: 'old-1', created_at: 2461000.25, facts_extracted_at: 2461000.25 },
      { id: 'old-2', created_at: 2461001.5, facts_extracted_at: 2461001.5 },
    ])
  })

  it('is idempotent (running twice does not error)', () => {
    runMigrations(db)
    runMigrations(db)
    expect(getSchemaVersion(db)).toBe(7)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'episode_parts'").pluck().all(),
    ).toEqual([])
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
