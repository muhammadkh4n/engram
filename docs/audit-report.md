# OpenClaw Memory — Code Audit Report

**Date:** 2026-03-27
**Auditor:** RexBook (automated)
**Codebase:** openclaw-memory v0.1.0 — 23 source files, ~2120 LOC + 1316 LOC tests
**Commit:** a100cd6

---

## Summary

Well-structured v0.1 project. Three-tier architecture is clean, circuit breaker + timeout utilities provide good resilience. Several issues from critical dimension mismatch to dead code need fixing before production.

**Totals:** 3 Critical, 5 High, 8 Medium, 6 Low

---

## Critical

### C1. Embedding Dimension Mismatch — Schema vs Config
**Files:** migrations/001_initial_schema.sql, openclaw.plugin.json, src/plugin-entry.ts
Schema uses vector(1536), config defaults to 768. All inserts will fail.
**Fix:** Align dimensions.

### C2. RLS Enabled Without Policies
**File:** migrations/003_enable_rls.sql
RLS enabled but no policies created. Non-service-role keys get silent empty results.
**Fix:** Add policies or document service role requirement.

### C3. Components Not Wired Into Plugin Entry
**File:** src/plugin-entry.ts
WriteBuffer, AsyncIngest, CompactionHandler, DailySummarizer, Cleanup, WeeklyPromoter, WorkingMemory, Summarizer, KnowledgeExtractor, EntityExtractor, Deduplicator, BatchEmbedder all exist but are disconnected. ~70% dead code.
**Fix:** Wire into plugin lifecycle.

---

## High

### H1. Retrieval Timeout Too Aggressive (200ms)
**File:** src/utils/timeout.ts line 7
Embedding+DB in 200ms is unrealistic. Frequent timeouts.
**Fix:** Increase to 2000ms or split per step.

### H2. TIMEOUTS.EMBEDDING (500ms) Never Used
**File:** src/utils/timeout.ts line 9
Dead constant. Tier stores use RETRIEVAL (200ms) for everything.
**Fix:** Apply EMBEDDING timeout to embedding step.

### H3. memory_forget Deletes by Semantic Search
**File:** src/plugin-entry.ts, memory_forget tool
Preview shows count not content. Unpredictable deletions.
**Fix:** Show content in preview, add threshold param.

### H4. No Retry/Backoff for Embeddings
**File:** src/utils/embeddings.ts
Rate limits trip circuit breaker after 5 failures, disabling all ops for 30s.
**Fix:** Add exponential backoff retry.

### H5. Single Shared Circuit Breaker
**File:** src/plugin-entry.ts line 91
One breaker for Supabase AND OpenAI. Cascading failures.
**Fix:** Separate breakers per service.

---

## Medium

### M1. Sequential Embedding in ingestBatch
**File:** src/plugin-entry.ts lines 107-122
N sequential embed+insert calls. BatchEmbedder exists but unused.
**Fix:** Use embedBatch() and batch insert.

### M2. DailySummarizer N+1 Query
**File:** src/cron/daily-summarizer.ts lines 54-75
Loads ALL digests and episodes, filters in JS.
**Fix:** SQL-side filtering.

### M3. WeeklyPromoter Loads All Knowledge
**File:** src/cron/weekly-promoter.ts line 48
No limit on knowledge select. ~3KB per embedding.
**Fix:** Paginate or use DB-side similarity.

### M4. Cleanup Loads All Digests
**File:** src/cron/cleanup.ts lines 35-50
Same N+1 pattern.
**Fix:** SQL joins.

### M5. KnowledgeExtractor patternCounts Not Persisted
**File:** src/tiers/knowledge-extractor.ts
In-memory Map resets per run. Batch promotion threshold unreachable.
**Fix:** Persist to DB.

### M6. Incomplete Public API Exports
**File:** src/index.ts
Many modules not exported.
**Fix:** Export or document.

### M7. TierRouter Type Conflict
**Files:** src/types.ts line 73, src/retrieval/tier-router.ts
Interface and class same name, class doesn't implement interface.
**Fix:** Rename or implement.

### M8. PII Sent to OpenAI Without Opt-Out
**Files:** src/tiers/episodes.ts, src/utils/embeddings.ts
All messages sent verbatim for embedding. No filtering or docs.
**Fix:** Document and add opt-out.

---

## Low

- L1. console.error instead of structured logger
- L2. JSON.stringify embedding serialization fragile
- L3. Unused _breaker param in AsyncIngest
- L4. No integration tests (all 14 are unit tests)
- L5. ivfflat index on empty tables (use HNSW)
- L6. No plugin-entry test (most critical file untested)

---

## Security Assessment (Clean)
- Credentials: config/env vars, no hardcoding, marked sensitive in manifest
- SQL injection: low risk, Supabase parameterizes, RPC uses typed params
- SSRF: none, only configured endpoints
- Write buffer JSONB: safe
- Circuit breaker: no timing attack risk

## Architecture Notes
**Good:** Clean separation, comprehensive types, 14 test files, retrieval gate heuristics, tier router, env var fallback
**Risk:** Tier stores tightly coupled to Supabase. Extract StorageAdapter interface for SQLite/Turso.

## Priority Order
1. C1 (dimensions) 2. C2 (RLS) 3. C3 (wire components) 4. H5 (separate breakers) 5. H1/H2 (timeouts) 6. H4 (retry) 7. M1 (batch) 8. M5 (persist patterns) 9. Rest
