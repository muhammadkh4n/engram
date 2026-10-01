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
-- Removal, in this order, each object named explicitly:
--
--   DROP INDEX public.idx_episodes_bm25;
--   DROP INDEX public.idx_digests_bm25;
--   DROP INDEX public.idx_semantic_bm25;
--   DROP INDEX public.idx_procedural_bm25;
--   DROP FUNCTION public.engram_bm25_match(text[], integer, text, text);
--   DROP EXTENSION pg_textsearch;
--
-- The last statement fails if anything else still uses the extension, and
-- that error is the signal to look, not to force the drop. After a service
-- restart the adapter falls back to engram_text_match (ts_rank_cd) from
-- schema.sql. Remove BM25 before moving to an image without the library:
-- inserts into a table that carries a BM25 index fail once the library is
-- missing.
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
-- shape so the adapter can call either one. It matches exactly the rows
-- engram_text_match matches and ranks them by BM25 instead of ts_rank_cd.
--
-- Matching. Each term becomes its own phraseto_tsquery('english', t), as in
-- engram_text_match, and a row matches when its fts column matches any of
-- them, under the same tier predicates. The 'english' parser splits an
-- identifier such as 'ACA-2432' into 'aca' and '-2432'; the phrase query
-- requires the two adjacent, so a row holding only 'aca' never matches.
-- pg_textsearch's own query cannot be the match step: it ORs the parts and
-- stores no positions, so short rows dense in 'aca' would outrank, and push
-- out, the rows that hold the identifier.
--
-- Candidates. The phrase match runs on each tier's GIN fts index. Scoring a
-- row with <@> outside a BM25 index scan tokenises its text again, at a cost
-- that grows with its length (about 0.2 ms for a 1.3 kB row), so scoring a
-- large match set whole would take seconds. Each tier therefore scores at
-- most candidate_cap rows. Every term ranks its own matches by
-- ts_rank_cd(fts, q, 2), which divides by the row's length and so orders
-- the way BM25 length normalisation does, and the candidates are taken
-- round-robin across terms: each term's best row first, then each term's
-- second, and so on. A rare term's rows are all kept while common terms
-- share what is left of the cap; ranking the whole match set by one
-- ts_rank_cd instead, which has no IDF, can drop the rare term's rows.
--
-- Scoring. A row is scored only on the terms it matches as phrases, so the
-- parts of an identifier it does not hold add nothing: a row matched by a
-- common word is not lifted by an 'aca' that belongs to other tickets. The
-- bare <@> expression is selected once per row and the tier is ordered by
-- that column. to_bm25query names the tier's index, whose term statistics
-- cover the rows recall may return. <@> yields a negative score (lower is a
-- better match), so rank_score is its negation and higher is better, as with
-- ts_rank_cd. Each tier keeps its best p_match_count rows; the LIMIT also
-- keeps the outer rank_score filter from being pushed into the tier, where
-- it would score every row a second time.
--
-- An empty or NULL p_terms, or terms that reduce to no lexemes, return no
-- rows. p_project_id is accepted for caller compatibility and filters
-- nothing: a project tag only ranks rows (in the client), it never excludes
-- them.
CREATE OR REPLACE FUNCTION public.engram_bm25_match(p_terms text[], p_match_count integer DEFAULT 30, p_session_id text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, rank_score double precision)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  WITH bounds AS (
    -- Rows each tier scores at most: over three times the 150 rows recall
    -- asks for, while a 5,000-row match set of 1.3 kB rows returns in about
    -- 80 ms (about 1 s when every match is scored).
    SELECT 500 AS candidate_cap
  ),
  term_queries AS (
    SELECT t, phraseto_tsquery('english', t) AS q
    FROM unnest(p_terms) AS t
  ),
  match_terms AS (
    SELECT t, q
    FROM term_queries
    WHERE numnode(q) > 0
  )
  SELECT id, memory_type, rank_score FROM (
    SELECT id, memory_type, -bm25_score::float AS rank_score FROM (
      SELECT * FROM (
        SELECT me.id, 'episode'::text AS memory_type,
          me.content <@> to_bm25query(array_to_string(ARRAY(
            SELECT mt.t FROM match_terms mt WHERE me.fts @@ mt.q), ' '), 'idx_episodes_bm25') AS bm25_score
        FROM memory_episodes me
        WHERE me.id IN (
          SELECT c.id
          FROM match_terms mt CROSS JOIN LATERAL (
            SELECT e.id, row_number() OVER (ORDER BY ts_rank_cd(e.fts, mt.q, 2) DESC) AS term_rank
            FROM memory_episodes e
            WHERE e.fts @@ mt.q
              AND e.forgotten_at IS NULL
              AND (p_session_id IS NULL OR e.session_id = p_session_id)
            LIMIT (SELECT candidate_cap FROM bounds)
          ) c
          GROUP BY c.id
          ORDER BY min(c.term_rank)
          LIMIT (SELECT candidate_cap FROM bounds)
        )
        ORDER BY bm25_score
        LIMIT p_match_count
      ) episodes

      UNION ALL

      SELECT * FROM (
        SELECT md.id, 'digest'::text AS memory_type,
          md.summary <@> to_bm25query(array_to_string(ARRAY(
            SELECT mt.t FROM match_terms mt WHERE md.fts @@ mt.q), ' '), 'idx_digests_bm25') AS bm25_score
        FROM memory_digests md
        WHERE md.id IN (
          SELECT c.id
          FROM match_terms mt CROSS JOIN LATERAL (
            SELECT d.id, row_number() OVER (ORDER BY ts_rank_cd(d.fts, mt.q, 2) DESC) AS term_rank
            FROM memory_digests d
            WHERE d.fts @@ mt.q
            LIMIT (SELECT candidate_cap FROM bounds)
          ) c
          GROUP BY c.id
          ORDER BY min(c.term_rank)
          LIMIT (SELECT candidate_cap FROM bounds)
        )
        ORDER BY bm25_score
        LIMIT p_match_count
      ) digests

      UNION ALL

      SELECT * FROM (
        SELECT ms.id, 'semantic'::text AS memory_type,
          (ms.topic || ' ' || ms.content) <@> to_bm25query(array_to_string(ARRAY(
            SELECT mt.t FROM match_terms mt WHERE ms.fts @@ mt.q), ' '), 'idx_semantic_bm25') AS bm25_score
        FROM memory_semantic ms
        WHERE ms.id IN (
          SELECT c.id
          FROM match_terms mt CROSS JOIN LATERAL (
            SELECT s.id, row_number() OVER (ORDER BY ts_rank_cd(s.fts, mt.q, 2) DESC) AS term_rank
            FROM memory_semantic s
            WHERE s.fts @@ mt.q
              AND s.superseded_by IS NULL
              AND s.forgotten_at IS NULL
            LIMIT (SELECT candidate_cap FROM bounds)
          ) c
          GROUP BY c.id
          ORDER BY min(c.term_rank)
          LIMIT (SELECT candidate_cap FROM bounds)
        )
        ORDER BY bm25_score
        LIMIT p_match_count
      ) semantic

      UNION ALL

      SELECT * FROM (
        SELECT mp.id, 'procedural'::text AS memory_type,
          (mp.trigger_text || ' ' || mp.procedure) <@> to_bm25query(array_to_string(ARRAY(
            SELECT mt.t FROM match_terms mt WHERE mp.fts @@ mt.q), ' '), 'idx_procedural_bm25') AS bm25_score
        FROM memory_procedural mp
        WHERE mp.id IN (
          SELECT c.id
          FROM match_terms mt CROSS JOIN LATERAL (
            SELECT p.id, row_number() OVER (ORDER BY ts_rank_cd(p.fts, mt.q, 2) DESC) AS term_rank
            FROM memory_procedural p
            WHERE p.fts @@ mt.q
              AND p.forgotten_at IS NULL
            LIMIT (SELECT candidate_cap FROM bounds)
          ) c
          GROUP BY c.id
          ORDER BY min(c.term_rank)
          LIMIT (SELECT candidate_cap FROM bounds)
        )
        ORDER BY bm25_score
        LIMIT p_match_count
      ) procedural
    ) tiers
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
