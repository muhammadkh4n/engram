-- Migration 009: Add searchable_content column for retrieval pollution fix.
--
-- Root cause: vector search treats tool calls, user meta-queries, and system
-- metadata identically to real content because they share the same embedding.
-- The fix (LCM-style): store clean, searchable text in a separate column and
-- compute embeddings from that column instead of raw content.

-- Add searchable_content column (stores cleaned text for search)
ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS searchable_content text;

-- Backfill: for existing episodes, apply the same stripping logic as the
-- TypeScript extractSearchableContent() function:
--   1. Remove day-stamped brackets: [Sat 2026-03-28 05:56 GMT+5]
--   2. Remove [Tool call: …] markers
--   3. Remove "Conversation info (untrusted metadata):" … ``` blocks
--   4. Remove "System: […]" lines
UPDATE memory_episodes SET searchable_content =
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          content,
          '\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}[^\]]*\]',
          '', 'g'),
        '\[Tool call: [^\]]+\]\s*',
        '', 'g'),
      'Conversation info \(untrusted metadata\):.*?```\s*',
      '', 'gs'),
    '^System:\s*\[[^\]]*\]\s*',
    '', 'gm')
WHERE searchable_content IS NULL;

-- Re-create the fts generated column to use searchable_content when available.
-- A GENERATED column's expression cannot be altered in-place, so we drop and
-- re-add. The COALESCE ensures that rows without searchable_content (e.g.
-- legacy rows where backfill produced an empty string) still get indexed.
ALTER TABLE memory_episodes DROP COLUMN IF EXISTS fts;
ALTER TABLE memory_episodes ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(NULLIF(searchable_content, ''), content))
  ) STORED;

-- Re-create GIN index for full-text search
DROP INDEX IF EXISTS idx_episodes_fts;
CREATE INDEX idx_episodes_fts ON memory_episodes USING gin(fts);
