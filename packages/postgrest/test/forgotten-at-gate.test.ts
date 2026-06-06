/**
 * Phase 1 (forget tombstone) — schema-level regression gate.
 *
 * schema.sql is GENERATED from a production pg_dump. A future re-dump that
 * forgets to carry the `forgotten_at IS NULL` predicate would silently make
 * forget() leak again (the exact class of the inverted-forget bug). These
 * assertions pin the invariant in the committed file. The runtime behaviour
 * (forget removes from every recall path, sibling survives, access_count
 * unchanged) is proven against live Postgres+pgvector; here we pin the source.
 *
 * Counts are exact on purpose: a dropped gate lowers a count; gating a wrong
 * table (e.g. memory_digests, which must NOT be forgettable) raises it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

/** Extract a `CREATE OR REPLACE FUNCTION public.<name>(...) AS $$ <body> $$;` body. */
function functionBody(name: string): string {
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
  )
  const m = schema.match(re)
  if (!m) throw new Error(`function ${name} not found in schema.sql`)
  return m[1]
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// Branch counts per recall function: hybrid has ft+vs per type (2 each),
// the others have one branch per type. Digests are intentionally NOT gated.
const RECALL_FUNCTIONS = [
  { name: 'engram_hybrid_recall', forgottenGates: 6, supersededGates: 2 },
  { name: 'engram_recall', forgottenGates: 3, supersededGates: 1 },
  { name: 'engram_text_boost', forgottenGates: 3, supersededGates: 1 },
  { name: 'engram_vector_search', forgottenGates: 3, supersededGates: 1 },
] as const

describe('schema.sql forgotten_at recall gates', () => {
  for (const fn of RECALL_FUNCTIONS) {
    it(`${fn.name} gates episode+semantic+procedural on forgotten_at IS NULL (x${fn.forgottenGates})`, () => {
      const body = functionBody(fn.name)
      expect(count(body, 'forgotten_at IS NULL')).toBe(fn.forgottenGates)
    })

    it(`${fn.name} still carries the semantic superseded_by gate (x${fn.supersededGates})`, () => {
      const body = functionBody(fn.name)
      expect(count(body, 'superseded_by IS NULL')).toBe(fn.supersededGates)
    })

    it(`${fn.name} does NOT gate the digest branch (digests are not forgettable)`, () => {
      const body = functionBody(fn.name)
      // The digest CTE/branch references memory_digests via the `md` alias;
      // it must never carry a forgotten_at predicate.
      expect(body).not.toMatch(/md\.forgotten_at/)
    })
  }
})

describe('schema.sql engram_mark_forgotten primitive', () => {
  const body = functionBody('engram_mark_forgotten')

  it('stamps forgotten_at for all three forgettable types', () => {
    expect(body).toMatch(/UPDATE memory_episodes SET forgotten_at = now\(\)/)
    expect(body).toMatch(/UPDATE memory_semantic SET forgotten_at = now\(\)/)
    expect(body).toMatch(/UPDATE memory_procedural SET forgotten_at = now\(\)/)
  })

  it('is idempotent: only stamps rows not already forgotten', () => {
    expect(count(body, 'forgotten_at IS NULL')).toBe(3)
  })

  it('touches NEITHER access_count NOR confidence (the inversion fix)', () => {
    // Forget must be a pure tombstone — writing access_count rewarded the
    // forgotten memory via accessBoost; writing confidence collides with decay.
    expect(body).not.toMatch(/access_count/)
    expect(body).not.toMatch(/confidence/)
  })
})

describe('schema.sql forgotten_at columns + indexes', () => {
  it('adds an idempotent forgotten_at column to the 3 forgettable tables', () => {
    for (const table of ['memory_episodes', 'memory_semantic', 'memory_procedural']) {
      expect(schema).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ADD COLUMN IF NOT EXISTS forgotten_at`),
      )
    }
  })

  it('does NOT add forgotten_at to memory_digests', () => {
    expect(schema).not.toMatch(/ALTER TABLE public\.memory_digests ADD COLUMN IF NOT EXISTS forgotten_at/)
  })

  it('creates a partial index on tombstoned rows for each forgettable table', () => {
    for (const idx of ['idx_episodes_forgotten', 'idx_semantic_forgotten', 'idx_procedural_forgotten']) {
      expect(schema).toMatch(
        new RegExp(`CREATE INDEX IF NOT EXISTS ${idx} [\\s\\S]*?WHERE \\(forgotten_at IS NOT NULL\\)`),
      )
    }
  })
})
