-- v0.3.13: persist auto-consolidation run history so the delta gate and
-- memory_consolidation_status MCP tool work against the Supabase backend.
--
-- The sqlite adapter has had this table since Wave 4; supabase never got
-- the equivalent table or storage class, which made the Phase 2 worker
-- effectively unobservable in production AND silently bypassed the delta
-- gate (no last-run record to compare against → falls back to volume check).

CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
  id           TEXT        NOT NULL PRIMARY KEY,
  cycle        TEXT        NOT NULL CHECK (cycle IN ('light', 'deep', 'dream', 'decay')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb
);

-- The "most recent completed run per cycle" query (used by isDreamCycleDue
-- and memory_consolidation_status) is what we optimize for.
CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_cycle_completed
  ON memory_consolidation_runs (cycle, started_at DESC)
  WHERE status = 'completed';

-- Generic recent-runs index for getRecent().
CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_started
  ON memory_consolidation_runs (started_at DESC);

-- RLS: this is engram-internal infrastructure, no end-user data; service-role
-- access only. Enabling RLS without policies effectively blocks anon/auth roles.
ALTER TABLE memory_consolidation_runs ENABLE ROW LEVEL SECURITY;
