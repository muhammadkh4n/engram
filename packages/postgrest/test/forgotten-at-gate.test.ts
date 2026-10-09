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
 * Counts are exact on purpose: a dropped gate lowers a count, and a gate
 * repeated or put on the wrong branch raises it.
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
// the others have one branch per type. Every tier is gated, digests included.
const RECALL_FUNCTIONS = [
  { name: 'engram_hybrid_recall', forgottenGates: 8, supersededGates: 2, digestGates: 2 },
  { name: 'engram_recall', forgottenGates: 4, supersededGates: 1, digestGates: 1 },
  { name: 'engram_text_boost', forgottenGates: 4, supersededGates: 1, digestGates: 1 },
  { name: 'engram_text_match', forgottenGates: 4, supersededGates: 1, digestGates: 1 },
  { name: 'engram_vector_search', forgottenGates: 4, supersededGates: 1, digestGates: 1 },
] as const

describe('schema.sql forgotten_at recall gates', () => {
  for (const fn of RECALL_FUNCTIONS) {
    it(`${fn.name} gates every tier on forgotten_at IS NULL (x${fn.forgottenGates})`, () => {
      const body = functionBody(fn.name)
      expect(count(body, 'forgotten_at IS NULL')).toBe(fn.forgottenGates)
    })

    it(`${fn.name} still carries the semantic superseded_by gate (x${fn.supersededGates})`, () => {
      const body = functionBody(fn.name)
      expect(count(body, 'superseded_by IS NULL')).toBe(fn.supersededGates)
    })

    it(`${fn.name} gates the digest branch (x${fn.digestGates})`, () => {
      const body = functionBody(fn.name)
      // engram_recall reads memory_digests unaliased; the others use `md`.
      const digestGate = fn.name === 'engram_recall' ? /FROM memory_digests\s+WHERE[^)]*?forgotten_at IS NULL/g : /md\.forgotten_at IS NULL/g
      expect(body.match(digestGate) ?? []).toHaveLength(fn.digestGates)
    })
  }
})

describe('schema.sql engram_mark_forgotten primitive', () => {
  const body = functionBody('engram_mark_forgotten')

  it('stamps forgotten_at for every tier', () => {
    expect(body).toMatch(/UPDATE memory_episodes SET forgotten_at = now\(\)/)
    expect(body).toMatch(/UPDATE memory_digests SET forgotten_at = now\(\)/)
    expect(body).toMatch(/UPDATE memory_semantic SET forgotten_at = now\(\)/)
    expect(body).toMatch(/UPDATE memory_procedural SET forgotten_at = now\(\)/)
  })

  it('is idempotent: only stamps rows not already forgotten', () => {
    expect(count(body, 'SET forgotten_at = now()')).toBe(4)
    expect(count(body, 'forgotten_at IS NULL')).toBe(4)
  })

  it('touches NEITHER access_count NOR confidence (the inversion fix)', () => {
    // Forget must be a pure tombstone — writing access_count rewarded the
    // forgotten memory via accessBoost; writing confidence collides with decay.
    expect(body).not.toMatch(/access_count/)
    expect(body).not.toMatch(/confidence/)
  })
})

describe('schema.sql forgotten_at columns + indexes', () => {
  it('adds an idempotent forgotten_at column to every tier table', () => {
    for (const table of ['memory_episodes', 'memory_digests', 'memory_semantic', 'memory_procedural']) {
      expect(schema).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ADD COLUMN IF NOT EXISTS forgotten_at`),
      )
    }
  })

  it('declares forgotten_at in the memory_digests table body', () => {
    const table = schema.match(/CREATE TABLE IF NOT EXISTS public\.memory_digests \(([\s\S]*?)\n\);/)
    expect(table?.[1]).toMatch(/\bforgotten_at timestamp with time zone\b/)
  })

  it('creates a partial index on tombstoned rows for each tier table', () => {
    for (const idx of ['idx_episodes_forgotten', 'idx_digests_forgotten', 'idx_semantic_forgotten', 'idx_procedural_forgotten']) {
      expect(schema).toMatch(
        new RegExp(`CREATE INDEX IF NOT EXISTS ${idx} [\\s\\S]*?WHERE \\(forgotten_at IS NOT NULL\\)`),
      )
    }
  })
})

describe('schema.sql pre-recall-RPC match functions', () => {
  it('match_digests skips forgotten digests', () => {
    expect(functionBody('match_digests')).toMatch(/WHERE d\.forgotten_at IS NULL/)
  })

  it('match_episodes skips forgotten episodes', () => {
    expect(functionBody('match_episodes')).toMatch(/e\.forgotten_at IS NULL/)
  })
})

describe('schema.sql post-apply smoke', () => {
  it('calls engram_mark_forgotten for every tier', () => {
    const smoke = schema.match(/DO \$smoke\$([\s\S]*?)\$smoke\$;/)
    expect(smoke).not.toBeNull()
    for (const tier of ['episode', 'digest', 'semantic', 'procedural']) {
      expect(smoke![1]).toContain(`public.engram_mark_forgotten('${tier}'`)
    }
  })
})
