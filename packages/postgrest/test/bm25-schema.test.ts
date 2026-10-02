/**
 * bm25.sql is an optional add-on applied after schema.sql on a server that
 * preloads pg_textsearch. These checks hold its text to the invariants the
 * planner and the recall filters depend on:
 * - each BM25 index is partial on exactly the rows recall may return, so its
 *   term statistics describe only those rows;
 * - every index is built with k1 = 1.2 and b = 0.4, and re-applying the file
 *   drops and rebuilds an index whose stored options differ, since
 *   pg_textsearch reads k1 and b from the metapage written at build time;
 * - engram_bm25_match matches exactly what engram_text_match matches: one
 *   phraseto_tsquery per term on each tier's GIN fts column, under the same
 *   tier predicates. pg_textsearch's own query ORs an identifier's parts, so
 *   it only scores rows and never selects them;
 * - each tier scores a bounded number of rows, selects the bare <@> score
 *   once per row, and leaves the rank_score filter outside the tiers;
 * - pg_textsearch's own functions are executable by no role but their
 *   owner, since PostgREST serves public and would expose them as /rpc
 *   endpoints; they are found through pg_depend, so a newer extension
 *   version's functions are covered when the file is re-applied;
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
  options: string
  predicate: string | null
}

function bm25Indexes(): Bm25Index[] {
  const re =
    /CREATE INDEX IF NOT EXISTS (\w+) ON public\.(\w+)\s+USING bm25 \((.+?)\) WITH \(([^)]*)\)(?:\s+WHERE ([^;]+))?;/g
  return [...bm25.matchAll(re)].map((m) => ({
    name: m[1]!,
    table: m[2]!,
    expr: m[3]!,
    options: m[4]!,
    predicate: m[5] ? m[5].replace(/\s+/g, ' ').trim() : null,
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

/** The options every BM25 index is built with: english, k1 = 1.2, b = 0.4. */
const INDEX_OPTIONS = "text_config = 'english', k1 = 1.2, b = 0.4"

/** pg_class.reloptions entries the options above are stored as. */
const STORED_OPTIONS = ['text_config=english', 'k1=1.2', 'b=0.4']

/** The DO block that drops BM25 indexes built with other options, squashed; '' when absent. */
function convergenceBlock(): string {
  const firstIndex = bm25.search(/^CREATE INDEX IF NOT EXISTS/m)
  if (firstIndex < 0) return ''
  const blocks = [...bm25.slice(0, firstIndex).matchAll(/^DO \$\$\n([\s\S]*?)\n\$\$;$/gm)]
  const block = blocks.find((m) => /\bDROP INDEX\b/.test(m[1]!))
  return block ? squash(block[1]!) : ''
}

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
        options: INDEX_OPTIONS,
        predicate: tier.predicate,
      })
    }
  })

  it('builds every index with k1 = 1.2 and b = 0.4', () => {
    const indexes = bm25Indexes()
    expect(indexes).toHaveLength(4)
    for (const index of indexes) {
      expect(index.options).toBe(INDEX_OPTIONS)
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

describe('bm25.sql converges existing BM25 indexes to the target options', () => {
  it('runs a convergence block before the BM25 indexes are created', () => {
    expect(convergenceBlock()).not.toBe('')
  })

  it('compares stored reloptions with exactly the options the CREATE statements use', () => {
    const block = convergenceBlock()
    const target = block.match(/target text\[\] := ARRAY\[([^\]]*)\];/)
    expect(target).not.toBeNull()
    const entries = target![1]!.split(',').map((e) => e.trim().replace(/^'|'$/g, ''))
    expect(entries).toEqual(STORED_OPTIONS)
    const fromCreate = INDEX_OPTIONS.split(',').map((o) => o.replace(/\s+/g, '').replace(/'/g, ''))
    expect(entries).toEqual(fromCreate)
    expect(block).toContain(
      "AND NOT (coalesce(c.reloptions, '{}') @> target AND coalesce(c.reloptions, '{}') <@ target)",
    )
  })

  it('considers exactly the four BM25 indexes in public', () => {
    const block = convergenceBlock()
    const names = block.match(/c\.relname IN \(([^)]*)\)/)
    expect(names).not.toBeNull()
    const listed = names![1]!.split(',').map((n) => n.trim().replace(/^'|'$/g, ''))
    expect([...listed].sort()).toEqual(bm25Indexes().map((i) => i.name).sort())
    expect(block).toContain("WHERE n.nspname = 'public' AND c.relkind = 'i'")
  })

  it('drops each mismatched index by name, without a dependent-object drop', () => {
    const block = convergenceBlock()
    expect(block).toContain("EXECUTE format('DROP INDEX public.%I', index_name);")
    expect(block.match(/DROP INDEX/g)).toHaveLength(1)
  })

  it('names the convergence among what re-applying does', () => {
    const header = squash(bm25.slice(0, bm25.search(/^CREATE EXTENSION IF NOT EXISTS/m)).replace(/^--\s*/gm, ''))
    expect(header).toContain('Re-applying also converges the BM25 indexes')
  })
})

describe("bm25.sql revokes EXECUTE on pg_textsearch's own functions", () => {
  /** The DO block between CREATE EXTENSION and the first BM25 index, squashed; '' when absent. */
  function revokeBlock(): string {
    const start = bm25.search(/^CREATE EXTENSION IF NOT EXISTS pg_textsearch;$/m)
    const end = bm25.search(/^CREATE INDEX IF NOT EXISTS/m)
    if (start < 0 || end < 0) return ''
    const m = bm25.slice(start, end).match(/^DO \$\$\n([\s\S]*?)\n\$\$;$/m)
    return m ? squash(m[1]!) : ''
  }

  it('runs right after CREATE EXTENSION, before any BM25 index is built', () => {
    expect(revokeBlock()).not.toBe('')
  })

  it('finds the functions through pg_depend on the pg_textsearch extension row, not by name', () => {
    const block = revokeBlock()
    expect(block).toContain('SELECT d.objid::regprocedure FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid')
    expect(block).toContain(
      "WHERE d.refclassid = 'pg_extension'::regclass AND d.classid = 'pg_proc'::regclass " +
        "AND d.deptype = 'e' AND e.extname = 'pg_textsearch'",
    )
    expect(block).not.toMatch(/bm25_\w+\(/)
  })

  it('revokes EXECUTE from PUBLIC and from every other grantee except the owner', () => {
    const block = revokeBlock()
    expect(block).toContain("EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC', fn);")
    expect(block).toContain('CROSS JOIN LATERAL aclexplode(p.proacl) acl')
    expect(block).toContain("AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> p.proowner")
    expect(block).toContain("EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM %I', fn, role_name);")
  })

  it('grants EXECUTE back to no role; the only grant is engram_bm25_match to service_role', () => {
    const grants = bm25.match(/^.*\bGRANT\b.*$/gm) ?? []
    expect(grants).toEqual([
      'GRANT EXECUTE ON FUNCTION public.engram_bm25_match(text[], integer, text, text) TO service_role;',
    ])
  })

  it('names the revoke among the statements that make re-applying safe', () => {
    const header = bm25.slice(0, bm25.search(/^CREATE EXTENSION IF NOT EXISTS/m))
    const reapply = squash(header.slice(header.indexOf('-- Idempotent and safe to re-apply')).replace(/^--\s*/gm, ''))
    expect(reapply).toMatch(/^Idempotent and safe to re-apply: [^.]*\brevoke of EXECUTE on pg_textsearch's own functions/)
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
      expect(conjuncts(whereOf(candidate, /ORDER BY/))).toEqual(expected)
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
        /row_number\(\) OVER \(ORDER BY ts_rank_cd\(([a-z])\.fts, mt\.q, 2\) DESC, \1\.id\) AS term_rank/,
      )
      expect(squash(branch)).toContain(
        'GROUP BY c.id ORDER BY min(c.term_rank), c.id LIMIT (SELECT candidate_cap FROM bounds)',
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
      expect(squash(branch)).toMatch(/\) ORDER BY bm25_score, [a-z]{2}\.id LIMIT p_match_count \) \w+\s*$/)
      expect(branch).not.toContain('rank_score')
    }
  })

  it('negates the score and filters rank_score > 0 only outside the tiers', () => {
    const outer = squash(body.slice(body.indexOf(') tiers')))
    expect(squash(body)).toContain('SELECT id, memory_type, -bm25_score::float AS rank_score FROM (')
    expect(outer).toMatch(
      /\) combined WHERE rank_score > 0 ORDER BY rank_score DESC, memory_type, id LIMIT p_match_count$/,
    )
  })
})

// A cut over tied scores keeps whichever tied rows the scan meets first, and
// heap order changes whenever a row is rewritten (recall's own shown_count
// update writes a new tuple). Every ORDER BY that feeds a LIMIT or a
// row_number() therefore ends in a key that is unique within its rows.
describe('bm25.sql engram_bm25_match cuts are deterministic under ties', () => {
  it("orders each term's candidate LIMIT by the window's key, ending in the row id", () => {
    for (const branch of tierBranches().values()) {
      const lateral = squash(candidateQuery(branch))
      expect(lateral).toMatch(
        /^SELECT ([a-z])\.id, row_number\(\) OVER \(ORDER BY ts_rank_cd\(\1\.fts, mt\.q, 2\) DESC, \1\.id\) AS term_rank .* ORDER BY ts_rank_cd\(\1\.fts, mt\.q, 2\) DESC, \1\.id LIMIT \(SELECT candidate_cap FROM bounds\)$/,
      )
    }
  })

  it('ends every tier cut in the id of the row it scores', () => {
    const branches = tierBranches()
    for (const [type, tier] of Object.entries(TIERS)) {
      const branch = squash(branches.get(type)!)
      expect(branch).toContain(`ORDER BY bm25_score, ${tier.alias}.id LIMIT p_match_count`)
    }
  })

  it('breaks ties across tiers on memory_type then id, unique over the union', () => {
    // Each ORDER BY immediately followed by its LIMIT: three per tier and the outer one.
    const orderBys = [...squash(body).matchAll(/ORDER BY ((?:(?!ORDER BY)[^;])*?) LIMIT/g)].map((m) => m[1]!)
    expect(orderBys).toHaveLength(13)
    for (const orderBy of orderBys) expect(orderBy).toMatch(/\bid$/)
    expect(orderBys.at(-1)).toBe('rank_score DESC, memory_type, id')
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
