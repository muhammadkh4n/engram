-- Vector-First Search: Pure cosine similarity across all memory types
CREATE OR REPLACE FUNCTION engram_vector_search(
  p_query_embedding vector,
  p_match_count int DEFAULT 15,
  p_session_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  memory_type text,
  content text,
  role text,
  salience float,
  access_count int,
  created_at timestamptz,
  similarity float,
  entities text[],
  metadata jsonb
)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public
AS $$
  -- Episodes
  SELECT
    me.id, 'episode'::text, me.content, me.role,
    me.salience::float, me.access_count, me.created_at,
    (1 - (me.embedding <=> p_query_embedding))::float AS similarity,
    me.entities, me.metadata
  FROM memory_episodes me
  WHERE me.embedding IS NOT NULL
    AND (p_session_id IS NULL OR me.session_id = p_session_id)

  UNION ALL

  -- Digests
  SELECT
    md.id, 'digest'::text, md.summary, NULL,
    0.5::float, 0, md.created_at,
    (1 - (md.embedding <=> p_query_embedding))::float,
    md.key_topics, md.metadata
  FROM memory_digests md
  WHERE md.embedding IS NOT NULL

  UNION ALL

  -- Semantic
  SELECT
    ms.id, 'semantic'::text, ms.content, NULL,
    ms.confidence::float, ms.access_count, ms.created_at,
    (1 - (ms.embedding <=> p_query_embedding))::float,
    ARRAY[]::text[], ms.metadata
  FROM memory_semantic ms
  WHERE ms.embedding IS NOT NULL AND ms.superseded_by IS NULL

  UNION ALL

  -- Procedural
  SELECT
    mp.id, 'procedural'::text, mp.procedure, NULL,
    mp.confidence::float, mp.access_count, mp.created_at,
    (1 - (mp.embedding <=> p_query_embedding))::float,
    ARRAY[]::text[], mp.metadata
  FROM memory_procedural mp
  WHERE mp.embedding IS NOT NULL

  ORDER BY similarity DESC
  LIMIT p_match_count
$$;

-- Text Boost: OR-joined FTS returning IDs and rank scores only
CREATE OR REPLACE FUNCTION engram_text_boost(
  p_query_terms text,
  p_match_count int DEFAULT 30,
  p_session_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  memory_type text,
  rank_score float
)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, memory_type, rank_score FROM (
    SELECT me.id, 'episode'::text AS memory_type,
      ts_rank_cd(me.fts, to_tsquery('english', p_query_terms))::float AS rank_score
    FROM memory_episodes me
    WHERE me.fts @@ to_tsquery('english', p_query_terms)
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

    UNION ALL

    SELECT mp.id, 'procedural'::text,
      ts_rank_cd(mp.fts, to_tsquery('english', p_query_terms))::float
    FROM memory_procedural mp
    WHERE mp.fts @@ to_tsquery('english', p_query_terms)
  ) combined
  ORDER BY rank_score DESC
  LIMIT p_match_count
$$;

GRANT EXECUTE ON FUNCTION engram_vector_search TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_text_boost TO authenticated, service_role;
