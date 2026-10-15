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
 *   matches phrases on;
 * - the vector legs' access path: the four policy numbers live in one
 *   settings function, the path function compares with <=, the HNSW branch
 *   re-sorts with a full sort, and the candidate and explain functions name
 *   every setting they change in a SET clause, change each only with a local
 *   set_config and put back the value they read before.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const bm25 = readFileSync(new URL('../bm25.sql', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

const CANDIDATES = 'engram_item_candidates'
const EXPLAIN = 'engram_item_candidates_explain'
const VALIDATE = 'engram_item_candidates_validate'
const LEG_SQL = 'engram_item_candidates_leg_sql'
const SETTINGS = 'engram_item_access_settings'
const ACCESS_PATH = 'engram_item_access_path'

const CANDIDATE_TYPES =
  'public.vector, text, text[], public.vector, text[], text[], text[], text, text, timestamp with time zone, boolean, smallint, integer, text'

/** Argument types of each function, as privilege statements name them. */
const SIGNATURES: Record<string, string> = {
  [SETTINGS]: '',
  [ACCESS_PATH]: 'bigint',
  [VALIDATE]: 'public.vector, text, public.vector, text[], text[], text[], boolean, smallint, integer, text',
  [LEG_SQL]: 'text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean',
  [CANDIDATES]: CANDIDATE_TYPES,
  [EXPLAIN]: `${CANDIDATE_TYPES}, boolean`,
}

/** The SET clauses both reading functions declare, in order. */
const POLICY_SET_CLAUSES = [
  "SET search_path TO 'public'",
  "SET enable_seqscan TO 'on'",
  "SET enable_bitmapscan TO 'on'",
  "SET enable_sort TO 'on'",
  "SET hnsw.iterative_scan TO 'off'",
  "SET hnsw.ef_search TO '40'",
  "SET hnsw.max_scan_tuples TO '20000'",
]

/** The value the HNSW branch gives each setting it changes. */
const HNSW_VALUES: Record<string, string> = {
  enable_seqscan: "'off'",
  enable_bitmapscan: "'off'",
  enable_sort: "'off'",
  'hnsw.iterative_scan': "'relaxed_order'",
  'hnsw.ef_search': 'v_settings.ef_search::text',
  'hnsw.max_scan_tuples': 'v_settings.max_scan_tuples::text',
}

/** The one positional USING list every leg statement receives. */
const USING_LIST = [
  'p_embedding', 'p_query', 'p_terms', 'p_hyde_embedding', 'p_entities', 'v_classes', 'p_kinds', 'v_hidden_kinds',
  'p_project_id', 'p_exclude_session', 'p_as_of', 'p_max_observation_trust', 'p_k', 'v_probe_cap', 'v_fetch',
]

/** The sizes the exact-scan threshold may take: the measured grid, or exact at every size. */
const THRESHOLD_VALUES = [1000, 2000, 5000, 10000, 20000, 40000, 80000, 2147483647]

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

  it('explains the same arguments plus p_analyze and returns legs, paths, filtered sizes and plans', () => {
    const fn = functionText(EXPLAIN)
    expect(fn.params).toEqual([...CANDIDATE_PARAMS, 'p_analyze boolean DEFAULT false'])
    expect(fn.returns).toBe('TABLE(leg text, path text, filtered_rows bigint, plan jsonb)')
  })

  it.each([CANDIDATES, EXPLAIN])(
    'declares %s VOLATILE SECURITY DEFINER plpgsql with a SET clause for every setting the policy changes',
    (name) => {
      expect(functionText(name).attributes).toBe(
        ['LANGUAGE plpgsql VOLATILE SECURITY DEFINER', ...POLICY_SET_CLAUSES].join(' '),
      )
    },
  )

  it.each([VALIDATE, LEG_SQL])('declares %s IMMUTABLE with a fixed search_path', (name) => {
    expect(functionText(name).attributes).toBe("LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'")
  })

  it.each([SETTINGS, ACCESS_PATH])('declares %s an IMMUTABLE SQL function with a fixed search_path', (name) => {
    expect(functionText(name).attributes).toMatch(/^LANGUAGE sql IMMUTABLE (?:STRICT )?SET search_path TO 'public'$/)
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
  it.each([CANDIDATES, EXPLAIN, VALIDATE, LEG_SQL, SETTINGS, ACCESS_PATH])('%s splices no caller value into text', (name) => {
    const { body } = functionText(name)
    expect(body).not.toMatch(/quote_literal/i)
    expect(body).not.toContain('%L')
    expect(body).not.toMatch(/\|\|\s*p_\w/)
    for (const call of formatCalls(body)) expect(call).not.toMatch(/\bp_\w/)
  })

  it.each([CANDIDATES, EXPLAIN])('%s runs every statement through EXECUTE with the one USING list', (name) => {
    const { body } = functionText(name)
    const executes = body.match(/\bEXECUTE\b[\s\S]*?(?:\bLOOP\b|;)/g) ?? []
    expect(executes.length).toBeGreaterThan(1)
    for (const execute of executes) {
      const m = execute.match(/^EXECUTE v_sql\s+(?:INTO v_\w+\s+)?USING ([\s\S]*?)\s*(?:\bLOOP|;)$/)
      expect(m, execute).not.toBeNull()
      expect(m![1]!.split(/\s*,\s*/)).toEqual(USING_LIST)
    }
    expect(body).not.toMatch(/\bRETURN QUERY\s+SELECT\b/i)
  })

  it('builds every leg with one helper and puts no "$n IS NULL OR" arm in any text', () => {
    expect(functionText(CANDIDATES).body).toMatch(new RegExp(`public\\.${LEG_SQL}\\(`))
    expect(functionText(EXPLAIN).body).toMatch(new RegExp(`public\\.${LEG_SQL}\\(`))
    const { body } = functionText(LEG_SQL)
    expect(body).not.toMatch(/\$\d+\s+IS\s+NULL\s+OR\b/i)
    expect(body).not.toMatch(/\bIS\s+NULL\s+OR\s+\$\d+/i)
  })

  it('documents the positional USING order at the helper', () => {
    const header = bm25.slice(0, bm25.indexOf(`CREATE OR REPLACE FUNCTION public.${LEG_SQL}(`))
    const comment = header.slice(header.lastIndexOf('\n\n'))
    for (let position = 1; position <= USING_LIST.length; position += 1) {
      expect(comment).toMatch(new RegExp(`\\$${position}\\s`))
    }
  })

  it('scans the exact branch from a materialized CTE that holds no ORDER BY', () => {
    const { body } = functionText(LEG_SQL)
    const cte = body.slice(body.indexOf('WITH filtered AS MATERIALIZED ('), body.indexOf('FROM filtered f'))
    expect(cte).toContain('i.embedding <=> ')
    expect(cte).not.toMatch(/ORDER BY/)
    expect(body).toContain("' SELECT f.id, 1 - f.d AS score FROM filtered f ORDER BY f.d, f.id LIMIT $13'")
  })

  it('walks the HNSW index in a materialized CTE and re-sorts it with a full sort', () => {
    const { body } = functionText(LEG_SQL)
    const cte = body.slice(body.indexOf('WITH relaxed AS MATERIALIZED ('), body.indexOf('FROM relaxed r'))
    expect(cte).toContain("' ORDER BY i.embedding <=> ' || v_vector || ' LIMIT $15)'")
    // d + 0: PostgreSQL 17 passes the CTE's index order up, and ORDER BY d
    // would plan an Incremental Sort that trusts the relaxed order.
    expect(body).toContain("' SELECT r.id, 1 - r.d AS score FROM relaxed r ORDER BY r.d + 0, r.id LIMIT $13'")
  })

  it('counts the visible rows up to the probe cap', () => {
    const { body } = functionText(LEG_SQL)
    expect(body).toContain("' WHERE i.embedding IS NOT NULL AND ' || v_visible || ' LIMIT $14) s'")
  })

  it('matches lexical terms as phrases on fts and scores them with the item BM25 index', () => {
    const { body } = functionText(LEG_SQL)
    expect(body).toContain("phraseto_tsquery(''english'', t)")
    expect(body).toContain('i.fts @@ mt.q')
    expect(body).toContain("''idx_items_bm25''")
    expect(body.match(/LIMIT 500/g)).toHaveLength(2)
  })
})

describe('engram_item_candidates access path policy', () => {
  /** set_config calls in a body: [setting, value, is_local]. */
  function setConfigCalls(body: string): [string, string, string][] {
    return [...body.matchAll(/set_config\('([\w.]+)',\s*([^,]+?),\s*(\w+)\)/g)].map((m) => [m[1]!, m[2]!, m[3]!])
  }

  it('keeps the four policy numbers in the settings function', () => {
    const m = functionText(SETTINGS).body.match(/^\s*SELECT (\d+), (\d+), (\d+), (\d+);\s*$/)
    expect(m).not.toBeNull()
    const [exactMaxRows, efSearch, overfetch, maxScanTuples] = m!.slice(1).map(Number)
    expect(functionText(SETTINGS).returns).toBe(
      'TABLE(exact_max_rows integer, ef_search integer, overfetch integer, max_scan_tuples integer)',
    )
    expect(THRESHOLD_VALUES).toContain(exactMaxRows)
    expect(efSearch).toBe(400)
    expect(overfetch).toBe(2)
    expect(maxScanTuples).toBe(20000)
  })

  it('takes the exact path at or below exact_max_rows, read from the settings function', () => {
    const fn = functionText(ACCESS_PATH)
    expect(fn.params).toEqual(['p_filtered_rows bigint'])
    expect(fn.returns).toBe('text')
    expect(fn.body).toContain("CASE WHEN p_filtered_rows <= s.exact_max_rows THEN 'exact' ELSE 'hnsw' END")
    expect(fn.body).toContain(`FROM public.${SETTINGS}() AS s`)
  })

  it.each([CANDIDATES, EXPLAIN])('%s reads its numbers from the settings function and its path from the path function', (name) => {
    const { body } = functionText(name)
    expect(body).toContain(`FROM public.${SETTINGS}() AS s;`)
    expect(body).toContain(`coalesce(p_force_path, public.${ACCESS_PATH}(v_count))`)
    expect(body).not.toMatch(/\b(20000|400)\b/)
  })

  it.each([CANDIDATES, EXPLAIN])('%s changes only settings its SET clauses name, each locally, and puts each back', (name) => {
    const { body } = functionText(name)
    const calls = setConfigCalls(body)
    const declared = POLICY_SET_CLAUSES.map((clause) => clause.split(' ')[1]!).filter((s) => s !== 'search_path')
    expect(calls.map(([, , isLocal]) => isLocal).every((isLocal) => isLocal === 'true')).toBe(true)
    expect([...new Set(calls.map(([setting]) => setting))].sort()).toEqual([...declared].sort())

    const saved = body.match(/v_saved := ARRAY\[([\s\S]*?)\];/)
    expect(saved).not.toBeNull()
    const savedOrder = [...saved![1]!.matchAll(/current_setting\('([\w.]+)'\)/g)].map((m) => m[1]!)
    expect([...savedOrder].sort()).toEqual([...declared].sort())
    for (const setting of declared) {
      const values = calls.filter(([s]) => s === setting).map(([, value]) => value)
      expect(values).toEqual([HNSW_VALUES[setting], `v_saved[${savedOrder.indexOf(setting) + 1}]`])
    }
  })

  it('explains each statement with a fixed EXPLAIN prefix in front of the helper text', () => {
    const { body } = functionText(EXPLAIN)
    expect(body).toContain("c_explain CONSTANT text := 'EXPLAIN (FORMAT JSON) ';")
    expect(body).toContain("c_explain_analyze CONSTANT text := 'EXPLAIN (ANALYZE, FORMAT JSON) ';")
    expect(body).toMatch(
      new RegExp(`v_sql := CASE WHEN v_analyze THEN c_explain_analyze ELSE c_explain END\\s+\\|\\| public\\.${LEG_SQL}\\(`),
    )
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
