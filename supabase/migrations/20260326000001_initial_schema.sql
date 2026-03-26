CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodes_session ON memory_episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON memory_episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON memory_episodes
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS memory_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_topics TEXT[] DEFAULT '{}',
  embedding vector(1536),
  episode_ids UUID[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_digests_session ON memory_digests(session_id);
CREATE INDEX IF NOT EXISTS idx_digests_created ON memory_digests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_digests_embedding ON memory_digests
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS memory_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  embedding vector(1536),
  source_digest_ids UUID[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON memory_knowledge(topic);
CREATE INDEX IF NOT EXISTS idx_knowledge_confidence ON memory_knowledge(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON memory_knowledge
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS memory_write_buffer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier TEXT NOT NULL CHECK (tier IN ('episode', 'digest', 'knowledge')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_write_buffer_status ON memory_write_buffer(status);
CREATE INDEX IF NOT EXISTS idx_write_buffer_created ON memory_write_buffer(created_at);
