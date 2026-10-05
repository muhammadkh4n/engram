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
-- Name: engram_all_finite(timestamp with time zone[]); Type: FUNCTION; Schema: public; Owner: -
--

-- True when no element of the array is infinity or -infinity. A CHECK
-- constraint cannot hold a subquery, so memory_items_finite_check reaches the
-- restated_at elements through this function. It must exist before the
-- tables whose CHECKs call it. pg_catalog-qualified and without a SET clause,
-- like engram_norm_quote.
CREATE OR REPLACE FUNCTION public.engram_all_finite(p_times timestamp with time zone[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(p_times) AS t(v) WHERE NOT pg_catalog.isfinite(t.v))
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
    CONSTRAINT memory_subjects_label_check CHECK (label ~ '\S' AND char_length(label) <= 200)
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
    CONSTRAINT memory_extraction_runs_extractor_version_check CHECK (extractor_version ~ '\S' AND char_length(extractor_version) <= 64),
    CONSTRAINT memory_extraction_runs_status_check CHECK (status IN ('running', 'succeeded', 'failed'))
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
    CONSTRAINT memory_items_finite_check CHECK (isfinite(occurred_at)
        AND (valid_to IS NULL OR isfinite(valid_to))
        AND (retired_at IS NULL OR isfinite(retired_at))
        AND (forgotten_at IS NULL OR isfinite(forgotten_at))
        AND public.engram_all_finite(restated_at))
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
    CONSTRAINT memory_capture_events_finite_check CHECK (isfinite(occurred_at))
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
    CONSTRAINT memory_secret_hits_text_check CHECK (target_id ~ '\S' AND field ~ '\S' AND detector ~ '\S' AND (secret_name IS NULL OR secret_name ~ '\S'))
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
CREATE INDEX IF NOT EXISTS idx_capture_events_pending ON public.memory_capture_events USING btree (occurred_at, id) WHERE (processed_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_capture_events_session ON public.memory_capture_events USING btree (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_session ON public.memory_extraction_runs USING btree (session_id, started_at);


--
-- Item store triggers. The CHECKs on memory_items see one row at a time; the
-- rules below need other rows or the previous version of a row, so triggers
-- hold them, for every writer: the RPCs and a direct PostgREST request alike.
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

-- content_hash, created_at and valid_to belong to the database: whatever a
-- writer sends is replaced, so the hash always matches the stored content and
-- valid_to is the successor's occurred_at while superseded_by is set, else
-- NULL. occurred_at never changes after insert, so that value cannot go stale.
-- A superseded_by naming no stored item leaves valid_to NULL, which
-- memory_items_supersession_check refuses at once.
CREATE OR REPLACE FUNCTION public.memory_items_before_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.content_hash := encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex');
  NEW.created_at := now();
  NEW.valid_to := (SELECT i.occurred_at FROM public.memory_items i WHERE i.id = NEW.superseded_by);
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
-- The lifecycle columns follow the same rules for a direct write as for the
-- RPCs, because service_role may UPDATE the table:
-- - superseded_by goes from NULL to an item only when that item exists, is
--   not forgotten, has the same class and occurred strictly later (pointing
--   at itself is left to memory_items_supersession_check).
-- - superseded_by moves from one item to another, or back to NULL, only when
--   the item it named is forgotten and the change comes from inside a trigger:
--   the forget cascade handing the supersession to the next live successor.
--   No other trigger updates memory_items, and a PostgREST client cannot add
--   one, so pg_trigger_depth() > 1 identifies the cascade; a session setting
--   could be set by any SQL client.
-- - a forgotten item's superseded_by, retired_at and retired_reason never
--   change again, and superseded_by does not change in the UPDATE that
--   forgets an item.
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
       AND (pg_trigger_depth() < 2
            OR NOT EXISTS (SELECT 1 FROM public.memory_items s
                            WHERE s.id = OLD.superseded_by AND s.forgotten_at IS NOT NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s: superseded_by is replaced or cleared only by the forget cascade', TG_NAME);
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
CREATE OR REPLACE FUNCTION public.memory_items_lineage() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row record;
  v_found integer := 0;
  v_quote text;
  v_quoted boolean := false;
BEGIN
  IF NEW.class = 'mk_statement' THEN
    v_quote := public.engram_norm_quote(NEW.content);
  END IF;
  FOR v_row IN
    SELECT i.class, i.speaker, i.content, i.forgotten_at
      FROM public.memory_items i
     WHERE i.id = ANY (NEW.lineage)
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
  IF v_found < (SELECT count(DISTINCT l.id) FROM unnest(NEW.lineage) AS l(id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('%s: lineage names an item that does not exist', TG_NAME);
  END IF;
  IF NEW.class = 'mk_statement' AND NOT v_quoted THEN
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
-- times along a chain also rule out a cycle. The row's current pointer is
-- checked rather than the one this event saw, because the forget cascade may
-- have moved it since. A forgotten item keeps the pointer it had when it was
-- forgotten. The target row stays locked FOR SHARE until the transaction ends.
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

-- Runs when forgotten_at goes from NULL to set, by any writer:
-- (a) every live item derived from this one, directly or through other live
--     items, is forgotten in one UPDATE with the same forgotten_at and the
--     reason "lineage: <id> forgotten", naming this item. Those updates fire
--     this trigger again, and it finds nothing live below them, so triggers
--     nest one level deep whatever the depth of the lineage. UNION, not
--     UNION ALL, ends the walk on a lineage cycle.
-- (b) every live item this one superseded is re-pointed to the nearest live
--     item further along the superseded_by chain, read now; when none remains
--     it is restored (superseded_by cleared). valid_to follows superseded_by
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
CREATE CONSTRAINT TRIGGER memory_items_supersession AFTER INSERT OR UPDATE OF superseded_by ON public.memory_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.superseded_by IS NOT NULL) EXECUTE FUNCTION public.memory_items_supersession();

DROP TRIGGER IF EXISTS memory_items_forget_cascade ON public.memory_items;
CREATE TRIGGER memory_items_forget_cascade AFTER UPDATE OF forgotten_at ON public.memory_items FOR EACH ROW WHEN (OLD.forgotten_at IS NULL AND NEW.forgotten_at IS NOT NULL) EXECUTE FUNCTION public.memory_items_forget_cascade();


--
-- Item store RPCs. Writers go through these instead of plain table writes
-- where a write needs more than one statement or must be idempotent: PostgREST
-- runs each request as one transaction, and its on_conflict names columns,
-- not the expression index on source->>'event_key'. Each is SECURITY DEFINER
-- with a fixed search_path and executable by service_role only. An invalid
-- argument raises SQLSTATE 22023 (invalid_parameter_value) and a refused rule
-- 23514 (check_violation), both with the message "<function name>: <reason>",
-- which names keys and positions but never quotes a value. The triggers above
-- still check every row these functions write.
--

--
-- Name: engram_insert_items(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

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
-- clock, not an event. source.event_key holds at most 512 characters, the
-- bound that keeps it inside a unique btree index row; a longer key is
-- refused here by position instead of failing the index. An object whose
-- source.event_key is already stored, or
-- appears earlier in the same call, is skipped and reported with the stored id
-- and inserted = false, so a retried delivery is a no-op. One row per object
-- comes back, in input order. The deferred lineage and supersession checks run at
-- the caller's commit, so a statement may come before the utterance it quotes
-- and one failing object fails them all.
CREATE OR REPLACE FUNCTION public.engram_insert_items(p_items jsonb) RETURNS TABLE(ord integer, id uuid, inserted boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count integer;
  v_problem text;
  v_ids uuid[];
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

  v_ids := ARRAY(
    SELECT coalesce((t.e ->> 'id')::uuid, gen_random_uuid())
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
     ORDER BY t.n);

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
           CASE WHEN jsonb_typeof(t.e -> 'lineage') = 'array'
                THEN ARRAY(SELECT l.value::uuid FROM jsonb_array_elements_text(t.e -> 'lineage') WITH ORDINALITY AS l(value, k) ORDER BY l.k)
                ELSE '{}'::uuid[] END,
           (t.e ->> 'extraction_run_id')::uuid
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
     ORDER BY t.n
    ON CONFLICT ((source ->> 'event_key')) WHERE (source ? 'event_key') DO NOTHING
    RETURNING m.id
  )
  SELECT coalesce(array_agg(a.id), '{}'::uuid[]) INTO v_inserted FROM added a;

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
  SELECT r.n::integer, r.item_id, r.added
    FROM unnest(v_result_ids, v_result_added) WITH ORDINALITY AS r(item_id, added, n)
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
-- engram_supersede_item holds the same key shared, so it waits for a forget
-- instead of deadlocking with it, and supersedes still run side by side.
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
-- it unretired.
CREATE OR REPLACE FUNCTION public.engram_unretire_items(p_ids uuid[]) RETURNS SETOF uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 50 OR array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_unretire_items: p_ids must hold 1 to 50 ids and no NULL';
  END IF;
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
-- class, p_new occurred strictly later, and p_old is not superseded by a third
-- item (replacing a successor is forgetting it). A missing or equal id is an
-- invalid argument (22023); a broken rule is refused (23514). Returns false
-- when p_old is already superseded by p_new; otherwise sets superseded_by, and
-- memory_items_before_update ends p_old's validity at p_new's event time.
-- Before locking a row it takes the forget advisory key
-- (7308892986227385959) shared: a running forget finishes first, so the two
-- never hold each other's rows, while supersedes do not block each other.
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

  PERFORM pg_advisory_xact_lock_shared(7308892986227385959);
  PERFORM 1 FROM public.memory_items i WHERE i.id IN (p_old, p_new) ORDER BY i.id FOR UPDATE;

  SELECT i.class, i.occurred_at, i.superseded_by, i.forgotten_at INTO v_old
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
-- Name: memory_capture_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_capture_events ENABLE ROW LEVEL SECURITY;

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
-- Name: memory_capture_events service_role_all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS service_role_all ON public.memory_capture_events;
CREATE POLICY service_role_all ON public.memory_capture_events TO service_role USING (true) WITH CHECK (true);


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
-- first, then service_role gets back what the item store needs: SELECT, INSERT
-- and UPDATE (memory_item_entities and memory_secret_hits are append-only:
-- SELECT and INSERT), and USAGE and SELECT on the two id sequences. Items are
-- never deleted through the API: forgetting is a tombstone, so only the owner
-- can DELETE or TRUNCATE. Re-applying the file repeats the revoke, so a grant
-- added by hand does not survive the next apply.
--

REVOKE ALL ON TABLE public.memory_subjects, public.memory_extraction_runs, public.memory_projects, public.memory_items, public.memory_item_entities, public.memory_capture_events, public.memory_secret_hits FROM PUBLIC, service_role;
REVOKE ALL ON SEQUENCE public.memory_capture_events_id_seq, public.memory_secret_hits_id_seq FROM PUBLIC, service_role;

-- anon and authenticated exist on Supabase and on installs that followed the
-- self-host runbook; a database without them has nothing to revoke.
DO $$
DECLARE
  role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.memory_subjects, public.memory_extraction_runs, public.memory_projects, public.memory_items, public.memory_item_entities, public.memory_capture_events, public.memory_secret_hits FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.memory_capture_events_id_seq, public.memory_secret_hits_id_seq FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON TABLE public.memory_subjects TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.memory_extraction_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.memory_projects TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.memory_items TO service_role;
GRANT SELECT, INSERT ON TABLE public.memory_item_entities TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.memory_capture_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.memory_secret_hits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.memory_capture_events_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.memory_secret_hits_id_seq TO service_role;


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
-- Every function below except the memory_items_* trigger functions is an RPC
-- endpoint and gets the service_role grant. The trigger functions are revoked
-- and granted to no role: PostgreSQL checks EXECUTE on a trigger function only
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
REVOKE EXECUTE ON FUNCTION public.engram_unretire_items(uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_norm_quote(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_all_finite(timestamp with time zone[]) FROM PUBLIC;
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
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_unretire_items(uuid[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_norm_quote(text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_all_finite(timestamp with time zone[]) FROM %I', role_name);
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
GRANT EXECUTE ON FUNCTION public.engram_unretire_items(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_hybrid_recall(text, public.vector, integer, double precision, double precision, integer, text, boolean, boolean, boolean, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_recall(public.vector, text, integer, double precision, boolean, boolean, boolean, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_record_access(uuid, text, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_record_shown(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_access_count_quantile(text, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_mark_forgotten(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_norm_quote(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_all_finite(timestamp with time zone[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_text_boost(text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_text_match(text[], integer, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_upsert_co_recalled(uuid, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_vector_search(public.vector, integer, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_digests(text, integer, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_episodes(text, integer, double precision, text) TO service_role;


--
-- PostgreSQL database dump complete
--


