-- Backfill pass 3: correct pass 2's majority-vote mis-tags.
-- Run on prod: docker exec -i engram-postgres psql -U postgres -d engram < this-file
--
-- Pass 2 (2026-07-07-project-id-backfill-2-sessions.sql) propagated a
-- session's MAJORITY project onto its untagged episodes. That assumed a
-- session maps to one working directory — false for catch-all sessions:
-- direct memory_ingest calls without a session id share session_id
-- 'default' (382 episodes spanning 5 projects on prod), so majority vote
-- stamped the dominant project onto other projects' memories.
--
-- This pass recomputes the derived tags deterministically with a strict
-- UNANIMITY rule: session propagation applies only when every
-- metadata-tagged episode in the session carries the SAME project.
-- Mixed sessions get no propagation — their untagged rows return to NULL
-- (shared). Rows created after the fixed adapter went live
-- (2026-07-07 12:01:02 UTC, service restart with PR #47) are untouched:
-- their project_id was written by the adapter, not derived.

\set adapter_live '''2026-07-07 12:01:02+00'''

\echo '=== Before ==='
SELECT 'episodes' AS tier, count(*) AS rows, count(project_id) AS tagged FROM memory_episodes
UNION ALL SELECT 'digests', count(*), count(project_id) FROM memory_digests
UNION ALL SELECT 'semantic', count(*), count(project_id) FROM memory_semantic;

BEGIN;

\echo '=== 1. Reset derived episode tags (rows with no own metadata tag) ==='
UPDATE memory_episodes
SET project_id = NULL
WHERE created_at < :adapter_live
  AND coalesce(metadata->>'project', '') = ''
  AND project_id IS NOT NULL;

\echo '=== 2. Re-propagate: unanimous sessions only ==='
UPDATE memory_episodes e
SET project_id = sub.pid
FROM (
  SELECT session_id, min(metadata->>'project') AS pid
  FROM memory_episodes
  WHERE coalesce(metadata->>'project', '') <> ''
  GROUP BY session_id
  HAVING count(DISTINCT metadata->>'project') = 1
) sub
WHERE e.project_id IS NULL
  AND e.created_at < :adapter_live
  AND e.session_id = sub.session_id;

\echo '=== 3. Re-derive digests from scratch ==='
UPDATE memory_digests SET project_id = NULL WHERE created_at < :adapter_live;
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
WHERE d.id = sub.id AND d.created_at < :adapter_live;

\echo '=== 4. Re-derive semantic from scratch (digests, then episodes) ==='
UPDATE memory_semantic SET project_id = NULL WHERE created_at < :adapter_live;
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
WHERE s.id = sub.id AND s.created_at < :adapter_live;
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
WHERE s.id = sub.id AND s.created_at < :adapter_live;

COMMIT;

\echo '=== After ==='
SELECT 'episodes' AS tier, count(*) AS rows, count(project_id) AS tagged FROM memory_episodes
UNION ALL SELECT 'digests', count(*), count(project_id) FROM memory_digests
UNION ALL SELECT 'semantic', count(*), count(project_id) FROM memory_semantic;

\echo '=== Sanity: mixed catch-all sessions must have no derived tags ==='
SELECT e.session_id, count(*) FILTER (WHERE e.project_id IS NOT NULL AND coalesce(e.metadata->>'project','') = '' AND e.created_at < :adapter_live) AS bad_rows
FROM memory_episodes e
GROUP BY e.session_id
HAVING count(DISTINCT e.metadata->>'project') FILTER (WHERE coalesce(e.metadata->>'project','') <> '') > 1
ORDER BY 2 DESC LIMIT 5;
