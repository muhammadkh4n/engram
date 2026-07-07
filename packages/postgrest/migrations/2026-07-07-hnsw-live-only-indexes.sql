-- Rebuild the HNSW indexes to cover only LIVE rows:
--   WHERE embedding IS NOT NULL AND forgotten_at IS NULL
--
-- Why: HNSW returns at most hnsw.ef_search candidates per index scan, and any
-- WHERE clauses beyond the index predicate are post-filters over that candidate
-- stream. With the old predicate (embedding IS NOT NULL only), tombstoned
-- (forgotten_at IS NOT NULL) rows stay inside the index and consume candidate
-- slots. After a bulk tombstone pass (e.g. the 2026-07-07 semantic exact-content
-- dedup, which tombstoned 44,522 of 48,494 semantic rows), a query asking for
-- 120 semantic candidates returned only 39 live rows — the ef_search window was
-- ~92% dead entries. Excluding forgotten rows at the index level restores the
-- full candidate budget to live rows. Every vector query already filters
-- forgotten_at IS NULL, so the partial predicate matches all query shapes; an
-- un-forgotten row re-enters the index automatically on UPDATE.
--
-- memory_digests has no forgotten_at column; its index is unchanged.
--
-- NOTE: parallel HNSW builds allocate dynamic shared memory; under Docker's
-- default 64MB /dev/shm the build fails with "could not resize shared memory
-- segment". Single-threaded build avoids that and takes seconds at this scale.
--
-- Ops context (not part of the canonical schema): the dedup pass that motivated
-- this also created table semantic_dedup_audit (tombstoned_id -> keeper_id,
-- content_hash, tombstoned_at) on the production DB as the undo/audit record.
--
-- Idempotent; safe to re-run.

SET max_parallel_maintenance_workers = 0;

DROP INDEX IF EXISTS idx_episodes_embedding_hnsw;
CREATE INDEX idx_episodes_embedding_hnsw ON public.memory_episodes USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE embedding IS NOT NULL AND forgotten_at IS NULL;

DROP INDEX IF EXISTS idx_semantic_embedding_hnsw;
CREATE INDEX idx_semantic_embedding_hnsw ON public.memory_semantic USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE embedding IS NOT NULL AND forgotten_at IS NULL;

DROP INDEX IF EXISTS idx_procedural_embedding_hnsw;
CREATE INDEX idx_procedural_embedding_hnsw ON public.memory_procedural USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE embedding IS NOT NULL AND forgotten_at IS NULL;

ANALYZE memory_episodes;
ANALYZE memory_semantic;
ANALYZE memory_procedural;
ANALYZE memory_digests;
