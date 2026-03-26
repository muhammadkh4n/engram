# OpenClaw Memory — Code Audit Report

**Date:** 2026-03-27
**Auditor:** RexBook (automated)
**Codebase:** `openclaw-memory v0.1.0` — 23 source files, ~2120 LOC + 1316 LOC tests
**Commit:** `a100cd6` (fix: use object signature for definePluginEntry)

---

## Summary

The openclaw-memory plugin is well-structured for a v0.1 project. The three-tier architecture (Episodes → Digests → Knowledge) is clean, the adapter pattern is reasonable, and the circuit breaker + timeout utilities provide good resilience primitives. However, there are several issues ranging from a critical dimension mismatch to dead code and missing RLS policies that should be addressed before production use.

**Totals:** 3 Critical, 5 High, 8 Medium, 6 Low

---

## Critical (must fix before production)

### C1. Embedding Dimension Mismatch — Schema vs Config

**File:** `migrations/001_initial_schema.sql` + `openclaw.plugin.json` + `src/plugin-entry.ts`
**Issue:** The database schema defines embedding columns as `vector(1536)`, but `openclaw.plugin.json` defaults `embeddingDimensions` to `768`, and `plugin-entry.ts` also defaults to `768`. When `text-embedding-3-small` is called with `dimensions: 768`, the resulting 768-dim vector will be inserted into a `vector(1536)` column. Supabase/pgvector will reject this with a dimension mismatch error.

**Impact:** All embeddings will fail at insert time, making the entire plugin non-functional.

**Fix:** Either:
- Change migrations to `vector(768)` to match the config defaults, OR
- Change config defaults to `1536` to match the schema, OR
- Make migrations parameterized / add a migration for the 768 dimension

### C2. RLS Enabled Without Policies — Full Lockout

**File:** `migrations/003_enable_rls.sql`
**Issue:** Row Level Security is enabled on all four tables but **no policies are created**. With RLS enabled and no policies, the Supabase service key (which bypasses RLS) will work, but if the plugin is ever used with a non-service-role key (e.g., anon key, user JWT), all queries return empty results and all inserts silently fail.

**Impact:** If anyone misconfigures the key type, the plugin silently returns no data with no errors. Extremely hard to debug.

**Fix:** Add explicit policies, e.g.:
```sql
CREATE POLICY "Service role full access" ON memory_episodes
  FOR ALL USING (true) WITH CHECK (true);
```
Or document that `SUPABASE_SERVICE_KEY` (service role) is mandatory.

### C3. Write Buffer & Cron Jobs Not Wired Into Plugin Entry

**File:** `src/plugin-entry.ts`
**Issue:** The plugin-entry.ts does not use `WriteBuffer`, `AsyncIngest`, `CompactionHandler`, `DailySummarizer`, `Cleanup`, `WeeklyPromoter`, `WorkingMemory`, `Summarizer`, `KnowledgeExtractor`, `EntityExtractor`, `Deduplicator`, or `BatchEmbedder`. These components exist in source but are **completely disconnected** from the plugin lifecycle. The `ingestBatch` method writes directly to `episodes.insert()` — bypassing the write buffer entirely. The `compact()` method is a no-op. Cron jobs are never registered.

**Impact:** The core reliability mechanism (write buffer with retries) is unused. Summarization never runs. Knowledge promotion never happens. The three-tier architecture is effectively tier-1 only (episodes).

**Fix:** Wire `WriteBuffer` into `ingestBatch`, register cron jobs via the plugin API (if supported), and connect `CompactionHandler` to `compact()`. This is the most significant gap — the majority of the codebase is dead code from the plugin's perspective.

---

## High (fix soon)

### H1. Retrieval Timeout Too Aggressive (200ms)

**File:** `src/utils/timeout.ts` line 7
**Issue:** `TIMEOUTS.RETRIEVAL` is set to `200ms`. The retrieval path includes: (1) embedding the query via OpenAI API (~100-300ms alone), then (2) Supabase RPC call (~50-200ms). On a 2GB VPS talking to external APIs, 200ms is almost certainly too low, causing frequent `TimeoutError` during `assemble()`.

**Impact:** Memory retrieval will frequently timeout, making the assemble step return empty memories even when relevant data exists.

**Fix:** Increase to at least `2000ms` for retrieval (embedding + DB query). Alternatively, split the timeout: budget ~500ms for embedding and ~500ms for the DB query separately.

### H2. Embedding Timeout Constant Unused (500ms)

**File:** `src/utils/timeout.ts` line 9
**Issue:** `TIMEOUTS.EMBEDDING` is `500ms` but is never actually used — the tier stores use `TIMEOUTS.RETRIEVAL` (200ms) which wraps both the embedding call AND the DB query together. The 500ms constant is defined but dead.

**Impact:** The embedding call gets only ~200ms as part of the retrieval timeout, which is insufficient for OpenAI API calls.

**Fix:** Use the `EMBEDDING` timeout for the embedding step, and a separate timeout for the DB query, or raise `RETRIEVAL` to cover both.

### H3. `memory_forget` Tool Deletes by Semantic Search — Unpredictable

**File:** `src/plugin-entry.ts`, `memory_forget` tool (~line 200)
**Issue:** The forget tool searches by semantic similarity then deletes the top-N matches. A user saying "forget about Python" could delete entries about "snake handling" or "Monty Python" depending on embedding proximity. The preview mode shows count but not content.

**Impact:** Users can accidentally delete unrelated memories.

**Fix:** The preview should show actual content of matches so the user can verify. Consider requiring exact topic match or adding a similarity threshold parameter.

### H4. No Embedding Call Retry/Backoff

**File:** `src/utils/embeddings.ts`
**Issue:** The `OpenAIEmbeddingService` wraps calls in the circuit breaker, but there's no retry with backoff for transient failures (429 rate limits, 503 service unavailable). The circuit breaker counts these as failures and opens after 5, then all operations fail for 30 seconds.

**Impact:** A single burst of rate-limit errors (common with OpenAI) trips the circuit breaker, disabling ALL memory operations (both read and write) for 30 seconds.

**Fix:** Add exponential backoff retry (1-2 retries) before counting as a circuit breaker failure. Separate read and write circuit breakers so a write storm doesn't block reads.

### H5. Single Circuit Breaker Shared Across All Operations

**File:** `src/plugin-entry.ts` line 91
**Issue:** One `CircuitBreaker` instance is created and shared across episodes, digests, knowledge, AND embeddings. If OpenAI rate-limits embeddings, it also breaks all Supabase queries. If Supabase is down, it also blocks embedding calls.

**Impact:** Correlated failures — one service's outage cascades to all operations.

**Fix:** Use separate circuit breakers for Supabase and OpenAI at minimum.

---

## Medium (fix when convenient)

### M1. `ingestBatch` Makes N Sequential Embedding+Insert Calls

**File:** `src/plugin-entry.ts` lines 107-122
**Issue:** `ingestBatch` loops over messages and calls `episodes.insert()` sequentially, which calls `embeddings.embed()` for each message individually. For a batch of 10 messages, this is 10 sequential OpenAI API calls + 10 sequential Supabase inserts.

**Impact:** Slow ingestion; could be 3-5 seconds for a typical batch.

**Fix:** Use `embeddings.embedBatch()` to embed all messages in one API call, then batch-insert into Supabase. The `BatchEmbedder` utility exists for this but isn't used.

### M2. `DailySummarizer.getUnsummarizedEpisodes` — N+1 Query Pattern

**File:** `src/cron/daily-summarizer.ts` lines 54-75
**Issue:** Fetches ALL digests to build the summarized IDs set, then fetches ALL recent episodes, then filters in JS. As the dataset grows, this loads increasingly large arrays into memory.

**Impact:** Memory spikes and slow queries at scale.

**Fix:** Use a SQL query with `NOT IN (SELECT unnest(episode_ids) FROM memory_digests)` or a materialized view.

### M3. `WeeklyPromoter` Loads ALL Knowledge Into Memory

**File:** `src/cron/weekly-promoter.ts` line 48
**Issue:** `SELECT id, content, embedding, metadata` from `memory_knowledge` with no limit. Embeddings are 768-dim float arrays (~3KB each). With 10K knowledge entries, this is ~30MB loaded into memory.

**Impact:** Memory pressure on a 2GB VPS. Will eventually OOM.

**Fix:** Process in pages, or use database-side similarity check via `match_knowledge` RPC.

### M4. `Cleanup.archiveOldEpisodes` Also Loads All Digests

**File:** `src/cron/cleanup.ts` lines 35-50
**Issue:** Same pattern as M2 — loads ALL digests to build summarized ID set, then loads ALL old episodes.

**Fix:** Use SQL joins instead of JS-side filtering.

### M5. `KnowledgeExtractor.patternCounts` Is In-Memory and Never Persisted

**File:** `src/tiers/knowledge-extractor.ts`
**Issue:** The `patternCounts` Map tracks topic occurrences for batch promotion. This is an in-memory Map that resets every time the process restarts. Since the `WeeklyPromoter` creates a new `KnowledgeExtractor` per run, the batch promotion threshold (3 occurrences in 7 days) can never be reached across separate runs.

**Impact:** Batch knowledge promotion never works. Only immediate pattern extraction works.

**Fix:** Persist pattern counts to Supabase, or track at the SQL level (count topic occurrences across digests).

### M6. Index.ts Exports Incomplete Public API

**File:** `src/index.ts`
**Issue:** The index.ts exports some modules but not `Summarizer`, `KnowledgeExtractor`, `WorkingMemory`, `EntityExtractor`, `Deduplicator`, `BatchEmbedder`, `DailySummarizer`, `Cleanup`, `WeeklyPromoter`, `CompactionHandler`, or `AsyncIngest`. The public API is incomplete.

**Fix:** Either export all public components or document what's considered internal.

### M7. `TierRouter` Type Conflict

**File:** `src/types.ts` line 73 + `src/retrieval/tier-router.ts`
**Issue:** `types.ts` exports a `TierRouter` interface, and `tier-router.ts` exports a `TierRouter` class. The class doesn't implement the interface. This causes confusion.

**Fix:** Have the class implement the interface, or rename one of them.

### M8. Conversation Content Sent to OpenAI for Embedding — No Opt-Out

**File:** `src/tiers/episodes.ts`, `src/utils/embeddings.ts`
**Issue:** All user and assistant messages are sent to OpenAI's embedding API verbatim. There's no content filtering, no opt-out mechanism, and no documentation about this data flow.

**Impact:** PII in conversations (names, emails, addresses) is sent to OpenAI. Users may not be aware.

**Fix:** Document the data flow. Consider adding a content sanitizer or allowing users to opt out of embedding certain messages.

---

## Low (nice to have)

### L1. `console.error` Used for Logging

**Files:** `plugin-entry.ts:117`, `cron/daily-summarizer.ts:62`, `cron/cleanup.ts:62,80`
**Issue:** Uses bare `console.error` without timestamps, log levels, or structured metadata.

**Fix:** Use a structured logger or the OpenClaw plugin logging API if available.

### L2. Embedding JSON Serialization Fragility

**Files:** All tier stores
**Issue:** Embeddings are serialized via `JSON.stringify(embedding)` before insert, and the RPC functions cast `query_embedding::vector`. This works but is fragile.

**Fix:** Use Supabase's native vector type support or a consistent serialization helper.

### L3. `_breaker` Unused Parameter in AsyncIngest

**File:** `src/ingestion/async-ingest.ts` line 14
**Issue:** The constructor accepts `_breaker?: unknown` which is never used.

**Fix:** Remove or use it.

### L4. No Integration Tests

**Files:** `test/`
**Issue:** All 14 test files are unit tests with mocks. No integration tests against a real Supabase instance.

**Fix:** Add a docker-compose with Supabase local for integration testing.

### L5. `ivfflat` Index Created on Empty Tables

**File:** `migrations/001_initial_schema.sql`
**Issue:** IVFFlat indexes require pre-existing data. Creating on empty tables means first queries will be inaccurate. `lists = 100` assumes ~100K rows.

**Fix:** Switch to HNSW indexes (work on empty tables), or create IVFFlat after initial data load.

### L6. No Plugin-Entry Test

**File:** `test/` (missing)
**Issue:** No test for the plugin entry point — the most critical file. `resolveConfig`, `formatMemories`, and tool handlers are untested.

**Fix:** Add unit tests for config resolution, memory formatting, and tool execute handlers.

---

## Architecture Notes (Not Issues)

**What's Good:**
- Clean separation of concerns: tiers, retrieval, ingestion, utils, cron
- Circuit breaker pattern is well-implemented
- Retrieval gate with regex heuristics avoids unnecessary embedding calls
- Tier router is a smart optimization
- Types are well-defined and comprehensive
- Test coverage exists for all utility and pure-logic modules (14 test files, 1316 LOC)
- Plugin config supports both direct config and env vars as fallback
- `openclaw.plugin.json` marks sensitive fields with `uiHints`

**Security Assessment:**
- Supabase credentials handled safely — config or env vars, marked as sensitive in plugin manifest
- OpenAI API key same — no hardcoding detected
- SQL injection risk is low — Supabase client parameterizes queries, RPC functions use typed parameters
- Write buffer stores payloads as JSONB — no direct SQL injection vector
- No SSRF risks — all external calls are to configured Supabase URL and OpenAI API
- Circuit breaker uses `Date.now()` — not vulnerable to timing attacks in this context

**Architecture Risks for Future Adapters:**
- Tier stores are tightly coupled to Supabase client (no adapter interface). Adding SQLite/Turso would require rewriting all three store classes.
- Consider extracting a `StorageAdapter` interface: `insert()`, `search()`, `delete()`, `query()`
- The RPC functions (`match_episodes`, etc.) are Supabase-specific

---

## Recommended Priority Order

1. **C1** (dimension mismatch) — plugin literally won't work without this
2. **C2** (RLS policies) — silent data loss risk
3. **C3** (wire up components) — 70% of the codebase is dead code
4. **H5** (separate circuit breakers) — cascading failures
5. **H1/H2** (timeouts) — retrieval will frequently fail
6. **H4** (retry/backoff) — rate limits will trip breaker
7. **M1** (batch embeddings) — performance
8. **M5** (persist pattern counts) — batch promotion broken
9. Everything else in order
