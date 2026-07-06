-- =============================================================================
-- Fix: engram_vector_search — HNSW-drivable plan shape
-- =============================================================================
--
-- Problem: engram_vector_search was written as a flat UNION ALL over the four
-- memory tables followed by a single outer `ORDER BY similarity DESC LIMIT
-- p_match_count`. The Postgres planner cannot push a global ORDER BY over a
-- UNION ALL down into a per-branch index scan, so every call fell back to a
-- sequential scan across all four tables even though each carries an HNSW
-- index on `embedding` (idx_episodes_embedding_hnsw, idx_digests_embedding_hnsw,
-- idx_semantic_embedding_hnsw, idx_procedural_embedding_hnsw).
--
-- Fix: give each tier its own `ORDER BY <alias>.embedding <=> p_query_embedding
-- LIMIT p_match_count` INSIDE a subquery — the exact shape the planner can
-- satisfy directly from the HNSW index — then UNION ALL the four capped,
-- pre-sorted tiers and apply the same final `ORDER BY similarity DESC LIMIT
-- p_match_count` for the global top-k. This is a planner-shape fix only: the
-- signature, return columns, and per-row filtering (forgotten_at, superseded_by,
-- session/project scoping) are unchanged from the current production function,
-- and each tier already contributes at most p_match_count rows to the final
-- limit, so the per-tier LIMIT cannot drop a row that would have made the
-- final cut.
--
-- Sibling function engram_recall (schema.sql) already uses this per-tier
-- subquery shape; this migration brings engram_vector_search in line with it.
--
-- Idempotent: CREATE OR REPLACE FUNCTION on the unchanged signature. Safe to
-- re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.engram_vector_search(p_query_embedding public.vector, p_match_count integer DEFAULT 15, p_session_id text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, content text, role text, salience double precision, access_count integer, created_at timestamp with time zone, similarity double precision, entities text[], metadata jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
  SELECT * FROM (
    SELECT * FROM (
      -- Episodes
      SELECT
        me.id, 'episode'::text, me.content, me.role,
        me.salience::float, me.access_count, me.created_at,
        (1 - (me.embedding <=> p_query_embedding))::float AS similarity,
        me.entities, me.metadata
      FROM memory_episodes me
      WHERE me.embedding IS NOT NULL
        AND me.forgotten_at IS NULL
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
        AND (p_project_id IS NULL OR me.project_id = p_project_id OR me.project_id IS NULL)
      ORDER BY me.embedding <=> p_query_embedding
      LIMIT p_match_count
    ) ep

    UNION ALL

    SELECT * FROM (
      -- Digests
      SELECT
        md.id, 'digest'::text, md.summary, NULL::text,
        0.5::float, 0, md.created_at,
        (1 - (md.embedding <=> p_query_embedding))::float,
        md.key_topics, md.metadata
      FROM memory_digests md
      WHERE md.embedding IS NOT NULL
        AND (p_project_id IS NULL OR md.project_id = p_project_id OR md.project_id IS NULL)
      ORDER BY md.embedding <=> p_query_embedding
      LIMIT p_match_count
    ) dg

    UNION ALL

    SELECT * FROM (
      -- Semantic
      SELECT
        ms.id, 'semantic'::text, ms.content, NULL::text,
        ms.confidence::float, ms.access_count, ms.created_at,
        (1 - (ms.embedding <=> p_query_embedding))::float,
        ARRAY[]::text[], ms.metadata
      FROM memory_semantic ms
      WHERE ms.embedding IS NOT NULL AND ms.superseded_by IS NULL
        AND ms.forgotten_at IS NULL
        AND (p_project_id IS NULL OR ms.project_id = p_project_id OR ms.project_id IS NULL)
      ORDER BY ms.embedding <=> p_query_embedding
      LIMIT p_match_count
    ) sm

    UNION ALL

    SELECT * FROM (
      -- Procedural
      SELECT
        mp.id, 'procedural'::text, mp.procedure, NULL::text,
        mp.confidence::float, mp.access_count, mp.created_at,
        (1 - (mp.embedding <=> p_query_embedding))::float,
        ARRAY[]::text[], mp.metadata
      FROM memory_procedural mp
      WHERE mp.embedding IS NOT NULL
        AND mp.forgotten_at IS NULL
        AND (p_project_id IS NULL OR mp.project_id = p_project_id OR mp.project_id IS NULL)
      ORDER BY mp.embedding <=> p_query_embedding
      LIMIT p_match_count
    ) pr
  ) all_tiers
  ORDER BY similarity DESC
  LIMIT p_match_count
$$;
