-- Backfill project_id across all memory tiers.
--
-- Until 2026-07-07 the PostgREST adapter never wrote project_id (and its row
-- mappers never read it), so the entire corpus is untagged and scoped recall
-- degenerates to an unscoped search: the retrieval RPCs filter with
-- (project_id = :p OR project_id IS NULL), and all-NULL means everything
-- matches every scope. The tag was never lost, though — the ingest hook has
-- been storing it as metadata->>'project' on episodes all along, so tags are
-- derivable, not guessed:
--
--   1. episodes:  from their own metadata->>'project'
--   2. digests:   majority project of their source episodes (episode_ids)
--   3. semantic:  majority project of their source digests, falling back to
--                 source episodes for rows with no digest lineage
--   4. procedural: majority project of their source episodes
--
-- Untagged rows stay NULL (= shared, visible in every scope). Idempotent:
-- every UPDATE only touches rows where project_id IS NULL.

\echo '=== Before: live rows / tagged, per tier ==='
SELECT 'episodes' AS tier, count(*) AS rows, count(project_id) AS tagged FROM memory_episodes
UNION ALL SELECT 'digests', count(*), count(project_id) FROM memory_digests
UNION ALL SELECT 'semantic', count(*), count(project_id) FROM memory_semantic
UNION ALL SELECT 'procedural', count(*), count(project_id) FROM memory_procedural;

BEGIN;

\echo '=== 1. Episodes from metadata->>project ==='
UPDATE memory_episodes
SET project_id = metadata->>'project'
WHERE project_id IS NULL
  AND coalesce(metadata->>'project', '') <> '';

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

\echo '=== 3b. Semantic still untagged: fall back to source episodes ==='
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

\echo '=== 4. Procedural from source episodes (majority) ==='
UPDATE memory_procedural p
SET project_id = sub.pid
FROM (
  SELECT p2.id, mode() WITHIN GROUP (ORDER BY e.project_id) AS pid
  FROM memory_procedural p2
  JOIN LATERAL unnest(p2.source_episode_ids) AS src(id) ON true
  JOIN memory_episodes e ON e.id = src.id
  WHERE p2.project_id IS NULL AND e.project_id IS NOT NULL
  GROUP BY p2.id
) sub
WHERE p.id = sub.id;

COMMIT;

\echo '=== After: rows / tagged, per tier ==='
SELECT 'episodes' AS tier, count(*) AS rows, count(project_id) AS tagged FROM memory_episodes
UNION ALL SELECT 'digests', count(*), count(project_id) FROM memory_digests
UNION ALL SELECT 'semantic', count(*), count(project_id) FROM memory_semantic
UNION ALL SELECT 'procedural', count(*), count(project_id) FROM memory_procedural;

\echo '=== After: project distribution (episodes) ==='
SELECT coalesce(project_id, '<shared>') AS project, count(*)
FROM memory_episodes GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
