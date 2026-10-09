/**
 * Every btree index on the item store tables must fit its rows under the
 * btree row limit (2,704 bytes per index tuple on 8 KB pages). A key longer
 * than that fails the write with 54000 and a message that names the index,
 * not the column or the rule, so each variable-length key column needs a
 * CHECK that bounds it. The bounds are read from the catalog, not from
 * schema.sql: pg_index and pg_attribute list every key and INCLUDE column
 * (expressions too), pg_constraint holds the CHECKs, and the bound of each key
 * is derived from the CHECK expressions as Postgres stores them. A key that no
 * CHECK bounds in a form this reader understands fails the test, so a new
 * index on unbounded text cannot slip in unnoticed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const ITEM_TABLES = [
  'memory_subjects',
  'memory_extraction_runs',
  'memory_projects',
  'memory_items',
  'memory_item_entities',
  'memory_item_links',
  'memory_capture_events',
  'memory_capture_event_counts',
  'memory_secret_hits',
  'memory_document_notes',
] as const

/** BTMaxItemSize for 8 KB pages, btree version 4. */
const BTREE_ROW_LIMIT = 2704
/** IndexTupleData header. */
const INDEX_TUPLE_HEADER = 8
/** Worst-case alignment padding before a column, plus a 4-byte varlena header for variable-length ones. */
const COLUMN_SLACK = 8
/** A UTF-8 character takes at most four bytes. */
const MAX_BYTES_PER_CHAR = 4

interface IndexColumn {
  index: string
  table: string
  position: number
  key: string
  typlen: number
}

interface CheckDef {
  table: string
  name: string
  def: string
}

/** Upper bounds a CHECK implies for one value: its length in characters and in bytes. */
interface Bound {
  chars: number
  bytes: number
}

interface KeyBound {
  key: string
  bytes: number
  checks: string[]
}

interface IndexReport {
  index: string
  table: string
  maxRowBytes: number
  keys: KeyBound[]
  unbounded: string[]
}

type Run = (sql: string) => Promise<string>

const tableList = `ARRAY[${ITEM_TABLES.map((t) => `'${t}'`).join(', ')}]`

async function readIndexColumns(run: Run): Promise<IndexColumn[]> {
  const json = await run(`
    SELECT coalesce(json_agg(json_build_object(
             'index', ic.relname, 'table', t.relname, 'position', a.attnum,
             'key', pg_get_indexdef(i.indexrelid, a.attnum, false), 'typlen', ty.typlen)
           ORDER BY t.relname, ic.relname, a.attnum), '[]'::json)
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_am am ON am.oid = ic.relam AND am.amname = 'btree'
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = i.indexrelid AND a.attnum > 0
      JOIN pg_type ty ON ty.oid = a.atttypid
     WHERE t.relname = ANY (${tableList});`)
  return JSON.parse(json) as IndexColumn[]
}

async function readChecks(run: Run): Promise<CheckDef[]> {
  const json = await run(`
    SELECT coalesce(json_agg(json_build_object(
             'table', t.relname, 'name', c.conname, 'def', pg_get_constraintdef(c.oid, false))
           ORDER BY t.relname, c.conname), '[]'::json)
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
     WHERE c.contype = 'c' AND t.relname = ANY (${tableList});`)
  return JSON.parse(json) as CheckDef[]
}

/** Index of the parenthesis closing the one at `open`, skipping quoted literals. */
function closingParen(text: string, open: number): number {
  let depth = 0
  let quoted = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'") quoted = !quoted
    if (quoted) continue
    if (ch === '(') depth++
    if (ch === ')' && --depth === 0) return i
  }
  return -1
}

function stripParens(text: string): string {
  let s = text.trim()
  while (s.startsWith('(') && closingParen(s, 0) === s.length - 1) s = s.slice(1, -1).trim()
  return s
}

/** Splits at every occurrence of ` <word> ` outside parentheses and quotes. */
function splitTopLevel(text: string, word: string): string[] {
  const parts: string[] = []
  const token = ` ${word} `
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'") quoted = !quoted
    if (quoted) continue
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && text.startsWith(token, i)) {
      parts.push(text.slice(start, i))
      start = i + token.length
      i += token.length - 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function maxBound(bounds: Bound[]): Bound {
  return {
    chars: Math.max(0, ...bounds.map((b) => b.chars)),
    bytes: Math.max(0, ...bounds.map((b) => b.bytes)),
  }
}

function minBound(bounds: Bound[]): Bound {
  return {
    chars: Math.min(...bounds.map((b) => b.chars)),
    bytes: Math.min(...bounds.map((b) => b.bytes)),
  }
}

/** Text literals of `'a'::text` or `ARRAY['a'::text, …]`, unescaped. */
function literals(text: string): string[] | undefined {
  const items = text.startsWith('ARRAY[') && text.endsWith(']') ? text.slice(6, -1).split(', ') : [text]
  const values: string[] = []
  for (const item of items) {
    const m = item.match(/^'((?:[^']|'')*)'::text$/)
    if (!m) return undefined
    values.push(m[1]!.replace(/''/g, "'"))
  }
  return values
}

function literalBound(values: string[]): Bound {
  return maxBound(values.map((v) => ({ chars: [...v].length, bytes: Buffer.byteLength(v, 'utf8') })))
}

/**
 * The longest string a fully anchored regex of printable-ASCII atoms can
 * match: `^[A-Z][a-z0-9-]{0,99}$` and the like, with a bounded repeat at
 * most. A literal or a class of ASCII characters matches one byte per
 * character; a negated class (`[^,]`) or `.` matches any character, up to
 * four bytes in UTF-8. Anything else (escapes, alternation, unbounded
 * repeats, non-ASCII) is not a bound.
 */
function regexBound(pattern: string): Bound | undefined {
  const m = pattern.match(/^\^(.*)\$$/)
  if (!m) return undefined
  const atom = /(\[[ -\[^-~]+\]|[A-Za-z0-9_-]|\.)(?:\{(\d+)(?:,(\d+))?\})?/y
  const body = m[1]!
  let chars = 0
  let bytes = 0
  let at = 0
  while (at < body.length) {
    atom.lastIndex = at
    const a = atom.exec(body)
    if (!a) return undefined
    const count = Number(a[3] ?? a[2] ?? 1)
    const anyCharacter = a[1] === '.' || a[1]!.startsWith('[^')
    chars += count
    bytes += count * (anyCharacter ? MAX_BYTES_PER_CHAR : 1)
    at = atom.lastIndex
  }
  return { chars, bytes }
}

/** The key whose NULL an expression asserts: `x IS NULL`, or `NOT (c ? 'k')` for the key `c ->> 'k'`. */
function isNullGuard(expr: string, key: string): boolean {
  if (expr === `${key} IS NULL` || expr === `(${key}) IS NULL`) return true
  const path = key.match(/^(\w+) ->> ('(?:[^']|'')*'::text)$/)
  return path !== null && stripParens(expr) === `NOT (${path[1]} ? ${path[2]})`
}

function sameKey(argument: string, key: string): boolean {
  return stripParens(argument) === key
}

/**
 * An upper bound on `key` (normalized, outer parentheses stripped) whenever
 * the CHECK expression `expr` is not false, or undefined when the expression
 * does not bound it. A CHECK passes on NULL, and every atom below is NULL only
 * when the key is: a conjunction is bounded by any bounded conjunct, a
 * disjunction only when every disjunct is, and a CASE only when every branch
 * is.
 */
function boundIn(rawExpr: string, key: string): Bound | undefined {
  const expr = stripParens(rawExpr)
  const conjuncts = splitTopLevel(expr, 'AND')
  if (conjuncts.length > 1) {
    const bounds = conjuncts.map((c) => boundIn(c, key)).filter((b): b is Bound => b !== undefined)
    return bounds.length === 0 ? undefined : minBound(bounds)
  }
  const disjuncts = splitTopLevel(expr, 'OR')
  if (disjuncts.length > 1) {
    const bounds = disjuncts.map((d) => boundIn(d, key))
    return bounds.every((b): b is Bound => b !== undefined) ? maxBound(bounds) : undefined
  }
  if (expr === 'false' || isNullGuard(expr, key)) return { chars: 0, bytes: 0 }

  const caseExpr = expr.match(/^CASE (\w+) (WHEN .*) ELSE (.*) END$/)
  if (caseExpr) {
    const branches = splitTopLevel(caseExpr[2]!, 'WHEN').map((b) => b.replace(/^WHEN /, ''))
    const results = [...branches.map((b) => splitTopLevel(b, 'THEN')[1]), caseExpr[3]]
    const bounds = results.map((r) => (r === undefined ? undefined : boundIn(r, key)))
    return bounds.every((b): b is Bound => b !== undefined) ? maxBound(bounds) : undefined
  }

  const length = expr.match(/^(char_length|octet_length)(\(.*\)) <= (\d+)$/)
  if (length && sameKey(length[2]!, key)) {
    const n = Number(length[3])
    return length[1] === 'octet_length' ? { chars: n, bytes: n } : { chars: n, bytes: n * MAX_BYTES_PER_CHAR }
  }

  for (const op of [' = ANY ', ' = ', ' ~ ']) {
    const at = expr.indexOf(op)
    if (at < 0 || !sameKey(expr.slice(0, at), key)) continue
    const right = stripParens(expr.slice(at + op.length))
    if (op === ' ~ ') {
      const pattern = literals(right)
      return pattern?.length === 1 ? regexBound(pattern[0]!) : undefined
    }
    const values = literals(right)
    return values ? literalBound(values) : undefined
  }
  return undefined
}

/**
 * The bound of one index key across all CHECKs of its table. lower() maps
 * character for character under the database's libc collation, but a
 * character's byte length can change, so only its character bound carries
 * over. COALESCE(x, 'literal') is bounded by both.
 */
function keyBound(rawKey: string, checks: CheckDef[]): { bound: Bound; checks: string[] } | undefined {
  const key = stripParens(rawKey)
  const lower = key.match(/^lower\((.*)\)$/)
  if (lower) {
    const inner = keyBound(lower[1]!, checks)
    if (!inner) return undefined
    const chars = inner.bound.chars
    return { bound: { chars, bytes: chars * MAX_BYTES_PER_CHAR }, checks: inner.checks }
  }
  const coalesce = key.match(/^COALESCE\((.*), ('(?:[^']|'')*'::text)\)$/)
  if (coalesce) {
    const inner = keyBound(coalesce[1]!, checks)
    const fallback = literals(coalesce[2]!)
    if (!inner || !fallback) return undefined
    return { bound: maxBound([inner.bound, literalBound(fallback)]), checks: inner.checks }
  }
  const found = checks
    .map((c) => ({ name: c.name, bound: boundIn(c.def.replace(/\s+/g, ' ').replace(/^CHECK /, ''), key) }))
    .filter((c): c is { name: string; bound: Bound } => c.bound !== undefined)
  if (found.length === 0) return undefined
  const bound = minBound(found.map((f) => f.bound))
  return { bound, checks: found.filter((f) => f.bound.bytes === bound.bytes).map((f) => f.name) }
}

async function indexReports(run: Run): Promise<IndexReport[]> {
  const columns = await readIndexColumns(run)
  const checks = await readChecks(run)
  const byIndex = new Map<string, IndexColumn[]>()
  for (const column of columns) byIndex.set(column.index, [...(byIndex.get(column.index) ?? []), column])
  return [...byIndex.entries()].map(([index, cols]) => {
    const table = cols[0]!.table
    const tableChecks = checks.filter((c) => c.table === table)
    const keys: KeyBound[] = []
    const unbounded: string[] = []
    let maxRowBytes = INDEX_TUPLE_HEADER
    for (const col of cols) {
      if (col.typlen > 0) {
        maxRowBytes += col.typlen + COLUMN_SLACK
        continue
      }
      const found = keyBound(col.key, tableChecks)
      if (!found) {
        unbounded.push(col.key)
        continue
      }
      keys.push({ key: col.key, bytes: found.bound.bytes, checks: found.checks })
      maxRowBytes += found.bound.bytes + COLUMN_SLACK
    }
    return { index, table, maxRowBytes, keys, unbounded }
  })
}

function violations(reports: IndexReport[]): string[] {
  return reports.flatMap((r) => [
    ...r.unbounded.map((key) => `${r.index} on ${r.table}: no CHECK bounds the key ${key}`),
    ...(r.unbounded.length === 0 && r.maxRowBytes > BTREE_ROW_LIMIT
      ? [`${r.index} on ${r.table}: a row may take ${r.maxRowBytes} bytes, over ${BTREE_ROW_LIMIT}`]
      : []),
  ])
}

describe.skipIf(!realPgImage)('btree index keys on the item store tables', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  it('bounds every variable-length key by a CHECK, so each index row fits the btree row limit', async () => {
    const reports = await indexReports((sql) => pg.psql(sql))
    expect(violations(reports)).toEqual([])
  }, TEST_TIMEOUT_MS)

  it('reads these bounds from the catalog, in bytes, with the CHECKs that hold them', async () => {
    const reports = await indexReports((sql) => pg.psql(sql))
    const bounds = Object.fromEntries(
      reports.flatMap((r) => r.keys.map((k) => [`${r.index}: ${k.key}`, `${k.bytes} by ${k.checks.join(', ')}`])),
    )
    expect(bounds).toEqual({
      'idx_capture_events_candidates: session_id': '1024 by memory_capture_events_session_id_check',
      'idx_capture_events_session: session_id': '1024 by memory_capture_events_session_id_check',
      'memory_capture_events_session_event_key: session_id': '1024 by memory_capture_events_session_id_check',
      'memory_document_notes_pkey: path': '2600 by memory_document_notes_path_check',
      'memory_capture_events_session_event_key: event_uuid': '512 by memory_capture_events_event_uuid_check',
      'idx_extraction_runs_session: session_id': '1024 by memory_extraction_runs_session_id_check',
      'idx_extraction_runs_anchor_version: extractor_version': '256 by memory_extraction_runs_extractor_version_check',
      'idx_extraction_runs_window_version: extractor_version': '256 by memory_extraction_runs_extractor_version_check',
      'idx_extraction_runs_window_version: window_key': '64 by memory_extraction_runs_window_key_check',
      'idx_item_entities_type_entity: entity_type': '7 by memory_item_entities_entity_type_check',
      'idx_item_entities_type_entity: entity': '2000 by memory_item_entities_entity_check',
      'memory_item_entities_pkey: entity': '2000 by memory_item_entities_entity_check',
      'memory_item_links_from_to_rel_key: rel': '8 by memory_item_links_rel_check',
      'idx_items_class_kind: class': '16 by memory_items_class_check',
      'idx_items_class_kind: kind': '15 by memory_items_kind_check',
      "idx_items_event_key: ((source ->> 'event_key'::text))": '2048 by memory_items_source_check',
      "idx_items_version_of: ((source ->> 'version_of'::text))": '2048 by memory_items_version_of_check',
      'idx_items_project: project_id': '100 by memory_items_ids_check',
      'idx_items_session: session_id': '1024 by memory_items_ids_check',
      'memory_projects_id_kind_key: id': '100 by memory_projects_id_check',
      'memory_projects_id_kind_key: kind': '9 by memory_projects_kind_check',
      'memory_projects_pkey: id': '100 by memory_projects_id_check',
      "idx_subjects_project_label: COALESCE(project_id, ''::text)": '100 by memory_subjects_project_id_check',
      'idx_subjects_project_label: lower(label)': '800 by memory_subjects_label_check',
    })
  }, TEST_TIMEOUT_MS)

  it('names a new index on an unbounded text column', async () => {
    const session = await pg.session()
    try {
      await session.run('BEGIN;')
      await session.run('CREATE INDEX tst_unbounded_cwd ON public.memory_capture_events (cwd, occurred_at);')
      const found = violations(await indexReports((sql) => session.run(sql)))
      expect(found).toContain('tst_unbounded_cwd on memory_capture_events: no CHECK bounds the key cwd')
      await session.run('ROLLBACK;')
    } finally {
      await session.close()
    }
  }, TEST_TIMEOUT_MS)
})

describe('reading a bound from a CHECK expression', () => {
  it('reads a disjunction as a bound only when every branch bounds the key', () => {
    expect(boundIn('((session_id IS NULL) OR (char_length(session_id) <= 10))', 'session_id')).toEqual({
      chars: 10,
      bytes: 40,
    })
    expect(boundIn("((kind = 'x'::text) OR (char_length(session_id) <= 10))", 'session_id')).toBeUndefined()
    expect(boundIn('((char_length(session_id) >= 1) AND (octet_length(session_id) <= 300))', 'session_id')).toEqual({
      chars: 300,
      bytes: 300,
    })
    expect(boundIn("(session_id ~ '^[a-z].*$'::text)", 'session_id')).toBeUndefined()
    expect(boundIn("(id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'::text)", 'id')).toEqual({ chars: 100, bytes: 100 })
    expect(boundIn("(register_prefix ~ '^[A-Z]{2,6}$'::text)", 'register_prefix')).toEqual({ chars: 6, bytes: 6 })
    expect(boundIn("CASE k WHEN 'a'::text THEN (session_id = 'abc'::text) ELSE true END", 'session_id')).toBeUndefined()
  })

  it('counts a negated class or a dot as four bytes, since each matches any character', () => {
    expect(boundIn("(cwd ~ '^[^,]{0,700}$'::text)", 'cwd')).toEqual({ chars: 700, bytes: 2800 })
    expect(boundIn("(cwd ~ '^.{0,10}$'::text)", 'cwd')).toEqual({ chars: 10, bytes: 40 })
    expect(boundIn("(cwd ~ '^[a-z][^/]{0,9}$'::text)", 'cwd')).toEqual({ chars: 10, bytes: 37 })
    expect(boundIn("(cwd ~ '^[a-z^]{0,9}$'::text)", 'cwd')).toEqual({ chars: 9, bytes: 9 })
  })

  it("fails an index whose key '^[^,]{0,700}$' bounds, over the btree row limit", () => {
    const checks: CheckDef[] = [{ table: 't', name: 't_cwd_check', def: "CHECK ((cwd ~ '^[^,]{0,700}$'::text))" }]
    const found = keyBound('cwd', checks)
    expect(found).toEqual({ bound: { chars: 700, bytes: 2800 }, checks: ['t_cwd_check'] })
    const report: IndexReport = {
      index: 'tst_cwd',
      table: 't',
      maxRowBytes: INDEX_TUPLE_HEADER + found!.bound.bytes + COLUMN_SLACK,
      keys: [{ key: 'cwd', bytes: found!.bound.bytes, checks: found!.checks }],
      unbounded: [],
    }
    expect(violations([report])).toEqual([`tst_cwd on t: a row may take 2816 bytes, over ${BTREE_ROW_LIMIT}`])
  })
})
