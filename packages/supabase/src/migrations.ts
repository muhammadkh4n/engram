// =============================================================================
// Engram PostgreSQL Migrations
// Apply these SQL strings via Supabase dashboard, psql, or a migration tool.
// =============================================================================

/**
 * Migration 004: Add Engram columns to existing tables and rename memory_knowledge.
 * Applies on top of the legacy 001–003 migrations (initial schema, search functions,
 * enable RLS).
 */
export const MIGRATION_004 = /* sql */ `
-- Migration 004: Engram v1 — extend existing tables
-- Run this after 001_initial_schema, 002_search_functions, 003_enable_rls

-- Add missing columns to memory_episodes
ALTER TABLE memory_episodes
  ADD COLUMN IF NOT EXISTS salience       real         NOT NULL DEFAULT 0.3
    CHECK (salience >= 0.0 AND salience <= 1.0),
  ADD COLUMN IF NOT EXISTS access_count   integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed  timestamptz,
  ADD COLUMN IF NOT EXISTS consolidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS entities       text[]       NOT NULL DEFAULT '{}';

-- Add missing columns to memory_digests
ALTER TABLE memory_digests
  ADD COLUMN IF NOT EXISTS source_digest_ids uuid[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS level             integer  NOT NULL DEFAULT 0
    CHECK (level >= 0 AND level <= 10);

-- Rename memory_knowledge -> memory_semantic (catalog-only, instantaneous)
-- Skip if already renamed
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'memory_knowledge'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'memory_semantic'
  ) THEN
    ALTER TABLE memory_knowledge RENAME TO memory_semantic;
  END IF;
END $$;

-- Add missing columns to memory_semantic
ALTER TABLE memory_semantic
  ADD COLUMN IF NOT EXISTS source_episode_ids uuid[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS decay_rate         real        NOT NULL DEFAULT 0.02
    CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  ADD COLUMN IF NOT EXISTS supersedes         uuid        REFERENCES memories(id),
  ADD COLUMN IF NOT EXISTS superseded_by      uuid        REFERENCES memories(id),
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz NOT NULL DEFAULT now();

-- Record migration
INSERT INTO schema_migrations (version, checksum)
VALUES ('004_engram_v1', md5('004'))
ON CONFLICT DO NOTHING;
`

/**
 * Migration 005: Create new tables — memories pool, memory_procedural,
 * memory_associations, consolidation_runs, sensory_snapshots.
 */
export const MIGRATION_005 = /* sql */ `
-- Migration 005: New Engram tables

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Memory ID Pool (base table for FK integrity across all memory types)
CREATE TABLE IF NOT EXISTS memories (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text  NOT NULL
              CHECK (type IN ('episode', 'digest', 'semantic', 'procedural')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Episodic Memory (full schema — idempotent)
CREATE TABLE IF NOT EXISTS memory_episodes (
  id               uuid        PRIMARY KEY REFERENCES memories(id),
  session_id       text        NOT NULL,
  role             text        NOT NULL
                   CHECK (role IN ('user', 'assistant', 'system')),
  content          text        NOT NULL,
  salience         real        NOT NULL DEFAULT 0.3
                   CHECK (salience >= 0.0 AND salience <= 1.0),
  access_count     integer     NOT NULL DEFAULT 0,
  last_accessed    timestamptz,
  consolidated_at  timestamptz,
  embedding        vector(1536),
  entities         text[]      NOT NULL DEFAULT '{}',
  metadata         jsonb       NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodes_session
  ON memory_episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_episodes_unconsolidated
  ON memory_episodes(session_id, salience DESC)
  WHERE consolidated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_episodes_created
  ON memory_episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_last_accessed
  ON memory_episodes(last_accessed)
  WHERE last_accessed IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_episodes_entities
  ON memory_episodes USING GIN(entities);
CREATE INDEX IF NOT EXISTS idx_episodes_content_trgm
  ON memory_episodes USING GIN(content gin_trgm_ops);

-- Digest Layer
CREATE TABLE IF NOT EXISTS memory_digests (
  id                   uuid        PRIMARY KEY REFERENCES memories(id),
  session_id           text        NOT NULL,
  summary              text        NOT NULL,
  key_topics           text[]      NOT NULL DEFAULT '{}',
  source_episode_ids   uuid[]      NOT NULL DEFAULT '{}',
  source_digest_ids    uuid[]      NOT NULL DEFAULT '{}',
  level                integer     NOT NULL DEFAULT 0
                       CHECK (level >= 0 AND level <= 10),
  embedding            vector(1536),
  metadata             jsonb       NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_digests_session
  ON memory_digests(session_id);
CREATE INDEX IF NOT EXISTS idx_digests_created
  ON memory_digests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_digests_topics
  ON memory_digests USING GIN(key_topics);
CREATE INDEX IF NOT EXISTS idx_digests_source_episodes
  ON memory_digests USING GIN(source_episode_ids);

-- Semantic Memory
CREATE TABLE IF NOT EXISTS memory_semantic (
  id                  uuid        PRIMARY KEY REFERENCES memories(id),
  topic               text        NOT NULL,
  content             text        NOT NULL,
  confidence          real        NOT NULL DEFAULT 0.5
                      CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_digest_ids   uuid[]      NOT NULL DEFAULT '{}',
  source_episode_ids  uuid[]      NOT NULL DEFAULT '{}',
  access_count        integer     NOT NULL DEFAULT 0,
  last_accessed       timestamptz,
  decay_rate          real        NOT NULL DEFAULT 0.02
                      CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  supersedes          uuid        REFERENCES memories(id),
  superseded_by       uuid        REFERENCES memories(id),
  embedding           vector(1536),
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_semantic_topic
  ON memory_semantic(topic);
CREATE INDEX IF NOT EXISTS idx_semantic_confidence
  ON memory_semantic(confidence DESC)
  WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_semantic_last_accessed
  ON memory_semantic(last_accessed);
CREATE INDEX IF NOT EXISTS idx_semantic_created
  ON memory_semantic(created_at DESC);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'semantic_updated_at'
  ) THEN
    CREATE TRIGGER semantic_updated_at
    BEFORE UPDATE ON memory_semantic
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Procedural Memory
CREATE TABLE IF NOT EXISTS memory_procedural (
  id                  uuid        PRIMARY KEY REFERENCES memories(id),
  category            text        NOT NULL
                      CHECK (category IN ('workflow', 'preference', 'habit', 'pattern', 'convention')),
  trigger_text        text        NOT NULL,
  procedure           text        NOT NULL,
  confidence          real        NOT NULL DEFAULT 0.5
                      CHECK (confidence >= 0.0 AND confidence <= 1.0),
  observation_count   integer     NOT NULL DEFAULT 1,
  last_observed       timestamptz NOT NULL DEFAULT now(),
  first_observed      timestamptz NOT NULL DEFAULT now(),
  access_count        integer     NOT NULL DEFAULT 0,
  last_accessed       timestamptz,
  decay_rate          real        NOT NULL DEFAULT 0.01
                      CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  source_episode_ids  uuid[]      NOT NULL DEFAULT '{}',
  embedding           vector(1536),
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_procedural_category
  ON memory_procedural(category);
CREATE INDEX IF NOT EXISTS idx_procedural_confidence
  ON memory_procedural(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_procedural_last_accessed
  ON memory_procedural(last_accessed);
CREATE INDEX IF NOT EXISTS idx_procedural_created
  ON memory_procedural(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'procedural_updated_at'
  ) THEN
    CREATE TRIGGER procedural_updated_at
    BEFORE UPDATE ON memory_procedural
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Associative Network
CREATE TABLE IF NOT EXISTS memory_associations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid        NOT NULL REFERENCES memories(id),
  source_type     text        NOT NULL
                  CHECK (source_type IN ('episode', 'digest', 'semantic', 'procedural')),
  target_id       uuid        NOT NULL REFERENCES memories(id),
  target_type     text        NOT NULL
                  CHECK (target_type IN ('episode', 'digest', 'semantic', 'procedural')),
  edge_type       text        NOT NULL
                  CHECK (edge_type IN ('temporal', 'causal', 'topical', 'supports',
                                       'contradicts', 'elaborates', 'derives_from', 'co_recalled')),
  strength        real        NOT NULL DEFAULT 0.3
                  CHECK (strength >= 0.0 AND strength <= 1.0),
  last_activated  timestamptz,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_association_pair UNIQUE (source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_assoc_source_strength
  ON memory_associations(source_id, strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_target_strength
  ON memory_associations(target_id, strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_source_type_strength
  ON memory_associations(source_id, edge_type, strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_prune
  ON memory_associations(strength, last_activated)
  WHERE strength < 0.1;

-- Consolidation Run Tracking
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle        text        NOT NULL
               CHECK (cycle IN ('light', 'deep', 'dream', 'decay')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status       text        NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'completed', 'failed')),
  metadata     jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_consolidation_runs_status
  ON consolidation_runs(status, started_at DESC);

-- Sensory Buffer Persistence
CREATE TABLE IF NOT EXISTS sensory_snapshots (
  session_id  text        PRIMARY KEY,
  snapshot    jsonb       NOT NULL DEFAULT '{}',
  saved_at    timestamptz NOT NULL DEFAULT now()
);

-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text        NOT NULL
);

INSERT INTO schema_migrations (version, checksum) VALUES
  ('005_engram_tables', md5('005'))
ON CONFLICT DO NOTHING;
`

/**
 * Migration 006: RPC functions — engram_recall, engram_association_walk,
 * engram_record_access, engram_upsert_co_recalled, engram_decay_pass,
 * engram_dream_cycle.
 */
export const MIGRATION_006 = /* sql */ `
-- Migration 006: RPC Functions

-- Unified recall across all memory types
CREATE OR REPLACE FUNCTION engram_recall(
  p_query_embedding   vector,
  p_session_id        text        DEFAULT NULL,
  p_match_count       int         DEFAULT 10,
  p_min_similarity    float       DEFAULT 0.3,
  p_include_episodes  bool        DEFAULT true,
  p_include_digests   bool        DEFAULT true,
  p_include_semantic  bool        DEFAULT true,
  p_include_procedural bool       DEFAULT true
)
RETURNS TABLE (
  id           uuid,
  memory_type  text,
  content      text,
  salience     float,
  access_count int,
  created_at   timestamptz,
  similarity   float,
  entities     text[]
)
LANGUAGE sql STABLE PARALLEL SAFE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, 'episode'::text, content, salience::float, access_count,
         created_at, (1-(embedding<=>p_query_embedding))::float, entities
  FROM memory_episodes
  WHERE p_include_episodes AND embedding IS NOT NULL
    AND (p_session_id IS NULL OR session_id = p_session_id)
    AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
  ORDER BY embedding<=>p_query_embedding
  LIMIT p_match_count
  UNION ALL
  SELECT id, 'digest'::text, summary, 0.5::float, 0,
         created_at, (1-(embedding<=>p_query_embedding))::float, key_topics
  FROM memory_digests
  WHERE p_include_digests AND embedding IS NOT NULL
    AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
  ORDER BY embedding<=>p_query_embedding
  LIMIT p_match_count
  UNION ALL
  SELECT id, 'semantic'::text, content, confidence::float, access_count,
         created_at, (1-(embedding<=>p_query_embedding))::float, ARRAY[]::text[]
  FROM memory_semantic
  WHERE p_include_semantic AND embedding IS NOT NULL
    AND superseded_by IS NULL
    AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
  ORDER BY embedding<=>p_query_embedding
  LIMIT p_match_count
  UNION ALL
  SELECT id, 'procedural'::text, procedure, confidence::float, access_count,
         created_at, (1-(embedding<=>p_query_embedding))::float, ARRAY[]::text[]
  FROM memory_procedural
  WHERE p_include_procedural AND embedding IS NOT NULL
    AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
  ORDER BY embedding<=>p_query_embedding
  LIMIT p_match_count
$$;

-- Association walk (single SQL call, replaces N+1 queries)
CREATE OR REPLACE FUNCTION engram_association_walk(
  p_seed_ids    uuid[],
  p_max_hops    int   DEFAULT 2,
  p_min_strength float DEFAULT 0.2,
  p_limit       int   DEFAULT 20
)
RETURNS TABLE (
  memory_id    uuid,
  memory_type  text,
  depth        int,
  path_strength float
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE walk AS (
    SELECT
      s.id          AS memory_id,
      NULL::text    AS memory_type,
      0             AS depth,
      ARRAY[s.id]   AS visited_ids,
      1.0::float    AS path_strength
    FROM unnest(p_seed_ids) AS s(id)

    UNION ALL

    SELECT
      CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END,
      CASE WHEN a.source_id = w.memory_id THEN a.target_type ELSE a.source_type END,
      w.depth + 1,
      w.visited_ids ||
        (CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END),
      (w.path_strength * a.strength)::float
    FROM walk w
    JOIN memory_associations a ON
      (a.source_id = w.memory_id OR a.target_id = w.memory_id)
    WHERE
      w.depth < p_max_hops
      AND a.strength >= p_min_strength
      AND NOT (
        CASE WHEN a.source_id = w.memory_id THEN a.target_id
             ELSE a.source_id END
      ) = ANY(w.visited_ids)
  )
  SELECT DISTINCT ON (memory_id)
    memory_id,
    memory_type,
    depth,
    path_strength
  FROM walk
  WHERE depth > 0
  ORDER BY memory_id, path_strength DESC, depth ASC
  LIMIT p_limit;
$$;

-- Atomic reconsolidation update
CREATE OR REPLACE FUNCTION engram_record_access(
  p_id          uuid,
  p_memory_type text,
  p_conf_boost  float DEFAULT 0.0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_memory_type = 'episode' THEN
    UPDATE memory_episodes
    SET access_count = access_count + 1,
        last_accessed = now()
    WHERE id = p_id;

  ELSIF p_memory_type = 'semantic' THEN
    UPDATE memory_semantic
    SET access_count = access_count + 1,
        last_accessed = now(),
        confidence = LEAST(1.0, confidence + p_conf_boost),
        updated_at = now()
    WHERE id = p_id;

  ELSIF p_memory_type = 'procedural' THEN
    UPDATE memory_procedural
    SET access_count = access_count + 1,
        last_accessed = now(),
        confidence = LEAST(1.0, confidence + p_conf_boost),
        updated_at = now()
    WHERE id = p_id;
  END IF;
END;
$$;

-- Upsert co_recalled association
CREATE OR REPLACE FUNCTION engram_upsert_co_recalled(
  p_source_id    uuid,
  p_source_type  text,
  p_target_id    uuid,
  p_target_type  text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO memory_associations
    (source_id, source_type, target_id, target_type, edge_type, strength, last_activated)
  VALUES
    (p_source_id, p_source_type, p_target_id, p_target_type, 'co_recalled', 0.2, now())
  ON CONFLICT (source_id, target_id, edge_type) DO UPDATE SET
    strength = LEAST(1.0, memory_associations.strength + 0.1),
    last_activated = now();
$$;

-- Batch decay pass
CREATE OR REPLACE FUNCTION engram_decay_pass(
  p_semantic_decay_rate   float DEFAULT 0.02,
  p_procedural_decay_rate float DEFAULT 0.01,
  p_semantic_days         int   DEFAULT 30,
  p_procedural_days       int   DEFAULT 60,
  p_edge_prune_strength   float DEFAULT 0.05,
  p_edge_prune_days       int   DEFAULT 90
)
RETURNS TABLE (
  semantic_decayed   int,
  procedural_decayed int,
  edges_pruned       int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_semantic_decayed   int;
  v_procedural_decayed int;
  v_edges_pruned       int;
BEGIN
  UPDATE memory_semantic
  SET confidence = GREATEST(0.05, confidence - p_semantic_decay_rate),
      updated_at = now()
  WHERE confidence > 0.05
    AND (last_accessed IS NULL OR last_accessed < now() - (p_semantic_days || ' days')::interval);
  GET DIAGNOSTICS v_semantic_decayed = ROW_COUNT;

  UPDATE memory_procedural
  SET confidence = GREATEST(0.05, confidence - p_procedural_decay_rate),
      updated_at = now()
  WHERE confidence > 0.05
    AND (last_accessed IS NULL OR last_accessed < now() - (p_procedural_days || ' days')::interval);
  GET DIAGNOSTICS v_procedural_decayed = ROW_COUNT;

  DELETE FROM memory_associations
  WHERE strength < p_edge_prune_strength
    AND (last_activated IS NULL OR
         last_activated < now() - (p_edge_prune_days || ' days')::interval);
  GET DIAGNOSTICS v_edges_pruned = ROW_COUNT;

  RETURN QUERY SELECT v_semantic_decayed, v_procedural_decayed, v_edges_pruned;
END;
$$;

-- Dream cycle: SQL-side entity co-occurrence
CREATE OR REPLACE FUNCTION engram_dream_cycle(
  p_days_lookback        int DEFAULT 30,
  p_max_new_associations int DEFAULT 50
)
RETURNS TABLE (
  source_id     uuid,
  source_type   text,
  target_id     uuid,
  target_type   text,
  shared_entity text,
  entity_count  int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH entity_memories AS (
    SELECT e.id AS memory_id, 'episode'::text AS memory_type,
           LOWER(unnest(e.entities)) AS entity
    FROM memory_episodes e
    WHERE e.created_at >= now() - (p_days_lookback || ' days')::interval
      AND array_length(e.entities, 1) > 0

    UNION ALL

    SELECT s.id, 'semantic'::text, LOWER(s.topic)
    FROM memory_semantic s
    WHERE s.created_at >= now() - (p_days_lookback || ' days')::interval
  ),
  pairs AS (
    SELECT
      em1.memory_id   AS source_id,
      em1.memory_type AS source_type,
      em2.memory_id   AS target_id,
      em2.memory_type AS target_type,
      em1.entity      AS shared_entity,
      COUNT(*)        AS entity_count
    FROM entity_memories em1
    JOIN entity_memories em2
      ON em1.entity = em2.entity
      AND em1.memory_id < em2.memory_id
    WHERE NOT EXISTS (
      SELECT 1 FROM memory_associations a
      WHERE (a.source_id = em1.memory_id AND a.target_id = em2.memory_id)
         OR (a.source_id = em2.memory_id AND a.target_id = em1.memory_id)
    )
    GROUP BY em1.memory_id, em1.memory_type, em2.memory_id, em2.memory_type, em1.entity
  )
  SELECT source_id, source_type, target_id, target_type, shared_entity, entity_count::int
  FROM pairs
  ORDER BY entity_count DESC, source_id, target_id
  LIMIT p_max_new_associations;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('006_rpc_functions', md5('006'))
ON CONFLICT DO NOTHING;
`

/**
 * Migration 007: Row Level Security policies and GRANT statements.
 */
export const MIGRATION_007 = /* sql */ `
-- Migration 007: RLS policies

ALTER TABLE memories              ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_episodes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_digests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_semantic       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_procedural     ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_associations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidation_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensory_snapshots     ENABLE ROW LEVEL SECURITY;

-- Option A: Supabase Auth (user-specific memory isolation)
CREATE POLICY episodes_auth_policy ON memory_episodes
  FOR ALL USING (
    session_id LIKE ('agent:' || auth.uid()::text || ':%')
    OR auth.role() = 'service_role'
  );

CREATE POLICY digests_auth_policy ON memory_digests
  FOR ALL USING (
    session_id LIKE ('agent:' || auth.uid()::text || ':%')
    OR auth.role() = 'service_role'
  );

-- Semantic, procedural, associations: cross-session, service role only
CREATE POLICY semantic_auth_policy ON memory_semantic
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY procedural_auth_policy ON memory_procedural
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY associations_auth_policy ON memory_associations
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY consolidation_runs_policy ON consolidation_runs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY sensory_snapshots_policy ON sensory_snapshots
  FOR ALL USING (
    session_id LIKE ('agent:' || auth.uid()::text || ':%')
    OR auth.role() = 'service_role'
  );

CREATE POLICY memories_policy ON memories
  FOR ALL USING (auth.role() = 'service_role');

-- Grant execute on RPC functions
GRANT EXECUTE ON FUNCTION engram_recall TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_association_walk TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_record_access TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_upsert_co_recalled TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_decay_pass TO service_role;
GRANT EXECUTE ON FUNCTION engram_dream_cycle TO service_role;
GRANT EXECUTE ON FUNCTION update_updated_at_column TO service_role;

INSERT INTO schema_migrations (version, checksum)
VALUES ('007_rls_policies', md5('007'))
ON CONFLICT DO NOTHING;
`

/**
 * Returns all migration SQL concatenated in order.
 * Apply this to a fresh Supabase project or run each migration individually.
 */
export function getMigrationSQL(): string {
  return [MIGRATION_004, MIGRATION_005, MIGRATION_006, MIGRATION_007].join('\n\n')
}
