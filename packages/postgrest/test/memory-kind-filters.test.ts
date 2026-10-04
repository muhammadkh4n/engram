/**
 * The search functions filter by memory kind and can leave out one session.
 * These checks hold schema.sql and bm25.sql to:
 * - engram_episode_kind computes the same kind as core's memoryKind() for
 *   every episode case in the shared case file. The CASE in its body is
 *   parsed and evaluated here with SQL semantics (->> yields NULL for an
 *   absent key or JSON null, comparisons with NULL are unknown), so a rule
 *   written differently in SQL fails against the same cases;
 * - the function is IMMUTABLE with no SET clause, so it can be inlined and
 *   indexed, and idx_episodes_kind indexes it on the rows recall can return;
 * - engram_vector_search, engram_text_match and engram_bm25_match append
 *   p_kinds and p_exclude_session_id with NULL defaults, each tier applies
 *   them, and every previous signature is dropped before the new one is
 *   created: two functions of one name are an overload PostgREST cannot
 *   resolve;
 * - only the new signatures carry privilege statements.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const bm25 = readFileSync(new URL('../bm25.sql', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

interface KindCase {
  why: string
  tier: string
  metadata?: Record<string, unknown> | null
  sessionId?: string | null
  kind: string
}

const cases = JSON.parse(
  readFileSync(new URL('../../core/src/memory-kind.cases.json', import.meta.url), 'utf8'),
) as KindCase[]
const episodeCases = cases.filter((c) => c.tier === 'episode')

function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

function definition(sql: string, name: string): { header: string; body: string; offset: number } {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([\\s\\S]*?)AS \\$\\$([\\s\\S]*?)\\$\\$;`)
  const m = sql.match(re)
  if (!m) throw new Error(`function ${name} not found`)
  return { header: m[1]!, body: m[2]!, offset: m.index! }
}

// ---------------------------------------------------------------------------
// A minimal evaluator for the CASE in engram_episode_kind. It accepts only
// the forms the rules need and throws on anything else, so a new construct
// in the SQL has to be taught here before the cases can pass.
// ---------------------------------------------------------------------------

type Sql = string | null
type Truth = boolean | null
type Token =
  | { t: 'field'; key: string }
  | { t: 'session' }
  | { t: 'str'; value: string }
  | { t: 'sym'; value: '(' | ')' | ',' | '=' }
  | { t: 'kw'; value: 'IN' | 'IS' | 'NULL' | 'AND' | 'OR' }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  const re = /\s*(?:p_metadata->>'(\w+)'|(p_session_id)\b|'([^']*)'|([(),=])|(IN|IS|NULL|AND|OR)\b)/y
  let pos = 0
  const rest = expr.trimEnd()
  while (pos < rest.length) {
    re.lastIndex = pos
    const m = re.exec(rest)
    if (!m) throw new Error(`unsupported SQL in kind rule at: ${rest.slice(pos)}`)
    if (m[1] !== undefined) tokens.push({ t: 'field', key: m[1] })
    else if (m[2] !== undefined) tokens.push({ t: 'session' })
    else if (m[3] !== undefined) tokens.push({ t: 'str', value: m[3] })
    else if (m[4] !== undefined) tokens.push({ t: 'sym', value: m[4] as '(' | ')' | ',' | '=' })
    else tokens.push({ t: 'kw', value: m[5] as 'IN' | 'IS' | 'NULL' | 'AND' | 'OR' })
    pos = re.lastIndex
  }
  return tokens
}

/** `metadata->>'key'` as Postgres returns it. */
function textOf(metadata: Record<string, unknown> | null | undefined, key: string): Sql {
  const value = metadata?.[key]
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function evaluate(expr: string, row: KindCase): Truth {
  const tokens = tokenize(expr)
  let i = 0
  const peek = (): Token | undefined => tokens[i]
  const isKw = (v: string) => peek()?.t === 'kw' && (peek() as { value: string }).value === v
  const isSym = (v: string) => peek()?.t === 'sym' && (peek() as { value: string }).value === v
  const expectSym = (v: string) => {
    if (!isSym(v)) throw new Error(`expected ${v} in: ${expr}`)
    i++
  }

  const operand = (): Sql => {
    const tok = tokens[i++]
    if (tok?.t === 'field') return textOf(row.metadata, tok.key)
    if (tok?.t === 'session') return row.sessionId ?? null
    if (tok?.t === 'str') return tok.value
    throw new Error(`expected an operand in: ${expr}`)
  }

  const predicate = (): Truth => {
    if (isSym('(')) {
      i++
      const inner = or()
      expectSym(')')
      return inner
    }
    const left = operand()
    if (isSym('=')) {
      i++
      const right = operand()
      return left === null || right === null ? null : left === right
    }
    if (isKw('IN')) {
      i++
      expectSym('(')
      const list: string[] = []
      for (;;) {
        const tok = tokens[i++]
        if (tok?.t !== 'str') throw new Error(`IN list holds a non-literal in: ${expr}`)
        list.push(tok.value)
        if (isSym(',')) {
          i++
          continue
        }
        expectSym(')')
        break
      }
      return left === null ? null : list.includes(left)
    }
    if (isKw('IS')) {
      i++
      if (!isKw('NULL')) throw new Error(`only IS NULL is supported in: ${expr}`)
      i++
      return left === null
    }
    throw new Error(`unsupported predicate in: ${expr}`)
  }

  const and = (): Truth => {
    let value = predicate()
    while (isKw('AND')) {
      i++
      const right = predicate()
      value = value === false || right === false ? false : value === null || right === null ? null : true
    }
    return value
  }

  const or = (): Truth => {
    let value = and()
    while (isKw('OR')) {
      i++
      const right = and()
      value = value === true || right === true ? true : value === null || right === null ? null : false
    }
    return value
  }

  const result = or()
  if (i !== tokens.length) throw new Error(`trailing tokens in: ${expr}`)
  return result
}

interface Rule {
  when: string
  kind: string
}

function kindRules(): { rules: Rule[]; otherwise: string } {
  const body = squash(definition(schema, 'engram_episode_kind').body)
  const m = body.match(/^SELECT CASE (.*) ELSE '(\w+)' END$/)
  if (!m) throw new Error(`engram_episode_kind is not a single CASE:\n${body}`)
  const rules = [...m[1]!.matchAll(/WHEN (.+?) THEN '(\w+)'/g)].map((r) => ({ when: r[1]!, kind: r[2]! }))
  expect(m[1]!.replace(/WHEN (.+?) THEN '(\w+)'/g, '').trim()).toBe('')
  return { rules, otherwise: m[2]! }
}

function sqlKind(row: KindCase): string {
  const { rules, otherwise } = kindRules()
  return rules.find((rule) => evaluate(rule.when, row) === true)?.kind ?? otherwise
}

describe('engram_episode_kind', () => {
  it('is an IMMUTABLE, parallel-safe SQL function with no SET clause and no SECURITY DEFINER', () => {
    const { header } = definition(schema, 'engram_episode_kind')
    expect(squash(header)).toBe(
      'p_metadata jsonb, p_session_id text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE',
    )
  })

  it('lists the episode kinds in rule order, with turn as the fallback', () => {
    const { rules, otherwise } = kindRules()
    expect(rules.map((r) => r.kind)).toEqual([
      'summary',
      'commit',
      'ruling',
      'proposal',
      'knowledge',
      'decision',
      'progress',
      'note',
      'note',
    ])
    expect(otherwise).toBe('turn')
    expect(new Set([...rules.map((r) => r.kind), otherwise])).toEqual(new Set(episodeCases.map((c) => c.kind)))
  })

  it('has episode cases in the shared case file', () => {
    expect(episodeCases.length).toBeGreaterThan(20)
  })

  it.each(episodeCases.map((c) => [c.why, c] as const))('%s', (_why, row) => {
    expect(sqlKind(row)).toBe(row.kind)
  })

  it('evaluates ->> on a non-string value as its text, which matches no rule string', () => {
    expect(
      sqlKind({ why: 'boolean category', tier: 'episode', metadata: { salienceCategory: true }, sessionId: 'x', kind: '' }),
    ).toBe('turn')
    expect(sqlKind({ why: 'numeric source', tier: 'episode', metadata: { source: 3 }, sessionId: null, kind: '' })).toBe(
      'turn',
    )
  })
})

describe('idx_episodes_kind', () => {
  const statement =
    'CREATE INDEX IF NOT EXISTS idx_episodes_kind ON public.memory_episodes USING btree (public.engram_episode_kind(metadata, session_id)) WHERE (forgotten_at IS NULL);'

  it('indexes the kind of every episode recall can return', () => {
    expect(schema).toContain(statement)
  })

  it('is created after the function and the table it reads', () => {
    const at = schema.indexOf(statement)
    expect(at).toBeGreaterThan(definition(schema, 'engram_episode_kind').offset)
    expect(at).toBeGreaterThan(schema.indexOf('CREATE TABLE IF NOT EXISTS public.memory_episodes'))
  })
})

const SEARCH_FUNCTIONS = [
  { file: 'schema.sql', sql: schema, name: 'engram_vector_search', old: '(public.vector, integer, text, text)', args: '(public.vector, integer, text, text, text[], text)' },
  { file: 'schema.sql', sql: schema, name: 'engram_text_match', old: '(text[], integer, text, text)', args: '(text[], integer, text, text, text[], text)' },
  { file: 'bm25.sql', sql: bm25, name: 'engram_bm25_match', old: '(text[], integer, text, text)', args: '(text[], integer, text, text, text[], text)' },
] as const

/** The tier branches of a search body, keyed by the memory_type literal each selects. */
function branches(body: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const chunk of body.split('UNION ALL')) {
    const type = chunk.match(/'(\w+)'::text/)
    if (!type) throw new Error(`branch without a memory_type literal:\n${chunk}`)
    found.set(type[1]!, squash(chunk))
  }
  return found
}

describe.each(SEARCH_FUNCTIONS)('$file $name', ({ sql, name, old, args }) => {
  const { header, body, offset } = definition(sql, name)

  it('appends p_kinds and p_exclude_session_id with NULL defaults', () => {
    expect(squash(header)).toMatch(
      /p_project_id text DEFAULT NULL::text, p_kinds text\[\] DEFAULT NULL::text\[\], p_exclude_session_id text DEFAULT NULL::text\) RETURNS/,
    )
  })

  it('is created once, after a drop of the signature without the filters', () => {
    const creates = stripComments(sql).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`, 'g'))
    expect(creates).toHaveLength(1)
    const drop = sql.indexOf(`DROP FUNCTION IF EXISTS public.${name}${old};`)
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(offset)
  })

  it('names the old signature only in a drop', () => {
    const lines = stripComments(sql)
      .split('\n')
      .filter((line) => line.includes(`${name}${old}`))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.trim()).toBe(`DROP FUNCTION IF EXISTS public.${name}${old};`)
  })

  it('revokes and grants EXECUTE on the new signature', () => {
    expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION public.${name}${args} FROM PUBLIC;`)
    expect(sql).toContain(`EXECUTE format('REVOKE EXECUTE ON FUNCTION public.${name}${args} FROM %I', role_name);`)
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${name}${args} TO service_role;`)
  })

  it('filters episodes by their derived kind and leaves out the excluded session', () => {
    const episode = branches(body).get('episode')!
    expect(episode).toMatch(
      /AND \(p_kinds IS NULL OR engram_episode_kind\((\w+)\.metadata, \1\.session_id\) = ANY\(p_kinds\)\)/,
    )
    expect(episode).toMatch(
      /AND \(p_exclude_session_id IS NULL OR (\w+)\.session_id IS DISTINCT FROM p_exclude_session_id\)/,
    )
  })

  it('skips the episode scan through a parameter-only test when no requested kind is an episode kind', () => {
    const episode = branches(body).get('episode')!
    const guard = episode.match(/AND \(p_kinds IS NULL OR p_kinds && ARRAY\[([^\]]*)\]\)/)
    expect(guard).not.toBeNull()
    const listed = [...guard![1]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!)
    const { rules, otherwise } = kindRules()
    expect(new Set(listed)).toEqual(new Set([...rules.map((r) => r.kind), otherwise]))
    expect(listed).toHaveLength(new Set(listed).size)
    // A clause naming no column is what the planner turns into a one-time
    // filter; the row classifier stays a separate condition.
    expect(guard![0]).not.toMatch(/\w+\.\w+/)
    for (const [type, chunk] of branches(body)) {
      if (type !== 'episode') expect(chunk).not.toContain('p_kinds &&')
    }
  })

  it('keeps digests only for the digest kind and applies the session exclusion to them', () => {
    const digest = branches(body).get('digest')!
    expect(digest).toContain("AND (p_kinds IS NULL OR 'digest' = ANY(p_kinds))")
    expect(digest).toMatch(/AND \(p_exclude_session_id IS NULL OR \w+\.session_id IS DISTINCT FROM p_exclude_session_id\)/)
  })

  it('keeps semantic rows for fact and procedural rows for procedure; neither has a session', () => {
    const all = branches(body)
    expect(all.get('semantic')).toContain("AND (p_kinds IS NULL OR 'fact' = ANY(p_kinds))")
    expect(all.get('procedural')).toContain("AND (p_kinds IS NULL OR 'procedure' = ANY(p_kinds))")
    expect(all.get('semantic')).not.toContain('p_exclude_session_id')
    expect(all.get('procedural')).not.toContain('p_exclude_session_id')
  })

  it('reads each filter parameter only inside a NULL-guarded condition', () => {
    expect(body.match(/\bp_kinds\b/g)).toHaveLength(10)
    expect(body.match(/p_kinds IS NULL OR/g)).toHaveLength(5)
    expect(body.match(/\bp_exclude_session_id\b/g)).toHaveLength(4)
    expect(body.match(/p_exclude_session_id IS NULL OR/g)).toHaveLength(2)
  })
})

describe('schema.sql privileges for the kind function', () => {
  it('revokes it from PUBLIC and the API roles and grants it to service_role', () => {
    expect(schema).toContain('REVOKE EXECUTE ON FUNCTION public.engram_episode_kind(jsonb, text) FROM PUBLIC;')
    expect(schema).toContain(
      "EXECUTE format('REVOKE EXECUTE ON FUNCTION public.engram_episode_kind(jsonb, text) FROM %I', role_name);",
    )
    expect(schema).toContain('GRANT EXECUTE ON FUNCTION public.engram_episode_kind(jsonb, text) TO service_role;')
  })
})

describe('schema.sql post-apply smoke', () => {
  it('calls both filtered search functions, so the kind function runs at apply time', () => {
    expect(schema).toContain(
      "PERFORM public.engram_text_match(ARRAY['smoke'], 1, NULL, NULL, ARRAY['note', 'digest', 'fact', 'procedure'], 'smoke');",
    )
    expect(schema).toContain(
      "PERFORM public.engram_vector_search(v_unit, 1, NULL, NULL, ARRAY['note', 'digest', 'fact', 'procedure'], 'smoke');",
    )
  })
})

describe('README documents the kinds and the filters', () => {
  const section = readme.slice(readme.indexOf('**Memory kinds and the search filters:**'))

  it('names the function, the index, both parameters and the schema cache reload', () => {
    expect(section.length).toBeGreaterThan(0)
    const note = section.slice(0, section.indexOf('\n'))
    for (const term of [
      'engram_episode_kind(metadata jsonb, session_id text)',
      'idx_episodes_kind',
      'p_kinds text[] DEFAULT NULL',
      'p_exclude_session_id text DEFAULT NULL',
      "NOTIFY pgrst, 'reload schema';",
      'REINDEX INDEX public.idx_episodes_kind',
    ]) {
      expect(note).toContain(term)
    }
  })
})
