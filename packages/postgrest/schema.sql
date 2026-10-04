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
-- from it: PostgreSQL keeps no usable statistics for a partial expression
-- index, so the kind test is estimated with a default selectivity.
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
  PERFORM public.engram_text_match(ARRAY['smoke', 'aca-2613'], 1);
  PERFORM public.engram_vector_search(v_unit, 1);
  PERFORM public.engram_text_match(ARRAY['smoke'], 1, NULL, NULL, ARRAY['note', 'digest', 'fact', 'procedure'], 'smoke');
  PERFORM public.engram_vector_search(v_unit, 1, NULL, NULL, ARRAY['note', 'digest', 'fact', 'procedure'], 'smoke');
  v_n := public.engram_mark_forgotten('episode', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  v_n := public.engram_mark_forgotten('semantic', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  v_n := public.engram_mark_forgotten('procedural', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]);
  RAISE NOTICE 'engram schema smoke OK: 5 recall RPCs + engram_mark_forgotten callable; forgotten_at gate live';
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
-- Every function below is an RPC endpoint and gets the service_role grant;
-- this file defines no trigger functions. engram_episode_kind is read by the
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
REVOKE EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_text_boost(text, integer, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_text_match(text[], integer, text, text, text[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_upsert_co_recalled(uuid, text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_vector_search(public.vector, integer, text, text, text[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.match_digests(text, integer, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.match_episodes(text, integer, double precision, text) FROM PUBLIC;

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
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_text_boost(text, integer, text, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_text_match(text[], integer, text, text, text[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_upsert_co_recalled(uuid, text, uuid, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_vector_search(public.vector, integer, text, text, text[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.match_digests(text, integer, double precision) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.match_episodes(text, integer, double precision, text) FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.engram_association_walk(uuid[], integer, double precision, integer, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_decay_pass(double precision, double precision, integer, integer, double precision, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_decay_semantic_gradient(uuid[], double precision[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_digest_fact_failure(uuid, boolean, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_episode_kind(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_text_boost(text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_text_match(text[], integer, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_upsert_co_recalled(uuid, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_vector_search(public.vector, integer, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_digests(text, integer, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_episodes(text, integer, double precision, text) TO service_role;


--
-- PostgreSQL database dump complete
--


