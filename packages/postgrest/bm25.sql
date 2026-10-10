-- =============================================================================
-- Engram — BM25 lexical ranking and the item candidate statement (pg_textsearch)
-- =============================================================================
--
-- Apply via:   psql -U postgres -d engram -v ON_ERROR_STOP=1 -1 -f bm25.sql
--
-- Requires the pg_textsearch extension (>= 1.0) on PostgreSQL 17 or 18,
-- loaded at server start with shared_preload_libraries = 'pg_textsearch'. On
-- a server without the library CREATE EXTENSION fails and nothing else in
-- this file is applied. The tier tables' BM25 ranking is optional, since the
-- adapter falls back to engram_text_match without it, but recall over the
-- item store needs this file: engram_item_candidates, the statement it reads
-- candidates through, ranks its lexical leg with BM25 and lives here.
--
-- Apply after schema.sql: the indexes and the functions read the memory
-- tables it creates. Then run NOTIFY pgrst, 'reload schema' so PostgREST
-- exposes engram_bm25_match and engram_item_candidates, and restart the
-- engram service: the adapter checks for engram_bm25_match once at startup
-- and keeps that lexical mode until restarted.
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
-- that error is the signal to look, not to force the drop. It also removes
-- engram_item_candidates, engram_item_candidates_explain and their helpers,
-- which are declared dependent on the extension, and with them candidate
-- reads over the item store. After
-- a service restart the adapter falls back to engram_text_match (ts_rank_cd)
-- from schema.sql. Remove BM25 before moving to an image without the library:
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
--
-- The same block drops an idx_digests_bm25 built without a predicate.
-- Digests gained a forgotten_at tombstone after that index was first built
-- over every row; CREATE INDEX IF NOT EXISTS would keep it, and forgotten
-- digests would go on counting in its term statistics. Dropped once, it is
-- rebuilt below with the predicate, which a second apply keeps.
DO $$
DECLARE
  target text[] := ARRAY['text_config=english', 'k1=1.2', 'b=0.4'];
  index_name name;
BEGIN
  FOR index_name IN
    SELECT c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'i'
      AND c.relname IN ('idx_episodes_bm25', 'idx_digests_bm25', 'idx_semantic_bm25', 'idx_procedural_bm25', 'idx_items_bm25')
      AND (NOT (coalesce(c.reloptions, '{}') @> target AND coalesce(c.reloptions, '{}') <@ target)
           OR (c.relname = 'idx_digests_bm25' AND i.indpred IS NULL))
  LOOP
    EXECUTE format('DROP INDEX public.%I', index_name);
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS idx_episodes_bm25 ON public.memory_episodes
  USING bm25 (content) WITH (text_config = 'english', k1 = 1.2, b = 0.4)
  WHERE forgotten_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_digests_bm25 ON public.memory_digests
  USING bm25 (summary) WITH (text_config = 'english', k1 = 1.2, b = 0.4)
  WHERE forgotten_at IS NULL;

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
              AND d.forgotten_at IS NULL
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


--
-- Name: engram_item_candidates and its helpers; Type: FUNCTION; Schema: public; Owner: -
--

-- engram_item_candidates is the statement recall reads item candidates
-- through. It returns them from up to five legs, in this order: vector
-- (p_embedding), hyde (p_hyde_embedding), bm25 (p_terms), subject (p_query)
-- and entity (p_entities); a leg runs only when its input is set. Each row is
-- an item id, its leg, a 1-based rank within the leg, the leg's raw score
-- and, on the vector legs, the access path taken. No text and no embedding:
-- the caller fuses the legs and reads the items it keeps by id.
--
-- Visibility applies inside every leg's statement, before its LIMIT, so each
-- cap is filled with rows the caller may receive:
-- - a forgotten item never shows;
-- - a retired item shows only with p_include_history; with p_as_of, an item
--   retired after p_as_of counts as not retired;
-- - assistant turns, commits, PRs, plan ledger log sections and session
--   index rows show only with p_include_history;
-- - legacy rows show only when p_classes names legacy;
-- - an observation above p_max_observation_trust is left out;
-- - with p_as_of, an item that occurred after it is left out;
-- - p_exclude_session leaves out that session's items and every item whose
--   lineage names one of them, so a statement derived from the session's
--   turns goes with them;
-- - a superseded item stays, for the caller to show next to its successor;
-- - p_project_id filters nothing: a project only orders the subject leg.
--
-- Why EXECUTE. Every leg runs through EXECUTE <text> USING <values>.
-- PL/pgSQL plans an EXECUTE each time it runs and caches nothing, and the
-- USING values reach that one-shot plan as constants: LIMIT $13 is costed at
-- its value and each filter at its real selectivity. A static RETURN QUERY is
-- prepared once per connection and, under plan_cache_mode = auto, may switch
-- to a generic plan after five calls, where a parameter LIMIT is costed at a
-- tenth of the rows. The text holds only the predicates the request needs,
-- never an "$n IS NULL OR" arm, so estimates and partial indexes see the real
-- filter set. engram_item_candidates_leg_sql assembles it from fixed
-- fragments chosen by flags and values travel only through USING, so no
-- caller string ever becomes SQL in this SECURITY DEFINER function.
--
-- Ties. Every leg's ORDER BY ends in the item id, so rows with equal scores
-- come back in one order on every call, whatever order the heap holds them in.
--
-- The access path of the vector legs. A filtered nearest-neighbour query can
-- run as an exact scan, which computes the distance of every visible row and
-- sorts, or as an HNSW index scan, which walks the graph from the query vector
-- and returns approximate neighbours. Left to the planner, the choice moves
-- with table size and statistics: a custom plan of one static statement
-- switched between the two as the table grew, and its HNSW plans returned
-- approximate rows by default. So the function picks the path itself, and
-- each branch's text admits only its own plan.
--
-- Count probe. Before the first vector leg, the function counts the visible
-- rows that have an embedding, stopping at the first row past
-- greatest(exact_max_rows, p_k): the count is exact up to that cap and the
-- probe never counts further. Planner estimates are never used, because they
-- move with ANALYZE and would send the same request over the same rows down
-- different paths. Both vector legs share their filters, so one count serves
-- them both.
--
-- Path. engram_item_access_path(count): exact at or below exact_max_rows,
-- hnsw above it. p_force_path replaces the path, never the probe.
--
-- HNSW branch. Right before its statement, set_config(..., true) turns
-- enable_seqscan, enable_bitmapscan and enable_sort off and sets
-- hnsw.iterative_scan to relaxed_order, and hnsw.ef_search and
-- hnsw.max_scan_tuples to engram_item_access_settings' values; right after
-- it, each setting goes back to the value it held. With sequential scans,
-- bitmap scans and sorts priced out, the HNSW index scan is the only plan
-- left for ORDER BY distance LIMIT n, whatever the statistics say. The
-- iterative scan checks the filters as it walks the graph and keeps walking
-- until the LIMIT's rows have passed them or max_scan_tuples tuples were
-- visited, so the filters apply before the cap. relaxed_order recalls more
-- than strict_order but may return rows slightly out of order, so the
-- statement fetches p_k * overfetch rows into a MATERIALIZED CTE and re-sorts
-- them by exact distance. The settings go back at once so that the exact
-- fallback and the lexical and subject legs plan with sorts and sequential
-- scans allowed.
--
-- Fallback. A leg's rows are collected before any is returned. When the
-- HNSW branch yields fewer than min(p_k, count) rows, because the iterative
-- scan reached max_scan_tuples first, the leg runs the exact branch instead
-- and reports the path exact_fallback.
--
-- Restore rule. engram_item_candidates and engram_item_candidates_explain
-- name every setting they change in a SET clause. PostgreSQL restores each
-- setting named in a function's SET clause when the function exits,
-- including changes made inside it with set_config(..., true), and an error
-- rolls them back with the transaction, so no setting of the policy reaches
-- the caller's transaction, even when a statement fails between the set and
-- the reset.

-- engram_item_access_settings is the one place the policy's four numbers
-- live:
-- - exact_max_rows, the largest filtered size scanned exactly: the largest
--   of 1000, 2000, 5000, 10000, 20000, 40000 and 80000 rows whose exact
--   branch kept its p95 within 250 ms (20 query vectors, 3 timed calls each
--   after a warm-up, no parallel workers), so the query and HyDE legs stay
--   under 500 ms together. Measured at 5000 on synthetic 1536-dimension rows
--   with packages/bench/src/access-path/engram-access-path.ts; the exact
--   scan's cost per row depends on the vector width and the row size, not
--   on the values;
-- - ef_search, the HNSW candidate list. 400 covers the over-fetch of the
--   largest p_k (200 rows, twice over);
-- - overfetch, how many rows per requested row the HNSW branch fetches
--   before the exact re-sort: 2;
-- - max_scan_tuples, the tuples an iterative scan may visit: 20000,
--   pgvector's default, pinned so a server-level change cannot move it.
CREATE OR REPLACE FUNCTION public.engram_item_access_settings() RETURNS TABLE(exact_max_rows integer, ef_search integer, overfetch integer, max_scan_tuples integer)
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT 5000, 400, 2, 20000;
$$;

-- engram_item_access_path names the path for a filtered size: exact at or
-- below exact_max_rows, hnsw above it.
CREATE OR REPLACE FUNCTION public.engram_item_access_path(p_filtered_rows bigint) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'public'
    AS $$
  SELECT CASE WHEN p_filtered_rows <= s.exact_max_rows THEN 'exact' ELSE 'hnsw' END
    FROM public.engram_item_access_settings() AS s;
$$;

-- engram_item_candidates_validate checks a request and resolves its class
-- filter. c_vocabulary is every class:kind pair memory_items_kind_check
-- admits, and c_history the pairs only a call with p_include_history sees.
-- Each history kind belongs to one class, so leaving those kinds out by name
-- leaves out exactly those pairs; session_index, all of whose kinds are
-- history, is a history-only class. It returns the classes to read (those
-- named, or every class but legacy and the history-only ones, which join
-- with p_include_history) and the kinds to leave out: the history kinds,
-- unless the call includes history or names its kinds, since a named history
-- kind without p_include_history is refused. Every refusal is
-- invalid_parameter_value and names the argument. The vector dimension is
-- checked here because a function argument keeps no vector(1536) typmod.
CREATE OR REPLACE FUNCTION public.engram_item_candidates_validate(p_embedding public.vector, p_query text, p_hyde_embedding public.vector, p_entities text[], p_classes text[], p_kinds text[], p_include_history boolean, p_max_observation_trust smallint, p_k integer, p_force_path text) RETURNS TABLE(classes text[], hidden_kinds text[])
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  c_vocabulary CONSTANT text[] := ARRAY[
    'utterance:user_prompt', 'utterance:user_answer', 'utterance:assistant_turn',
    'mk_statement:ruling', 'mk_statement:fact', 'mk_statement:correction',
    'observation:fact', 'observation:procedure', 'observation:finding',
    'artifact:commit', 'artifact:pr', 'artifact:ledger_decision', 'artifact:ledger_ruling', 'artifact:ruling_entry',
    'document_section:note', 'document_section:plan_readme', 'document_section:plan_phase',
    'document_section:plan_ledger', 'document_section:plan_ledger_log', 'document_section:finding',
    'document_section:audit', 'document_section:research',
    'session_index:session',
    'legacy:legacy_episode', 'legacy:legacy_digest', 'legacy:legacy_fact'
  ];
  c_history CONSTANT text[] := ARRAY[
    'utterance:assistant_turn', 'artifact:commit', 'artifact:pr', 'document_section:plan_ledger_log',
    'session_index:session'
  ];
  c_dimensions CONSTANT integer := 1536;
  v_history boolean := coalesce(p_include_history, false);
  v_known_classes text[];
  v_known_kinds text[];
  v_history_kinds text[];
  v_history_classes text[];
  v_legacy_kinds text[];
  v_bad text[];
BEGIN
  v_known_classes := ARRAY(SELECT DISTINCT split_part(t.pair, ':', 1) FROM unnest(c_vocabulary) AS t(pair) ORDER BY 1);
  v_known_kinds := ARRAY(SELECT DISTINCT split_part(t.pair, ':', 2) FROM unnest(c_vocabulary) AS t(pair) ORDER BY 1);
  v_history_kinds := ARRAY(SELECT split_part(t.pair, ':', 2) FROM unnest(c_history) AS t(pair) ORDER BY 1);
  v_history_classes := ARRAY(
    SELECT k.cls FROM unnest(v_known_classes) AS k(cls)
     WHERE NOT EXISTS (SELECT 1 FROM unnest(c_vocabulary) AS t(pair)
                        WHERE split_part(t.pair, ':', 1) = k.cls AND t.pair <> ALL (c_history)));
  v_legacy_kinds := ARRAY(SELECT split_part(t.pair, ':', 2) FROM unnest(c_vocabulary) AS t(pair)
                           WHERE split_part(t.pair, ':', 1) = 'legacy');

  IF p_k IS NULL OR p_k NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_item_candidates: p_k must be between 1 and 200';
  END IF;
  IF p_classes IS NOT NULL THEN
    IF cardinality(p_classes) = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_item_candidates: p_classes must name at least one class';
    END IF;
    v_bad := ARRAY(SELECT u.v FROM unnest(p_classes) AS u(v) WHERE u.v IS NULL OR u.v <> ALL (v_known_classes));
    IF cardinality(v_bad) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_item_candidates: p_classes holds an unknown class: ' || array_to_string(v_bad, ', ', 'NULL');
    END IF;
    IF NOT v_history AND p_classes && v_history_classes THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_item_candidates: p_classes names a history-only class without p_include_history';
    END IF;
  END IF;
  IF p_kinds IS NOT NULL THEN
    IF cardinality(p_kinds) = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_item_candidates: p_kinds must name at least one kind';
    END IF;
    v_bad := ARRAY(SELECT u.v FROM unnest(p_kinds) AS u(v) WHERE u.v IS NULL OR u.v <> ALL (v_known_kinds));
    IF cardinality(v_bad) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_item_candidates: p_kinds holds an unknown kind: ' || array_to_string(v_bad, ', ', 'NULL');
    END IF;
    IF NOT v_history AND p_kinds && v_history_kinds THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_item_candidates: p_kinds names a history kind without p_include_history';
    END IF;
    IF p_kinds && v_legacy_kinds AND NOT coalesce('legacy' = ANY (p_classes), false) THEN
      RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
        MESSAGE = 'engram_item_candidates: p_kinds names a legacy kind without legacy in p_classes';
    END IF;
  END IF;
  IF p_force_path IS NOT NULL AND p_force_path NOT IN ('exact', 'hnsw') THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_item_candidates: p_force_path must be exact or hnsw';
  END IF;
  IF char_length(p_query) > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_item_candidates: p_query must be at most 4000 characters';
  END IF;
  IF p_max_observation_trust NOT BETWEEN 0 AND 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_item_candidates: p_max_observation_trust must be between 0 and 3';
  END IF;
  IF vector_dims(p_embedding) <> c_dimensions THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_item_candidates: p_embedding must have 1536 dimensions';
  END IF;
  IF vector_dims(p_hyde_embedding) <> c_dimensions THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_item_candidates: p_hyde_embedding must have 1536 dimensions';
  END IF;
  IF array_position(p_entities, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_item_candidates: p_entities holds a NULL entity';
  END IF;

  classes := coalesce(p_classes, ARRAY(
    SELECT k.cls FROM unnest(v_known_classes) AS k(cls)
     WHERE k.cls <> 'legacy' AND (v_history OR k.cls <> ALL (v_history_classes))));
  hidden_kinds := CASE WHEN v_history OR p_kinds IS NOT NULL THEN NULL ELSE v_history_kinds END;
  RETURN NEXT;
END; $$;

-- engram_item_candidates_leg_sql returns the text of one leg's statement,
-- built from fixed fragments chosen by flags. It never sees a value, so no
-- value can reach the text. Every statement returns (id, score) rows, best
-- first, and reads its values from one positional USING list that every
-- caller passes in this order:
--   $1  p_embedding               $9  p_project_id
--   $2  p_query                   $10 p_exclude_session
--   $3  p_terms                   $11 p_as_of
--   $4  p_hyde_embedding          $12 p_max_observation_trust
--   $5  p_entities                $13 p_k
--   $6  the classes to read       $14 the count probe's row cap (NULL: no cap)
--   $7  p_kinds                   $15 the HNSW branch's fetch, p_k * overfetch
--   $8  the kinds left out
-- A statement ignores the positions it does not reference.
--
-- vector and hyde, count probe (p_branch count): the number of visible rows
-- with an embedding, up to $14 of them.
--
-- vector and hyde, exact branch: the distance of every visible row with an
-- embedding is computed once, in a MATERIALIZED CTE with no ORDER BY, and the
-- sort above it reads (id, distance) pairs that no index holds, so this text
-- plans an exact scan whatever the costs: the HNSW index can only serve an
-- ORDER BY on the distance expression over memory_items itself. The score is
-- 1 minus the cosine distance.
--
-- vector and hyde, HNSW branch: the CTE orders memory_items by the distance
-- expression and fetches $15 rows, the shape an HNSW index scan serves; the
-- caller prices every other plan out before running it. The rows an
-- iterative scan returns may be slightly out of order, so the outer
-- statement re-sorts the materialized (id, distance) pairs and keeps $13.
-- It sorts on d + 0, not d: PostgreSQL 17 carries the CTE's index order up
-- to the outer query, and ORDER BY d, id would plan an Incremental Sort that
-- takes the rows as already ordered by d and only orders equal distances by
-- id. No pathkey covers d + 0, so the outer sort is a full sort.
--
-- bm25: each term becomes its own phraseto_tsquery('english', t), matched on
-- fts through idx_items_fts, as engram_bm25_match matches a tier. The
-- 'english' parser splits 'xyz-123' into 'xyz' and '-123', and the phrase
-- query requires the two adjacent, so a row holding only 'xyz' never
-- matches. Scoring with <@> outside a BM25 index scan tokenises the row
-- again, so at most 500 rows are scored: each term ranks its visible matches
-- by ts_rank_cd(fts, q, 2), which divides by the row's length as BM25 length
-- normalisation does, and candidates are taken round-robin across terms, so
-- a rare term keeps its rows while common terms share the rest. A row is
-- scored on the terms it matches only, with idx_items_bm25's term
-- statistics, and the score is negated so higher is better. The LIMIT sits
-- below the score > 0 filter, which keeps that filter out of the scan, where
-- it would score every row a second time.
--
-- subject: up to 5 subjects whose label's lexemes all occur among the
-- query's (plainto_tsquery of the label against to_tsvector of p_query; a
-- label with no lexeme never matches) and that hold a visible item, so a
-- subject with nothing to show takes no place. p_project_id's subjects come
-- first when it is set, then labels with more lexemes. Their visible items
-- follow in subject order, current before superseded (as of p_as_of when it
-- is set), newer first. The score is the label's lexeme count.
--
-- entity: the visible items holding an entity equal, ignoring case, to one
-- of p_entities, found through idx_item_entities_entity, a hash index on
-- lower(entity). Items matching more of the requested entities come first,
-- then newer ones. The score is the number of distinct requested entities
-- matched; an item that stores one entity in two spellings counts it once.
CREATE OR REPLACE FUNCTION public.engram_item_candidates_leg_sql(p_leg text, p_branch text, p_has_kinds boolean, p_hide_kinds boolean, p_include_history boolean, p_has_as_of boolean, p_has_exclude_session boolean, p_has_trust_cap boolean, p_has_project boolean) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_visible text := 'i.forgotten_at IS NULL AND i.class = ANY ($6)';
  v_current text := 'i.valid_to IS NULL';
  v_subject_order text := 's.lexemes DESC, s.id';
  v_vector text;
BEGIN
  IF p_has_kinds THEN
    v_visible := v_visible || ' AND i.kind = ANY ($7)';
  END IF;
  IF p_hide_kinds THEN
    v_visible := v_visible || ' AND i.kind <> ALL ($8)';
  END IF;
  IF p_has_as_of THEN
    v_visible := v_visible || ' AND i.occurred_at <= $11';
    v_current := '(i.valid_to IS NULL OR i.valid_to > $11)';
  END IF;
  IF NOT p_include_history AND p_has_as_of THEN
    v_visible := v_visible || ' AND (i.retired_at IS NULL OR i.retired_at > $11)';
  ELSIF NOT p_include_history THEN
    v_visible := v_visible || ' AND i.retired_at IS NULL';
  END IF;
  IF p_has_exclude_session THEN
    v_visible := v_visible || ' AND i.session_id IS DISTINCT FROM $10'
      || ' AND NOT coalesce(i.lineage && ARRAY(SELECT x.id FROM public.memory_items x WHERE x.session_id = $10), false)';
  END IF;
  IF p_has_trust_cap THEN
    v_visible := v_visible || ' AND (i.class <> ''observation'' OR i.trust <= $12)';
  END IF;
  IF p_has_project THEN
    v_subject_order := '(s.project_id IS NOT DISTINCT FROM $9) DESC, ' || v_subject_order;
  END IF;

  IF p_leg IN ('vector', 'hyde') THEN
    v_vector := CASE WHEN p_leg = 'vector' THEN '$1' ELSE '$4' END;
    IF p_branch = 'count' THEN
      RETURN 'SELECT count(*) FROM ('
        || ' SELECT 1 FROM public.memory_items i'
        || ' WHERE i.embedding IS NOT NULL AND ' || v_visible || ' LIMIT $14) s';
    END IF;
    IF p_branch = 'exact' THEN
      RETURN 'WITH filtered AS MATERIALIZED ('
        || ' SELECT i.id, i.embedding <=> ' || v_vector || ' AS d FROM public.memory_items i'
        || ' WHERE i.embedding IS NOT NULL AND ' || v_visible || ')'
        || ' SELECT f.id, 1 - f.d AS score FROM filtered f ORDER BY f.d, f.id LIMIT $13';
    END IF;
    IF p_branch = 'hnsw' THEN
      RETURN 'WITH relaxed AS MATERIALIZED ('
        || ' SELECT i.id, i.embedding <=> ' || v_vector || ' AS d FROM public.memory_items i'
        || ' WHERE i.embedding IS NOT NULL AND ' || v_visible
        || ' ORDER BY i.embedding <=> ' || v_vector || ' LIMIT $15)'
        || ' SELECT r.id, 1 - r.d AS score FROM relaxed r ORDER BY r.d + 0, r.id LIMIT $13';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'engram_item_candidates_leg_sql: a vector leg runs the count, exact or hnsw branch';
  END IF;

  IF p_leg = 'bm25' THEN
    RETURN 'WITH match_terms AS MATERIALIZED ('
      || ' SELECT u.t, u.q FROM (SELECT t, phraseto_tsquery(''english'', t) AS q FROM unnest($3) AS t) u'
      || ' WHERE numnode(u.q) > 0),'
      || ' picked AS ('
      || ' SELECT c.id FROM match_terms mt CROSS JOIN LATERAL ('
      || ' SELECT i.id, row_number() OVER (ORDER BY ts_rank_cd(i.fts, mt.q, 2) DESC, i.id) AS term_rank'
      || ' FROM public.memory_items i WHERE i.fts @@ mt.q AND ' || v_visible
      || ' ORDER BY ts_rank_cd(i.fts, mt.q, 2) DESC, i.id LIMIT 500) c'
      || ' GROUP BY c.id ORDER BY min(c.term_rank), c.id LIMIT 500)'
      || ' SELECT s.id, s.score FROM ('
      || ' SELECT i.id, -(i.search_text <@> to_bm25query(array_to_string(ARRAY('
      || ' SELECT mt.t FROM match_terms mt WHERE i.fts @@ mt.q), '' ''), ''idx_items_bm25''))::double precision AS score'
      || ' FROM public.memory_items i WHERE i.id IN (SELECT p.id FROM picked p)'
      || ' ORDER BY score DESC, i.id LIMIT $13) s'
      || ' WHERE s.score > 0 ORDER BY s.score DESC, s.id';
  END IF;

  IF p_leg = 'subject' THEN
    RETURN 'WITH query_lexemes AS MATERIALIZED (SELECT to_tsvector(''english'', $2) AS v),'
      || ' matched AS MATERIALIZED ('
      || ' SELECT s.id, s.lexemes, row_number() OVER (ORDER BY ' || v_subject_order || ') AS subject_rank FROM ('
      || ' SELECT sj.id, sj.project_id, cardinality(tsvector_to_array(to_tsvector(''english'', sj.label))) AS lexemes'
      || ' FROM public.memory_subjects sj CROSS JOIN query_lexemes ql'
      || ' WHERE numnode(plainto_tsquery(''english'', sj.label)) > 0'
      || ' AND ql.v @@ plainto_tsquery(''english'', sj.label)'
      || ' AND EXISTS (SELECT 1 FROM public.memory_items i WHERE i.subject_id = sj.id AND ' || v_visible || ')'
      || ') s ORDER BY ' || v_subject_order || ' LIMIT 5)'
      || ' SELECT i.id, m.lexemes::double precision AS score'
      || ' FROM matched m JOIN public.memory_items i ON i.subject_id = m.id'
      || ' WHERE ' || v_visible
      || ' ORDER BY m.subject_rank, (' || v_current || ') DESC, i.occurred_at DESC, i.id LIMIT $13';
  END IF;

  IF p_leg = 'entity' THEN
    RETURN 'SELECT i.id, count(DISTINCT lower(e.entity))::double precision AS score'
      || ' FROM public.memory_item_entities e JOIN public.memory_items i ON i.id = e.item_id'
      || ' WHERE lower(e.entity) = ANY (ARRAY(SELECT lower(x.v) FROM unnest($5) AS x(v)))'
      || ' AND ' || v_visible
      || ' GROUP BY i.id ORDER BY score DESC, i.occurred_at DESC, i.id LIMIT $13';
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
    MESSAGE = 'engram_item_candidates_leg_sql: p_leg must be vector, hyde, bm25, subject or entity';
END; $$;

CREATE OR REPLACE FUNCTION public.engram_item_candidates(p_embedding public.vector DEFAULT NULL::public.vector, p_query text DEFAULT NULL::text, p_terms text[] DEFAULT NULL::text[], p_hyde_embedding public.vector DEFAULT NULL::public.vector, p_entities text[] DEFAULT NULL::text[], p_classes text[] DEFAULT NULL::text[], p_kinds text[] DEFAULT NULL::text[], p_project_id text DEFAULT NULL::text, p_exclude_session text DEFAULT NULL::text, p_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone, p_include_history boolean DEFAULT false, p_max_observation_trust smallint DEFAULT NULL::smallint, p_k integer DEFAULT 50, p_force_path text DEFAULT NULL::text) RETURNS TABLE(item_id uuid, leg text, rank integer, raw_score double precision, path text)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'public'
    SET enable_seqscan TO 'on'
    SET enable_bitmapscan TO 'on'
    SET enable_sort TO 'on'
    SET hnsw.iterative_scan TO 'off'
    SET hnsw.ef_search TO '40'
    SET hnsw.max_scan_tuples TO '20000'
    AS $$
DECLARE
  v_classes text[];
  v_hidden_kinds text[];
  v_history boolean := coalesce(p_include_history, false);
  v_settings record;
  v_probe_cap bigint;
  v_fetch integer;
  v_count bigint;
  v_legs text[] := ARRAY[]::text[];
  v_leg text;
  v_path text;
  v_sql text;
  v_saved text[];
  v_row record;
  v_ids uuid[];
  v_scores double precision[];
  v_rank integer;
BEGIN
  SELECT a.classes, a.hidden_kinds INTO v_classes, v_hidden_kinds
    FROM public.engram_item_candidates_validate(p_embedding, p_query, p_hyde_embedding, p_entities, p_classes, p_kinds,
                                                p_include_history, p_max_observation_trust, p_k, p_force_path) AS a;
  SELECT s.exact_max_rows, s.ef_search, s.overfetch, s.max_scan_tuples INTO v_settings
    FROM public.engram_item_access_settings() AS s;
  -- One row past the larger of the threshold and p_k: the path test and
  -- min(p_k, count) for the fallback both read an exact count.
  v_probe_cap := greatest(v_settings.exact_max_rows::bigint, p_k) + 1;
  v_fetch := p_k * v_settings.overfetch;

  IF p_embedding IS NOT NULL THEN
    v_legs := v_legs || 'vector'::text;
  END IF;
  IF p_hyde_embedding IS NOT NULL THEN
    v_legs := v_legs || 'hyde'::text;
  END IF;
  IF cardinality(p_terms) > 0 THEN
    v_legs := v_legs || 'bm25'::text;
  END IF;
  IF p_query ~ '\S' THEN
    v_legs := v_legs || 'subject'::text;
  END IF;
  IF cardinality(p_entities) > 0 THEN
    v_legs := v_legs || 'entity'::text;
  END IF;

  FOREACH v_leg IN ARRAY v_legs LOOP
    v_path := NULL;
    IF v_leg IN ('vector', 'hyde') THEN
      IF v_count IS NULL THEN
        v_sql := public.engram_item_candidates_leg_sql(v_leg, 'count', p_kinds IS NOT NULL, v_hidden_kinds IS NOT NULL,
                                                       v_history, p_as_of IS NOT NULL, p_exclude_session IS NOT NULL,
                                                       p_max_observation_trust IS NOT NULL, p_project_id IS NOT NULL);
        EXECUTE v_sql INTO v_count
          USING p_embedding, p_query, p_terms, p_hyde_embedding, p_entities, v_classes, p_kinds, v_hidden_kinds,
                p_project_id, p_exclude_session, p_as_of, p_max_observation_trust, p_k, v_probe_cap, v_fetch;
      END IF;
      v_path := coalesce(p_force_path, public.engram_item_access_path(v_count));
    END IF;

    -- Collect the leg's rows before returning any, so a short HNSW result
    -- can be replaced by the exact branch's.
    LOOP
      v_sql := public.engram_item_candidates_leg_sql(v_leg, CASE WHEN v_path = 'exact_fallback' THEN 'exact' ELSE v_path END,
                                                     p_kinds IS NOT NULL, v_hidden_kinds IS NOT NULL,
                                                     v_history, p_as_of IS NOT NULL, p_exclude_session IS NOT NULL,
                                                     p_max_observation_trust IS NOT NULL, p_project_id IS NOT NULL);
      IF v_path = 'hnsw' THEN
        v_saved := ARRAY[current_setting('enable_seqscan'), current_setting('enable_bitmapscan'),
                         current_setting('enable_sort'), current_setting('hnsw.iterative_scan'),
                         current_setting('hnsw.ef_search'), current_setting('hnsw.max_scan_tuples')];
        PERFORM set_config('enable_seqscan', 'off', true), set_config('enable_bitmapscan', 'off', true),
                set_config('enable_sort', 'off', true), set_config('hnsw.iterative_scan', 'relaxed_order', true),
                set_config('hnsw.ef_search', v_settings.ef_search::text, true),
                set_config('hnsw.max_scan_tuples', v_settings.max_scan_tuples::text, true);
      END IF;
      v_ids := ARRAY[]::uuid[];
      v_scores := ARRAY[]::double precision[];
      FOR v_row IN EXECUTE v_sql
        USING p_embedding, p_query, p_terms, p_hyde_embedding, p_entities, v_classes, p_kinds, v_hidden_kinds,
              p_project_id, p_exclude_session, p_as_of, p_max_observation_trust, p_k, v_probe_cap, v_fetch
      LOOP
        v_ids := v_ids || v_row.id;
        v_scores := v_scores || v_row.score;
      END LOOP;
      IF v_path = 'hnsw' THEN
        PERFORM set_config('enable_seqscan', v_saved[1], true), set_config('enable_bitmapscan', v_saved[2], true),
                set_config('enable_sort', v_saved[3], true), set_config('hnsw.iterative_scan', v_saved[4], true),
                set_config('hnsw.ef_search', v_saved[5], true), set_config('hnsw.max_scan_tuples', v_saved[6], true);
      END IF;
      EXIT WHEN v_path IS DISTINCT FROM 'hnsw' OR cardinality(v_ids) >= least(p_k, v_count);
      v_path := 'exact_fallback';
    END LOOP;

    FOR v_rank IN 1 .. cardinality(v_ids) LOOP
      item_id := v_ids[v_rank];
      leg := v_leg;
      rank := v_rank;
      raw_score := v_scores[v_rank];
      path := v_path;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END; $$;

-- engram_item_candidates_explain makes engram_item_candidates' decisions for
-- the same arguments, through the same validation, settings and statement
-- texts, and returns one row per statement a leg runs: the leg, its path, on
-- the vector legs the full filtered size (the probe runs with no cap, which
-- reaches the same path and the same min(p_k, count)), and the statement's
-- EXPLAIN (FORMAT JSON) plan, run with the same USING values and, on the
-- HNSW branch, the same settings. With p_analyze the statements are executed
-- under EXPLAIN ANALYZE; an HNSW plan whose top node returned fewer than
-- min(p_k, count) rows is followed by the exact branch's plan, path
-- exact_fallback, as the candidate function would run it. Without p_analyze
-- no statement runs, so the fallback cannot be known and is not shown. For
-- tests, measurement and checks on a live database.
CREATE OR REPLACE FUNCTION public.engram_item_candidates_explain(p_embedding public.vector DEFAULT NULL::public.vector, p_query text DEFAULT NULL::text, p_terms text[] DEFAULT NULL::text[], p_hyde_embedding public.vector DEFAULT NULL::public.vector, p_entities text[] DEFAULT NULL::text[], p_classes text[] DEFAULT NULL::text[], p_kinds text[] DEFAULT NULL::text[], p_project_id text DEFAULT NULL::text, p_exclude_session text DEFAULT NULL::text, p_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone, p_include_history boolean DEFAULT false, p_max_observation_trust smallint DEFAULT NULL::smallint, p_k integer DEFAULT 50, p_force_path text DEFAULT NULL::text, p_analyze boolean DEFAULT false) RETURNS TABLE(leg text, path text, filtered_rows bigint, plan jsonb)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'public'
    SET enable_seqscan TO 'on'
    SET enable_bitmapscan TO 'on'
    SET enable_sort TO 'on'
    SET hnsw.iterative_scan TO 'off'
    SET hnsw.ef_search TO '40'
    SET hnsw.max_scan_tuples TO '20000'
    AS $$
DECLARE
  c_explain CONSTANT text := 'EXPLAIN (FORMAT JSON) ';
  c_explain_analyze CONSTANT text := 'EXPLAIN (ANALYZE, FORMAT JSON) ';
  v_classes text[];
  v_hidden_kinds text[];
  v_history boolean := coalesce(p_include_history, false);
  v_analyze boolean := coalesce(p_analyze, false);
  v_settings record;
  v_probe_cap bigint;
  v_fetch integer;
  v_count bigint;
  v_legs text[] := ARRAY[]::text[];
  v_leg text;
  v_path text;
  v_sql text;
  v_saved text[];
  v_plan json;
BEGIN
  SELECT a.classes, a.hidden_kinds INTO v_classes, v_hidden_kinds
    FROM public.engram_item_candidates_validate(p_embedding, p_query, p_hyde_embedding, p_entities, p_classes, p_kinds,
                                                p_include_history, p_max_observation_trust, p_k, p_force_path) AS a;
  SELECT s.exact_max_rows, s.ef_search, s.overfetch, s.max_scan_tuples INTO v_settings
    FROM public.engram_item_access_settings() AS s;
  -- LIMIT NULL: the probe counts every visible row.
  v_probe_cap := NULL;
  v_fetch := p_k * v_settings.overfetch;

  IF p_embedding IS NOT NULL THEN
    v_legs := v_legs || 'vector'::text;
  END IF;
  IF p_hyde_embedding IS NOT NULL THEN
    v_legs := v_legs || 'hyde'::text;
  END IF;
  IF cardinality(p_terms) > 0 THEN
    v_legs := v_legs || 'bm25'::text;
  END IF;
  IF p_query ~ '\S' THEN
    v_legs := v_legs || 'subject'::text;
  END IF;
  IF cardinality(p_entities) > 0 THEN
    v_legs := v_legs || 'entity'::text;
  END IF;

  FOREACH v_leg IN ARRAY v_legs LOOP
    v_path := NULL;
    filtered_rows := NULL;
    IF v_leg IN ('vector', 'hyde') THEN
      IF v_count IS NULL THEN
        v_sql := public.engram_item_candidates_leg_sql(v_leg, 'count', p_kinds IS NOT NULL, v_hidden_kinds IS NOT NULL,
                                                       v_history, p_as_of IS NOT NULL, p_exclude_session IS NOT NULL,
                                                       p_max_observation_trust IS NOT NULL, p_project_id IS NOT NULL);
        EXECUTE v_sql INTO v_count
          USING p_embedding, p_query, p_terms, p_hyde_embedding, p_entities, v_classes, p_kinds, v_hidden_kinds,
                p_project_id, p_exclude_session, p_as_of, p_max_observation_trust, p_k, v_probe_cap, v_fetch;
      END IF;
      v_path := coalesce(p_force_path, public.engram_item_access_path(v_count));
      filtered_rows := v_count;
    END IF;

    LOOP
      v_sql := CASE WHEN v_analyze THEN c_explain_analyze ELSE c_explain END
        || public.engram_item_candidates_leg_sql(v_leg, CASE WHEN v_path = 'exact_fallback' THEN 'exact' ELSE v_path END,
                                                 p_kinds IS NOT NULL, v_hidden_kinds IS NOT NULL,
                                                 v_history, p_as_of IS NOT NULL, p_exclude_session IS NOT NULL,
                                                 p_max_observation_trust IS NOT NULL, p_project_id IS NOT NULL);
      IF v_path = 'hnsw' THEN
        v_saved := ARRAY[current_setting('enable_seqscan'), current_setting('enable_bitmapscan'),
                         current_setting('enable_sort'), current_setting('hnsw.iterative_scan'),
                         current_setting('hnsw.ef_search'), current_setting('hnsw.max_scan_tuples')];
        PERFORM set_config('enable_seqscan', 'off', true), set_config('enable_bitmapscan', 'off', true),
                set_config('enable_sort', 'off', true), set_config('hnsw.iterative_scan', 'relaxed_order', true),
                set_config('hnsw.ef_search', v_settings.ef_search::text, true),
                set_config('hnsw.max_scan_tuples', v_settings.max_scan_tuples::text, true);
      END IF;
      EXECUTE v_sql INTO v_plan
        USING p_embedding, p_query, p_terms, p_hyde_embedding, p_entities, v_classes, p_kinds, v_hidden_kinds,
              p_project_id, p_exclude_session, p_as_of, p_max_observation_trust, p_k, v_probe_cap, v_fetch;
      IF v_path = 'hnsw' THEN
        PERFORM set_config('enable_seqscan', v_saved[1], true), set_config('enable_bitmapscan', v_saved[2], true),
                set_config('enable_sort', v_saved[3], true), set_config('hnsw.iterative_scan', v_saved[4], true),
                set_config('hnsw.ef_search', v_saved[5], true), set_config('hnsw.max_scan_tuples', v_saved[6], true);
      END IF;
      leg := v_leg;
      path := v_path;
      plan := v_plan::jsonb;
      RETURN NEXT;
      EXIT WHEN v_path IS DISTINCT FROM 'hnsw' OR NOT v_analyze
        OR (v_plan -> 0 -> 'Plan' ->> 'Actual Rows')::numeric >= least(p_k, v_count);
      v_path := 'exact_fallback';
    END LOOP;
  END LOOP;
END; $$;

-- The candidate functions are SECURITY DEFINER or serve one, and PostgREST
-- serves public to the anon role: EXECUTE is revoked from PUBLIC, anon and
-- authenticated and granted to service_role, as for engram_bm25_match.
REVOKE EXECUTE ON FUNCTION public.engram_item_access_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_item_access_path(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_item_candidates_validate(public.vector, text, public.vector, text[], text[], text[], boolean, smallint, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_item_candidates_leg_sql(text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_item_candidates(public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.engram_item_candidates_explain(public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text, boolean) FROM PUBLIC;

DO $$
DECLARE
  role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_item_access_settings() FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_item_access_path(bigint) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_item_candidates_validate(public.vector, text, public.vector, text[], text[], text[], boolean, smallint, integer, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_item_candidates_leg_sql(text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_item_candidates(public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text) FROM %I', role_name);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_item_candidates_explain(public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text, boolean) FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.engram_item_access_settings() TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_item_access_path(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_item_candidates_validate(public.vector, text, public.vector, text[], text[], text[], boolean, smallint, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_item_candidates_leg_sql(text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_item_candidates(public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.engram_item_candidates_explain(public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text, boolean) TO service_role;

-- The statement text names to_bm25query and <@> only inside strings, so no
-- dependency is recorded for them. Declaring one on each candidate function
-- and helper makes DROP EXTENSION pg_textsearch remove them together, instead
-- of leaving a function whose every lexical call fails. Re-applying adds no
-- second dependency.
ALTER FUNCTION public.engram_item_access_settings() DEPENDS ON EXTENSION pg_textsearch;
ALTER FUNCTION public.engram_item_access_path(bigint) DEPENDS ON EXTENSION pg_textsearch;
ALTER FUNCTION public.engram_item_candidates_validate(public.vector, text, public.vector, text[], text[], text[], boolean, smallint, integer, text) DEPENDS ON EXTENSION pg_textsearch;
ALTER FUNCTION public.engram_item_candidates_leg_sql(text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) DEPENDS ON EXTENSION pg_textsearch;
ALTER FUNCTION public.engram_item_candidates(public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text) DEPENDS ON EXTENSION pg_textsearch;
ALTER FUNCTION public.engram_item_candidates_explain(public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text, boolean) DEPENDS ON EXTENSION pg_textsearch;
