-- Migration 010: episode_parts table
--
-- Dual-storage architecture: episodes.content holds clean searchable text only.
-- episode_parts holds every ContentPart at full fidelity — tool calls, tool
-- results, reasoning, images. Nothing in this table is FTS-indexed. That is
-- the architectural point: tool call JSON cannot pollute text search.

CREATE TABLE IF NOT EXISTS episode_parts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id   uuid        NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
  ordinal      integer     NOT NULL,
  part_type    text        NOT NULL CHECK (part_type IN ('text', 'tool_call', 'tool_result', 'reasoning', 'image', 'other')),
  text_content text,
  tool_name    text,
  tool_input   jsonb,
  tool_output  jsonb,
  raw          jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episode_parts_episode ON episode_parts(episode_id);

-- Re-point the FTS tsvector to episodes.content directly.
-- episodes.content is now clean by construction (parseContent strips noise),
-- so we no longer need the searchable_content column as an intermediary.
-- The searchable_content column is left in place for backward compatibility
-- with existing rows, but new rows no longer need it.
-- The fts column is regenerated to use content instead of
-- COALESCE(searchable_content, content).

-- Note: if the fts generated column already uses content, this is a no-op.
-- If it uses COALESCE(searchable_content, content) from migration 009, we
-- drop and recreate it. Run this migration inside a transaction.

DO $$
BEGIN
  -- Drop the old fts column if it exists (safe because it is generated and
  -- recreated below)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_episodes' AND column_name = 'fts'
  ) THEN
    ALTER TABLE memory_episodes DROP COLUMN fts;
  END IF;

  -- Re-add fts generated column pointing directly at content
  ALTER TABLE memory_episodes
    ADD COLUMN fts tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

EXCEPTION WHEN others THEN
  -- If the column already exists in the correct form, ignore
  NULL;
END $$;

DROP INDEX IF EXISTS idx_episodes_fts;
CREATE INDEX IF NOT EXISTS idx_episodes_fts ON memory_episodes USING gin(fts);
