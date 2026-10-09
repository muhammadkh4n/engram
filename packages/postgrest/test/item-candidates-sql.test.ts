/**
 * engram_item_candidates is the one statement recall reads item candidates
 * through. It is SECURITY DEFINER and assembles the text of each leg at run
 * time, so these checks hold its text in bm25.sql to the rules that keep that
 * safe and predictable:
 * - the signature and result shape callers bind to, its language, volatility
 *   and SET clause, EXECUTE for service_role only, and a dependency on
 *   pg_textsearch so DROP EXTENSION removes it with the operators it uses;
 * - every leg runs through EXECUTE ... USING, and no caller value is ever
 *   spliced into SQL text: no quote_literal, no %L, no || followed by a p_
 *   argument and no format() call that takes one;
 * - a leg's text holds no "$n IS NULL OR" arms, so the planner sees only the
 *   predicates a request needs;
 * - the class and kind vocabulary the function validates against is exactly
 *   the one memory_items_kind_check admits, and every history-only kind
 *   belongs to one class, so leaving those kinds out by name leaves out
 *   exactly the history pairs;
 * - memory_items carries the fts column and GIN index the lexical leg
 *   matches phrases on.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const bm25 = readFileSync(new URL('../bm25.sql', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

const CANDIDATES = 'engram_item_candidates'
const VALIDATE = 'engram_item_candidates_validate'
const LEG_SQL = 'engram_item_candidates_leg_sql'

/** Argument types of each function, as privilege statements name them. */
const SIGNATURES: Record<string, string> = {
  [VALIDATE]: 'public.vector, text, public.vector, text[], text[], text[], boolean, smallint, integer, text',
  [LEG_SQL]: 'text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean',
  [CANDIDATES]:
    'public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text',
}

const CANDIDATE_PARAMS = [
  'p_embedding public.vector DEFAULT NULL::public.vector',
  'p_query text DEFAULT NULL::text',
  'p_terms text[] DEFAULT NULL::text[]',
  'p_hyde_embedding public.vector DEFAULT NULL::public.vector',
  'p_entities text[] DEFAULT NULL::text[]',
  'p_classes text[] DEFAULT NULL::text[]',
  'p_kinds text[] DEFAULT NULL::text[]',
  'p_project_id text DEFAULT NULL::text',
  'p_exclude_session text DEFAULT NULL::text',
  'p_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone',
  'p_include_history boolean DEFAULT false',
  'p_max_observation_trust smallint DEFAULT NULL::smallint',
  'p_k integer DEFAULT 50',
  'p_force_path text DEFAULT NULL::text',
]

const HISTORY_PAIRS = [
  'artifact:commit',
  'artifact:pr',
  'document_section:plan_ledger_log',
  'session_index:session',
  'utterance:assistant_turn',
]

interface FunctionText {
  params: string[]
  returns: string
  attributes: string
  body: string
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

function functionText(name: string): FunctionText {
  const m = bm25.match(
    new RegExp(
      `^CREATE OR REPLACE FUNCTION public\\.${name}\\(([^)]*)\\) RETURNS (.+)\\n((?: {4}.+\\n)*?) {4}AS \\$\\$\\n([\\s\\S]*?)\\$\\$;$`,
      'm',
    ),
  )
  if (!m) throw new Error(`${name} not found in bm25.sql`)
  return {
    params: m[1]!.split(', '),
    returns: m[2]!,
    attributes: m[3]!.replace(/\s+/g, ' ').trim(),
    body: stripComments(m[4]!),
  }
}

/** Every format( call's argument text, up to its matching parenthesis. */
function formatCalls(body: string): string[] {
  const calls: string[] = []
  for (const m of body.matchAll(/\bformat\s*\(/g)) {
    let depth = 1
    let i = m.index! + m[0].length
    const start = i
    while (i < body.length && depth > 0) {
      if (body[i] === '(') depth += 1
      if (body[i] === ')') depth -= 1
      i += 1
    }
    calls.push(body.slice(start, i - 1))
  }
  return calls
}

function arrayConstant(body: string, name: string): string[] {
  const m = body.match(new RegExp(`${name} CONSTANT text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`))
  if (!m) throw new Error(`${name} not found`)
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((v) => v[1]!).sort()
}

/** class:kind pairs memory_items_kind_check admits, read from schema.sql. */
function checkPairs(): string[] {
  const m = schema.match(/CONSTRAINT memory_items_kind_check CHECK \(CASE class\n([\s\S]*?)\n\s*ELSE false END\)/)
  if (!m) throw new Error('memory_items_kind_check not found')
  const pairs: string[] = []
  for (const line of m[1]!.matchAll(/WHEN '(\w+)' THEN kind IN \(([^)]*)\)/g)) {
    for (const kind of line[2]!.matchAll(/'(\w+)'/g)) pairs.push(`${line[1]}:${kind[1]}`)
  }
  return pairs.sort()
}

describe('engram_item_candidates signature and privileges', () => {
  it('takes the request arguments in order and returns ids, legs, ranks, raw scores and paths', () => {
    const fn = functionText(CANDIDATES)
    expect(fn.params).toEqual(CANDIDATE_PARAMS)
    expect(fn.returns).toBe(
      'TABLE(item_id uuid, leg text, rank integer, raw_score double precision, path text)',
    )
  })

  it('is VOLATILE SECURITY DEFINER plpgsql with a fixed search_path', () => {
    expect(functionText(CANDIDATES).attributes).toBe(
      "LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'",
    )
  })

  it.each([VALIDATE, LEG_SQL])('declares %s IMMUTABLE with a fixed search_path', (name) => {
    expect(functionText(name).attributes).toBe("LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'")
  })

  it.each(Object.keys(SIGNATURES))('revokes %s from PUBLIC, anon and authenticated, and grants it to service_role', (name) => {
    const signature = `public.${name}(${SIGNATURES[name]})`
    const defined = bm25.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
    const revoke = bm25.indexOf(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`)
    const apiRevoke = bm25.indexOf(`EXECUTE format('REVOKE EXECUTE ON FUNCTION ${signature} FROM %I', role_name);`)
    const grant = bm25.indexOf(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`)
    expect(defined).toBeGreaterThan(-1)
    expect(revoke).toBeGreaterThan(defined)
    expect(apiRevoke).toBeGreaterThan(defined)
    expect(grant).toBeGreaterThan(defined)
  })

  it.each(Object.keys(SIGNATURES))('declares %s dependent on pg_textsearch, so DROP EXTENSION removes it', (name) => {
    const statement = `ALTER FUNCTION public.${name}(${SIGNATURES[name]}) DEPENDS ON EXTENSION pg_textsearch;`
    expect(bm25.indexOf(statement)).toBeGreaterThan(bm25.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`))
  })
})

describe('engram_item_candidates assembles SQL only from fixed fragments', () => {
  it.each([CANDIDATES, VALIDATE, LEG_SQL])('%s splices no caller value into text', (name) => {
    const { body } = functionText(name)
    expect(body).not.toMatch(/quote_literal/i)
    expect(body).not.toContain('%L')
    expect(body).not.toMatch(/\|\|\s*p_\w/)
    for (const call of formatCalls(body)) expect(call).not.toMatch(/\bp_\w/)
  })

  it('runs every leg through EXECUTE with its values in USING', () => {
    const { body } = functionText(CANDIDATES)
    const executes = body.match(/\bEXECUTE\b[\s\S]*?(?:\bLOOP\b|;)/g) ?? []
    expect(executes.length).toBeGreaterThan(0)
    for (const execute of executes) expect(execute).toMatch(/^EXECUTE v_sql\s+USING /)
    expect(body).not.toMatch(/\bRETURN QUERY\s+SELECT\b/i)
  })

  it('builds every leg with one helper and puts no "$n IS NULL OR" arm in any text', () => {
    expect(functionText(CANDIDATES).body).toMatch(new RegExp(`public\\.${LEG_SQL}\\(`))
    const { body } = functionText(LEG_SQL)
    expect(body).not.toMatch(/\$\d+\s+IS\s+NULL\s+OR\b/i)
    expect(body).not.toMatch(/\bIS\s+NULL\s+OR\s+\$\d+/i)
  })

  it('documents the positional USING order at the helper', () => {
    const header = bm25.slice(0, bm25.indexOf(`CREATE OR REPLACE FUNCTION public.${LEG_SQL}(`))
    const comment = header.slice(header.lastIndexOf('\n\n'))
    for (const position of ['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$10', '$11', '$12', '$13']) {
      expect(comment).toContain(position)
    }
  })

  it('scans the exact branch from a materialized CTE that holds no ORDER BY', () => {
    const { body } = functionText(LEG_SQL)
    const cte = body.slice(body.indexOf('WITH filtered AS MATERIALIZED ('), body.indexOf('FROM filtered f'))
    expect(cte).toContain('i.embedding <=> ')
    expect(cte).not.toMatch(/ORDER BY/)
    expect(body).toContain("' SELECT f.id, 1 - f.d AS score FROM filtered f ORDER BY f.d, f.id LIMIT $13'")
  })

  it('matches lexical terms as phrases on fts and scores them with the item BM25 index', () => {
    const { body } = functionText(LEG_SQL)
    expect(body).toContain("phraseto_tsquery(''english'', t)")
    expect(body).toContain('i.fts @@ mt.q')
    expect(body).toContain("''idx_items_bm25''")
    expect(body.match(/LIMIT 500/g)).toHaveLength(2)
  })
})

describe('engram_item_candidates vocabulary', () => {
  const body = functionText(VALIDATE).body
  const vocabulary = arrayConstant(body, 'c_vocabulary')
  const history = arrayConstant(body, 'c_history')
  const check = checkPairs()
  const kindClasses = (kind: string): string[] =>
    check.filter((p) => p.split(':')[1] === kind).map((p) => p.split(':')[0]!)

  it('validates against exactly the class:kind pairs memory_items_kind_check admits', () => {
    expect(check.length).toBeGreaterThan(0)
    expect(vocabulary).toEqual(check)
  })

  it('holds the history-only pairs, all of them admitted pairs', () => {
    expect(history).toEqual(HISTORY_PAIRS)
    for (const pair of history) expect(check).toContain(pair)
  })

  it('names each history kind under one class only, so excluding it by kind excludes that pair alone', () => {
    for (const pair of history) expect(kindClasses(pair.split(':')[1]!)).toEqual([pair.split(':')[0]])
  })

  it('treats every session_index kind as history, so the class is history-only', () => {
    const sessionKinds = check.filter((p) => p.startsWith('session_index:'))
    expect(sessionKinds.length).toBeGreaterThan(0)
    for (const pair of sessionKinds) expect(history).toContain(pair)
  })

  it('names each legacy kind under the legacy class only', () => {
    const legacyKinds = check.filter((p) => p.startsWith('legacy:')).map((p) => p.split(':')[1]!)
    expect(legacyKinds.length).toBeGreaterThan(0)
    for (const kind of legacyKinds) expect(kindClasses(kind)).toEqual(['legacy'])
  })
})

describe('memory_items fts column', () => {
  it('adds the generated english tsvector of search_text and its GIN index after the table', () => {
    const table = schema.indexOf('CREATE TABLE IF NOT EXISTS public.memory_items (')
    const column = schema.indexOf(
      "ALTER TABLE public.memory_items ADD COLUMN IF NOT EXISTS fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(search_text, ''))) STORED;",
    )
    const index = schema.indexOf('CREATE INDEX IF NOT EXISTS idx_items_fts ON public.memory_items USING gin (fts);')
    expect(table).toBeGreaterThan(-1)
    expect(column).toBeGreaterThan(table)
    expect(index).toBeGreaterThan(column)
  })
})
