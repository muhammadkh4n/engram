/**
 * bm25.sql is an optional add-on applied after schema.sql on a server that
 * preloads pg_textsearch. These checks hold its text to the invariants the
 * planner and the recall filters depend on:
 * - each BM25 index is partial on exactly the rows recall may return, so its
 *   term statistics describe only those rows;
 * - engram_bm25_match matches exactly what engram_text_match matches: one
 *   phraseto_tsquery per term on each tier's GIN fts column, under the same
 *   tier predicates. pg_textsearch's own query ORs an identifier's parts, so
 *   it only scores rows and never selects them;
 * - each tier scores a bounded number of rows, selects the bare <@> score
 *   once per row, and leaves the rank_score filter outside the tiers;
 * - removal is documented as explicit drops, never CASCADE.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const bm25 = readFileSync(new URL('../bm25.sql', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

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

function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function functionBody(sql: string, name: string): string {
  const m = sql.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`),
  )
  if (!m) throw new Error(`${name} not found`)
  return m[1]!
}

const body = functionBody(bm25, 'engram_bm25_match')
const textMatchBody = functionBody(schema, 'engram_text_match')

/** Splits a UNION ALL of tier branches, keyed by the memory_type literal each selects. */
function branchesByType(union: string): Map<string, string> {
  const branches = new Map<string, string>()
  for (const chunk of union.split('UNION ALL')) {
    const type = chunk.match(/'(\w+)'::text/)
    if (!type) throw new Error(`branch without a memory_type literal:\n${chunk}`)
    branches.set(type[1]!, chunk)
  }
  return branches
}

/** The four tier branches of engram_bm25_match. */
function tierBranches(): Map<string, string> {
  const start = body.indexOf('SELECT * FROM (')
  const end = body.indexOf(') tiers')
  if (start < 0 || end < 0) throw new Error('tier union not found')
  return branchesByType(body.slice(start, end))
}

/** The per-term candidate subquery of a branch: what it matches on. */
function candidateQuery(branch: string): string {
  const m = branch.match(/CROSS JOIN LATERAL \(([\s\S]*?)\) c\b/)
  if (!m) throw new Error(`branch without a per-term candidate subquery:\n${branch}`)
  return m[1]!
}

/** WHERE conjuncts with table aliases and the tsquery's CTE alias removed. */
function conjuncts(where: string): string[] {
  return squash(where)
    .replace(/\b[a-z]{1,2}\./g, '')
    .split(/ AND (?![^(]*\))/)
    .map((c) => c.trim())
    .sort()
}

function whereOf(sql: string, until: RegExp): string {
  const m = sql.match(new RegExp(`WHERE([\\s\\S]*?)${until.source}`))
  if (!m) throw new Error(`no WHERE clause in:\n${sql}`)
  return m[1]!
}

const TIERS = {
  episode: {
    index: 'idx_episodes_bm25',
    table: 'memory_episodes',
    alias: 'me',
    expr: 'content',
    predicate: 'forgotten_at IS NULL',
  },
  digest: { index: 'idx_digests_bm25', table: 'memory_digests', alias: 'md', expr: 'summary', predicate: null },
  semantic: {
    index: 'idx_semantic_bm25',
    table: 'memory_semantic',
    alias: 'ms',
    expr: "(topic || ' ' || content)",
    predicate: 'forgotten_at IS NULL AND superseded_by IS NULL',
  },
  procedural: {
    index: 'idx_procedural_bm25',
    table: 'memory_procedural',
    alias: 'mp',
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

describe('bm25.sql engram_bm25_match matching', () => {
  it('keeps the engram_text_match signature and result shape', () => {
    const header = (sql: string, name: string): string => {
      const m = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}(\\([^\\n]*?) RETURNS ([^\\n]+)`))
      if (!m) throw new Error(`${name} header not found`)
      return `${m[1]} RETURNS ${m[2]}`
    }
    expect(header(bm25, 'engram_bm25_match')).toBe(header(schema, 'engram_text_match'))
    expect(bm25).toMatch(/LANGUAGE sql STABLE SECURITY DEFINER\s+SET search_path TO 'public'/)
  })

  it('builds one phrase query per term exactly as engram_text_match does, dropping empty ones', () => {
    const termQuery = "phraseto_tsquery('english', t) AS q FROM unnest(p_terms) AS t"
    expect(squash(textMatchBody)).toContain(termQuery)
    expect(squash(body)).toContain(`term_queries AS ( SELECT t, ${termQuery} )`)
    expect(squash(textMatchBody)).toContain('WHERE numnode(q) > 0')
    expect(squash(body)).toContain('match_terms AS ( SELECT t, q FROM term_queries WHERE numnode(q) > 0 )')
  })

  it("matches each tier on its fts column under engram_text_match's tier predicates", () => {
    const textBranches = branchesByType(textMatchBody.slice(textMatchBody.indexOf('SELECT id, memory_type')))
    const branches = tierBranches()
    expect([...branches.keys()].sort()).toEqual(['digest', 'episode', 'procedural', 'semantic'])
    for (const type of Object.keys(TIERS)) {
      const expected = conjuncts(whereOf(textBranches.get(type)!, /(?:\) combined|$)/))
      const candidate = candidateQuery(branches.get(type)!)
      expect(conjuncts(whereOf(candidate, /LIMIT/))).toEqual(expected)
      expect(squash(candidate)).toMatch(/FROM memory_\w+ [a-z] WHERE [a-z]\.fts @@ mt\.q/)
    }
  })

  it('takes every candidate from the per-term phrase queries, never from to_bm25query', () => {
    for (const branch of tierBranches().values()) {
      expect(squash(branch)).toContain('FROM match_terms mt CROSS JOIN LATERAL (')
      const candidate = candidateQuery(branch)
      expect(candidate).not.toContain('<@>')
      expect(candidate).not.toContain('to_bm25query')
    }
    expect(body.match(/<@>/g)).toHaveLength(4)
    expect(body.match(/to_bm25query\(/g)).toHaveLength(4)
  })

  it('gates tombstoned and superseded rows exactly where recall does', () => {
    expect(body.match(/forgotten_at IS NULL/g)).toHaveLength(3)
    expect(body.match(/superseded_by IS NULL/g)).toHaveLength(1)
    expect(body).not.toMatch(/\bd\.forgotten_at/)
    expect(squash(candidateQuery(tierBranches().get('episode')!))).toContain(
      '(p_session_id IS NULL OR e.session_id = p_session_id)',
    )
  })

  it('never reads p_project_id', () => {
    expect(body).not.toContain('p_project_id')
  })
})

describe('bm25.sql engram_bm25_match scoring', () => {
  it('bounds the rows each tier scores with one named cap', () => {
    expect(body).toMatch(/WITH bounds AS \(\n(?:\s*--[^\n]*\n)*\s*SELECT \d+ AS candidate_cap\n\s*\),/)
    for (const branch of tierBranches().values()) {
      expect(branch.match(/LIMIT \(SELECT candidate_cap FROM bounds\)/g)).toHaveLength(2)
      expect(squash(branch)).toMatch(
        /row_number\(\) OVER \(ORDER BY ts_rank_cd\([a-z]\.fts, mt\.q, 2\) DESC\) AS term_rank/,
      )
      expect(squash(branch)).toContain(
        'GROUP BY c.id ORDER BY min(c.term_rank) LIMIT (SELECT candidate_cap FROM bounds)',
      )
    }
  })

  it("scores each row with the tier's BM25 index on only the terms it matches", () => {
    const branches = tierBranches()
    for (const [type, tier] of Object.entries(TIERS)) {
      const branch = squash(branches.get(type)!)
      const scoredText = tier.expr.startsWith('(')
        ? tier.expr.replace(/(\w+) \|\|/, `${tier.alias}.$1 ||`).replace(/\|\| (\w+)\)$/, `|| ${tier.alias}.$1)`)
        : `${tier.alias}.${tier.expr}`
      expect(branch).toContain(
        `${scoredText} <@> to_bm25query(array_to_string(ARRAY( ` +
          `SELECT mt.t FROM match_terms mt WHERE ${tier.alias}.fts @@ mt.q), ' '), '${tier.index}') AS bm25_score`,
      )
      expect(branch).toContain(`FROM ${tier.table} ${tier.alias} WHERE ${tier.alias}.id IN (`)
    }
  })

  it('selects the bare score once per row and orders each tier by that column', () => {
    for (const branch of tierBranches().values()) {
      expect(branch).not.toMatch(/-\s*\(?[^\n]*<@>/)
      expect(squash(branch)).toMatch(/\) ORDER BY bm25_score LIMIT p_match_count \) \w+\s*$/)
      expect(branch).not.toContain('rank_score')
    }
  })

  it('negates the score and filters rank_score > 0 only outside the tiers', () => {
    const outer = squash(body.slice(body.indexOf(') tiers')))
    expect(squash(body)).toContain('SELECT id, memory_type, -bm25_score::float AS rank_score FROM (')
    expect(outer).toMatch(/\) combined WHERE rank_score > 0 ORDER BY rank_score DESC LIMIT p_match_count$/)
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

describe('BM25 removal is explicit drops, never CASCADE', () => {
  const lexicalSection = readme.slice(
    readme.indexOf('## Lexical ranking'),
    readme.indexOf('\n## ', readme.indexOf('## Lexical ranking') + 1),
  )
  const removal = [
    ...bm25Indexes().map((i) => `DROP INDEX public.${i.name};`),
    'DROP FUNCTION public.engram_bm25_match(text[], integer, text, text);',
    'DROP EXTENSION pg_textsearch;',
  ]

  it('never says CASCADE in bm25.sql or the README lexical ranking section', () => {
    expect(lexicalSection.length).toBeGreaterThan(0)
    expect(bm25).not.toMatch(/cascade/i)
    expect(lexicalSection).not.toMatch(/cascade/i)
  })

  it('lists every BM25 object, then the extension, in the bm25.sql header and the README', () => {
    expect(removal).toHaveLength(6)
    const header = bm25
      .slice(0, bm25.search(/^CREATE EXTENSION IF NOT EXISTS/m))
      .split('\n')
      .map((l) => l.replace(/^--\s*/, '').trim())
      .filter((l) => l.startsWith('DROP '))
    const documented = lexicalSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('DROP '))
    expect(header).toEqual(removal)
    expect(documented).toEqual(removal)
  })
})
