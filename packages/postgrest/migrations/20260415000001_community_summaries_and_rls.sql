-- Wave 5: Community summaries cache table + RLS for all new tables.

-- Community summaries: read cache for MCP queries.
-- Source of truth is :Community nodes in Neo4j.
CREATE TABLE IF NOT EXISTS community_summaries (
  community_id     TEXT        NOT NULL PRIMARY KEY,
  project_id       TEXT,
  label            TEXT        NOT NULL,
  member_count     INTEGER     NOT NULL DEFAULT 0,
  top_entities     JSONB       NOT NULL DEFAULT '[]',
  top_topics       JSONB       NOT NULL DEFAULT '[]',
  top_persons      JSONB       NOT NULL DEFAULT '[]',
  dominant_emotion TEXT,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_project ON community_summaries(project_id);
CREATE INDEX IF NOT EXISTS idx_community_members ON community_summaries(member_count DESC);

-- Add project_id columns to memory tables (idempotent with IF NOT EXISTS).
ALTER TABLE memory_episodes    ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE memory_digests     ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE memory_semantic    ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE memory_procedural  ADD COLUMN IF NOT EXISTS project_id TEXT;

-- Indexes for project-scoped queries.
CREATE INDEX IF NOT EXISTS idx_episodes_project    ON memory_episodes(project_id)   WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_digests_project     ON memory_digests(project_id)    WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_semantic_project    ON memory_semantic(project_id)   WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_procedural_project  ON memory_procedural(project_id) WHERE project_id IS NOT NULL;

-- Enable RLS on all tables (idempotent — no error if already enabled).
ALTER TABLE community_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidation_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensory_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories            ENABLE ROW LEVEL SECURITY;

-- Service role full access policies (drop first for idempotency).
DO $$ BEGIN
  DROP POLICY IF EXISTS service_role_all ON community_summaries;
  DROP POLICY IF EXISTS service_role_all ON consolidation_runs;
  DROP POLICY IF EXISTS service_role_all ON sensory_snapshots;
  DROP POLICY IF EXISTS service_role_all ON memories;
END $$;

CREATE POLICY service_role_all ON community_summaries FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON consolidation_runs  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON sensory_snapshots   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON memories            FOR ALL TO service_role USING (true) WITH CHECK (true);
