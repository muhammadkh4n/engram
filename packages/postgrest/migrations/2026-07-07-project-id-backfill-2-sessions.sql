-- Backfill pass 2: session propagation + lineage re-roll.
-- Run on prod: docker exec -i engram-postgres psql -U postgres -d engram < this-file
--
-- Pass 1 (2026-07-07-project-id-backfill.sql) tagged episodes from their own
-- metadata->>'project'. Episodes ingested without that metadata (direct
-- memory_ingest clients that predate or skip the hook) stayed NULL — but a
-- session lives in exactly one working directory, so an untagged episode
-- whose session-mates are tagged inherits the session's majority project.
-- This is still derivation, not content classification: episodes in fully
-- untagged sessions remain NULL (shared).
--
-- After the episode pass, digests and semantic rows that previously had no
-- tagged lineage are re-rolled with the same lineage rules as pass 1.
-- Idempotent: every UPDATE only touches rows where project_id IS NULL.

\echo '=== Before ==='
SELECT 'episodes' AS tier, count(*) AS rows, count(project_id) AS tagged FROM memory_episodes
UNION ALL SELECT 'digests', count(*), count(project_id) FROM memory_digests
UNION ALL SELECT 'semantic', count(*), count(project_id) FROM memory_semantic;

BEGIN;

\echo '=== 1. Episodes from session majority ==='
UPDATE memory_episodes e
SET project_id = sub.pid
FROM (
  SELECT e2.session_id, mode() WITHIN GROUP (ORDER BY e3.project_id) AS pid
  FROM (SELECT DISTINCT session_id FROM memory_episodes WHERE project_id IS NULL) e2
  JOIN memory_episodes e3 ON e3.session_id = e2.session_id AND e3.project_id IS NOT NULL
  GROUP BY e2.session_id
) sub
WHERE e.project_id IS NULL AND e.session_id = sub.session_id;

\echo '=== 2. Digests from source episodes (majority) ==='
UPDATE memory_digests d
SET project_id = sub.pid
FROM (
  SELECT d2.id, mode() WITHIN GROUP (ORDER BY e.project_id) AS pid
  FROM memory_digests d2
  JOIN LATERAL unnest(d2.episode_ids) AS src(id) ON true
  JOIN memory_episodes e ON e.id = src.id
  WHERE d2.project_id IS NULL AND e.project_id IS NOT NULL
  GROUP BY d2.id
) sub
WHERE d.id = sub.id;

\echo '=== 3a. Semantic from source digests (majority) ==='
UPDATE memory_semantic s
SET project_id = sub.pid
FROM (
  SELECT s2.id, mode() WITHIN GROUP (ORDER BY d.project_id) AS pid
  FROM memory_semantic s2
  JOIN LATERAL unnest(s2.source_digest_ids) AS src(id) ON true
  JOIN memory_digests d ON d.id = src.id
  WHERE s2.project_id IS NULL AND d.project_id IS NOT NULL
  GROUP BY s2.id
) sub
WHERE s.id = sub.id;

\echo '=== 3b. Semantic from source episodes (fallback) ==='
UPDATE memory_semantic s
SET project_id = sub.pid
FROM (
  SELECT s2.id, mode() WITHIN GROUP (ORDER BY e.project_id) AS pid
  FROM memory_semantic s2
  JOIN LATERAL unnest(s2.source_episode_ids) AS src(id) ON true
  JOIN memory_episodes e ON e.id = src.id
  WHERE s2.project_id IS NULL AND e.project_id IS NOT NULL
  GROUP BY s2.id
) sub
WHERE s.id = sub.id;

COMMIT;

\echo '=== After ==='
SELECT 'episodes' AS tier, count(*) AS rows, count(project_id) AS tagged FROM memory_episodes
UNION ALL SELECT 'digests', count(*), count(project_id) FROM memory_digests
UNION ALL SELECT 'semantic', count(*), count(project_id) FROM memory_semantic;
