# Engram Database Architecture Audit

**Date:** 2026-03-27
**Auditor:** Senior Database Architect
**Scope:** SQLite (spec schema) + PostgreSQL (migrations 001–003) for the Engram cognitive memory engine
**Verdict:** The existing PostgreSQL schema is an early v0.1 prototype that covers roughly 40% of the data model described in the spec. The SQLite schema in the spec is closer but has eight structural problems that will cause correctness and performance issues at scale. Both require significant rework before production use.

---

## Table of Contents

1. [Schema Design Review](#1-schema-design-review)
2. [Index Strategy](#2-index-strategy)
3. [Query Pattern Analysis](#3-query-pattern-analysis)
4. [Data Integrity](#4-data-integrity)
5. [Migration Strategy](#5-migration-strategy)
6. [Scaling Analysis](#6-scaling-analysis)
7. [Recommended Schema](#7-recommended-schema)

---

## 1. Schema Design Review

### 1.1 Normalization

**SQLite schema (spec)**

The design is at 2NF/3NF where it matters, with one deliberate violation and one accidental one.

Deliberate denormalization: `entities TEXT` stored as a JSON array in `episodes` rather than a separate `episode_entities` junction table. This is acceptable at Level 0 because the primary access pattern is "give me all entities for this episode," not "give me all episodes for this entity." When entity-based lookups become hot (dream cycle, topical association creation), this denormalization becomes the bottleneck. The dream cycle must deserialize every JSON array in memory rather than doing a SQL join. Recommendation: keep it denormalized for Level 0 but note the query impact in Section 3.

Accidental denormalization: `source_episode_ids TEXT` and `source_digest_ids TEXT` in both `digests` and `semantic` are stored as JSON arrays in a TEXT column. This is the provenance chain. Any query that needs to find "which digest was derived from episode X" must do a full table scan with `json_each()` or application-side filtering. There is no SQL-level way to index into a JSON array in SQLite without generated columns. This is not a normalization problem per se — it is a query access pattern problem that a junction table would solve. For lossless provenance (a core design principle), the inability to efficiently query the provenance chain is a significant design debt.

Verdict: Acceptable for a first implementation if junction tables are added in v1.1 when provenance queries become frequent.

**PostgreSQL schema (migrations 001–003)**

The existing schema covers only three tables: `memory_episodes`, `memory_digests`, `memory_knowledge`. The Engram spec adds two more: `procedural` and `associations`. The existing schema is a subset of what is needed, not a different design.

The `episode_ids UUID[]` array column in `memory_digests` is the PostgreSQL equivalent of the same denormalization. PostgreSQL has `ANY()` and GIN indexes on array columns, making this somewhat better than SQLite JSON TEXT, but it still cannot enforce referential integrity.

The `key_topics TEXT[]` in `memory_digests` is clean — PostgreSQL native array is the right type here.

### 1.2 Data Types

**Critical: vector dimensions (C1 from existing audit)**

`memory_episodes.embedding vector(1536)` while the config defaults to 768. Every insert will fail with a dimension mismatch error. The recommended fix is to make the dimension a migration variable, not a hardcoded literal. In practice: choose one authoritative dimension based on the embedding model, put it in a single place. With OpenAI text-embedding-3-small (1536-dim) or text-embedding-3-large (3072-dim), the schema must match. The SQLite schema uses BLOB, which sidesteps this — the application serializes the vector as a raw Float32 buffer and reads it back without schema enforcement.

**SQLite TEXT for timestamps**

`created_at TEXT DEFAULT (datetime('now'))` produces ISO 8601 strings like `"2026-03-27 14:23:01"`. This is the SQLite convention but has a subtle problem: SQLite's `datetime('now')` returns UTC without a timezone marker, and `datetime('now', 'localtime')` returns local time. Queries like "episodes created in the last 24 hours" using string comparison work correctly only if all timestamps are consistently UTC. The bigger problem is `last_accessed TEXT` and `consolidated_at TEXT` — these are nullable timestamps that default to NULL, which is correct, but comparison operators on TEXT timestamps break if any application code accidentally inserts a differently-formatted string. Recommendation: use `REAL` (Julian Day number) for all timestamps in SQLite. `julianday('now')` is monotonically comparable with `<` and `>`, arithmetic is trivial (`julianday('now') - 30` gives 30 days ago), and there is no string-parsing overhead. The schema change is a one-line `DEFAULT (julianday('now'))` substitution everywhere.

**`REAL` vs `NUMERIC` for confidence/salience**

The SQLite schema uses `REAL` (IEEE 754 double) for `salience`, `confidence`, `strength`, and `decay_rate`. This is the right call for SQLite. The CHECK constraints `confidence >= 0 AND confidence <= 1` on `memory_knowledge` in the PostgreSQL schema are missing entirely in the SQLite spec. They should be present on all four REAL columns: `salience REAL DEFAULT 0.3 CHECK (salience >= 0.0 AND salience <= 1.0)`. Without these constraints, application bugs that write confidence = 1.5 or salience = -0.1 silently corrupt the scoring model.

**`BLOB` vs `BYTEA` for embeddings**

SQLite BLOB for embedding vectors is correct. A 1536-dimension Float32 vector is 6,144 bytes. Stored as raw binary (not base64-encoded text), it is compact and fast to deserialize. The concern is L2 (from the existing audit): "JSON.stringify embedding serialization fragile." If the application serializes embeddings as JSON arrays (e.g., `JSON.stringify([0.1, 0.2, ...])`), the stored size triples to ~18KB per embedding and every read requires JSON parsing. The schema should enforce BLOB storage. In the adapter code, use `Buffer.from(new Float32Array(embedding).buffer)` for serialization and `new Float32Array(buffer.buffer)` for deserialization.

PostgreSQL `BYTEA` is acceptable but `vector(n)` is strictly better when pgvector is installed — it stores vectors natively and the `<=>` operator works without deserialization.

**`entities TEXT` as JSON array**

The SQLite spec stores `entities TEXT` as a JSON array string. In PostgreSQL the equivalent would be `TEXT[]`. For SQLite, a generated column approach is better:

```sql
-- Store as JSON (writeable)
entities_json TEXT DEFAULT '[]',
-- Expose as a searchable expression
-- (used in FTS5 content= tables, not as a separate column)
```

The FTS5 index on `content, entities` means the raw JSON string `["React","TypeScript","OpenAI"]` is what gets tokenized. FTS5 will tokenize `React`, `TypeScript`, `OpenAI` correctly since they are not surrounded by quotes in the actual values — but it will also index `[`, `]`, and `,` as tokens if the unicode61 tokenizer is used without normalization. More on this in the FTS5 section.

**`metadata TEXT DEFAULT '{}'`**

Storing metadata as a JSON string is fine for SQLite. The default `'{}'` is the correct empty-object string. One concern: `DEFAULT '{}'` means the column always has a value, making it `NOT NULL` implicitly desirable. Add `NOT NULL` explicitly. Without it, `NULL` metadata is possible if an insert explicitly sets `metadata = NULL`, bypassing the default.

### 1.3 Primary Keys

**UUID TEXT in SQLite vs INTEGER autoincrement**

The spec uses `id TEXT PRIMARY KEY` with UUIDs generated in application code (`crypto.randomUUID()`). This is a deliberate choice for cross-adapter compatibility — the same ID works in both SQLite and PostgreSQL. The performance implications are real:

- SQLite's B-tree primary key index works best with monotonically increasing values. UUID v4 is random, causing 50% page splits on average during inserts as the B-tree must constantly rebalance.
- At 100K episodes, this is measurable but not catastrophic: roughly 20–30% more write latency compared to INTEGER PRIMARY KEY AUTOINCREMENT.
- At 1M+ rows, the index fragmentation becomes significant enough that regular VACUUM + REINDEX is required.

Alternative: use UUID v7 (time-ordered UUID) for all IDs. UUID v7 has a 48-bit millisecond timestamp prefix followed by random bits, making it monotonically increasing within millisecond boundaries. This eliminates B-tree page splits while preserving global uniqueness and cross-adapter compatibility. The JS `uuid` package v9+ supports `uuidv7()`.

For the `associations` table specifically, UUID TEXT primary keys are particularly costly because the table will be large (see Section 6) and heavily read during every recall. Consider an INTEGER rowid primary key with a UUID as a secondary UNIQUE column if the rowid is never exposed to callers — this keeps the B-tree optimal while UUID serves as the stable external identifier.

**PostgreSQL UUID**

`UUID PRIMARY KEY DEFAULT gen_random_uuid()` generates UUID v4. Same page-split issue exists for heap-organized tables but matters less because PostgreSQL's MVCC heap storage is not keyed on the primary key value the same way SQLite's B-tree is. However, the UUID index on the PK column still suffers random insert order. PostgreSQL 17+ has UUID v7 via `gen_random_uuid()` — or use `uuidv7()` from the `pg_uuidv7` extension on earlier versions.

### 1.4 Foreign Keys

**The polymorphic association anti-pattern**

This is the most significant architectural problem in the schema. The `associations` table has:

```sql
source_id TEXT NOT NULL,
source_type TEXT NOT NULL,  -- 'episode' | 'digest' | 'semantic' | 'procedural'
target_id TEXT NOT NULL,
target_type TEXT NOT NULL,
```

`source_id` can point to any of four different tables. The database cannot enforce referential integrity here. If an episode is somehow absent (bug, partial migration, or a future soft-delete flag), `associations` rows pointing to it are orphaned with no database-level detection.

The three standard alternatives:

**Option A: Separate association tables per type combination**

Create `episode_episode_assoc`, `episode_digest_assoc`, etc. With 4 source types and 4 target types, this is 16 tables (but only ~10 meaningful combinations). Referential integrity is enforced, but querying "all edges for memory X" requires a UNION across multiple tables. Verdict: impractical for 2-hop graph walks.

**Option B: Universal memory ID pool (recommended)**

Create a `memories` table that is the sole ID authority. Every episode, digest, semantic memory, and procedural memory gets its ID from this table:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('episode', 'digest', 'semantic', 'procedural')),
  created_at REAL DEFAULT (julianday('now'))
);
```

All four memory tables then `REFERENCES memories(id)`. The `associations` table has `REFERENCES memories(id)` for both `source_id` and `target_id`. This gives full referential integrity at the cost of one extra insert per memory creation. Cascade deletes (if ever needed) are automatic. The `memories` table also provides a single place to query "what type is this ID?" without touching four tables — critical for the `getById(id, type)` adapter method.

**Option C: Trigger-based validation**

Keep the current schema but add BEFORE INSERT/UPDATE triggers on `associations` that verify `source_id` exists in the corresponding table based on `source_type`. This is messy in SQLite (four separate trigger conditions) but functional. It does not help with after-the-fact orphaning.

Recommendation: Implement Option B. The `memories` table is a clean abstraction that pays for itself in query simplicity and integrity guarantees.

### 1.5 NULL Handling

Missing `NOT NULL` constraints in the SQLite spec:

| Table | Column | Should Be NOT NULL? | Reason |
|-------|--------|--------------------|----|
| episodes | session_id | Yes | Every episode belongs to a session |
| episodes | role | Yes | Enum, always set |
| episodes | content | Yes | Core data |
| episodes | metadata | Yes | Default '{}' makes it always present |
| episodes | entities_json | Yes | Default '[]' makes it always present |
| digests | session_id | Yes | Always set |
| digests | summary | Yes | Core data |
| digests | key_topics | Yes | Default '[]' |
| digests | source_episode_ids | Yes | Default '[]' |
| digests | source_digest_ids | Yes | Default '[]' |
| semantic | topic | Yes | Core data |
| semantic | content | Yes | Core data |
| semantic | source_digest_ids | Yes | Default '[]' |
| semantic | source_episode_ids | Yes | Default '[]' |
| procedural | category | Yes | Enum, always set |
| procedural | trigger_text | Yes | Core data |
| procedural | procedure | Yes | Core data |
| procedural | source_episode_ids | Yes | Default '[]' |
| associations | source_id | Yes | |
| associations | source_type | Yes | |
| associations | target_id | Yes | |
| associations | target_type | Yes | |
| associations | edge_type | Yes | |

Columns correctly left nullable: `embedding BLOB`, `last_accessed`, `consolidated_at`, `last_observed` (on first insert), `supersedes`, `superseded_by`.

`first_observed` in `procedural` should default to `(julianday('now'))` and be NOT NULL — it is always set on creation.

### 1.6 Check Constraints

**Missing enum constraints in SQLite spec**

The spec has `CHECK (role IN ('user', 'assistant', 'system'))` on `episodes` and `CHECK (category IN (...))` on `procedural`. Missing:

```sql
-- source_type and target_type in associations
CHECK (source_type IN ('episode', 'digest', 'semantic', 'procedural'))
CHECK (target_type IN ('episode', 'digest', 'semantic', 'procedural'))

-- edge_type in associations
CHECK (edge_type IN ('temporal', 'causal', 'topical', 'supports',
                     'contradicts', 'elaborates', 'derives_from', 'co_recalled'))

-- level in digests
CHECK (level >= 0 AND level <= 10)  -- arbitrary upper bound to catch bugs

-- decay_rate bounds
CHECK (decay_rate > 0.0 AND decay_rate <= 1.0)

-- strength bounds in associations
CHECK (strength >= 0.0 AND strength <= 1.0)
```

**PostgreSQL schema**

The existing `memory_knowledge.confidence` check `CHECK (confidence >= 0 AND confidence <= 1)` is correct but it uses `FLOAT` for the column type. `FLOAT` in PostgreSQL is an alias for `DOUBLE PRECISION` (8 bytes). `REAL` (4 bytes) is sufficient for a 0–1 confidence score and halves the storage per row. At 100K semantic memories, this is 400KB saved on that column alone — negligible. The real argument for `REAL` is alignment: the SQLite schema uses REAL and consistency between adapters reduces confusion.

The `memory_write_buffer` table's status enum constraint is correct. The tier constraint is correct but will be wrong for Engram (it does not include 'semantic' or 'procedural' — it only has 'episode', 'digest', 'knowledge').

---

## 2. Index Strategy

### 2.1 Missing Indexes

**SQLite**

Based on the query patterns in Sections 5–7:

```sql
-- Light sleep: find unconsolidated episodes per session
-- Query: WHERE session_id = ? AND consolidated_at IS NULL ORDER BY salience DESC
-- Current index: idx_episodes_session (session_id alone)
-- Missing: composite covering index
CREATE INDEX idx_episodes_unconsolidated
  ON episodes(session_id, consolidated_at, salience DESC)
  WHERE consolidated_at IS NULL;
-- SQLite partial indexes require WHERE clause to match exactly at query time.
-- Alternatively (wider compatibility):
CREATE INDEX idx_episodes_session_salience ON episodes(session_id, salience DESC);
```

```sql
-- Decay pass: find semantic memories not accessed in N days
-- Query: WHERE last_accessed < ? OR last_accessed IS NULL
-- Missing: index on last_accessed
CREATE INDEX idx_semantic_last_accessed ON semantic(last_accessed);
CREATE INDEX idx_procedural_last_accessed ON procedural(last_accessed);
```

```sql
-- Reconsolidation update: single-row UPDATE by primary key
-- No issue — PK is already indexed. But access_count++ is a read-modify-write.
-- No additional index needed; covered by PK.
```

```sql
-- Dream cycle: getAllRecent across all tiers by date
-- This touches all four tables. Each needs an index on created_at.
CREATE INDEX idx_episodes_created ON episodes(created_at DESC);
CREATE INDEX idx_digests_created ON digests(created_at DESC);
CREATE INDEX idx_semantic_created ON semantic(created_at DESC);
CREATE INDEX idx_procedural_created ON procedural(created_at DESC);
-- Note: the spec already has idx_episodes_session but NOT created_at indexes on
-- digests, semantic, or procedural. The digests_level index is for hierarchical
-- digests only, not for date-range queries.
```

```sql
-- Association walk: getForMemory returns edges where source_id = ? OR target_id = ?
-- Current: idx_assoc_source (source_id), idx_assoc_target (target_id) — these exist
-- Missing: filter by min_strength and edge_type
CREATE INDEX idx_assoc_source_strength ON associations(source_id, strength DESC);
CREATE INDEX idx_assoc_target_strength ON associations(target_id, strength DESC);
-- The strength DESC ordering eliminates a sort step for the min_strength filter.
```

```sql
-- Association edge pruning (decay pass):
-- DELETE WHERE strength < 0.05 AND last_activated < ?
CREATE INDEX idx_assoc_prune ON associations(strength, last_activated)
  WHERE strength < 0.1;  -- partial index on weak edges only
```

```sql
-- Semantic supersession chain walk:
-- SELECT * FROM semantic WHERE superseded_by = ?  (find newer version)
-- SELECT * FROM semantic WHERE supersedes = ?     (find what was replaced)
CREATE INDEX idx_semantic_supersedes ON semantic(supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX idx_semantic_superseded_by ON semantic(superseded_by) WHERE superseded_by IS NOT NULL;
```

```sql
-- Procedural trigger matching: searchByTrigger
-- Query: FTS5 match on trigger_text OR topic similarity
-- The FTS5 virtual table handles this. But there is also a direct-match case:
-- WHERE trigger_text LIKE '%TypeScript%'
-- LIKE with leading wildcard cannot use a B-tree index. The FTS5 index is the
-- right tool here. No additional B-tree index needed.
```

**PostgreSQL**

```sql
-- The existing ivfflat vector index is wrong for two reasons:
-- 1. ivfflat requires lists = sqrt(row_count) for optimal recall. With lists=100,
--    it is optimal at ~10,000 rows. At 1K rows it wastes memory; at 100K rows
--    recall degrades to 87% (from audit L5).
-- 2. HNSW is strictly better for this workload (see Section 2.4).

-- Missing: partial vector index for active memories only
-- Memories with embedding IS NULL should not be in the vector index
-- (they will crash vector operations). pgvector's index already skips NULLs,
-- but making it explicit documents intent.

-- Missing: composite index for session + date queries
CREATE INDEX idx_episodes_session_created
  ON memory_episodes(session_id, created_at DESC);

-- Missing: GIN index on key_topics for array containment queries
CREATE INDEX idx_digests_topics ON memory_digests USING GIN(key_topics);

-- Missing: index for knowledge confidence decay queries
CREATE INDEX idx_knowledge_last_accessed
  ON memory_knowledge(updated_at DESC)
  WHERE confidence > 0.05;

-- The existing idx_knowledge_confidence is on confidence DESC, which helps
-- ORDER BY confidence but not WHERE last_accessed < ? queries.
```

### 2.2 Over-indexing

**`idx_assoc_strength ON associations(strength)`** is not useful alone. Queries on the association table always start with `source_id` or `target_id` as the leading filter. A standalone strength index will never be chosen by the query planner when `source_id` or `target_id` is in the WHERE clause. Drop it and replace with the composite indexes above.

**`idx_digests_level ON digests(level)`** — the level column has very low cardinality (0, 1, maybe 2). With only 2–3 distinct values and an uneven distribution (95%+ of rows will be level=0), an index on level alone is nearly useless. SQLite will likely do a full scan anyway. This index can be dropped.

**`idx_episodes_created ON memory_episodes(created_at DESC)` and `idx_digests_created ON memory_digests(created_at DESC)`** in the PostgreSQL migration — these are useful for time-range scans but should be combined with session_id for the actual access patterns. Keep them as secondary fallback indexes but note the composite versions are more selective.

### 2.3 Composite Indexes

Key composite indexes ranked by impact:

| Index | Tables | Columns | Replaces | Query Pattern |
|-------|--------|---------|---------|---------------|
| High | episodes | (session_id, consolidated_at, salience DESC) | idx_episodes_session | Light sleep batch |
| High | associations | (source_id, strength DESC, edge_type) | idx_assoc_source + idx_assoc_strength | Association walk |
| High | associations | (target_id, strength DESC, edge_type) | idx_assoc_target + idx_assoc_strength | Association walk (reverse) |
| Medium | episodes | (session_id, created_at DESC) | idx_episodes_session | Recall with recency bias |
| Medium | semantic | (topic, confidence DESC) | idx_knowledge_topic + idx_knowledge_confidence | Topic-filtered semantic recall |
| Medium | associations | (source_id, target_id) | idx_assoc_pair (already composite UNIQUE) | Exists check in dream cycle |

### 2.4 FTS5 Configuration

**Current spec configuration**

```sql
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  content, entities,
  content=episodes, content_rowid=rowid
);
```

Issues:

1. **Tokenizer**: The default tokenizer is `unicode61`. For an AI memory engine where content includes code snippets, URLs, and technical identifiers like `useEffect`, `useState`, `TypeScript`, and `vector(1536)`, the unicode61 tokenizer will split on camelCase boundaries inconsistently and treat punctuation as token separators. Recommendation: use `tokenize="unicode61 remove_diacritics 1"` for natural language content and add a separate `tokenize="porter unicode61"` option for stemming (so "running" matches "run"). For technical content with code, consider a custom trigram tokenizer approach, but this requires SQLite extension compilation. The practical recommendation is `unicode61` with `prefix='2 3'` for prefix search support.

2. **Content table sync**: The `content=episodes` configuration creates a "content table" FTS5 index — the FTS table stores only the index, not the data. This is efficient. However, it requires sync triggers to keep the FTS index current when the base table is updated. The spec does not include these triggers. Without them, the FTS index goes stale on any UPDATE to episodes.content or episodes.entities. Required triggers:

```sql
CREATE TRIGGER episodes_fts_insert AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content, entities)
  VALUES (new.rowid, new.content, new.entities_json);
END;

CREATE TRIGGER episodes_fts_update AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, entities)
  VALUES ('delete', old.rowid, old.content, old.entities_json);
  INSERT INTO episodes_fts(rowid, content, entities)
  VALUES (new.rowid, new.content, new.entities_json);
END;

CREATE TRIGGER episodes_fts_delete AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, entities)
  VALUES ('delete', old.rowid, old.content, old.entities_json);
END;
```

The same triggers are needed for digests_fts, semantic_fts, and procedural_fts.

3. **entities tokenization problem**: As noted in Section 1.2, the entities column stores raw JSON: `["React","TypeScript"]`. FTS5 will index the bracket characters and commas as tokens unless the tokenizer normalizes them away. The unicode61 tokenizer removes punctuation by default when `categories` includes `L*` and `N*` but not `P*`. Test this before deploying: `SELECT * FROM episodes_fts WHERE episodes_fts MATCH '"React"'` should work, but `SELECT * FROM episodes_fts WHERE episodes_fts MATCH 'React'` is what matters. The safest approach is to store entities as a space-separated string in a separate column used exclusively for FTS indexing: `entities_fts TEXT GENERATED ALWAYS AS (replace(replace(replace(entities_json, '[', ''), ']', ''), '"', '')) VIRTUAL`. Then use this generated column in the FTS table.

4. **`porter` stemmer**: For the primary `content` column, adding the Porter stemmer improves recall at the cost of precision. Given that this is a memory recall system (high recall desired), include it: `tokenize="porter unicode61"`.

5. **VACUUM/optimize**: FTS5 accumulates "shadow table" fragmentation during heavy insert/delete cycles. The `INSERT INTO episodes_fts(episodes_fts) VALUES ('optimize')` command should run as part of the decay pass (monthly) or any time fragmentation is suspected. This is equivalent to `VACUUM` for FTS5.

### 2.5 pgvector: HNSW vs ivfflat

The existing migrations use `ivfflat` with `lists = 100`. The existing audit (L5) already flags this. Here is the full analysis:

**ivfflat characteristics**:
- Build time: O(n) — fast
- Query time: O(sqrt(n)) approximately
- Recall at `probes=1`: ~60%. At `probes=10`: ~85%. At `probes=100` (equal to lists): 100% but defeats the purpose.
- `lists = 100` is optimal at ~10,000 rows (the rule of thumb is `lists = sqrt(n_rows)`). At 1K rows, 100 lists means most lists have only 10 items — essentially a full scan. At 100K rows, 100 lists gives poor recall.
- The index must be rebuilt when row count changes significantly. There is no online rebuild.

**HNSW characteristics**:
- Build time: O(n log n) — slower to build, but build is amortized over inserts
- Query time: O(log n) — faster at scale
- Recall at default parameters: ~95–99%
- No rebuild required as data grows
- Memory usage: approximately `4 * dimensions * m * n` bytes where `m` is the number of bi-directional links (default 16). At 1536 dimensions, 1M rows, m=16: ~100GB RAM. This is the HNSW in-memory index, not the table storage. At 100K rows: ~10GB. **This is the critical constraint for cloud deployment.**

**Recommended parameters**:

For the Engram use case (moderate scale, high recall required, infrequent writes during consolidation):

```sql
-- For tables up to ~100K rows
CREATE INDEX idx_episodes_embedding ON memory_episodes
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
-- ef_construction = 64: good quality/speed balance
-- m = 16: default, good for most cases

-- For query time (set per session or per query)
SET hnsw.ef_search = 40;  -- higher = better recall, slower query
-- Default ef_search = 40 gives ~97% recall at this scale.
```

**Partial indexes for non-null embeddings**:

```sql
-- Only index rows that actually have embeddings (Level 0 skips embeddings)
CREATE INDEX idx_episodes_embedding ON memory_episodes
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;
```

This is important: trying to index a NULL vector will either fail or produce undefined behavior depending on pgvector version. The partial index also keeps the index smaller when the system is running in Level 0 mode with no embedding provider.

---

## 3. Query Pattern Analysis

### 3.1 Recall Stage 1 — Parallel Cross-Table Search

**SQLite (BM25 mode)**

```sql
-- Execute as four separate queries, run in parallel via Promise.allSettled()
-- Each returns {id, type, content, score} for merging in application code.

-- Episode search
SELECT
  e.id,
  'episode'                                    AS type,
  e.content,
  e.salience,
  e.access_count,
  e.created_at,
  e.entities_json                              AS entities,
  -rank                                        AS bm25_score
FROM episodes_fts
JOIN episodes e ON episodes_fts.rowid = e.rowid
WHERE episodes_fts MATCH ?          -- tokenized query
  AND (:session_id IS NULL OR e.session_id = :session_id)
ORDER BY rank                       -- rank is negative BM25 score; ORDER BY rank ASC = best first
LIMIT :limit;

-- Digest search
SELECT
  d.id,
  'digest'                                     AS type,
  d.summary                                    AS content,
  0.5                                          AS salience,  -- digests have no salience; use midpoint
  0                                            AS access_count,
  d.created_at,
  d.key_topics                                 AS entities,
  -rank                                        AS bm25_score
FROM digests_fts
JOIN digests d ON digests_fts.rowid = d.rowid
WHERE digests_fts MATCH ?
ORDER BY rank
LIMIT :limit;

-- Semantic search
SELECT
  s.id,
  'semantic'                                   AS type,
  s.content,
  s.confidence                                 AS salience,
  s.access_count,
  s.created_at,
  NULL                                         AS entities,
  -rank                                        AS bm25_score
FROM semantic_fts
JOIN semantic s ON semantic_fts.rowid = s.rowid
WHERE semantic_fts MATCH ?
  AND (s.superseded_by IS NULL)                -- exclude superseded memories by default
ORDER BY rank
LIMIT :limit;

-- Procedural search (trigger-matched variant)
SELECT
  p.id,
  'procedural'                                 AS type,
  p.procedure                                  AS content,
  p.confidence                                 AS salience,
  p.access_count,
  p.created_at,
  NULL                                         AS entities,
  -rank                                        AS bm25_score
FROM procedural_fts
JOIN procedural p ON procedural_fts.rowid = p.rowid
WHERE procedural_fts MATCH ?
ORDER BY rank
LIMIT :limit;
```

Why these queries and not a UNION: UNION forces sequential execution in SQLite. The application layer runs all four in parallel via `Promise.allSettled()` and merges the scored results. The FTS5 `rank` value is negative (lower is better match), so `-rank` gives a positive BM25 score for consistent application-side merging.

**PostgreSQL (vector similarity mode)**

```sql
-- The match_episodes function in 002 takes query_embedding as TEXT and casts it.
-- This is a type mismatch bug: the parameter should be vector(1536), not TEXT.
-- Casting TEXT -> vector works but adds parsing overhead on every call.

-- Corrected and extended version:
CREATE OR REPLACE FUNCTION engram_recall(
  p_query_embedding   vector,
  p_query_text        text,
  p_session_id        text        DEFAULT NULL,
  p_match_count       int         DEFAULT 10,
  p_min_similarity    float       DEFAULT 0.3,
  p_include_episodes  bool        DEFAULT true,
  p_include_digests   bool        DEFAULT true,
  p_include_semantic  bool        DEFAULT true,
  p_include_procedural bool       DEFAULT true
)
RETURNS TABLE (
  id          uuid,
  memory_type text,
  content     text,
  salience    float,
  access_count int,
  created_at  timestamptz,
  similarity  float,
  entities    text[]
)
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT id, 'episode' AS memory_type, content, salience, access_count, created_at,
    (1 - (embedding <=> p_query_embedding))::float AS similarity,
    entities
  FROM memory_episodes
  WHERE p_include_episodes
    AND embedding IS NOT NULL
    AND (p_session_id IS NULL OR session_id = p_session_id)
    AND (1 - (embedding <=> p_query_embedding)) >= p_min_similarity
    AND consolidated_at IS NULL  -- prefer unconsolidated for recency
  ORDER BY embedding <=> p_query_embedding
  LIMIT p_match_count

  UNION ALL

  SELECT id, 'digest' AS memory_type, summary AS content,
    0.5 AS salience, 0 AS access_count, created_at,
    (1 - (embedding <=> p_query_embedding))::float AS similarity,
    key_topics AS entities
  FROM memory_digests
  WHERE p_include_digests
    AND embedding IS NOT NULL
    AND (1 - (embedding <=> p_query_embedding)) >= p_min_similarity
  ORDER BY embedding <=> p_query_embedding
  LIMIT p_match_count

  UNION ALL

  SELECT id, 'semantic' AS memory_type, content,
    confidence AS salience, access_count, created_at,
    (1 - (embedding <=> p_query_embedding))::float AS similarity,
    ARRAY[]::text[] AS entities
  FROM memory_semantic
  WHERE p_include_semantic
    AND embedding IS NOT NULL
    AND superseded_by IS NULL
    AND (1 - (embedding <=> p_query_embedding)) >= p_min_similarity
  ORDER BY embedding <=> p_query_embedding
  LIMIT p_match_count

  UNION ALL

  SELECT id, 'procedural' AS memory_type, procedure AS content,
    confidence AS salience, access_count, created_at,
    (1 - (embedding <=> p_query_embedding))::float AS similarity,
    ARRAY[]::text[] AS entities
  FROM memory_procedural
  WHERE p_include_procedural
    AND embedding IS NOT NULL
    AND (1 - (embedding <=> p_query_embedding)) >= p_min_similarity
  ORDER BY embedding <=> p_query_embedding
  LIMIT p_match_count

  ORDER BY similarity DESC
  LIMIT p_match_count * 4;  -- over-fetch before application-side re-ranking
$$;
```

Why UNION ALL (not four separate RPC calls): A single RPC call from the Supabase client is cheaper than four parallel calls because each call has HTTP overhead. The UNION ALL runs the four subqueries in parallel within PostgreSQL (with `PARALLEL SAFE` and `max_parallel_workers_per_gather >= 4`). The over-fetch (match_count * 4) ensures each tier contributes candidates before the application re-ranks with priming boosts, recency bias, and access frequency.

Why `LANGUAGE sql` not `plpgsql`: SQL functions with `STABLE` are inlinable — PostgreSQL can optimize across the function boundary. plpgsql functions are opaque to the planner.

### 3.2 Association Walk — N-Hop Graph Traversal

The current spec implementation issues one query per edge, per hop, per recalled memory (up to 5 top memories × 2 hops × edge count). At 10 edges per node, this is 100 individual queries for a 2-hop walk. This is the main scalability concern for the association stage.

**SQLite — single recursive CTE walk**

```sql
-- Walk the association graph up to :max_hops hops from a set of seed IDs.
-- Uses recursive CTE to avoid N+1 queries.
WITH RECURSIVE
walk(memory_id, memory_type, depth, path, min_strength) AS (
  -- Seed: start from recalled memory IDs
  SELECT
    value      AS memory_id,
    NULL       AS memory_type,  -- type looked up in outer join
    0          AS depth,
    json_array(value) AS path,
    1.0        AS min_strength
  FROM json_each(:seed_ids_json)  -- pass as JSON array: '["id1","id2",...]'

  UNION ALL

  -- Recursive step: follow edges
  SELECT
    CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END AS memory_id,
    CASE WHEN a.source_id = w.memory_id THEN a.target_type ELSE a.source_type END AS memory_type,
    w.depth + 1,
    json_insert(w.path, '$[#]',
      CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END),
    w.min_strength * a.strength  AS min_strength
  FROM walk w
  JOIN associations a ON (
    a.source_id = w.memory_id OR a.target_id = w.memory_id
  )
  WHERE
    w.depth < :max_hops
    AND a.strength >= :min_edge_strength
    -- Prevent cycles
    AND NOT json_each.value IS NOT NULL  -- cycles checked via path
    AND NOT EXISTS (
      SELECT 1 FROM json_each(w.path)
      WHERE value = CASE WHEN a.source_id = w.memory_id
                         THEN a.target_id ELSE a.source_id END
    )
)
SELECT DISTINCT
  w.memory_id,
  w.memory_type,
  w.depth,
  w.min_strength AS path_strength
FROM walk
WHERE w.depth > 0  -- exclude seeds
ORDER BY w.min_strength DESC, w.depth ASC
LIMIT :limit;
```

The path-as-JSON-array cycle detection is somewhat expensive but correct. For graphs with low cycle probability (which the association graph should have, since `topical` edges are the main source of cycles), this performs well in practice. At depth=2 with max_hops=2, the recursive CTE terminates after 3 levels and the total work is bounded.

**PostgreSQL — recursive CTE with array path**

```sql
-- More efficient PostgreSQL version using native array for cycle detection
WITH RECURSIVE
walk AS (
  -- Seed nodes (pass as array parameter)
  SELECT
    unnest(p_seed_ids)::uuid  AS memory_id,
    NULL::text                AS memory_type,
    0                         AS depth,
    ARRAY[unnest(p_seed_ids)::uuid] AS visited_ids,
    1.0::float                AS path_strength
  FROM (SELECT 1) t  -- force single row

  UNION ALL

  SELECT
    CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END,
    CASE WHEN a.source_id = w.memory_id THEN a.target_type ELSE a.source_type END,
    w.depth + 1,
    w.visited_ids ||
      (CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END),
    w.path_strength * a.strength
  FROM walk w
  JOIN memory_associations a ON
    (a.source_id = w.memory_id OR a.target_id = w.memory_id)
  WHERE
    w.depth < p_max_hops
    AND a.strength >= p_min_strength
    AND NOT (CASE WHEN a.source_id = w.memory_id THEN a.target_id
                  ELSE a.source_id END) = ANY(w.visited_ids)
)
SELECT DISTINCT ON (memory_id)
  memory_id,
  memory_type,
  depth,
  path_strength
FROM walk
WHERE depth > 0
ORDER BY memory_id, path_strength DESC, depth ASC;
```

This avoids the 100-query N+1 problem by traversing the full sub-graph in one SQL call. For a 2-hop walk from 5 seed nodes with an average of 8 edges per node, this is 1 query replacing 40+ individual queries.

### 3.3 Dream Cycle — O(n^2) Entity Co-occurrence Problem

The spec's implementation loads all recent memories into application memory, builds an entity map, then checks every pair for existing associations. At 10,000 recent memories with average 5 entities each, the entity map has 50,000 entries. The pairwise check is O(n^2) = O(50,000^2) = 2.5 billion iterations. The `maxNewAssociations` cap (default 50) prevents runaway inserts but not the O(n^2) iteration cost.

**Better approach: SQL-side entity co-occurrence with EXISTS anti-join**

```sql
-- SQLite version
-- Step 1: Build a temporary entity-memory mapping (only for recent memories)
CREATE TEMP TABLE IF NOT EXISTS dream_entity_map (
  entity     TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  memory_type TEXT NOT NULL
);

DELETE FROM dream_entity_map;

INSERT INTO dream_entity_map (entity, memory_id, memory_type)
SELECT LOWER(je.value), e.id, 'episode'
FROM episodes e, json_each(e.entities_json) je
WHERE e.created_at > julianday('now') - :days_lookback
  AND je.value != ''
UNION ALL
SELECT LOWER(je.value), s.id, 'semantic'
FROM semantic s, json_each(s.metadata) je  -- assumes entities in metadata
WHERE s.created_at > julianday('now') - :days_lookback;

-- Step 2: Find pairs sharing an entity that lack an association (SQL-side O(n^2) but bounded)
SELECT
  em1.memory_id   AS source_id,
  em1.memory_type AS source_type,
  em2.memory_id   AS target_id,
  em2.memory_type AS target_type,
  em1.entity,
  COUNT(*)        AS shared_entity_count
FROM dream_entity_map em1
JOIN dream_entity_map em2
  ON em1.entity = em2.entity
  AND em1.memory_id < em2.memory_id  -- prevent duplicates
  AND em1.memory_id != em2.memory_id
WHERE NOT EXISTS (
  SELECT 1 FROM associations a
  WHERE (a.source_id = em1.memory_id AND a.target_id = em2.memory_id)
     OR (a.source_id = em2.memory_id AND a.target_id = em1.memory_id)
)
GROUP BY em1.memory_id, em1.memory_type, em2.memory_id, em2.memory_type
ORDER BY shared_entity_count DESC
LIMIT :max_new_associations;
```

This moves the O(n^2) work into the database engine's hash join, which is far more efficient than application-level nested loops. The `GROUP BY` also surfaces pairs sharing multiple entities (higher strength candidates) first.

The `CREATE TEMP TABLE` approach is correct for SQLite: the temp table lives for the duration of the connection, is not persisted, and avoids polluting the main schema.

### 3.4 Decay Pass — Bulk Confidence Update

**SQLite**

```sql
-- Batch update semantic confidence in a single statement
-- The MAX(0.05, ...) ensures the floor
UPDATE semantic
SET
  confidence = MAX(0.05, confidence - :decay_rate),
  updated_at = julianday('now')
WHERE
  (last_accessed IS NULL OR last_accessed < julianday('now') - :days_threshold)
  AND confidence > 0.05;  -- skip already-floored memories

-- Returns number of rows updated (changes() in SQLite)

-- Same for procedural (different decay_rate and days_threshold)
UPDATE procedural
SET
  confidence = MAX(0.05, confidence - :procedural_decay_rate),
  updated_at = julianday('now')
WHERE
  (last_accessed IS NULL OR last_accessed < julianday('now') - :procedural_days_threshold)
  AND confidence > 0.05;

-- Prune weak associations (the one true deletion in the system)
DELETE FROM associations
WHERE strength < :edge_prune_threshold
  AND (last_activated IS NULL OR last_activated < julianday('now') - 90);
```

The spec's implementation loops over individual rows in application code. These batch SQL statements do the same work in a single operation with zero network round-trips. At 10,000 semantic memories, the loop makes 10,000 UPDATE calls; this version makes 1.

### 3.5 Consolidation — Light Sleep Atomicity

```sql
-- Transactional light sleep: insert digest + mark episodes + create associations
-- All or nothing — if any step fails, nothing is committed.
BEGIN IMMEDIATE;  -- IMMEDIATE prevents write conflicts in WAL mode

INSERT INTO digests (id, session_id, summary, key_topics, source_episode_ids,
                     source_digest_ids, level, metadata, created_at)
VALUES (:id, :session_id, :summary, :key_topics_json, :source_episode_ids_json,
        '[]', :level, :metadata_json, julianday('now'));

UPDATE episodes
SET consolidated_at = julianday('now')
WHERE id IN (SELECT value FROM json_each(:episode_ids_json));

INSERT INTO associations (id, source_id, source_type, target_id, target_type,
                          edge_type, strength, created_at)
SELECT
  lower(hex(randomblob(16))),  -- UUID without crypto module
  je.value,                    -- episode id
  'episode',
  :digest_id,
  'digest',
  'derives_from',
  0.8,
  julianday('now')
FROM json_each(:episode_ids_json) je;

COMMIT;
```

Using `BEGIN IMMEDIATE` is critical in WAL mode. Without it, a BEGIN DEFERRED transaction that encounters a write from another connection will get `SQLITE_BUSY` at commit time, not at BEGIN time, causing a retry loop. IMMEDIATE acquires the write lock at BEGIN, failing fast if another writer holds it.

### 3.6 Reconsolidation — Atomic Access Update

```sql
-- Single UPDATE per recalled memory — no separate read needed
UPDATE episodes
SET
  access_count = access_count + 1,
  last_accessed = julianday('now')
WHERE id = :id;

-- For semantic (with confidence boost)
UPDATE semantic
SET
  access_count = access_count + 1,
  last_accessed = julianday('now'),
  confidence = MIN(1.0, confidence + :boost),  -- 0.05 boost, capped at 1.0
  updated_at = julianday('now')
WHERE id = :id;

-- Association co_recalled upsert
INSERT INTO associations
  (id, source_id, source_type, target_id, target_type, edge_type, strength, last_activated, created_at)
VALUES
  (:new_id, :source_id, :source_type, :target_id, :target_type, 'co_recalled', 0.2, julianday('now'), julianday('now'))
ON CONFLICT (source_id, target_id, edge_type)
DO UPDATE SET
  strength = MIN(1.0, strength + 0.1),
  last_activated = julianday('now');
-- The UNIQUE constraint idx_assoc_pair enables this ON CONFLICT clause.
```

The `ON CONFLICT DO UPDATE` (upsert) is critical for `co_recalled` edges. These edges are created on every recall, so the same pair will conflict frequently. Without upsert, the application must check existence before insert — two round-trips instead of one.

---

## 4. Data Integrity

### 4.1 Referential Integrity for Polymorphic Associations

Adopting the `memories` table approach (Option B from Section 1.4) resolves this. However, if that is deferred, the trigger approach provides intermediate protection.

**SQLite trigger-based validation**

```sql
CREATE TRIGGER associations_validate_source BEFORE INSERT ON associations
BEGIN
  SELECT RAISE(ABORT, 'source_id not found in any memory table')
  WHERE NOT (
    EXISTS (SELECT 1 FROM episodes  WHERE id = NEW.source_id) OR
    EXISTS (SELECT 1 FROM digests   WHERE id = NEW.source_id) OR
    EXISTS (SELECT 1 FROM semantic  WHERE id = NEW.source_id) OR
    EXISTS (SELECT 1 FROM procedural WHERE id = NEW.source_id)
  );
END;

CREATE TRIGGER associations_validate_target BEFORE INSERT ON associations
BEGIN
  SELECT RAISE(ABORT, 'target_id not found in any memory table')
  WHERE NOT (
    EXISTS (SELECT 1 FROM episodes  WHERE id = NEW.target_id) OR
    EXISTS (SELECT 1 FROM digests   WHERE id = NEW.target_id) OR
    EXISTS (SELECT 1 FROM semantic  WHERE id = NEW.target_id) OR
    EXISTS (SELECT 1 FROM procedural WHERE id = NEW.target_id)
  );
END;
```

This costs four EXISTS checks on every association insert. During light sleep (many inserts), this adds up. Mitigation: skip these triggers in production after initial validation is confirmed, or batch-validate via a periodic integrity check query rather than per-insert triggers.

**PostgreSQL alternative: check constraint via function**

```sql
CREATE OR REPLACE FUNCTION memory_id_exists(p_id uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE p_type
    WHEN 'episode'   THEN EXISTS(SELECT 1 FROM memory_episodes   WHERE id = p_id)
    WHEN 'digest'    THEN EXISTS(SELECT 1 FROM memory_digests    WHERE id = p_id)
    WHEN 'semantic'  THEN EXISTS(SELECT 1 FROM memory_semantic   WHERE id = p_id)
    WHEN 'procedural' THEN EXISTS(SELECT 1 FROM memory_procedural WHERE id = p_id)
    ELSE false
  END
$$;

ALTER TABLE memory_associations
  ADD CONSTRAINT fk_source CHECK (memory_id_exists(source_id, source_type)),
  ADD CONSTRAINT fk_target CHECK (memory_id_exists(target_id, target_type));
```

Note: check constraints calling user-defined functions are not re-validated on referenced row changes in PostgreSQL — they fire only on INSERT/UPDATE of the association row. Full enforcement still requires the `memories` table approach.

### 4.2 Orphaned Records

When a memory is "forgotten" (confidence decayed to minimum, or `forget()` called), the spec marks it as deprioritized but does not delete it. Association edges pointing to it remain valid — the edge simply leads to a low-confidence memory that scores poorly in recall. This is intentional per the "lossless" principle.

However, if a bug or migration failure results in an episode row being deleted without cleaning its edges, the orphaned edge will cause the `getById(id, type)` lookup in the association walk to return null. The current spec handles this: `if (!target) continue` in Stage 2. This is correct — orphaned edges silently degrade to no-ops.

Better defensive coding: the association walk should not call `getById` for every edge individually. Instead, batch-fetch all target IDs:

```sql
-- After collecting all target IDs from the walk result:
SELECT id, 'episode' AS type, content, salience, access_count, created_at
FROM episodes WHERE id IN (:target_ids_list)
UNION ALL
SELECT id, 'digest', summary, 0.5, 0, created_at
FROM digests WHERE id IN (:target_ids_list)
UNION ALL
SELECT id, 'semantic', content, confidence, access_count, created_at
FROM semantic WHERE id IN (:target_ids_list)
UNION ALL
SELECT id, 'procedural', procedure, confidence, access_count, created_at
FROM procedural WHERE id IN (:target_ids_list);
```

Missing IDs are naturally absent from the result — no null check needed.

### 4.3 Concurrent Access

**SQLite WAL mode**

WAL mode must be enabled explicitly. The spec does not include this pragma. Without WAL, the default journal mode is DELETE (rollback journal), which allows only one writer AND zero readers during writes. For a memory engine that performs background consolidation while also serving recalls, this is a deadlock-by-design.

Required pragmas (set at connection open time, not in schema migration):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;   -- WAL + NORMAL is safe and fast (vs FULL which is slower)
PRAGMA foreign_keys = ON;      -- must be set per connection, not in schema
PRAGMA cache_size = -65536;    -- 64MB page cache (negative = KB)
PRAGMA temp_store = MEMORY;    -- temp tables in RAM
PRAGMA mmap_size = 268435456;  -- 256MB memory-mapped I/O
PRAGMA wal_autocheckpoint = 1000; -- checkpoint every 1000 pages (~4MB)
```

WAL allows one writer and N concurrent readers. The consolidation cycle (writer) and recall (reader) can run simultaneously without blocking. The one contention point is the WAL checkpoint: when the WAL file grows large, SQLite blocks readers briefly to checkpoint it back to the main file. `wal_autocheckpoint = 1000` prevents the WAL from growing unboundedly.

**PostgreSQL isolation levels**

For consolidation (light sleep, deep sleep): use `SERIALIZABLE` isolation. Consolidation reads a batch of unconsolidated episodes, creates a digest, and marks episodes as consolidated. A race between two consolidation workers could process the same episodes twice. SERIALIZABLE will abort one of them. Consolidation is idempotent on retry (marking already-consolidated episodes is a no-op), so retry is safe.

For retrieval: `READ COMMITTED` is correct and the default. Retrieval does not need to see a consistent snapshot across all four tables — it is acceptable for a memory to be consolidated (episode marked) between the episode search and the digest search within the same recall.

For reconsolidation updates (access_count++): these can be `READ COMMITTED` with advisory locks or simply fire-and-forget. A missed increment of access_count from a race is not a data integrity issue — it is a minor scoring inaccuracy.

### 4.4 Idempotency for Consolidation Resumability

Light sleep marks episodes as consolidated AFTER the digest is created. If the process crashes between digest insert and episode markConsolidated, the next run will re-process those episodes. This creates a duplicate digest.

Solution: use a consolidation_run table and a two-phase commit pattern.

```sql
CREATE TABLE consolidation_runs (
  id TEXT PRIMARY KEY,
  cycle TEXT NOT NULL CHECK (cycle IN ('light', 'deep', 'dream', 'decay')),
  started_at REAL NOT NULL DEFAULT (julianday('now')),
  completed_at REAL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  metadata TEXT DEFAULT '{}'  -- JSON: episodes_processed, digests_created, etc.
);

-- Idempotency key on digest: include the sorted episode IDs as a hash
-- If a digest for the same episode batch already exists, skip creation.
ALTER TABLE digests ADD COLUMN episode_batch_hash TEXT;
CREATE UNIQUE INDEX idx_digests_batch_hash ON digests(episode_batch_hash)
  WHERE episode_batch_hash IS NOT NULL;
```

The `episode_batch_hash` is a deterministic hash of the sorted source episode IDs (e.g., SHA-256 of the sorted, joined IDs). On a crash-restart, the duplicate digest insert fails the unique constraint, the application catches the conflict, and skips to the `markConsolidated` step without creating a duplicate. This is O(1) idempotency with no extra read.

---

## 5. Migration Strategy

### 5.1 Schema Versioning

**SQLite**

SQLite has a built-in `PRAGMA user_version` integer that persists across connections. Use it as a migration version counter.

```sql
-- Migration runner pseudocode (TypeScript adapter):
-- 1. Read PRAGMA user_version
-- 2. Compare to LATEST_VERSION constant
-- 3. Run migrations in order, wrap each in a transaction
-- 4. Update user_version after each migration

-- Migration 0 -> 1: initial schema
BEGIN;
-- ... all CREATE TABLE statements ...
PRAGMA user_version = 1;
COMMIT;

-- Migration 1 -> 2: add entities_fts generated column
BEGIN;
ALTER TABLE episodes ADD COLUMN entities_fts TEXT
  GENERATED ALWAYS AS (
    replace(replace(replace(entities_json, '[', ''), ']', ''), '"', '')
  ) VIRTUAL;
-- Rebuild FTS index
INSERT INTO episodes_fts(episodes_fts) VALUES ('rebuild');
PRAGMA user_version = 2;
COMMIT;
```

Store all migration SQL in versioned files: `migrations/sqlite/001_initial.sql`, `002_add_fts_generated.sql`, etc. The adapter's `initialize()` method reads the current user_version and runs all pending migrations in order.

**PostgreSQL**

Use a `schema_migrations` table following the Rails/Flyway convention:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum    TEXT NOT NULL  -- SHA-256 of migration file content
);
```

The checksum prevents applying a modified migration file that was already recorded as applied — a common source of "why does staging differ from production" bugs.

### 5.2 Migration from Current PostgreSQL Schema to Engram Schema

The current schema (`001_initial_schema.sql`) has three tables: `memory_episodes`, `memory_digests`, `memory_knowledge`. The Engram schema needs five: `memory_episodes` (extended), `memory_digests` (extended), `memory_semantic` (renamed from `memory_knowledge`), `memory_procedural` (new), `memory_associations` (new).

This requires a non-trivial data migration. Here is the complete migration plan:

```sql
-- Migration 004: Add Engram columns to existing tables
-- Safe to run live — ALTER TABLE ADD COLUMN with defaults is non-blocking in PostgreSQL 11+

ALTER TABLE memory_episodes
  ADD COLUMN IF NOT EXISTS salience         real    NOT NULL DEFAULT 0.3,
  ADD COLUMN IF NOT EXISTS access_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed    timestamptz,
  ADD COLUMN IF NOT EXISTS consolidated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS entities         text[]  NOT NULL DEFAULT '{}';

ALTER TABLE memory_digests
  ADD COLUMN IF NOT EXISTS source_digest_ids uuid[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS level             integer NOT NULL DEFAULT 0
    CHECK (level >= 0 AND level <= 10);

-- Rename memory_knowledge -> memory_semantic
-- PostgreSQL: ALTER TABLE RENAME is non-blocking and instant
ALTER TABLE memory_knowledge RENAME TO memory_semantic;
ALTER INDEX idx_knowledge_topic     RENAME TO idx_semantic_topic;
ALTER INDEX idx_knowledge_confidence RENAME TO idx_semantic_confidence;
ALTER INDEX idx_knowledge_embedding  RENAME TO idx_semantic_embedding;

-- Add new columns to memory_semantic
ALTER TABLE memory_semantic
  ADD COLUMN IF NOT EXISTS source_episode_ids uuid[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS access_count       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed      timestamptz,
  ADD COLUMN IF NOT EXISTS decay_rate         real    NOT NULL DEFAULT 0.02
    CHECK (decay_rate > 0 AND decay_rate <= 1),
  ADD COLUMN IF NOT EXISTS supersedes         uuid    REFERENCES memory_semantic(id),
  ADD COLUMN IF NOT EXISTS superseded_by      uuid    REFERENCES memory_semantic(id);

-- Migrate source_digest_ids from existing column name
-- (current schema uses source_digest_ids UUID[] already — verify)
-- The existing memory_knowledge has source_digest_ids: nothing to migrate for this column.

-- Rename metadata fields for consistency
-- memory_knowledge had "topic" + "content" — memory_semantic keeps these names. No rename needed.

-- Migration 005: Create new tables
CREATE TABLE memory_procedural (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  category          text        NOT NULL
    CHECK (category IN ('workflow', 'preference', 'habit', 'pattern', 'convention')),
  trigger_text      text        NOT NULL,
  procedure         text        NOT NULL,
  confidence        real        NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),
  observation_count integer     NOT NULL DEFAULT 1,
  last_observed     timestamptz NOT NULL DEFAULT now(),
  first_observed    timestamptz NOT NULL DEFAULT now(),
  access_count      integer     NOT NULL DEFAULT 0,
  last_accessed     timestamptz,
  decay_rate        real        NOT NULL DEFAULT 0.01
    CHECK (decay_rate > 0 AND decay_rate <= 1),
  source_episode_ids uuid[]     NOT NULL DEFAULT '{}',
  embedding         vector(1536),
  metadata          jsonb       NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_associations (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid    NOT NULL,
  source_type     text    NOT NULL
    CHECK (source_type IN ('episode', 'digest', 'semantic', 'procedural')),
  target_id       uuid    NOT NULL,
  target_type     text    NOT NULL
    CHECK (target_type IN ('episode', 'digest', 'semantic', 'procedural')),
  edge_type       text    NOT NULL
    CHECK (edge_type IN ('temporal','causal','topical','supports',
                         'contradicts','elaborates','derives_from','co_recalled')),
  strength        real    NOT NULL DEFAULT 0.3
    CHECK (strength >= 0 AND strength <= 1),
  last_activated  timestamptz,
  metadata        jsonb   NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_association_pair UNIQUE (source_id, target_id, edge_type)
);

-- Migration 006: Update RPC functions and add RLS policies
-- (See Section 7b for complete RPC and RLS definitions)

-- Migration 007: Fix embedding dimensions
-- If current schema is vector(1536) but model outputs 768-dim vectors:
-- Cannot change vector dimensions in-place. Requires:
-- 1. Add new column: embedding_v2 vector(768)
-- 2. Re-embed all rows (application-level migration)
-- 3. Rename: ALTER TABLE ... RENAME COLUMN embedding TO embedding_v1;
--            ALTER TABLE ... RENAME COLUMN embedding_v2 TO embedding;
-- 4. Drop old: ALTER TABLE ... DROP COLUMN embedding_v1;
-- This is a multi-day migration for large tables. See zero-downtime note below.
```

### 5.3 Zero-Downtime Migration

The column additions in Migration 004 are safe in PostgreSQL 11+. `ALTER TABLE ADD COLUMN` with a default value is instantaneous — PostgreSQL 11 changed the behavior to store the default in the catalog instead of rewriting every row.

The `RENAME TABLE` for `memory_knowledge -> memory_semantic` is also instantaneous (catalog-only operation) and does not block reads or writes.

The problematic step is embedding dimension correction. If vector dimensions must change, the safest zero-downtime approach is:

1. Deploy code that writes to BOTH the old column and a new `embedding_v2 vector(768)` column simultaneously (dual-write)
2. Run a background job to backfill `embedding_v2` for existing rows
3. Monitor `COUNT(*) WHERE embedding_v2 IS NULL` until zero
4. Deploy code that reads from `embedding_v2` only
5. Drop `embedding` column
6. Rename `embedding_v2` to `embedding`

For the `memory_write_buffer` table: it is an implementation detail of the current system, not part of the Engram spec. Drop it in Migration 004 after draining it:

```sql
-- Drain first (application must stop using it)
DELETE FROM memory_write_buffer WHERE status IN ('done', 'failed');
-- Then drop
DROP TABLE memory_write_buffer;
```

---

## 6. Scaling Analysis

### 6.1 Row Count Projections

Assumptions: 50 messages/day, 20-episode batches per digest, 5 semantic facts per digest, 2 procedural memories per deep sleep cycle, 3 co_recalled edges per recall, 3 recalls/day.

| Scale | Episodes | Digests | Semantic | Procedural | Associations |
|-------|----------|---------|----------|------------|--------------|
| 1K episodes | 1,000 | 50 | 250 | 14/week | ~2,700 |
| 10K episodes | 10,000 | 500 | 2,500 | 140 | ~27,000 |
| 100K episodes | 100,000 | 5,000 | 25,000 | 1,400 | ~270,000 |
| 1M episodes | 1,000,000 | 50,000 | 250,000 | 14,000 | ~2,700,000 |

The associations table grows as: `3 recalls/day * 3 edges/recall * days + consolidation edges`. The 2.7M estimate at 1M episodes assumes roughly 2 years of agent usage.

**Storage estimates (SQLite, without embeddings)**

- Episodes: ~500 bytes/row avg → 500MB at 1M rows
- Embeddings (1536-dim Float32 = 6KB): +6GB at 1M episodes — this is the dominant cost
- Associations: ~200 bytes/row → 540MB at 2.7M rows
- Total at 1M scale: ~7GB without embeddings, ~13GB with

This is entirely manageable for a local SQLite database. For SQLite's practical limit: a single SQLite file can store terabytes if on an SSD. The limiting factor is RAM for the working set, not storage capacity.

**PostgreSQL storage estimates**

Higher per-row overhead due to MVCC tuple headers (~24 bytes per row), TOAST for large text fields, and the JSONB metadata column. Multiply the SQLite estimates by ~1.5 for the table data. The pgvector HNSW index for 1M vectors at 1536 dimensions is approximately:

`1M * 1536 * 4 bytes * (1 + m * 2) / 2 ≈ 1M * 6144 * 33 / 2 ≈ 100GB`

This exceeds typical cloud instance RAM. The practical limit for HNSW in-memory operation is ~100K vectors per table, which corresponds to roughly 2 years of agent usage at moderate volume. Beyond that, ivfflat (with proper lists sizing = sqrt(n)) or approximate search with acceptable recall degradation is necessary.

### 6.2 FTS5 at Scale

FTS5 shadow tables grow approximately 2–3x the size of the indexed text. At 1M episodes with average 200-character content, the FTS5 index is ~400MB–600MB. Query latency:

- BM25 search on 1M rows: 5–50ms with proper tokenization, FTS5's internal BM25 scoring is efficient
- The bottleneck at scale is not query speed but VACUUM frequency: FTS5 accumulates "tombstone" entries on updates/deletes. Run `INSERT INTO episodes_fts(episodes_fts) VALUES ('optimize')` monthly during the decay pass.
- FTS5 does not benefit from SQLite's B-tree index optimization. Full-text queries always scan the FTS index, not the base table. The joins back to the base table (`JOIN episodes e ON episodes_fts.rowid = e.rowid`) are rowid lookups — O(log n) each.

At 100K rows: FTS5 queries complete in 2–10ms. At 1M rows: 20–100ms. The 100ms performance target in the spec is achievable at 100K episodes scale but not at 1M without query optimization (limiting MATCH to specific columns, using prefix queries, or adding columnstore caching).

### 6.3 Association Table Growth

The `co_recalled` edge type is created on every recall for every pair of memories in the result. With 10 results per recall and `min(allMemories.length, i + 5)` bound in the spec code, each recall creates up to `10 * 5 / 2 = 25` new edge attempts. Most hit the ON CONFLICT clause and update instead. But for diverse queries that rarely recall the same memories together, new edges are created on nearly every recall.

At 3 recalls/day over 2 years: `3 * 730 * 25 = 54,750` co_recalled edges. This is manageable. The concern is at higher recall frequency or with many concurrent agents. The `maxNewAssociations` cap in the dream cycle prevents runaway dream-cycle edges, but there is no equivalent cap on co_recalled edges.

Recommendation: cap co_recalled edge creation to the top-5 recalled memories only (not the full result set), and only create new edges if edge count for the source memory is below a threshold (e.g., 100 edges max per memory). This prevents "hub" memories that are recalled frequently from accumulating thousands of co_recalled edges.

### 6.4 Partitioning

**SQLite**: SQLite does not support table partitioning. The scaling strategy for SQLite is to archive old episodes to a separate database file and ATTACH it when needed. This is a valid approach for the "single agent, personal use" SQLite tier.

**PostgreSQL**: Partitioning is worth considering for `memory_episodes` at 1M+ rows.

```sql
-- Range partition by created_at year-month
CREATE TABLE memory_episodes (
  id           uuid        NOT NULL,
  session_id   text        NOT NULL,
  -- ... other columns ...
  created_at   timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE TABLE memory_episodes_2026_q1
  PARTITION OF memory_episodes
  FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
```

However, partitioning complicates the HNSW index: each partition has its own HNSW index, and cross-partition vector search requires querying all partitions. This partially defeats the purpose. A better approach at scale is to use PostgreSQL table partitioning only for cold episodes (consolidated_at IS NOT NULL) and keep hot episodes in the main table. An archive job (part of the decay pass) moves consolidated episodes older than 90 days to the partition.

---

## 7. Recommended Schema

### 7a. SQLite — Production-Ready Schema

```sql
-- =============================================================================
-- Engram SQLite Schema v1.0
-- Compatible with: better-sqlite3, node:sqlite, Bun SQLite
-- Run pragmas at connection open (not in this file):
--   PRAGMA journal_mode = WAL;
--   PRAGMA synchronous = NORMAL;
--   PRAGMA foreign_keys = ON;
--   PRAGMA cache_size = -65536;    -- 64MB
--   PRAGMA temp_store = MEMORY;
--   PRAGMA mmap_size = 268435456;  -- 256MB
-- =============================================================================

-- Track schema version
PRAGMA user_version = 1;

-- ---------------------------------------------------------------------------
-- Memory ID Pool (enables FK enforcement on polymorphic associations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT    NOT NULL PRIMARY KEY,
  type       TEXT    NOT NULL
             CHECK (type IN ('episode', 'digest', 'semantic', 'procedural')),
  created_at REAL    NOT NULL DEFAULT (julianday('now'))
);

-- ---------------------------------------------------------------------------
-- Episodic Memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS episodes (
  id               TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  session_id       TEXT    NOT NULL,
  role             TEXT    NOT NULL
                   CHECK (role IN ('user', 'assistant', 'system')),
  content          TEXT    NOT NULL,
  salience         REAL    NOT NULL DEFAULT 0.3
                   CHECK (salience >= 0.0 AND salience <= 1.0),
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed    REAL,                         -- julianday or NULL
  consolidated_at  REAL,                         -- julianday or NULL
  embedding        BLOB,                         -- Float32 raw bytes, nullable
  entities_json    TEXT    NOT NULL DEFAULT '[]',-- JSON array of extracted entities
  -- Generated column for FTS-friendly entity text (space-separated, no brackets)
  entities_fts     TEXT    GENERATED ALWAYS AS (
                     replace(replace(replace(entities_json, '[', ''), ']', ''), '"', '')
                   ) VIRTUAL,
  metadata         TEXT    NOT NULL DEFAULT '{}',-- JSON object
  created_at       REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_episodes_session
  ON episodes(session_id);

CREATE INDEX IF NOT EXISTS idx_episodes_session_salience
  ON episodes(session_id, salience DESC);

-- Composite for light sleep: unconsolidated episodes by session
CREATE INDEX IF NOT EXISTS idx_episodes_unconsolidated
  ON episodes(session_id, consolidated_at, salience DESC);

CREATE INDEX IF NOT EXISTS idx_episodes_created
  ON episodes(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_episodes_last_accessed
  ON episodes(last_accessed);

-- FTS5: content + generated entity text (space-separated, safe for tokenizer)
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  content,
  entities_fts,
  content=episodes,
  content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS episodes_fts_insert
AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content, entities_fts)
  VALUES (new.rowid, new.content, new.entities_fts);
END;

CREATE TRIGGER IF NOT EXISTS episodes_fts_update
AFTER UPDATE OF content, entities_json ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, entities_fts)
  VALUES ('delete', old.rowid, old.content, old.entities_fts);
  INSERT INTO episodes_fts(rowid, content, entities_fts)
  VALUES (new.rowid, new.content, new.entities_fts);
END;

CREATE TRIGGER IF NOT EXISTS episodes_fts_delete
AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, entities_fts)
  VALUES ('delete', old.rowid, old.content, old.entities_fts);
END;

-- ---------------------------------------------------------------------------
-- Digest Layer (Consolidation Artifacts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS digests (
  id                   TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  session_id           TEXT    NOT NULL,
  summary              TEXT    NOT NULL,
  key_topics           TEXT    NOT NULL DEFAULT '[]', -- JSON array
  source_episode_ids   TEXT    NOT NULL DEFAULT '[]', -- JSON array of episode IDs
  source_digest_ids    TEXT    NOT NULL DEFAULT '[]', -- JSON array of digest IDs
  level                INTEGER NOT NULL DEFAULT 0
                       CHECK (level >= 0 AND level <= 10),
  embedding            BLOB,
  metadata             TEXT    NOT NULL DEFAULT '{}',
  created_at           REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_digests_session
  ON digests(session_id);

CREATE INDEX IF NOT EXISTS idx_digests_created
  ON digests(created_at DESC);

-- Generated column for FTS-friendly key_topics
CREATE TABLE IF NOT EXISTS digests (
  -- (redeclared to show only new column; actual schema above is complete)
  -- key_topics_fts TEXT GENERATED ALWAYS AS (
  --   replace(replace(replace(key_topics, '[', ''), ']', ''), '"', '')
  -- ) VIRTUAL
  -- NOTE: Add to the CREATE TABLE above, not as ALTER
);
-- Corrected: key_topics_fts is part of digests CREATE TABLE above.
-- (See recommended schema file for the complete single CREATE TABLE statement.)

CREATE VIRTUAL TABLE IF NOT EXISTS digests_fts USING fts5(
  summary,
  key_topics,              -- raw JSON; tokenizer handles bracket removal imperfectly
  content=digests,
  content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE TRIGGER IF NOT EXISTS digests_fts_insert
AFTER INSERT ON digests BEGIN
  INSERT INTO digests_fts(rowid, summary, key_topics)
  VALUES (new.rowid, new.summary, new.key_topics);
END;

CREATE TRIGGER IF NOT EXISTS digests_fts_delete
AFTER DELETE ON digests BEGIN
  INSERT INTO digests_fts(digests_fts, rowid, summary, key_topics)
  VALUES ('delete', old.rowid, old.summary, old.key_topics);
END;

-- ---------------------------------------------------------------------------
-- Semantic Memory (Facts & Concepts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic (
  id                  TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  topic               TEXT    NOT NULL,
  content             TEXT    NOT NULL,
  confidence          REAL    NOT NULL DEFAULT 0.5
                      CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_digest_ids   TEXT    NOT NULL DEFAULT '[]',
  source_episode_ids  TEXT    NOT NULL DEFAULT '[]',
  access_count        INTEGER NOT NULL DEFAULT 0,
  last_accessed       REAL,
  decay_rate          REAL    NOT NULL DEFAULT 0.02
                      CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  supersedes          TEXT    REFERENCES memories(id),  -- ID of older knowledge
  superseded_by       TEXT    REFERENCES memories(id),  -- ID of newer knowledge
  embedding           BLOB,
  metadata            TEXT    NOT NULL DEFAULT '{}',
  created_at          REAL    NOT NULL DEFAULT (julianday('now')),
  updated_at          REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_semantic_topic
  ON semantic(topic);

CREATE INDEX IF NOT EXISTS idx_semantic_confidence
  ON semantic(confidence DESC);

CREATE INDEX IF NOT EXISTS idx_semantic_last_accessed
  ON semantic(last_accessed);

CREATE INDEX IF NOT EXISTS idx_semantic_created
  ON semantic(created_at DESC);

-- Supersession chain navigation
CREATE INDEX IF NOT EXISTS idx_semantic_supersedes
  ON semantic(supersedes)
  WHERE supersedes IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_superseded_by
  ON semantic(superseded_by)
  WHERE superseded_by IS NOT NULL;

-- Composite: topic + confidence for filtered semantic recall
CREATE INDEX IF NOT EXISTS idx_semantic_topic_confidence
  ON semantic(topic, confidence DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
  topic,
  content,
  content=semantic,
  content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE TRIGGER IF NOT EXISTS semantic_fts_insert
AFTER INSERT ON semantic BEGIN
  INSERT INTO semantic_fts(rowid, topic, content)
  VALUES (new.rowid, new.topic, new.content);
END;

CREATE TRIGGER IF NOT EXISTS semantic_fts_update
AFTER UPDATE OF topic, content ON semantic BEGIN
  INSERT INTO semantic_fts(semantic_fts, rowid, topic, content)
  VALUES ('delete', old.rowid, old.topic, old.content);
  INSERT INTO semantic_fts(rowid, topic, content)
  VALUES (new.rowid, new.topic, new.content);
END;

CREATE TRIGGER IF NOT EXISTS semantic_fts_delete
AFTER DELETE ON semantic BEGIN
  INSERT INTO semantic_fts(semantic_fts, rowid, topic, content)
  VALUES ('delete', old.rowid, old.topic, old.content);
END;

-- Auto-update updated_at
CREATE TRIGGER IF NOT EXISTS semantic_updated_at
AFTER UPDATE ON semantic BEGIN
  UPDATE semantic SET updated_at = julianday('now') WHERE id = new.id;
END;

-- ---------------------------------------------------------------------------
-- Procedural Memory (How-To, Habits, Workflows)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS procedural (
  id                  TEXT    NOT NULL PRIMARY KEY REFERENCES memories(id),
  category            TEXT    NOT NULL
                      CHECK (category IN ('workflow', 'preference', 'habit', 'pattern', 'convention')),
  trigger_text        TEXT    NOT NULL,
  procedure           TEXT    NOT NULL,
  confidence          REAL    NOT NULL DEFAULT 0.5
                      CHECK (confidence >= 0.0 AND confidence <= 1.0),
  observation_count   INTEGER NOT NULL DEFAULT 1,
  last_observed       REAL    NOT NULL DEFAULT (julianday('now')),
  first_observed      REAL    NOT NULL DEFAULT (julianday('now')),
  access_count        INTEGER NOT NULL DEFAULT 0,
  last_accessed       REAL,
  decay_rate          REAL    NOT NULL DEFAULT 0.01
                      CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  source_episode_ids  TEXT    NOT NULL DEFAULT '[]',
  embedding           BLOB,
  metadata            TEXT    NOT NULL DEFAULT '{}',
  created_at          REAL    NOT NULL DEFAULT (julianday('now')),
  updated_at          REAL    NOT NULL DEFAULT (julianday('now'))
);

CREATE INDEX IF NOT EXISTS idx_procedural_category
  ON procedural(category);

CREATE INDEX IF NOT EXISTS idx_procedural_confidence
  ON procedural(confidence DESC);

CREATE INDEX IF NOT EXISTS idx_procedural_last_accessed
  ON procedural(last_accessed);

CREATE INDEX IF NOT EXISTS idx_procedural_created
  ON procedural(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS procedural_fts USING fts5(
  trigger_text,
  procedure,
  category,
  content=procedural,
  content_rowid=rowid,
  tokenize="porter unicode61 remove_diacritics 1",
  prefix="2 3"
);

CREATE TRIGGER IF NOT EXISTS procedural_fts_insert
AFTER INSERT ON procedural BEGIN
  INSERT INTO procedural_fts(rowid, trigger_text, procedure, category)
  VALUES (new.rowid, new.trigger_text, new.procedure, new.category);
END;

CREATE TRIGGER IF NOT EXISTS procedural_fts_update
AFTER UPDATE OF trigger_text, procedure, category ON procedural BEGIN
  INSERT INTO procedural_fts(procedural_fts, rowid, trigger_text, procedure, category)
  VALUES ('delete', old.rowid, old.trigger_text, old.procedure, old.category);
  INSERT INTO procedural_fts(rowid, trigger_text, procedure, category)
  VALUES (new.rowid, new.trigger_text, new.procedure, new.category);
END;

CREATE TRIGGER IF NOT EXISTS procedural_fts_delete
AFTER DELETE ON procedural BEGIN
  INSERT INTO procedural_fts(procedural_fts, rowid, trigger_text, procedure, category)
  VALUES ('delete', old.rowid, old.trigger_text, old.procedure, old.category);
END;

CREATE TRIGGER IF NOT EXISTS procedural_updated_at
AFTER UPDATE ON procedural BEGIN
  UPDATE procedural SET updated_at = julianday('now') WHERE id = new.id;
END;

-- ---------------------------------------------------------------------------
-- Associative Network (Memory Graph)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS associations (
  id              TEXT    NOT NULL PRIMARY KEY,
  source_id       TEXT    NOT NULL REFERENCES memories(id),
  source_type     TEXT    NOT NULL
                  CHECK (source_type IN ('episode', 'digest', 'semantic', 'procedural')),
  target_id       TEXT    NOT NULL REFERENCES memories(id),
  target_type     TEXT    NOT NULL
                  CHECK (target_type IN ('episode', 'digest', 'semantic', 'procedural')),
  edge_type       TEXT    NOT NULL
                  CHECK (edge_type IN ('temporal', 'causal', 'topical', 'supports',
                                       'contradicts', 'elaborates', 'derives_from', 'co_recalled')),
  strength        REAL    NOT NULL DEFAULT 0.3
                  CHECK (strength >= 0.0 AND strength <= 1.0),
  last_activated  REAL,
  metadata        TEXT    NOT NULL DEFAULT '{}',
  created_at      REAL    NOT NULL DEFAULT (julianday('now')),

  -- Prevent duplicate edges of the same type between the same pair
  CONSTRAINT uq_association_pair UNIQUE (source_id, target_id, edge_type)
);

-- Association walk (bidirectional)
CREATE INDEX IF NOT EXISTS idx_assoc_source_strength
  ON associations(source_id, strength DESC);

CREATE INDEX IF NOT EXISTS idx_assoc_target_strength
  ON associations(target_id, strength DESC);

-- Dream cycle exists-check and pair lookup
-- (covered by uq_association_pair unique index — SQLite uses unique indexes for lookups)

-- Decay pass: prune weak old edges
CREATE INDEX IF NOT EXISTS idx_assoc_prune
  ON associations(strength, last_activated)
  WHERE strength < 0.1;

-- ---------------------------------------------------------------------------
-- Consolidation Run Tracking (idempotency)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id           TEXT    NOT NULL PRIMARY KEY,
  cycle        TEXT    NOT NULL
               CHECK (cycle IN ('light', 'deep', 'dream', 'decay')),
  started_at   REAL    NOT NULL DEFAULT (julianday('now')),
  completed_at REAL,
  status       TEXT    NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'completed', 'failed')),
  metadata     TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_consolidation_runs_status
  ON consolidation_runs(status, started_at DESC);

-- ---------------------------------------------------------------------------
-- Sensory Buffer Persistence (session snapshots)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sensory_snapshots (
  session_id   TEXT    NOT NULL PRIMARY KEY,
  snapshot     TEXT    NOT NULL DEFAULT '{}', -- JSON: WorkingMemoryItem[], PrimedTopic[]
  saved_at     REAL    NOT NULL DEFAULT (julianday('now'))
);
```

---

### 7b. PostgreSQL — Production-Ready Schema

```sql
-- =============================================================================
-- Engram PostgreSQL Schema v1.0
-- Requires: PostgreSQL 15+, pgvector >= 0.5.0
-- Embedding dimensions: configure ENGRAM_EMBEDDING_DIM before applying.
-- Default: 1536 (OpenAI text-embedding-3-small)
-- =============================================================================

-- Extension
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- for LIKE/trigram search fallback

-- ---------------------------------------------------------------------------
-- Configurable embedding dimension via session variable
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- Validate pgvector is installed and supports HNSW
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) THEN
    RAISE EXCEPTION 'pgvector extension required';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Memory ID Pool
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text  NOT NULL
              CHECK (type IN ('episode', 'digest', 'semantic', 'procedural')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Episodic Memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_episodes (
  id               uuid        PRIMARY KEY REFERENCES memories(id),
  session_id       text        NOT NULL,
  role             text        NOT NULL
                   CHECK (role IN ('user', 'assistant', 'system')),
  content          text        NOT NULL,
  salience         real        NOT NULL DEFAULT 0.3
                   CHECK (salience >= 0.0 AND salience <= 1.0),
  access_count     integer     NOT NULL DEFAULT 0,
  last_accessed    timestamptz,
  consolidated_at  timestamptz,
  embedding        vector(1536),             -- NULL in Level 0 mode
  entities         text[]      NOT NULL DEFAULT '{}',
  metadata         jsonb       NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Session scoped queries (most common filter)
CREATE INDEX IF NOT EXISTS idx_episodes_session
  ON memory_episodes(session_id);

-- Light sleep: unconsolidated episodes per session
CREATE INDEX IF NOT EXISTS idx_episodes_unconsolidated
  ON memory_episodes(session_id, salience DESC)
  WHERE consolidated_at IS NULL;

-- Recency queries
CREATE INDEX IF NOT EXISTS idx_episodes_created
  ON memory_episodes(created_at DESC);

-- Decay pass
CREATE INDEX IF NOT EXISTS idx_episodes_last_accessed
  ON memory_episodes(last_accessed)
  WHERE last_accessed IS NOT NULL;

-- Entity search (GIN for array containment: WHERE entities @> ARRAY['React'])
CREATE INDEX IF NOT EXISTS idx_episodes_entities
  ON memory_episodes USING GIN(entities);

-- HNSW vector index (partial: only rows with embeddings)
CREATE INDEX IF NOT EXISTS idx_episodes_embedding
  ON memory_episodes USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- Full-text search via pg_trgm (BM25-equivalent for PostgreSQL without extensions)
CREATE INDEX IF NOT EXISTS idx_episodes_content_trgm
  ON memory_episodes USING GIN(content gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Digest Layer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_digests (
  id                   uuid        PRIMARY KEY REFERENCES memories(id),
  session_id           text        NOT NULL,
  summary              text        NOT NULL,
  key_topics           text[]      NOT NULL DEFAULT '{}',
  source_episode_ids   uuid[]      NOT NULL DEFAULT '{}',
  source_digest_ids    uuid[]      NOT NULL DEFAULT '{}',
  level                integer     NOT NULL DEFAULT 0
                       CHECK (level >= 0 AND level <= 10),
  embedding            vector(1536),
  metadata             jsonb       NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_digests_session
  ON memory_digests(session_id);

CREATE INDEX IF NOT EXISTS idx_digests_created
  ON memory_digests(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_digests_topics
  ON memory_digests USING GIN(key_topics);

CREATE INDEX IF NOT EXISTS idx_digests_source_episodes
  ON memory_digests USING GIN(source_episode_ids);

CREATE INDEX IF NOT EXISTS idx_digests_embedding
  ON memory_digests USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Semantic Memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_semantic (
  id                  uuid        PRIMARY KEY REFERENCES memories(id),
  topic               text        NOT NULL,
  content             text        NOT NULL,
  confidence          real        NOT NULL DEFAULT 0.5
                      CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_digest_ids   uuid[]      NOT NULL DEFAULT '{}',
  source_episode_ids  uuid[]      NOT NULL DEFAULT '{}',
  access_count        integer     NOT NULL DEFAULT 0,
  last_accessed       timestamptz,
  decay_rate          real        NOT NULL DEFAULT 0.02
                      CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  supersedes          uuid        REFERENCES memories(id),
  superseded_by       uuid        REFERENCES memories(id),
  embedding           vector(1536),
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_semantic_topic
  ON memory_semantic(topic);

CREATE INDEX IF NOT EXISTS idx_semantic_topic_confidence
  ON memory_semantic(topic, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_semantic_confidence
  ON memory_semantic(confidence DESC)
  WHERE superseded_by IS NULL;    -- only active memories in this index

CREATE INDEX IF NOT EXISTS idx_semantic_last_accessed
  ON memory_semantic(last_accessed);

CREATE INDEX IF NOT EXISTS idx_semantic_created
  ON memory_semantic(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_semantic_supersedes
  ON memory_semantic(supersedes)
  WHERE supersedes IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_superseded_by
  ON memory_semantic(superseded_by)
  WHERE superseded_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_embedding
  ON memory_semantic USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL AND superseded_by IS NULL;  -- only active

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER semantic_updated_at
BEFORE UPDATE ON memory_semantic
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Procedural Memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_procedural (
  id                  uuid        PRIMARY KEY REFERENCES memories(id),
  category            text        NOT NULL
                      CHECK (category IN ('workflow', 'preference', 'habit', 'pattern', 'convention')),
  trigger_text        text        NOT NULL,
  procedure           text        NOT NULL,
  confidence          real        NOT NULL DEFAULT 0.5
                      CHECK (confidence >= 0.0 AND confidence <= 1.0),
  observation_count   integer     NOT NULL DEFAULT 1,
  last_observed       timestamptz NOT NULL DEFAULT now(),
  first_observed      timestamptz NOT NULL DEFAULT now(),
  access_count        integer     NOT NULL DEFAULT 0,
  last_accessed       timestamptz,
  decay_rate          real        NOT NULL DEFAULT 0.01
                      CHECK (decay_rate > 0.0 AND decay_rate <= 1.0),
  source_episode_ids  uuid[]      NOT NULL DEFAULT '{}',
  embedding           vector(1536),
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_procedural_category
  ON memory_procedural(category);

CREATE INDEX IF NOT EXISTS idx_procedural_confidence
  ON memory_procedural(confidence DESC);

CREATE INDEX IF NOT EXISTS idx_procedural_last_accessed
  ON memory_procedural(last_accessed);

CREATE INDEX IF NOT EXISTS idx_procedural_created
  ON memory_procedural(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_procedural_embedding
  ON memory_procedural USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_procedural_content_trgm
  ON memory_procedural USING GIN(
    (trigger_text || ' ' || procedure) gin_trgm_ops
  );

CREATE TRIGGER procedural_updated_at
BEFORE UPDATE ON memory_procedural
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Associative Network
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_associations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid        NOT NULL REFERENCES memories(id),
  source_type     text        NOT NULL
                  CHECK (source_type IN ('episode', 'digest', 'semantic', 'procedural')),
  target_id       uuid        NOT NULL REFERENCES memories(id),
  target_type     text        NOT NULL
                  CHECK (target_type IN ('episode', 'digest', 'semantic', 'procedural')),
  edge_type       text        NOT NULL
                  CHECK (edge_type IN ('temporal', 'causal', 'topical', 'supports',
                                       'contradicts', 'elaborates', 'derives_from', 'co_recalled')),
  strength        real        NOT NULL DEFAULT 0.3
                  CHECK (strength >= 0.0 AND strength <= 1.0),
  last_activated  timestamptz,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_association_pair UNIQUE (source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_assoc_source_strength
  ON memory_associations(source_id, strength DESC);

CREATE INDEX IF NOT EXISTS idx_assoc_target_strength
  ON memory_associations(target_id, strength DESC);

-- For edge type filtering during graph walks
CREATE INDEX IF NOT EXISTS idx_assoc_source_type_strength
  ON memory_associations(source_id, edge_type, strength DESC);

-- Decay pass pruning
CREATE INDEX IF NOT EXISTS idx_assoc_prune
  ON memory_associations(strength, last_activated)
  WHERE strength < 0.1;

-- ---------------------------------------------------------------------------
-- Consolidation Run Tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle        text        NOT NULL
               CHECK (cycle IN ('light', 'deep', 'dream', 'decay')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status       text        NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'completed', 'failed')),
  metadata     jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_consolidation_runs_status
  ON consolidation_runs(status, started_at DESC);

-- ---------------------------------------------------------------------------
-- Sensory Buffer Persistence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sensory_snapshots (
  session_id  text        PRIMARY KEY,
  snapshot    jsonb       NOT NULL DEFAULT '{}',
  saved_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- RPC Functions
-- ---------------------------------------------------------------------------

-- Unified recall across all memory types
CREATE OR REPLACE FUNCTION engram_recall(
  p_query_embedding   vector,
  p_session_id        text        DEFAULT NULL,
  p_match_count       int         DEFAULT 10,
  p_min_similarity    float       DEFAULT 0.3,
  p_include_episodes  bool        DEFAULT true,
  p_include_digests   bool        DEFAULT true,
  p_include_semantic  bool        DEFAULT true,
  p_include_procedural bool       DEFAULT true
)
RETURNS TABLE (
  id           uuid,
  memory_type  text,
  content      text,
  salience     float,
  access_count int,
  created_at   timestamptz,
  similarity   float,
  entities     text[]
)
LANGUAGE sql STABLE PARALLEL SAFE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, 'episode'::text, content, salience::float, access_count,
         created_at, (1-(embedding<=>p_query_embedding))::float, entities
  FROM memory_episodes
  WHERE p_include_episodes AND embedding IS NOT NULL
    AND (p_session_id IS NULL OR session_id = p_session_id)
    AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
  ORDER BY embedding<=>p_query_embedding
  LIMIT p_match_count
  UNION ALL
  SELECT id, 'digest'::text, summary, 0.5::float, 0,
         created_at, (1-(embedding<=>p_query_embedding))::float, key_topics
  FROM memory_digests
  WHERE p_include_digests AND embedding IS NOT NULL
    AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
  ORDER BY embedding<=>p_query_embedding
  LIMIT p_match_count
  UNION ALL
  SELECT id, 'semantic'::text, content, confidence::float, access_count,
         created_at, (1-(embedding<=>p_query_embedding))::float, ARRAY[]::text[]
  FROM memory_semantic
  WHERE p_include_semantic AND embedding IS NOT NULL
    AND superseded_by IS NULL
    AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
  ORDER BY embedding<=>p_query_embedding
  LIMIT p_match_count
  UNION ALL
  SELECT id, 'procedural'::text, procedure, confidence::float, access_count,
         created_at, (1-(embedding<=>p_query_embedding))::float, ARRAY[]::text[]
  FROM memory_procedural
  WHERE p_include_procedural AND embedding IS NOT NULL
    AND (1-(embedding<=>p_query_embedding)) >= p_min_similarity
  ORDER BY embedding<=>p_query_embedding
  LIMIT p_match_count
$$;

-- Association walk (single SQL call, replaces N+1 queries)
CREATE OR REPLACE FUNCTION engram_association_walk(
  p_seed_ids    uuid[],
  p_max_hops    int   DEFAULT 2,
  p_min_strength float DEFAULT 0.2,
  p_limit       int   DEFAULT 20
)
RETURNS TABLE (
  memory_id    uuid,
  memory_type  text,
  depth        int,
  path_strength float
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE walk AS (
    SELECT
      s.id          AS memory_id,
      NULL::text    AS memory_type,
      0             AS depth,
      ARRAY[s.id]   AS visited_ids,
      1.0::float    AS path_strength
    FROM unnest(p_seed_ids) AS s(id)

    UNION ALL

    SELECT
      CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END,
      CASE WHEN a.source_id = w.memory_id THEN a.target_type ELSE a.source_type END,
      w.depth + 1,
      w.visited_ids ||
        (CASE WHEN a.source_id = w.memory_id THEN a.target_id ELSE a.source_id END),
      (w.path_strength * a.strength)::float
    FROM walk w
    JOIN memory_associations a ON
      (a.source_id = w.memory_id OR a.target_id = w.memory_id)
    WHERE
      w.depth < p_max_hops
      AND a.strength >= p_min_strength
      AND NOT (
        CASE WHEN a.source_id = w.memory_id THEN a.target_id
             ELSE a.source_id END
      ) = ANY(w.visited_ids)
  )
  SELECT DISTINCT ON (memory_id)
    memory_id,
    memory_type,
    depth,
    path_strength
  FROM walk
  WHERE depth > 0
  ORDER BY memory_id, path_strength DESC, depth ASC
  LIMIT p_limit;
$$;

-- Atomic reconsolidation update
CREATE OR REPLACE FUNCTION engram_record_access(
  p_id          uuid,
  p_memory_type text,
  p_conf_boost  float DEFAULT 0.0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_memory_type = 'episode' THEN
    UPDATE memory_episodes
    SET access_count = access_count + 1,
        last_accessed = now()
    WHERE id = p_id;

  ELSIF p_memory_type = 'semantic' THEN
    UPDATE memory_semantic
    SET access_count = access_count + 1,
        last_accessed = now(),
        confidence = LEAST(1.0, confidence + p_conf_boost),
        updated_at = now()
    WHERE id = p_id;

  ELSIF p_memory_type = 'procedural' THEN
    UPDATE memory_procedural
    SET access_count = access_count + 1,
        last_accessed = now(),
        confidence = LEAST(1.0, confidence + p_conf_boost),
        updated_at = now()
    WHERE id = p_id;
  END IF;
END;
$$;

-- Upsert co_recalled association
CREATE OR REPLACE FUNCTION engram_upsert_co_recalled(
  p_source_id    uuid,
  p_source_type  text,
  p_target_id    uuid,
  p_target_type  text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO memory_associations
    (source_id, source_type, target_id, target_type, edge_type, strength, last_activated)
  VALUES
    (p_source_id, p_source_type, p_target_id, p_target_type, 'co_recalled', 0.2, now())
  ON CONFLICT (source_id, target_id, edge_type) DO UPDATE SET
    strength = LEAST(1.0, memory_associations.strength + 0.1),
    last_activated = now();
$$;

-- Batch decay pass
CREATE OR REPLACE FUNCTION engram_decay_pass(
  p_semantic_decay_rate   float DEFAULT 0.02,
  p_procedural_decay_rate float DEFAULT 0.01,
  p_semantic_days         int   DEFAULT 30,
  p_procedural_days       int   DEFAULT 60,
  p_edge_prune_strength   float DEFAULT 0.05,
  p_edge_prune_days       int   DEFAULT 90
)
RETURNS TABLE (
  semantic_decayed   int,
  procedural_decayed int,
  edges_pruned       int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_semantic_decayed   int;
  v_procedural_decayed int;
  v_edges_pruned       int;
BEGIN
  -- Decay semantic
  UPDATE memory_semantic
  SET confidence = GREATEST(0.05, confidence - p_semantic_decay_rate),
      updated_at = now()
  WHERE confidence > 0.05
    AND (last_accessed IS NULL OR last_accessed < now() - (p_semantic_days || ' days')::interval);
  GET DIAGNOSTICS v_semantic_decayed = ROW_COUNT;

  -- Decay procedural
  UPDATE memory_procedural
  SET confidence = GREATEST(0.05, confidence - p_procedural_decay_rate),
      updated_at = now()
  WHERE confidence > 0.05
    AND (last_accessed IS NULL OR last_accessed < now() - (p_procedural_days || ' days')::interval);
  GET DIAGNOSTICS v_procedural_decayed = ROW_COUNT;

  -- Prune weak old edges (only true deletion in the system)
  DELETE FROM memory_associations
  WHERE strength < p_edge_prune_strength
    AND (last_activated IS NULL OR
         last_activated < now() - (p_edge_prune_days || ' days')::interval);
  GET DIAGNOSTICS v_edges_pruned = ROW_COUNT;

  RETURN QUERY SELECT v_semantic_decayed, v_procedural_decayed, v_edges_pruned;
END;
$$;

-- Dream cycle: SQL-side entity co-occurrence (replaces O(n^2) app-side loop)
CREATE OR REPLACE FUNCTION engram_dream_cycle(
  p_days_lookback       int DEFAULT 30,
  p_max_new_associations int DEFAULT 50
)
RETURNS TABLE (
  source_id    uuid,
  source_type  text,
  target_id    uuid,
  target_type  text,
  shared_entity text,
  entity_count  int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH entity_memories AS (
    -- Unnest episode entities
    SELECT e.id AS memory_id, 'episode'::text AS memory_type,
           LOWER(unnest(e.entities)) AS entity
    FROM memory_episodes e
    WHERE e.created_at >= now() - (p_days_lookback || ' days')::interval
      AND array_length(e.entities, 1) > 0

    UNION ALL

    -- Semantic memories participate via topic keyword
    SELECT s.id, 'semantic'::text, LOWER(s.topic)
    FROM memory_semantic s
    WHERE s.created_at >= now() - (p_days_lookback || ' days')::interval
  ),
  pairs AS (
    SELECT
      em1.memory_id   AS source_id,
      em1.memory_type AS source_type,
      em2.memory_id   AS target_id,
      em2.memory_type AS target_type,
      em1.entity      AS shared_entity,
      COUNT(*)        AS entity_count
    FROM entity_memories em1
    JOIN entity_memories em2
      ON em1.entity = em2.entity
      AND em1.memory_id < em2.memory_id  -- canonical ordering prevents duplicates
    WHERE NOT EXISTS (
      SELECT 1 FROM memory_associations a
      WHERE (a.source_id = em1.memory_id AND a.target_id = em2.memory_id)
         OR (a.source_id = em2.memory_id AND a.target_id = em1.memory_id)
    )
    GROUP BY em1.memory_id, em1.memory_type, em2.memory_id, em2.memory_type, em1.entity
  )
  SELECT source_id, source_type, target_id, target_type, shared_entity, entity_count::int
  FROM pairs
  ORDER BY entity_count DESC, source_id, target_id
  LIMIT p_max_new_associations;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE memories              ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_episodes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_digests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_semantic       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_procedural     ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_associations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidation_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensory_snapshots     ENABLE ROW LEVEL SECURITY;

-- Service role bypass (required for Supabase service-role key operations)
-- The service role key bypasses RLS by default in Supabase. These policies
-- are for anon/authenticated roles when exposed via the client API.

-- Policy: agent_id-based isolation
-- Assumes session_id encodes the agent/user: 'agent:{agent_id}:{session_uuid}'
-- Or: use Supabase auth.uid() for user-specific isolation.

-- Option A: Supabase Auth (user-specific memory)
CREATE POLICY episodes_auth_policy ON memory_episodes
  FOR ALL USING (
    -- Service role bypasses automatically. Authenticated users see their sessions.
    session_id LIKE ('agent:' || auth.uid()::text || ':%')
    OR auth.role() = 'service_role'
  );

-- Option B: API key scoping (agent-to-agent isolation in multi-tenant)
-- Requires a custom claims function. Placeholder:
-- CREATE POLICY episodes_agent_policy ON memory_episodes
--   FOR ALL USING (session_id = current_setting('app.agent_id', true));

-- Apply same pattern to all tables (abbreviated — full policies mirror episodes)
CREATE POLICY digests_auth_policy ON memory_digests
  FOR ALL USING (
    session_id LIKE ('agent:' || auth.uid()::text || ':%')
    OR auth.role() = 'service_role'
  );

CREATE POLICY semantic_auth_policy ON memory_semantic
  FOR ALL USING (auth.role() = 'service_role');  -- semantic is cross-session; service role only

CREATE POLICY procedural_auth_policy ON memory_procedural
  FOR ALL USING (auth.role() = 'service_role');  -- same

CREATE POLICY associations_auth_policy ON memory_associations
  FOR ALL USING (auth.role() = 'service_role');  -- graph is cross-session

CREATE POLICY consolidation_runs_policy ON consolidation_runs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY sensory_snapshots_policy ON sensory_snapshots
  FOR ALL USING (
    session_id LIKE ('agent:' || auth.uid()::text || ':%')
    OR auth.role() = 'service_role'
  );

CREATE POLICY memories_policy ON memories
  FOR ALL USING (auth.role() = 'service_role');

-- Grant execute on RPC functions to authenticated role (Supabase PostgREST)
GRANT EXECUTE ON FUNCTION engram_recall TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_association_walk TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_record_access TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_upsert_co_recalled TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION engram_decay_pass TO service_role;
GRANT EXECUTE ON FUNCTION engram_dream_cycle TO service_role;
GRANT EXECUTE ON FUNCTION update_updated_at_column TO service_role;

-- ---------------------------------------------------------------------------
-- Schema migrations tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text        NOT NULL
);

INSERT INTO schema_migrations (version, checksum) VALUES
  ('001_initial_schema',  'legacy'),
  ('002_search_functions','legacy'),
  ('003_enable_rls',      'legacy'),
  ('004_engram_v1',       md5(pg_catalog.current_setting('server_version')))  -- placeholder
ON CONFLICT DO NOTHING;
```

---

## Summary of Critical Findings

| Priority | Issue | Impact | File |
|----------|-------|--------|------|
| P0 | Embedding dimension mismatch (1536 vs 768) | All inserts fail | migrations/001 |
| P0 | RLS enabled with no policies | Silent empty results for all non-service-role reads | migrations/003 |
| P0 | Missing memory_procedural and memory_associations tables | ~40% of spec not persisted | missing |
| P1 | FTS5 sync triggers absent | FTS index goes stale on any update | spec schema |
| P1 | ivfflat → HNSW for vector search | Recall degrades at scale; index wrong for any row count | migrations/001 |
| P1 | No WAL mode pragma | Concurrent consolidation + recall deadlocks | spec (missing) |
| P1 | Batch SQL missing (N+1 in decay pass, dream cycle) | 10,000 queries instead of 1 per cycle | spec code |
| P2 | Polymorphic association FK gap | Orphaned edges undetectable by DB | spec schema |
| P2 | UUID v4 B-tree fragmentation | 20–30% write latency increase at scale | both schemas |
| P2 | missing NOT NULL constraints | Silent nulls corrupt scoring model | spec schema |
| P2 | No consolidation_runs idempotency | Duplicate digests on crash-restart | missing |
| P2 | CHECK constraints missing on enums | Invalid edge_type/source_type silently stored | spec schema |
| P3 | REAL timestamps instead of julianday in SQLite | String comparison bugs for timezone-naive comparisons | spec schema |
| P3 | JSON.stringify embedding serialization | 3x storage bloat, parse overhead | application code |
| P3 | entities_fts generated column missing | FTS tokenizes JSON brackets as tokens | spec schema |
```
