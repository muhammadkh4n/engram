CREATE OR REPLACE FUNCTION match_episodes(
  query_embedding TEXT,
  match_count INT DEFAULT 10,
  min_similarity FLOAT DEFAULT 0.3,
  filter_session_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  session_id TEXT,
  role TEXT,
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
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

CREATE OR REPLACE FUNCTION match_digests(
  query_embedding TEXT,
  match_count INT DEFAULT 10,
  min_similarity FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  session_id TEXT,
  summary TEXT,
  key_topics TEXT[],
  episode_ids UUID[],
  metadata JSONB,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
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

CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding TEXT,
  match_count INT DEFAULT 10,
  min_similarity FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  topic TEXT,
  content TEXT,
  confidence FLOAT,
  source_digest_ids UUID[],
  metadata JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    k.id, k.topic, k.content, k.confidence::FLOAT, k.source_digest_ids, k.metadata, k.created_at, k.updated_at,
    (1 - (k.embedding <=> query_embedding::vector))::FLOAT AS similarity
  FROM memory_knowledge k
  WHERE (1 - (k.embedding <=> query_embedding::vector)) >= min_similarity
  ORDER BY k.embedding <=> query_embedding::vector
  LIMIT match_count;
END;
$$;
