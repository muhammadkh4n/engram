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
-- CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, and a revoke of
-- EXECUTE on pg_textsearch's own functions from PUBLIC and every other role
-- except their owner. Re-applying repeats the revoke, so it also covers the
-- functions a newer pg_textsearch adds after ALTER EXTENSION ... UPDATE.
-- Re-applying also converges the BM25 indexes: an index whose stored options
-- differ from the ones below is dropped and built again, and an index that
-- already carries them is left as it is.
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
--   DROP INDEX public.idx_items_bm25;
--   DROP FUNCTION public.engram_bm25_match(text[], integer, text, text, text[], text);
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

-- pg_textsearch installs its functions in public. Some of them keep the
-- default EXECUTE grant to PUBLIC. Where default privileges grant EXECUTE on
-- new functions to a role such as service_role, that role receives every
-- one of them, including the index maintenance, cache and test scaffolds
-- the extension itself revokes from PUBLIC. PostgREST serves public, so any
-- of these a role may execute is callable as /rpc/<name> with that role's
-- JWT, or with none by the anon role. Only some guard themselves:
-- bm25_force_merge and bm25_spill_index require the index owner, the dump
-- and tombstone functions a superuser, while others such as
-- bm25_test_memtable_append and bm25_cache_evict_largest check nothing.
-- EXECUTE is therefore revoked from PUBLIC and from every role except each
-- function's owner, and granted back to none: engram_bm25_match is SECURITY
-- DEFINER and reaches the operators and scoring functions it uses as its
-- owner, and index writes need no EXECUTE because the server calls the
-- access method. The functions are found through pg_depend, not listed by
-- name, so re-applying this file covers the functions a newer version adds.
DO $$
DECLARE
  fn regprocedure;
  role_name name;
BEGIN
  FOR fn IN
    SELECT d.objid::regprocedure
    FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    WHERE d.refclassid = 'pg_extension'::regclass
      AND d.classid = 'pg_proc'::regclass
      AND d.deptype = 'e'
      AND e.extname = 'pg_textsearch'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC', fn);
    FOR role_name IN
      SELECT DISTINCT r.rolname
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
      WHERE p.oid = fn::oid
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> p.proowner
    LOOP
      EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM %I', fn, role_name);
    END LOOP;
  END LOOP;
END
$$;


--
-- BM25 indexes, one per tier.
--
-- Each index covers the same text as that tier's fts generated column in
-- schema.sql, with the same 'english' configuration. BM25 term statistics
-- (document count, document frequency, average length) are kept per index,
-- so each index predicate equals the filter recall applies to that tier:
-- tombstoned and superseded rows never inflate or dilute the statistics of
-- the rows recall can return.
--
-- Parameters: k1 = 1.2 (the default) and b = 0.4 (the default is 0.75).
-- b sets how strongly a row's score is divided by its length relative to
-- the tier's average. Episodes average about 44 tokens, while design
-- records, audits and session summaries run to hundreds or thousands, so at
-- b = 0.75 a long row holding the query terms scores far below a short row
-- holding the same terms and drops out of the lexical results. b = 0.4
-- keeps part of the normalisation, so a short row that is mostly the query
-- still ranks well, while long matching rows stay in the results.
--
-- Changing an index's options. pg_textsearch writes k1 and b into the
-- index metapage when the index is built, and every score reads them from
-- there. ALTER INDEX ... SET (b = ...) is accepted, but it only rewrites
-- pg_class.reloptions: the metapage, and so every score, keeps the old value
-- until the index is rebuilt. CREATE INDEX IF NOT EXISTS skips an index that
-- exists, whatever its options. So, for re-applying this file to move an
-- existing install to the options below, this block drops each of the five
-- indexes whose stored options are not exactly that set, and the CREATE
-- statements that follow build it again. An index that already carries them
-- is kept, so a second apply rebuilds nothing. engram_bm25_match names the
-- indexes only as text inside to_bm25query, so no object depends on them;
-- if one ever does, DROP INDEX fails and the transaction rolls back.
DO $$
DECLARE
  target text[] := ARRAY['text_config=english', 'k1=1.2', 'b=0.4'];
  index_name name;
BEGIN
  FOR index_name IN
    SELECT c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'i'
      AND c.relname IN ('idx_episodes_bm25', 'idx_digests_bm25', 'idx_semantic_bm25', 'idx_procedural_bm25', 'idx_items_bm25')
      AND NOT (coalesce(c.reloptions, '{}') @> target AND coalesce(c.reloptions, '{}') <@ target)
  LOOP
    EXECUTE format('DROP INDEX public.%I', index_name);
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS idx_episodes_bm25 ON public.memory_episodes
  USING bm25 (content) WITH (text_config = 'english', k1 = 1.2, b = 0.4)
  WHERE forgotten_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_digests_bm25 ON public.memory_digests
  USING bm25 (summary) WITH (text_config = 'english', k1 = 1.2, b = 0.4);

CREATE INDEX IF NOT EXISTS idx_semantic_bm25 ON public.memory_semantic
  USING bm25 ((topic || ' ' || content)) WITH (text_config = 'english', k1 = 1.2, b = 0.4)
  WHERE forgotten_at IS NULL AND superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_procedural_bm25 ON public.memory_procedural
  USING bm25 ((trigger_text || ' ' || procedure)) WITH (text_config = 'english', k1 = 1.2, b = 0.4)
  WHERE forgotten_at IS NULL;

-- The item store's lexical index. Items carry their own search_text, so the
-- index reads that column.
CREATE INDEX IF NOT EXISTS idx_items_bm25 ON public.memory_items
  USING bm25 (search_text) WITH (text_config = 'english', k1 = 1.2, b = 0.4)
  WHERE forgotten_at IS NULL;


--
-- Name: engram_bm25_match(text[], integer, text, text, text[], text); Type: FUNCTION; Schema: public; Owner: -
--

-- Drop the signature without p_kinds and p_exclude_session_id: the new
-- defaulted parameters would otherwise leave a second overload, and PostgREST
-- cannot choose between two functions of one name. The drop also removes the
-- old signature's grants and its dependency on the extension; both are
-- declared again for the new one below.
DROP FUNCTION IF EXISTS public.engram_bm25_match(text[], integer, text, text);

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
-- Ties. Each cut (a term's candidate LIMIT and its row_number(), the
-- tier's candidate cap, the tier's p_match_count rows and the final cut)
-- ends its ORDER BY in a key that is unique within its rows: the row id, and
-- memory_type with the id across tiers. Rows with identical text score
-- identically, and without that key the cut keeps whichever tied rows the
-- scan meets first. Heap order changes whenever a row is rewritten, and
-- recall rewrites the rows it returns (shown_count), so two calls with the
-- same terms over the same rows could return different id sets.
--
-- Filters. p_kinds and p_exclude_session_id keep the rows engram_text_match
-- keeps under the same arguments, so they are applied where a term picks its
-- candidates: the cap is filled with rows the caller can receive. As in
-- engram_text_match, the episode branch first tests p_kinds against the
-- kinds engram_episode_kind can return, a one-time filter that skips the
-- episode scan when no requested kind is an episode kind.
--
-- An empty or NULL p_terms, or terms that reduce to no lexemes, return no
-- rows. p_project_id is accepted for caller compatibility and filters
-- nothing: a project tag only ranks rows (in the client), it never excludes
-- them.
CREATE OR REPLACE FUNCTION public.engram_bm25_match(p_terms text[], p_match_count integer DEFAULT 30, p_session_id text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text, p_kinds text[] DEFAULT NULL::text[], p_exclude_session_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, memory_type text, rank_score double precision)
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
            SELECT e.id, row_number() OVER (ORDER BY ts_rank_cd(e.fts, mt.q, 2) DESC, e.id) AS term_rank
            FROM memory_episodes e
            WHERE e.fts @@ mt.q
              AND e.forgotten_at IS NULL
              AND (p_session_id IS NULL OR e.session_id = p_session_id)
              AND (p_kinds IS NULL OR p_kinds && ARRAY['summary', 'commit', 'ruling', 'proposal', 'knowledge', 'decision', 'progress', 'note', 'turn'])
              AND (p_kinds IS NULL OR engram_episode_kind(e.metadata, e.session_id) = ANY(p_kinds))
              AND (p_exclude_session_id IS NULL OR e.session_id IS DISTINCT FROM p_exclude_session_id)
            ORDER BY ts_rank_cd(e.fts, mt.q, 2) DESC, e.id
            LIMIT (SELECT candidate_cap FROM bounds)
          ) c
          GROUP BY c.id
          ORDER BY min(c.term_rank), c.id
          LIMIT (SELECT candidate_cap FROM bounds)
        )
        ORDER BY bm25_score, me.id
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
            SELECT d.id, row_number() OVER (ORDER BY ts_rank_cd(d.fts, mt.q, 2) DESC, d.id) AS term_rank
            FROM memory_digests d
            WHERE d.fts @@ mt.q
              AND (p_kinds IS NULL OR 'digest' = ANY(p_kinds))
              AND (p_exclude_session_id IS NULL OR d.session_id IS DISTINCT FROM p_exclude_session_id)
            ORDER BY ts_rank_cd(d.fts, mt.q, 2) DESC, d.id
            LIMIT (SELECT candidate_cap FROM bounds)
          ) c
          GROUP BY c.id
          ORDER BY min(c.term_rank), c.id
          LIMIT (SELECT candidate_cap FROM bounds)
        )
        ORDER BY bm25_score, md.id
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
            SELECT s.id, row_number() OVER (ORDER BY ts_rank_cd(s.fts, mt.q, 2) DESC, s.id) AS term_rank
            FROM memory_semantic s
            WHERE s.fts @@ mt.q
              AND s.superseded_by IS NULL
              AND s.forgotten_at IS NULL
              AND (p_kinds IS NULL OR 'fact' = ANY(p_kinds))
            ORDER BY ts_rank_cd(s.fts, mt.q, 2) DESC, s.id
            LIMIT (SELECT candidate_cap FROM bounds)
          ) c
          GROUP BY c.id
          ORDER BY min(c.term_rank), c.id
          LIMIT (SELECT candidate_cap FROM bounds)
        )
        ORDER BY bm25_score, ms.id
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
            SELECT p.id, row_number() OVER (ORDER BY ts_rank_cd(p.fts, mt.q, 2) DESC, p.id) AS term_rank
            FROM memory_procedural p
            WHERE p.fts @@ mt.q
              AND p.forgotten_at IS NULL
              AND (p_kinds IS NULL OR 'procedure' = ANY(p_kinds))
            ORDER BY ts_rank_cd(p.fts, mt.q, 2) DESC, p.id
            LIMIT (SELECT candidate_cap FROM bounds)
          ) c
          GROUP BY c.id
          ORDER BY min(c.term_rank), c.id
          LIMIT (SELECT candidate_cap FROM bounds)
        )
        ORDER BY bm25_score, mp.id
        LIMIT p_match_count
      ) procedural
    ) tiers
  ) combined
  WHERE rank_score > 0
  ORDER BY rank_score DESC, memory_type, id
  LIMIT p_match_count
$$;

-- engram_bm25_match is SECURITY DEFINER and PostgREST serves public to the
-- anon role, so the default EXECUTE grant to PUBLIC (and, on Supabase, the
-- default grants to anon and authenticated) would let a request without a
-- JWT run it. Clients authenticate with the service-role key: EXECUTE is
-- revoked from those roles and granted to service_role explicitly, as
-- schema.sql does for its RPC functions.
REVOKE EXECUTE ON FUNCTION public.engram_bm25_match(text[], integer, text, text, text[], text) FROM PUBLIC;

DO $$
DECLARE
  role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_bm25_match(text[], integer, text, text, text[], text) FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.engram_bm25_match(text[], integer, text, text, text[], text) TO service_role;

-- A LANGUAGE sql body records no dependency on to_bm25query or <@>, so this
-- declares one: DROP EXTENSION pg_textsearch then removes the function too,
-- and the service falls back to engram_text_match instead of finding a
-- function whose every call fails. Re-applying adds no second dependency.
ALTER FUNCTION public.engram_bm25_match(text[], integer, text, text, text[], text) DEPENDS ON EXTENSION pg_textsearch;
