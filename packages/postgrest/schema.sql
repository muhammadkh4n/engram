-- =============================================================================
-- Engram — Self-host PostgreSQL schema (idempotent)
-- =============================================================================
--
-- Apply via:   psql -U postgres -d engram -f schema.sql
--
-- This file is the canonical schema source of truth for self-host installs.
-- It is GENERATED from a production dump (post-v0.4.0 rebrand) and made
-- idempotent so it can be re-applied safely to any database state:
--   - CREATE TABLE IF NOT EXISTS
--   - CREATE INDEX IF NOT EXISTS
--   - CREATE OR REPLACE FUNCTION
--   - CREATE EXTENSION IF NOT EXISTS
--   - DROP POLICY IF EXISTS … ; CREATE POLICY …
--
-- For schema evolution history (per-migration diffs over time), see git log
-- on this file and the commit history of the deleted migrations/ directory.
--
-- Required roles (create once via the runbook before applying):
--   anon, authenticated, service_role, engram_authenticator
--
-- Required extensions:
--   pgvector (auto-created via CREATE EXTENSION IF NOT EXISTS vector)
--
-- See packages/postgrest/README.md for the full self-host runbook.
-- =============================================================================

--
-- PostgreSQL database dump
--

\restrict tlEVnt8kGKkgOUYZKAXb1KawcsGvDr4beUlVChILStbye6OdwQxAhSvtcrV7MdF

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- pgvector extension required for vector(1536) columns
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- forget() tombstone — within-file ordering note
-- -----------------------------------------------------------------------------
-- Phase 1 adds a `forgotten_at timestamptz` tombstone to memory_episodes /
-- memory_semantic / memory_procedural. forget() stamps it; every recall RPC
-- below gates on `forgotten_at IS NULL` (a 1:1 clone of the proven
-- `superseded_by IS NULL` gate). It is intentionally NOT added to
-- memory_digests (consolidation artifacts are not directly forgettable).
--
-- This file is a pg_dump: functions are emitted ABOVE the tables they read,
-- which is only valid because `SET check_function_bodies = false` (above)
-- defers body validation to call time. The forgotten_at columns are therefore
-- added in the TABLE section (CREATE TABLE bodies + an idempotent
-- `ADD COLUMN IF NOT EXISTS` block for already-provisioned DBs, since
-- CREATE TABLE IF NOT EXISTS is a no-op there) and the partial indexes in the
-- INDEX section — both physically before the only call sites in this file: the
-- post-apply smoke at EOF, which EXECUTES every recall RPC so a missing column
-- or broken gate fails LOUDLY at apply time. There is no migration runner; the
-- single sequential `psql -f schema.sql` apply is the ordering guarantee.
-- =============================================================================

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: engram_association_walk(uuid[], integer, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.engram_association_walk(p_seed_ids uuid[], p_max_hops integer DEFAULT 2, p_min_strength double precision DEFAULT 0.2, p_limit integer DEFAULT 20) RETURNS TABLE(memory_id uuid, memory_type text, depth integer, path_strength double precision)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  WITH RECURSIVE walk AS (
    SELECT s.id AS memory_id, NULL::text AS memory_type, 0 AS depth,
           ARRAY[s.id] AS visited_ids, 1.0::float AS path_strength
    FROM unnest(p_seed_ids) AS s(id)
    UNION ALL
    SELECT CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END,
           CASE WHEN a.source_id = w.memory_id THEN a.target_type ELSE a.source_type END,
           w.depth + 1,
           w.visited_ids || (CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END),
           (w.path_strength * a.strength)::float
    FROM walk w JOIN memory_associations a ON (a.source_id = w.memory_id OR a.target_id = w.memory_id)
    WHERE w.depth < p_max_hops AND a.strength >= p_min_strength
      AND NOT (CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END) = ANY(w.visited_ids)
  )
  SELECT DISTINCT ON (memory_id) memory_id, memory_type, depth, path_strength
  FROM walk WHERE depth > 0 ORDER BY memory_id, path_strength DESC, depth ASC LIMIT p_limit
$$;


--
-- Name: engram_decay_pass(double precision, double precision, integer, integer, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.engram_decay_pass(p_semantic_decay_rate double precision DEFAULT 0.02, p_procedural_decay_rate double precision DEFAULT 0.01, p_semantic_days integer DEFAULT 30, p_procedural_days integer DEFAULT 60, p_edge_prune_strength double precision DEFAULT 0.05, p_edge_prune_days integer DEFAULT 90) RETURNS TABLE(semantic_decayed integer, procedural_decayed integer, edges_pruned integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_s int; v_p int; v_e int;
BEGIN
  UPDATE memory_semantic SET confidence = GREATEST(0.05, confidence - p_semantic_decay_rate), updated_at = now()
  WHERE confidence > 0.05 AND (last_accessed IS NULL OR last_accessed < now() - (p_semantic_days || ' days')::interval);
  GET DIAGNOSTICS v_s = ROW_COUNT;
  UPDATE memory_procedural SET confidence = GREATEST(0.05, confidence - p_procedural_decay_rate), updated_at = now()
  WHERE confidence > 0.05 AND (last_accessed IS NULL OR last_accessed < now() - (p_procedural_days || ' days')::interval);
  GET DIAGNOSTICS v_p = ROW_COUNT;
  DELETE FROM memory_associations WHERE strength < p_edge_prune_strength
    AND (last_activated IS NULL OR last_activated < now() - (p_edge_prune_days || ' days')::interval)
    AND edge_type != 'derives_from';
  GET DIAGNOSTICS v_e = ROW_COUNT;
  RETURN QUERY SELECT v_s, v_p, v_e;
END; $$;


--
-- Name: engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the pre-Wave-5 signature (without p_project_id) so the new defaulted
-- parameter does not create an ambiguous overload alongside the old function.
DROP FUNCTION IF EXISTS public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean);

-- RETURNS TABLE gained project_id, so CREATE OR REPLACE alone cannot upgrade an existing installation — drop the same-argument signature first.
DROP FUNCTION IF EXISTS public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text);

CREATE OR REPLACE FUNCTION public.engram_hybrid_recall(p_query_text text, p_query_embedding public.vector, p_match_count integer DEFAULT 10, p_full_text_weight double precision DEFAULT 1.0, p_semantic_weight double precision DEFAULT 1.0, p_rrf_k integer DEFAULT 60, p_session_id text DEFAULT NULL::text, p_include_episodes boolean DEFAULT true, p_include_digests boolean DEFAULT true, p_include_semantic boolean DEFAULT true, p_include_procedural boolean DEFAULT true, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, content text, salience double precision, access_count integer, created_at timestamp with time zone, similarity double precision, entities text[], project_id text)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
  SELECT * FROM (
    WITH ft AS (
      SELECT me.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(me.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_episodes me
      WHERE p_include_episodes AND me.fts @@ websearch_to_tsquery('english', p_query_text)
        AND me.forgotten_at IS NULL
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
        AND (p_project_id IS NULL OR me.project_id = p_project_id OR me.project_id IS NULL)
      LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT me.id, ROW_NUMBER() OVER (ORDER BY me.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_episodes me
      WHERE p_include_episodes AND me.embedding IS NOT NULL
        AND me.forgotten_at IS NULL
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
        AND (p_project_id IS NULL OR me.project_id = p_project_id OR me.project_id IS NULL)
      ORDER BY me.embedding <=> p_query_embedding LIMIT p_match_count * 2
    )
    SELECT me.id, 'episode'::text AS memory_type, me.content,
      me.salience::float, me.access_count, me.created_at,
      (COALESCE(1.0/(p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight + COALESCE(1.0/(p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float AS sim,
      me.entities, me.project_id
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_episodes me ON COALESCE(ft.id, vs.id) = me.id
    ORDER BY 7 DESC LIMIT p_match_count
  ) ep

  UNION ALL

  SELECT * FROM (
    WITH ft AS (
      SELECT md.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(md.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_digests md WHERE p_include_digests AND md.fts @@ websearch_to_tsquery('english', p_query_text)
        AND (p_project_id IS NULL OR md.project_id = p_project_id OR md.project_id IS NULL) LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT md.id, ROW_NUMBER() OVER (ORDER BY md.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_digests md WHERE p_include_digests AND md.embedding IS NOT NULL
        AND (p_project_id IS NULL OR md.project_id = p_project_id OR md.project_id IS NULL)
      ORDER BY md.embedding <=> p_query_embedding LIMIT p_match_count * 2
    )
    SELECT md.id, 'digest'::text, md.summary, 0.5::float, 0, md.created_at,
      (COALESCE(1.0/(p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight + COALESCE(1.0/(p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      md.key_topics, md.project_id
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_digests md ON COALESCE(ft.id, vs.id) = md.id
    ORDER BY 7 DESC LIMIT p_match_count
  ) dg

  UNION ALL

  SELECT * FROM (
    WITH ft AS (
      SELECT ms.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ms.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_semantic ms WHERE p_include_semantic AND ms.fts @@ websearch_to_tsquery('english', p_query_text) AND ms.superseded_by IS NULL AND ms.forgotten_at IS NULL
        AND (p_project_id IS NULL OR ms.project_id = p_project_id OR ms.project_id IS NULL) LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT ms.id, ROW_NUMBER() OVER (ORDER BY ms.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_semantic ms WHERE p_include_semantic AND ms.embedding IS NOT NULL AND ms.superseded_by IS NULL AND ms.forgotten_at IS NULL
        AND (p_project_id IS NULL OR ms.project_id = p_project_id OR ms.project_id IS NULL)
      ORDER BY ms.embedding <=> p_query_embedding LIMIT p_match_count * 2
    )
    SELECT ms.id, 'semantic'::text, ms.content, ms.confidence::float, ms.access_count, ms.created_at,
      (COALESCE(1.0/(p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight + COALESCE(1.0/(p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      ARRAY[]::text[], ms.project_id
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_semantic ms ON COALESCE(ft.id, vs.id) = ms.id
    ORDER BY 7 DESC LIMIT p_match_count
  ) sm

  UNION ALL

  SELECT * FROM (
    WITH ft AS (
      SELECT mp.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(mp.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_procedural mp WHERE p_include_procedural AND mp.fts @@ websearch_to_tsquery('english', p_query_text) AND mp.forgotten_at IS NULL
        AND (p_project_id IS NULL OR mp.project_id = p_project_id OR mp.project_id IS NULL) LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT mp.id, ROW_NUMBER() OVER (ORDER BY mp.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_procedural mp WHERE p_include_procedural AND mp.embedding IS NOT NULL AND mp.forgotten_at IS NULL
        AND (p_project_id IS NULL OR mp.project_id = p_project_id OR mp.project_id IS NULL)
      ORDER BY mp.embedding <=> p_query_embedding LIMIT p_match_count * 2
    )
    SELECT mp.id, 'procedural'::text, mp.procedure, mp.confidence::float, mp.access_count, mp.created_at,
      (COALESCE(1.0/(p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight + COALESCE(1.0/(p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      ARRAY[]::text[], mp.project_id
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_procedural mp ON COALESCE(ft.id, vs.id) = mp.id
    ORDER BY 7 DESC LIMIT p_match_count
  ) pr
$$;


--
-- Name: engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the pre-Wave-5 signature (without p_project_id) so the new defaulted
-- parameter does not create an ambiguous overload alongside the old function.
DROP FUNCTION IF EXISTS public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean);

-- RETURNS TABLE gained project_id, so CREATE OR REPLACE alone cannot upgrade an existing installation — drop the same-argument signature first.
DROP FUNCTION IF EXISTS public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text);

CREATE OR REPLACE FUNCTION public.engram_recall(p_query_embedding public.vector, p_session_id text DEFAULT NULL::text, p_match_count integer DEFAULT 10, p_min_similarity double precision DEFAULT 0.3, p_include_episodes boolean DEFAULT true, p_include_digests boolean DEFAULT true, p_include_semantic boolean DEFAULT true, p_include_procedural boolean DEFAULT true, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, content text, salience double precision, access_count integer, created_at timestamp with time zone, similarity double precision, entities text[], project_id text)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
  SELECT * FROM (
    SELECT id, 'episode'::text, content, salience::float, access_count, created_at,
           (1-(embedding<=>p_query_embedding))::float AS similarity, entities, project_id
    FROM memory_episodes
    WHERE p_include_episodes AND embedding IS NOT NULL
      AND forgotten_at IS NULL
      AND (p_session_id IS NULL OR session_id = p_session_id)
      AND (p_project_id IS NULL OR project_id = p_project_id OR project_id IS NULL)
      AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
    ORDER BY embedding<=>p_query_embedding LIMIT p_match_count
  ) ep
  UNION ALL
  SELECT * FROM (
    SELECT id, 'digest'::text, summary, 0.5::float, 0, created_at,
           (1-(embedding<=>p_query_embedding))::float, key_topics, project_id
    FROM memory_digests
    WHERE p_include_digests AND embedding IS NOT NULL
      AND (p_project_id IS NULL OR project_id = p_project_id OR project_id IS NULL)
      AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
    ORDER BY embedding<=>p_query_embedding LIMIT p_match_count
  ) dg
  UNION ALL
  SELECT * FROM (
    SELECT id, 'semantic'::text, content, confidence::float, access_count, created_at,
           (1-(embedding<=>p_query_embedding))::float, ARRAY[]::text[], project_id
    FROM memory_semantic
    WHERE p_include_semantic AND embedding IS NOT NULL AND superseded_by IS NULL
      AND forgotten_at IS NULL
      AND (p_project_id IS NULL OR project_id = p_project_id OR project_id IS NULL)
      AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
    ORDER BY embedding<=>p_query_embedding LIMIT p_match_count
  ) sm
  UNION ALL
  SELECT * FROM (
    SELECT id, 'procedural'::text, procedure, confidence::float, access_count, created_at,
           (1-(embedding<=>p_query_embedding))::float, ARRAY[]::text[], project_id
    FROM memory_procedural
    WHERE p_include_procedural AND embedding IS NOT NULL
      AND forgotten_at IS NULL
      AND (p_project_id IS NULL OR project_id = p_project_id OR project_id IS NULL)
      AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
    ORDER BY embedding<=>p_query_embedding LIMIT p_match_count
  ) pr
$$;


--
-- Name: engram_record_access(uuid, text, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.engram_record_access(p_id uuid, p_memory_type text, p_conf_boost double precision DEFAULT 0.0) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_memory_type = 'episode' THEN
    UPDATE memory_episodes SET access_count = access_count + 1, last_accessed = now() WHERE id = p_id;
  ELSIF p_memory_type = 'semantic' THEN
    UPDATE memory_semantic SET access_count = access_count + 1, last_accessed = now(),
      confidence = LEAST(1.0, confidence + p_conf_boost), updated_at = now() WHERE id = p_id;
  ELSIF p_memory_type = 'procedural' THEN
    UPDATE memory_procedural SET access_count = access_count + 1, last_accessed = now(),
      confidence = LEAST(1.0, confidence + p_conf_boost), updated_at = now() WHERE id = p_id;
  END IF;
END; $$;


--
-- Name: engram_mark_forgotten(text, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

-- Tombstone primitive for forget(). Sets forgotten_at and touches NOTHING else
-- (deliberately no access_count / confidence write — that was the inverted-
-- forget() bug). Idempotent: the `forgotten_at IS NULL` guard makes a repeat
-- forget a no-op (returns 0). Mirrors the per-store markForgotten storage
-- contract (returns the number of rows newly tombstoned).
CREATE OR REPLACE FUNCTION public.engram_mark_forgotten(p_memory_type text, p_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_count integer;
BEGIN
  IF p_memory_type = 'episode' THEN
    UPDATE memory_episodes SET forgotten_at = now()
      WHERE id = ANY(p_ids) AND forgotten_at IS NULL;
  ELSIF p_memory_type = 'semantic' THEN
    UPDATE memory_semantic SET forgotten_at = now()
      WHERE id = ANY(p_ids) AND forgotten_at IS NULL;
  ELSIF p_memory_type = 'procedural' THEN
    UPDATE memory_procedural SET forgotten_at = now()
      WHERE id = ANY(p_ids) AND forgotten_at IS NULL;
  ELSE
    RAISE EXCEPTION 'engram_mark_forgotten: unknown memory_type %', p_memory_type;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;


--
-- Name: engram_text_boost(text, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the pre-Wave-5 signature (without p_project_id) so the new defaulted
-- parameter does not create an ambiguous overload alongside the old function.
DROP FUNCTION IF EXISTS public.engram_text_boost(text, integer, text);

CREATE OR REPLACE FUNCTION public.engram_text_boost(p_query_terms text, p_match_count integer DEFAULT 30, p_session_id text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, rank_score double precision)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
  SELECT id, memory_type, rank_score FROM (
    SELECT me.id, 'episode'::text AS memory_type,
      ts_rank_cd(me.fts, to_tsquery('english', p_query_terms))::float AS rank_score
    FROM memory_episodes me
    WHERE me.fts @@ to_tsquery('english', p_query_terms)
      AND me.forgotten_at IS NULL
      AND (p_session_id IS NULL OR me.session_id = p_session_id)
      AND (p_project_id IS NULL OR me.project_id = p_project_id OR me.project_id IS NULL)

    UNION ALL

    SELECT md.id, 'digest'::text,
      ts_rank_cd(md.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_digests md
    WHERE md.fts @@ to_tsquery('english', p_query_terms)
      AND (p_project_id IS NULL OR md.project_id = p_project_id OR md.project_id IS NULL)

    UNION ALL

    SELECT ms.id, 'semantic'::text,
      ts_rank_cd(ms.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_semantic ms
    WHERE ms.fts @@ to_tsquery('english', p_query_terms)
      AND ms.superseded_by IS NULL
      AND ms.forgotten_at IS NULL
      AND (p_project_id IS NULL OR ms.project_id = p_project_id OR ms.project_id IS NULL)

    UNION ALL

    SELECT mp.id, 'procedural'::text,
      ts_rank_cd(mp.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_procedural mp
    WHERE mp.fts @@ to_tsquery('english', p_query_terms)
      AND mp.forgotten_at IS NULL
      AND (p_project_id IS NULL OR mp.project_id = p_project_id OR mp.project_id IS NULL)
  ) combined
  ORDER BY rank_score DESC
  LIMIT p_match_count
$$;


--
-- Name: engram_upsert_co_recalled(uuid, text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.engram_upsert_co_recalled(p_source_id uuid, p_source_type text, p_target_id uuid, p_target_type text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  INSERT INTO memory_associations (source_id, source_type, target_id, target_type, edge_type, strength, last_activated)
  VALUES (p_source_id, p_source_type, p_target_id, p_target_type, 'co_recalled', 0.2, now())
  ON CONFLICT (source_id, target_id, edge_type) DO UPDATE SET
    strength = LEAST(1.0, memory_associations.strength + 0.1), last_activated = now();
$$;


--
-- Name: engram_vector_search(public.vector, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the pre-Wave-5 signature (without p_project_id) so the new defaulted
-- parameter does not create an ambiguous overload alongside the old function.
DROP FUNCTION IF EXISTS public.engram_vector_search(public.vector, integer, text);

-- RETURNS TABLE gained project_id, so CREATE OR REPLACE alone cannot upgrade an existing installation — drop the same-argument signature first.
DROP FUNCTION IF EXISTS public.engram_vector_search(public.vector, integer, text, text);

-- Exact-vs-approximate tradeoff: the old function body scanned every row
-- (exact, sequential scan); the per-tier subquery shape below lets the
-- planner drive each tier from its HNSW index instead (approximate nearest
-- neighbor). Recall is now governed by `hnsw.ef_search` (the number of
-- candidates HNSW examines per index scan) rather than by touching every
-- row, so a true top-k match can be missed if it falls outside the
-- ef_search candidate window. The `p_session_id` / `p_project_id` /
-- `forgotten_at` / `superseded_by` predicates are post-filters applied to
-- that candidate stream, not filters that widen it — a narrow filter
-- combined with a low ef_search compounds the truncation risk.
--
-- `SET hnsw.ef_search TO '150'`: callers pass p_match_count up to 120 (core
-- recall's vector-search leg requests strategy.maxResults * 4, and
-- maxResults tops out at 30 for the deep-sleep/light-sleep intents — see
-- packages/core/src/retrieval/search.ts and packages/core/src/intent/
-- intents.ts). Postgres's pgvector HNSW returns at most ef_search candidates
-- per index scan (default 40) regardless of the query's LIMIT, so without an
-- explicit floor a deep recall call silently truncates below what it asked
-- for. 150 covers the 120 ceiling with headroom.
CREATE OR REPLACE FUNCTION public.engram_vector_search(p_query_embedding public.vector, p_match_count integer DEFAULT 15, p_session_id text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, content text, role text, salience double precision, access_count integer, created_at timestamp with time zone, similarity double precision, entities text[], metadata jsonb, project_id text)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    SET hnsw.ef_search TO '150'
    AS $$
  SELECT * FROM (
    SELECT * FROM (
      -- Episodes
      SELECT
        me.id, 'episode'::text, me.content, me.role,
        me.salience::float, me.access_count, me.created_at,
        (1 - (me.embedding <=> p_query_embedding))::float AS similarity,
        me.entities, me.metadata, me.project_id
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
        md.key_topics, md.metadata, md.project_id
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
        ARRAY[]::text[], ms.metadata, ms.project_id
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
        ARRAY[]::text[], mp.metadata, mp.project_id
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


--
-- Name: match_digests(text, integer, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.match_digests(query_embedding text, match_count integer DEFAULT 10, min_similarity double precision DEFAULT 0.3) RETURNS TABLE(id uuid, session_id text, summary text, key_topics text[], episode_ids uuid[], metadata jsonb, created_at timestamp with time zone, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id, d.session_id, d.summary, d.key_topics, d.episode_ids, d.metadata, d.created_at,
    (1 - (d.embedding <=> query_embedding::vector))::FLOAT AS similarity
  FROM memory_digests d
  WHERE (1 - (d.embedding <=> query_embedding::vector)) >= min_similarity
  ORDER BY d.embedding <=> query_embedding::vector
  LIMIT match_count;
END;
$$;


--
-- Name: match_episodes(text, integer, double precision, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.match_episodes(query_embedding text, match_count integer DEFAULT 10, min_similarity double precision DEFAULT 0.3, filter_session_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, session_id text, role text, content text, metadata jsonb, created_at timestamp with time zone, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.session_id, e.role, e.content, e.metadata, e.created_at,
    (1 - (e.embedding <=> query_embedding::vector))::FLOAT AS similarity
  FROM memory_episodes e
  WHERE
    (filter_session_id IS NULL OR e.session_id = filter_session_id)
    AND (1 - (e.embedding <=> query_embedding::vector)) >= min_similarity
  ORDER BY e.embedding <=> query_embedding::vector
  LIMIT match_count;
END;
$$;


--
-- Name: match_knowledge(text, integer, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.match_knowledge(query_embedding text, match_count integer DEFAULT 10, min_similarity double precision DEFAULT 0.3) RETURNS TABLE(id uuid, topic text, content text, confidence double precision, source_digest_ids uuid[], metadata jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    k.id, k.topic, k.content, k.confidence::FLOAT, k.source_digest_ids, k.metadata, k.created_at, k.updated_at,
    (1 - (k.embedding <=> query_embedding::vector))::FLOAT AS similarity
  FROM memory_knowledge k
  WHERE (1 - (k.embedding <=> query_embedding::vector)) >= min_similarity
  ORDER BY k.embedding <=> query_embedding::vector
  LIMIT match_count;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: community_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.community_summaries (
    community_id text NOT NULL,
    project_id text,
    label text NOT NULL,
    member_count integer DEFAULT 0 NOT NULL,
    top_entities jsonb DEFAULT '[]'::jsonb NOT NULL,
    top_topics jsonb DEFAULT '[]'::jsonb NOT NULL,
    top_persons jsonb DEFAULT '[]'::jsonb NOT NULL,
    dominant_emotion text,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: consolidation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.consolidation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT consolidation_runs_cycle_check CHECK ((cycle = ANY (ARRAY['light'::text, 'deep'::text, 'dream'::text, 'decay'::text]))),
    CONSTRAINT consolidation_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: episode_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.episode_parts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    episode_id uuid NOT NULL,
    ordinal integer NOT NULL,
    part_type text NOT NULL,
    text_content text,
    tool_name text,
    tool_input jsonb,
    tool_output jsonb,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT episode_parts_part_type_check CHECK ((part_type = ANY (ARRAY['text'::text, 'tool_call'::text, 'tool_result'::text, 'reasoning'::text, 'image'::text, 'other'::text])))
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memories_type_check CHECK ((type = ANY (ARRAY['episode'::text, 'digest'::text, 'semantic'::text, 'procedural'::text])))
);


--
-- Name: memory_associations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_associations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    source_type text NOT NULL,
    target_id uuid NOT NULL,
    target_type text NOT NULL,
    edge_type text NOT NULL,
    strength real DEFAULT 0.3 NOT NULL,
    last_activated timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_associations_edge_type_check CHECK ((edge_type = ANY (ARRAY['temporal'::text, 'causal'::text, 'topical'::text, 'supports'::text, 'contradicts'::text, 'elaborates'::text, 'derives_from'::text, 'co_recalled'::text]))),
    CONSTRAINT memory_associations_source_type_check CHECK ((source_type = ANY (ARRAY['episode'::text, 'digest'::text, 'semantic'::text, 'procedural'::text]))),
    CONSTRAINT memory_associations_strength_check CHECK (((strength >= (0.0)::double precision) AND (strength <= (1.0)::double precision))),
    CONSTRAINT memory_associations_target_type_check CHECK ((target_type = ANY (ARRAY['episode'::text, 'digest'::text, 'semantic'::text, 'procedural'::text])))
);


--
-- Name: memory_consolidation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_consolidation_runs (
    id text NOT NULL,
    cycle text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT memory_consolidation_runs_cycle_check CHECK ((cycle = ANY (ARRAY['light'::text, 'deep'::text, 'dream'::text, 'decay'::text]))),
    CONSTRAINT memory_consolidation_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: memory_digests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_digests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id text NOT NULL,
    summary text NOT NULL,
    key_topics text[] DEFAULT '{}'::text[],
    embedding public.vector(1536),
    episode_ids uuid[] DEFAULT '{}'::uuid[],
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    source_digest_ids uuid[] DEFAULT '{}'::uuid[],
    level integer DEFAULT 0,
    fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, summary)) STORED,
    project_id text
);


--
-- Name: memory_episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_episodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id text NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    embedding public.vector(1536),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    salience real DEFAULT 0.3,
    access_count integer DEFAULT 0,
    last_accessed timestamp with time zone,
    consolidated_at timestamp with time zone,
    entities text[] DEFAULT '{}'::text[],
    searchable_content text,
    fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    project_id text,
    forgotten_at timestamp with time zone,
    CONSTRAINT memory_episodes_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);


--
-- Name: memory_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    topic text NOT NULL,
    content text NOT NULL,
    confidence double precision DEFAULT 1.0,
    embedding public.vector(1536),
    source_digest_ids uuid[] DEFAULT '{}'::uuid[],
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT memory_knowledge_confidence_check1 CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))
);


--
-- Name: memory_procedural; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_procedural (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category text NOT NULL,
    trigger_text text NOT NULL,
    procedure text NOT NULL,
    confidence real DEFAULT 0.5 NOT NULL,
    observation_count integer DEFAULT 1 NOT NULL,
    last_observed timestamp with time zone DEFAULT now() NOT NULL,
    first_observed timestamp with time zone DEFAULT now() NOT NULL,
    access_count integer DEFAULT 0 NOT NULL,
    last_accessed timestamp with time zone,
    decay_rate real DEFAULT 0.01 NOT NULL,
    source_episode_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    embedding public.vector(1536),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((trigger_text || ' '::text) || procedure))) STORED,
    project_id text,
    forgotten_at timestamp with time zone,
    CONSTRAINT memory_procedural_category_check CHECK ((category = ANY (ARRAY['workflow'::text, 'preference'::text, 'habit'::text, 'pattern'::text, 'convention'::text]))),
    CONSTRAINT memory_procedural_confidence_check CHECK (((confidence >= (0.0)::double precision) AND (confidence <= (1.0)::double precision))),
    CONSTRAINT memory_procedural_decay_rate_check CHECK (((decay_rate > (0.0)::double precision) AND (decay_rate <= (1.0)::double precision)))
);


--
-- Name: memory_semantic; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_semantic (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    topic text NOT NULL,
    content text NOT NULL,
    confidence double precision DEFAULT 1.0,
    embedding public.vector(1536),
    source_digest_ids uuid[] DEFAULT '{}'::uuid[],
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    source_episode_ids uuid[] DEFAULT '{}'::uuid[],
    access_count integer DEFAULT 0,
    last_accessed timestamp with time zone,
    decay_rate real DEFAULT 0.02,
    supersedes uuid,
    superseded_by uuid,
    fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((topic || ' '::text) || content))) STORED,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    project_id text,
    forgotten_at timestamp with time zone,
    CONSTRAINT memory_knowledge_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))
);


--
-- Name: memory_write_buffer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_write_buffer (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tier text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    retry_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT memory_write_buffer_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT memory_write_buffer_tier_check CHECK ((tier = ANY (ARRAY['episode'::text, 'digest'::text, 'knowledge'::text])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    checksum text NOT NULL
);


--
-- Name: sensory_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.sensory_snapshots (
    session_id text NOT NULL,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    saved_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- forget() tombstone columns — idempotent ADD COLUMN for already-provisioned
-- DBs (CREATE TABLE IF NOT EXISTS above is a no-op there, so the column in the
-- table body never lands on an existing DB). Placed after the CREATE TABLEs and
-- before the partial indexes / post-apply smoke that read it. See the ordering
-- note at the top of this file. NOT added to memory_digests by design.
--
ALTER TABLE public.memory_episodes ADD COLUMN IF NOT EXISTS forgotten_at timestamp with time zone;
ALTER TABLE public.memory_semantic ADD COLUMN IF NOT EXISTS forgotten_at timestamp with time zone;
ALTER TABLE public.memory_procedural ADD COLUMN IF NOT EXISTS forgotten_at timestamp with time zone;


--
-- Name: community_summaries community_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_summaries
    ADD CONSTRAINT community_summaries_pkey PRIMARY KEY (community_id);


--
-- Name: consolidation_runs consolidation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consolidation_runs
    ADD CONSTRAINT consolidation_runs_pkey PRIMARY KEY (id);


--
-- Name: episode_parts episode_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_parts
    ADD CONSTRAINT episode_parts_pkey PRIMARY KEY (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_associations memory_associations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_associations
    ADD CONSTRAINT memory_associations_pkey PRIMARY KEY (id);


--
-- Name: memory_consolidation_runs memory_consolidation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_consolidation_runs
    ADD CONSTRAINT memory_consolidation_runs_pkey PRIMARY KEY (id);


--
-- Name: memory_digests memory_digests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_digests
    ADD CONSTRAINT memory_digests_pkey PRIMARY KEY (id);


--
-- Name: memory_episodes memory_episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_episodes
    ADD CONSTRAINT memory_episodes_pkey PRIMARY KEY (id);


--
-- Name: memory_semantic memory_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_semantic
    ADD CONSTRAINT memory_knowledge_pkey PRIMARY KEY (id);


--
-- Name: memory_knowledge memory_knowledge_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_knowledge
    ADD CONSTRAINT memory_knowledge_pkey1 PRIMARY KEY (id);


--
-- Name: memory_procedural memory_procedural_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_procedural
    ADD CONSTRAINT memory_procedural_pkey PRIMARY KEY (id);


--
-- Name: memory_write_buffer memory_write_buffer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_write_buffer
    ADD CONSTRAINT memory_write_buffer_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sensory_snapshots sensory_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensory_snapshots
    ADD CONSTRAINT sensory_snapshots_pkey PRIMARY KEY (session_id);


--
-- Name: memory_associations uq_association_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_associations
    ADD CONSTRAINT uq_association_pair UNIQUE (source_id, target_id, edge_type);


--
-- Name: idx_assoc_source_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_assoc_source_strength ON public.memory_associations USING btree (source_id, strength DESC);


--
-- Name: idx_assoc_target_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_assoc_target_strength ON public.memory_associations USING btree (target_id, strength DESC);


--
-- Name: idx_community_members; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_community_members ON public.community_summaries USING btree (member_count DESC);


--
-- Name: idx_community_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_community_project ON public.community_summaries USING btree (project_id);


--
-- Name: idx_digests_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_digests_created ON public.memory_digests USING btree (created_at DESC);


--
-- Name: idx_digests_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--
-- The legacy ivfflat indexes (probes=1 by default) were retired: ivfflat was
-- abandoned early for poor recall, and now that engram_vector_search /
-- engram_recall use a per-tier ORDER BY ... LIMIT shape the planner is free
-- to pick either index — leaving ivfflat in place risked it winning on cost
-- despite worse recall than HNSW. The drops below make re-running this file
-- upgrade an older installation in place (idx_knowledge_embedding is the
-- semantic tier's pre-rename ivfflat name).
--

DROP INDEX IF EXISTS public.idx_digests_embedding;
DROP INDEX IF EXISTS public.idx_episodes_embedding;
DROP INDEX IF EXISTS public.idx_knowledge_embedding;

CREATE INDEX IF NOT EXISTS idx_digests_embedding_hnsw ON public.memory_digests USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (embedding IS NOT NULL);


--
-- Name: idx_digests_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_digests_fts ON public.memory_digests USING gin (fts);


--
-- Name: idx_digests_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_digests_project ON public.memory_digests USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_digests_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_digests_session ON public.memory_digests USING btree (session_id);


--
-- Name: idx_episode_parts_episode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_episode_parts_episode ON public.episode_parts USING btree (episode_id);


--
-- Name: idx_episodes_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_episodes_created ON public.memory_episodes USING btree (created_at DESC);


--
-- Name: idx_episodes_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--
-- The ivfflat sibling index (idx_episodes_embedding) was retired — rationale
-- and the upgrade DROPs live with idx_digests_embedding_hnsw above.
--

CREATE INDEX IF NOT EXISTS idx_episodes_embedding_hnsw ON public.memory_episodes USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (embedding IS NOT NULL AND forgotten_at IS NULL);


--
-- Name: idx_episodes_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_episodes_fts ON public.memory_episodes USING gin (fts);


--
-- Name: idx_episodes_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_episodes_project ON public.memory_episodes USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_episodes_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_episodes_session ON public.memory_episodes USING btree (session_id);


--
-- Name: idx_knowledge_confidence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_knowledge_confidence ON public.memory_semantic USING btree (confidence DESC);


--
-- Name: idx_knowledge_topic; Type: INDEX; Schema: public; Owner: -
--
-- (idx_knowledge_embedding, the ivfflat sibling of idx_semantic_embedding_hnsw
-- below, was retired — rationale and the upgrade DROPs live with
-- idx_digests_embedding_hnsw above.)
--

CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON public.memory_semantic USING btree (topic);


--
-- Name: idx_memory_consolidation_runs_cycle_completed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_cycle_completed ON public.memory_consolidation_runs USING btree (cycle, started_at DESC) WHERE (status = 'completed'::text);


--
-- Name: idx_memory_consolidation_runs_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_started ON public.memory_consolidation_runs USING btree (started_at DESC);


--
-- Name: idx_memory_semantic_valid_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_memory_semantic_valid_from ON public.memory_semantic USING btree (valid_from);


--
-- Name: idx_memory_semantic_valid_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_memory_semantic_valid_until ON public.memory_semantic USING btree (valid_until) WHERE (valid_until IS NOT NULL);


--
-- Name: idx_procedural_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_procedural_category ON public.memory_procedural USING btree (category);


--
-- Name: idx_procedural_confidence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_procedural_confidence ON public.memory_procedural USING btree (confidence DESC);


--
-- Name: idx_procedural_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_procedural_embedding_hnsw ON public.memory_procedural USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (embedding IS NOT NULL AND forgotten_at IS NULL);


--
-- Name: idx_procedural_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_procedural_fts ON public.memory_procedural USING gin (fts);


--
-- Name: idx_procedural_last_accessed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_procedural_last_accessed ON public.memory_procedural USING btree (last_accessed);


--
-- Name: idx_procedural_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_procedural_project ON public.memory_procedural USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_semantic_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_semantic_embedding_hnsw ON public.memory_semantic USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (embedding IS NOT NULL AND forgotten_at IS NULL);


--
-- Name: idx_semantic_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_semantic_fts ON public.memory_semantic USING gin (fts);


--
-- Name: idx_semantic_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_semantic_project ON public.memory_semantic USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_write_buffer_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_write_buffer_created ON public.memory_write_buffer USING btree (created_at);


--
-- Name: idx_write_buffer_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_write_buffer_status ON public.memory_write_buffer USING btree (status);


--
-- forget() tombstone partial indexes: index only the (rare) tombstoned rows so
-- forgotten-row enumeration (Phase 2 reclamation / audit) is cheap. The hot
-- `forgotten_at IS NULL` recall predicate matches the majority of rows and is
-- driven by the vector/fts indexes; it needs no index of its own. Mirrors the
-- SQLite v5 `WHERE forgotten_at IS NOT NULL` partial indexes (lockstep).
--

CREATE INDEX IF NOT EXISTS idx_episodes_forgotten ON public.memory_episodes USING btree (forgotten_at) WHERE (forgotten_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_semantic_forgotten ON public.memory_semantic USING btree (forgotten_at) WHERE (forgotten_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_procedural_forgotten ON public.memory_procedural USING btree (forgotten_at) WHERE (forgotten_at IS NOT NULL);


--
-- Name: episode_parts episode_parts_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_parts
    ADD CONSTRAINT episode_parts_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.memory_episodes(id) ON DELETE CASCADE;


--
-- Name: community_summaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_summaries ENABLE ROW LEVEL SECURITY;

--
-- Name: consolidation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.consolidation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: episode_parts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.episode_parts ENABLE ROW LEVEL SECURITY;

--
-- Name: memories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_associations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_associations ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_consolidation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_consolidation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_digests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_digests ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_episodes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_episodes ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_procedural; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_procedural ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_semantic; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_semantic ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_write_buffer; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_write_buffer ENABLE ROW LEVEL SECURITY;

--
-- Name: sensory_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sensory_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: community_summaries service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.community_summaries;
CREATE POLICY service_role_all ON public.community_summaries TO service_role USING (true) WITH CHECK (true);


--
-- Name: consolidation_runs service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.consolidation_runs;
CREATE POLICY service_role_all ON public.consolidation_runs TO service_role USING (true) WITH CHECK (true);


--
-- Name: episode_parts service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.episode_parts;
CREATE POLICY service_role_all ON public.episode_parts TO service_role USING (true) WITH CHECK (true);


--
-- Name: memories service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memories;
CREATE POLICY service_role_all ON public.memories TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_associations service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_associations;
CREATE POLICY service_role_all ON public.memory_associations TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_digests service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_digests;
CREATE POLICY service_role_all ON public.memory_digests TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_episodes service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_episodes;
CREATE POLICY service_role_all ON public.memory_episodes TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_procedural service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_procedural;
CREATE POLICY service_role_all ON public.memory_procedural TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_semantic service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_semantic;
CREATE POLICY service_role_all ON public.memory_semantic TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_write_buffer service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_write_buffer;
CREATE POLICY service_role_all ON public.memory_write_buffer TO service_role USING (true) WITH CHECK (true);


--
-- Name: sensory_snapshots service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.sensory_snapshots;
CREATE POLICY service_role_all ON public.sensory_snapshots TO service_role USING (true) WITH CHECK (true);


--
-- Post-apply smoke (no migration runner exists to enforce column-before-function
-- ordering). Executes every recall RPC + the forget primitive against the just-
-- applied schema so a missing forgotten_at column or a broken gate fails HERE: it
-- aborts the apply under `psql -v ON_ERROR_STOP=1`, and otherwise surfaces as a
-- loud ERROR line in the apply log. Read-only except engram_mark_forgotten on the
-- nil UUID (matches nothing -> returns 0). Idempotent and safe to re-run. All
-- names schema-qualified because the dump sets search_path = ''.
--

DO $smoke$
DECLARE
  v_unit public.vector := ('[1' || repeat(',0', 1535) || ']')::public.vector;
  v_n integer;
BEGIN
  PERFORM public.engram_recall(v_unit, NULL, 1);
  PERFORM public.engram_hybrid_recall('smoke', v_unit, 1);
  PERFORM public.engram_text_boost('smoke', 1);
  PERFORM public.engram_vector_search(v_unit, 1);
  v_n := public.engram_mark_forgotten('episode', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  v_n := public.engram_mark_forgotten('semantic', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  v_n := public.engram_mark_forgotten('procedural', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  RAISE NOTICE 'engram schema smoke OK: 4 recall RPCs + engram_mark_forgotten callable; forgotten_at gate live';
END;
$smoke$;


--
-- PostgreSQL database dump complete
--

\unrestrict tlEVnt8kGKkgOUYZKAXb1KawcsGvDr4beUlVChILStbye6OdwQxAhSvtcrV7MdF

