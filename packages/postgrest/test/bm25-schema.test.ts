/**
 * bm25.sql is an optional add-on applied after schema.sql on a server that
 * preloads pg_textsearch. These checks hold its text to the invariants the
 * planner and the recall filters depend on:
 * - each BM25 index is partial on exactly the rows recall may return, so its
 *   term statistics describe only those rows;
 * - each tier's ordered subquery repeats its index predicate and index
 *   expression, so the planner can serve ORDER BY ... <@> ... LIMIT from that
 *   index;
 * - no score predicate sits inside an ordered subquery, which would force a
 *   standalone scoring scan.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const bm25 = readFileSync(new URL('../bm25.sql', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

interface Bm25Index {
  name: string
  table: string
  expr: string
  predicate: string | null
}

function bm25Indexes(): Bm25Index[] {
  const re =
    /CREATE INDEX IF NOT EXISTS (\w+) ON public\.(\w+)\s+USING bm25 \((.+?)\) WITH \(text_config = 'english'\)(?:\s+WHERE ([^;]+))?;/g
  return [...bm25.matchAll(re)].map((m) => ({
    name: m[1]!,
    table: m[2]!,
    expr: m[3]!,
    predicate: m[4] ? m[4].replace(/\s+/g, ' ').trim() : null,
  }))
}

function functionBody(): string {
  const m = bm25.match(
    /CREATE OR REPLACE FUNCTION public\.engram_bm25_match\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
  )
  if (!m) throw new Error('engram_bm25_match not found in bm25.sql')
  return m[1]!
}

/** The four ordered tier subqueries, keyed by the memory_type literal each selects. */
function tierBranches(): Map<string, string> {
  const body = functionBody()
  const inner = body.slice(0, body.indexOf(') combined'))
  const branches = new Map<string, string>()
  for (const chunk of inner.split('UNION ALL')) {
    const type = chunk.match(/'(\w+)'::text AS memory_type/)
    if (!type) throw new Error(`branch without a memory_type literal:\n${chunk}`)
    branches.set(type[1]!, chunk)
  }
  return branches
}

function whereClause(branch: string): string {
  const m = branch.match(/WHERE([\s\S]*?)ORDER BY/)
  if (!m) throw new Error(`branch without WHERE ... ORDER BY:\n${branch}`)
  return m[1]!.replace(/\s+/g, ' ')
}

function stripAliases(sql: string): string {
  return sql.replace(/\b[a-z]{2}\./g, '').replace(/\s+/g, ' ').trim()
}

const TIERS = {
  episode: {
    index: 'idx_episodes_bm25',
    table: 'memory_episodes',
    expr: 'content',
    predicate: 'forgotten_at IS NULL',
  },
  digest: { index: 'idx_digests_bm25', table: 'memory_digests', expr: 'summary', predicate: null },
  semantic: {
    index: 'idx_semantic_bm25',
    table: 'memory_semantic',
    expr: "(topic || ' ' || content)",
    predicate: 'forgotten_at IS NULL AND superseded_by IS NULL',
  },
  procedural: {
    index: 'idx_procedural_bm25',
    table: 'memory_procedural',
    expr: "(trigger_text || ' ' || procedure)",
    predicate: 'forgotten_at IS NULL',
  },
} as const

describe('bm25.sql BM25 indexes', () => {
  it('creates the extension idempotently', () => {
    expect(bm25).toMatch(/^CREATE EXTENSION IF NOT EXISTS pg_textsearch;$/m)
  })

  it('creates one english BM25 index per tier with the recall predicate', () => {
    const indexes = bm25Indexes()
    expect(indexes).toHaveLength(4)
    for (const tier of Object.values(TIERS)) {
      expect(indexes).toContainEqual({
        name: tier.index,
        table: tier.table,
        expr: tier.expr,
        predicate: tier.predicate,
      })
    }
  })

  it('indexes the same text as each tier fts column in schema.sql', () => {
    const ftsSource = (table: string): string => {
      const re = new RegExp(
        `CREATE TABLE IF NOT EXISTS public\\.${table} \\([\\s\\S]*?fts tsvector GENERATED ALWAYS AS \\(to_tsvector\\('english'::regconfig, (.+?)\\)\\) STORED`,
      )
      const m = schema.match(re)
      if (!m) throw new Error(`fts column of ${table} not found in schema.sql`)
      return m[1]!.replace(/'::text/g, "'").replace(/[()]/g, '')
    }
    for (const tier of Object.values(TIERS)) {
      expect(tier.expr.replace(/[()]/g, '')).toBe(ftsSource(tier.table))
    }
  })
})

describe('bm25.sql engram_bm25_match', () => {
  it('keeps the engram_text_match signature and result shape', () => {
    const header = (sql: string, name: string): string => {
      const m = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}(\\([^\\n]*?) RETURNS ([^\\n]+)`))
      if (!m) throw new Error(`${name} header not found`)
      return `${m[1]} RETURNS ${m[2]}`
    }
    expect(header(bm25, 'engram_bm25_match')).toBe(header(schema, 'engram_text_match'))
    expect(bm25).toMatch(/LANGUAGE sql STABLE SECURITY DEFINER\s+SET search_path TO 'public'/)
  })

  it('every to_bm25query names an index created in the file', () => {
    const created = new Set(bm25Indexes().map((i) => i.name))
    const calls = functionBody().match(/to_bm25query\(/g) ?? []
    const named = [...functionBody().matchAll(/to_bm25query\(.*?, '(\w+)'\)/g)].map((m) => m[1]!)
    expect(calls.length).toBeGreaterThan(0)
    expect(named).toHaveLength(calls.length)
    for (const name of named) expect(created).toContain(name)
  })

  it('has one ordered branch per tier, scored and ordered through its own index expression', () => {
    const branches = tierBranches()
    expect([...branches.keys()].sort()).toEqual(['digest', 'episode', 'procedural', 'semantic'])
    for (const [type, tier] of Object.entries(TIERS)) {
      const branch = branches.get(type)!
      expect(branch).toContain(`FROM ${tier.table} `)
      const query = `to_bm25query(array_to_string(p_terms, ' '), '${tier.index}')`
      const indexed = `${tier.expr} <@> ${query}`
      const order = branch.match(/ORDER BY ([^\n]+)\n\s*LIMIT p_match_count/)
      expect(order && stripAliases(order[1]!)).toBe(indexed)
      const score = branch.match(/-\((.+)\)::float AS rank_score/)
      expect(score && stripAliases(score[1]!)).toBe(indexed)
    }
  })

  it("repeats each tier's index predicate in its WHERE", () => {
    const branches = tierBranches()
    for (const [type, tier] of Object.entries(TIERS)) {
      const where = stripAliases(whereClause(branches.get(type)!))
      if (tier.predicate) expect(where).toContain(tier.predicate)
    }
    expect(whereClause(branches.get('episode')!)).toContain(
      '(p_session_id IS NULL OR me.session_id = p_session_id)',
    )
  })

  it('gates tombstoned and superseded rows exactly where recall does', () => {
    const body = functionBody()
    expect(body.match(/forgotten_at IS NULL/g)).toHaveLength(3)
    expect(body.match(/superseded_by IS NULL/g)).toHaveLength(1)
    expect(body).not.toContain('md.forgotten_at')
  })

  it('returns nothing for an empty term list', () => {
    for (const branch of tierBranches().values()) {
      expect(whereClause(branch)).toContain('cardinality(p_terms) > 0')
    }
  })

  it('never reads p_project_id', () => {
    expect(functionBody()).not.toContain('p_project_id')
  })

  it('negates the score and filters it only outside the ordered subqueries', () => {
    const body = functionBody()
    for (const branch of tierBranches().values()) {
      expect(branch).toMatch(/-\(.+<@>.+\)::float AS rank_score/)
      expect(branch).not.toMatch(/rank_score\s*[<>=]/)
      expect(branch.replace(/cardinality\(p_terms\) > 0/g, '')).not.toMatch(/[<>]=?\s*-?\d/)
    }
    const outer = body.slice(body.indexOf(') combined'))
    expect(outer).toMatch(/WHERE rank_score > 0\s+ORDER BY rank_score DESC\s+LIMIT p_match_count/)
  })
})

describe('bm25.sql stays optional and plain SQL', () => {
  it('schema.sql does not mention pg_textsearch, so it applies on a plain pgvector image', () => {
    expect(schema).not.toContain('pg_textsearch')
    expect(schema).not.toMatch(/USING bm25/)
  })

  it('ties engram_bm25_match to the extension so DROP EXTENSION removes it', () => {
    // A LANGUAGE sql body records no dependency on to_bm25query or <@>, so
    // without this the function outlives the extension and every call to it
    // fails with "function to_bm25query does not exist".
    expect(bm25).toMatch(
      /ALTER FUNCTION public\.engram_bm25_match\(text\[\], integer, text, text\) DEPENDS ON EXTENSION pg_textsearch;/,
    )
    expect(bm25.indexOf('DEPENDS ON EXTENSION')).toBeGreaterThan(
      bm25.indexOf('CREATE OR REPLACE FUNCTION public.engram_bm25_match'),
    )
  })

  it('holds no psql meta-commands', () => {
    const metaLines = bm25
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.startsWith('\\'))
    expect(metaLines).toEqual([])
  })
})
