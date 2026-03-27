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
