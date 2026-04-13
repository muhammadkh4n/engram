-- Temporal validity columns for semantic memories.
-- Mirrors valid_from/valid_until properties on Neo4j Memory nodes.
--
-- Boundary convention: half-open interval [valid_from, valid_until)
--   valid_from  INCLUSIVE — memory becomes valid at this moment.
--   valid_until EXCLUSIVE — memory ceases to be valid at this moment.
--
-- NULL valid_from  = always valid (treat as epoch).
-- NULL valid_until = currently valid, no expiry.

ALTER TABLE semantic ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ;
ALTER TABLE semantic ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

-- Backfill valid_from from created_at.
UPDATE semantic SET valid_from = created_at WHERE valid_from IS NULL;

-- Backfill valid_until from the superseding memory's created_at.
UPDATE semantic
SET valid_until = (
  SELECT s2.created_at FROM semantic s2 WHERE s2.id = semantic.superseded_by LIMIT 1
)
WHERE superseded_by IS NOT NULL AND valid_until IS NULL;

-- Indexes for temporal filtering.
CREATE INDEX IF NOT EXISTS idx_semantic_valid_from  ON semantic (valid_from);
CREATE INDEX IF NOT EXISTS idx_semantic_valid_until ON semantic (valid_until) WHERE valid_until IS NOT NULL;
