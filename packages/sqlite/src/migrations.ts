import type Database from 'better-sqlite3'

const SCHEMA_V1 = `
-- Memory ID Pool (enables FK enforcement on polymorphic associations)
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT    NOT NULL PRIMARY KEY,
  type       TEXT    NOT NULL CHECK (type IN ('episode', 'digest', 'semantic', 'procedural')),
  created_at REAL    NOT NULL DEFAULT (julianday('now'))
);

-- Episodic Memory
CREATE TABLE IF NOT EXISTS episodes (
  id               TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  session_id       TEXT    NOT NULL,
  role             TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content          TEXT    NOT NULL,
  salience         REAL    NOT NULL DEFAULT 0.3 CHECK (salience >= 0.0 AND salience <= 1.0),
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed    REAL,
  consolidated_at  REAL,
  embedding        BLOB,
  entities_json    TEXT    NOT NULL DEFAULT '[]',
  entities_fts     TEXT    GENERATED ALWAYS AS (
                     replace(replace(replace(entities_json, '[', ''), ']', ''), '"', '')
                   ) VIRTUAL,
  metadata         TEXT    NOT NULL DEFAULT '{}',
  created_at       REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_episodes_session_salience ON episodes(session_id, salience DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_unconsolidated ON episodes(session_id, consolidated_at, salience DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_last_accessed ON episodes(last_accessed);

-- Digest Layer
CREATE TABLE IF NOT EXISTS digests (
  id                   TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  session_id           TEXT    NOT NULL,
  summary              TEXT    NOT NULL,
  key_topics           TEXT    NOT NULL DEFAULT '[]',
  source_episode_ids   TEXT    NOT NULL DEFAULT '[]',
  source_digest_ids    TEXT    NOT NULL DEFAULT '[]',
  level                INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0 AND level <= 10),
  embedding            BLOB,
  metadata             TEXT    NOT NULL DEFAULT '{}',
  created_at           REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_digests_session ON digests(session_id);
CREATE INDEX IF NOT EXISTS idx_digests_created ON digests(created_at DESC);

-- Semantic Memory
CREATE TABLE IF NOT EXISTS semantic (
  id                  TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  topic               TEXT    NOT NULL,
  content             TEXT    NOT NULL,
  confidence          REAL    NOT NULL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_digest_ids   TEXT    NOT NULL DEFAULT '[]',
  source_episode_ids  TEXT    NOT NULL DEFAULT '[]',
  access_count        INTEGER NOT NULL DEFAULT 0,
  last_accessed       REAL,
  decay_rate          REAL    NOT NULL DEFAULT 0.02 CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  supersedes          TEXT    REFERENCES memories(id),
  superseded_by       TEXT    REFERENCES memories(id),
  embedding           BLOB,
  metadata            TEXT    NOT NULL DEFAULT '{}',
  created_at          REAL    NOT NULL DEFAULT (julianday('now')),
  updated_at          REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_semantic_topic ON semantic(topic);
CREATE INDEX IF NOT EXISTS idx_semantic_confidence ON semantic(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_last_accessed ON semantic(last_accessed);
CREATE INDEX IF NOT EXISTS idx_semantic_created ON semantic(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_topic_confidence ON semantic(topic, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_supersedes ON semantic(supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_semantic_superseded_by ON semantic(superseded_by) WHERE superseded_by IS NOT NULL;

-- Procedural Memory
CREATE TABLE IF NOT EXISTS procedural (
  id                  TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  category            TEXT    NOT NULL CHECK (category IN ('workflow', 'preference', 'habit', 'pattern', 'convention')),
  trigger_text        TEXT    NOT NULL,
  procedure           TEXT    NOT NULL,
  confidence          REAL    NOT NULL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  observation_count   INTEGER NOT NULL DEFAULT 1,
  last_observed       REAL    NOT NULL DEFAULT (julianday('now')),
  first_observed      REAL    NOT NULL DEFAULT (julianday('now')),
  access_count        INTEGER NOT NULL DEFAULT 0,
  last_accessed       REAL,
  decay_rate          REAL    NOT NULL DEFAULT 0.01 CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  source_episode_ids  TEXT    NOT NULL DEFAULT '[]',
  embedding           BLOB,
  metadata            TEXT    NOT NULL DEFAULT '{}',
  created_at          REAL    NOT NULL DEFAULT (julianday('now')),
  updated_at          REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_procedural_category ON procedural(category);
CREATE INDEX IF NOT EXISTS idx_procedural_confidence ON procedural(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_procedural_last_accessed ON procedural(last_accessed);
CREATE INDEX IF NOT EXISTS idx_procedural_created ON procedural(created_at DESC);

-- Associative Network
CREATE TABLE IF NOT EXISTS associations (
  id              TEXT    NOT NULL PRIMARY KEY,
  source_id       TEXT    NOT NULL REFERENCES memories(id),
  source_type     TEXT    NOT NULL CHECK (source_type IN ('episode', 'digest', 'semantic', 'procedural')),
  target_id       TEXT    NOT NULL REFERENCES memories(id),
  target_type     TEXT    NOT NULL CHECK (target_type IN ('episode', 'digest', 'semantic', 'procedural')),
  edge_type       TEXT    NOT NULL CHECK (edge_type IN ('temporal', 'causal', 'topical', 'supports', 'contradicts', 'elaborates', 'derives_from', 'co_recalled')),
  strength        REAL    NOT NULL DEFAULT 0.3 CHECK (strength >= 0.0 AND strength <= 1.0),
  last_activated  REAL,
  metadata        TEXT    NOT NULL DEFAULT '{}',
  created_at      REAL    NOT NULL DEFAULT (julianday('now')),
  CONSTRAINT uq_association_pair UNIQUE (source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_assoc_source_strength ON associations(source_id, strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_target_strength ON associations(target_id, strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_prune ON associations(strength, last_activated) WHERE strength < 0.1;

-- Consolidation Run Tracking
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id           TEXT    NOT NULL PRIMARY KEY,
  cycle        TEXT    NOT NULL CHECK (cycle IN ('light', 'deep', 'dream', 'decay')),
  started_at   REAL    NOT NULL DEFAULT (julianday('now')),
  completed_at REAL,
  status       TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  metadata     TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_consolidation_runs_status ON consolidation_runs(status, started_at DESC);

-- Sensory Buffer Persistence
CREATE TABLE IF NOT EXISTS sensory_snapshots (
  session_id   TEXT    NOT NULL PRIMARY KEY,
  snapshot     TEXT    NOT NULL DEFAULT '{}',
  saved_at     REAL    NOT NULL DEFAULT (julianday('now'))
);
`

const FTS5_TABLES = `
-- FTS5 virtual tables
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  content, entities_fts,
  content=episodes, content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE VIRTUAL TABLE IF NOT EXISTS digests_fts USING fts5(
  summary, key_topics,
  content=digests, content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
  topic, content,
  content=semantic, content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE VIRTUAL TABLE IF NOT EXISTS procedural_fts USING fts5(
  trigger_text, procedure, category,
  content=procedural, content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);
`

const FTS5_TRIGGERS = `
-- Episodes FTS sync
CREATE TRIGGER IF NOT EXISTS episodes_fts_insert AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content, entities_fts) VALUES (new.rowid, new.content, new.entities_fts);
END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_update AFTER UPDATE OF content, entities_json ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, entities_fts) VALUES ('delete', old.rowid, old.content, old.entities_fts);
  INSERT INTO episodes_fts(rowid, content, entities_fts) VALUES (new.rowid, new.content, new.entities_fts);
END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_delete AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, entities_fts) VALUES ('delete', old.rowid, old.content, old.entities_fts);
END;

-- Digests FTS sync
CREATE TRIGGER IF NOT EXISTS digests_fts_insert AFTER INSERT ON digests BEGIN
  INSERT INTO digests_fts(rowid, summary, key_topics) VALUES (new.rowid, new.summary, new.key_topics);
END;
CREATE TRIGGER IF NOT EXISTS digests_fts_delete AFTER DELETE ON digests BEGIN
  INSERT INTO digests_fts(digests_fts, rowid, summary, key_topics) VALUES ('delete', old.rowid, old.summary, old.key_topics);
END;

-- Semantic FTS sync
CREATE TRIGGER IF NOT EXISTS semantic_fts_insert AFTER INSERT ON semantic BEGIN
  INSERT INTO semantic_fts(rowid, topic, content) VALUES (new.rowid, new.topic, new.content);
END;
CREATE TRIGGER IF NOT EXISTS semantic_fts_update AFTER UPDATE OF topic, content ON semantic BEGIN
  INSERT INTO semantic_fts(semantic_fts, rowid, topic, content) VALUES ('delete', old.rowid, old.topic, old.content);
  INSERT INTO semantic_fts(rowid, topic, content) VALUES (new.rowid, new.topic, new.content);
END;
CREATE TRIGGER IF NOT EXISTS semantic_fts_delete AFTER DELETE ON semantic BEGIN
  INSERT INTO semantic_fts(semantic_fts, rowid, topic, content) VALUES ('delete', old.rowid, old.topic, old.content);
END;

-- Procedural FTS sync
CREATE TRIGGER IF NOT EXISTS procedural_fts_insert AFTER INSERT ON procedural BEGIN
  INSERT INTO procedural_fts(rowid, trigger_text, procedure, category) VALUES (new.rowid, new.trigger_text, new.procedure, new.category);
END;
CREATE TRIGGER IF NOT EXISTS procedural_fts_update AFTER UPDATE OF trigger_text, procedure, category ON procedural BEGIN
  INSERT INTO procedural_fts(procedural_fts, rowid, trigger_text, procedure, category) VALUES ('delete', old.rowid, old.trigger_text, old.procedure, old.category);
  INSERT INTO procedural_fts(rowid, trigger_text, procedure, category) VALUES (new.rowid, new.trigger_text, new.procedure, new.category);
END;
CREATE TRIGGER IF NOT EXISTS procedural_fts_delete AFTER DELETE ON procedural BEGIN
  INSERT INTO procedural_fts(procedural_fts, rowid, trigger_text, procedure, category) VALUES ('delete', old.rowid, old.trigger_text, old.procedure, old.category);
END;

-- Auto-update updated_at triggers
CREATE TRIGGER IF NOT EXISTS semantic_updated_at AFTER UPDATE ON semantic BEGIN
  UPDATE semantic SET updated_at = julianday('now') WHERE id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS procedural_updated_at AFTER UPDATE ON procedural BEGIN
  UPDATE procedural SET updated_at = julianday('now') WHERE id = new.id;
END;
`

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number
}

/**
 * Whether FTS5 is available in the current SQLite build.
 * Set after the first runMigrations() call.
 * When false, episode/digest/semantic/procedural search falls back to LIKE queries.
 */
export let hasFts5 = true

const SCHEMA_V2 = `
-- Episode Parts: full-fidelity storage for every ContentPart in a message.
-- episodes.content holds clean searchable text only.
-- episode_parts holds tool calls, tool results, reasoning, images — nothing
-- in this table is indexed for search. That is the whole point.
CREATE TABLE IF NOT EXISTS episode_parts (
  id           TEXT    NOT NULL PRIMARY KEY,
  episode_id   TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  part_type    TEXT    NOT NULL CHECK (part_type IN ('text', 'tool_call', 'tool_result', 'reasoning', 'image', 'other')),
  text_content TEXT,
  tool_name    TEXT,
  tool_input   TEXT,
  tool_output  TEXT,
  raw          TEXT,
  created_at   REAL    NOT NULL DEFAULT (julianday('now'))
);
CREATE INDEX IF NOT EXISTS idx_episode_parts_episode ON episode_parts(episode_id);
`

export function runMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db)

  if (currentVersion < 1) {
    db.exec(SCHEMA_V1)

    try {
      db.exec(FTS5_TABLES)
      db.exec(FTS5_TRIGGERS)
      hasFts5 = true
    } catch (err) {
      hasFts5 = false
      console.warn(
        '[engram] FTS5 not available in this SQLite build — full-text search disabled, falling back to LIKE queries.',
        err instanceof Error ? err.message : String(err)
      )
      // Non-fatal: the core tables still work; FTS-based search simply won't function.
    }

    db.pragma('user_version = 1')
  }

  if (currentVersion < 2) {
    db.exec(SCHEMA_V2)
    db.pragma('user_version = 2')
  }

  if (currentVersion < 3) {
    // V3: Temporal validity columns on semantic table.
    // Half-open interval [valid_from, valid_until):
    //   valid_from  INCLUSIVE — memory becomes valid at this moment
    //   valid_until EXCLUSIVE — memory ceases to be valid at this moment
    // NULL valid_from  = always valid (epoch). NULL valid_until = still valid.
    const columns = db.prepare('PRAGMA table_info(semantic)').all() as Array<{ name: string }>
    const hasValidFrom = columns.some(c => c.name === 'valid_from')
    if (!hasValidFrom) {
      db.exec('ALTER TABLE semantic ADD COLUMN valid_from REAL')
      db.exec('ALTER TABLE semantic ADD COLUMN valid_until REAL')
    }
    // Backfill valid_from from created_at (idempotent)
    db.exec('UPDATE semantic SET valid_from = created_at WHERE valid_from IS NULL')
    // Backfill valid_until from the superseding memory's created_at
    db.exec(`
      UPDATE semantic SET valid_until = (
        SELECT s2.created_at FROM semantic s2
        WHERE s2.id = semantic.superseded_by LIMIT 1
      ) WHERE superseded_by IS NOT NULL AND valid_until IS NULL
    `)
    // Partial index for temporal queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_temporal
      ON semantic(valid_from, valid_until)
      WHERE valid_until IS NOT NULL
    `)
    db.pragma('user_version = 3')
  }

  if (currentVersion < 4) {
    // V4: Community summaries cache table + project_id columns on all memory tables.
    // community_summaries: read cache for MCP tool queries.
    // Source of truth is the :Community nodes in Neo4j.
    db.exec(`
      CREATE TABLE IF NOT EXISTS community_summaries (
        community_id     TEXT    NOT NULL PRIMARY KEY,
        project_id       TEXT,
        label            TEXT    NOT NULL,
        member_count     INTEGER NOT NULL DEFAULT 0,
        top_entities     TEXT    NOT NULL DEFAULT '[]',
        top_topics       TEXT    NOT NULL DEFAULT '[]',
        top_persons      TEXT    NOT NULL DEFAULT '[]',
        dominant_emotion TEXT,
        generated_at     REAL    NOT NULL DEFAULT (julianday('now')),
        updated_at       REAL    NOT NULL DEFAULT (julianday('now'))
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_community_project ON community_summaries(project_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_community_members ON community_summaries(member_count DESC)`)

    // project_id columns on all memory tables.
    // NULL = global (accessible from all projects, backward compatible).
    const tables = ['episodes', 'digests', 'semantic', 'procedural'] as const
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === 'project_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`)
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project_id) WHERE project_id IS NOT NULL`)
      }
    }

    db.pragma('user_version = 4')
  }
}
