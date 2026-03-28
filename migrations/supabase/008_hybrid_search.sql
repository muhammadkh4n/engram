-- Add tsvector columns for full-text search (generated, stored)
ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

ALTER TABLE memory_digests ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', summary)) STORED;

ALTER TABLE memory_semantic ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', topic || ' ' || content)) STORED;

ALTER TABLE memory_procedural ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', trigger_text || ' ' || procedure)) STORED;

-- GIN indexes for full-text search
CREATE INDEX IF NOT EXISTS idx_episodes_fts ON memory_episodes USING gin(fts);
CREATE INDEX IF NOT EXISTS idx_digests_fts ON memory_digests USING gin(fts);
CREATE INDEX IF NOT EXISTS idx_semantic_fts ON memory_semantic USING gin(fts);
CREATE INDEX IF NOT EXISTS idx_procedural_fts ON memory_procedural USING gin(fts);

-- Hybrid search with RRF (Reciprocal Rank Fusion)
-- Combines BM25 full-text + pgvector cosine similarity
CREATE OR REPLACE FUNCTION engram_hybrid_recall(
  p_query_text text,
  p_query_embedding vector,
  p_match_count int DEFAULT 10,
  p_full_text_weight float DEFAULT 1.0,
  p_semantic_weight float DEFAULT 1.0,
  p_rrf_k int DEFAULT 60,
  p_session_id text DEFAULT NULL,
  p_include_episodes bool DEFAULT true,
  p_include_digests bool DEFAULT true,
  p_include_semantic bool DEFAULT true,
  p_include_procedural bool DEFAULT true
)
RETURNS TABLE (
  id uuid,
  memory_type text,
  content text,
  salience float,
  access_count int,
  created_at timestamptz,
  similarity float,
  entities text[]
)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public
AS $$
  -- Episode hybrid search
  SELECT * FROM (
    WITH ft AS (
      SELECT me.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(me.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_episodes me
      WHERE p_include_episodes AND me.fts @@ websearch_to_tsquery('english', p_query_text)
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
      LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT me.id, ROW_NUMBER() OVER (ORDER BY me.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_episodes me
      WHERE p_include_episodes AND me.embedding IS NOT NULL
        AND (p_session_id IS NULL OR me.session_id = p_session_id)
      ORDER BY me.embedding <=> p_query_embedding
      LIMIT p_match_count * 2
    )
    SELECT
      me.id, 'episode'::text AS memory_type, me.content,
      me.salience::float, me.access_count, me.created_at,
      (COALESCE(1.0 / (p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight +
       COALESCE(1.0 / (p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float AS similarity,
      me.entities
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_episodes me ON COALESCE(ft.id, vs.id) = me.id
    ORDER BY similarity DESC
    LIMIT p_match_count
  ) ep

  UNION ALL

  -- Digest hybrid search
  SELECT * FROM (
    WITH ft AS (
      SELECT md.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(md.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_digests md
      WHERE p_include_digests AND md.fts @@ websearch_to_tsquery('english', p_query_text)
      LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT md.id, ROW_NUMBER() OVER (ORDER BY md.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_digests md
      WHERE p_include_digests AND md.embedding IS NOT NULL
      ORDER BY md.embedding <=> p_query_embedding
      LIMIT p_match_count * 2
    )
    SELECT
      md.id, 'digest'::text, md.summary, 0.5::float, 0, md.created_at,
      (COALESCE(1.0 / (p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight +
       COALESCE(1.0 / (p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      md.key_topics
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_digests md ON COALESCE(ft.id, vs.id) = md.id
    ORDER BY similarity DESC
    LIMIT p_match_count
  ) dg

  UNION ALL

  -- Semantic hybrid search
  SELECT * FROM (
    WITH ft AS (
      SELECT ms.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ms.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_semantic ms
      WHERE p_include_semantic AND ms.fts @@ websearch_to_tsquery('english', p_query_text)
        AND ms.superseded_by IS NULL
      LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT ms.id, ROW_NUMBER() OVER (ORDER BY ms.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_semantic ms
      WHERE p_include_semantic AND ms.embedding IS NOT NULL AND ms.superseded_by IS NULL
      ORDER BY ms.embedding <=> p_query_embedding
      LIMIT p_match_count * 2
    )
    SELECT
      ms.id, 'semantic'::text, ms.content, ms.confidence::float, ms.access_count, ms.created_at,
      (COALESCE(1.0 / (p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight +
       COALESCE(1.0 / (p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      ARRAY[]::text[]
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_semantic ms ON COALESCE(ft.id, vs.id) = ms.id
    ORDER BY similarity DESC
    LIMIT p_match_count
  ) sm

  UNION ALL

  -- Procedural hybrid search
  SELECT * FROM (
    WITH ft AS (
      SELECT mp.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(mp.fts, websearch_to_tsquery('english', p_query_text)) DESC) AS rank_ix
      FROM memory_procedural mp
      WHERE p_include_procedural AND mp.fts @@ websearch_to_tsquery('english', p_query_text)
      LIMIT p_match_count * 2
    ),
    vs AS (
      SELECT mp.id, ROW_NUMBER() OVER (ORDER BY mp.embedding <=> p_query_embedding) AS rank_ix
      FROM memory_procedural mp
      WHERE p_include_procedural AND mp.embedding IS NOT NULL
      ORDER BY mp.embedding <=> p_query_embedding
      LIMIT p_match_count * 2
    )
    SELECT
      mp.id, 'procedural'::text, mp.procedure, mp.confidence::float, mp.access_count, mp.created_at,
      (COALESCE(1.0 / (p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight +
       COALESCE(1.0 / (p_rrf_k + vs.rank_ix), 0.0) * p_semantic_weight)::float,
      ARRAY[]::text[]
    FROM ft FULL OUTER JOIN vs ON ft.id = vs.id
    JOIN memory_procedural mp ON COALESCE(ft.id, vs.id) = mp.id
    ORDER BY similarity DESC
    LIMIT p_match_count
  ) pr
$$;

GRANT EXECUTE ON FUNCTION engram_hybrid_recall TO authenticated, service_role;
