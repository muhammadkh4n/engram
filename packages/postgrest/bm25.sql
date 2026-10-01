-- =============================================================================
-- Engram — optional BM25 lexical ranking (pg_textsearch)
-- =============================================================================
--
-- Apply via:   psql -U postgres -d engram -v ON_ERROR_STOP=1 -1 -f bm25.sql
--
-- Optional. Requires the pg_textsearch extension (>= 1.0) on PostgreSQL 17 or
-- 18, loaded at server start with shared_preload_libraries = 'pg_textsearch'.
-- On a server without the library CREATE EXTENSION fails and nothing else in
-- this file is applied.
--
-- Apply after schema.sql: the indexes and the function read the memory tables
-- it creates. Then run NOTIFY pgrst, 'reload schema' so PostgREST exposes
-- engram_bm25_match, and restart the engram service: the adapter checks for
-- the function once at startup and keeps that lexical mode until restarted.
--
-- Idempotent and safe to re-apply: CREATE EXTENSION IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION.
--
-- Like schema.sql, this file contains no psql meta-commands, so any psql
-- client version and SQL editors can run it as plain SQL.
--
-- Removal:   DROP EXTENSION pg_textsearch CASCADE;
-- drops the BM25 indexes and engram_bm25_match with it. After a service
-- restart the adapter falls back to engram_text_match (ts_rank_cd) from
-- schema.sql. Drop the extension before moving to an image without the
-- library: inserts into a table that carries a BM25 index fail once the
-- library is missing.
--

CREATE EXTENSION IF NOT EXISTS pg_textsearch;


--
-- BM25 indexes, one per tier.
--
-- Each index covers the same text as that tier's fts generated column in
-- schema.sql, with the same 'english' configuration. BM25 term statistics
-- (document count, document frequency, average length) are kept per index,
-- so each index predicate equals the filter recall applies to that tier:
-- tombstoned and superseded rows never inflate or dilute the statistics of
-- the rows recall can return. Default BM25 parameters (k1 = 1.2, b = 0.75).
--

CREATE INDEX IF NOT EXISTS idx_episodes_bm25 ON public.memory_episodes
  USING bm25 (content) WITH (text_config = 'english')
  WHERE forgotten_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_digests_bm25 ON public.memory_digests
  USING bm25 (summary) WITH (text_config = 'english');

CREATE INDEX IF NOT EXISTS idx_semantic_bm25 ON public.memory_semantic
  USING bm25 ((topic || ' ' || content)) WITH (text_config = 'english')
  WHERE forgotten_at IS NULL AND superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_procedural_bm25 ON public.memory_procedural
  USING bm25 ((trigger_text || ' ' || procedure)) WITH (text_config = 'english')
  WHERE forgotten_at IS NULL;


--
-- Name: engram_bm25_match(text[], integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

-- BM25 counterpart of engram_text_match, with the same signature and result
-- shape so the adapter can call either one. The terms are joined into one
-- query text; pg_textsearch tokenises it with the index's 'english'
-- configuration and sums the per-term scores (OR semantics), weighting each
-- term by its inverse document frequency in that tier.
--
-- Each tier is an ordered subquery whose ORDER BY ... <@> ... LIMIT the
-- planner serves from that tier's BM25 index. to_bm25query names the index
-- because the indexes are partial. <@> yields a negative score (lower is a
-- better match), so rank_score is its negation and higher is better, as with
-- ts_rank_cd. The rank_score > 0 filter sits outside the ordered subqueries:
-- inside them a score predicate would force standalone scoring of every row
-- (a sequential scan), and outside it only drops non-matching rows if the
-- planner ever scores without the index. A subquery with LIMIT is never a
-- target of qual pushdown, so the filter stays where it is written.
--
-- An empty or NULL p_terms returns no rows. p_project_id is accepted for
-- caller compatibility and filters nothing: a project tag only ranks rows (in
-- the client), it never excludes them.
CREATE OR REPLACE FUNCTION public.engram_bm25_match(p_terms text[], p_match_count integer DEFAULT 30, p_session_id text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, rank_score double precision)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT id, memory_type, rank_score FROM (
    SELECT * FROM (
      SELECT me.id, 'episode'::text AS memory_type,
        -(me.content <@> to_bm25query(array_to_string(p_terms, ' '), 'idx_episodes_bm25'))::float AS rank_score
      FROM memory_episodes me
      WHERE cardinality(p_terms) > 0
        AND me.forgotten_at IS NULL
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
      ORDER BY me.content <@> to_bm25query(array_to_string(p_terms, ' '), 'idx_episodes_bm25')
      LIMIT p_match_count
    ) episodes

    UNION ALL

    SELECT * FROM (
      SELECT md.id, 'digest'::text AS memory_type,
        -(md.summary <@> to_bm25query(array_to_string(p_terms, ' '), 'idx_digests_bm25'))::float AS rank_score
      FROM memory_digests md
      WHERE cardinality(p_terms) > 0
      ORDER BY md.summary <@> to_bm25query(array_to_string(p_terms, ' '), 'idx_digests_bm25')
      LIMIT p_match_count
    ) digests

    UNION ALL

    SELECT * FROM (
      SELECT ms.id, 'semantic'::text AS memory_type,
        -((ms.topic || ' ' || ms.content) <@> to_bm25query(array_to_string(p_terms, ' '), 'idx_semantic_bm25'))::float AS rank_score
      FROM memory_semantic ms
      WHERE cardinality(p_terms) > 0
        AND ms.forgotten_at IS NULL
        AND ms.superseded_by IS NULL
      ORDER BY (ms.topic || ' ' || ms.content) <@> to_bm25query(array_to_string(p_terms, ' '), 'idx_semantic_bm25')
      LIMIT p_match_count
    ) semantic

    UNION ALL

    SELECT * FROM (
      SELECT mp.id, 'procedural'::text AS memory_type,
        -((mp.trigger_text || ' ' || mp.procedure) <@> to_bm25query(array_to_string(p_terms, ' '), 'idx_procedural_bm25'))::float AS rank_score
      FROM memory_procedural mp
      WHERE cardinality(p_terms) > 0
        AND mp.forgotten_at IS NULL
      ORDER BY (mp.trigger_text || ' ' || mp.procedure) <@> to_bm25query(array_to_string(p_terms, ' '), 'idx_procedural_bm25')
      LIMIT p_match_count
    ) procedural
  ) combined
  WHERE rank_score > 0
  ORDER BY rank_score DESC
  LIMIT p_match_count
$$;

-- A LANGUAGE sql body records no dependency on to_bm25query or <@>, so this
-- declares one: DROP EXTENSION pg_textsearch then removes the function too,
-- and the service falls back to engram_text_match instead of finding a
-- function whose every call fails. Re-applying adds no second dependency.
ALTER FUNCTION public.engram_bm25_match(text[], integer, text, text) DEPENDS ON EXTENSION pg_textsearch;
