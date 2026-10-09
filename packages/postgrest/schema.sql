-- =============================================================================
-- Engram — Self-host PostgreSQL schema (idempotent)
-- =============================================================================
--
-- Apply via:   psql -U postgres -d engram -v ON_ERROR_STOP=1 -1 -f schema.sql
--
-- The file must contain no psql meta-commands (backslash lines such as
-- pg_dump's \restrict / \unrestrict), so that any psql client version and
-- SQL editors such as Supabase's can run it as plain SQL.
--
-- This file is the canonical schema source of truth for self-host installs.
-- It is GENERATED from a production dump (post-v0.4.0 rebrand) and made
-- idempotent so it can be re-applied safely to any database state:
--   - CREATE TABLE IF NOT EXISTS
--   - CREATE INDEX IF NOT EXISTS
--   - CREATE OR REPLACE FUNCTION
--   - CREATE EXTENSION IF NOT EXISTS
--   - DROP POLICY IF EXISTS … ; CREATE POLICY …
--   - ADD CONSTRAINT wrapped in a DO block gated on a pg_constraint lookup
--     (bare ADD CONSTRAINT errors on re-apply; IF NOT EXISTS has no PK/FK form)
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

-- pgvector extension required for vector(1536) columns. WITH SCHEMA is
-- mandatory: the dump preamble empties search_path, so an unqualified
-- CREATE EXTENSION has no target schema and fails on a fresh database.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- The vector RPCs set hnsw.iterative_scan and hnsw.max_scan_tuples, which
-- pgvector only knows from 0.8.0; older versions reject them at apply or
-- call time. Fail the apply early with an actionable message instead.
DO $$
DECLARE
  installed text;
BEGIN
  SELECT extversion INTO installed FROM pg_extension WHERE extname = 'vector';
  IF string_to_array(installed, '.')::int[] < '{0,8,0}'::int[] THEN
    RAISE EXCEPTION 'pgvector % is installed; engram requires pgvector >= 0.8.0. Run ALTER EXTENSION vector UPDATE; (after installing a newer pgvector) and re-apply.', installed;
  END IF;
END
$$;

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
-- Name: engram_association_walk(uuid[], integer, double precision, integer, text[]); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the signature without p_exclude_types so the new defaulted parameter
-- does not leave an ambiguous overload alongside the old function.
DROP FUNCTION IF EXISTS public.engram_association_walk(uuid[], integer, double precision, integer);

-- p_exclude_types names edge types the walk does not follow at any hop;
-- NULL or an empty array follows every type.
-- The inner DISTINCT ON keeps each memory's strongest path; the outer ORDER BY
-- then ranks memories by that strength before LIMIT, so the cut drops the
-- weakest paths rather than the highest ids, and memory_id breaks ties so
-- repeated calls return the same list.
CREATE OR REPLACE FUNCTION public.engram_association_walk(p_seed_ids uuid[], p_max_hops integer DEFAULT 2, p_min_strength double precision DEFAULT 0.2, p_limit integer DEFAULT 20, p_exclude_types text[] DEFAULT NULL::text[]) RETURNS TABLE(memory_id uuid, memory_type text, depth integer, path_strength double precision)
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
      AND (p_exclude_types IS NULL OR NOT (a.edge_type = ANY(p_exclude_types)))
      AND NOT (CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END) = ANY(w.visited_ids)
  )
  SELECT b.memory_id, b.memory_type, b.depth, b.path_strength
  FROM (
    SELECT DISTINCT ON (memory_id) memory_id, memory_type, depth, path_strength
    FROM walk WHERE depth > 0 ORDER BY memory_id, path_strength DESC, depth ASC
  ) b
  ORDER BY b.path_strength DESC, b.depth ASC, b.memory_id
  LIMIT p_limit
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
  WHERE confidence > 0.05 AND forgotten_at IS NULL AND superseded_by IS NULL
    AND (GREATEST(last_accessed, last_shown) IS NULL OR GREATEST(last_accessed, last_shown) < now() - (p_semantic_days || ' days')::interval);
  GET DIAGNOSTICS v_s = ROW_COUNT;
  UPDATE memory_procedural SET confidence = GREATEST(0.05, confidence - p_procedural_decay_rate), updated_at = now()
  WHERE confidence > 0.05 AND forgotten_at IS NULL
    AND (GREATEST(last_accessed, last_shown) IS NULL OR GREATEST(last_accessed, last_shown) < now() - (p_procedural_days || ' days')::interval);
  GET DIAGNOSTICS v_p = ROW_COUNT;
  DELETE FROM memory_associations WHERE strength < p_edge_prune_strength
    AND (last_activated IS NULL OR last_activated < now() - (p_edge_prune_days || ' days')::interval)
    AND edge_type != 'derives_from';
  GET DIAGNOSTICS v_e = ROW_COUNT;
  RETURN QUERY SELECT v_s, v_p, v_e;
END; $$;


--
-- Name: engram_decay_semantic_gradient(uuid[], double precision[], integer); Type: FUNCTION; Schema: public; Owner: -
--

-- Per-row decay rates (PageRank-weighted) applied in one set-based UPDATE.
-- p_ids and p_rates are parallel arrays; the floor and the live-row gates
-- match the flat semantic decay in engram_decay_pass.
CREATE OR REPLACE FUNCTION public.engram_decay_semantic_gradient(p_ids uuid[], p_rates double precision[], p_days integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_n int;
BEGIN
  UPDATE memory_semantic s SET confidence = GREATEST(0.05, s.confidence - u.rate), updated_at = now()
  FROM unnest(p_ids, p_rates) AS u(id, rate)
  WHERE s.id = u.id AND s.confidence > 0.05
    AND s.forgotten_at IS NULL AND s.superseded_by IS NULL
    AND (GREATEST(s.last_accessed, s.last_shown) IS NULL OR GREATEST(s.last_accessed, s.last_shown) < now() - make_interval(days => p_days));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;


--
-- Name: engram_digest_fact_failure(uuid, boolean, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

-- engram_digest_fact_failure replaces this function, which counted every
-- failure it was called for.
DROP FUNCTION IF EXISTS public.engram_digest_fact_attempt(uuid);

-- Records one failed fact-extraction unit on a digest in one statement, so
-- concurrent failures all land: every failure is added and sets the next
-- attempt time (deep sleep backs off by the failure count), and the attempt
-- count grows only when the run proved the failure is the digest's own.
-- Returns the attempt count after the update; deep sleep stops retrying a
-- digest at its attempt cap. An unknown id updates nothing and returns NULL.
CREATE OR REPLACE FUNCTION public.engram_digest_fact_failure(p_id uuid, p_counted boolean, p_next timestamp with time zone) RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE memory_digests
    SET fact_extraction_failures = fact_extraction_failures + 1,
        facts_next_attempt_at = p_next,
        fact_extraction_attempts = fact_extraction_attempts + CASE WHEN p_counted THEN 1 ELSE 0 END
    WHERE id = p_id
    RETURNING fact_extraction_attempts;
$$;


--
-- Name: engram_episode_kind(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

-- The kind of an episode, derived from fields every episode already carries,
-- so no row is rewritten to classify it. Rules in order, first match wins:
-- summary (metadata.type is a session or pre-compact summary), commit
-- (metadata.source git-commit), ruling, proposal, knowledge, decision and
-- progress (metadata.salienceCategory), note (source memory-ingest, or no
-- source in an unnamed session: NULL, '' or 'default'), and turn for every
-- other episode. The other tiers are a kind each (digest, fact, procedure),
-- applied by the search functions to the tier as a whole. The TypeScript
-- memoryKind() in @engram-mem/core and the SQLite adapter implement the same
-- rules and are checked against the same case file.
--
-- metadata->>'key' is NULL for an absent key and for JSON null, and the text
-- form of any other value; a non-string value never equals a rule's string,
-- so only a missing or null source counts as "no source".
--
-- IMMUTABLE and free of SET clauses so the planner can inline it and
-- idx_episodes_kind can index it. The body names only pg_catalog operators,
-- which resolve under any search_path, including the empty one this file
-- runs with. Changing the body changes what idx_episodes_kind holds: a
-- re-apply that alters it must REINDEX INDEX public.idx_episodes_kind.
-- engram_vector_search, engram_text_match and engram_bm25_match list every
-- kind this function can return, to skip the episode tier when none is
-- asked for: a kind added here must be added to those three lists.
--
-- An INSERT into memory_episodes evaluates the index expression as the
-- inserting role, which therefore needs EXECUTE: service_role has it, and the
-- SECURITY DEFINER functions run as the owner.
CREATE OR REPLACE FUNCTION public.engram_episode_kind(p_metadata jsonb, p_session_id text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN p_metadata->>'type' IN ('session-summary', 'pre-compact-summary') THEN 'summary'
    WHEN p_metadata->>'source' = 'git-commit' THEN 'commit'
    WHEN p_metadata->>'salienceCategory' = 'ruling' THEN 'ruling'
    WHEN p_metadata->>'salienceCategory' = 'proposal' THEN 'proposal'
    WHEN p_metadata->>'salienceCategory' IN ('fact', 'lesson', 'preference', 'external_fact', 'identity') THEN 'knowledge'
    WHEN p_metadata->>'salienceCategory' = 'decision' THEN 'decision'
    WHEN p_metadata->>'salienceCategory' IN ('milestone', 'plan', 'context_switch', 'risk', 'emotional_signal') THEN 'progress'
    WHEN p_metadata->>'source' = 'memory-ingest' THEN 'note'
    WHEN p_metadata->>'source' IS NULL AND (p_session_id IS NULL OR p_session_id IN ('', 'default')) THEN 'note'
    ELSE 'turn'
  END
$$;


--
-- Name: engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the pre-Wave-5 signature (without p_project_id) so the new defaulted
-- parameter does not create an ambiguous overload alongside the old function.
DROP FUNCTION IF EXISTS public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean);

-- RETURNS TABLE gained project_id (Wave 5) and then session_id (synthesis Stage 1), so CREATE OR REPLACE alone cannot upgrade an existing installation — drop the same-argument signature first.
DROP FUNCTION IF EXISTS public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text);

-- p_project_id is accepted for caller compatibility and filters nothing: a
-- project tag only ranks rows (in the client), it never excludes them.
-- The vs CTEs rank by distance through the HNSW indexes, where session_id and
-- superseded_by are post-filters; an iterative scan in strict order keeps
-- them from truncating the candidate list or reordering its ranks.
CREATE OR REPLACE FUNCTION public.engram_hybrid_recall(p_query_text text, p_query_embedding public.vector, p_match_count integer DEFAULT 10, p_full_text_weight double precision DEFAULT 1.0, p_semantic_weight double precision DEFAULT 1.0, p_rrf_k integer DEFAULT 60, p_session_id text DEFAULT NULL::text, p_include_episodes boolean DEFAULT true, p_include_digests boolean DEFAULT true, p_include_semantic boolean DEFAULT true, p_include_procedural boolean DEFAULT true, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, content text, salience double precision, access_count integer, created_at timestamp with time zone, similarity double precision, entities text[], project_id text, session_id text)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    SET hnsw.ef_search TO '150'
    SET hnsw.iterative_scan TO 'strict_order'
    SET hnsw.max_scan_tuples TO '20000'
    AS $$
  SELECT * FROM (
    WITH ft AS (
      SELECT me.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(me.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_episodes me
      WHERE p_include_episodes AND me.fts @@ websearch_to_tsquery('english', p_query_text)
        AND me.forgotten_at IS NULL
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
      LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT me.id, ROW_NUMBER() OVER (ORDER BY me.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_episodes me
      WHERE p_include_episodes AND me.embedding IS NOT NULL
        AND me.forgotten_at IS NULL
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
      ORDER BY me.embedding <=> p_query_embedding LIMIT p_match_count * 2
    )
    SELECT me.id, 'episode'::text AS memory_type, me.content,
      me.salience::float, me.access_count, me.created_at,
      (COALESCE(1.0/(p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight + COALESCE(1.0/(p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float AS sim,
      me.entities, me.project_id, me.session_id
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_episodes me ON COALESCE(ft.id, vs.id) = me.id
    ORDER BY 7 DESC LIMIT p_match_count
  ) ep

  UNION ALL

  SELECT * FROM (
    WITH ft AS (
      SELECT md.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(md.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_digests md WHERE p_include_digests AND md.fts @@ websearch_to_tsquery('english', p_query_text)
        LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT md.id, ROW_NUMBER() OVER (ORDER BY md.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_digests md WHERE p_include_digests AND md.embedding IS NOT NULL
      ORDER BY md.embedding <=> p_query_embedding LIMIT p_match_count * 2
    )
    SELECT md.id, 'digest'::text, md.summary, 0.5::float, 0, md.created_at,
      (COALESCE(1.0/(p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight + COALESCE(1.0/(p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      md.key_topics, md.project_id, md.session_id
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_digests md ON COALESCE(ft.id, vs.id) = md.id
    ORDER BY 7 DESC LIMIT p_match_count
  ) dg

  UNION ALL

  SELECT * FROM (
    WITH ft AS (
      SELECT ms.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ms.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_semantic ms WHERE p_include_semantic AND ms.fts @@ websearch_to_tsquery('english', p_query_text) AND ms.superseded_by IS NULL AND ms.forgotten_at IS NULL
        LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT ms.id, ROW_NUMBER() OVER (ORDER BY ms.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_semantic ms WHERE p_include_semantic AND ms.embedding IS NOT NULL AND ms.superseded_by IS NULL AND ms.forgotten_at IS NULL
      ORDER BY ms.embedding <=> p_query_embedding LIMIT p_match_count * 2
    )
    SELECT ms.id, 'semantic'::text, ms.content, ms.confidence::float, ms.access_count, ms.created_at,
      (COALESCE(1.0/(p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight + COALESCE(1.0/(p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      ARRAY[]::text[], ms.project_id, NULL::text
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_semantic ms ON COALESCE(ft.id, vs.id) = ms.id
    ORDER BY 7 DESC LIMIT p_match_count
  ) sm

  UNION ALL

  SELECT * FROM (
    WITH ft AS (
      SELECT mp.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(mp.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_procedural mp WHERE p_include_procedural AND mp.fts @@ websearch_to_tsquery('english', p_query_text) AND mp.forgotten_at IS NULL
        LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT mp.id, ROW_NUMBER() OVER (ORDER BY mp.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_procedural mp WHERE p_include_procedural AND mp.embedding IS NOT NULL AND mp.forgotten_at IS NULL
      ORDER BY mp.embedding <=> p_query_embedding LIMIT p_match_count * 2
    )
    SELECT mp.id, 'procedural'::text, mp.procedure, mp.confidence::float, mp.access_count, mp.created_at,
      (COALESCE(1.0/(p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight + COALESCE(1.0/(p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      ARRAY[]::text[], mp.project_id, NULL::text
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

-- RETURNS TABLE gained project_id (Wave 5) and then session_id (synthesis Stage 1), so CREATE OR REPLACE alone cannot upgrade an existing installation — drop the same-argument signature first.
DROP FUNCTION IF EXISTS public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text);

-- p_project_id is accepted for caller compatibility and filters nothing: a
-- project tag only ranks rows (in the client), it never excludes them.
-- The similarity floor filters each tier's nearest p_match_count rows from
-- outside the ordered subquery (its LIMIT keeps Postgres from pushing the
-- filter in). Inside an iterative HNSW scan a floor few rows pass would keep
-- the scan walking up to max_scan_tuples; outside it the result is the same,
-- because rows that pass the floor are always among the nearest ones.
CREATE OR REPLACE FUNCTION public.engram_recall(p_query_embedding public.vector, p_session_id text DEFAULT NULL::text, p_match_count integer DEFAULT 10, p_min_similarity double precision DEFAULT 0.3, p_include_episodes boolean DEFAULT true, p_include_digests boolean DEFAULT true, p_include_semantic boolean DEFAULT true, p_include_procedural boolean DEFAULT true, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, content text, salience double precision, access_count integer, created_at timestamp with time zone, similarity double precision, entities text[], project_id text, session_id text)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    SET hnsw.ef_search TO '150'
    SET hnsw.iterative_scan TO 'strict_order'
    SET hnsw.max_scan_tuples TO '20000'
    AS $$
  SELECT * FROM (
    SELECT id, 'episode'::text, content, salience::float, access_count, created_at,
           (1-(embedding<=>p_query_embedding))::float AS similarity, entities, project_id, session_id
    FROM memory_episodes
    WHERE p_include_episodes AND embedding IS NOT NULL
      AND forgotten_at IS NULL
      AND (p_session_id IS NULL OR session_id = p_session_id)
    ORDER BY embedding<=>p_query_embedding LIMIT p_match_count
  ) ep
  WHERE ep.similarity >= p_min_similarity
  UNION ALL
  SELECT * FROM (
    SELECT id, 'digest'::text, summary, 0.5::float, 0, created_at,
           (1-(embedding<=>p_query_embedding))::float AS similarity, key_topics, project_id, session_id
    FROM memory_digests
    WHERE p_include_digests AND embedding IS NOT NULL
    ORDER BY embedding<=>p_query_embedding LIMIT p_match_count
  ) dg
  WHERE dg.similarity >= p_min_similarity
  UNION ALL
  SELECT * FROM (
    SELECT id, 'semantic'::text, content, confidence::float, access_count, created_at,
           (1-(embedding<=>p_query_embedding))::float AS similarity, ARRAY[]::text[], project_id, NULL::text
    FROM memory_semantic
    WHERE p_include_semantic AND embedding IS NOT NULL AND superseded_by IS NULL
      AND forgotten_at IS NULL
    ORDER BY embedding<=>p_query_embedding LIMIT p_match_count
  ) sm
  WHERE sm.similarity >= p_min_similarity
  UNION ALL
  SELECT * FROM (
    SELECT id, 'procedural'::text, procedure, confidence::float, access_count, created_at,
           (1-(embedding<=>p_query_embedding))::float AS similarity, ARRAY[]::text[], project_id, NULL::text
    FROM memory_procedural
    WHERE p_include_procedural AND embedding IS NOT NULL
      AND forgotten_at IS NULL
    ORDER BY embedding<=>p_query_embedding LIMIT p_match_count
  ) pr
  WHERE pr.similarity >= p_min_similarity
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
      confidence = GREATEST(0.0, LEAST(1.0, confidence + p_conf_boost)), updated_at = now() WHERE id = p_id;
  ELSIF p_memory_type = 'procedural' THEN
    UPDATE memory_procedural SET access_count = access_count + 1, last_accessed = now(),
      confidence = GREATEST(0.0, LEAST(1.0, confidence + p_conf_boost)), updated_at = now() WHERE id = p_id;
  END IF;
END; $$;


--
-- Name: engram_record_shown(uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

-- Records that recall emitted these memories: shown_count + 1 and last_shown
-- for every listed row of one tier, in one set-based UPDATE. Exposure is not
-- access, so access_count, last_accessed, confidence and updated_at are left
-- alone. A duplicated id counts once. An unknown tier raises rather than
-- silently recording nothing.
CREATE OR REPLACE FUNCTION public.engram_record_shown(p_ids uuid[], p_memory_type text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_memory_type = 'episode' THEN
    UPDATE memory_episodes SET shown_count = shown_count + 1, last_shown = now() WHERE id = ANY(p_ids);
  ELSIF p_memory_type = 'semantic' THEN
    UPDATE memory_semantic SET shown_count = shown_count + 1, last_shown = now() WHERE id = ANY(p_ids);
  ELSIF p_memory_type = 'procedural' THEN
    UPDATE memory_procedural SET shown_count = shown_count + 1, last_shown = now() WHERE id = ANY(p_ids);
  ELSE
    RAISE EXCEPTION 'engram_record_shown: unknown memory type %', p_memory_type;
  END IF;
END; $$;


--
-- Name: engram_access_count_quantile(text, double precision); Type: FUNCTION; Schema: public; Owner: -
--

-- Interpolated q-quantile of access_count over one tier's live rows: not
-- forgotten and, for semantic, not superseded. A NULL access_count counts as
-- never accessed. An empty tier or an unknown memory type yields 0; callers
-- validate the type and q before calling.
CREATE OR REPLACE FUNCTION public.engram_access_count_quantile(p_memory_type text, p_q double precision) RETURNS double precision
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(percentile_cont(p_q) WITHIN GROUP (ORDER BY access_count), 0)::double precision
  FROM (
    SELECT COALESCE(e.access_count, 0) AS access_count FROM memory_episodes e
    WHERE p_memory_type = 'episode' AND e.forgotten_at IS NULL
    UNION ALL
    SELECT COALESCE(s.access_count, 0) FROM memory_semantic s
    WHERE p_memory_type = 'semantic' AND s.forgotten_at IS NULL AND s.superseded_by IS NULL
    UNION ALL
    SELECT COALESCE(p.access_count, 0) FROM memory_procedural p
    WHERE p_memory_type = 'procedural' AND p.forgotten_at IS NULL
  ) live
$$;


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
-- Name: engram_norm_quote(text); Type: FUNCTION; Schema: public; Owner: -
--

-- The quote rule: when an mk_statement counts as an exact quote of what was
-- said. normalizeQuote in @engram-mem/core runs the same four steps, and both
-- are tested against packages/core/src/items/quote.cases.json:
-- (1) Unicode NFC; (2) the curly single quotes U+2018-U+201B become ' and the
-- curly double quotes U+201C-U+201F become "; (3) each run of tab, LF, VT,
-- FF, CR, space, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F,
-- U+205F or U+3000 becomes one space; (4) leading and trailing spaces are
-- removed. btrim strips only U+0020, so a zero-width U+FEFF at the edge stays.
-- Case, dashes and zero-width characters stay: they can change what was said.
-- A quote occurs in a text when it normalizes to a non-empty substring of the
-- normalized text.
--
-- Every function is pg_catalog-qualified, so no search_path, the empty one
-- this file runs with included, changes what a name resolves to; there is no
-- SET clause, so the planner can inline it. The literals are E'' strings,
-- whose escapes mean the same whatever standard_conforming_strings is (VT is
-- written \x0B: E'' strings have no \v). normalize needs a UTF8 database.
CREATE OR REPLACE FUNCTION public.engram_norm_quote(p_text text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.translate(
        pg_catalog.normalize(p_text, 'NFC'),
        E'\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F',
        E'\x27\x27\x27\x27\x22\x22\x22\x22'),
      E'[\t\n\x0B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+',
      ' ',
      'g'),
    ' ')
$$;


--
-- Name: engram_time_in_range(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

-- True when the time is NULL or lies in years 1 to 9999 AD, in UTC:
-- 0001-01-01T00:00:00Z inclusive to 10000-01-01T00:00:00Z exclusive.
-- PostgreSQL stores 4713 BC to 294276 AD and the infinities, but to_json
-- writes a BC time with a trailing " BC" and a later year with five digits,
-- and neither is an ISO-8601 string a JSON reader can parse; infinity and
-- -infinity fall outside the range too, so this check is also the finite
-- check. Every timestamptz column of the item store tables carries it in a
-- CHECK. NULL passes, so a nullable column needs no separate guard. The
-- bounds carry an explicit offset, so neither TimeZone nor DateStyle changes
-- what they mean. It must exist before the tables whose CHECKs call it.
-- pg_catalog-qualified and without a SET clause, like engram_norm_quote.
CREATE OR REPLACE FUNCTION public.engram_time_in_range(p_time timestamp with time zone) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT p_time IS NULL
      OR (p_time OPERATOR(pg_catalog.>=) '0001-01-01 00:00:00+00'::pg_catalog.timestamptz
          AND p_time OPERATOR(pg_catalog.<) '10000-01-01 00:00:00+00'::pg_catalog.timestamptz)
$$;


--
-- Name: engram_times_in_range(timestamp with time zone[]); Type: FUNCTION; Schema: public; Owner: -
--

-- True when every element of the array is a time engram_time_in_range
-- accepts and none is NULL: a reader converting restated_at would otherwise
-- meet a restatement with no time. A CHECK constraint cannot hold a
-- subquery, so memory_items_finite_check reaches the restated_at elements
-- through this function.
CREATE OR REPLACE FUNCTION public.engram_times_in_range(p_times timestamp with time zone[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(p_times) AS t(v) WHERE t.v IS NULL OR NOT public.engram_time_in_range(t.v))
$$;


--
-- Name: engram_text_boost(text, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the pre-Wave-5 signature (without p_project_id) so the new defaulted
-- parameter does not create an ambiguous overload alongside the old function.
DROP FUNCTION IF EXISTS public.engram_text_boost(text, integer, text);

-- p_project_id is accepted for caller compatibility and filters nothing: a
-- project tag only ranks rows (in the client), it never excludes them.
-- Superseded by engram_text_match below and kept unchanged: a deploy applies
-- this schema before the service restarts, and the build still running until
-- then calls engram_text_boost.
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

    UNION ALL

    SELECT md.id, 'digest'::text,
      ts_rank_cd(md.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_digests md
    WHERE md.fts @@ to_tsquery('english', p_query_terms)

    UNION ALL

    SELECT ms.id, 'semantic'::text,
      ts_rank_cd(ms.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_semantic ms
    WHERE ms.fts @@ to_tsquery('english', p_query_terms)
      AND ms.superseded_by IS NULL
      AND ms.forgotten_at IS NULL

    UNION ALL

    SELECT mp.id, 'procedural'::text,
      ts_rank_cd(mp.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_procedural mp
    WHERE mp.fts @@ to_tsquery('english', p_query_terms)
      AND mp.forgotten_at IS NULL
  ) combined
  ORDER BY rank_score DESC
  LIMIT p_match_count
$$;


--
-- Name: engram_text_match(text[], integer, text, text, text[], text); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the signature without p_kinds and p_exclude_session_id: the new
-- defaulted parameters would otherwise leave a second overload, and PostgREST
-- cannot choose between two functions of one name.
DROP FUNCTION IF EXISTS public.engram_text_match(text[], integer, text, text);

-- Lexical match over the raw query terms. Each term becomes its own
-- phraseto_tsquery: that parser runs the term through the same 'english'
-- configuration to_tsvector used at index time, so the lexemes and their
-- positions match what was indexed ('aca-2613' -> 'aca' <-> '-2613',
-- 'gpt-4o' -> 'gpt-4o' <-> 'gpt' <-> '4o'), and it parses no operator syntax,
-- so a term like '--force' cannot become a negation inside the OR. Terms that
-- reduce to no lexemes (stop words, punctuation) are dropped; when none is
-- left the query is NULL and no row matches. p_project_id is accepted for
-- caller compatibility and filters nothing: a project tag only ranks rows (in
-- the client), it never excludes them. Rows with equal rank_score are ordered
-- by memory_type and id, a key unique across the tiers: otherwise the LIMIT
-- keeps whichever tied rows the scan meets first, and heap order changes
-- whenever recall rewrites a returned row (shown_count).
--
-- p_kinds keeps only rows of the named kinds: an episode by
-- engram_episode_kind, the other tiers as 'digest', 'fact' (semantic) and
-- 'procedure' (procedural). p_exclude_session_id leaves out the episodes and
-- digests of that session; semantic and procedural rows belong to no session
-- and are kept. With both NULL every row matches as before, in the same order.
--
-- The episode branch first tests p_kinds against the list of kinds
-- engram_episode_kind can return. That clause reads no column, so the
-- planner makes it a one-time filter: when no requested kind is an episode
-- kind, memory_episodes is not scanned at all. Being parameter-only, it is
-- estimated as always true and leaves the unfiltered plan's row estimates
-- as they were.
CREATE OR REPLACE FUNCTION public.engram_text_match(p_terms text[], p_match_count integer DEFAULT 30, p_session_id text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text, p_kinds text[] DEFAULT NULL::text[], p_exclude_session_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, rank_score double precision)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
  WITH term_queries AS (
    SELECT phraseto_tsquery('english', t) AS q
    FROM unnest(p_terms) AS t
  ),
  match_query AS (
    SELECT string_agg('(' || q::text || ')', ' | ')::tsquery AS q
    FROM term_queries
    WHERE numnode(q) > 0
  )
  SELECT id, memory_type, rank_score FROM (
    SELECT me.id, 'episode'::text AS memory_type,
      ts_rank_cd(me.fts, mq.q)::float AS rank_score
    FROM memory_episodes me, match_query mq
    WHERE me.fts @@ mq.q
      AND me.forgotten_at IS NULL
      AND (p_session_id IS NULL OR me.session_id = p_session_id)
      AND (p_kinds IS NULL OR p_kinds && ARRAY['summary', 'commit', 'ruling', 'proposal', 'knowledge', 'decision', 'progress', 'note', 'turn'])
      AND (p_kinds IS NULL OR engram_episode_kind(me.metadata, me.session_id) = ANY(p_kinds))
      AND (p_exclude_session_id IS NULL OR me.session_id IS DISTINCT FROM p_exclude_session_id)

    UNION ALL

    SELECT md.id, 'digest'::text,
      ts_rank_cd(md.fts, mq.q)::float
    FROM memory_digests md, match_query mq
    WHERE md.fts @@ mq.q
      AND (p_kinds IS NULL OR 'digest' = ANY(p_kinds))
      AND (p_exclude_session_id IS NULL OR md.session_id IS DISTINCT FROM p_exclude_session_id)

    UNION ALL

    SELECT ms.id, 'semantic'::text,
      ts_rank_cd(ms.fts, mq.q)::float
    FROM memory_semantic ms, match_query mq
    WHERE ms.fts @@ mq.q
      AND ms.superseded_by IS NULL
      AND ms.forgotten_at IS NULL
      AND (p_kinds IS NULL OR 'fact' = ANY(p_kinds))

    UNION ALL

    SELECT mp.id, 'procedural'::text,
      ts_rank_cd(mp.fts, mq.q)::float
    FROM memory_procedural mp, match_query mq
    WHERE mp.fts @@ mq.q
      AND mp.forgotten_at IS NULL
      AND (p_kinds IS NULL OR 'procedure' = ANY(p_kinds))
  ) combined
  ORDER BY rank_score DESC, memory_type, id
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
-- Name: engram_vector_search(public.vector, integer, text, text, text[], text); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the pre-Wave-5 signature (without p_project_id) so the new defaulted
-- parameter does not create an ambiguous overload alongside the old function.
DROP FUNCTION IF EXISTS public.engram_vector_search(public.vector, integer, text);

-- RETURNS TABLE gained project_id (Wave 5) and then session_id (synthesis Stage 1), so CREATE OR REPLACE alone cannot upgrade an existing installation — drop the same-argument signature first.
-- The same drop removes the signature without p_kinds and p_exclude_session_id,
-- which would otherwise stay as a second overload PostgREST cannot resolve.
DROP FUNCTION IF EXISTS public.engram_vector_search(public.vector, integer, text, text);

-- The HNSW settings below apply to every vector RPC: engram_vector_search,
-- engram_recall and engram_hybrid_recall each pin the same three, for the
-- reasons given here.
--
-- Each tier is its own nearest-N subquery with its own access path. For
-- engram_vector_search, measured on PostgreSQL 17 with pgvector 0.8.2 and the
-- SET clauses below, that path is never the HNSW index: see the note above
-- its CREATE. The settings below matter whenever a plan does use the index.
--
-- On the index path only the partial index predicate (`forgotten_at IS NULL`
-- on episodes, semantic and procedural; none on digests) is part of the
-- index. Every other condition (`p_session_id`, `p_kinds`,
-- `p_exclude_session_id`, semantic `superseded_by IS NULL`) is a post-filter
-- applied to the candidates the scan returns. A
-- plain HNSW scan returns at most `hnsw.ef_search` candidates (default 40),
-- so a selective post-filter can leave far fewer rows than the LIMIT asked
-- for.
--
-- `SET hnsw.ef_search TO '150'`: a vector RPC can be asked for up to 120
-- rows per tier (core recall's vector-search leg requests
-- strategy.maxResults * 4, and maxResults tops out at 30 for the
-- deep-sleep/light-sleep intents; see packages/core/src/retrieval/search.ts
-- and packages/core/src/intent/intents.ts). 150 covers the 120 ceiling with
-- headroom for the unfiltered case. Without the pin a function runs at the
-- server default of 40 and silently caps a plain scan below the LIMIT.
--
-- `SET hnsw.iterative_scan TO 'strict_order'`: when post-filters reject
-- candidates, the scan keeps pulling further candidates from the graph until
-- the LIMIT is filled or `hnsw.max_scan_tuples` tuples were visited.
-- `strict_order` keeps the returned rows in exact distance order, which the
-- per-tier LIMIT relies on (`relaxed_order` may return them out of order).
--
-- `SET hnsw.max_scan_tuples TO '20000'` bounds the work a filter that few
-- rows pass can cause; this is pgvector's default, pinned so a server-level
-- change cannot widen it silently.
--
-- hnsw.iterative_scan and hnsw.max_scan_tuples require pgvector >= 0.8.0.
--
-- p_project_id is accepted for caller compatibility and filters nothing: a
-- project tag only ranks rows (in the client), it never excludes them.
--
-- p_kinds and p_exclude_session_id filter as in engram_text_match.
--
-- Access path, measured on PostgreSQL 17 with pgvector 0.8.2 and these SET
-- clauses (other versions may plan differently): the SET clauses keep this
-- function from being inlined, so its statement gets a generic plan with the
-- arguments as unbound parameters. The planner costs a LIMIT given by a
-- parameter as 10% of the rows, which makes the HNSW path look several times
-- dearer than a sequential scan. At every measured size, from about 9,000 up
-- to 200,000 episodes, each tier is a sequential scan (parallel on the larger
-- tables) sorted by distance, with or without p_kinds and
-- p_exclude_session_id: the results are exact, and its time grows with the
-- table.
--
-- The episode kind test is `p_kinds IS NULL OR engram_episode_kind(...) =
-- ANY(p_kinds)`, a row filter in that scan; the planner neither uses
-- idx_episodes_kind nor reads its statistics. Because the scan is exact, a
-- filtered call returns min(LIMIT, matching rows) for the tier. The episode
-- tier also tests p_kinds against the episode kind list (see
-- engram_text_match), and on the other tiers the kind test names no column:
-- each is a one-time filter, so a tier left out by p_kinds is not scanned at
-- all.
CREATE OR REPLACE FUNCTION public.engram_vector_search(p_query_embedding public.vector, p_match_count integer DEFAULT 15, p_session_id text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text, p_kinds text[] DEFAULT NULL::text[], p_exclude_session_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, content text, role text, salience double precision, access_count integer, created_at timestamp with time zone, similarity double precision, entities text[], metadata jsonb, project_id text, session_id text)
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'public'
    SET hnsw.ef_search TO '150'
    SET hnsw.iterative_scan TO 'strict_order'
    SET hnsw.max_scan_tuples TO '20000'
    AS $$
  SELECT * FROM (
    SELECT * FROM (
      -- Episodes
      SELECT
        me.id, 'episode'::text, me.content, me.role,
        me.salience::float, me.access_count, me.created_at,
        (1 - (me.embedding <=> p_query_embedding))::float AS similarity,
        me.entities, me.metadata, me.project_id, me.session_id
      FROM memory_episodes me
      WHERE me.embedding IS NOT NULL
        AND me.forgotten_at IS NULL
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
        AND (p_kinds IS NULL OR p_kinds && ARRAY['summary', 'commit', 'ruling', 'proposal', 'knowledge', 'decision', 'progress', 'note', 'turn'])
        AND (p_kinds IS NULL OR engram_episode_kind(me.metadata, me.session_id) = ANY(p_kinds))
        AND (p_exclude_session_id IS NULL OR me.session_id IS DISTINCT FROM p_exclude_session_id)
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
        md.key_topics, md.metadata, md.project_id, md.session_id
      FROM memory_digests md
      WHERE md.embedding IS NOT NULL
        AND (p_kinds IS NULL OR 'digest' = ANY(p_kinds))
        AND (p_exclude_session_id IS NULL OR md.session_id IS DISTINCT FROM p_exclude_session_id)
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
        ARRAY[]::text[], ms.metadata, ms.project_id, NULL::text
      FROM memory_semantic ms
      WHERE ms.embedding IS NOT NULL AND ms.superseded_by IS NULL
        AND ms.forgotten_at IS NULL
        AND (p_kinds IS NULL OR 'fact' = ANY(p_kinds))
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
        ARRAY[]::text[], mp.metadata, mp.project_id, NULL::text
      FROM memory_procedural mp
      WHERE mp.embedding IS NOT NULL
        AND mp.forgotten_at IS NULL
        AND (p_kinds IS NULL OR 'procedure' = ANY(p_kinds))
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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
    fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    project_id text,
    forgotten_at timestamp with time zone,
    shown_count integer DEFAULT 0 NOT NULL,
    last_shown timestamp with time zone,
    CONSTRAINT memory_episodes_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
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
    shown_count integer DEFAULT 0 NOT NULL,
    last_shown timestamp with time zone,
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
    shown_count integer DEFAULT 0 NOT NULL,
    last_shown timestamp with time zone,
    CONSTRAINT memory_knowledge_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))
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
-- Item store. memory_items holds typed items: each row records who said or
-- produced it (speaker), how far it can be trusted (trust) and where it came
-- from (source, lineage). The rules below are CHECK constraints so that no
-- writer, the RPCs or a direct PostgREST request, can store an item the rules
-- refuse.
--
-- Three words name an item's state, here and in every comment below: live
-- means not forgotten; in force means live and not retired; current means in
-- force and not superseded. Retiring an item takes it out of force but keeps
-- it live, so it still stands in a supersession chain.
--
-- The tables are created in foreign-key order: subjects, extraction runs and
-- projects first, then memory_items, then the tables that point at items.
-- memory_extraction_runs.anchor_item_id points back at memory_items, so its
-- foreign key is added after memory_items exists.
--

--
-- Name: memory_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_subjects (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    project_id text,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_subjects_project_id_check CHECK (project_id IS NULL OR project_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
    CONSTRAINT memory_subjects_label_check CHECK (label ~ '\S' AND char_length(label) <= 200),
    CONSTRAINT memory_subjects_finite_check CHECK (public.engram_time_in_range(created_at))
);


--
-- Name: memory_extraction_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_extraction_runs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id text,
    anchor_item_id uuid,
    extractor_version text NOT NULL,
    model text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text NOT NULL,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    CONSTRAINT memory_extraction_runs_session_id_check CHECK (session_id IS NULL OR char_length(session_id) BETWEEN 1 AND 256),
    CONSTRAINT memory_extraction_runs_extractor_version_check CHECK (extractor_version ~ '\S' AND char_length(extractor_version) <= 64),
    CONSTRAINT memory_extraction_runs_status_check CHECK (status IN ('running', 'succeeded', 'failed')),
    CONSTRAINT memory_extraction_runs_finite_check CHECK (public.engram_time_in_range(started_at)
        AND public.engram_time_in_range(finished_at))
);


--
-- Name: memory_projects; Type: TABLE; Schema: public; Owner: -
--
-- The registry of project and workspace ids items may carry. A workspace
-- groups projects and belongs to no workspace itself. workspace_id must name a
-- row of kind workspace: the foreign key pairs it with workspace_kind, a
-- constant 'workspace', against the unique (id, kind), so naming a project is
-- refused and so is turning a named workspace into a project.
--

CREATE TABLE IF NOT EXISTS public.memory_projects (
    id text PRIMARY KEY,
    kind text NOT NULL,
    workspace_id text,
    workspace_kind text GENERATED ALWAYS AS ('workspace') STORED NOT NULL,
    vault_folder text,
    register_prefix text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_projects_id_check CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
    CONSTRAINT memory_projects_kind_check CHECK (kind IN ('project', 'workspace')),
    CONSTRAINT memory_projects_workspace_check CHECK (kind = 'project' OR workspace_id IS NULL),
    CONSTRAINT memory_projects_vault_folder_check CHECK (vault_folder IS NULL OR char_length(vault_folder) <= 200),
    CONSTRAINT memory_projects_register_prefix_check CHECK (register_prefix IS NULL OR register_prefix ~ '^[A-Z]{2,6}$'),
    CONSTRAINT memory_projects_finite_check CHECK (public.engram_time_in_range(updated_at)),
    CONSTRAINT memory_projects_id_kind_key UNIQUE (id, kind),
    CONSTRAINT memory_projects_workspace_fkey FOREIGN KEY (workspace_id, workspace_kind) REFERENCES public.memory_projects (id, kind)
);


--
-- Name: memory_items; Type: TABLE; Schema: public; Owner: -
--
-- Class rules, one CHECK each:
-- - utterance: what was said in a session. MK's prompts and answers are
--   trust 0; assistant turns are trust 3.
-- - mk_statement: an exact quote of MK, trust 0. It needs a subject and a
--   non-empty lineage (the utterances it was quoted from).
-- - observation: written by the assistant; trust 2 when source.evidence is a
--   non-empty array of pointers, else 3. It needs a subject.
-- - artifact, document_section, session_index: produced by tools, trust 1.
-- - legacy: rows copied from the memory_* tiers, trust 3 whoever spoke.
-- Only utterances, observations and legacy rows may have the assistant as
-- speaker, so nothing the assistant wrote can be stored as MK's word.
--
-- A CHECK that evaluates to NULL passes, so the rules that compare nullable
-- columns use IS NOT DISTINCT FROM or CASE, whose WHEN treats NULL as false.
--

CREATE TABLE IF NOT EXISTS public.memory_items (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    class text NOT NULL,
    kind text NOT NULL,
    speaker text NOT NULL,
    trust smallint NOT NULL,
    project_id text,
    workspace_id text,
    plan_slug text,
    session_id text,
    subject_id uuid REFERENCES public.memory_subjects(id),
    content text NOT NULL,
    search_text text NOT NULL,
    context text,
    embedding public.vector(1536),
    embedding_model text,
    occurred_at timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    superseded_by uuid REFERENCES public.memory_items(id),
    restated_at timestamp with time zone[] DEFAULT '{}'::timestamp with time zone[] NOT NULL,
    retired_at timestamp with time zone,
    retired_reason text,
    forgotten_at timestamp with time zone,
    forgotten_reason text,
    standing boolean,
    register_status text,
    register_ref text,
    source jsonb NOT NULL,
    lineage uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    content_hash text NOT NULL,
    extraction_run_id uuid REFERENCES public.memory_extraction_runs(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_items_class_check CHECK (class IN ('utterance', 'mk_statement', 'observation', 'artifact', 'document_section', 'session_index', 'legacy')),
    CONSTRAINT memory_items_kind_check CHECK (CASE class
        WHEN 'utterance' THEN kind IN ('user_prompt', 'user_answer', 'assistant_turn')
        WHEN 'mk_statement' THEN kind IN ('ruling', 'fact', 'correction')
        WHEN 'observation' THEN kind IN ('fact', 'procedure', 'finding')
        WHEN 'artifact' THEN kind IN ('commit', 'pr', 'ledger_decision', 'ledger_ruling', 'ruling_entry')
        WHEN 'document_section' THEN kind IN ('note', 'plan_readme', 'plan_phase', 'plan_ledger', 'plan_ledger_log', 'finding', 'audit', 'research')
        WHEN 'session_index' THEN kind IN ('session')
        WHEN 'legacy' THEN kind IN ('legacy_episode', 'legacy_digest', 'legacy_fact')
        ELSE false END),
    CONSTRAINT memory_items_speaker_check CHECK (CASE class
        WHEN 'utterance' THEN (CASE WHEN kind = 'assistant_turn' THEN speaker = 'assistant' ELSE speaker = 'mk' END)
        WHEN 'mk_statement' THEN speaker = 'mk'
        WHEN 'observation' THEN speaker = 'assistant'
        WHEN 'artifact' THEN speaker = 'artifact'
        WHEN 'document_section' THEN speaker = 'artifact'
        WHEN 'session_index' THEN speaker = 'system'
        WHEN 'legacy' THEN speaker IN ('mk', 'assistant', 'system', 'artifact')
        ELSE false END),
    CONSTRAINT memory_items_trust_check CHECK (trust = CASE class
        WHEN 'utterance' THEN (CASE WHEN speaker = 'mk' THEN 0 ELSE 3 END)
        WHEN 'mk_statement' THEN 0
        WHEN 'observation' THEN (CASE WHEN jsonb_typeof(source -> 'evidence') = 'array' AND source -> 'evidence' <> '[]'::jsonb THEN 2 ELSE 3 END)
        WHEN 'artifact' THEN 1
        WHEN 'document_section' THEN 1
        WHEN 'session_index' THEN 1
        WHEN 'legacy' THEN 3
        ELSE -1 END),
    CONSTRAINT memory_items_assistant_check CHECK (speaker <> 'assistant' OR class IN ('utterance', 'observation', 'legacy')),
    CONSTRAINT memory_items_subject_check CHECK (class NOT IN ('mk_statement', 'observation') OR subject_id IS NOT NULL),
    CONSTRAINT memory_items_statement_lineage_check CHECK (class <> 'mk_statement' OR cardinality(lineage) > 0),
    CONSTRAINT memory_items_lineage_self_check CHECK (NOT (id = ANY (lineage)) AND array_position(lineage, NULL) IS NULL),
    CONSTRAINT memory_items_supersession_check CHECK ((superseded_by IS NULL OR superseded_by <> id) AND (superseded_by IS NULL) = (valid_to IS NULL) AND (valid_to IS NULL OR valid_to >= occurred_at)),
    CONSTRAINT memory_items_retired_check CHECK ((retired_at IS NULL) = (retired_reason IS NULL) AND (retired_reason IS NULL OR retired_reason ~ '\S')),
    CONSTRAINT memory_items_forgotten_check CHECK ((forgotten_at IS NULL) = (forgotten_reason IS NULL) AND (forgotten_reason IS NULL OR forgotten_reason ~ '\S')),
    CONSTRAINT memory_items_embedding_check CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
    CONSTRAINT memory_items_source_check CHECK (jsonb_typeof(source) = 'object'
        AND (source ->> 'type') IN ('transcript', 'history', 'git', 'ledger', 'register', 'vault', 'legacy', 'ingest_tool', 'extraction')
        AND (NOT (source ? 'event_key') OR (jsonb_typeof(source -> 'event_key') = 'string' AND (source ->> 'event_key') ~ '\S'
                                            AND char_length(source ->> 'event_key') <= 512))),
    CONSTRAINT memory_items_text_check CHECK (content ~ '\S' AND search_text ~ '\S' AND (context IS NULL OR context ~ '\S')),
    CONSTRAINT memory_items_ids_check CHECK ((project_id IS NULL OR project_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
        AND (workspace_id IS NULL OR workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
        AND (plan_slug IS NULL OR plan_slug ~ '^[a-z0-9][a-z0-9-]{0,127}$')
        AND (session_id IS NULL OR char_length(session_id) BETWEEN 1 AND 256)),
    CONSTRAINT memory_items_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT memory_items_register_check CHECK ((class = 'mk_statement') = (standing IS NOT NULL)
        AND (register_status IS NULL OR (register_status IN ('candidate', 'recorded', 'dismissed') AND class = 'mk_statement' AND standing IS TRUE))
        AND ((register_status IS NOT DISTINCT FROM 'recorded') = (register_ref IS NOT NULL))
        AND (register_ref IS NULL OR register_ref ~ '^(R-[A-Z]{2,6}-[0-9]+|plan:[a-z0-9][a-z0-9-]{0,79}/[A-Za-z0-9][A-Za-z0-9._-]{0,39})$')),
    CONSTRAINT memory_items_mk_decision_check CHECK (NOT (class = 'artifact' AND kind = 'ledger_decision' AND (source ->> 'by') IS NOT DISTINCT FROM 'mk')
        OR (coalesce(source ->> 'quote', '') ~ '\S' AND coalesce(source ->> 'quote_source', '') ~ '\S')),
    CONSTRAINT memory_items_finite_check CHECK (public.engram_time_in_range(occurred_at)
        AND public.engram_time_in_range(valid_to)
        AND public.engram_time_in_range(retired_at)
        AND public.engram_time_in_range(forgotten_at)
        AND public.engram_time_in_range(created_at)
        AND public.engram_times_in_range(restated_at))
);


--
-- Name: memory_item_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.memory_item_entities (
    item_id uuid NOT NULL REFERENCES public.memory_items(id) ON DELETE CASCADE,
    entity text NOT NULL,
    entity_type text NOT NULL,
    PRIMARY KEY (item_id, entity),
    CONSTRAINT memory_item_entities_entity_check CHECK (entity ~ '\S' AND char_length(entity) <= 2000 AND octet_length(entity) <= 2000),
    CONSTRAINT memory_item_entities_entity_type_check CHECK (entity_type IN ('ticket', 'repo', 'path', 'sha', 'url', 'package'))
);


--
-- Name: memory_item_links; Type: TABLE; Schema: public; Owner: -
--
-- Relations between items that neither supersede nor restate: an MK
-- statement that corrects an item, an assistant turn that retracts one, a
-- statement that changes a register entry. A link counts only while
-- from_item is neither retired nor forgotten; readers apply that, so retiring
-- or forgetting the source withdraws the link without deleting it. run_id is
-- the extraction run that wrote the link, NULL for one written outside
-- extraction.
CREATE TABLE IF NOT EXISTS public.memory_item_links (
    id bigserial PRIMARY KEY,
    from_item uuid NOT NULL REFERENCES public.memory_items(id),
    to_item uuid NOT NULL REFERENCES public.memory_items(id),
    rel text NOT NULL,
    run_id uuid REFERENCES public.memory_extraction_runs(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_item_links_rel_check CHECK (rel IN ('corrects', 'retracts', 'changes')),
    CONSTRAINT memory_item_links_distinct_check CHECK (from_item <> to_item),
    CONSTRAINT memory_item_links_finite_check CHECK (public.engram_time_in_range(created_at)),
    CONSTRAINT memory_item_links_from_to_rel_key UNIQUE (from_item, to_item, rel)
);


--
-- Name: memory_capture_events; Type: TABLE; Schema: public; Owner: -
--
-- Raw capture events, one row per (session_id, event_uuid): a replayed
-- delivery hits the unique key instead of adding a row.
--

CREATE TABLE IF NOT EXISTS public.memory_capture_events (
    id bigserial PRIMARY KEY,
    session_id text NOT NULL,
    event_uuid text NOT NULL,
    type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    cwd text,
    project jsonb DEFAULT '{}'::jsonb NOT NULL,
    plan_dirs text[] DEFAULT '{}'::text[] NOT NULL,
    client jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload jsonb NOT NULL,
    scrub jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    processed_at timestamp with time zone,
    error text,
    CONSTRAINT memory_capture_events_session_event_key UNIQUE (session_id, event_uuid),
    CONSTRAINT memory_capture_events_session_id_check CHECK (char_length(session_id) BETWEEN 1 AND 256),
    CONSTRAINT memory_capture_events_event_uuid_check CHECK (char_length(event_uuid) BETWEEN 1 AND 128),
    CONSTRAINT memory_capture_events_type_check CHECK (type IN ('user_prompt', 'user_answer', 'assistant_turn', 'session_start', 'session_end', 'pre_compact', 'git_commit', 'ledger_decision', 'ledger_ruling', 'briefing_shown', 'register_entry', 'candidate_status')),
    CONSTRAINT memory_capture_events_payload_check CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT memory_capture_events_attempts_check CHECK (attempts >= 0),
    CONSTRAINT memory_capture_events_finite_check CHECK (public.engram_time_in_range(occurred_at)
        AND public.engram_time_in_range(received_at)
        AND public.engram_time_in_range(processed_at))
);


--
-- Name: memory_session_state; Type: TABLE; Schema: public; Owner: -
--
-- One row per capture session, kept by engram_track_session_activity on
-- every event insert: the first and last event times, the last event id, the
-- last time an event of the session was received, and the latest session_end
-- time. The session index builder records what its index covers:
-- index_item_id is the index it last wrote or confirmed, indexed_event_id
-- the last event id that index reflects. 0 means no index reflects the
-- session as it stands: none was built yet, or an extraction commit changed
-- the statements or observations the index lists.
CREATE TABLE IF NOT EXISTS public.memory_session_state (
    session_id text PRIMARY KEY,
    first_event_at timestamp with time zone NOT NULL,
    last_event_at timestamp with time zone NOT NULL,
    last_event_id bigint NOT NULL,
    last_received_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    index_item_id uuid REFERENCES public.memory_items(id),
    indexed_event_id bigint DEFAULT 0 NOT NULL,
    CONSTRAINT memory_session_state_session_id_check CHECK (char_length(session_id) BETWEEN 1 AND 256),
    CONSTRAINT memory_session_state_indexed_event_id_check CHECK (indexed_event_id >= 0)
);


--
-- Name: memory_capture_event_counts; Type: TABLE; Schema: public; Owner: -
--
-- Running counts of capture events by state, so engram_capture_materialize
-- reports table-wide pending and dead counts without reading every
-- unprocessed event. The counts are the column sums over all rows:
-- memory_capture_events_count adds one row per change in an event's state,
-- insert-only so concurrent ingests never wait on each other, and
-- engram_capture_materialize folds the rows into one under its lock. pending
-- counts events with processed_at NULL and fewer than 3 attempts, dead those
-- with processed_at NULL and 3 attempts or more.
--

CREATE TABLE IF NOT EXISTS public.memory_capture_event_counts (
    id bigserial PRIMARY KEY,
    pending bigint NOT NULL,
    dead bigint NOT NULL
);


--
-- Name: memory_secret_hits; Type: TABLE; Schema: public; Owner: -
--
-- One row per value masked before storage: where it was and which detector
-- or registered secret name matched. The value itself is never stored.
--

CREATE TABLE IF NOT EXISTS public.memory_secret_hits (
    id bigserial PRIMARY KEY,
    found_at timestamp with time zone DEFAULT now() NOT NULL,
    target_table text NOT NULL,
    target_id text NOT NULL,
    field text NOT NULL,
    detector text NOT NULL,
    secret_name text,
    CONSTRAINT memory_secret_hits_target_table_check CHECK (target_table IN ('memory_capture_events', 'memory_items')),
    CONSTRAINT memory_secret_hits_text_check CHECK (target_id ~ '\S' AND field ~ '\S' AND detector ~ '\S' AND (secret_name IS NULL OR secret_name ~ '\S')),
    CONSTRAINT memory_secret_hits_finite_check CHECK (public.engram_time_in_range(found_at))
);


--
-- Name: memory_extraction_runs memory_extraction_runs_anchor_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_extraction_runs_anchor_item_id_fkey' AND conrelid = 'public.memory_extraction_runs'::regclass) THEN
    ALTER TABLE ONLY public.memory_extraction_runs
      ADD CONSTRAINT memory_extraction_runs_anchor_item_id_fkey FOREIGN KEY (anchor_item_id) REFERENCES public.memory_items(id);
  END IF;
END $$;


--
-- Storage parameters of memory_items. Items are updated in place: once for the
-- embedding, again for supersession, restatement and register status.
-- The optional BM25 index (bm25.sql) counts every dead row version in its
-- document statistics until VACUUM removes it, so BM25 scores drift as dead
-- rows accumulate; autovacuum therefore runs at about 1% dead rows instead of
-- PostgreSQL's default 20%, and analyze at 2%. fillfactor 90 leaves free space in each page so an update that
-- touches no indexed column stays a HOT update and adds no index entry. Set by
-- ALTER TABLE rather than in CREATE TABLE so that re-applying the file also
-- converges an existing table.
--

ALTER TABLE public.memory_items SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 100, autovacuum_analyze_scale_factor = 0.02);


--
-- Columns and rules memory_items gained after it was first provisioned. CREATE
-- TABLE IF NOT EXISTS is a no-op on a database that already has the table, so
-- each is added here, idempotently, and reaches fresh and existing databases
-- alike.
-- - embedding_attempts and embedding_error: the capture worker raises the
--   count each time the embedding provider refuses an item's own text (HTTP
--   400 or 422) and keeps the provider's message, at most 500 characters. At
--   5 attempts the item leaves the pending set (engram_items_pending_embedding),
--   so one text the model can never take does not stop embedding for every
--   newer item; engram_items_embedding_failed_count reports how many left,
--   and engram_items_reset_embedding_failures returns them to the queue.
-- - embedding_claimed_by and embedding_claimed_until: the capture worker
--   that read the item for embedding, and when that claim lapses. The pending
--   read claims what it returns for 120 seconds and a worker renews its
--   claims while its pass runs, so two server processes never send the same
--   item to the provider; a crashed worker's claim lapses on its own.
--   memory_items_embedding_claim_check sets both or neither and keeps the
--   lapse time in range, as every timestamptz column of the item store is.
-- - memory_items_version_of_check bounds source.version_of as
--   memory_items_source_check bounds source.event_key: a non-blank string of
--   at most 512 characters, so every idx_items_version_of key fits a btree
--   index row.
-- Each constraint is added only when pg_constraint lacks it; a bare ADD
-- CONSTRAINT fails on re-apply.
--

ALTER TABLE public.memory_items ADD COLUMN IF NOT EXISTS embedding_attempts smallint DEFAULT 0 NOT NULL;
ALTER TABLE public.memory_items ADD COLUMN IF NOT EXISTS embedding_error text;
ALTER TABLE public.memory_items ADD COLUMN IF NOT EXISTS embedding_claimed_by uuid;
ALTER TABLE public.memory_items ADD COLUMN IF NOT EXISTS embedding_claimed_until timestamp with time zone;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_version_of_check' AND conrelid = 'public.memory_items'::regclass) THEN
    ALTER TABLE ONLY public.memory_items
      ADD CONSTRAINT memory_items_version_of_check CHECK (NOT (source ? 'version_of') OR (jsonb_typeof(source -> 'version_of') = 'string'
        AND (source ->> 'version_of') ~ '\S' AND char_length(source ->> 'version_of') <= 512));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_embedding_attempts_check' AND conrelid = 'public.memory_items'::regclass) THEN
    ALTER TABLE ONLY public.memory_items
      ADD CONSTRAINT memory_items_embedding_attempts_check CHECK (embedding_attempts BETWEEN 0 AND 5
        AND (embedding_error IS NULL OR (embedding_error ~ '\S' AND char_length(embedding_error) <= 500)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_embedding_claim_check' AND conrelid = 'public.memory_items'::regclass) THEN
    ALTER TABLE ONLY public.memory_items
      ADD CONSTRAINT memory_items_embedding_claim_check CHECK (public.engram_time_in_range(embedding_claimed_until)
        AND (embedding_claimed_by IS NULL) = (embedding_claimed_until IS NULL));
  END IF;
END $$;


--
-- Columns memory_capture_events gained after it was first provisioned, added
-- the same idempotent way.
-- - backfill: the event was posted by the history backfill (client name
--   'engram-backfill') or recovers a prompt from history (payload.origin).
--   Generated at insert, so engram_capture_materialize ranks sessions from
--   idx_capture_events_candidates instead of reading every pending payload.
--

ALTER TABLE public.memory_capture_events ADD COLUMN IF NOT EXISTS backfill boolean NOT NULL
    GENERATED ALWAYS AS ((payload ? 'origin') OR coalesce((client ->> 'name') = 'engram-backfill', false)) STORED;


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
-- Exposure columns: how often and how recently recall emitted a memory. They
-- are kept apart from access_count / last_accessed, which count only genuine
-- recurrence (a duplicate ingest, a re-extracted fact), so the ranking bonus
-- built on access_count does not feed on its own display history. Idempotent
-- for already-provisioned DBs, where CREATE TABLE IF NOT EXISTS is a no-op.
--
ALTER TABLE public.memory_episodes ADD COLUMN IF NOT EXISTS shown_count integer DEFAULT 0 NOT NULL;
ALTER TABLE public.memory_episodes ADD COLUMN IF NOT EXISTS last_shown timestamp with time zone;
ALTER TABLE public.memory_semantic ADD COLUMN IF NOT EXISTS shown_count integer DEFAULT 0 NOT NULL;
ALTER TABLE public.memory_semantic ADD COLUMN IF NOT EXISTS last_shown timestamp with time zone;
ALTER TABLE public.memory_procedural ADD COLUMN IF NOT EXISTS shown_count integer DEFAULT 0 NOT NULL;
ALTER TABLE public.memory_procedural ADD COLUMN IF NOT EXISTS last_shown timestamp with time zone;


--
-- Fact-extraction watermark: deep sleep extracts facts from the digests where
-- facts_extracted_at IS NULL and stamps each one. This file is re-applied on
-- every deploy, so it never stamps rows: a stamp here would also mark digests
-- written since the last apply and skip their extraction. Existing rows are
-- stamped once, by hand, when upgrading (see the package README).
--
ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS facts_extracted_at timestamp with time zone;

--
-- Fact-extraction failures counted against a digest: those its run proved
-- were the digest's own. Deep sleep reads only digests below its attempt cap.
-- A rederive resets it to 0.
--
ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS fact_extraction_attempts integer DEFAULT 0 NOT NULL;

--
-- Fact-extraction backoff: every failed unit, counted or not, adds to
-- fact_extraction_failures and sets facts_next_attempt_at; deep sleep reads a
-- digest again only once that time has passed (NULL: due now), so a digest
-- that keeps failing cannot hold the head of the oldest-first pending batch.
--
ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS facts_next_attempt_at timestamp with time zone;
ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS fact_extraction_failures integer DEFAULT 0 NOT NULL;


--
-- memory_episodes.fts converge: older installs generated fts from a since-removed
-- secondary text column (falling back to content). CREATE TABLE IF NOT EXISTS never
-- rewrites an existing column, so an install whose generation expression differs
-- from the declared content-only one gets fts dropped and re-added here (its GIN
-- index goes with it and is recreated). A no-op when the expression already
-- matches, so re-applying the file is safe. Runs before anything else in this
-- file touches memory_episodes columns or indexes.
--

DO $$
DECLARE
  current_expr text;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO current_expr
  FROM pg_attribute a
  JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.memory_episodes'::regclass
    AND a.attname = 'fts'
    AND a.attgenerated = 's'
    AND NOT a.attisdropped;

  IF current_expr IS NOT NULL
     AND current_expr <> 'to_tsvector(''english''::regconfig, content)' THEN
    ALTER TABLE public.memory_episodes DROP COLUMN fts;
    ALTER TABLE public.memory_episodes
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED;
    CREATE INDEX IF NOT EXISTS idx_episodes_fts ON public.memory_episodes USING gin (fts);
  END IF;
END $$;


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_pkey' AND conrelid = 'public.memories'::regclass) THEN
    ALTER TABLE ONLY public.memories
      ADD CONSTRAINT memories_pkey PRIMARY KEY (id);
  END IF;
END $$;


--
-- Name: memory_associations memory_associations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_associations_pkey' AND conrelid = 'public.memory_associations'::regclass) THEN
    ALTER TABLE ONLY public.memory_associations
      ADD CONSTRAINT memory_associations_pkey PRIMARY KEY (id);
  END IF;
END $$;


--
-- Name: memory_consolidation_runs memory_consolidation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_consolidation_runs_pkey' AND conrelid = 'public.memory_consolidation_runs'::regclass) THEN
    ALTER TABLE ONLY public.memory_consolidation_runs
      ADD CONSTRAINT memory_consolidation_runs_pkey PRIMARY KEY (id);
  END IF;
END $$;


--
-- Name: memory_digests memory_digests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_digests_pkey' AND conrelid = 'public.memory_digests'::regclass) THEN
    ALTER TABLE ONLY public.memory_digests
      ADD CONSTRAINT memory_digests_pkey PRIMARY KEY (id);
  END IF;
END $$;


--
-- Name: memory_episodes memory_episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_episodes_pkey' AND conrelid = 'public.memory_episodes'::regclass) THEN
    ALTER TABLE ONLY public.memory_episodes
      ADD CONSTRAINT memory_episodes_pkey PRIMARY KEY (id);
  END IF;
END $$;


--
-- Name: memory_semantic memory_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_knowledge_pkey' AND conrelid = 'public.memory_semantic'::regclass) THEN
    ALTER TABLE ONLY public.memory_semantic
      ADD CONSTRAINT memory_knowledge_pkey PRIMARY KEY (id);
  END IF;
END $$;


--
-- Name: memory_procedural memory_procedural_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_procedural_pkey' AND conrelid = 'public.memory_procedural'::regclass) THEN
    ALTER TABLE ONLY public.memory_procedural
      ADD CONSTRAINT memory_procedural_pkey PRIMARY KEY (id);
  END IF;
END $$;


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schema_migrations_pkey' AND conrelid = 'public.schema_migrations'::regclass) THEN
    ALTER TABLE ONLY public.schema_migrations
      ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);
  END IF;
END $$;


--
-- Name: sensory_snapshots sensory_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sensory_snapshots_pkey' AND conrelid = 'public.sensory_snapshots'::regclass) THEN
    ALTER TABLE ONLY public.sensory_snapshots
      ADD CONSTRAINT sensory_snapshots_pkey PRIMARY KEY (session_id);
  END IF;
END $$;


--
-- Name: memory_associations uq_association_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_association_pair' AND conrelid = 'public.memory_associations'::regclass) THEN
    ALTER TABLE ONLY public.memory_associations
      ADD CONSTRAINT uq_association_pair UNIQUE (source_id, target_id, edge_type);
  END IF;
END $$;


--
-- Name: idx_assoc_source_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_assoc_source_strength ON public.memory_associations USING btree (source_id, strength DESC);


--
-- Name: idx_assoc_target_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_assoc_target_strength ON public.memory_associations USING btree (target_id, strength DESC);


--
-- Name: idx_digests_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_digests_created ON public.memory_digests USING btree (created_at DESC);


--
-- Name: idx_digests_facts_due; Type: INDEX; Schema: public; Owner: -
--

-- Pending digests by next attempt time, then oldest first. It replaces the
-- created_at-only index; CREATE INDEX IF NOT EXISTS never changes an existing
-- index, so the new definition takes a new name.
DROP INDEX IF EXISTS public.idx_digests_facts_pending;
CREATE INDEX IF NOT EXISTS idx_digests_facts_due ON public.memory_digests USING btree (facts_next_attempt_at, created_at, id) WHERE (facts_extracted_at IS NULL);


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
-- Name: idx_episodes_capture_key; Type: INDEX; Schema: public; Owner: -
--
-- The capture route's replay probe is check-then-insert: two deliveries of
-- one capture (a spooled retry racing the original request that timed out on
-- the client but finished on the server) can both miss it. Only the store can
-- make them collide, so a capture key is unique per session here, and the
-- adapter reports the collision as a replay.
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_capture_key ON public.memory_episodes (session_id, (metadata->>'captureKey')) WHERE metadata ? 'captureKey';


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
-- Name: idx_episodes_kind; Type: INDEX; Schema: public; Owner: -
--
-- An expression index instead of a stored kind column: adding a stored
-- generated column rewrites memory_episodes and rebuilds its HNSW index,
-- while this builds one btree beside them. Partial on the rows recall can
-- return, as the HNSW index is. It serves a query that compares
-- engram_episode_kind(metadata, session_id) with a known kind list. The
-- search functions are planned with p_kinds as an unbound parameter behind
-- `p_kinds IS NULL OR ...`, so they use neither this index nor its
-- statistics; see engram_vector_search. Even a query with a literal kind
-- list, which can use this index as a bitmap scan, does not get estimates
-- from it: ANALYZE does collect statistics for the index expression, but
-- PostgreSQL's selectivity estimation does not consult the statistics of a
-- partial index, so the kind test is estimated with a default selectivity.
--
-- A plain CREATE INDEX blocks writes to memory_episodes while it builds; on
-- a large existing table build it first with CREATE INDEX CONCURRENTLY (see
-- the package README) and this statement then skips it.
--

CREATE INDEX IF NOT EXISTS idx_episodes_kind ON public.memory_episodes USING btree (public.engram_episode_kind(metadata, session_id)) WHERE (forgotten_at IS NULL);


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
-- Item store indexes. idx_items_event_key makes source.event_key unique where
-- present: it is the idempotency key of an item insert, and each writer
-- namespaces its keys. memory_items_source_check bounds a key at 512
-- characters: at most 4 bytes each in UTF-8, so at most 2,048 bytes, under the
-- btree limit of about 2,700 bytes per index row, past which an insert fails
-- with 54000 naming no column. idx_items_lineage serves the lineage @> ARRAY[id]
-- lookups that find the items derived from a given item. The HNSW index has
-- the same form and predicate as the tier tables' indexes above.
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_event_key ON public.memory_items USING btree ((source ->> 'event_key')) WHERE (source ? 'event_key');
CREATE INDEX IF NOT EXISTS idx_items_class_kind ON public.memory_items USING btree (class, kind);
CREATE INDEX IF NOT EXISTS idx_items_project ON public.memory_items USING btree (project_id) WHERE (project_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_session ON public.memory_items USING btree (session_id, occurred_at) WHERE (session_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_occurred ON public.memory_items USING btree (occurred_at);
CREATE INDEX IF NOT EXISTS idx_items_subject ON public.memory_items USING btree (subject_id) WHERE (subject_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_superseded_by ON public.memory_items USING btree (superseded_by) WHERE (superseded_by IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_lineage ON public.memory_items USING gin (lineage);
CREATE INDEX IF NOT EXISTS idx_items_embedding_hnsw ON public.memory_items USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (embedding IS NOT NULL AND forgotten_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_project_label ON public.memory_subjects USING btree ((coalesce(project_id, '')), lower(label));
CREATE INDEX IF NOT EXISTS idx_item_entities_type_entity ON public.memory_item_entities USING btree (entity_type, entity);
CREATE INDEX IF NOT EXISTS idx_item_links_to_item ON public.memory_item_links USING btree (to_item);
CREATE INDEX IF NOT EXISTS idx_item_links_run ON public.memory_item_links USING btree (run_id);
-- Materialize candidates in session and event-time order: one probe finds
-- each session's earliest candidate, a range scan its next ones. Replaces an
-- index over every unprocessed event in time order, which no ranking used.
DROP INDEX IF EXISTS public.idx_capture_events_pending;
CREATE INDEX IF NOT EXISTS idx_capture_events_candidates ON public.memory_capture_events USING btree (session_id, occurred_at, id) INCLUDE (backfill) WHERE (processed_at IS NULL AND attempts < 3);
CREATE INDEX IF NOT EXISTS idx_capture_events_session ON public.memory_capture_events USING btree (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_session ON public.memory_extraction_runs USING btree (session_id, started_at);

-- idx_extraction_runs_anchor_version allows one open or successful run per
-- anchor and extractor version: engram_extraction_begin inserts on it with ON
-- CONFLICT DO NOTHING, so two workers never extract the same window twice,
-- while failed runs stay beside it as the anchor's failure record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_extraction_runs_anchor_version ON public.memory_extraction_runs USING btree (anchor_item_id, extractor_version) WHERE (status IN ('running', 'succeeded'));

-- idx_items_version_of finds the current version of an item chain (a ledger
-- decision or register entry) when capture materializes a new version.
-- memory_items_version_of_check bounds source.version_of at 512 characters,
-- as memory_items_source_check bounds source.event_key, so every key fits a
-- btree index row.
CREATE INDEX IF NOT EXISTS idx_items_version_of ON public.memory_items USING btree ((source ->> 'version_of')) WHERE (source ? 'version_of');

-- idx_items_pending_embedding serves engram_items_pending_embedding's oldest
-- first read of items still waiting for a vector. Its predicate is the
-- eligibility clauses of that function's WHERE, word for word, so it holds
-- only the backlog embedding drains; the claim clause is checked on the rows
-- the index returns, so only items under another worker's live claim (at
-- most a few batches) are read and passed over. Assistant utterances and
-- legacy rows are never embedded by the worker, and an index that held them
-- would be walked whole on every idle call. CREATE INDEX IF NOT EXISTS keeps
-- an existing index whatever its predicate, so an index built before the
-- embedding_attempts clause, or one that still left session indexes out, is
-- dropped first and rebuilt; otherwise the planner could no longer match it
-- to the function and every call would scan the table.
DO $$ BEGIN
  IF EXISTS (SELECT 1
               FROM pg_catalog.pg_index x
               JOIN pg_catalog.pg_class c ON c.oid = x.indexrelid
              WHERE c.relname = 'idx_items_pending_embedding'
                AND c.relnamespace = 'public'::regnamespace
                AND (pg_catalog.pg_get_expr(x.indpred, x.indrelid) NOT LIKE '%(embedding_attempts < 5)%'
                     OR pg_catalog.pg_get_expr(x.indpred, x.indrelid) LIKE '%session_index%')) THEN
    DROP INDEX public.idx_items_pending_embedding;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_items_pending_embedding ON public.memory_items USING btree (created_at, id) WHERE (embedding IS NULL AND forgotten_at IS NULL AND embedding_attempts < 5 AND NOT (class = 'utterance' AND speaker = 'assistant') AND class <> 'legacy');


--
-- Item store triggers. The CHECKs on memory_items see one row at a time; the
-- rules below need other rows or the previous version of a row, so triggers
-- hold them, for every writer: the RPCs and the owner's direct writes alike.
-- A refusal raises SQLSTATE 23514 (check_violation) with the message
-- "<trigger name>: <reason>" and never quotes row data.
--
-- memory_items_lineage and memory_items_supersession are constraint triggers
-- deferred to commit, so a statement and the utterance it quotes may be
-- inserted in either order within one transaction. A caller that must fail
-- one unit of work without failing its transaction runs
-- SET CONSTRAINTS ALL IMMEDIATE at the end of the unit. Both lock the rows
-- they read FOR SHARE, which conflicts with the row lock an UPDATE takes: a
-- concurrent forget of one of those rows either waits for this commit, and
-- its cascade then sees the new item, or makes this check wait for the forget
-- to commit and then see the row forgotten. Either way no live item is left
-- pointing at a forgotten one.
--
-- A constraint trigger has no CREATE OR REPLACE, so every trigger here is
-- dropped and created again on each apply.
--

--
-- Name: memory_items_before_insert(); Type: FUNCTION; Schema: public; Owner: -
--

-- Every item is born live and unsuperseded, whoever writes it: a new row
-- carrying superseded_by, retired_at, retired_reason, forgotten_at,
-- forgotten_reason or a restatement is refused. Each of those is reached
-- through a later write that the RPCs and memory_items_before_update check
-- (a forget takes the forget lock and cascades, a supersession needs a live,
-- later successor); a row inserted already forgotten would skip the cascade
-- and the lineage check both.
-- content_hash, created_at and valid_to belong to the database: whatever a
-- writer sends is replaced, so the hash always matches the stored content.
-- valid_to is the successor's occurred_at while superseded_by is set, and a
-- new row has no successor, so it starts NULL.
-- A row with lineage takes the forget lock (7308892986227385959) shared
-- before it is written, as engram_insert_items does: its lineage check locks
-- those rows FOR SHARE, in no fixed order, while every function that locks
-- existing rows (forget, retire, unretire, supersede) locks them in its own
-- order, so the two would otherwise deadlock. Those functions hold the key
-- exclusively from before their first row lock: holding it shared makes
-- either wait for this transaction or this transaction wait for it, while
-- inserts still run beside each other (FOR SHARE locks do not conflict).
CREATE OR REPLACE FUNCTION public.memory_items_before_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_set text[];
BEGIN
  v_set := array_remove(ARRAY[
    CASE WHEN NEW.superseded_by IS NOT NULL THEN 'superseded_by' END,
    CASE WHEN NEW.retired_at IS NOT NULL THEN 'retired_at' END,
    CASE WHEN NEW.retired_reason IS NOT NULL THEN 'retired_reason' END,
    CASE WHEN NEW.forgotten_at IS NOT NULL THEN 'forgotten_at' END,
    CASE WHEN NEW.forgotten_reason IS NOT NULL THEN 'forgotten_reason' END,
    CASE WHEN cardinality(NEW.restated_at) > 0 THEN 'restated_at' END
  ]::text[], NULL);
  IF cardinality(v_set) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: a new item cannot carry %s', TG_NAME, array_to_string(v_set, ', '));
  END IF;
  IF cardinality(NEW.lineage) > 0 THEN
    PERFORM pg_advisory_xact_lock_shared(7308892986227385959);
  END IF;
  NEW.content_hash := encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex');
  NEW.created_at := now();
  NEW.valid_to := NULL;
  RETURN NEW;
END; $$;


--
-- Name: memory_items_before_update(); Type: FUNCTION; Schema: public; Owner: -
--

-- What was said never changes after insert: who said it and when, its text,
-- its source, lineage and extraction run. A changed fact is a new item that
-- supersedes the old one. Forgetting is permanent: forgotten_at is never
-- cleared, and once it is set neither it nor forgotten_reason changes. The
-- embedding, restatement, register, scope and subject columns stay writable.
-- service_role may only SELECT these tables and writes through the engram_*
-- RPCs, but the owner (a maintenance session, a later migration) writes
-- directly, so the lifecycle columns follow the same rules for every writer:
-- - superseded_by goes from NULL to an item only when that item exists, is
--   not forgotten, has the same class and occurred strictly later (pointing
--   at itself is left to memory_items_supersession_check).
-- - superseded_by moves from an item X to another valid successor, or back
--   to NULL, only when X is no longer in force: forgotten (the forget
--   cascade hands the supersession to the nearest successor still live) or
--   retired (a writer that retires a successor may restore or re-point what
--   it superseded). The rule reads X's state, not who is writing: while X is
--   in force the supersession stands, and only a forget or a retirement of X
--   releases it.
-- - a forgotten item's superseded_by, retired_at and retired_reason never
--   change again, and superseded_by does not change in the UPDATE that
--   forgets an item.
-- - forgotten_at goes from NULL to a time only in a transaction that a
--   forget has marked: engram_forget_items takes the forget lock (advisory
--   key 7308892986227385959) exclusively at transaction level before it
--   locks any row, then sets the transaction-local setting
--   engram.forget_lock_xact to txid_current(). The forget cascade locks rows
--   as it runs, so a forget that started without the lock would take row
--   locks in an order no other forget path shares and could deadlock with
--   them; taking the lock here would come after this row's lock and have the
--   same effect. The mark, not pg_locks, is the proof: pg_locks shows a
--   session-level hold of the key exactly as it shows a transaction-level
--   one, and pg_advisory_unlock can release a session-level hold before the
--   transaction ends, while a transaction-level lock lasts until commit or
--   rollback. A direct UPDATE that forgets is refused, under a session-level
--   lock as without one. A rolled-back savepoint reverts the mark with the
--   lock taken under it, and the txid comparison ignores a value left by SET
--   at session level or by an earlier transaction. Comparing a setting costs
--   no lock-table read, so a forget of N rows pays nothing per row.
-- memory_items_supersession still re-checks the target at commit, which
-- catches a target forgotten by another transaction after this check.
-- valid_to is derived again from superseded_by whenever either is in the
-- change, so a sent valid_to is ignored and the two never diverge.
CREATE OR REPLACE FUNCTION public.memory_items_before_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_changed text[];
  v_target record;
BEGIN
  v_changed := array_remove(ARRAY[
    CASE WHEN NEW.id IS DISTINCT FROM OLD.id THEN 'id' END,
    CASE WHEN NEW.class IS DISTINCT FROM OLD.class THEN 'class' END,
    CASE WHEN NEW.kind IS DISTINCT FROM OLD.kind THEN 'kind' END,
    CASE WHEN NEW.speaker IS DISTINCT FROM OLD.speaker THEN 'speaker' END,
    CASE WHEN NEW.trust IS DISTINCT FROM OLD.trust THEN 'trust' END,
    CASE WHEN NEW.session_id IS DISTINCT FROM OLD.session_id THEN 'session_id' END,
    CASE WHEN NEW.content IS DISTINCT FROM OLD.content THEN 'content' END,
    CASE WHEN NEW.context IS DISTINCT FROM OLD.context THEN 'context' END,
    CASE WHEN NEW.search_text IS DISTINCT FROM OLD.search_text THEN 'search_text' END,
    CASE WHEN NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN 'occurred_at' END,
    CASE WHEN NEW.source IS DISTINCT FROM OLD.source THEN 'source' END,
    CASE WHEN NEW.lineage IS DISTINCT FROM OLD.lineage THEN 'lineage' END,
    CASE WHEN NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN 'content_hash' END,
    CASE WHEN NEW.extraction_run_id IS DISTINCT FROM OLD.extraction_run_id THEN 'extraction_run_id' END,
    CASE WHEN NEW.created_at IS DISTINCT FROM OLD.created_at THEN 'created_at' END
  ]::text[], NULL);
  IF cardinality(v_changed) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: %s cannot change after insert', TG_NAME, array_to_string(v_changed, ', '));
  END IF;
  IF OLD.forgotten_at IS NOT NULL AND NEW.forgotten_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: forgotten_at cannot be cleared', TG_NAME);
  END IF;
  IF OLD.forgotten_at IS NOT NULL
     AND (NEW.forgotten_at IS DISTINCT FROM OLD.forgotten_at OR NEW.forgotten_reason IS DISTINCT FROM OLD.forgotten_reason) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: forgotten_at and forgotten_reason are set once', TG_NAME);
  END IF;
  IF OLD.forgotten_at IS NULL AND NEW.forgotten_at IS NOT NULL
     AND pg_catalog.current_setting('engram.forget_lock_xact', true) IS DISTINCT FROM pg_catalog.txid_current()::text THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: forgotten_at is set only by a forget that holds the forget lock for the whole transaction', TG_NAME);
  END IF;
  IF OLD.forgotten_at IS NOT NULL
     AND (NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
          OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
          OR NEW.retired_reason IS DISTINCT FROM OLD.retired_reason) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: a forgotten item keeps its superseded_by, retired_at and retired_reason', TG_NAME);
  END IF;
  IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
    IF NEW.forgotten_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s: superseded_by cannot change on an item being forgotten', TG_NAME);
    END IF;
    IF OLD.superseded_by IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.memory_items s
                    WHERE s.id = OLD.superseded_by AND s.forgotten_at IS NULL AND s.retired_at IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s: superseded_by is replaced or cleared only once the item it names is forgotten or retired', TG_NAME);
    END IF;
    IF NEW.superseded_by IS NOT NULL AND NEW.superseded_by <> NEW.id THEN
      SELECT t.class, t.occurred_at, t.forgotten_at INTO v_target
        FROM public.memory_items t
       WHERE t.id = NEW.superseded_by;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('%s: superseded_by names an item that does not exist', TG_NAME);
      ELSIF v_target.class <> NEW.class THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('%s: superseded_by names an item of another class', TG_NAME);
      ELSIF v_target.forgotten_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('%s: superseded_by names a forgotten item', TG_NAME);
      ELSIF v_target.occurred_at <= NEW.occurred_at THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('%s: superseded_by names an item that did not occur later', TG_NAME);
      END IF;
    END IF;
  END IF;
  IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by OR NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    NEW.valid_to := (SELECT i.occurred_at FROM public.memory_items i WHERE i.id = NEW.superseded_by);
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: memory_items_lineage(); Type: FUNCTION; Schema: public; Owner: -
--

-- Lineage names the items an item was derived from. At commit each of them
-- must exist and not be forgotten, and an mk_statement's content must occur,
-- under the quote rule (engram_norm_quote), in an utterance spoken by MK among
-- them: nothing is stored as MK's word unless MK said it. The lineage rows
-- stay locked FOR SHARE until the transaction ends.
-- Like every deferred check here, it judges the row as it stands at commit,
-- re-read rather than taken from the insert event: a row forgotten earlier in
-- the same transaction (the forget cascade reaches every row derived from a
-- forgotten item) asserts nothing, so its lineage is not checked.
CREATE OR REPLACE FUNCTION public.memory_items_lineage() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_item record;
  v_row record;
  v_found integer := 0;
  v_quote text;
  v_quoted boolean := false;
BEGIN
  SELECT i.class, i.content, i.lineage, i.forgotten_at INTO v_item
    FROM public.memory_items i
   WHERE i.id = NEW.id;
  IF NOT FOUND OR v_item.forgotten_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_item.class = 'mk_statement' THEN
    v_quote := public.engram_norm_quote(v_item.content);
  END IF;
  FOR v_row IN
    SELECT i.class, i.speaker, i.content, i.forgotten_at
      FROM public.memory_items i
     WHERE i.id = ANY (v_item.lineage)
       FOR SHARE
  LOOP
    v_found := v_found + 1;
    IF v_row.forgotten_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s: lineage contains a forgotten item', TG_NAME);
    END IF;
    IF v_quote <> '' AND NOT v_quoted AND v_row.class = 'utterance' AND v_row.speaker = 'mk'
       AND strpos(public.engram_norm_quote(v_row.content), v_quote) > 0 THEN
      v_quoted := true;
    END IF;
  END LOOP;
  IF v_found < (SELECT count(DISTINCT l.id) FROM unnest(v_item.lineage) AS l(id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: lineage names an item that does not exist', TG_NAME);
  END IF;
  IF v_item.class = 'mk_statement' AND NOT v_quoted THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: the quote does not occur in an mk utterance of its lineage', TG_NAME);
  END IF;
  RETURN NULL;
END; $$;


--
-- Name: memory_items_supersession(); Type: FUNCTION; Schema: public; Owner: -
--

-- At commit, a live item's superseded_by must name an item of the same class
-- that is not forgotten and occurred strictly later; strictly later event
-- times along a chain also rule out a cycle. Like every deferred check here,
-- it judges the row as it stands at commit, re-read rather than taken from
-- the event: the forget cascade may have moved the pointer since, and a row
-- forgotten in the same transaction asserts nothing (it keeps the pointer it
-- had when it was forgotten). The target row stays locked FOR SHARE until the
-- transaction ends. It fires on an UPDATE of superseded_by only:
-- memory_items_before_insert refuses a new row that carries one.
CREATE OR REPLACE FUNCTION public.memory_items_supersession() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_item record;
  v_target record;
BEGIN
  SELECT i.class, i.occurred_at, i.superseded_by, i.forgotten_at INTO v_item
    FROM public.memory_items i
   WHERE i.id = NEW.id;
  IF NOT FOUND OR v_item.superseded_by IS NULL OR v_item.forgotten_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.class, t.occurred_at, t.forgotten_at INTO v_target
    FROM public.memory_items t
   WHERE t.id = v_item.superseded_by
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: superseded_by names an item that does not exist', TG_NAME);
  ELSIF v_target.class <> v_item.class THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: superseded_by names an item of another class', TG_NAME);
  ELSIF v_target.forgotten_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: superseded_by names a forgotten item', TG_NAME);
  ELSIF v_target.occurred_at <= v_item.occurred_at THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: superseded_by names an item that did not occur later', TG_NAME);
  END IF;
  RETURN NULL;
END; $$;


--
-- Name: memory_items_forget_cascade(); Type: FUNCTION; Schema: public; Owner: -
--

-- Runs when forgotten_at goes from NULL to set, in a transaction a forget has
-- marked after taking the forget lock (memory_items_before_update refuses
-- any other):
-- (a) every live item derived from this one, directly or through other live
--     items, is forgotten in one UPDATE with the same forgotten_at and the
--     reason "lineage: <id> forgotten", naming this item. Those updates fire
--     this trigger again, and it finds nothing live below them, so triggers
--     nest one level deep whatever the depth of the lineage. UNION, not
--     UNION ALL, ends the walk on a lineage cycle.
-- (b) every live item this one superseded is re-pointed to the nearest live
--     item further along the superseded_by chain, read now, retired included:
--     retiring an item does not bring back the item it replaced. When none
--     remains it is restored (superseded_by cleared). valid_to follows superseded_by
--     through memory_items_before_update. The walk stops at an id it has
--     already seen, so a cycle not yet refused at commit cannot loop it.
CREATE OR REPLACE FUNCTION public.memory_items_forget_cascade() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_next uuid := NEW.superseded_by;
  v_seen uuid[] := ARRAY[NEW.id];
  v_step record;
  v_successor uuid;
BEGIN
  WITH RECURSIVE below(id) AS (
    SELECT i.id
      FROM public.memory_items i
     WHERE i.lineage @> ARRAY[NEW.id] AND i.forgotten_at IS NULL
    UNION
    SELECT i.id
      FROM below b
      JOIN public.memory_items i ON i.lineage @> ARRAY[b.id]
     WHERE i.forgotten_at IS NULL
  )
  UPDATE public.memory_items m
     SET forgotten_at = NEW.forgotten_at,
         forgotten_reason = format('lineage: %s forgotten', NEW.id)
    FROM below b
   WHERE m.id = b.id AND m.forgotten_at IS NULL;

  WHILE v_next IS NOT NULL AND NOT v_next = ANY (v_seen) LOOP
    SELECT i.superseded_by, i.forgotten_at INTO v_step
      FROM public.memory_items i
     WHERE i.id = v_next;
    EXIT WHEN NOT FOUND;
    IF v_step.forgotten_at IS NULL THEN
      v_successor := v_next;
      EXIT;
    END IF;
    v_seen := v_seen || v_next;
    v_next := v_step.superseded_by;
  END LOOP;

  UPDATE public.memory_items
     SET superseded_by = v_successor
   WHERE superseded_by = NEW.id AND forgotten_at IS NULL;
  RETURN NULL;
END; $$;


--
-- Name: memory_items triggers; Type: TRIGGER; Schema: public; Owner: -
--
-- The WHEN clauses skip rows a trigger has nothing to check: an item with no
-- lineage or no superseded_by, an UPDATE that does not newly forget.
--

DROP TRIGGER IF EXISTS memory_items_before_insert ON public.memory_items;
CREATE TRIGGER memory_items_before_insert BEFORE INSERT ON public.memory_items FOR EACH ROW EXECUTE FUNCTION public.memory_items_before_insert();

DROP TRIGGER IF EXISTS memory_items_before_update ON public.memory_items;
CREATE TRIGGER memory_items_before_update BEFORE UPDATE ON public.memory_items FOR EACH ROW EXECUTE FUNCTION public.memory_items_before_update();

DROP TRIGGER IF EXISTS memory_items_lineage ON public.memory_items;
CREATE CONSTRAINT TRIGGER memory_items_lineage AFTER INSERT ON public.memory_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (cardinality(NEW.lineage) > 0) EXECUTE FUNCTION public.memory_items_lineage();

DROP TRIGGER IF EXISTS memory_items_supersession ON public.memory_items;
CREATE CONSTRAINT TRIGGER memory_items_supersession AFTER UPDATE OF superseded_by ON public.memory_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.superseded_by IS NOT NULL) EXECUTE FUNCTION public.memory_items_supersession();

DROP TRIGGER IF EXISTS memory_items_forget_cascade ON public.memory_items;
CREATE TRIGGER memory_items_forget_cascade AFTER UPDATE OF forgotten_at ON public.memory_items FOR EACH ROW WHEN (OLD.forgotten_at IS NULL AND NEW.forgotten_at IS NOT NULL) EXECUTE FUNCTION public.memory_items_forget_cascade();

-- engram_track_session_activity keeps memory_session_state for each inserted
-- capture event: least() of the first event time, greatest() of the last
-- event time, the last event id and the last received time, and the latest
-- session_end time (greatest() ignores NULLs, so any other event leaves it
-- as it is). It fires per row, so the events of one session inserted in one
-- statement fold into a single row one after another.
CREATE OR REPLACE FUNCTION public.engram_track_session_activity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.memory_session_state AS s
         (session_id, first_event_at, last_event_at, last_event_id, last_received_at, ended_at)
  VALUES (NEW.session_id, NEW.occurred_at, NEW.occurred_at, NEW.id, NEW.received_at,
          CASE WHEN NEW.type = 'session_end' THEN NEW.occurred_at END)
  ON CONFLICT (session_id) DO UPDATE
     SET first_event_at = least(s.first_event_at, EXCLUDED.first_event_at),
         last_event_at = greatest(s.last_event_at, EXCLUDED.last_event_at),
         last_event_id = greatest(s.last_event_id, EXCLUDED.last_event_id),
         last_received_at = greatest(s.last_received_at, EXCLUDED.last_received_at),
         ended_at = greatest(s.ended_at, EXCLUDED.ended_at);
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS memory_capture_events_session_activity ON public.memory_capture_events;
CREATE TRIGGER memory_capture_events_session_activity AFTER INSERT ON public.memory_capture_events FOR EACH ROW EXECUTE FUNCTION public.engram_track_session_activity();

-- Events stored before the trigger existed fold into their sessions' rows
-- here. The fold is idempotent, so re-applying the file changes nothing. It
-- writes the rows in session_id order, the order every multi-row writer of
-- memory_session_state locks them in, so an apply during live capture cannot
-- deadlock with an ingest.
INSERT INTO public.memory_session_state AS s
       (session_id, first_event_at, last_event_at, last_event_id, last_received_at, ended_at)
SELECT c.session_id, min(c.occurred_at), max(c.occurred_at), max(c.id), max(c.received_at),
       max(c.occurred_at) FILTER (WHERE c.type = 'session_end')
  FROM public.memory_capture_events c
 GROUP BY c.session_id
 ORDER BY c.session_id
ON CONFLICT (session_id) DO UPDATE
   SET first_event_at = least(s.first_event_at, EXCLUDED.first_event_at),
       last_event_at = greatest(s.last_event_at, EXCLUDED.last_event_at),
       last_event_id = greatest(s.last_event_id, EXCLUDED.last_event_id),
       last_received_at = greatest(s.last_received_at, EXCLUDED.last_received_at),
       ended_at = greatest(s.ended_at, EXCLUDED.ended_at);


--
-- Name: memory_capture_events_count(); Type: FUNCTION; Schema: public; Owner: -
--

-- Keeps memory_capture_event_counts in step with memory_capture_events. As a
-- row trigger it adds one row holding the change in pending and dead that an
-- insert, update or delete makes, and nothing when the event's state is
-- unchanged; as a TRUNCATE trigger it clears the counts with the events.
CREATE OR REPLACE FUNCTION public.memory_capture_events_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_pending bigint := 0;
  v_dead bigint := 0;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    DELETE FROM public.memory_capture_event_counts;
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    IF OLD.processed_at IS NULL THEN
      IF OLD.attempts < 3 THEN v_pending := v_pending - 1; ELSE v_dead := v_dead - 1; END IF;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.processed_at IS NULL THEN
      IF NEW.attempts < 3 THEN v_pending := v_pending + 1; ELSE v_dead := v_dead + 1; END IF;
    END IF;
  END IF;
  IF v_pending <> 0 OR v_dead <> 0 THEN
    INSERT INTO public.memory_capture_event_counts (pending, dead) VALUES (v_pending, v_dead);
  END IF;
  RETURN NULL;
END; $$;


--
-- Name: memory_capture_events triggers; Type: TRIGGER; Schema: public; Owner: -
--
-- Only processed_at and attempts move an event between pending, dead and
-- processed, so updates of other columns skip the count.
--
-- A database that stored events before the counts existed starts from a count
-- of them. The triggers and that seed share one transaction, opened by the
-- table lock: applied with a plain psql -f, separate statements would commit
-- the triggers first, an ingest or materialize landing before the seed would
-- write a delta row, the seed would see a non-empty counts table and be
-- skipped, and pending would stay short by every event stored before the
-- triggers. Under the lock no event changes until the commit, so the counts
-- table is empty here exactly when the triggers are new or no event is
-- pending or dead, and counting then is right in both cases.
--
-- The lock is ACCESS EXCLUSIVE, the mode DROP TRIGGER needs, taken before any
-- other statement so the block never upgrades a lock it holds. A materialize
-- pass reads the events and then updates them; a weaker lock that blocks
-- writes (SHARE ROW EXCLUSIVE) would be granted beside the pass's read, the
-- DROP TRIGGER would then wait on that read, and the pass's UPDATE would wait
-- on the lock already held: a deadlock that rolls back the pass or stops the
-- apply partway. Asked for first, the lock simply waits for the pass to
-- commit.
--

DO $$ BEGIN
  LOCK TABLE public.memory_capture_events IN ACCESS EXCLUSIVE MODE;
  DROP TRIGGER IF EXISTS memory_capture_events_count ON public.memory_capture_events;
  CREATE TRIGGER memory_capture_events_count AFTER INSERT OR DELETE OR UPDATE OF processed_at, attempts ON public.memory_capture_events FOR EACH ROW EXECUTE FUNCTION public.memory_capture_events_count();
  DROP TRIGGER IF EXISTS memory_capture_events_count_truncate ON public.memory_capture_events;
  CREATE TRIGGER memory_capture_events_count_truncate AFTER TRUNCATE ON public.memory_capture_events FOR EACH STATEMENT EXECUTE FUNCTION public.memory_capture_events_count();
  IF NOT EXISTS (SELECT 1 FROM public.memory_capture_event_counts) THEN
    INSERT INTO public.memory_capture_event_counts (pending, dead)
    SELECT count(*) FILTER (WHERE c.attempts < 3), count(*) FILTER (WHERE c.attempts >= 3)
      FROM public.memory_capture_events c
     WHERE c.processed_at IS NULL;
  END IF;
END $$;


--
-- Item store RPCs, the only way service_role writes the item store: it may
-- SELECT the tables and nothing more (see the privileges section). Each write
-- that needs more than one statement or must be idempotent is one call:
-- PostgREST runs each request as one transaction, and its on_conflict names
-- columns, not the expression index on source->>'event_key'. Each is SECURITY
-- DEFINER with a fixed search_path, runs as the owner and is executable by
-- service_role only. An invalid
-- argument raises SQLSTATE 22023 (invalid_parameter_value) and a refused rule
-- 23514 (check_violation), both with the message "<function name>: <reason>",
-- which names keys and positions but never quotes a value. The triggers above
-- still check every row these functions write.
--

--
-- Name: engram_insert_items(jsonb); Type: FUNCTION; Schema: public; Owner: -
--


-- CREATE OR REPLACE cannot change the result columns, so a database holding an
-- earlier result shape of this function would refuse the re-apply. Its grants
-- are re-issued below.
DROP FUNCTION IF EXISTS public.engram_insert_items(jsonb);

-- Inserts 1 to 500 items given as JSON objects keyed by column name. Every
-- column may be sent except the ones the database or a later write owns:
-- superseded_by, valid_to, restated_at, retired_at, retired_reason,
-- forgotten_at, forgotten_reason, content_hash and created_at. Each key is checked for its
-- JSON type and for a value its column type accepts before anything is
-- written, so a bad value is reported by object position and key instead of
-- as a cast error that quotes it; class, kind, speaker, trust, content,
-- search_text, occurred_at and source are required. A missing id is generated;
-- two objects of one call may not send the same id, so every inserted row
-- maps back to exactly one position. occurred_at must be ISO-8601 with Z or a
-- +hh:mm offset: a form read through DateStyle or the session TimeZone (an
-- offset-less time, 'now', a US date) would store a time the sender did not
-- mean, and 'infinity' is no event time. It may lie at most 10 minutes past
-- now(), the clock skew a capture client is allowed; a later time is a wrong
-- clock, not an event. The four-digit year and that limit keep it below year
-- 10000; a year-1 time with a positive offset is still 1 BC in UTC, which
-- engram_time_in_range refuses, so that is reported by position too. source.event_key is absent or a
-- non-blank string of at most 512 characters, the bound that keeps it inside
-- a unique btree index row; any other key (a JSON null, a number, a blank
-- string, a longer string) is refused here by position instead of failing
-- memory_items_source_check or the index with no position. An object whose
-- source.event_key is already stored, or appears earlier in the same call, is
-- skipped and reported with the stored id and inserted = false, so a retried
-- delivery is a no-op; forgotten says whether that stored item is forgotten
-- (an inserted item never is). A lineage entry naming a skipped object's id
-- names the stored item instead, so a replay of an utterance and a new item
-- derived from it can arrive in one call. An inserted object whose lineage
-- names a forgotten item, directly or through a skipped object, is refused by
-- position. One row per object comes back, in input order. The deferred
-- lineage and supersession checks run at the caller's commit, so a statement
-- may come before the utterance it quotes and one failing object fails them
-- all.
CREATE OR REPLACE FUNCTION public.engram_insert_items(p_items jsonb) RETURNS TABLE(ord integer, id uuid, inserted boolean, forgotten boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count integer;
  v_problem text;
  v_ids uuid[];
  v_resolved uuid[];
  v_skipped boolean[];
  v_lineage jsonb;
  v_raced integer;
  v_inserted uuid[];
  v_result_ids uuid[];
  v_result_added boolean[];
  v_missing integer;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_insert_items: p_items must be a JSON array';
  END IF;
  v_count := jsonb_array_length(p_items);
  IF v_count < 1 OR v_count > 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = format('engram_insert_items: p_items holds %s objects, not 1 to 500', v_count);
  END IF;

  SELECT format('object %s is not a JSON object', t.n) INTO v_problem
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
   WHERE jsonb_typeof(t.e) <> 'object'
   ORDER BY t.n
   LIMIT 1;

  IF v_problem IS NULL THEN
    WITH spec(col, json_type, sql_type) AS (
      VALUES ('id', 'string', 'uuid'), ('class', 'string', NULL), ('kind', 'string', NULL),
             ('speaker', 'string', NULL), ('trust', 'number', 'smallint'), ('project_id', 'string', NULL),
             ('workspace_id', 'string', NULL), ('plan_slug', 'string', NULL), ('session_id', 'string', NULL),
             ('subject_id', 'string', 'uuid'), ('content', 'string', NULL), ('search_text', 'string', NULL),
             ('context', 'string', NULL), ('embedding', 'array', NULL), ('embedding_model', 'string', NULL),
             ('occurred_at', 'string', 'timestamptz'), ('standing', 'boolean', NULL), ('register_status', 'string', NULL), ('register_ref', 'string', NULL),
             ('source', 'object', NULL), ('lineage', 'array', NULL), ('extraction_run_id', 'string', 'uuid')
    ), field AS (
      SELECT t.n, k.key, k.value, s.col, s.json_type, s.sql_type
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
       CROSS JOIN LATERAL jsonb_each(t.e) AS k(key, value)
        LEFT JOIN spec s ON s.col = k.key
    ), problem AS (
      SELECT f.n, f.key,
             CASE
               WHEN f.col IS NULL THEN
                 format('object %s has the key %s, which is not an insert column', f.n, quote_ident(left(f.key, 63)))
               WHEN f.value = 'null'::jsonb THEN NULL
               WHEN jsonb_typeof(f.value) <> f.json_type THEN
                 format('object %s: %s must be a JSON %s or null', f.n, f.col, f.json_type)
               WHEN f.sql_type IS NOT NULL
                    AND NOT pg_input_is_valid(CASE WHEN f.json_type = 'string' THEN f.value #>> '{}' ELSE f.value::text END, f.sql_type) THEN
                 format('object %s: %s is not a valid %s', f.n, f.col, f.sql_type)
               WHEN f.col = 'occurred_at'
                    AND (f.value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' THEN
                 format('object %s: occurred_at must be ISO-8601 with Z or an offset', f.n)
               WHEN f.col = 'occurred_at'
                    AND (f.value #>> '{}')::timestamptz > now() + interval '10 minutes' THEN
                 format('object %s: occurred_at is more than 10 minutes ahead of now', f.n)
               WHEN f.col = 'occurred_at'
                    AND NOT public.engram_time_in_range((f.value #>> '{}')::timestamptz) THEN
                 format('object %s: occurred_at is before year 1 in UTC', f.n)
               WHEN f.col = 'embedding'
                    AND (jsonb_array_length(f.value) <> 1536
                         OR EXISTS (SELECT 1 FROM jsonb_array_elements(f.value) AS x(v)
                                     WHERE CASE WHEN jsonb_typeof(x.v) = 'number' THEN abs(x.v::text::numeric) > 3.4028234663852886e38 ELSE true END)) THEN
                 format('object %s: embedding must hold 1536 numbers in the real range', f.n)
               WHEN f.col = 'lineage'
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(f.value) AS x(v)
                                 WHERE jsonb_typeof(x.v) <> 'string' OR NOT pg_input_is_valid(x.v #>> '{}', 'uuid')) THEN
                 format('object %s: lineage must hold uuid strings only', f.n)
               WHEN f.col = 'source'
                    AND jsonb_typeof(f.value -> 'event_key') = 'string'
                    AND char_length(f.value ->> 'event_key') > 512 THEN
                 format('object %s: source.event_key is longer than 512 characters', f.n)
               WHEN f.col = 'source'
                    AND (f.value ? 'event_key')
                    AND NOT (jsonb_typeof(f.value -> 'event_key') = 'string' AND (f.value ->> 'event_key') ~ '\S') THEN
                 format('object %s: source.event_key must be absent or a non-blank string of at most 512 characters', f.n)
             END AS reason
        FROM field f
    )
    SELECT p.reason INTO v_problem
      FROM problem p
     WHERE p.reason IS NOT NULL
     ORDER BY p.n, p.key
     LIMIT 1;
  END IF;

  IF v_problem IS NULL THEN
    SELECT format('object %s has no %s', t.n, r.col) INTO v_problem
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
     CROSS JOIN unnest(ARRAY['class', 'kind', 'speaker', 'trust', 'content', 'search_text', 'occurred_at', 'source']) WITH ORDINALITY AS r(col, k)
     WHERE coalesce(t.e -> r.col, 'null'::jsonb) = 'null'::jsonb
     ORDER BY t.n, r.k
     LIMIT 1;
  END IF;

  IF v_problem IS NULL THEN
    WITH sent AS (
      SELECT t.n, (t.e ->> 'id')::uuid AS item_id
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
       WHERE t.e ->> 'id' IS NOT NULL
    ), firsts AS (
      SELECT s.n, first_value(s.n) OVER (PARTITION BY s.item_id ORDER BY s.n) AS first_n
        FROM sent s
    )
    SELECT format('objects %s and %s share an id', f.first_n, f.n) INTO v_problem
      FROM firsts f
     WHERE f.n > f.first_n
     ORDER BY f.n
     LIMIT 1;
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_insert_items: ' || v_problem;
  END IF;

  -- Objects with lineage take the forget lock shared before any row is
  -- written; memory_items_before_insert explains why.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS t(e)
              WHERE jsonb_typeof(t.e -> 'lineage') = 'array' AND jsonb_array_length(t.e -> 'lineage') > 0) THEN
    PERFORM pg_advisory_xact_lock_shared(7308892986227385959);
  END IF;

  v_ids := ARRAY(
    SELECT coalesce((t.e ->> 'id')::uuid, gen_random_uuid())
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
     ORDER BY t.n);

  -- Every object is resolved before a row is written: an object whose event
  -- key is stored, or held by an earlier object of the call, is skipped and
  -- stands for that item. Another object may name a skipped object's id in
  -- its lineage, as the caller's handle for the item it was derived from, so
  -- lineage is rewritten through this map; the stored id is then what the
  -- lineage check reads, instead of an id that is never written.
  WITH obj AS (
    SELECT t.n, t.e -> 'source' ->> 'event_key' AS event_key
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
  ), firsts AS (
    SELECT o.n, o.event_key,
           CASE WHEN o.event_key IS NULL THEN o.n
                ELSE first_value(o.n) OVER (PARTITION BY o.event_key ORDER BY o.n) END AS first_n
      FROM obj o
  )
  SELECT array_agg(coalesce(s.stored_id, v_ids[f.first_n::integer]) ORDER BY f.n),
         array_agg(s.stored_id IS NOT NULL OR f.first_n < f.n ORDER BY f.n)
    INTO v_resolved, v_skipped
    FROM firsts f
    LEFT JOIN LATERAL (
      SELECT x.id AS stored_id
        FROM public.memory_items x
       WHERE (x.source ? 'event_key') AND (x.source ->> 'event_key') = f.event_key
    ) s ON true;

  SELECT jsonb_agg(
           CASE WHEN jsonb_typeof(t.e -> 'lineage') = 'array' THEN
             (SELECT coalesce(jsonb_agg(to_jsonb(coalesce(v_resolved[array_position(v_ids, l.value::uuid)], l.value::uuid)) ORDER BY l.k), '[]'::jsonb)
                FROM jsonb_array_elements_text(t.e -> 'lineage') WITH ORDINALITY AS l(value, k))
           ELSE '[]'::jsonb END
           ORDER BY t.n)
    INTO v_lineage
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n);

  -- A lineage naming a forgotten item fails memory_items_lineage at commit
  -- with no position; it is named here, by the stored id or through a
  -- skipped object. The forget lock held shared above keeps a forget from
  -- changing what this reads before the call commits.
  SELECT format('object %s: lineage names a forgotten item', t.n) INTO v_problem
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
   WHERE NOT v_skipped[t.n::integer]
     AND EXISTS (SELECT 1
                   FROM jsonb_array_elements_text(v_lineage -> (t.n::integer - 1)) AS l(value)
                   JOIN public.memory_items x ON x.id = l.value::uuid
                  WHERE x.forgotten_at IS NOT NULL)
   ORDER BY t.n
   LIMIT 1;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_insert_items: ' || v_problem;
  END IF;

  WITH added AS (
    INSERT INTO public.memory_items AS m (
      id, class, kind, speaker, trust, project_id, workspace_id, plan_slug, session_id, subject_id,
      content, search_text, context, embedding, embedding_model, occurred_at, standing,
      register_status, register_ref, source, lineage, extraction_run_id)
    SELECT v_ids[t.n::integer],
           t.e ->> 'class',
           t.e ->> 'kind',
           t.e ->> 'speaker',
           (t.e ->> 'trust')::smallint,
           t.e ->> 'project_id',
           t.e ->> 'workspace_id',
           t.e ->> 'plan_slug',
           t.e ->> 'session_id',
           (t.e ->> 'subject_id')::uuid,
           t.e ->> 'content',
           t.e ->> 'search_text',
           t.e ->> 'context',
           CASE WHEN jsonb_typeof(t.e -> 'embedding') = 'array' THEN (t.e -> 'embedding')::text::public.vector END,
           t.e ->> 'embedding_model',
           (t.e ->> 'occurred_at')::timestamptz,
           (t.e ->> 'standing')::boolean,
           t.e ->> 'register_status',
           t.e ->> 'register_ref',
           t.e -> 'source',
           ARRAY(SELECT l.value::uuid
                   FROM jsonb_array_elements_text(v_lineage -> (t.n::integer - 1)) WITH ORDINALITY AS l(value, k)
                  ORDER BY l.k),
           (t.e ->> 'extraction_run_id')::uuid
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
     WHERE NOT v_skipped[t.n::integer]
     ORDER BY t.n
    ON CONFLICT ((source ->> 'event_key')) WHERE (source ? 'event_key') DO NOTHING
    RETURNING m.id
  )
  SELECT coalesce(array_agg(a.id), '{}'::uuid[]) INTO v_inserted FROM added a;

  -- An object resolved for insert that ON CONFLICT skipped had its event key
  -- committed by a concurrent call after the lookup above. When an object of
  -- this call names it in lineage, that lineage now names an id that is never
  -- written; a serialization failure rolls the call back, and its retry
  -- resolves the key to the stored item.
  SELECT t.n::integer INTO v_raced
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
   WHERE NOT v_skipped[t.n::integer]
     AND NOT v_ids[t.n::integer] = ANY (v_inserted)
     AND EXISTS (SELECT 1
                   FROM jsonb_array_elements(p_items) WITH ORDINALITY AS o(e, m)
                  CROSS JOIN LATERAL jsonb_array_elements_text(v_lineage -> (o.m::integer - 1)) AS l(value)
                  WHERE NOT v_skipped[o.m::integer] AND l.value::uuid = v_ids[t.n::integer])
   ORDER BY t.n
   LIMIT 1;
  IF v_raced IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'serialization_failure',
      MESSAGE = format('engram_insert_items: object %s was stored by a concurrent call, retry the call', v_raced);
  END IF;

  -- v_ids holds no id twice, so an id in v_inserted names its position
  -- exactly. Every other object was skipped on its event key, whose stored
  -- row is visible to this statement.
  SELECT array_agg(CASE WHEN v_ids[t.n::integer] = ANY (v_inserted) THEN v_ids[t.n::integer]
                        ELSE (SELECT x.id FROM public.memory_items x
                               WHERE (x.source ? 'event_key') AND (x.source ->> 'event_key') = (t.e -> 'source' ->> 'event_key')) END
                   ORDER BY t.n),
         array_agg(v_ids[t.n::integer] = ANY (v_inserted) ORDER BY t.n)
    INTO v_result_ids, v_result_added
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n);

  -- Unreachable while ON CONFLICT DO NOTHING behaves as documented: under
  -- READ COMMITTED the conflicting row is visible here, and under REPEATABLE
  -- READ an invisible one fails the INSERT with a serialization error. A
  -- NULL id would otherwise reach the caller as a stored item.
  v_missing := array_position(v_result_ids, NULL);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'internal_error',
      MESSAGE = format('engram_insert_items: object %s was neither inserted nor matched to a stored event key', v_missing);
  END IF;

  RETURN QUERY
  SELECT r.n::integer, r.item_id, r.added, x.forgotten_at IS NOT NULL
    FROM unnest(v_result_ids, v_result_added) WITH ORDINALITY AS r(item_id, added, n)
    JOIN public.memory_items x ON x.id = r.item_id
   ORDER BY r.n;
END; $$;


--
-- Name: engram_forget_items(uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

-- Forgets 1 to 50 listed items and every live item derived from them through
-- lineage, at any depth, in one UPDATE. The closure is computed first, each id
-- once: a listed id keeps the caller's reason, and a descendant gets
-- "lineage: <listed id> forgotten: <reason>", naming the first listed id
-- (in p_ids order) it descends from. The live listed items are locked FOR
-- UPDATE first; then the closure is recomputed and its new members locked,
-- in id order, until a pass adds none. A writer of a new descendant holds its
-- lineage rows FOR SHARE until it commits, so the lock waits for it and the
-- next pass sees its row; once every member is locked, no descendant and no
-- superseded_by pointer (its foreign key takes FOR KEY SHARE) can commit
-- against the closure. The UPDATE therefore forgets the whole closure itself,
-- the cascade trigger finds nothing left to forget, and the rows returned are
-- exactly what this call changed. The live items whose superseded_by is in
-- the closure are read before the UPDATE; the forget cascade trigger then
-- re-points each to the nearest live successor or restores it, and both
-- outcomes are reported with via = the forgotten successor. Unknown and
-- already forgotten ids yield no row. Rows: (item_id, 'forgotten', NULL) for
-- the listed ids in p_ids order, then (item_id, 'forgotten', listed id) for
-- the descendants, then (item_id, 'repointed' | 'restored', the forgotten
-- successor) ordered by item_id.
-- Forgets run one at a time: each takes the exclusive transaction-level
-- advisory lock 7308892986227385959 (the ASCII bytes of "engramfg") before
-- it locks any row. Two forgets over overlapping closures would otherwise
-- lock each other's rows in passes with no common order and deadlock.
-- The rule is the same for every function that locks existing item rows:
-- engram_retire_items, engram_unretire_items and engram_supersede_item hold
-- the key exclusively too, and every insert of a row with lineage holds it
-- shared, so no two writers that lock the same rows in different orders
-- ever run at once. Once it holds the key, the call sets the
-- transaction-local engram.forget_lock_xact to txid_current();
-- memory_items_before_update refuses forgotten_at in any transaction without
-- that mark, so every forget path takes its locks in this one order.
CREATE OR REPLACE FUNCTION public.engram_forget_items(p_ids uuid[], p_reason text) RETURNS TABLE(item_id uuid, effect text, via uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_closure uuid[];
  v_roots uuid[];
  v_locked uuid[];
  v_unlocked uuid[];
  v_successors uuid[];
  v_targets uuid[];
  v_forgotten uuid[];
  v_forgotten_via uuid[];
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 50 OR array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_forget_items: p_ids must hold 1 to 50 ids and no NULL';
  END IF;
  IF p_reason IS NULL OR p_reason !~ '\S' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_forget_items: p_reason must be non-blank and at most 2000 characters';
  END IF;

  PERFORM pg_advisory_xact_lock(7308892986227385959);
  PERFORM pg_catalog.set_config('engram.forget_lock_xact', pg_catalog.txid_current()::text, true);

  v_locked := ARRAY(
    SELECT m.id
      FROM public.memory_items m
     WHERE m.id = ANY (p_ids) AND m.forgotten_at IS NULL
     ORDER BY m.id
       FOR UPDATE);
  IF cardinality(v_locked) = 0 THEN
    RETURN;
  END IF;

  LOOP
    WITH RECURSIVE walk(node, root) AS (
      SELECT i.id, i.id
        FROM public.memory_items i
       WHERE i.id = ANY (p_ids) AND i.forgotten_at IS NULL
      UNION
      SELECT c.id, w.root
        FROM walk w
        JOIN public.memory_items c ON c.lineage @> ARRAY[w.node]
       WHERE c.forgotten_at IS NULL
    ), chosen AS (
      SELECT DISTINCT ON (w.node)
             w.node,
             CASE WHEN w.node = ANY (p_ids) THEN NULL ELSE w.root END AS root,
             array_position(p_ids, w.root) AS root_pos
        FROM walk w
       ORDER BY w.node, (w.node = w.root) DESC, array_position(p_ids, w.root)
    )
    SELECT array_agg(c.node ORDER BY c.root IS NOT NULL, c.root_pos, c.node),
           array_agg(c.root ORDER BY c.root IS NOT NULL, c.root_pos, c.node)
      INTO v_closure, v_roots
      FROM chosen c;

    EXIT WHEN v_closure IS NULL;
    v_unlocked := ARRAY(SELECT c.node FROM unnest(v_closure) AS c(node) WHERE NOT c.node = ANY (v_locked) ORDER BY c.node);
    EXIT WHEN cardinality(v_unlocked) = 0;
    PERFORM 1 FROM public.memory_items m WHERE m.id = ANY (v_unlocked) ORDER BY m.id FOR UPDATE;
    v_locked := v_locked || v_unlocked;
  END LOOP;

  IF v_closure IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg(s.id ORDER BY s.id), array_agg(s.superseded_by ORDER BY s.id)
    INTO v_successors, v_targets
    FROM public.memory_items s
   WHERE s.superseded_by = ANY (v_closure)
     AND s.forgotten_at IS NULL
     AND NOT (s.id = ANY (v_closure));

  WITH gone AS (
    UPDATE public.memory_items m
       SET forgotten_at = now(),
           forgotten_reason = CASE WHEN c.root IS NULL THEN p_reason
                                   ELSE format('lineage: %s forgotten: %s', c.root, p_reason) END
      FROM unnest(v_closure, v_roots) WITH ORDINALITY AS c(node, root, k)
     WHERE m.id = c.node AND m.forgotten_at IS NULL
    RETURNING m.id AS node, c.root AS root, c.k AS k
  )
  SELECT array_agg(g.node ORDER BY g.k), array_agg(g.root ORDER BY g.k)
    INTO v_forgotten, v_forgotten_via
    FROM gone g;

  IF v_forgotten IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT f.node, 'forgotten'::text, f.root
    FROM unnest(v_forgotten, v_forgotten_via) WITH ORDINALITY AS f(node, root, k)
   ORDER BY f.k;

  RETURN QUERY
  SELECT s.node,
         CASE WHEN m.superseded_by IS NULL THEN 'restored' ELSE 'repointed' END,
         s.target
    FROM unnest(v_successors, v_targets) AS s(node, target)
    JOIN public.memory_items m ON m.id = s.node
   WHERE s.target = ANY (v_forgotten)
     AND m.forgotten_at IS NULL
     AND m.superseded_by IS DISTINCT FROM s.target
   ORDER BY s.node;
END; $$;


--
-- Name: engram_retire_items(uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

-- Retires 1 to 50 live, unretired items: they stay stored and keep their
-- lineage, and readers leave them out by default. Returns the ids it retired.
-- It takes the forget advisory key (7308892986227385959) exclusively, then
-- locks the listed rows FOR NO KEY UPDATE in id order. A forget locks rows
-- in its own order, and a lineage check locks the rows a new item names FOR
-- SHARE in the order they were inserted; a retire locking the same rows in
-- id order could each wait on a row the other holds. Forgets and supersedes
-- hold the key exclusively, and inserts of rows with lineage hold it shared,
-- each from before its first row lock to commit, so a retire waits for every
-- one of them to finish, or they wait for it. Retires and unretires also
-- wait for each other.
-- FOR NO KEY UPDATE is the lock the UPDATE takes anyway (no key column
-- changes): it does not block a foreign-key check, which takes FOR KEY SHARE.
CREATE OR REPLACE FUNCTION public.engram_retire_items(p_ids uuid[], p_reason text) RETURNS SETOF uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 50 OR array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_retire_items: p_ids must hold 1 to 50 ids and no NULL';
  END IF;
  IF p_reason IS NULL OR p_reason !~ '\S' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_retire_items: p_reason must be non-blank and at most 2000 characters';
  END IF;
  PERFORM pg_advisory_xact_lock(7308892986227385959);
  PERFORM 1 FROM public.memory_items i WHERE i.id = ANY (p_ids) ORDER BY i.id FOR NO KEY UPDATE;
  RETURN QUERY
  WITH retired AS (
    UPDATE public.memory_items m
       SET retired_at = now(), retired_reason = p_reason
     WHERE m.id = ANY (p_ids) AND m.forgotten_at IS NULL AND m.retired_at IS NULL
    RETURNING m.id
  )
  SELECT r.id FROM retired r ORDER BY r.id;
END; $$;


--
-- Name: engram_unretire_items(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

-- Clears both retire columns on 1 to 50 live, retired items. Returns the ids
-- it unretired. It takes its locks in engram_retire_items's order, for the
-- same reason.
CREATE OR REPLACE FUNCTION public.engram_unretire_items(p_ids uuid[]) RETURNS SETOF uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 50 OR array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_unretire_items: p_ids must hold 1 to 50 ids and no NULL';
  END IF;
  PERFORM pg_advisory_xact_lock(7308892986227385959);
  PERFORM 1 FROM public.memory_items i WHERE i.id = ANY (p_ids) ORDER BY i.id FOR NO KEY UPDATE;
  RETURN QUERY
  WITH unretired AS (
    UPDATE public.memory_items m
       SET retired_at = NULL, retired_reason = NULL
     WHERE m.id = ANY (p_ids) AND m.forgotten_at IS NULL AND m.retired_at IS NOT NULL
    RETURNING m.id
  )
  SELECT u.id FROM unretired u ORDER BY u.id;
END; $$;


--
-- Name: engram_supersede_item(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

-- Marks p_old as superseded by p_new. Both rows are locked FOR UPDATE in id
-- order, so two calls on the same pair cannot deadlock, and every rule is
-- checked on the locked rows: both exist and are live, they differ, share a
-- class, p_new occurred strictly later, p_old is not retired (a retired item
-- is no longer current, so nothing replaces it), and p_old is not superseded
-- by a third item (replacing a successor is forgetting it). valid_to is never
-- set here: memory_items_before_update derives it from superseded_by as the
-- successor's occurred_at, so a backfilled pair keeps its event times. A missing or equal id is an
-- invalid argument (22023); a broken rule is refused (23514). Returns false
-- when p_old is already superseded by p_new; otherwise sets superseded_by, and
-- memory_items_before_update ends p_old's validity at p_new's event time.
-- Before locking a row it takes the forget advisory key
-- (7308892986227385959) exclusively, as every function that locks existing
-- item rows does. Id order alone is not enough: a lineage check locks the
-- rows a new item names FOR SHARE in insertion order, so an insert holding
-- p_old and then naming p_new would wait on this call while this call waits
-- on it. Inserts of rows with lineage hold the key shared until commit, so
-- the supersede waits for them, or they wait for it; supersedes also wait
-- for each other, for forgets and for retires.
CREATE OR REPLACE FUNCTION public.engram_supersede_item(p_old uuid, p_new uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_old record;
  v_new record;
BEGIN
  IF p_old IS NULL OR p_new IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_supersede_item: p_old and p_new are required';
  END IF;
  IF p_old = p_new THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_supersede_item: an item cannot supersede itself';
  END IF;

  PERFORM pg_advisory_xact_lock(7308892986227385959);
  PERFORM 1 FROM public.memory_items i WHERE i.id IN (p_old, p_new) ORDER BY i.id FOR UPDATE;

  SELECT i.class, i.occurred_at, i.superseded_by, i.retired_at, i.forgotten_at INTO v_old
    FROM public.memory_items i WHERE i.id = p_old;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_supersede_item: p_old names no item';
  END IF;
  SELECT i.class, i.occurred_at, i.forgotten_at INTO v_new
    FROM public.memory_items i WHERE i.id = p_new;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_supersede_item: p_new names no item';
  END IF;

  IF v_old.forgotten_at IS NOT NULL OR v_new.forgotten_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'engram_supersede_item: a forgotten item neither supersedes nor is superseded';
  END IF;
  IF v_old.class <> v_new.class THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'engram_supersede_item: the items have different classes';
  END IF;
  IF v_old.superseded_by = p_new THEN
    RETURN false;
  END IF;
  IF v_old.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'engram_supersede_item: p_old is already superseded by another item';
  END IF;
  IF v_old.retired_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'engram_supersede_item: p_old is retired';
  END IF;
  IF v_new.occurred_at <= v_old.occurred_at THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'engram_supersede_item: p_new did not occur later than p_old';
  END IF;

  UPDATE public.memory_items m
     SET superseded_by = p_new
   WHERE m.id = p_old;
  RETURN true;
END; $$;


--
-- Name: engram_sync_projects(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

-- Upserts the project registry into memory_projects. p_rows is a JSON array
-- of objects with exactly the keys id, kind, workspace_id, vault_folder and
-- register_prefix (id and kind strings, the others string or null), each id
-- once. Workspaces are written before projects, so a project may name a
-- workspace from the same call. A row absent from p_rows is never deleted:
-- items and events already carry its id. A row whose values are unchanged
-- keeps its updated_at. Returns the number of rows inserted or changed. A
-- malformed argument is an invalid argument (22023); a value the table
-- refuses raises its constraint's error (23514, 23503).
CREATE OR REPLACE FUNCTION public.engram_sync_projects(p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_workspaces integer;
  v_projects integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_sync_projects: p_rows must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_rows) AS e(r)
     WHERE CASE
             WHEN jsonb_typeof(e.r) IS DISTINCT FROM 'object' THEN true
             ELSE EXISTS (
                    SELECT 1 FROM jsonb_object_keys(e.r) AS k(key)
                     WHERE k.key NOT IN ('id', 'kind', 'workspace_id', 'vault_folder', 'register_prefix'))
               OR jsonb_typeof(e.r -> 'id') IS DISTINCT FROM 'string'
               OR jsonb_typeof(e.r -> 'kind') IS DISTINCT FROM 'string'
               OR coalesce(jsonb_typeof(e.r -> 'workspace_id'), 'missing') NOT IN ('string', 'null')
               OR coalesce(jsonb_typeof(e.r -> 'vault_folder'), 'missing') NOT IN ('string', 'null')
               OR coalesce(jsonb_typeof(e.r -> 'register_prefix'), 'missing') NOT IN ('string', 'null')
           END
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_sync_projects: every row must be an object with exactly id, kind, workspace_id, vault_folder and register_prefix, id and kind strings, the others string or null';
  END IF;
  IF (SELECT count(*) <> count(DISTINCT e.r ->> 'id') FROM jsonb_array_elements(p_rows) AS e(r)) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_sync_projects: p_rows names an id more than once';
  END IF;

  WITH upserted AS (
    INSERT INTO public.memory_projects AS p (id, kind, workspace_id, vault_folder, register_prefix)
    SELECT e.r ->> 'id', e.r ->> 'kind', e.r ->> 'workspace_id', e.r ->> 'vault_folder', e.r ->> 'register_prefix'
      FROM jsonb_array_elements(p_rows) AS e(r)
     WHERE e.r ->> 'kind' = 'workspace'
     ORDER BY e.r ->> 'id'
    ON CONFLICT (id) DO UPDATE
       SET kind = EXCLUDED.kind, workspace_id = EXCLUDED.workspace_id, vault_folder = EXCLUDED.vault_folder,
           register_prefix = EXCLUDED.register_prefix, updated_at = now()
     WHERE (p.kind, p.workspace_id, p.vault_folder, p.register_prefix)
           IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.workspace_id, EXCLUDED.vault_folder, EXCLUDED.register_prefix)
    RETURNING 1
  )
  SELECT count(*) INTO v_workspaces FROM upserted;

  -- Every other kind goes through this insert, so a kind that is neither
  -- value is refused by memory_projects_kind_check rather than skipped.
  WITH upserted AS (
    INSERT INTO public.memory_projects AS p (id, kind, workspace_id, vault_folder, register_prefix)
    SELECT e.r ->> 'id', e.r ->> 'kind', e.r ->> 'workspace_id', e.r ->> 'vault_folder', e.r ->> 'register_prefix'
      FROM jsonb_array_elements(p_rows) AS e(r)
     WHERE e.r ->> 'kind' IS DISTINCT FROM 'workspace'
     ORDER BY e.r ->> 'id'
    ON CONFLICT (id) DO UPDATE
       SET kind = EXCLUDED.kind, workspace_id = EXCLUDED.workspace_id, vault_folder = EXCLUDED.vault_folder,
           register_prefix = EXCLUDED.register_prefix, updated_at = now()
     WHERE (p.kind, p.workspace_id, p.vault_folder, p.register_prefix)
           IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.workspace_id, EXCLUDED.vault_folder, EXCLUDED.register_prefix)
    RETURNING 1
  )
  SELECT count(*) INTO v_projects FROM upserted;

  RETURN v_workspaces + v_projects;
END; $$;


--
-- Name: engram_capture_ingest(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

-- Stores capture events idempotently. p_events is a JSON array of 1 to 500
-- objects with exactly the keys session_id, event_uuid, type, occurred_at,
-- cwd, project, plan_dirs, client, payload, scrub and hits: session_id,
-- event_uuid, type and occurred_at strings, cwd a string or null, project,
-- client, payload and scrub objects, plan_dirs an array of strings, hits an
-- array of objects with exactly field, detector and secret_name, and
-- occurred_at an RFC 3339 timestamp with an offset. Each event
-- is inserted unless its (session_id, event_uuid) is already stored, from an
-- earlier call or earlier in this one; only a newly inserted event gets its
-- hits as memory_secret_hits rows. Returns one row per input, in input order
-- (ord from 1): the stored row's id and 'accepted' when this call inserted
-- it, 'duplicate' otherwise. The whole call is one transaction. A malformed
-- argument is an invalid argument (22023); a value the table refuses raises
-- its constraint's error (23514).
CREATE OR REPLACE FUNCTION public.engram_capture_ingest(p_events jsonb)
    RETURNS TABLE(ord integer, event_id bigint, status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_event jsonb;
  v_ord bigint;
  v_occurred timestamp with time zone;
  v_id bigint;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_capture_ingest: p_events must be a JSON array of 1 to 500 events';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_events) AS e(r)
     WHERE CASE
             WHEN jsonb_typeof(e.r) IS DISTINCT FROM 'object' THEN true
             ELSE (SELECT count(*) FROM jsonb_object_keys(e.r)) <> 11
               OR EXISTS (
                    SELECT 1 FROM jsonb_object_keys(e.r) AS k(key)
                     WHERE k.key NOT IN ('session_id', 'event_uuid', 'type', 'occurred_at', 'cwd', 'project',
                                         'plan_dirs', 'client', 'payload', 'scrub', 'hits'))
               OR jsonb_typeof(e.r -> 'session_id') IS DISTINCT FROM 'string'
               OR jsonb_typeof(e.r -> 'event_uuid') IS DISTINCT FROM 'string'
               OR jsonb_typeof(e.r -> 'type') IS DISTINCT FROM 'string'
               OR jsonb_typeof(e.r -> 'occurred_at') IS DISTINCT FROM 'string'
               OR coalesce(jsonb_typeof(e.r -> 'cwd'), 'missing') NOT IN ('string', 'null')
               OR jsonb_typeof(e.r -> 'project') IS DISTINCT FROM 'object'
               OR jsonb_typeof(e.r -> 'client') IS DISTINCT FROM 'object'
               OR jsonb_typeof(e.r -> 'payload') IS DISTINCT FROM 'object'
               OR jsonb_typeof(e.r -> 'scrub') IS DISTINCT FROM 'object'
               OR jsonb_typeof(e.r -> 'plan_dirs') IS DISTINCT FROM 'array'
               OR jsonb_typeof(e.r -> 'hits') IS DISTINCT FROM 'array'
               OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(e.r -> 'plan_dirs') AS d(v)
                     WHERE jsonb_typeof(d.v) IS DISTINCT FROM 'string')
               OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(e.r -> 'hits') AS h(v)
                     WHERE jsonb_typeof(h.v) IS DISTINCT FROM 'object'
                        OR (SELECT count(*) FROM jsonb_object_keys(h.v)) <> 3
                        OR jsonb_typeof(h.v -> 'field') IS DISTINCT FROM 'string'
                        OR jsonb_typeof(h.v -> 'detector') IS DISTINCT FROM 'string'
                        OR coalesce(jsonb_typeof(h.v -> 'secret_name'), 'missing') NOT IN ('string', 'null'))
           END
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_capture_ingest: every event must be an object with exactly session_id, event_uuid, type, occurred_at, cwd, project, plan_dirs, client, payload, scrub and hits, of their types';
  END IF;

  -- Every event's AFTER INSERT trigger upserts its session's state row, and
  -- that row lock is held to the end of the call. Taken in event order, two
  -- batches naming sessions A and B in opposite orders, or a batch and an
  -- extraction commit resetting both rows, would each hold one row and wait
  -- for the other: a deadlock (40P01). So the batch's session rows are locked
  -- first, in session_id order, the order every multi-row writer of
  -- memory_session_state uses. A session with no row yet gets one here; ON
  -- CONFLICT DO UPDATE locks a row another call created, and waits for it if
  -- that call has not committed. The new row starts at values every fold
  -- below replaces: least() and greatest() take the first stored event's
  -- times and id. The session has no stored event (an event always comes
  -- with its row), so the batch's first event of it is stored and folded.
  -- Locking a session before any of its events is inserted also keeps two
  -- calls from blocking each other on an event key of one session.
  INSERT INTO public.memory_session_state AS s
         (session_id, first_event_at, last_event_at, last_event_id, last_received_at)
  SELECT DISTINCT e.r ->> 'session_id', 'infinity'::timestamptz, '-infinity'::timestamptz, 0, '-infinity'::timestamptz
    FROM jsonb_array_elements(p_events) AS e(r)
   ORDER BY 1
  ON CONFLICT (session_id) DO UPDATE SET last_event_id = s.last_event_id;

  FOR v_event, v_ord IN SELECT e.r, e.n FROM jsonb_array_elements(p_events) WITH ORDINALITY AS e(r, n) ORDER BY e.n
  LOOP
    -- RFC 3339 with an offset only: the cast alone also takes words such as
    -- 'yesterday' and times with no zone, read in the session's TimeZone.
    IF (v_event ->> 'occurred_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = format('engram_capture_ingest: event %s has an occurred_at that is not a timestamp', v_ord);
    END IF;
    BEGIN
      v_occurred := (v_event ->> 'occurred_at')::timestamp with time zone;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = format('engram_capture_ingest: event %s has an occurred_at that is not a timestamp', v_ord);
    END;

    v_id := NULL;
    INSERT INTO public.memory_capture_events AS c
           (session_id, event_uuid, type, occurred_at, cwd, project, plan_dirs, client, payload, scrub)
    VALUES (v_event ->> 'session_id', v_event ->> 'event_uuid', v_event ->> 'type', v_occurred,
            v_event ->> 'cwd', v_event -> 'project',
            ARRAY(SELECT d.v FROM jsonb_array_elements_text(v_event -> 'plan_dirs') WITH ORDINALITY AS d(v, n)
                   ORDER BY d.n),
            v_event -> 'client', v_event -> 'payload', v_event -> 'scrub')
    ON CONFLICT (session_id, event_uuid) DO NOTHING
    RETURNING c.id INTO v_id;

    IF v_id IS NOT NULL THEN
      INSERT INTO public.memory_secret_hits (target_table, target_id, field, detector, secret_name)
      SELECT 'memory_capture_events', v_id::text, h.v ->> 'field', h.v ->> 'detector', h.v ->> 'secret_name'
        FROM jsonb_array_elements(v_event -> 'hits') WITH ORDINALITY AS h(v, n)
       ORDER BY h.n;
      ord := v_ord; event_id := v_id; status := 'accepted';
    ELSE
      -- The conflicting row is committed or was written earlier in this
      -- call: ON CONFLICT waits for a concurrent insert of the key to finish.
      SELECT c.id INTO v_id
        FROM public.memory_capture_events c
       WHERE c.session_id = v_event ->> 'session_id' AND c.event_uuid = v_event ->> 'event_uuid';
      ord := v_ord; event_id := v_id; status := 'duplicate';
    END IF;
    RETURN NEXT;
  END LOOP;
END; $$;


--
-- Name: engram_capture_materialize(integer); Type: FUNCTION; Schema: public; Owner: -
--

-- Turns up to p_limit (1 to 1000) stored capture events into items, one event
-- at a time, and returns what it did as JSON.
-- One call runs at a time: it first takes the transaction-level advisory lock
-- hashtextextended('engram.capture.materialize', 0) without waiting, and
-- without it returns {"locked": false} and touches nothing. PostgREST runs
-- each request as one transaction, so the lock lasts exactly this call.
-- Candidates are the events with processed_at NULL and fewer than 3 attempts.
-- A session is backfill while its earliest candidate carries payload.origin
-- or was posted by the client 'engram-backfill'; live sessions come first,
-- then everything by (occurred_at, id). Every event of a session shares its
-- session's rank, so a backlog never delays live capture and a session's
-- events always run in event-time order.
-- A call reads in proportion to p_limit and to the sessions with candidates,
-- never to the backlog: one probe of idx_capture_events_candidates per
-- session finds its earliest candidate (and so its rank, from the backfill
-- column), and sessions are then merged in rank order, each read only below
-- the p_limit-th best event so far. A session whose earliest candidate ranks
-- after that event cannot contribute, nor can any session after it.
-- Each event runs in its own subtransaction with the deferred constraint
-- triggers forced at its end (SET CONSTRAINTS ALL IMMEDIATE), so a broken
-- invariant fails that event alone: attempts goes up by one, error keeps the
-- first 500 characters of the message (never DETAIL, which can quote row
-- data), and the session's later events wait for the next call. At 3
-- attempts the event is dead and no longer holds its session back.
-- Serialization failures, deadlocks and lock timeouts are not the event's
-- fault, so they abort the whole call instead of costing an attempt.
-- Every item takes occurred_at, session_id, project_id and workspace_id from
-- its event (the project the route resolved), and source keys event_id,
-- session_id, event_uuid and event_key plus its type's keys; a source key
-- whose value would be null is left out. event_key is 'capture:<event id>',
-- 'git:<repo>:<sha>' for a commit, so the same commit captured by two
-- sessions is one item, and '<version_of>:<sha256 of the payload>' for a
-- ledger decision or register entry, so a repeated version is one item. An
-- insert whose event_key is already stored creates nothing.
-- A ledger decision or register entry is a new version of the item chain
-- named by source.version_of. The newest live head of that chain (retired
-- included) is superseded by the new version when the new one occurred
-- later, unless that head is retired: a retired item is no longer current,
-- engram_supersede_item refuses to replace it, and it keeps its retirement as
-- its end. The new version supersedes the head when it occurred earlier (a
-- late delivery); equal times fail the event. The new version takes the head's restated_at
-- (copied after the insert: a new item carries no restatement). A register
-- entry whose status is not 'active' is retired, and each entry it lists in
-- supersedes has its head retired unless already retired.
-- A prompt recovered from a legacy row takes that item as lineage; when the
-- item is missing or forgotten the event creates nothing, is marked
-- processed with error 'origin_not_found' and counts as skipped. A
-- candidate_status event sets the named mk_statement's register_status and
-- register_ref and fails when no such statement exists. briefing_shown and
-- the session markers create nothing.
-- Rows are locked by UPDATE here (restated_at, register columns) and by the
-- supersede and retire calls, so before the first event that can do either
-- the call takes the forget advisory key exclusively, as every function that
-- locks item rows does; inserts with lineage take it shared in
-- memory_items_before_insert. It is taken outside the event's subtransaction,
-- which would release it on a failure.
-- Returns {"locked": true, "processed", "failed", "skipped", "pending",
-- "dead"}: processed counts events marked processed by this call, skipped
-- included; pending (candidates left) and dead (3 attempts) are table-wide,
-- read from memory_capture_event_counts, whose rows the call folds into one.
CREATE OR REPLACE FUNCTION public.engram_capture_materialize(p_limit integer DEFAULT 200) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_ids bigint[] := '{}'::bigint[];
  v_ranks boolean[] := '{}'::boolean[];
  v_times timestamp with time zone[] := '{}'::timestamp with time zone[];
  v_session record;
  v_below_rank boolean;
  v_below_at timestamp with time zone;
  v_below_id bigint;
  v_upto_at timestamp with time zone;
  v_upto_id bigint;
  v_count_rows bigint;
  v_id bigint;
  e public.memory_capture_events%ROWTYPE;
  p jsonb;
  v_keyed boolean := false;
  v_blocked text[] := '{}'::text[];
  v_processed integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
  v_attempts integer;
  v_pending bigint;
  v_dead bigint;
  v_class text;
  v_kind text;
  v_plan text;
  v_content text;
  v_context text;
  v_search text;
  v_source jsonb;
  v_lineage uuid[];
  v_key text;
  v_version_of text;
  v_error text;
  v_new uuid;
  v_head record;
  v_superseded text;
  v_dot text := ' ' || chr(183) || ' ';
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_capture_materialize: p_limit must be from 1 to 1000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('engram.capture.materialize', 0)) THEN
    RETURN jsonb_build_object('locked', false);
  END IF;

  -- v_ids, v_ranks and v_times hold the best candidates so far in rank
  -- order; once there are p_limit of them, the last is the bound below which
  -- a later session's events must rank to displace it.
  FOR v_session IN
    WITH RECURSIVE heads AS (
      (SELECT c.session_id, c.occurred_at, c.id, c.backfill
         FROM public.memory_capture_events c
        WHERE c.processed_at IS NULL AND c.attempts < 3
        ORDER BY c.session_id, c.occurred_at, c.id
        LIMIT 1)
      UNION ALL
      SELECT n.session_id, n.occurred_at, n.id, n.backfill
        FROM heads h
       CROSS JOIN LATERAL (
         SELECT c.session_id, c.occurred_at, c.id, c.backfill
           FROM public.memory_capture_events c
          WHERE c.processed_at IS NULL AND c.attempts < 3 AND c.session_id > h.session_id
          ORDER BY c.session_id, c.occurred_at, c.id
          LIMIT 1) AS n
    )
    SELECT h.session_id, h.backfill, h.occurred_at, h.id
      FROM heads h
     ORDER BY h.backfill, h.occurred_at, h.id
     LIMIT p_limit
  LOOP
    EXIT WHEN cardinality(v_ids) = p_limit
          AND (v_session.backfill, v_session.occurred_at, v_session.id) > (v_below_rank, v_below_at, v_below_id);
    -- A plain row comparison, so the scan stops at the bound as an index
    -- condition instead of filtering the rest of the session.
    IF cardinality(v_ids) = p_limit AND v_session.backfill = v_below_rank THEN
      v_upto_at := v_below_at;
      v_upto_id := v_below_id;
    ELSE
      v_upto_at := 'infinity';
      v_upto_id := 9223372036854775807;
    END IF;
    SELECT coalesce(array_agg(m.id ORDER BY m.rank, m.occurred_at, m.id), '{}'),
           coalesce(array_agg(m.rank ORDER BY m.rank, m.occurred_at, m.id), '{}'),
           coalesce(array_agg(m.occurred_at ORDER BY m.rank, m.occurred_at, m.id), '{}')
      INTO v_ids, v_ranks, v_times
      FROM (SELECT u.id, u.rank, u.occurred_at
              FROM (SELECT b.id, b.rank, b.occurred_at
                      FROM unnest(v_ids, v_ranks, v_times) AS b(id, rank, occurred_at)
                    UNION ALL
                    (SELECT c.id, v_session.backfill, c.occurred_at
                       FROM public.memory_capture_events c
                      WHERE c.processed_at IS NULL AND c.attempts < 3 AND c.session_id = v_session.session_id
                        AND (c.occurred_at, c.id) < (v_upto_at, v_upto_id)
                      ORDER BY c.occurred_at, c.id
                      LIMIT p_limit)) AS u
             ORDER BY u.rank, u.occurred_at, u.id
             LIMIT p_limit) AS m;
    IF cardinality(v_ids) = p_limit THEN
      v_below_rank := v_ranks[p_limit];
      v_below_at := v_times[p_limit];
      v_below_id := v_ids[p_limit];
    END IF;
  END LOOP;

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO e FROM public.memory_capture_events c WHERE c.id = v_id;
    CONTINUE WHEN e.session_id = ANY (v_blocked);
    IF NOT v_keyed AND e.type IN ('ledger_decision', 'register_entry', 'candidate_status') THEN
      PERFORM pg_advisory_xact_lock(7308892986227385959);
      v_keyed := true;
    END IF;

    BEGIN
      SET CONSTRAINTS ALL DEFERRED;
      p := e.payload;
      v_class := NULL;
      v_plan := NULL;
      v_context := NULL;
      v_lineage := '{}'::uuid[];
      v_key := 'capture:' || e.id;
      v_version_of := NULL;
      v_error := NULL;
      v_new := NULL;

      CASE e.type
      WHEN 'user_prompt' THEN
        v_class := 'utterance';
        v_kind := 'user_prompt';
        v_content := p ->> 'text';
        v_search := v_content;
        v_source := jsonb_build_object('type', 'transcript', 'line', p -> 'transcript_line', 'truncated', p -> 'truncated');
        IF jsonb_typeof(p -> 'origin') = 'object' THEN
          v_source := v_source || jsonb_build_object('type', p -> 'origin' -> 'type', 'origin', p -> 'origin');
          IF (p -> 'origin' ->> 'type') = 'history' THEN
            v_source := v_source || jsonb_build_object('line', p -> 'origin' -> 'line');
          ELSIF (p -> 'origin' ->> 'type') = 'legacy' THEN
            v_lineage := ARRAY[(p -> 'origin' ->> 'id')::uuid];
            IF NOT EXISTS (SELECT 1 FROM public.memory_items i WHERE i.id = v_lineage[1] AND i.forgotten_at IS NULL) THEN
              v_error := 'origin_not_found';
            END IF;
          END IF;
        END IF;

      WHEN 'user_answer' THEN
        v_class := 'utterance';
        v_kind := 'user_answer';
        -- MK's words only: per question its answer and note, then the reply.
        SELECT string_agg(b.block, E'\n\n' ORDER BY b.n) INTO v_content
          FROM (SELECT q.n, concat_ws(E'\n', CASE WHEN a.answer ~ '\S' THEN a.answer END,
                                             CASE WHEN a.note ~ '\S' THEN a.note END) AS block
                  FROM jsonb_array_elements(p -> 'questions') WITH ORDINALITY AS q(v, n)
                 CROSS JOIN LATERAL (SELECT p -> 'answers' ->> (q.v ->> 'question') AS answer,
                                            p -> 'notes' ->> (q.v ->> 'question') AS note) AS a
                UNION ALL
                SELECT 2147483647, CASE WHEN (p ->> 'response') ~ '\S' THEN p ->> 'response' END) AS b
         WHERE b.block <> '';
        -- What was asked: header, question, the options offered.
        SELECT string_agg(concat_ws(E'\n',
                 CASE WHEN (q.v ->> 'header') ~ '\S' THEN format('[%s] %s', q.v ->> 'header', q.v ->> 'question')
                      ELSE q.v ->> 'question' END,
                 (SELECT string_agg('- ' || (o.v ->> 'label')
                                      || CASE WHEN (o.v ->> 'description') ~ '\S' THEN ': ' || (o.v ->> 'description') ELSE '' END,
                                    E'\n' ORDER BY o.n)
                    FROM jsonb_array_elements(q.v -> 'options') WITH ORDINALITY AS o(v, n)),
                 CASE WHEN (q.v -> 'multiSelect') = 'true'::jsonb THEN '(multi-select)' END),
               E'\n\n' ORDER BY q.n) INTO v_context
          FROM jsonb_array_elements(p -> 'questions') WITH ORDINALITY AS q(v, n);
        SELECT string_agg(b.block, E'\n\n' ORDER BY b.n) INTO v_search
          FROM (SELECT q.n, concat_ws(E'\n', 'Q: ' || (q.v ->> 'question'),
                                             CASE WHEN a.answer ~ '\S' THEN 'A: ' || a.answer END,
                                             CASE WHEN a.note ~ '\S' THEN 'Note: ' || a.note END) AS block
                  FROM jsonb_array_elements(p -> 'questions') WITH ORDINALITY AS q(v, n)
                 CROSS JOIN LATERAL (SELECT p -> 'answers' ->> (q.v ->> 'question') AS answer,
                                            p -> 'notes' ->> (q.v ->> 'question') AS note) AS a
                UNION ALL
                SELECT 2147483647, CASE WHEN (p ->> 'response') ~ '\S' THEN 'Response: ' || (p ->> 'response') END) AS b
         WHERE b.block <> '';
        v_source := jsonb_build_object('type', 'transcript', 'line', p -> 'transcript_line', 'truncated', p -> 'truncated');

      WHEN 'assistant_turn' THEN
        v_class := 'utterance';
        v_kind := 'assistant_turn';
        v_content := p ->> 'text';
        v_search := v_content;
        v_source := jsonb_build_object('type', 'transcript', 'line', p -> 'transcript_line', 'tools', p -> 'tools');

      WHEN 'git_commit' THEN
        v_class := 'artifact';
        v_kind := 'commit';
        v_content := p ->> 'message';
        v_search := concat_ws(E'\n', format('%s %s', p ->> 'repo', left(p ->> 'sha', 12)), p ->> 'message',
                              (SELECT string_agg(f.v, E'\n' ORDER BY f.n)
                                 FROM jsonb_array_elements_text(p -> 'files') WITH ORDINALITY AS f(v, n)
                                WHERE f.n <= 200));
        v_source := jsonb_build_object('type', 'git', 'repo', p -> 'repo', 'sha', p -> 'sha', 'files', p -> 'files');
        v_key := format('git:%s:%s', p ->> 'repo', p ->> 'sha');

      WHEN 'ledger_decision' THEN
        v_class := 'artifact';
        v_kind := 'ledger_decision';
        v_plan := p ->> 'plan';
        v_content := p ->> 'ruling';
        v_context := CASE WHEN (p ->> 'trigger') ~ '\S' THEN p ->> 'trigger' END;
        v_search := concat_ws(E'\n',
                              format('%s %s (class %s)', p ->> 'plan', p ->> 'id', p ->> 'class')
                                || CASE WHEN (p ->> 'trigger') ~ '\S' THEN ': ' || (p ->> 'trigger') ELSE '' END,
                              p ->> 'ruling',
                              CASE WHEN (p ->> 'quote') ~ '\S' THEN
                                CASE WHEN (p ->> 'said_as') = 'choice' THEN 'MK chose: "' ELSE 'MK: "' END
                                  || (p ->> 'quote') || '"'
                                  || CASE WHEN (p ->> 'question') ~ '\S' THEN v_dot || 'answering: "' || (p ->> 'question') || '"' ELSE '' END
                              END);
        v_version_of := format('ledger-decision:%s:%s', p ->> 'plan', p ->> 'id');
        v_key := v_version_of || ':' || encode(sha256(convert_to(p::text, 'UTF8')), 'hex');
        v_source := jsonb_build_object('type', 'ledger', 'plan', p -> 'plan', 'decision_id', p -> 'id', 'class', p -> 'class',
                                       'by', p -> 'by', 'quote', p -> 'quote', 'quote_source', p -> 'source',
                                       'said_as', p -> 'said_as', 'question', p -> 'question');

      WHEN 'ledger_ruling' THEN
        v_class := 'artifact';
        v_kind := 'ledger_ruling';
        v_plan := p ->> 'plan';
        v_content := p ->> 'ruling';
        v_search := concat_ws(E'\n', format('%s %s/%s: %s', p ->> 'plan', p ->> 'phase', p ->> 'task', p ->> 'ruling'),
                              CASE WHEN (p ->> 'why') ~ '\S' THEN 'Why: ' || (p ->> 'why') END);
        v_source := jsonb_build_object('type', 'ledger', 'plan', p -> 'plan', 'phase', p -> 'phase', 'task', p -> 'task',
                                       'why', p -> 'why');

      WHEN 'register_entry' THEN
        v_class := 'artifact';
        v_kind := 'ruling_entry';
        v_content := concat(p ->> 'id', v_dot, p ->> 'status', v_dot, p ->> 'subject', v_dot,
                            CASE WHEN (p ->> 'said_as') = 'choice' THEN 'MK chose, ' ELSE 'MK, ' END,
                            p ->> 'said_at', ': "', p ->> 'quote', '"',
                            CASE WHEN (p ->> 'question') ~ '\S' THEN v_dot || 'answering: "' || (p ->> 'question') || '"' END);
        v_context := CASE WHEN (p ->> 'question') ~ '\S' THEN p ->> 'question' END;
        v_search := concat_ws(E'\n', v_content,
                              (SELECT string_agg(x.v, ', ' ORDER BY x.n)
                                 FROM jsonb_array_elements_text(p -> 'applies_to') WITH ORDINALITY AS x(v, n)),
                              (SELECT string_agg(x.v, ', ' ORDER BY x.n)
                                 FROM jsonb_array_elements_text(p -> 'triggers') WITH ORDINALITY AS x(v, n)));
        v_version_of := 'register:' || (p ->> 'id');
        v_key := v_version_of || ':' || encode(sha256(convert_to(p::text, 'UTF8')), 'hex');
        v_source := jsonb_build_object('type', 'register', 'id', p -> 'id', 'status', p -> 'status', 'subject', p -> 'subject',
                                       'scope', p -> 'scope', 'file', p -> 'file', 'said_at', p -> 'said_at', 'said_as', p -> 'said_as',
                                       'verified', p -> 'verified', 'applies_to', p -> 'applies_to', 'triggers', p -> 'triggers',
                                       'supersedes', p -> 'supersedes', 'restated', p -> 'restated');

      WHEN 'candidate_status' THEN
        PERFORM 1 FROM public.memory_items i
         WHERE i.id = (p ->> 'item_id')::uuid AND i.class = 'mk_statement';
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation',
            MESSAGE = 'engram_capture_materialize: candidate_status names no mk_statement';
        END IF;
        UPDATE public.memory_items m
           SET register_status = p ->> 'status',
               register_ref = CASE WHEN (p ->> 'status') = 'recorded' THEN p ->> 'register_id' END
         WHERE m.id = (p ->> 'item_id')::uuid;

      ELSE
        -- briefing_shown, session_start, session_end, pre_compact: kept as
        -- events only.
        NULL;
      END CASE;

      IF v_class IS NOT NULL AND v_error IS NULL THEN
        v_source := jsonb_build_object('event_id', e.id::text, 'session_id', e.session_id, 'event_uuid', e.event_uuid,
                                       'event_key', v_key, 'version_of', v_version_of)
                    || v_source;
        v_source := (SELECT jsonb_object_agg(s.key, s.value)
                       FROM jsonb_each(v_source) AS s(key, value)
                      WHERE s.value <> 'null'::jsonb);
        INSERT INTO public.memory_items AS m (
          class, kind, speaker, trust, project_id, workspace_id, plan_slug, session_id,
          content, search_text, context, occurred_at, source, lineage)
        VALUES (v_class, v_kind,
                CASE WHEN v_class = 'artifact' THEN 'artifact' WHEN v_kind = 'assistant_turn' THEN 'assistant' ELSE 'mk' END,
                CASE WHEN v_class = 'artifact' THEN 1 WHEN v_kind = 'assistant_turn' THEN 3 ELSE 0 END,
                e.project ->> 'id', e.project ->> 'workspace', v_plan, e.session_id,
                v_content, v_search, v_context, e.occurred_at, v_source, v_lineage)
        ON CONFLICT ((source ->> 'event_key')) WHERE (source ? 'event_key') DO NOTHING
        RETURNING m.id INTO v_new;
      END IF;

      IF v_new IS NOT NULL AND v_version_of IS NOT NULL THEN
        SELECT i.id, i.occurred_at, i.restated_at, i.retired_at INTO v_head
          FROM public.memory_items i
         WHERE (i.source ? 'version_of') AND (i.source ->> 'version_of') = v_version_of
           AND i.class = v_class AND i.kind = v_kind
           AND i.id <> v_new AND i.forgotten_at IS NULL AND i.superseded_by IS NULL
         ORDER BY i.occurred_at DESC, i.created_at DESC, i.id DESC
         LIMIT 1;
        IF FOUND THEN
          IF cardinality(v_head.restated_at) > 0 THEN
            UPDATE public.memory_items m SET restated_at = v_head.restated_at WHERE m.id = v_new;
          END IF;
          IF e.occurred_at > v_head.occurred_at THEN
            -- A retired version is no longer current and keeps its end as
            -- retired; only a current one is superseded by its successor.
            IF v_head.retired_at IS NULL THEN
              PERFORM public.engram_supersede_item(v_head.id, v_new);
            END IF;
          ELSIF e.occurred_at < v_head.occurred_at THEN
            PERFORM public.engram_supersede_item(v_new, v_head.id);
          ELSE
            RAISE EXCEPTION USING ERRCODE = 'check_violation',
              MESSAGE = 'engram_capture_materialize: another version of this item has the same event time';
          END IF;
        END IF;

        IF e.type = 'register_entry' THEN
          IF (p ->> 'status') <> 'active' THEN
            PERFORM * FROM public.engram_retire_items(ARRAY[v_new], 'register status: ' || (p ->> 'status'));
          END IF;
          FOR v_superseded IN SELECT s.v FROM jsonb_array_elements_text(p -> 'supersedes') AS s(v) LOOP
            CONTINUE WHEN v_superseded = (p ->> 'id');
            SELECT i.id, i.retired_at INTO v_head
              FROM public.memory_items i
             WHERE (i.source ? 'version_of') AND (i.source ->> 'version_of') = 'register:' || v_superseded
               AND i.class = 'artifact' AND i.kind = 'ruling_entry'
               AND i.forgotten_at IS NULL AND i.superseded_by IS NULL
             ORDER BY i.occurred_at DESC, i.created_at DESC, i.id DESC
             LIMIT 1;
            IF FOUND AND v_head.retired_at IS NULL THEN
              PERFORM * FROM public.engram_retire_items(ARRAY[v_head.id],
                                                         format('superseded in the register by %s', p ->> 'id'));
            END IF;
          END LOOP;
        END IF;
      END IF;

      SET CONSTRAINTS ALL IMMEDIATE;
      UPDATE public.memory_capture_events c
         SET processed_at = now(), error = v_error
       WHERE c.id = v_id;
      v_processed := v_processed + 1;
      IF v_error IS NOT NULL THEN
        v_skipped := v_skipped + 1;
      END IF;
    EXCEPTION
      WHEN serialization_failure OR deadlock_detected OR lock_not_available THEN
        RAISE;
      WHEN OTHERS THEN
        UPDATE public.memory_capture_events c
           SET attempts = c.attempts + 1, error = left(SQLERRM, 500)
         WHERE c.id = v_id
        RETURNING c.attempts INTO v_attempts;
        v_failed := v_failed + 1;
        IF v_attempts < 3 THEN
          v_blocked := v_blocked || e.session_id;
        END IF;
    END;
  END LOOP;

  SELECT count(*), coalesce(sum(n.pending), 0), coalesce(sum(n.dead), 0)
    INTO v_count_rows, v_pending, v_dead
    FROM public.memory_capture_event_counts n;
  IF v_count_rows > 1 THEN
    -- The sum of the deleted rows, not of the rows read above: an ingest
    -- that committed in between is counted in its own rows either way.
    WITH folded AS (DELETE FROM public.memory_capture_event_counts RETURNING pending, dead)
    SELECT coalesce(sum(f.pending), 0), coalesce(sum(f.dead), 0) INTO v_pending, v_dead FROM folded f;
    INSERT INTO public.memory_capture_event_counts (pending, dead) VALUES (v_pending, v_dead);
  END IF;
  RETURN jsonb_build_object('locked', true, 'processed', v_processed, 'failed', v_failed, 'skipped', v_skipped,
                            'pending', v_pending, 'dead', v_dead);
END; $$;


--
-- Name: engram_items_pending_embedding(integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

-- The signature without p_claimant read without claiming; dropping it leaves
-- no unclaimed read for a caller to reach.
DROP FUNCTION IF EXISTS public.engram_items_pending_embedding(integer);

-- Claims and returns up to p_limit (1 to 256) items that still need an
-- embedding, oldest first: no embedding, not forgotten, fewer than 5 refused
-- embedding attempts, not an assistant utterance, and not a legacy item.
-- Assistant turns are trust 3 and never ranked by vector; legacy rows are
-- embedded by their own writer or not at all. A session index is written
-- without a vector and waits here like any other item.
-- idx_items_pending_embedding serves the order, and its predicate repeats the
-- eligibility clauses of this WHERE word for word so the planner
-- proves the match and the index holds no row this function skips. The WHERE
-- columns are unqualified to keep that text identical; none of them is an
-- output column name.
-- Claims: an item is taken only when p_claimant already holds it, nobody
-- does, or the holder's claim has lapsed, and every row returned is claimed
-- for p_claimant for 120 seconds. The call takes the forget advisory key
-- exclusively before it reads, as every function that locks item rows does,
-- so two calls run one after the other and the second reads after the
-- first's claims are committed: two calls never return the same item while
-- a claim is live. A row some other writer holds locked is skipped rather
-- than waited on.
-- search_text comes back cut to its first 6000 characters: the worker embeds
-- at most 6000 UTF-16 units of it (EMBED_MAX_CHARS) and a character is at
-- least one unit, so the head holds all that is embedded and a batch of long
-- items does not carry their whole text over the wire.
CREATE OR REPLACE FUNCTION public.engram_items_pending_embedding(p_limit integer, p_claimant uuid) RETURNS TABLE(id uuid, search_text text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_pending_embedding: p_limit must be from 1 to 256';
  END IF;
  IF p_claimant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_pending_embedding: p_claimant must be a uuid';
  END IF;
  PERFORM pg_advisory_xact_lock(7308892986227385959);
  RETURN QUERY
  WITH candidate AS (
    SELECT i.id
      FROM public.memory_items i
     WHERE embedding IS NULL
       AND forgotten_at IS NULL
       AND embedding_attempts < 5
       AND NOT (class = 'utterance' AND speaker = 'assistant')
       AND class <> 'legacy'
       AND (embedding_claimed_by = p_claimant OR embedding_claimed_until IS NULL OR embedding_claimed_until <= now())
     ORDER BY i.created_at, i.id
     LIMIT p_limit
       FOR NO KEY UPDATE OF i SKIP LOCKED
  ), claimed AS (
    UPDATE public.memory_items m
       SET embedding_claimed_by = p_claimant,
           embedding_claimed_until = now() + interval '120 seconds'
      FROM candidate c
     WHERE m.id = c.id
    RETURNING m.id, left(m.search_text, 6000) AS head_text, m.created_at
  )
  SELECT k.id, k.head_text
    FROM claimed k
   ORDER BY k.created_at, k.id;
END; $$;


--
-- Name: engram_items_renew_embedding_claims(uuid[], uuid); Type: FUNCTION; Schema: public; Owner: -
--

-- Extends p_claimant's claims on 1 to 256 items to 120 seconds from now,
-- for items p_claimant still holds that are still waiting for a vector (no
-- embedding, not forgotten); a lapsed claim nobody took over is held again.
-- Returns the claims extended. A worker calls it while its pass runs, so a
-- pass that outlasts one lease keeps its items. It takes the forget advisory
-- key exclusively before it locks rows, as engram_items_pending_embedding
-- does; a row some other writer holds locked is skipped, and the next
-- renewal reaches it well before the claim lapses.
CREATE OR REPLACE FUNCTION public.engram_items_renew_embedding_claims(p_ids uuid[], p_claimant uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_renewed integer;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = format('engram_items_renew_embedding_claims: p_ids holds %s ids, not 1 to 256', coalesce(cardinality(p_ids), 0));
  END IF;
  IF array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_renew_embedding_claims: p_ids holds a null id';
  END IF;
  IF p_claimant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_renew_embedding_claims: p_claimant must be a uuid';
  END IF;
  PERFORM pg_advisory_xact_lock(7308892986227385959);
  WITH held AS (
    SELECT i.id
      FROM public.memory_items i
     WHERE i.id = ANY (p_ids)
       AND i.embedding_claimed_by = p_claimant
       AND i.embedding IS NULL
       AND i.forgotten_at IS NULL
       FOR NO KEY UPDATE OF i SKIP LOCKED
  )
  UPDATE public.memory_items m
     SET embedding_claimed_until = now() + interval '120 seconds'
    FROM held h
   WHERE m.id = h.id;
  GET DIAGNOSTICS v_renewed = ROW_COUNT;
  RETURN v_renewed;
END; $$;


--
-- Name: engram_items_set_embeddings(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

-- Writes 1 to 256 embeddings, each {id, embedding, model}: 1536 numbers in the
-- real range and a non-blank model string of at most 200 characters, every id
-- distinct. A row is written only while it has no embedding and is not
-- forgotten, so a repeat, or a batch that lost a race with a forget, writes
-- nothing for that row. Returns the rows written. A written row's embedding
-- claim is cleared: the item needs no further pass.
-- It takes the forget advisory key (7308892986227385959) exclusively, then
-- locks the rows FOR NO KEY UPDATE in id order, as engram_retire_items does:
-- a forget locks rows in its own order, and an UPDATE taking row locks
-- without the key could deadlock with it.
CREATE OR REPLACE FUNCTION public.engram_items_set_embeddings(p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count integer;
  v_problem text;
  v_written integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_set_embeddings: p_rows must be a JSON array';
  END IF;
  v_count := jsonb_array_length(p_rows);
  IF v_count < 1 OR v_count > 256 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = format('engram_items_set_embeddings: p_rows holds %s objects, not 1 to 256', v_count);
  END IF;

  SELECT p.reason INTO v_problem
    FROM (
      SELECT t.n,
             CASE
               WHEN jsonb_typeof(t.e) <> 'object' THEN format('object %s is not a JSON object', t.n)
               WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(t.e) AS k(key) WHERE k.key NOT IN ('id', 'embedding', 'model')) THEN
                 format('object %s has a key other than id, embedding and model', t.n)
               WHEN jsonb_typeof(t.e -> 'id') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(t.e ->> 'id', 'uuid') THEN
                 format('object %s: id must be a uuid string', t.n)
               WHEN jsonb_typeof(t.e -> 'model') IS DISTINCT FROM 'string' OR (t.e ->> 'model') !~ '\S'
                    OR char_length(t.e ->> 'model') > 200 THEN
                 format('object %s: model must be a non-blank string of at most 200 characters', t.n)
               WHEN jsonb_typeof(t.e -> 'embedding') IS DISTINCT FROM 'array'
                    OR jsonb_array_length(t.e -> 'embedding') <> 1536
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements(t.e -> 'embedding') AS x(v)
                                WHERE CASE WHEN jsonb_typeof(x.v) = 'number' THEN abs(x.v::text::numeric) > 3.4028234663852886e38 ELSE true END) THEN
                 format('object %s: embedding must hold 1536 numbers in the real range', t.n)
             END AS reason
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(e, n)
    ) p
   WHERE p.reason IS NOT NULL
   ORDER BY p.n
   LIMIT 1;

  IF v_problem IS NULL THEN
    WITH sent AS (
      SELECT t.n, first_value(t.n) OVER (PARTITION BY (t.e ->> 'id')::uuid ORDER BY t.n) AS first_n
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(e, n)
    )
    SELECT format('objects %s and %s share an id', s.first_n, s.n) INTO v_problem
      FROM sent s
     WHERE s.n > s.first_n
     ORDER BY s.n
     LIMIT 1;
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_set_embeddings: ' || v_problem;
  END IF;

  PERFORM pg_advisory_xact_lock(7308892986227385959);
  PERFORM 1
     FROM public.memory_items i
    WHERE i.id IN (SELECT (t.e ->> 'id')::uuid FROM jsonb_array_elements(p_rows) AS t(e))
    ORDER BY i.id
      FOR NO KEY UPDATE;
  UPDATE public.memory_items m
     SET embedding = (r.e -> 'embedding')::text::public.vector,
         embedding_model = r.e ->> 'model',
         embedding_claimed_by = NULL,
         embedding_claimed_until = NULL
    FROM jsonb_array_elements(p_rows) AS r(e)
   WHERE m.id = (r.e ->> 'id')::uuid
     AND m.embedding IS NULL
     AND m.forgotten_at IS NULL;
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END; $$;


--
-- Name: engram_items_record_embedding_failures(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

-- The signature without p_claimant raised an item whoever held it; dropping
-- it leaves no way to count one refusal twice.
DROP FUNCTION IF EXISTS public.engram_items_record_embedding_failures(jsonb);

-- Records 1 to 256 input-specific embedding failures, each {id, error}: a
-- uuid and the provider's non-blank message, every id distinct, found by
-- p_claimant's embedding pass. Each item still pending (no embedding, not
-- forgotten, fewer than 5 attempts) on which no other claimant holds a live
-- claim has embedding_attempts raised by one and embedding_error set to the
-- message cut to 500 characters; any other row is left as it is. Returns the
-- rows raised. A pass whose claim lapsed and was taken over records nothing,
-- so a refusal counts once per item per pass.
-- It takes the forget advisory key exclusively, then locks the rows FOR NO
-- KEY UPDATE in id order, as engram_items_set_embeddings does.
CREATE OR REPLACE FUNCTION public.engram_items_record_embedding_failures(p_rows jsonb, p_claimant uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count integer;
  v_problem text;
  v_raised integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_record_embedding_failures: p_rows must be a JSON array';
  END IF;
  v_count := jsonb_array_length(p_rows);
  IF v_count < 1 OR v_count > 256 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = format('engram_items_record_embedding_failures: p_rows holds %s objects, not 1 to 256', v_count);
  END IF;
  IF p_claimant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_record_embedding_failures: p_claimant must be a uuid';
  END IF;

  SELECT p.reason INTO v_problem
    FROM (
      SELECT t.n,
             CASE
               WHEN jsonb_typeof(t.e) <> 'object' THEN format('object %s is not a JSON object', t.n)
               WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(t.e) AS k(key) WHERE k.key NOT IN ('id', 'error')) THEN
                 format('object %s has a key other than id and error', t.n)
               WHEN jsonb_typeof(t.e -> 'id') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(t.e ->> 'id', 'uuid') THEN
                 format('object %s: id must be a uuid string', t.n)
               WHEN jsonb_typeof(t.e -> 'error') IS DISTINCT FROM 'string' OR left(t.e ->> 'error', 500) !~ '\S' THEN
                 format('object %s: error must be a string that is not blank in its first 500 characters', t.n)
             END AS reason
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(e, n)
    ) p
   WHERE p.reason IS NOT NULL
   ORDER BY p.n
   LIMIT 1;

  IF v_problem IS NULL THEN
    WITH sent AS (
      SELECT t.n, first_value(t.n) OVER (PARTITION BY (t.e ->> 'id')::uuid ORDER BY t.n) AS first_n
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(e, n)
    )
    SELECT format('objects %s and %s share an id', s.first_n, s.n) INTO v_problem
      FROM sent s
     WHERE s.n > s.first_n
     ORDER BY s.n
     LIMIT 1;
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_record_embedding_failures: ' || v_problem;
  END IF;

  PERFORM pg_advisory_xact_lock(7308892986227385959);
  PERFORM 1
     FROM public.memory_items i
    WHERE i.id IN (SELECT (t.e ->> 'id')::uuid FROM jsonb_array_elements(p_rows) AS t(e))
    ORDER BY i.id
      FOR NO KEY UPDATE;
  UPDATE public.memory_items m
     SET embedding_attempts = m.embedding_attempts + 1,
         embedding_error = left(r.e ->> 'error', 500)
    FROM jsonb_array_elements(p_rows) AS r(e)
   WHERE m.id = (r.e ->> 'id')::uuid
     AND m.embedding IS NULL
     AND m.forgotten_at IS NULL
     AND m.embedding_attempts < 5
     AND (m.embedding_claimed_by = p_claimant OR m.embedding_claimed_until IS NULL OR m.embedding_claimed_until <= now());
  GET DIAGNOSTICS v_raised = ROW_COUNT;
  RETURN v_raised;
END; $$;


--
-- Name: engram_items_embedding_failed_count(); Type: FUNCTION; Schema: public; Owner: -
--

-- How many items left the pending set after 5 refused embedding attempts and
-- still have no embedding, forgotten items excluded. Read only; capture health
-- reports it.
CREATE OR REPLACE FUNCTION public.engram_items_embedding_failed_count() RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT count(*)
    FROM public.memory_items i
   WHERE i.embedding IS NULL
     AND i.forgotten_at IS NULL
     AND i.embedding_attempts >= 5;
$$;


--
-- Name: engram_items_reset_embedding_failures(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

-- The recovery step for refusals that turn out not to be the items' own (a
-- provider or proxy fault, a model change): clears embedding_attempts and
-- embedding_error so the items are pending again. Given 1 to 256 ids, it
-- resets each of those items that has a recorded failure; given NULL, every
-- item engram_items_embedding_failed_count counts (5 attempts, no embedding,
-- not forgotten). An empty array is refused, so a caller's empty id list
-- never reads as "every item". Forgotten items are left as they are. Returns
-- the rows reset. It takes the forget advisory key exclusively, then locks
-- the rows FOR NO KEY UPDATE in id order, as engram_items_set_embeddings does.
CREATE OR REPLACE FUNCTION public.engram_items_reset_embedding_failures(p_ids uuid[] DEFAULT NULL) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_reset integer;
BEGIN
  IF p_ids IS NOT NULL AND (cardinality(p_ids) < 1 OR cardinality(p_ids) > 256) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = format('engram_items_reset_embedding_failures: p_ids holds %s ids, not 1 to 256; pass NULL to reset every failed item', cardinality(p_ids));
  END IF;
  IF p_ids IS NOT NULL AND array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_items_reset_embedding_failures: p_ids holds a null id';
  END IF;

  PERFORM pg_advisory_xact_lock(7308892986227385959);
  IF p_ids IS NULL THEN
    PERFORM 1
       FROM public.memory_items i
      WHERE i.embedding IS NULL
        AND i.forgotten_at IS NULL
        AND i.embedding_attempts >= 5
      ORDER BY i.id
        FOR NO KEY UPDATE;
    UPDATE public.memory_items m
       SET embedding_attempts = 0,
           embedding_error = NULL
     WHERE m.embedding IS NULL
       AND m.forgotten_at IS NULL
       AND m.embedding_attempts >= 5;
  ELSE
    PERFORM 1
       FROM public.memory_items i
      WHERE i.id = ANY (p_ids)
        AND i.forgotten_at IS NULL
        AND (i.embedding_attempts > 0 OR i.embedding_error IS NOT NULL)
      ORDER BY i.id
        FOR NO KEY UPDATE;
    UPDATE public.memory_items m
       SET embedding_attempts = 0,
           embedding_error = NULL
     WHERE m.id = ANY (p_ids)
       AND m.forgotten_at IS NULL
       AND (m.embedding_attempts > 0 OR m.embedding_error IS NOT NULL);
  END IF;
  GET DIAGNOSTICS v_reset = ROW_COUNT;
  RETURN v_reset;
END; $$;


--
-- Extraction. A window is built around an anchor: every MK prompt or dialog
-- answer that is not forgotten, and the earliest assistant turn of each group
-- of turns that is extracted without an MK utterance
-- (engram_extraction_turn_groups). memory_extraction_runs records each attempt at one anchor and
-- extractor version: inserted as running before the model call, closed as
-- succeeded by engram_extraction_commit or as failed by engram_extraction_fail.
-- A failure's stats.failure is 'held' when the reply or the commit failed and
-- 'transient' when the call did (an empty or moderated reply, a provider or
-- network fault). stats.counted says whether it counts toward its class's
-- limit: only when the provider was shown to be up, so an outage backs
-- anchors off without exhausting them. Every failure backs the anchor off.
--

--
-- Name: engram_extraction_run_state(text, text); Type: FUNCTION; Schema: public; Owner: -
--

-- Every anchor's runs at extractor version p_version, of session p_session
-- (every session when NULL): whether one succeeded, how many failed (counted
-- or not), the counted held and the counted transient failures, the latest
-- failure's end, and the newest run still open with its start. An anchor is
-- finished once a run succeeded or it is exhausted: 3 counted held failures
-- or 6 counted transient ones. Only a counted failure exhausts an anchor, so
-- an outage (stats.counted false) never does.
CREATE OR REPLACE FUNCTION public.engram_extraction_run_state(p_version text, p_session text) RETURNS TABLE(anchor_item_id uuid, succeeded boolean, failed integer, held integer, transient integer, last_failed timestamp with time zone, running_run_id uuid, running_started_at timestamp with time zone, finished boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT s.aid, s.succeeded, s.failed, s.held, s.transient, s.last_failed, s.running_id, s.running_at,
         s.succeeded OR s.held >= 3 OR s.transient >= 6
    FROM (SELECT r.anchor_item_id AS aid,
                 bool_or(r.status = 'succeeded') AS succeeded,
                 (count(*) FILTER (WHERE r.status = 'failed'))::integer AS failed,
                 (count(*) FILTER (WHERE r.status = 'failed' AND r.stats @> '{"failure": "held", "counted": true}'))::integer AS held,
                 (count(*) FILTER (WHERE r.status = 'failed' AND r.stats @> '{"failure": "transient", "counted": true}'))::integer AS transient,
                 max(coalesce(r.finished_at, r.started_at)) FILTER (WHERE r.status = 'failed') AS last_failed,
                 (array_agg(r.id ORDER BY r.started_at DESC, r.id DESC) FILTER (WHERE r.status = 'running'))[1] AS running_id,
                 max(r.started_at) FILTER (WHERE r.status = 'running') AS running_at
            FROM public.memory_extraction_runs r
           WHERE r.extractor_version = p_version AND r.anchor_item_id IS NOT NULL
             AND (p_session IS NULL OR r.session_id = p_session)
           GROUP BY r.anchor_item_id) s
$$;


--
-- Name: engram_extraction_turn_groups(text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

DROP FUNCTION IF EXISTS public.engram_extraction_turn_groups(text, text);

-- The assistant turns the windows of session p_session show at extractor
-- version p_version (every session when NULL), one row per turn and window,
-- so the pending read and the window read compute the same windows and a
-- retry rebuilds the same one. p_any_version says which runs count as having
-- extracted something: with true, a succeeded run at any extractor version
-- (the worker and engram-extract's gap fill, since a version bump
-- re-extracts nothing by itself); with false, only one at p_version
-- (engram-extract --replace, which re-runs what other versions extracted):
-- - A turn is observed once a succeeded run that counts lists it in
--   stats.observation_sources: each turn yields observations once.
-- - An unobserved turn belongs to (owner_id) the first open user prompt of its
--   session after it: one that is not forgotten, not exhausted at p_version
--   (engram_extraction_run_state) and has no succeeded run that counts. A
--   turn no open prompt follows belongs to
--   the session's flush (owner_id NULL). A finished prompt so passes the turns
--   it never extracted to the next one, and a dialog answer shows no turn.
-- - An open prompt also shows the latest turn before it when that turn is
--   observed (observed true): context MK may be answering, never extracted
--   again.
-- - Each owner's turns are packed from the newest backward into groups of at
--   most 24000 characters: a group takes the next turns that fit whole; a
--   turn counts as at most 24000 (a window shows only the last 24000
--   characters of a longer one), so a longer turn forms a group alone.
-- - anchor_id names the window that shows the turn: the prompt for a prompt's
--   newest group; for every other group, and every group of a flush, the
--   group's earliest turn, an observation-only window that the session's
--   (occurred_at, id) order runs before the prompt.
-- Read only.
CREATE OR REPLACE FUNCTION public.engram_extraction_turn_groups(p_version text, p_session text, p_any_version boolean) RETURNS TABLE(session_id text, turn_id uuid, owner_id uuid, anchor_id uuid, observed boolean)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_budget constant integer := 24000;
  r record;
  v_started boolean := false;
  v_sid text;
  v_owner uuid;
  v_newest boolean := true;
  v_used integer := 0;
  v_turns uuid[] := '{}'::uuid[];
  v_seen boolean[] := '{}'::boolean[];
  v_anchor uuid;
BEGIN
  IF p_any_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_turn_groups: p_any_version is required';
  END IF;
  FOR r IN
    WITH state AS (
      SELECT st.anchor_item_id AS aid, st.finished
        FROM public.engram_extraction_run_state(p_version, p_session) st
    ), seen AS (
      SELECT DISTINCT lower(x.v)::uuid AS id
        FROM public.memory_extraction_runs rr
       CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(rr.stats -> 'observation_sources') = 'array'
                                                         THEN rr.stats -> 'observation_sources' ELSE '[]'::jsonb END) AS x(v)
       WHERE (p_any_version OR rr.extractor_version = p_version) AND rr.status = 'succeeded'
         AND (p_session IS NULL OR rr.session_id = p_session)
         AND x.v ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    ), open_prompt AS (
      SELECT p.id, p.session_id AS sid, p.occurred_at AS t_at
        FROM public.memory_items p
        LEFT JOIN state st ON st.aid = p.id
       WHERE p.class = 'utterance' AND p.kind = 'user_prompt' AND p.forgotten_at IS NULL
         AND p.session_id IS NOT NULL AND (p_session IS NULL OR p.session_id = p_session)
         AND NOT coalesce(st.finished, false)
         AND NOT (p_any_version AND EXISTS (SELECT 1 FROM public.memory_extraction_runs x
                                             WHERE x.anchor_item_id = p.id AND x.status = 'succeeded'))
    ), unseen AS (
      SELECT op.id, op.sid, op.t_at, true AS is_prompt, 0 AS len
        FROM open_prompt op
      UNION ALL
      SELECT t.id, t.session_id, t.occurred_at, false, least(char_length(t.content), v_budget)
        FROM public.memory_items t
       WHERE t.class = 'utterance' AND t.kind = 'assistant_turn' AND t.forgotten_at IS NULL
         AND t.session_id IS NOT NULL AND (p_session IS NULL OR t.session_id = p_session)
         AND NOT EXISTS (SELECT 1 FROM seen sn WHERE sn.id = t.id)
    ), banded AS (
      -- Walking a session newest first, each open prompt starts a band that
      -- holds the turns before it, back to the previous open prompt.
      SELECT u.*, count(*) FILTER (WHERE u.is_prompt) OVER (PARTITION BY u.sid ORDER BY u.t_at DESC, u.id DESC) AS band
        FROM unseen u
    ), owned AS (
      SELECT b.id, b.sid, b.t_at, b.len, b.is_prompt,
             (array_agg(b.id) FILTER (WHERE b.is_prompt) OVER (PARTITION BY b.sid, b.band))[1] AS owner
        FROM banded b
    ), shown AS (
      SELECT o.id, o.sid, o.t_at, o.len, o.owner, false AS was_seen
        FROM owned o
       WHERE NOT o.is_prompt
      UNION ALL
      SELECT c.id, op.sid, c.occurred_at, least(char_length(c.content), v_budget), op.id, true
        FROM open_prompt op
       CROSS JOIN LATERAL (SELECT t.id, t.occurred_at, t.content
                             FROM public.memory_items t
                            WHERE t.session_id = op.sid AND t.class = 'utterance' AND t.kind = 'assistant_turn'
                              AND t.forgotten_at IS NULL AND (t.occurred_at, t.id) < (op.t_at, op.id)
                            ORDER BY t.occurred_at DESC, t.id DESC
                            LIMIT 1) c
       WHERE EXISTS (SELECT 1 FROM seen sn WHERE sn.id = c.id)
    )
    SELECT sh.sid, sh.owner, sh.id, sh.len, sh.was_seen
      FROM shown sh
     ORDER BY sh.sid, sh.owner NULLS LAST, sh.t_at DESC, sh.id DESC
  LOOP
    IF v_started AND (r.sid IS DISTINCT FROM v_sid OR r.owner IS DISTINCT FROM v_owner OR v_used + r.len > v_budget) THEN
      v_anchor := CASE WHEN v_newest AND v_owner IS NOT NULL THEN v_owner ELSE v_turns[cardinality(v_turns)] END;
      RETURN QUERY SELECT v_sid, g.t, v_owner, v_anchor, g.f FROM unnest(v_turns, v_seen) AS g(t, f);
      v_newest := r.sid IS DISTINCT FROM v_sid OR r.owner IS DISTINCT FROM v_owner;
      v_used := 0;
      v_turns := '{}'::uuid[];
      v_seen := '{}'::boolean[];
    END IF;
    v_started := true;
    v_sid := r.sid;
    v_owner := r.owner;
    v_used := v_used + r.len;
    v_turns := v_turns || r.id;
    v_seen := v_seen || r.was_seen;
  END LOOP;
  IF v_started THEN
    v_anchor := CASE WHEN v_newest AND v_owner IS NOT NULL THEN v_owner ELSE v_turns[cardinality(v_turns)] END;
    RETURN QUERY SELECT v_sid, g.t, v_owner, v_anchor, g.f FROM unnest(v_turns, v_seen) AS g(t, f);
  END IF;
END; $$;


--
-- Name: engram_extraction_pending(text, integer, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

-- CREATE OR REPLACE cannot change a function's result columns, so the
-- function is dropped first: a database holding an earlier column list then
-- converges when this file is applied again.
DROP FUNCTION IF EXISTS public.engram_extraction_pending(text, integer, integer, timestamp with time zone);

-- The anchors to extract next at p_version, cut at p_limit (1 to 1000).
-- Sessions come most recently received first (memory_session_state
-- .last_received_at), so a live session is never queued behind a backlog;
-- each session's anchors come in (occurred_at, id) order. An anchor is
-- pending while no run at any extractor version succeeded on it, and at
-- p_version it has fewer than 3 counted held failures and fewer than 6
-- counted transient ones. A version bump so re-extracts nothing by itself:
-- what an earlier version extracted stays until engram-extract --replace
-- re-runs it, and a turn observed at any version is observed here too
-- (engram_extraction_turn_groups with p_any_version). There is no minimum per session,
-- so a session's one MK utterance is pending as soon as it is stored. A
-- session's pending anchors are returned from its earliest on, up to the
-- first one that is not due: a later anchor waits behind a pending earlier
-- one, and an exhausted anchor no longer holds its session back. A failure
-- counts only when its run's stats.counted is true; one without it (an
-- outage) never exhausts an anchor. An anchor is due when it has no failure,
-- or once p_now reaches the latest failure's end plus the backoff for its
-- count n of failures, counted or not: 60 seconds doubled n - 1 times, capped
-- at 6 hours, the schedule the worker's own backoff uses. Due-ness is decided
-- here, before the limit, so sessions waiting out a backoff never crowd due
-- ones out. The earliest turn of an observation-only group of
-- engram_extraction_turn_groups is an anchor of kind 'turns': a prompt's
-- older group at once, a group of the session's flush (the turns no open
-- prompt follows) only while its session may be closed: it ended with no
-- later event, or nothing of it was received in the p_idle_seconds before
-- p_now (received time, so a backlog stored long after its events happened
-- is not idle), and no event of it waits for engram_capture_materialize.
-- failures counts every failed run, held_failures and transient_failures the
-- counted ones of each class; running_run_id and running_started_at name a
-- run still open on the anchor, which the caller closes as failed once it is
-- stale (its worker died) before beginning a new one.
CREATE OR REPLACE FUNCTION public.engram_extraction_pending(p_version text, p_limit integer, p_idle_seconds integer, p_now timestamp with time zone) RETURNS TABLE(anchor_item_id uuid, session_id text, anchor_kind text, occurred_at timestamp with time zone, failures integer, held_failures integer, transient_failures integer, running_run_id uuid, running_started_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_version IS NULL OR p_version !~ '\S' OR char_length(p_version) > 64 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_pending: p_version must be a non-blank text of at most 64 characters';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_pending: p_limit must be from 1 to 1000';
  END IF;
  IF p_idle_seconds IS NULL OR p_idle_seconds < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_pending: p_idle_seconds must be at least 1';
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_pending: p_now must be a finite time';
  END IF;

  RETURN QUERY
  WITH closable AS (
    SELECT s.session_id AS sid
      FROM public.memory_session_state s
     WHERE (s.ended_at >= s.last_event_at
            OR s.last_received_at < p_now - make_interval(secs => p_idle_seconds))
       AND NOT EXISTS (SELECT 1
                         FROM public.memory_capture_events c
                        WHERE c.session_id = s.session_id AND c.processed_at IS NULL AND c.attempts < 3)
  ), grp AS (
    SELECT DISTINCT g.session_id AS sid, g.anchor_id, g.owner_id
      FROM public.engram_extraction_turn_groups(p_version, NULL, true) g
     WHERE g.anchor_id IS DISTINCT FROM g.owner_id
  ), anchor AS (
    SELECT u.id, u.session_id AS sid, u.kind, u.occurred_at AS t_at
      FROM public.memory_items u
     WHERE u.class = 'utterance' AND u.kind IN ('user_prompt', 'user_answer')
       AND u.forgotten_at IS NULL AND u.session_id IS NOT NULL
    UNION ALL
    SELECT t.id, t.session_id, 'turns', t.occurred_at
      FROM grp g
      JOIN public.memory_items t ON t.id = g.anchor_id
     WHERE g.owner_id IS NOT NULL OR EXISTS (SELECT 1 FROM closable c WHERE c.sid = g.sid)
  ), run AS (
    SELECT st.anchor_item_id AS aid, st.failed, st.held, st.transient, st.last_failed, st.finished,
           st.running_run_id AS running_id, st.running_started_at AS running_at
      FROM public.engram_extraction_run_state(p_version, NULL) st
  ), pending AS (
    SELECT a.id, a.sid, a.kind, a.t_at, coalesce(r.failed, 0) AS failed, coalesce(r.held, 0) AS held,
           coalesce(r.transient, 0) AS transient, r.running_id, r.running_at,
           (coalesce(r.failed, 0) = 0
            OR p_now >= r.last_failed + make_interval(secs => least(60 * power(2, r.failed - 1), 21600))) AS due
      FROM anchor a
      LEFT JOIN run r ON r.aid = a.id
     WHERE NOT coalesce(r.finished, false)
       AND NOT EXISTS (SELECT 1 FROM public.memory_extraction_runs x
                        WHERE x.anchor_item_id = a.id AND x.status = 'succeeded')
  ), queued AS (
    SELECT p.*,
           bool_and(p.due) OVER (PARTITION BY p.sid ORDER BY p.t_at, p.id) AS clear,
           s.last_received_at AS received_at
      FROM pending p
      LEFT JOIN public.memory_session_state s ON s.session_id = p.sid
  )
  SELECT q.id, q.sid, q.kind, q.t_at, q.failed, q.held, q.transient, q.running_id, q.running_at
    FROM queued q
   WHERE q.clear
   ORDER BY q.received_at DESC NULLS LAST, q.sid, q.t_at, q.id
   LIMIT p_limit;
END; $$;


--
-- Name: engram_extraction_plan_slug(text[]); Type: FUNCTION; Schema: public; Owner: -
--

-- The plan a capture event ran under: the last path segment of its first plan
-- folder, or NULL when it has none.
CREATE OR REPLACE FUNCTION public.engram_extraction_plan_slug(p_plan_dirs text[]) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT nullif(
    pg_catalog.regexp_replace(pg_catalog.regexp_replace(p_plan_dirs[1], '/+$', ''), '^.*/', ''), '')
$$;


--
-- Name: engram_extraction_in_scope(public.memory_items, public.memory_items, text); Type: FUNCTION; Schema: public; Owner: -
--

-- Whether item i is in the scope of extraction anchor a under plan p_plan:
-- the anchor's project, or no project and the anchor's workspace or none. A
-- statement scoped to a plan is in scope only under that plan, and one scoped
-- to a session only in that session.
CREATE OR REPLACE FUNCTION public.engram_extraction_in_scope(i public.memory_items, a public.memory_items, p_plan text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT (i.project_id = a.project_id
          OR (i.project_id IS NULL AND (i.workspace_id IS NULL OR i.workspace_id = a.workspace_id)))
     AND (i.class <> 'mk_statement'
          OR coalesce(CASE i.source ->> 'scope'
                                   WHEN 'plan' THEN i.plan_slug = p_plan
                                   WHEN 'session' THEN i.session_id = a.session_id
                                   ELSE true END, false))
$$;


--
-- Name: engram_extraction_subject_current(public.memory_items, text, uuid, text, text, boolean, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

DROP FUNCTION IF EXISTS public.engram_extraction_subject_current(public.memory_items, text, uuid, text, timestamp with time zone);
DROP FUNCTION IF EXISTS public.engram_extraction_subject_current(public.memory_items, text, uuid, text, boolean, timestamp with time zone);

-- The current items (not superseded, retired or forgotten) filed under
-- p_subject in the scope of anchor a under plan p_plan that occurred no later
-- than p_at: those of p_class, and for an mk_statement also the observations,
-- which a statement may correct. A standing statement (p_standing) is also
-- weighed against the active register entries (artifact/ruling_entry with
-- source.status 'active') whose source.subject equals the subject's label
-- (p_subject's stored label, or p_label when p_subject is null because the
-- statement names a subject not stored yet), compared case-insensitively with
-- whitespace runs collapsed and trimmed: register subjects are shared by
-- every project, so they match by label. A new item of p_class on p_subject
-- at p_at is weighed against exactly these.
CREATE OR REPLACE FUNCTION public.engram_extraction_subject_current(a public.memory_items, p_plan text, p_subject uuid, p_label text, p_class text, p_standing boolean, p_at timestamp with time zone) RETURNS SETOF public.memory_items
    LANGUAGE sql STABLE
    AS $$
  SELECT i.*
    FROM public.memory_items i
   WHERE i.subject_id = p_subject
     AND (i.class = p_class OR (p_class = 'mk_statement' AND i.class = 'observation'))
     AND i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL
     AND i.occurred_at <= p_at
     AND public.engram_extraction_in_scope(i, a, p_plan)
  UNION ALL
  SELECT i.*
    FROM public.memory_items i
   CROSS JOIN (SELECT coalesce((SELECT s.label FROM public.memory_subjects s WHERE s.id = p_subject), p_label) AS label) AS sj
   WHERE p_class = 'mk_statement' AND coalesce(p_standing, false)
     AND i.class = 'artifact' AND i.kind = 'ruling_entry'
     AND (i.source ->> 'status') = 'active'
     AND lower(btrim(regexp_replace(i.source ->> 'subject', '\s+', ' ', 'g')))
         = lower(btrim(regexp_replace(sj.label, '\s+', ' ', 'g')))
     AND i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL
     AND i.occurred_at <= p_at
     AND public.engram_extraction_in_scope(i, a, p_plan)
$$;


--
-- Name: engram_extraction_candidates(uuid, jsonb, integer); Type: FUNCTION; Schema: public; Owner: -
--

-- What each new item of an extraction window must be weighed against, or
-- NULL when p_anchor names no utterance or a forgotten one. p_items holds up
-- to 500 objects {subject_id, subject_label, class, standing, occurred_at,
-- content, event_key, exclude}: a stored subject, or null with the label of a
-- subject the commit will create (only a standing statement's register
-- entries can be on it), mk_statement or observation, whether a statement is
-- standing (a boolean; false or null for an observation), the item's time,
-- its words, its source.event_key and the ids its own links already name.
-- Returns one object per item, in input order:
-- - stored: the id of the item that already holds event_key, or null;
-- - repeat_of: when nothing holds it, a current item of the same class and
--   subject in the anchor's scope (engram_extraction_in_scope) that occurred
--   no later and holds the same words under the quote rule (the commit
--   stores the item as its restatement), or null. Out of scope the same
--   words are a different statement: a session-scoped rule said again in
--   another session, or a plan-scoped one under another plan, is stored;
-- - when both are null, total counts the items
--   engram_extraction_subject_current returns for it in the anchor's scope
--   minus exclude, read lists all their ids and candidates the first p_limit
--   (1 to 100), newest first, with their subject label (a register entry's
--   own source.subject), project, workspace and content.
-- An item that is stored or a repeat gets total 0 and empty lists: it needs
-- no decision.
CREATE OR REPLACE FUNCTION public.engram_extraction_candidates(p_anchor uuid, p_items jsonb, p_limit integer) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  a public.memory_items%ROWTYPE;
  v_time constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  v_uuid constant text := '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
  v_problem text;
  v_plan text;
  v_item jsonb;
  v_at timestamptz;
  v_exclude uuid[];
  v_stored uuid;
  v_repeat uuid;
  v_total integer;
  v_read jsonb;
  v_candidates jsonb;
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_candidates: p_limit must be from 1 to 100';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_candidates: p_items must be a JSON array';
  END IF;
  IF jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = format('engram_extraction_candidates: p_items holds %s objects, more than 500', jsonb_array_length(p_items));
  END IF;
  SELECT x.reason INTO v_problem
    FROM (SELECT t.n,
                 CASE
                   WHEN jsonb_typeof(t.v) <> 'object' THEN format('item %s is not a JSON object', t.n)
                   WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(t.v) AS k(key)
                                 WHERE k.key NOT IN ('subject_id', 'subject_label', 'class', 'standing', 'occurred_at', 'content', 'event_key', 'exclude')) THEN
                     format('item %s has a key other than subject_id, subject_label, class, standing, occurred_at, content, event_key and exclude', t.n)
                   WHEN coalesce(jsonb_typeof(t.v -> 'subject_label'), 'null') NOT IN ('string', 'null') THEN
                     format('item %s: subject_label must be a string or null', t.n)
                   WHEN CASE WHEN coalesce(jsonb_typeof(t.v -> 'subject_id'), 'null') = 'null'
                             THEN btrim(coalesce(t.v ->> 'subject_label', '')) = ''
                             ELSE jsonb_typeof(t.v -> 'subject_id') <> 'string' OR (t.v ->> 'subject_id') !~* v_uuid END THEN
                     format('item %s: subject_id must be a UUID, or null with a subject_label', t.n)
                   WHEN coalesce(t.v ->> 'class', '') NOT IN ('mk_statement', 'observation') THEN
                     format('item %s: class must be mk_statement or observation', t.n)
                   WHEN coalesce(jsonb_typeof(t.v -> 'standing'), 'null') NOT IN ('boolean', 'null') THEN
                     format('item %s: standing must be a boolean or null', t.n)
                   WHEN jsonb_typeof(t.v -> 'occurred_at') IS DISTINCT FROM 'string' THEN
                     format('item %s: occurred_at must be a string', t.n)
                   WHEN jsonb_typeof(t.v -> 'content') IS DISTINCT FROM 'string' THEN
                     format('item %s: content must be a string', t.n)
                   WHEN jsonb_typeof(t.v -> 'event_key') IS DISTINCT FROM 'string' THEN
                     format('item %s: event_key must be a string', t.n)
                   WHEN jsonb_typeof(t.v -> 'exclude') IS DISTINCT FROM 'array'
                        OR EXISTS (SELECT 1 FROM jsonb_array_elements(t.v -> 'exclude') AS e(v)
                                    WHERE jsonb_typeof(e.v) <> 'string' OR (e.v #>> '{}') !~* v_uuid) THEN
                     format('item %s: exclude must be an array of UUIDs', t.n)
                 END AS reason
            FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(v, n)) AS x
   WHERE x.reason IS NOT NULL
   ORDER BY x.n
   LIMIT 1;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_candidates: ' || v_problem;
  END IF;

  SELECT * INTO a
    FROM public.memory_items i
   WHERE i.id = p_anchor AND i.class = 'utterance' AND i.forgotten_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT public.engram_extraction_plan_slug(e.plan_dirs) INTO v_plan
    FROM public.memory_capture_events e
   WHERE e.id = CASE WHEN (a.source ->> 'event_id') ~ '^[0-9]{1,18}$' THEN (a.source ->> 'event_id')::bigint END;

  FOR v_item IN SELECT t.v FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(v, n) ORDER BY t.n LOOP
    v_at := (v_item ->> 'occurred_at')::timestamptz;
    v_exclude := ARRAY(SELECT e.x::uuid FROM jsonb_array_elements_text(v_item -> 'exclude') AS e(x));
    SELECT x.id INTO v_stored
      FROM public.memory_items x
     WHERE (x.source ? 'event_key') AND (x.source ->> 'event_key') = (v_item ->> 'event_key')
     LIMIT 1;
    v_repeat := NULL;
    IF v_stored IS NULL THEN
      SELECT i.id INTO v_repeat
        FROM public.memory_items i
       WHERE i.class = v_item ->> 'class' AND i.subject_id = (v_item ->> 'subject_id')::uuid
         AND i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL
         AND i.occurred_at <= v_at
         AND public.engram_extraction_in_scope(i, a, v_plan)
         AND public.engram_norm_quote(i.content) = public.engram_norm_quote(v_item ->> 'content')
       ORDER BY i.occurred_at DESC, i.id
       LIMIT 1;
    END IF;
    v_total := 0;
    v_read := '[]'::jsonb;
    v_candidates := '[]'::jsonb;
    IF v_stored IS NULL AND v_repeat IS NULL THEN
      SELECT count(*)::integer,
             coalesce(jsonb_agg(to_jsonb(r.id) ORDER BY r.rn), '[]'::jsonb),
             coalesce(jsonb_agg(jsonb_build_object(
                        'id', r.id, 'class', r.class, 'kind', r.kind, 'subject_id', r.subject_id,
                        'subject_label', coalesce(sj.label, r.entry_subject), 'project_id', r.project_id,
                        'workspace_id', r.workspace_id, 'content', r.content,
                        'occurred_at', to_char(r.occurred_at AT TIME ZONE 'UTC', v_time)) ORDER BY r.rn)
                      FILTER (WHERE r.rn <= p_limit), '[]'::jsonb)
        INTO v_total, v_read, v_candidates
        FROM (SELECT c.id, c.class, c.kind, c.subject_id, c.content, c.occurred_at, c.project_id, c.workspace_id,
                     CASE WHEN c.class = 'artifact' THEN c.source ->> 'subject' END AS entry_subject,
                     row_number() OVER (ORDER BY c.occurred_at DESC, c.id DESC) AS rn
                FROM public.engram_extraction_subject_current(a, v_plan, (v_item ->> 'subject_id')::uuid,
                                                              v_item ->> 'subject_label', v_item ->> 'class',
                                                              (v_item ->> 'standing')::boolean, v_at) AS c
               WHERE c.id <> ALL (v_exclude)) AS r
        LEFT JOIN public.memory_subjects sj ON sj.id = r.subject_id;
    END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
               'stored', v_stored, 'repeat_of', v_repeat, 'total', v_total,
               'read', v_read, 'candidates', v_candidates));
  END LOOP;
  RETURN v_out;
END; $$;


--
-- Name: engram_extraction_window(uuid, integer, integer, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

DROP FUNCTION IF EXISTS public.engram_extraction_window(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.engram_extraction_window(uuid, integer, integer, text);

-- The window around one anchor as JSON, as extractor version p_version
-- builds it, or NULL when p_anchor names no utterance or a forgotten one:
-- - anchor: the utterance's id, kind, session_id, project_id, workspace_id,
--   content, context, occurred_at and source;
-- - anchor_event: the payload and plan_dirs of the capture event its
--   source.event_id names, or null;
-- - turns: the assistant turns the anchor's window shows, oldest first, each
--   with the utterance's fields and observed: for a prompt or an assistant
--   turn, the turns engram_extraction_turn_groups gives that anchor under
--   p_any_version, the same rule the caller chose its anchors by (a
--   prompt's unobserved turns and its observed context turn; an
--   observation-only group); [] for a dialog answer, which carries its
--   question, and for a prompt that is already finished;
-- - subjects: up to p_subject_limit (1 to 1000) active subjects of the scope,
--   most recently used first, with last_used_at. A subject is active while a
--   current item (not forgotten, retired or superseded) is filed under it;
--   last_used_at is the latest occurred_at among those items;
-- - statements and observations: up to p_recent_limit (1 to 200) current
--   items of each class in scope, newest first, with their subject's label,
--   project and workspace;
-- - shown: for an MK utterance, the current items that briefing_shown events
--   of its session put in front of the assistant from the previous MK
--   utterance (inclusive; the session's start when there is none) up to this
--   one (exclusive): the context of the reply MK reacts to. The latest
--   briefing first, each in its own order, each item once, at most 24, with
--   class, kind, subject, project, workspace and the first 1500 characters of
--   the content. Shown items may lie outside the scope;
-- - turn_refs: every item, forgotten or not, whose id occurs (in any case) in
--   the text of the window's assistant turns, at most 200 ids, with its
--   class, kind, subject, project,
--   workspace, time and currency, so a retraction naming one can be resolved;
-- - projects: the id and kind of every registry row.
-- The scope is the anchor's project, its workspace's own items and global
-- ones; at a workspace root (no project) the workspace and global. A statement
-- scoped to a plan is in scope only under that plan, the slug of the anchor
-- event's first plan folder, and one scoped to a session only in that session.
-- Times are UTC ISO 8601 with microseconds, whatever the session TimeZone.
CREATE OR REPLACE FUNCTION public.engram_extraction_window(p_anchor uuid, p_subject_limit integer, p_recent_limit integer, p_version text, p_any_version boolean) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  a public.memory_items%ROWTYPE;
  v_time constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  v_event jsonb;
  v_plan text;
  v_turns jsonb := '[]'::jsonb;
  v_subjects jsonb;
  v_statements jsonb;
  v_observations jsonb;
  v_projects jsonb;
  v_prev timestamptz;
  v_shown jsonb := '[]'::jsonb;
  v_ref_text text;
  v_refs jsonb := '[]'::jsonb;
BEGIN
  IF p_subject_limit IS NULL OR p_subject_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_window: p_subject_limit must be from 1 to 1000';
  END IF;
  IF p_recent_limit IS NULL OR p_recent_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_window: p_recent_limit must be from 1 to 200';
  END IF;
  IF p_version IS NULL OR p_version !~ '\S' OR char_length(p_version) > 64 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_window: p_version must be a non-blank text of at most 64 characters';
  END IF;
  IF p_any_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_window: p_any_version is required';
  END IF;

  SELECT * INTO a
    FROM public.memory_items i
   WHERE i.id = p_anchor AND i.class = 'utterance' AND i.forgotten_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- event_id is cast only when it is 1 to 18 digits, as engram_invariant_counts
  -- reads it, so a malformed value means no event instead of a cast error.
  SELECT jsonb_build_object('payload', e.payload, 'plan_dirs', to_jsonb(e.plan_dirs)),
         public.engram_extraction_plan_slug(e.plan_dirs)
    INTO v_event, v_plan
    FROM public.memory_capture_events e
   WHERE e.id = CASE WHEN (a.source ->> 'event_id') ~ '^[0-9]{1,18}$' THEN (a.source ->> 'event_id')::bigint END;

  IF a.kind IN ('user_prompt', 'assistant_turn') AND a.session_id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', t.id, 'kind', t.kind, 'session_id', t.session_id, 'project_id', t.project_id,
             'workspace_id', t.workspace_id, 'content', t.content, 'context', t.context,
             'occurred_at', to_char(t.occurred_at AT TIME ZONE 'UTC', v_time), 'source', t.source,
             'observed', g.observed)
             ORDER BY t.occurred_at, t.id), '[]'::jsonb),
           string_agg(t.content, E'\n' ORDER BY t.occurred_at, t.id)
      INTO v_turns, v_ref_text
      FROM public.engram_extraction_turn_groups(p_version, a.session_id, p_any_version) g
      JOIN public.memory_items t ON t.id = g.turn_id
     WHERE g.anchor_id = a.id;
  END IF;

  IF a.kind IN ('user_prompt', 'user_answer') AND a.session_id IS NOT NULL THEN
    SELECT max(p.occurred_at) INTO v_prev
      FROM public.memory_items p
     WHERE p.class = 'utterance' AND p.kind IN ('user_prompt', 'user_answer')
       AND p.session_id = a.session_id AND (p.occurred_at, p.id) < (a.occurred_at, a.id);
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', i.id, 'class', i.class, 'kind', i.kind, 'subject_id', i.subject_id, 'subject_label', sj.label,
             'project_id', i.project_id, 'workspace_id', i.workspace_id, 'content', left(i.content, 1500),
             'occurred_at', to_char(i.occurred_at AT TIME ZONE 'UTC', v_time))
             ORDER BY f.rank), '[]'::jsonb)
      INTO v_shown
      FROM (SELECT g.id, g.rank
              FROM (SELECT x.id, min(x.rank) AS rank
                      FROM (SELECT (s.v #>> '{}')::uuid AS id,
                                   row_number() OVER (ORDER BY e.occurred_at DESC, e.id DESC, s.n) AS rank
                              FROM public.memory_capture_events e
                             CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload -> 'item_ids') = 'array'
                                                                          THEN e.payload -> 'item_ids' ELSE '[]'::jsonb END)
                                        WITH ORDINALITY AS s(v, n)
                             WHERE e.session_id = a.session_id AND e.type = 'briefing_shown'
                               AND e.occurred_at >= coalesce(v_prev, '-infinity'::timestamptz)
                               AND e.occurred_at < a.occurred_at
                               AND jsonb_typeof(s.v) = 'string'
                               AND (s.v #>> '{}') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') AS x
                     GROUP BY x.id) AS g
              JOIN public.memory_items c ON c.id = g.id
             WHERE c.superseded_by IS NULL AND c.retired_at IS NULL AND c.forgotten_at IS NULL
             ORDER BY g.rank
             LIMIT 24) AS f
      JOIN public.memory_items i ON i.id = f.id
      LEFT JOIN public.memory_subjects sj ON sj.id = i.subject_id;
  END IF;

  IF v_ref_text IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', i.id, 'class', i.class, 'kind', i.kind, 'subject_id', i.subject_id,
             'project_id', i.project_id, 'workspace_id', i.workspace_id,
             'occurred_at', to_char(i.occurred_at AT TIME ZONE 'UTC', v_time),
             'superseded_by', i.superseded_by,
             'retired_at', to_char(i.retired_at AT TIME ZONE 'UTC', v_time),
             'forgotten_at', to_char(i.forgotten_at AT TIME ZONE 'UTC', v_time))
             ORDER BY i.id), '[]'::jsonb)
      INTO v_refs
      FROM public.memory_items i
     WHERE i.id IN (SELECT DISTINCT lower(m.found[1])::uuid
                      FROM regexp_matches(v_ref_text, '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})', 'gi') AS m(found)
                     LIMIT 200);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'label', s.label, 'project_id', s.project_id,
           'last_used_at', to_char(s.used AT TIME ZONE 'UTC', v_time))
           ORDER BY s.used DESC, s.label COLLATE "C", s.id), '[]'::jsonb)
    INTO v_subjects
    FROM (SELECT sj.id, sj.label, sj.project_id, u.used
            FROM public.memory_subjects sj
            JOIN LATERAL (SELECT max(i.occurred_at) AS used
                            FROM public.memory_items i
                           WHERE i.subject_id = sj.id AND i.forgotten_at IS NULL
                             AND i.retired_at IS NULL AND i.superseded_by IS NULL) u ON u.used IS NOT NULL
           WHERE sj.project_id IS NULL OR sj.project_id = a.project_id
              OR (a.project_id IS NULL AND sj.project_id = a.workspace_id)
           ORDER BY u.used DESC, sj.label COLLATE "C", sj.id
           LIMIT p_subject_limit) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'kind', s.kind, 'subject_id', s.subject_id, 'subject_label', s.label,
           'project_id', s.project_id, 'workspace_id', s.workspace_id,
           'content', s.content, 'occurred_at', to_char(s.occurred_at AT TIME ZONE 'UTC', v_time))
           ORDER BY s.occurred_at DESC, s.id DESC), '[]'::jsonb)
    INTO v_statements
    FROM (SELECT i.id, i.kind, i.subject_id, sj.label, i.project_id, i.workspace_id, i.content, i.occurred_at
            FROM public.memory_items i
            LEFT JOIN public.memory_subjects sj ON sj.id = i.subject_id
           WHERE i.class = 'mk_statement' AND i.forgotten_at IS NULL
             AND i.retired_at IS NULL AND i.superseded_by IS NULL
             AND public.engram_extraction_in_scope(i, a, v_plan)
           ORDER BY i.occurred_at DESC, i.id DESC
           LIMIT p_recent_limit) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'kind', s.kind, 'subject_id', s.subject_id, 'subject_label', s.label,
           'project_id', s.project_id, 'workspace_id', s.workspace_id,
           'content', s.content, 'occurred_at', to_char(s.occurred_at AT TIME ZONE 'UTC', v_time))
           ORDER BY s.occurred_at DESC, s.id DESC), '[]'::jsonb)
    INTO v_observations
    FROM (SELECT i.id, i.kind, i.subject_id, sj.label, i.project_id, i.workspace_id, i.content, i.occurred_at
            FROM public.memory_items i
            LEFT JOIN public.memory_subjects sj ON sj.id = i.subject_id
           WHERE i.class = 'observation' AND i.forgotten_at IS NULL
             AND i.retired_at IS NULL AND i.superseded_by IS NULL
             AND public.engram_extraction_in_scope(i, a, v_plan)
           ORDER BY i.occurred_at DESC, i.id DESC
           LIMIT p_recent_limit) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind) ORDER BY p.id COLLATE "C"), '[]'::jsonb)
    INTO v_projects
    FROM public.memory_projects p;

  RETURN jsonb_build_object(
    'anchor', jsonb_build_object(
      'id', a.id, 'kind', a.kind, 'session_id', a.session_id, 'project_id', a.project_id,
      'workspace_id', a.workspace_id, 'content', a.content, 'context', a.context,
      'occurred_at', to_char(a.occurred_at AT TIME ZONE 'UTC', v_time), 'source', a.source),
    'anchor_event', v_event,
    'turns', v_turns,
    'subjects', v_subjects,
    'statements', v_statements,
    'observations', v_observations,
    'shown', v_shown,
    'turn_refs', v_refs,
    'projects', v_projects);
END; $$;


--
-- Name: engram_extraction_begin(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

-- Opens a run on p_anchor at p_version and returns its id, or NULL when the
-- anchor already has a running or succeeded run at that version
-- (idx_extraction_runs_anchor_version). p_anchor must name an utterance and
-- p_session its session; p_model is the model asked, NULL when unknown.
CREATE OR REPLACE FUNCTION public.engram_extraction_begin(p_anchor uuid, p_session text, p_version text, p_model text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_session text;
  v_id uuid;
BEGIN
  IF p_version IS NULL OR p_version !~ '\S' OR char_length(p_version) > 64 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_begin: p_version must be a non-blank text of at most 64 characters';
  END IF;
  IF p_model IS NOT NULL AND (p_model !~ '\S' OR char_length(p_model) > 200) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_begin: p_model must be NULL or a non-blank text of at most 200 characters';
  END IF;
  SELECT i.session_id INTO v_session
    FROM public.memory_items i
   WHERE i.id = p_anchor AND i.class = 'utterance';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_begin: p_anchor names no utterance';
  END IF;
  IF p_session IS DISTINCT FROM v_session THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_begin: p_session is not the anchor''s session';
  END IF;

  INSERT INTO public.memory_extraction_runs AS r (session_id, anchor_item_id, extractor_version, model, status)
  VALUES (p_session, p_anchor, p_version, p_model, 'running')
  ON CONFLICT (anchor_item_id, extractor_version) WHERE (status IN ('running', 'succeeded')) DO NOTHING
  RETURNING r.id INTO v_id;
  RETURN v_id;
END; $$;


--
-- Name: engram_extraction_fail(uuid, text, text, boolean, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

-- p_counted was added to this function; the earlier signature is dropped so
-- it does not stay behind as a second overload.
DROP FUNCTION IF EXISTS public.engram_extraction_fail(uuid, text, text, jsonb);

-- Closes a running run as failed: finished_at, error (its first 500
-- characters, NULL when blank) and stats, which are p_stats (counts only,
-- never text) with failure set to p_failure, 'held' or 'transient', and
-- counted to p_counted, whether the failure counts toward the anchor's limit
-- for its class. Returns false and changes nothing when the run is not
-- running: a commit or an earlier close came first.
CREATE OR REPLACE FUNCTION public.engram_extraction_fail(p_run uuid, p_error text, p_failure text, p_counted boolean, p_stats jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_fail: p_run must not be NULL';
  END IF;
  IF p_failure IS NULL OR p_failure NOT IN ('transient', 'held') THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_fail: p_failure must be transient or held';
  END IF;
  IF p_counted IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_fail: p_counted must not be NULL';
  END IF;
  IF p_stats IS NOT NULL AND jsonb_typeof(p_stats) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_fail: p_stats must be a JSON object or NULL';
  END IF;

  UPDATE public.memory_extraction_runs r
     SET status = 'failed',
         finished_at = now(),
         error = CASE WHEN p_error ~ '\S' THEN left(p_error, 500) END,
         stats = coalesce(p_stats, '{}'::jsonb) || jsonb_build_object('failure', p_failure, 'counted', p_counted)
   WHERE r.id = p_run AND r.status = 'running';
  RETURN FOUND;
END; $$;


--
-- Name: engram_extraction_apply(uuid, jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

-- The body of engram_extraction_commit, which calls it with p_reindex empty.
-- Stores what one run extracted, in one transaction, and closes the run as
-- succeeded. p_payload is {subjects, items, retractions, stats}, each key
-- optional:
-- - subjects: [{key, label, project_id}], the new subjects the items name by
--   key. Each is upserted on idx_subjects_project_label, so a label already
--   stored under that project (in any case) is reused, and its key resolves
--   to the stored or created id. subjects_created counts the rows created.
-- - items: up to 500 mk_statement or observation objects in
--   engram_insert_items' form, except that a subject is given either as
--   subject_id or as subject_key, entities lists the item's
--   {entity, entity_type} rows, links lists its validated links
--   {rel, target} (rel supersedes, restates, corrects, retracts or changes;
--   never both supersedes and restates) and links_rejected the links its
--   validation refused, {target, reason}, and candidates_read the ids of
--   the current items on its subject it was weighed against (with those its
--   links name), as engram_extraction_candidates read them; on a new subject
--   (subject_key) only a standing statement has them, read by the label. Every item gets
--   extraction_run_id = p_run. An item whose source.event_key is already
--   stored is not inserted and counts as a duplicate; its entities and links
--   are not written again, since they were written with it.
-- - retractions: null or an array of {from, targets, rejected}, one per
--   assistant turn of the window whose text retracts earlier items: the
--   turn, the ids it retracts and the retractions its validation refused,
--   [{target, reason}]. Each target becomes a retracts link from that turn,
--   applied and checked as an item's links are; a refused one is recorded
--   under the turn's id.
-- - stats: counts only, never text; the run's stats are these plus
--   subjects_created, entities (rows written), duplicates, links_applied,
--   links_rejected [{item, target, reason}], restatements
--   [{target, at, utterance}] and link_race [{item, appeared}].
-- link_race names, per item with candidates_read, each item that
-- engram_extraction_subject_current returns for it now (under the key,
-- before this call writes any item; an item on a new subject by its subject's
-- label, as engram_extraction_candidates read it) and that is not in
-- candidates_read: it
-- became current after the read, so the item was never weighed against it.
-- Both stay current; nothing is applied to the newcomer.
-- An item with no supersedes link is a restatement when a restates target is
-- current, or else when a current item of its class and subject in the
-- anchor's scope (engram_extraction_in_scope) holds the same words under the
-- quote rule and occurred no later. A restatement is not
-- stored: its occurred_at joins each target's restated_at (sorted, each time
-- once), its other links run from its first target, and that target stands
-- for it in item_ids. Every other item is inserted and its links applied in
-- input order: supersedes through engram_supersede_item, corrects, retracts
-- and changes as memory_item_links rows (a repeated row is skipped). A link
-- whose target is no longer current (superseded, retired or forgotten) is not
-- applied and is recorded as not_current; a target that names no item, a
-- restatement time earlier than its target, or a supersession the item rules
-- refuse raises, so the window's items and links are stored together or not
-- at all.
-- The run row is locked first and must be running. The deferred item checks
-- (an mk_statement's quote must occur in an MK utterance of its lineage) are
-- forced right after the insert, so a refused item raises from this call,
-- nothing is written and the run stays running for the caller to fail.
-- Restatement times and supersessions lock existing item rows, so the call
-- takes the forget advisory key (7308892986227385959) exclusively before it
-- reads or writes any item, as every function that locks item rows does.
-- Returns {item_ids, subjects_created, duplicates, restatements,
-- links_applied}: item_ids
-- holds one id per item in input order, a duplicate's being the stored
-- item's and a restatement's its first target's.
-- p_reindex names further sessions whose index the caller's transaction
-- changed before this call (engram_extraction_replace: the sessions of the
-- items it retired or handed back). They are made due for a rebuild with the
-- sessions of this call's own items, all their rows locked in one
-- session_id order: two separate ordered passes could each hold a row the
-- other waits for, as could an ingest.
CREATE OR REPLACE FUNCTION public.engram_extraction_apply(p_run uuid, p_payload jsonb, p_reindex text[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_status text;
  v_problem text;
  v_subjects jsonb;
  v_items jsonb;
  v_stats jsonb;
  v_keys jsonb := '{}'::jsonb;
  v_insert jsonb;
  v_count integer;
  v_ids uuid[] := '{}'::uuid[];
  v_sessions text[];
  v_added boolean[] := '{}'::boolean[];
  v_restating boolean[] := '{}'::boolean[];
  v_to_insert jsonb;
  v_positions integer[];
  v_row record;
  v_n integer;
  v_obj jsonb;
  v_links jsonb;
  v_link jsonb;
  v_target uuid;
  v_targets uuid[];
  v_at timestamptz;
  v_target_at timestamptz;
  v_current boolean;
  v_refused jsonb := '[]'::jsonb;
  v_restated jsonb := '[]'::jsonb;
  v_applied integer := 0;
  v_restatements integer := 0;
  v_created integer := 0;
  v_entities integer := 0;
  v_duplicates integer := 0;
  v_anchor public.memory_items%ROWTYPE;
  v_plan text;
  v_race jsonb := '[]'::jsonb;
  v_retractions jsonb;
  v_retraction jsonb;
  v_from uuid;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_commit: p_payload must be a JSON object';
  END IF;
  SELECT format('p_payload has the key %s, which is not subjects, items, retractions or stats', quote_ident(left(k.key, 63)))
    INTO v_problem
    FROM jsonb_object_keys(p_payload) AS k(key)
   WHERE k.key NOT IN ('subjects', 'items', 'retractions', 'stats')
   ORDER BY k.key
   LIMIT 1;
  v_subjects := CASE WHEN coalesce(p_payload -> 'subjects', 'null'::jsonb) = 'null'::jsonb THEN '[]'::jsonb ELSE p_payload -> 'subjects' END;
  v_items := CASE WHEN coalesce(p_payload -> 'items', 'null'::jsonb) = 'null'::jsonb THEN '[]'::jsonb ELSE p_payload -> 'items' END;
  v_stats := CASE WHEN coalesce(p_payload -> 'stats', 'null'::jsonb) = 'null'::jsonb THEN '{}'::jsonb ELSE p_payload -> 'stats' END;
  IF v_problem IS NULL AND jsonb_typeof(v_subjects) <> 'array' THEN
    v_problem := 'subjects must be a JSON array';
  END IF;
  IF v_problem IS NULL AND jsonb_typeof(v_items) <> 'array' THEN
    v_problem := 'items must be a JSON array';
  END IF;
  IF v_problem IS NULL AND jsonb_typeof(v_stats) <> 'object' THEN
    v_problem := 'stats must be a JSON object';
  END IF;
  IF v_problem IS NULL AND jsonb_array_length(v_items) > 500 THEN
    v_problem := format('items holds %s objects, more than 500', jsonb_array_length(v_items));
  END IF;
  v_retractions := CASE WHEN coalesce(p_payload -> 'retractions', 'null'::jsonb) = 'null'::jsonb THEN '[]'::jsonb ELSE p_payload -> 'retractions' END;
  IF v_problem IS NULL AND (
       jsonb_typeof(v_retractions) <> 'array'
       OR EXISTS (SELECT 1
                    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_retractions) = 'array' THEN v_retractions ELSE '[]'::jsonb END) AS e(v)
                   WHERE jsonb_typeof(e.v) <> 'object'
                      OR EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(e.v) = 'object' THEN e.v ELSE '{}'::jsonb END) AS k(key)
                                  WHERE k.key NOT IN ('from', 'targets', 'rejected'))
                      OR jsonb_typeof(e.v -> 'from') IS DISTINCT FROM 'string'
                      OR (e.v ->> 'from') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
                      OR jsonb_typeof(e.v -> 'targets') IS DISTINCT FROM 'array'
                      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.v -> 'targets') = 'array'
                                                                         THEN e.v -> 'targets' ELSE '[]'::jsonb END) AS x(v)
                                  WHERE jsonb_typeof(x.v) <> 'string'
                                     OR (x.v #>> '{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
                      OR jsonb_typeof(e.v -> 'rejected') IS DISTINCT FROM 'array'
                      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.v -> 'rejected') = 'array'
                                                                         THEN e.v -> 'rejected' ELSE '[]'::jsonb END) AS r(v)
                                  WHERE CASE WHEN jsonb_typeof(r.v) <> 'object' THEN true
                                             ELSE EXISTS (SELECT 1 FROM jsonb_object_keys(r.v) AS k(key) WHERE k.key NOT IN ('target', 'reason'))
                                                  OR coalesce(r.v ->> 'reason', '') NOT IN ('not_current', 'class_mismatch', 'subject_mismatch',
                                                                                            'target_newer', 'target_same_time', 'link_conflict',
                                                                                            'not_a_candidate', 'not_in_scope')
                                                  OR jsonb_typeof(r.v -> 'target') IS DISTINCT FROM 'string'
                                                  OR (r.v ->> 'target') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' END))) THEN
    v_problem := 'retractions must be null or an array of {from, targets, rejected}: a UUID, an array of UUIDs and an array of {target, reason} with a known reason';
  END IF;

  IF v_problem IS NULL THEN
    SELECT x.reason INTO v_problem
      FROM (SELECT s.n,
                   CASE
                     WHEN jsonb_typeof(s.v) <> 'object' THEN format('subject %s is not a JSON object', s.n)
                     WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(s.v) AS k(key) WHERE k.key NOT IN ('key', 'label', 'project_id')) THEN
                       format('subject %s has a key other than key, label and project_id', s.n)
                     WHEN jsonb_typeof(s.v -> 'key') IS DISTINCT FROM 'string' OR (s.v ->> 'key') !~ '\S' THEN
                       format('subject %s: key must be a non-blank string', s.n)
                     WHEN jsonb_typeof(s.v -> 'label') IS DISTINCT FROM 'string' THEN
                       format('subject %s: label must be a string', s.n)
                     WHEN coalesce(jsonb_typeof(s.v -> 'project_id'), 'null') NOT IN ('string', 'null') THEN
                       format('subject %s: project_id must be a string or null', s.n)
                   END AS reason
              FROM jsonb_array_elements(v_subjects) WITH ORDINALITY AS s(v, n)) AS x
     WHERE x.reason IS NOT NULL
     ORDER BY x.n
     LIMIT 1;
  END IF;

  IF v_problem IS NULL THEN
    SELECT format('subjects %s and %s share a key', min(s.n), max(s.n)) INTO v_problem
      FROM jsonb_array_elements(v_subjects) WITH ORDINALITY AS s(v, n)
     GROUP BY s.v ->> 'key'
    HAVING count(*) > 1
     ORDER BY min(s.n)
     LIMIT 1;
  END IF;

  IF v_problem IS NULL THEN
    SELECT x.reason INTO v_problem
      FROM (SELECT t.n,
                   CASE
                     WHEN jsonb_typeof(t.v) <> 'object' THEN format('item %s is not a JSON object', t.n)
                     WHEN coalesce(t.v ->> 'class', '') NOT IN ('mk_statement', 'observation') THEN
                       format('item %s: class must be mk_statement or observation', t.n)
                     WHEN (coalesce(t.v -> 'subject_id', 'null'::jsonb) = 'null'::jsonb)
                          = (coalesce(t.v -> 'subject_key', 'null'::jsonb) = 'null'::jsonb) THEN
                       format('item %s must give exactly one of subject_id and subject_key', t.n)
                     WHEN coalesce(t.v -> 'subject_key', 'null'::jsonb) <> 'null'::jsonb
                          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_subjects) AS s(v)
                                           WHERE (s.v -> 'key') = (t.v -> 'subject_key')) THEN
                       format('item %s: subject_key names no subject of the payload', t.n)
                     WHEN coalesce(jsonb_typeof(t.v -> 'entities'), 'null') NOT IN ('array', 'null') THEN
                       format('item %s: entities must be a JSON array', t.n)
                     WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.v -> 'entities') = 'array'
                                                                          THEN t.v -> 'entities' ELSE '[]'::jsonb END) AS e(v)
                                   WHERE CASE WHEN jsonb_typeof(e.v) <> 'object' THEN true
                                              ELSE EXISTS (SELECT 1 FROM jsonb_object_keys(e.v) AS k(key) WHERE k.key NOT IN ('entity', 'entity_type'))
                                                   OR jsonb_typeof(e.v -> 'entity') IS DISTINCT FROM 'string'
                                                   OR jsonb_typeof(e.v -> 'entity_type') IS DISTINCT FROM 'string' END) THEN
                       format('item %s: each entity must be {entity, entity_type} with string values', t.n)
                     WHEN coalesce(jsonb_typeof(t.v -> 'links'), 'null') NOT IN ('array', 'null') THEN
                       format('item %s: links must be a JSON array', t.n)
                     WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.v -> 'links') = 'array'
                                                                          THEN t.v -> 'links' ELSE '[]'::jsonb END) AS l(v)
                                   WHERE CASE WHEN jsonb_typeof(l.v) <> 'object' THEN true
                                              ELSE EXISTS (SELECT 1 FROM jsonb_object_keys(l.v) AS k(key) WHERE k.key NOT IN ('rel', 'target'))
                                                   OR coalesce(l.v ->> 'rel', '') NOT IN ('supersedes', 'restates', 'corrects', 'retracts', 'changes')
                                                   OR jsonb_typeof(l.v -> 'target') IS DISTINCT FROM 'string'
                                                   OR (l.v ->> 'target') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' END) THEN
                       format('item %s: each link must be {rel, target} with a known rel and a UUID target', t.n)
                     WHEN (t.v -> 'links') @> '[{"rel": "supersedes"}]' AND (t.v -> 'links') @> '[{"rel": "restates"}]' THEN
                       format('item %s both supersedes and restates', t.n)
                     WHEN coalesce(jsonb_typeof(t.v -> 'links_rejected'), 'null') NOT IN ('array', 'null') THEN
                       format('item %s: links_rejected must be a JSON array', t.n)
                     WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.v -> 'links_rejected') = 'array'
                                                                          THEN t.v -> 'links_rejected' ELSE '[]'::jsonb END) AS r(v)
                                   WHERE CASE WHEN jsonb_typeof(r.v) <> 'object' THEN true
                                              ELSE EXISTS (SELECT 1 FROM jsonb_object_keys(r.v) AS k(key) WHERE k.key NOT IN ('target', 'reason'))
                                                   OR coalesce(r.v ->> 'reason', '') NOT IN ('not_current', 'class_mismatch', 'subject_mismatch',
                                                                                             'target_newer', 'target_same_time', 'link_conflict',
                                                                                             'not_a_candidate', 'not_in_scope')
                                                   OR jsonb_typeof(r.v -> 'target') IS DISTINCT FROM 'string'
                                                   OR (r.v ->> 'target') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' END) THEN
                       format('item %s: each rejected link must be {target, reason} with a known reason and a UUID target', t.n)
                     WHEN coalesce(jsonb_typeof(t.v -> 'candidates_read'), 'null') NOT IN ('array', 'null')
                          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.v -> 'candidates_read') = 'array'
                                                                             THEN t.v -> 'candidates_read' ELSE '[]'::jsonb END) AS c(v)
                                      WHERE jsonb_typeof(c.v) <> 'string'
                                         OR (c.v #>> '{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN
                       format('item %s: candidates_read must be an array of UUIDs', t.n)
                     WHEN jsonb_typeof(t.v -> 'candidates_read') = 'array' AND coalesce(t.v -> 'subject_id', 'null'::jsonb) = 'null'::jsonb
                          AND NOT (t.v ->> 'class' = 'mk_statement' AND (t.v -> 'standing') = 'true'::jsonb) THEN
                       format('item %s: candidates_read needs a subject_id, or a standing statement on a new subject', t.n)
                   END AS reason
              FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(v, n)) AS x
     WHERE x.reason IS NOT NULL
     ORDER BY x.n
     LIMIT 1;
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_commit: ' || v_problem;
  END IF;

  SELECT r.status INTO v_status
    FROM public.memory_extraction_runs r
   WHERE r.id = p_run
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_commit: p_run names no run';
  END IF;
  IF v_status <> 'running' THEN
    RAISE EXCEPTION USING ERRCODE = 'object_not_in_prerequisite_state',
      MESSAGE = format('engram_extraction_commit: the run is %s, not running', v_status);
  END IF;

  IF jsonb_array_length(v_subjects) > 0 THEN
    WITH added AS (
      INSERT INTO public.memory_subjects AS m (project_id, label)
      SELECT s.v ->> 'project_id', s.v ->> 'label'
        FROM jsonb_array_elements(v_subjects) WITH ORDINALITY AS s(v, n)
       ORDER BY s.n
      ON CONFLICT ((coalesce(project_id, '')), lower(label)) DO NOTHING
      RETURNING m.id
    )
    SELECT count(*) INTO v_created FROM added;

    -- A separate statement: the rows inserted above, and any a concurrent
    -- commit inserted first, are visible only to a later snapshot.
    SELECT jsonb_object_agg(s.v ->> 'key', m.id) INTO v_keys
      FROM jsonb_array_elements(v_subjects) AS s(v)
      JOIN public.memory_subjects m
        ON coalesce(m.project_id, '') = coalesce(s.v ->> 'project_id', '') AND lower(m.label) = lower(s.v ->> 'label');
  END IF;

  IF jsonb_array_length(v_items) > 0 THEN
    PERFORM pg_advisory_xact_lock(7308892986227385959);

    SELECT format('item %s: link target %s names no item', t.n, l.v ->> 'target') INTO v_problem
      FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(v, n)
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.v -> 'links') = 'array'
                                                  THEN t.v -> 'links' ELSE '[]'::jsonb END) WITH ORDINALITY AS l(v, k)
     WHERE NOT EXISTS (SELECT 1 FROM public.memory_items i WHERE i.id = (l.v ->> 'target')::uuid)
     ORDER BY t.n, l.k
     LIMIT 1;
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_extraction_commit: ' || v_problem;
    END IF;

    -- Before any item of this call is written, so only items another writer
    -- made current since the read can appear here.
    SELECT r.* INTO v_anchor
      FROM public.memory_extraction_runs x
      JOIN public.memory_items r ON r.id = x.anchor_item_id
     WHERE x.id = p_run;
    SELECT public.engram_extraction_plan_slug(e.plan_dirs) INTO v_plan
      FROM public.memory_capture_events e
     WHERE e.id = CASE WHEN (v_anchor.source ->> 'event_id') ~ '^[0-9]{1,18}$' THEN (v_anchor.source ->> 'event_id')::bigint END;
    SELECT coalesce(jsonb_agg(jsonb_build_object('n', t.n, 'appeared', c.id) ORDER BY t.n, c.occurred_at DESC, c.id DESC), '[]'::jsonb)
      INTO v_race
      FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(v, n)
     CROSS JOIN LATERAL public.engram_extraction_subject_current(
                          v_anchor, v_plan, (t.v ->> 'subject_id')::uuid,
                          (SELECT s.v ->> 'label' FROM jsonb_array_elements(v_subjects) AS s(v)
                            WHERE (s.v -> 'key') = (t.v -> 'subject_key') LIMIT 1),
                          t.v ->> 'class', (t.v ->> 'standing')::boolean,
                          (t.v ->> 'occurred_at')::timestamptz) AS c
     WHERE jsonb_typeof(t.v -> 'candidates_read') = 'array'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.v -> 'candidates_read') AS k(x) WHERE k.x::uuid = c.id);

    SELECT jsonb_agg((t.v - 'subject_key' - 'entities' - 'links' - 'links_rejected' - 'candidates_read')
                     || jsonb_build_object('extraction_run_id', p_run)
                     || CASE WHEN coalesce(t.v -> 'subject_key', 'null'::jsonb) <> 'null'::jsonb
                             THEN jsonb_build_object('subject_id', v_keys -> (t.v ->> 'subject_key'))
                             ELSE '{}'::jsonb END
                     ORDER BY t.n)
      INTO v_insert
      FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(v, n);

    v_count := jsonb_array_length(v_items);
    v_ids := array_fill(NULL::uuid, ARRAY[v_count]);
    v_added := array_fill(false, ARRAY[v_count]);
    v_restating := array_fill(false, ARRAY[v_count]);

    -- Restatements first: an item whose event key is stored is left to the
    -- insert, which reports it as a duplicate.
    FOR v_n IN 1 .. v_count LOOP
      v_obj := v_insert -> (v_n - 1);
      v_links := CASE WHEN jsonb_typeof(v_items -> (v_n - 1) -> 'links') = 'array' THEN v_items -> (v_n - 1) -> 'links' ELSE '[]'::jsonb END;
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.memory_items x
                             WHERE (x.source ? 'event_key') AND (x.source ->> 'event_key') = (v_obj -> 'source' ->> 'event_key'));
      CONTINUE WHEN v_links @> '[{"rel": "supersedes"}]';
      v_at := (v_obj ->> 'occurred_at')::timestamptz;
      v_targets := '{}'::uuid[];
      FOR v_link IN SELECT l.v FROM jsonb_array_elements(v_links) WITH ORDINALITY AS l(v, k) WHERE l.v ->> 'rel' = 'restates' ORDER BY l.k LOOP
        v_target := (v_link ->> 'target')::uuid;
        SELECT i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL, i.occurred_at
          INTO v_current, v_target_at
          FROM public.memory_items i WHERE i.id = v_target;
        IF NOT v_current THEN
          v_refused := v_refused || jsonb_build_object('n', v_n, 'target', v_target, 'reason', 'not_current');
        ELSIF v_target_at > v_at THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation',
            MESSAGE = format('engram_extraction_commit: item %s restates an item that occurred later', v_n);
        ELSIF NOT v_target = ANY (v_targets) THEN
          v_targets := v_targets || v_target;
        END IF;
      END LOOP;
      IF cardinality(v_targets) = 0 THEN
        SELECT ARRAY[i.id] INTO v_targets
          FROM public.memory_items i
         WHERE i.class = v_obj ->> 'class' AND i.subject_id = (v_obj ->> 'subject_id')::uuid
           AND i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL
           AND i.occurred_at <= v_at
           AND public.engram_extraction_in_scope(i, v_anchor, v_plan)
           AND public.engram_norm_quote(i.content) = public.engram_norm_quote(v_obj ->> 'content')
         ORDER BY i.occurred_at DESC, i.id
         LIMIT 1;
      END IF;
      CONTINUE WHEN coalesce(cardinality(v_targets), 0) = 0;

      v_restating[v_n] := true;
      v_ids[v_n] := v_targets[1];
      v_restatements := v_restatements + 1;
      UPDATE public.memory_items m
         SET restated_at = ARRAY(SELECT DISTINCT u.x FROM unnest(m.restated_at || v_at) AS u(x) ORDER BY u.x)
       WHERE m.id = ANY (v_targets);
      SELECT v_restated || jsonb_agg(jsonb_build_object('target', g.id, 'at', v_obj -> 'occurred_at',
                                                        'utterance', v_obj -> 'lineage' -> 0) ORDER BY g.k)
        INTO v_restated
        FROM unnest(v_targets) WITH ORDINALITY AS g(id, k);
    END LOOP;

    SELECT coalesce(jsonb_agg(e.v ORDER BY e.n), '[]'::jsonb), coalesce(array_agg(e.n::integer ORDER BY e.n), '{}'::integer[])
      INTO v_to_insert, v_positions
      FROM jsonb_array_elements(v_insert) WITH ORDINALITY AS e(v, n)
     WHERE NOT v_restating[e.n::integer];
    IF cardinality(v_positions) > 0 THEN
      FOR v_row IN SELECT r.ord, r.id, r.inserted FROM public.engram_insert_items(v_to_insert) AS r LOOP
        v_ids[v_positions[v_row.ord]] := v_row.id;
        v_added[v_positions[v_row.ord]] := v_row.inserted;
      END LOOP;
    END IF;

    SET CONSTRAINTS ALL IMMEDIATE;

    -- Links, in input order, from each stored item or a restatement's first
    -- target; a duplicate's were written with it.
    FOR v_n IN 1 .. v_count LOOP
      CONTINUE WHEN NOT (v_added[v_n] OR v_restating[v_n]);
      v_links := CASE WHEN jsonb_typeof(v_items -> (v_n - 1) -> 'links') = 'array' THEN v_items -> (v_n - 1) -> 'links' ELSE '[]'::jsonb END;
      FOR v_link IN SELECT l.v FROM jsonb_array_elements(v_links) WITH ORDINALITY AS l(v, k) WHERE l.v ->> 'rel' <> 'restates' ORDER BY l.k LOOP
        v_target := (v_link ->> 'target')::uuid;
        IF v_target = v_ids[v_n] THEN
          v_refused := v_refused || jsonb_build_object('n', v_n, 'target', v_target, 'reason', 'link_conflict');
          CONTINUE;
        END IF;
        SELECT i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL INTO v_current
          FROM public.memory_items i WHERE i.id = v_target;
        IF NOT v_current THEN
          v_refused := v_refused || jsonb_build_object('n', v_n, 'target', v_target, 'reason', 'not_current');
          CONTINUE;
        END IF;
        IF v_link ->> 'rel' = 'supersedes' THEN
          PERFORM public.engram_supersede_item(v_target, v_ids[v_n]);
        ELSE
          INSERT INTO public.memory_item_links (from_item, to_item, rel, run_id)
          VALUES (v_ids[v_n], v_target, v_link ->> 'rel', p_run)
          ON CONFLICT (from_item, to_item, rel) DO NOTHING;
        END IF;
        v_applied := v_applied + 1;
      END LOOP;
      SELECT v_refused || coalesce(jsonb_agg(jsonb_build_object('n', v_n, 'target', r.v -> 'target', 'reason', r.v -> 'reason')
                                             ORDER BY r.k), '[]'::jsonb)
        INTO v_refused
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_items -> (v_n - 1) -> 'links_rejected') = 'array'
                                       THEN v_items -> (v_n - 1) -> 'links_rejected' ELSE '[]'::jsonb END) WITH ORDINALITY AS r(v, k);
    END LOOP;

    INSERT INTO public.memory_item_entities (item_id, entity, entity_type)
    SELECT v_ids[t.n::integer], e.v ->> 'entity', e.v ->> 'entity_type'
      FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(v, n)
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.v -> 'entities') = 'array'
                                                  THEN t.v -> 'entities' ELSE '[]'::jsonb END) AS e(v)
     WHERE v_added[t.n::integer]
    ON CONFLICT (item_id, entity) DO NOTHING;
    GET DIAGNOSTICS v_entities = ROW_COUNT;

    v_duplicates := v_count - v_restatements - cardinality(array_positions(v_added, true));
  END IF;

  IF jsonb_array_length(v_retractions) > 0 THEN
    PERFORM pg_advisory_xact_lock(7308892986227385959);
  END IF;
  FOR v_retraction IN SELECT e.v FROM jsonb_array_elements(v_retractions) WITH ORDINALITY AS e(v, k) ORDER BY e.k LOOP
    v_from := (v_retraction ->> 'from')::uuid;
    PERFORM 1 FROM public.memory_items i WHERE i.id = v_from AND i.class = 'utterance' AND i.kind = 'assistant_turn';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_extraction_commit: retractions.from names no assistant turn';
    END IF;
    FOR v_link IN SELECT x.v FROM jsonb_array_elements(v_retraction -> 'targets') WITH ORDINALITY AS x(v, k) ORDER BY x.k LOOP
      v_target := (v_link #>> '{}')::uuid;
      SELECT i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL INTO v_current
        FROM public.memory_items i WHERE i.id = v_target;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
          MESSAGE = format('engram_extraction_commit: retraction target %s names no item', v_target);
      END IF;
      IF v_target = v_from THEN
        v_refused := v_refused || jsonb_build_object('item', v_from, 'target', v_target, 'reason', 'link_conflict');
      ELSIF NOT v_current THEN
        v_refused := v_refused || jsonb_build_object('item', v_from, 'target', v_target, 'reason', 'not_current');
      ELSE
        INSERT INTO public.memory_item_links (from_item, to_item, rel, run_id)
        VALUES (v_from, v_target, 'retracts', p_run)
        ON CONFLICT (from_item, to_item, rel) DO NOTHING;
        v_applied := v_applied + 1;
      END IF;
    END LOOP;
    SELECT v_refused || coalesce(jsonb_agg(jsonb_build_object('item', v_from, 'target', r.v -> 'target', 'reason', r.v -> 'reason')
                                           ORDER BY r.k), '[]'::jsonb)
      INTO v_refused
      FROM jsonb_array_elements(v_retraction -> 'rejected') WITH ORDINALITY AS r(v, k);
  END LOOP;

  -- A session index lists its session's current statements and observations,
  -- so every session whose list this commit changed (the sessions of the items
  -- it stored or pointed at, and of the items they superseded, and the
  -- caller's p_reindex) gets indexed_event_id 0, which makes it due for a
  -- rebuild. The rows are locked in session_id order first, as
  -- engram_capture_ingest locks them: an UPDATE alone locks in scan order,
  -- and could deadlock with an ingest naming the same sessions.
  v_sessions := ARRAY(SELECT DISTINCT x.sid
                        FROM (SELECT i.session_id AS sid
                                FROM public.memory_items i
                               WHERE i.id = ANY (v_ids) OR i.superseded_by = ANY (v_ids)
                              UNION ALL
                              SELECT u.sid FROM unnest(coalesce(p_reindex, '{}'::text[])) AS u(sid)) AS x
                       WHERE x.sid IS NOT NULL);
  PERFORM 1 FROM public.memory_session_state st
   WHERE st.session_id = ANY (v_sessions)
   ORDER BY st.session_id
     FOR UPDATE;
  UPDATE public.memory_session_state st
     SET indexed_event_id = 0
   WHERE st.indexed_event_id <> 0
     AND st.session_id = ANY (v_sessions);

  UPDATE public.memory_extraction_runs r
     SET status = 'succeeded',
         finished_at = now(),
         error = NULL,
         stats = v_stats || jsonb_build_object(
                   'subjects_created', v_created, 'entities', v_entities, 'duplicates', v_duplicates,
                   'links_applied', v_applied,
                   'links_rejected', (SELECT coalesce(jsonb_agg(jsonb_build_object('item', coalesce(f.v -> 'item', to_jsonb(v_ids[(f.v ->> 'n')::integer])),
                                                                                   'target', f.v -> 'target',
                                                                                   'reason', f.v -> 'reason') ORDER BY f.k), '[]'::jsonb)
                                        FROM jsonb_array_elements(v_refused) WITH ORDINALITY AS f(v, k)),
                   'restatements', v_restated,
                   'link_race', (SELECT coalesce(jsonb_agg(jsonb_build_object('item', v_ids[(g.v ->> 'n')::integer],
                                                                              'appeared', g.v -> 'appeared') ORDER BY g.k), '[]'::jsonb)
                                   FROM jsonb_array_elements(v_race) WITH ORDINALITY AS g(v, k)))
   WHERE r.id = p_run;

  RETURN jsonb_build_object('item_ids', to_jsonb(v_ids), 'subjects_created', v_created, 'duplicates', v_duplicates,
                            'restatements', v_restatements, 'links_applied', v_applied);
END; $$;


--
-- Name: engram_extraction_commit(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

-- Stores what one run extracted and closes it as succeeded:
-- engram_extraction_apply with no further session to reindex, where the
-- payload, the link and restatement rules and the result are described.
CREATE OR REPLACE FUNCTION public.engram_extraction_commit(p_run uuid, p_payload jsonb) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.engram_extraction_apply(p_run, p_payload, '{}'::text[])
$$;


--
-- Name: engram_extraction_sessions(text, timestamp with time zone, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

-- The sessions an operator re-run of extraction covers: the one named by
-- p_session, or every session with an MK utterance (a user prompt or dialog
-- answer that is not forgotten) at or after p_since; exactly one of the two
-- is given. Rows are ordered by first_at, the session's earliest such
-- utterance (for a named session its earliest at all, NULL when it has
-- none), oldest first, so supersession runs forward in event time. due is
-- the rule the session index and the trailing-turn flush use for a session
-- that may be closed: it ended with no later event, or nothing of it was
-- received in the p_idle_seconds before p_now (received time, so a backlog
-- stored late is not idle), and no event of it waits for
-- engram_capture_materialize. A session that is not due is live and belongs
-- to the worker. A session with no state row yields no row. Read only.
CREATE OR REPLACE FUNCTION public.engram_extraction_sessions(p_session text, p_since timestamp with time zone, p_idle_seconds integer, p_now timestamp with time zone) RETURNS TABLE(session_id text, first_at timestamp with time zone, due boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF (p_session IS NULL) = (p_since IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_sessions: give exactly one of p_session and p_since';
  END IF;
  IF p_session IS NOT NULL AND char_length(p_session) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_sessions: p_session must hold 1 to 256 characters';
  END IF;
  IF p_since IS NOT NULL AND NOT public.engram_time_in_range(p_since) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_sessions: p_since must be a finite time';
  END IF;
  IF p_idle_seconds IS NULL OR p_idle_seconds < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_sessions: p_idle_seconds must be at least 1';
  END IF;
  IF p_now IS NULL OR NOT public.engram_time_in_range(p_now) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_sessions: p_now must be a finite time';
  END IF;

  RETURN QUERY
  WITH spoken AS (
    SELECT u.session_id AS sid, min(u.occurred_at) AS first_at
      FROM public.memory_items u
     WHERE u.class = 'utterance' AND u.kind IN ('user_prompt', 'user_answer')
       AND u.forgotten_at IS NULL AND u.session_id IS NOT NULL
       AND (CASE WHEN p_session IS NULL THEN u.occurred_at >= p_since ELSE u.session_id = p_session END)
     GROUP BY u.session_id
  ), chosen AS (
    SELECT sp.sid, sp.first_at FROM spoken sp
    UNION ALL
    SELECT p_session, NULL::timestamp with time zone
     WHERE p_session IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spoken)
  )
  SELECT c.sid, c.first_at,
         coalesce((st.ended_at >= st.last_event_at
                   OR st.last_received_at < p_now - make_interval(secs => p_idle_seconds))
                  AND NOT EXISTS (SELECT 1
                                    FROM public.memory_capture_events e
                                   WHERE e.session_id = c.sid AND e.processed_at IS NULL AND e.attempts < 3),
                  false)
    FROM chosen c
    JOIN public.memory_session_state st ON st.session_id = c.sid
   ORDER BY c.first_at NULLS LAST, c.sid;
END; $$;


--
-- Name: engram_extraction_session_anchors(text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

DROP FUNCTION IF EXISTS public.engram_extraction_session_anchors(text, text);

-- Every window of session p_session at extractor version p_version, in the
-- (occurred_at, id) order the worker runs them: its MK utterances that are
-- not forgotten, and the earliest turn of each observation-only group of
-- engram_extraction_turn_groups, a flush group included (the caller runs only
-- a session that may be closed). The windows and succeeded follow
-- p_any_version as engram_extraction_turn_groups reads it: with true (gap
-- fill) succeeded says a run at any version succeeded on the anchor, so only
-- what no version extracted is left; with false (--replace) it says one at
-- p_version did, so what other versions extracted is run again. running_run_id and running_started_at name a run
-- still open on it. Backoff and failure limits are not applied: an operator
-- re-run decides for itself. Read only.
CREATE OR REPLACE FUNCTION public.engram_extraction_session_anchors(p_version text, p_session text, p_any_version boolean) RETURNS TABLE(anchor_item_id uuid, anchor_kind text, occurred_at timestamp with time zone, succeeded boolean, running_run_id uuid, running_started_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_version IS NULL OR p_version !~ '\S' OR char_length(p_version) > 64 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_session_anchors: p_version must be a non-blank text of at most 64 characters';
  END IF;
  IF p_session IS NULL OR char_length(p_session) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_session_anchors: p_session must hold 1 to 256 characters';
  END IF;
  IF p_any_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_session_anchors: p_any_version is required';
  END IF;

  RETURN QUERY
  WITH grp AS (
    SELECT DISTINCT g.anchor_id
      FROM public.engram_extraction_turn_groups(p_version, p_session, p_any_version) g
     WHERE g.anchor_id IS DISTINCT FROM g.owner_id
  ), anchor AS (
    SELECT u.id, u.kind, u.occurred_at AS t_at
      FROM public.memory_items u
     WHERE u.session_id = p_session AND u.class = 'utterance' AND u.kind IN ('user_prompt', 'user_answer')
       AND u.forgotten_at IS NULL
    UNION ALL
    SELECT t.id, 'turns', t.occurred_at
      FROM grp g
      JOIN public.memory_items t ON t.id = g.anchor_id
  )
  SELECT a.id, a.kind, a.t_at,
         coalesce(rs.succeeded, false)
           OR (p_any_version AND EXISTS (SELECT 1 FROM public.memory_extraction_runs x
                                          WHERE x.anchor_item_id = a.id AND x.status = 'succeeded')),
         rs.running_run_id, rs.running_started_at
    FROM anchor a
    LEFT JOIN public.engram_extraction_run_state(p_version, p_session) rs ON rs.anchor_item_id = a.id
   ORDER BY a.t_at, a.id;
END; $$;


--
-- Name: engram_extraction_replace(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

-- engram_extraction_commit for a window that earlier extractor versions
-- already extracted, with what they stored and the new run did not reproduce
-- taken back first, all in one transaction. The window's old-version items
-- are the live (neither retired nor forgotten) items of runs at any other
-- version that came from the utterances this run extracts from: statements
-- quoting the run's anchor, observations of the turns p_payload's
-- stats.observation_sources names (an array of turn ids; absent means none).
-- An old item is reproduced when a payload item carries its event key; the
-- identity rule makes the same words from the same utterance the same item,
-- so the commit keeps it and writes no duplicate. Every other old item:
-- - is retired with the reason "replaced by extractor <version> (run <id>)",
--   unless MK recorded it in a register (register_status 'recorded'), in
--   which case it stays and is listed under kept_recorded;
-- - hands back what it superseded: each live item whose superseded_by is a
--   retired one is re-pointed to the nearest live item further along that
--   superseded_by chain, as a forget does, or restored (superseded_by
--   cleared, valid_to with it) when none remains.
-- The old versions' restatement times recorded for these utterances
-- (stats.restatements of their succeeded runs in this session) are removed
-- from their targets; the commit adds back the ones the new run reproduces.
-- The sessions of the retired and handed-back items get indexed_event_id 0,
-- as the commit does for its own, so their indexes are rebuilt.
-- Then the payload is committed as engram_extraction_commit commits it, and
-- the run's stats gain replace {retired [ids], restored [{item, from, to}]
-- (to NULL: restored, else re-pointed), kept_recorded [ids], unrestated
-- [{target, at}]}. Undoing a replace unretires the retired ids and
-- supersedes each restored item by its from id again. Returns the commit's
-- result plus retired, restored, kept_recorded and unrestated (a count).
-- The forget advisory key (7308892986227385959) is taken exclusively before
-- any row is locked, as every function that locks item rows does.
CREATE OR REPLACE FUNCTION public.engram_extraction_replace(p_run uuid, p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_run record;
  v_sources uuid[];
  v_utterances uuid[];
  v_keys text[];
  v_old record;
  v_retire uuid[] := '{}'::uuid[];
  v_recorded uuid[] := '{}'::uuid[];
  v_reason text;
  v_row record;
  v_step record;
  v_next uuid;
  v_seen uuid[];
  v_successor uuid;
  v_restored jsonb := '[]'::jsonb;
  v_unrestated jsonb := '[]'::jsonb;
  v_replace jsonb;
  v_result jsonb;
  v_reindex text[];
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_replace: p_run is required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR jsonb_typeof(p_payload -> 'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_replace: p_payload must be a JSON object with an items array';
  END IF;
  IF p_payload #> '{stats,observation_sources}' IS NOT NULL
     AND (jsonb_typeof(p_payload #> '{stats,observation_sources}') <> 'array'
          OR EXISTS (SELECT 1
                       FROM jsonb_array_elements(p_payload #> '{stats,observation_sources}') e
                      WHERE jsonb_typeof(e) <> 'string'
                         OR (e #>> '{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_replace: stats.observation_sources must be an array of item ids';
  END IF;

  PERFORM pg_advisory_xact_lock(7308892986227385959);
  SELECT r.status, r.anchor_item_id, r.extractor_version, r.session_id INTO v_run
    FROM public.memory_extraction_runs r
   WHERE r.id = p_run
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_extraction_replace: p_run names no run';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION USING ERRCODE = 'object_not_in_prerequisite_state',
      MESSAGE = format('engram_extraction_replace: the run is %s, not running', v_run.status);
  END IF;

  v_sources := ARRAY(SELECT DISTINCT (e #>> '{}')::uuid
                       FROM jsonb_array_elements(coalesce(p_payload #> '{stats,observation_sources}', '[]'::jsonb)) e);
  v_utterances := ARRAY[v_run.anchor_item_id] || v_sources;
  v_keys := ARRAY(SELECT i #>> '{source,event_key}'
                    FROM jsonb_array_elements(p_payload -> 'items') i
                   WHERE i #>> '{source,event_key}' IS NOT NULL);
  v_reason := format('replaced by extractor %s (run %s)', v_run.extractor_version, p_run);

  FOR v_old IN
    SELECT i.id, i.register_status
      FROM public.memory_items i
      JOIN public.memory_extraction_runs r ON r.id = i.extraction_run_id
     WHERE i.lineage && v_utterances
       AND ((i.class = 'mk_statement' AND i.lineage[1] = v_run.anchor_item_id)
            OR (i.class = 'observation' AND i.lineage[1] = ANY (v_sources)))
       AND r.extractor_version <> v_run.extractor_version
       AND i.retired_at IS NULL AND i.forgotten_at IS NULL
       AND NOT coalesce((i.source ->> 'event_key') = ANY (v_keys), false)
     ORDER BY i.id
       FOR NO KEY UPDATE OF i
  LOOP
    IF v_old.register_status IS NOT DISTINCT FROM 'recorded' THEN
      v_recorded := v_recorded || v_old.id;
    ELSE
      v_retire := v_retire || v_old.id;
    END IF;
  END LOOP;

  IF cardinality(v_retire) > 0 THEN
    PERFORM 1
       FROM public.memory_items m
      WHERE m.superseded_by = ANY (v_retire) AND m.forgotten_at IS NULL AND m.retired_at IS NULL
        AND NOT m.id = ANY (v_retire)
      ORDER BY m.id
        FOR NO KEY UPDATE;
    UPDATE public.memory_items m
       SET retired_at = now(), retired_reason = v_reason
     WHERE m.id = ANY (v_retire);

    FOR v_row IN
      SELECT m.id, m.superseded_by
        FROM public.memory_items m
       WHERE m.superseded_by = ANY (v_retire) AND m.forgotten_at IS NULL AND m.retired_at IS NULL
       ORDER BY m.id
    LOOP
      v_successor := NULL;
      v_seen := ARRAY[v_row.id, v_row.superseded_by];
      SELECT i.superseded_by INTO v_next FROM public.memory_items i WHERE i.id = v_row.superseded_by;
      WHILE v_next IS NOT NULL AND NOT v_next = ANY (v_seen) LOOP
        SELECT i.superseded_by, i.retired_at, i.forgotten_at INTO v_step
          FROM public.memory_items i
         WHERE i.id = v_next;
        EXIT WHEN NOT FOUND;
        IF v_step.retired_at IS NULL AND v_step.forgotten_at IS NULL THEN
          v_successor := v_next;
          EXIT;
        END IF;
        v_seen := v_seen || v_next;
        v_next := v_step.superseded_by;
      END LOOP;
      UPDATE public.memory_items m SET superseded_by = v_successor WHERE m.id = v_row.id;
      v_restored := v_restored || jsonb_build_array(
        jsonb_build_object('item', v_row.id, 'from', v_row.superseded_by, 'to', v_successor));
    END LOOP;
  END IF;

  FOR v_row IN
    SELECT DISTINCT (e ->> 'target')::uuid AS target, (e ->> 'at')::timestamp with time zone AS at
      FROM public.memory_extraction_runs r
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.stats -> 'restatements') = 'array'
                                                  THEN r.stats -> 'restatements' ELSE '[]'::jsonb END) e
     WHERE r.session_id = v_run.session_id AND r.status = 'succeeded'
       AND r.extractor_version <> v_run.extractor_version
       AND (e ->> 'utterance')::uuid = ANY (v_utterances)
     ORDER BY 1, 2
  LOOP
    UPDATE public.memory_items m
       SET restated_at = array_remove(m.restated_at, v_row.at)
     WHERE m.id = v_row.target AND v_row.at = ANY (m.restated_at);
    IF FOUND THEN
      v_unrestated := v_unrestated || jsonb_build_array(jsonb_build_object('target', v_row.target, 'at', v_row.at));
    END IF;
  END LOOP;

  -- A session index lists its session's current items, so the sessions of
  -- the items retired or handed back here go due for a rebuild, with the
  -- commit's own, in the commit's single ordered pass over their rows.
  v_reindex := ARRAY(SELECT DISTINCT m.session_id
                       FROM public.memory_items m
                      WHERE (m.id = ANY (v_retire)
                             OR m.id IN (SELECT (e ->> 'item')::uuid FROM jsonb_array_elements(v_restored) e))
                        AND m.session_id IS NOT NULL);
  v_result := public.engram_extraction_apply(p_run, p_payload, v_reindex);

  v_replace := jsonb_build_object('retired', to_jsonb(v_retire), 'restored', v_restored,
                                  'kept_recorded', to_jsonb(v_recorded), 'unrestated', v_unrestated);
  UPDATE public.memory_extraction_runs r
     SET stats = r.stats || jsonb_build_object('replace', v_replace)
   WHERE r.id = p_run;
  RETURN v_result || jsonb_build_object('retired', to_jsonb(v_retire), 'restored', v_restored,
                                        'kept_recorded', to_jsonb(v_recorded),
                                        'unrestated', jsonb_array_length(v_unrestated));
END; $$;


--
-- Name: engram_due_sessions(integer, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

-- Up to p_limit (1 to 1000) sessions whose index is out of date and may be
-- built now, the longest idle first. Out of date: an event was stored after
-- the last one the index reflects, or the index was forgotten. May be built:
-- the session ended with no later event, or nothing of it was received in
-- the p_idle_seconds before p_now; received time, not event time, so a
-- backlog stored long after its events happened does not count as idle. And
-- no event of the session waits for engram_capture_materialize, judged as
-- that function picks its candidates (unprocessed, fewer than 3 attempts),
-- so an event it gave up on never holds the index back. Each row carries the
-- session's last event id, which the builder hands back to
-- engram_session_index_commit. Read only.
CREATE OR REPLACE FUNCTION public.engram_due_sessions(p_idle_seconds integer, p_limit integer, p_now timestamp with time zone) RETURNS TABLE(session_id text, last_event_id bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_idle_seconds IS NULL OR p_idle_seconds < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_due_sessions: p_idle_seconds must be 0 or more';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_due_sessions: p_limit must be from 1 to 1000';
  END IF;
  IF p_now IS NULL OR NOT public.engram_time_in_range(p_now) THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_due_sessions: p_now must be a finite time';
  END IF;
  RETURN QUERY
  SELECT s.session_id, s.last_event_id
    FROM public.memory_session_state s
    LEFT JOIN public.memory_items i ON i.id = s.index_item_id
   WHERE (s.last_event_id > s.indexed_event_id OR i.forgotten_at IS NOT NULL)
     AND (s.ended_at >= s.last_event_at
          OR s.last_received_at < p_now - make_interval(secs => p_idle_seconds))
     AND NOT EXISTS (SELECT 1
                       FROM public.memory_capture_events c
                      WHERE c.session_id = s.session_id AND c.processed_at IS NULL AND c.attempts < 3)
   ORDER BY s.last_received_at, s.session_id
   LIMIT p_limit;
END; $$;


--
-- Name: engram_session_index_source(text); Type: FUNCTION; Schema: public; Owner: -
--

-- Everything the index of session p_session is rendered from, read in one
-- snapshot, as one JSON object:
-- - first_event_id, last_event_id: over its events; first_at, last_at: over
--   its events but briefing_shown, which records what memory showed the
--   session rather than anything the session did, so a resume that only
--   shows a briefing leaves the text as it was;
-- - history: a user_prompt event of it carries payload.origin;
-- - projects, workspaces: its events' project ids and workspaces, and plans:
--   the basenames of its events' plan_dirs and the plan of its ledger events;
--   each distinct, in the order first seen;
-- - utterances: its current user_prompt and user_answer utterances in event
--   order, each {id, kind, occurred_at, text}; text is a prompt's content
--   and an answer's search text, which pairs each question with MK's answer;
-- - has_utterance: it holds an utterance that is not forgotten;
-- - statements, observations: the ids of its current items of each class;
-- - commits: {repo, sha, occurred_at} of its git_commit events whose commit item is
--   stored and not forgotten (a commit captured by two sessions is one item,
--   so the event, not the item's session, ties the commit to the session);
-- - tool_refs: {repo, ref, occurred_at} of the refs its current assistant turns carry that
--   look like a commit sha or a GitHub pull request URL, repo being the
--   turn's project;
-- - ledger: {plan, id} of its ledger events whose item is stored and not
--   forgotten; a ruling has no id of its own and reads <phase>/<task>;
-- - current_index: {id, content, occurred_at} of its current index, or null.
-- Read only.
CREATE OR REPLACE FUNCTION public.engram_session_index_source(p_session text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_session IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_session_index_source: p_session is required';
  END IF;

  WITH ev AS (
    SELECT c.id, c.type, c.occurred_at, c.project, c.plan_dirs, c.payload,
           row_number() OVER (ORDER BY c.occurred_at, c.id) AS r
      FROM public.memory_capture_events c
     WHERE c.session_id = p_session
  ), it AS (
    SELECT i.id, i.class, i.kind, i.content, i.search_text, i.occurred_at, i.created_at, i.project_id, i.source,
           (i.superseded_by IS NULL AND i.retired_at IS NULL) AS is_current
      FROM public.memory_items i
     WHERE i.session_id = p_session AND i.forgotten_at IS NULL
  ), keyed AS (
    SELECT ev.id, ev.type, ev.occurred_at, ev.payload,
           CASE ev.type
             WHEN 'git_commit' THEN format('git:%s:%s', ev.payload ->> 'repo', ev.payload ->> 'sha')
             WHEN 'ledger_decision' THEN format('ledger-decision:%s:%s', ev.payload ->> 'plan', ev.payload ->> 'id')
                                         || ':' || encode(sha256(convert_to(ev.payload::text, 'UTF8')), 'hex')
             ELSE 'capture:' || ev.id
           END AS event_key
      FROM ev
     WHERE ev.type IN ('git_commit', 'ledger_decision', 'ledger_ruling')
  ), stored AS (
    SELECT k.*
      FROM keyed k
     WHERE EXISTS (SELECT 1 FROM public.memory_items i
                    WHERE (i.source ? 'event_key') AND (i.source ->> 'event_key') = k.event_key
                      AND i.forgotten_at IS NULL)
  ), plans AS (
    SELECT regexp_replace(rtrim(d.v, '/'), '^.*/', '') AS v, ev.r, d.n
      FROM ev
     CROSS JOIN LATERAL (SELECT x.v, x.n FROM unnest(ev.plan_dirs) WITH ORDINALITY AS x(v, n)
                         UNION ALL
                         SELECT ev.payload ->> 'plan', 2147483647
                          WHERE ev.type IN ('ledger_decision', 'ledger_ruling')) AS d(v, n)
  )
  SELECT jsonb_build_object(
           'session_id', p_session,
           'first_event_id', (SELECT min(ev.id) FROM ev),
           'last_event_id', (SELECT max(ev.id) FROM ev),
           'first_at', (SELECT min(ev.occurred_at) FROM ev WHERE ev.type <> 'briefing_shown'),
           'last_at', (SELECT max(ev.occurred_at) FROM ev WHERE ev.type <> 'briefing_shown'),
           'history', EXISTS (SELECT 1 FROM ev WHERE ev.type = 'user_prompt' AND ev.payload ? 'origin'),
           'projects', (SELECT coalesce(jsonb_agg(f.v ORDER BY f.r), '[]'::jsonb)
                          FROM (SELECT ev.project ->> 'id' AS v, min(ev.r) AS r FROM ev
                                 WHERE (ev.project ->> 'id') ~ '\S' GROUP BY 1) AS f),
           'workspaces', (SELECT coalesce(jsonb_agg(f.v ORDER BY f.r), '[]'::jsonb)
                            FROM (SELECT ev.project ->> 'workspace' AS v, min(ev.r) AS r FROM ev
                                   WHERE (ev.project ->> 'workspace') ~ '\S' GROUP BY 1) AS f),
           'plans', (SELECT coalesce(jsonb_agg(f.v ORDER BY f.r, f.n), '[]'::jsonb)
                       FROM (SELECT DISTINCT ON (p.v) p.v, p.r, p.n FROM plans p
                              WHERE p.v ~ '\S' ORDER BY p.v, p.r, p.n) AS f),
           'utterances', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                    'id', u.id, 'kind', u.kind, 'occurred_at', u.occurred_at,
                                    'text', CASE u.kind WHEN 'user_answer' THEN u.search_text ELSE u.content END)
                                  ORDER BY u.occurred_at, (u.source ->> 'event_id')::bigint, u.id), '[]'::jsonb)
                            FROM it u
                           WHERE u.class = 'utterance' AND u.kind IN ('user_prompt', 'user_answer') AND u.is_current),
           'has_utterance', EXISTS (SELECT 1 FROM it u WHERE u.class = 'utterance'),
           'statements', (SELECT coalesce(jsonb_agg(s.id ORDER BY s.occurred_at, s.created_at, s.id), '[]'::jsonb)
                            FROM it s WHERE s.class = 'mk_statement' AND s.is_current),
           'observations', (SELECT coalesce(jsonb_agg(o.id ORDER BY o.occurred_at, o.created_at, o.id), '[]'::jsonb)
                              FROM it o WHERE o.class = 'observation' AND o.is_current),
           'commits', (SELECT coalesce(jsonb_agg(jsonb_build_object('repo', k.payload ->> 'repo', 'sha', k.payload ->> 'sha',
                                                                   'occurred_at', k.occurred_at)
                                                 ORDER BY k.occurred_at, k.id), '[]'::jsonb)
                         FROM stored k WHERE k.type = 'git_commit'),
           'tool_refs', (SELECT coalesce(jsonb_agg(jsonb_build_object('repo', t.project_id, 'ref', x.v ->> 'ref',
                                                                     'occurred_at', t.occurred_at)
                                                   ORDER BY t.occurred_at, (t.source ->> 'event_id')::bigint, t.id, x.n), '[]'::jsonb)
                           FROM it t
                          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.source -> 'tools') = 'array'
                                                                       THEN t.source -> 'tools' ELSE '[]'::jsonb END)
                                     WITH ORDINALITY AS x(v, n)
                          WHERE t.class = 'utterance' AND t.kind = 'assistant_turn' AND t.is_current
                            AND jsonb_typeof(x.v) = 'object'
                            AND ((x.v ->> 'ref') ~ '^[a-f0-9]{7,40}$'
                                 OR (x.v ->> 'ref') ~ '^https://github\.com/[^/]+/[^/]+/pull/[0-9]+$')),
           'ledger', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                'plan', k.payload ->> 'plan',
                                'id', CASE k.type WHEN 'ledger_decision' THEN k.payload ->> 'id'
                                                  ELSE concat_ws('/', k.payload ->> 'phase', k.payload ->> 'task') END)
                              ORDER BY k.occurred_at, k.id), '[]'::jsonb)
                        FROM stored k WHERE k.type IN ('ledger_decision', 'ledger_ruling')),
           'current_index', (SELECT jsonb_build_object('id', x.id, 'content', x.content, 'occurred_at', x.occurred_at)
                               FROM it x
                              WHERE x.class = 'session_index' AND x.is_current
                              ORDER BY x.occurred_at DESC, x.created_at DESC, x.id DESC
                              LIMIT 1))
    INTO v_result;
  RETURN v_result;
END; $$;


--
-- Name: engram_session_index_commit(text, jsonb, bigint); Type: FUNCTION; Schema: public; Owner: -
--

-- Stores the index the builder rendered for session p_session from the
-- events up to p_event_id, in one transaction. p_item is null for a session
-- with no utterance, which gets no index; otherwise an object with exactly
-- content, occurred_at, project_id, workspace_id, lineage (the quoted MK
-- utterances), source ({type transcript or history, session_id, event_key
-- 'session_index:<session>:…', first_event_id, last_event_id}), listed (the
-- statement and observation ids the text names) and replaces (the current
-- index the text was rendered against, or null).
-- It takes the forget advisory key (7308892986227385959) exclusively, as
-- every function that locks item rows does, and then the session's row. The
-- rendered text is stale, and nothing is written, when the session's current
-- index is no longer replaces, or its current statements and observations
-- are no longer listed: the session stays due and the next build reads them
-- again. An unchanged text writes no item. A changed text is inserted as a
-- session_index item (speaker system, trust 1, search text = content) with a
-- NULL embedding, and supersedes the current index through
-- engram_supersede_item. That rule wants the successor strictly later, so a
-- rebuild whose last event is no later than the current index's (a late
-- delivery, a commit that changed only the listed items) takes the current
-- index's time plus one microsecond. A key already stored on another item
-- raises. Then index_item_id is set and indexed_event_id raised to
-- p_event_id; it never moves back, so a slower build never undoes a newer
-- one. Returns {written, stale, item_id}.
CREATE OR REPLACE FUNCTION public.engram_session_index_commit(p_session text, p_item jsonb, p_event_id bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_last bigint;
  v_current record;
  v_item jsonb := CASE WHEN p_item = 'null'::jsonb THEN NULL ELSE p_item END;
  v_problem text;
  v_listed uuid[];
  v_actual uuid[];
  v_at timestamptz;
  v_new uuid;
  v_key_prefix text;
BEGIN
  IF p_session IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_session_index_commit: p_session is required';
  END IF;
  IF p_event_id IS NULL OR p_event_id < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_session_index_commit: p_event_id must be an event id';
  END IF;
  v_key_prefix := 'session_index:' || p_session || ':';
  IF v_item IS NOT NULL THEN
    IF jsonb_typeof(v_item) <> 'object' THEN
      v_problem := 'p_item must be a JSON object or null';
    ELSIF EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) AS k(key)
                   WHERE k.key NOT IN ('content', 'occurred_at', 'project_id', 'workspace_id', 'lineage', 'source',
                                       'listed', 'replaces'))
          OR (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 8 THEN
      v_problem := 'p_item must have exactly the keys content, occurred_at, project_id, workspace_id, lineage, source, listed and replaces';
    ELSIF jsonb_typeof(v_item -> 'content') <> 'string' OR jsonb_typeof(v_item -> 'occurred_at') <> 'string'
          OR jsonb_typeof(v_item -> 'lineage') <> 'array' OR jsonb_typeof(v_item -> 'listed') <> 'array'
          OR jsonb_typeof(v_item -> 'source') <> 'object'
          OR jsonb_typeof(v_item -> 'project_id') NOT IN ('string', 'null')
          OR jsonb_typeof(v_item -> 'workspace_id') NOT IN ('string', 'null')
          OR jsonb_typeof(v_item -> 'replaces') NOT IN ('string', 'null') THEN
      v_problem := 'p_item has a value of the wrong type';
    ELSIF (v_item -> 'source' ->> 'session_id') IS DISTINCT FROM p_session
          OR (v_item -> 'source' ->> 'type') NOT IN ('transcript', 'history')
          OR left(coalesce(v_item -> 'source' ->> 'event_key', ''), char_length(v_key_prefix)) <> v_key_prefix THEN
      v_problem := 'p_item.source must name the session, its type and a session_index event key';
    END IF;
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_session_index_commit: ' || v_problem;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(7308892986227385959);
  SELECT s.last_event_id INTO v_last
    FROM public.memory_session_state s
   WHERE s.session_id = p_session
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_session_index_commit: p_session names no captured session';
  END IF;
  IF p_event_id > v_last THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_session_index_commit: p_event_id is later than the session''s last event';
  END IF;

  SELECT i.id, i.content, i.occurred_at INTO v_current
    FROM public.memory_items i
   WHERE i.session_id = p_session AND i.class = 'session_index'
     AND i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL
   ORDER BY i.occurred_at DESC, i.created_at DESC, i.id DESC
   LIMIT 1;

  IF v_item IS NULL THEN
    UPDATE public.memory_session_state s
       SET index_item_id = v_current.id,
           indexed_event_id = greatest(s.indexed_event_id, p_event_id)
     WHERE s.session_id = p_session;
    RETURN jsonb_build_object('written', false, 'stale', false, 'item_id', v_current.id);
  END IF;

  v_listed := ARRAY(SELECT DISTINCT (x.v #>> '{}')::uuid FROM jsonb_array_elements(v_item -> 'listed') AS x(v) ORDER BY 1);
  v_actual := ARRAY(SELECT i.id
                      FROM public.memory_items i
                     WHERE i.session_id = p_session AND i.class IN ('mk_statement', 'observation')
                       AND i.superseded_by IS NULL AND i.retired_at IS NULL AND i.forgotten_at IS NULL
                     ORDER BY 1);
  IF (v_item ->> 'replaces')::uuid IS DISTINCT FROM v_current.id OR v_listed <> v_actual THEN
    RETURN jsonb_build_object('written', false, 'stale', true, 'item_id', v_current.id);
  END IF;

  IF v_current.id IS NOT NULL AND v_current.content = (v_item ->> 'content') THEN
    UPDATE public.memory_session_state s
       SET index_item_id = v_current.id,
           indexed_event_id = greatest(s.indexed_event_id, p_event_id)
     WHERE s.session_id = p_session;
    RETURN jsonb_build_object('written', false, 'stale', false, 'item_id', v_current.id);
  END IF;

  v_at := (v_item ->> 'occurred_at')::timestamptz;
  IF v_current.id IS NOT NULL AND v_at <= v_current.occurred_at THEN
    v_at := v_current.occurred_at + interval '1 microsecond';
  END IF;
  INSERT INTO public.memory_items AS m (
    class, kind, speaker, trust, project_id, workspace_id, session_id,
    content, search_text, occurred_at, source, lineage)
  VALUES ('session_index', 'session', 'system', 1, v_item ->> 'project_id', v_item ->> 'workspace_id', p_session,
          v_item ->> 'content', v_item ->> 'content', v_at, v_item -> 'source',
          ARRAY(SELECT (x.v #>> '{}')::uuid FROM jsonb_array_elements(v_item -> 'lineage') WITH ORDINALITY AS x(v, n) ORDER BY x.n))
  ON CONFLICT ((source ->> 'event_key')) WHERE (source ? 'event_key') DO NOTHING
  RETURNING m.id INTO v_new;
  IF v_new IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'engram_session_index_commit: the index key is already stored on another item';
  END IF;
  IF v_current.id IS NOT NULL THEN
    PERFORM public.engram_supersede_item(v_current.id, v_new);
  END IF;
  -- The lineage check is deferred to commit; forcing it here fails this call
  -- with its own message instead of at the end of the transaction.
  SET CONSTRAINTS ALL IMMEDIATE;

  UPDATE public.memory_session_state s
     SET index_item_id = v_new,
         indexed_event_id = greatest(s.indexed_event_id, p_event_id)
   WHERE s.session_id = p_session;
  RETURN jsonb_build_object('written', true, 'stale', false, 'item_id', v_new);
END; $$;


--
-- Name: engram_invariant_counts(); Type: FUNCTION; Schema: public; Owner: -
--

-- Violations of the item invariants that can be counted in SQL, one row each,
-- in this order; every invariant holds when all are zero. The CHECKs and
-- triggers refuse these writes, so a non-zero count means a writer bypassed
-- them (a superuser, or triggers disabled by session_replication_role).
-- - assistant_authored_mk_claims: mk_statements not spoken by MK, and ledger
--   decisions attributed to MK (source.by = 'mk') without a non-blank
--   source.quote and source.quote_source.
-- - quote_not_in_lineage: mk_statements whose content does not occur, under
--   the quote rule, in an utterance spoken by MK in their lineage.
-- - lineage_to_forgotten: live items with a forgotten item in their lineage.
-- - utterance_time_mismatch: utterances whose source.event_id names a capture
--   event with a different occurred_at, plus transcript and history
--   utterances with no such event. event_id is cast only when it is 1 to 18
--   digits, so a malformed or oversized value counts as no event instead of
--   failing the count.
-- - unregistered_project: items whose project_id is not a registered project,
--   or whose workspace_id is not a registered workspace.
-- Forgotten items are counted too, except where the invariant is about live
-- items: forgetting hides an item, it does not make a broken row valid.
CREATE OR REPLACE FUNCTION public.engram_invariant_counts() RETURNS TABLE(name text, violations bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT v.name, v.violations
    FROM (VALUES
      (1, 'assistant_authored_mk_claims', (
        SELECT count(*)
          FROM public.memory_items i
         WHERE (i.class = 'mk_statement' AND i.speaker <> 'mk')
            OR (i.class = 'artifact' AND i.kind = 'ledger_decision'
                AND (i.source ->> 'by') IS NOT DISTINCT FROM 'mk'
                AND (coalesce(i.source ->> 'quote', '') !~ '\S' OR coalesce(i.source ->> 'quote_source', '') !~ '\S')))),
      (2, 'quote_not_in_lineage', (
        SELECT count(*)
          FROM public.memory_items s
         WHERE s.class = 'mk_statement'
           AND NOT EXISTS (
             SELECT 1
               FROM public.memory_items u
              WHERE u.id = ANY (s.lineage)
                AND u.class = 'utterance'
                AND u.speaker = 'mk'
                AND public.engram_norm_quote(s.content) <> ''
                AND strpos(public.engram_norm_quote(u.content), public.engram_norm_quote(s.content)) > 0))),
      (3, 'lineage_to_forgotten', (
        SELECT count(*)
          FROM public.memory_items i
         WHERE i.forgotten_at IS NULL
           AND EXISTS (
             SELECT 1 FROM public.memory_items l
              WHERE l.id = ANY (i.lineage) AND l.forgotten_at IS NOT NULL))),
      (4, 'utterance_time_mismatch', (
        SELECT count(*)
          FROM public.memory_items u
          LEFT JOIN public.memory_capture_events e
            ON e.id = CASE WHEN (u.source ->> 'event_id') ~ '^[0-9]{1,18}$' THEN (u.source ->> 'event_id')::bigint END
         WHERE u.class = 'utterance'
           AND ((e.id IS NOT NULL AND e.occurred_at <> u.occurred_at)
                OR (e.id IS NULL AND (u.source ->> 'type') IN ('transcript', 'history'))))),
      (5, 'unregistered_project', (
        SELECT count(*)
          FROM public.memory_items i
         WHERE (i.project_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM public.memory_projects p WHERE p.id = i.project_id AND p.kind = 'project'))
            OR (i.workspace_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM public.memory_projects w WHERE w.id = i.workspace_id AND w.kind = 'workspace'))))
    ) AS v(ord, name, violations)
   ORDER BY v.ord
$$;


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
-- Name: sensory_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sensory_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_subjects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_extraction_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_extraction_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_projects ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_items ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_item_entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_item_entities ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_item_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_item_links ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_session_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_session_state ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_capture_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_capture_events ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_capture_event_counts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_capture_event_counts ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_secret_hits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_secret_hits ENABLE ROW LEVEL SECURITY;

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
-- Name: sensory_snapshots service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.sensory_snapshots;
CREATE POLICY service_role_all ON public.sensory_snapshots TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_subjects service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_subjects;
CREATE POLICY service_role_all ON public.memory_subjects TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_extraction_runs service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_extraction_runs;
CREATE POLICY service_role_all ON public.memory_extraction_runs TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_projects service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_projects;
CREATE POLICY service_role_all ON public.memory_projects TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_items service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_items;
CREATE POLICY service_role_all ON public.memory_items TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_item_entities service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_item_entities;
CREATE POLICY service_role_all ON public.memory_item_entities TO service_role USING (true) WITH CHECK (true);

--
-- Name: memory_item_links service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_item_links;
CREATE POLICY service_role_all ON public.memory_item_links TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_session_state service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_session_state;
CREATE POLICY service_role_all ON public.memory_session_state TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_capture_events service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_capture_events;
CREATE POLICY service_role_all ON public.memory_capture_events TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_capture_event_counts service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_capture_event_counts;
CREATE POLICY service_role_all ON public.memory_capture_event_counts TO service_role USING (true) WITH CHECK (true);


--
-- Name: memory_secret_hits service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_secret_hits;
CREATE POLICY service_role_all ON public.memory_secret_hits TO service_role USING (true) WITH CHECK (true);


--
-- Item store table privileges, identical on every database.
--
-- A fresh database grants a new table to no role but its owner, while the
-- production database's default privileges give service_role every table
-- privilege, DELETE and TRUNCATE included, and UPDATE on sequences. So all
-- privileges are revoked from PUBLIC, service_role, anon and authenticated
-- first, then service_role gets back SELECT and nothing else: no INSERT,
-- UPDATE, DELETE or TRUNCATE on the tables and nothing on the three id
-- sequences. Every write goes through the engram_* RPCs, which run as the
-- owner, so the rules each RPC applies (idempotent inserts, forgets that
-- cascade under one lock order, supersession only to a later live item) hold
-- for every API write instead of being repeated for direct table writes.
-- Items are never deleted: forgetting is a tombstone. Re-applying the file
-- repeats the revoke, so a grant added by hand does not survive the next
-- apply.
--

REVOKE ALL ON TABLE public.memory_subjects, public.memory_extraction_runs, public.memory_projects, public.memory_items, public.memory_item_entities, public.memory_item_links, public.memory_session_state, public.memory_capture_events, public.memory_capture_event_counts, public.memory_secret_hits FROM PUBLIC, service_role;
REVOKE ALL ON SEQUENCE public.memory_capture_events_id_seq, public.memory_capture_event_counts_id_seq, public.memory_secret_hits_id_seq, public.memory_item_links_id_seq FROM PUBLIC, service_role;

-- anon and authenticated exist on Supabase and on installs that followed the
-- self-host runbook; a database without them has nothing to revoke.
DO $$
DECLARE
  role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.memory_subjects, public.memory_extraction_runs, public.memory_projects, public.memory_items, public.memory_item_entities, public.memory_item_links, public.memory_session_state, public.memory_capture_events, public.memory_capture_event_counts, public.memory_secret_hits FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.memory_capture_events_id_seq, public.memory_capture_event_counts_id_seq, public.memory_secret_hits_id_seq, public.memory_item_links_id_seq FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT ON TABLE public.memory_subjects TO service_role;
GRANT SELECT ON TABLE public.memory_extraction_runs TO service_role;
GRANT SELECT ON TABLE public.memory_projects TO service_role;
GRANT SELECT ON TABLE public.memory_items TO service_role;
GRANT SELECT ON TABLE public.memory_item_entities TO service_role;
GRANT SELECT ON TABLE public.memory_item_links TO service_role;
GRANT SELECT ON TABLE public.memory_capture_events TO service_role;
GRANT SELECT ON TABLE public.memory_capture_event_counts TO service_role;
GRANT SELECT ON TABLE public.memory_secret_hits TO service_role;
GRANT SELECT ON TABLE public.memory_session_state TO service_role;


--
-- Post-apply smoke (no migration runner exists to enforce column-before-function
-- ordering). Executes every recall RPC + the forget primitive against the just-
-- applied schema so a missing forgotten_at column or a broken gate fails HERE: it
-- aborts the apply under `psql -v ON_ERROR_STOP=1`, and otherwise surfaces as a
-- loud ERROR line in the apply log. Read-only except engram_mark_forgotten and the
-- item forget, retire and unretire RPCs on the nil UUID (match nothing, write
-- nothing). Idempotent and safe to re-run. All
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
  PERFORM public.engram_text_match(ARRAY['smoke', 'aca-2613'], 1);
  PERFORM public.engram_vector_search(v_unit, 1);
  PERFORM public.engram_text_match(ARRAY['smoke'], 1, NULL, NULL, ARRAY['note', 'digest', 'fact', 'procedure'], 'smoke');
  PERFORM public.engram_vector_search(v_unit, 1, NULL, NULL, ARRAY['note', 'digest', 'fact', 'procedure'], 'smoke');
  v_n := public.engram_mark_forgotten('episode', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  v_n := public.engram_mark_forgotten('semantic', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  v_n := public.engram_mark_forgotten('procedural', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  PERFORM * FROM public.engram_invariant_counts();
  PERFORM * FROM public.engram_forget_items(ARRAY['00000000-0000-0000-0000-000000000000']::uuid[], 'smoke');
  PERFORM * FROM public.engram_retire_items(ARRAY['00000000-0000-0000-0000-000000000000']::uuid[], 'smoke');
  PERFORM * FROM public.engram_unretire_items(ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  RAISE NOTICE 'engram schema smoke OK: 5 recall RPCs + engram_mark_forgotten callable; forgotten_at gate live; item forget, retire, unretire and invariant counts callable';
END;
$smoke$;


--
-- Function privileges: EXECUTE for service_role only.
--
-- PostgREST serves schema public and runs every request without a JWT as the
-- anon role, so any function in public that anon may execute is callable as
-- /rpc/<name> by anyone who can reach PostgREST. Postgres grants EXECUTE on a
-- new function to PUBLIC, and on Supabase default privileges also grant it to
-- anon and authenticated. The engram_* functions are SECURITY DEFINER: they
-- run as their owner, past RLS, and return memory content or tombstone,
-- decay and re-weight memories. Clients authenticate with the service-role
-- key, so EXECUTE is revoked from PUBLIC, anon and authenticated and granted
-- to service_role explicitly, which also covers a database whose default
-- privileges grant service_role nothing. Functions that are dropped and
-- re-created above lose their grants on every apply, so this section runs
-- after the last function definition and re-applying the file restores it.
--
-- Every function below except the trigger functions (memory_items_*,
-- memory_capture_events_* and engram_track_session_activity) is an RPC
-- endpoint and gets the service_role grant. The trigger functions are revoked
-- from service_role as well and granted to no role, so a database whose
-- default privileges give service_role EXECUTE on new functions ends with the
-- same privileges as a fresh one. PostgreSQL checks EXECUTE on a trigger function only
-- when CREATE TRIGGER binds it, never when the trigger fires, so every
-- writer's INSERT and UPDATE still runs them, and a grant would only make them
-- callable by name. engram_episode_kind is read by the
-- search functions and by idx_episodes_kind, and an INSERT into
-- memory_episodes evaluates it as the inserting role, so service_role needs
-- its grant to write episodes. match_episodes and match_digests
-- are SECURITY INVOKER, kept for adapters on the pre-recall-RPC schema.
--

REVOKE EXECUTE ON FUNCTION public.engram_association_walk(uuid[], integer, double precision, integer, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_decay_pass(double precision, double precision, integer, integer, double precision, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_decay_semantic_gradient(uuid[], double precision[], integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_digest_fact_failure(uuid, boolean, timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_episode_kind(jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_forget_items(uuid[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_insert_items(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_invariant_counts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_retire_items(uuid[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_supersede_item(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_capture_ingest(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_capture_materialize(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_items_pending_embedding(integer, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_items_renew_embedding_claims(uuid[], uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_items_set_embeddings(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_items_record_embedding_failures(jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_items_embedding_failed_count() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_items_reset_embedding_failures(uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_sync_projects(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_unretire_items(uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_run_state(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_turn_groups(text, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_pending(text, integer, integer, timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_window(uuid, integer, integer, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_candidates(uuid, jsonb, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_plan_slug(text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_in_scope(public.memory_items, public.memory_items, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_subject_current(public.memory_items, text, uuid, text, text, boolean, timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_begin(uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_fail(uuid, text, text, boolean, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_apply(uuid, jsonb, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_commit(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_due_sessions(integer, integer, timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_sessions(text, timestamp with time zone, integer, timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_session_anchors(text, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_extraction_replace(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_session_index_source(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_session_index_commit(text, jsonb, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_norm_quote(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_time_in_range(timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_times_in_range(timestamp with time zone[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_text_boost(text, integer, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_text_match(text[], integer, text, text, text[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_upsert_co_recalled(uuid, text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_vector_search(public.vector, integer, text, text, text[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.match_digests(text, integer, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.match_episodes(text, integer, double precision, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.memory_items_before_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.memory_items_before_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.memory_items_forget_cascade() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.memory_items_lineage() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.memory_items_supersession() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_track_session_activity() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.memory_capture_events_count() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.memory_items_before_insert() FROM service_role;
REVOKE EXECUTE ON FUNCTION public.memory_items_before_update() FROM service_role;
REVOKE EXECUTE ON FUNCTION public.memory_items_forget_cascade() FROM service_role;
REVOKE EXECUTE ON FUNCTION public.memory_items_lineage() FROM service_role;
REVOKE EXECUTE ON FUNCTION public.memory_items_supersession() FROM service_role;
REVOKE EXECUTE ON FUNCTION public.engram_track_session_activity() FROM service_role;
REVOKE EXECUTE ON FUNCTION public.memory_capture_events_count() FROM service_role;

-- anon and authenticated exist on Supabase and on installs that followed the
-- self-host runbook; a database without them has nothing to revoke.
DO $$
DECLARE
  role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_association_walk(uuid[], integer, double precision, integer, text[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_decay_pass(double precision, double precision, integer, integer, double precision, integer) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_decay_semantic_gradient(uuid[], double precision[], integer) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_digest_fact_failure(uuid, boolean, timestamp with time zone) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_episode_kind(jsonb, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_forget_items(uuid[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_insert_items(jsonb) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_invariant_counts() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_retire_items(uuid[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_supersede_item(uuid, uuid) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_capture_ingest(jsonb) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_capture_materialize(integer) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_items_pending_embedding(integer, uuid) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_items_renew_embedding_claims(uuid[], uuid) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_items_set_embeddings(jsonb) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_items_record_embedding_failures(jsonb, uuid) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_items_embedding_failed_count() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_items_reset_embedding_failures(uuid[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_sync_projects(jsonb) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_unretire_items(uuid[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_run_state(text, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_turn_groups(text, text, boolean) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_pending(text, integer, integer, timestamp with time zone) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_window(uuid, integer, integer, text, boolean) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_candidates(uuid, jsonb, integer) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_plan_slug(text[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_in_scope(public.memory_items, public.memory_items, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_subject_current(public.memory_items, text, uuid, text, text, boolean, timestamp with time zone) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_begin(uuid, text, text, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_fail(uuid, text, text, boolean, jsonb) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_apply(uuid, jsonb, text[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_commit(uuid, jsonb) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_due_sessions(integer, integer, timestamp with time zone) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_sessions(text, timestamp with time zone, integer, timestamp with time zone) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_session_anchors(text, text, boolean) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_extraction_replace(uuid, jsonb) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_session_index_source(text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_session_index_commit(text, jsonb, bigint) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_norm_quote(text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_time_in_range(timestamp with time zone) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_times_in_range(timestamp with time zone[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_text_boost(text, integer, text, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_text_match(text[], integer, text, text, text[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_upsert_co_recalled(uuid, text, uuid, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_vector_search(public.vector, integer, text, text, text[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.match_digests(text, integer, double precision) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.match_episodes(text, integer, double precision, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.memory_items_before_insert() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.memory_items_before_update() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.memory_items_forget_cascade() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.memory_items_lineage() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.memory_items_supersession() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_track_session_activity() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.memory_capture_events_count() FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.engram_association_walk(uuid[], integer, double precision, integer, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_decay_pass(double precision, double precision, integer, integer, double precision, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_decay_semantic_gradient(uuid[], double precision[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_digest_fact_failure(uuid, boolean, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_episode_kind(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_forget_items(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_insert_items(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_invariant_counts() TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_retire_items(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_supersede_item(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_capture_ingest(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_capture_materialize(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_items_pending_embedding(integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_items_renew_embedding_claims(uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_items_set_embeddings(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_items_record_embedding_failures(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_items_embedding_failed_count() TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_items_reset_embedding_failures(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_sync_projects(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_unretire_items(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_run_state(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_turn_groups(text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_pending(text, integer, integer, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_window(uuid, integer, integer, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_candidates(uuid, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_plan_slug(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_in_scope(public.memory_items, public.memory_items, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_subject_current(public.memory_items, text, uuid, text, text, boolean, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_begin(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_fail(uuid, text, text, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_apply(uuid, jsonb, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_commit(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_due_sessions(integer, integer, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_sessions(text, timestamp with time zone, integer, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_session_anchors(text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_extraction_replace(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_session_index_source(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_session_index_commit(text, jsonb, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_norm_quote(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_time_in_range(timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_times_in_range(timestamp with time zone[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_text_boost(text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_text_match(text[], integer, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_upsert_co_recalled(uuid, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_vector_search(public.vector, integer, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_digests(text, integer, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_episodes(text, integer, double precision, text) TO service_role;


--
-- PostgreSQL database dump complete
--


