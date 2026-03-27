-- Vector similarity search functions for all three memory tiers

-- Episodes: full search with optional session filter
CREATE OR REPLACE FUNCTION match_episodes(
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  min_similarity float DEFAULT 0.3,
  filter_session_id text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  session_id text,
  role text,
  content text,
  metadata jsonb,
  created_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.session_id,
    e.role,
    e.content,
    e.metadata,
    e.created_at,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM memory_episodes e
  WHERE e.embedding IS NOT NULL
    AND (filter_session_id IS NULL OR e.session_id = filter_session_id)
    AND 1 - (e.embedding <=> query_embedding) >= min_similarity
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Digests: session summaries search
CREATE OR REPLACE FUNCTION match_digests(
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  min_similarity float DEFAULT 0.3
)
RETURNS TABLE(
  id uuid,
  session_id text,
  summary text,
  key_topics text[],
  metadata jsonb,
  created_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.session_id,
    d.summary,
    d.key_topics,
    d.metadata,
    d.created_at,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM memory_digests d
  WHERE d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) >= min_similarity
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Knowledge: distilled facts search
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  min_similarity float DEFAULT 0.3
)
RETURNS TABLE(
  id uuid,
  topic text,
  content text,
  confidence float,
  metadata jsonb,
  created_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    k.id,
    k.topic,
    k.content,
    k.confidence,
    k.metadata,
    k.created_at,
    1 - (k.embedding <=> query_embedding) AS similarity
  FROM memory_knowledge k
  WHERE k.embedding IS NOT NULL
    AND 1 - (k.embedding <=> query_embedding) >= min_similarity
  ORDER BY k.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
