/**
 * Every timestamptz column of the item store tables, and every element of a
 * timestamptz[] column, must hold a time in years 1 to 9999 AD (UTC).
 * PostgreSQL stores 4713 BC to 294276 AD and the infinities, but to_json
 * writes a BC time as '0001-12-31T19:00:00+00:00 BC' and a later year with
 * five digits, and the item reader's Date parser accepts neither, so one such
 * value would fail every read of the rows around it. The columns are listed
 * from the catalog (pg_attribute) and each must appear in a CHECK as a
 * top-level conjunct engram_time_in_range(<column>), or
 * engram_times_in_range(<column>) for an array; a new timestamptz column
 * without one fails the test.
 */
import { randomUUID } from 'node:crypto'
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
  'memory_capture_events',
  'memory_capture_event_counts',
  'memory_secret_hits',
] as const

const BC = '0001-12-31T23:59:59Z BC'
const YEAR_12000 = '12000-01-01T00:00:00Z'

type Run = (sql: string) => Promise<string>

interface TimeColumn {
  table: string
  column: string
  isArray: boolean
}

interface CheckDef {
  table: string
  name: string
  def: string
}

const tableList = `ARRAY[${ITEM_TABLES.map((t) => `'${t}'`).join(', ')}]`

async function readTimeColumns(run: Run): Promise<TimeColumn[]> {
  return JSON.parse(
    await run(`
      SELECT coalesce(json_agg(json_build_object('table', c.relname, 'column', a.attname, 'isArray', t.typname = '_timestamptz')
               ORDER BY c.relname, a.attnum), '[]'::json)
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_type t ON t.oid = a.atttypid
       WHERE c.relname = ANY (${tableList}) AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND t.typname IN ('timestamptz', '_timestamptz');`),
  ) as TimeColumn[]
}

async function readChecks(run: Run): Promise<CheckDef[]> {
  return JSON.parse(
    await run(`
      SELECT coalesce(json_agg(json_build_object('table', t.relname, 'name', c.conname, 'def', pg_get_constraintdef(c.oid, false))
               ORDER BY t.relname, c.conname), '[]'::json)
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
       WHERE c.contype = 'c' AND t.relname = ANY (${tableList});`),
  ) as CheckDef[]
}

/** The expression without parentheses that enclose all of it. */
function stripParens(expr: string): string {
  let text = expr.trim()
  while (text.startsWith('(') && closingParen(text, 0) === text.length - 1) text = text.slice(1, -1).trim()
  return text
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

/** The operands of a top-level AND chain; one operand when there is none. */
function conjuncts(expr: string): string[] {
  const text = stripParens(expr)
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'") quoted = !quoted
    if (quoted) continue
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0 && text.startsWith(' AND ', i)) {
      parts.push(text.slice(start, i))
      start = i + 5
    }
  }
  parts.push(text.slice(start))
  return parts.map(stripParens)
}

/**
 * The column each range call guards, read from a CHECK definition. A call
 * counts only as a top-level conjunct: anywhere else (inside OR, NOT, CASE) the
 * CHECK could pass with the call false.
 */
function guardedColumns(def: string): Array<{ column: string; isArray: boolean }> {
  const expr = def.replace(/\s+/g, ' ').replace(/^CHECK /, '')
  return conjuncts(expr).flatMap((part) => {
    const m = part.match(/^(?:public\.)?engram_(time|times)_in_range\((\w+)\)$/)
    return m ? [{ column: m[2]!, isArray: m[1] === 'times' }] : []
  })
}

/** Each timestamptz column with the CHECKs that keep it in range; an empty list is a gap. */
async function rangeReport(run: Run): Promise<Record<string, string[]>> {
  const [columns, checks] = await Promise.all([readTimeColumns(run), readChecks(run)])
  return Object.fromEntries(
    columns.map((c) => [
      `${c.table}.${c.column}${c.isArray ? '[]' : ''}`,
      checks
        .filter((k) => k.table === c.table && guardedColumns(k.def).some((g) => g.column === c.column && g.isArray === c.isArray))
        .map((k) => k.name),
    ]),
  )
}

function gaps(report: Record<string, string[]>): string[] {
  return Object.entries(report)
    .filter(([, checks]) => checks.length === 0)
    .map(([column]) => `${column} has no range CHECK`)
}

describe.skipIf(!realPgImage)('times on the item store tables stay within years 1 to 9999', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  async function refusal(sql: string): Promise<string> {
    try {
      await pg.psql(`\\set VERBOSITY verbose\n${sql}`)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('the write was accepted')
  }

  async function insertArtifact(occurredAt = '2026-05-06T07:00:00Z'): Promise<string> {
    const id = randomUUID()
    await pg.psql(`INSERT INTO public.memory_items (id, class, kind, speaker, trust, content, search_text, occurred_at, source)
      VALUES ('${id}', 'artifact', 'commit', 'artifact', 1, 'chore: keep times in range', 'chore: keep times in range',
              '${occurredAt}', '{"type": "git"}'::jsonb);`)
    return id
  }

  it('lists every timestamptz column with the CHECK that keeps it in range', async () => {
    expect(await rangeReport((sql) => pg.psql(sql))).toEqual({
      'memory_capture_events.occurred_at': ['memory_capture_events_finite_check'],
      'memory_capture_events.received_at': ['memory_capture_events_finite_check'],
      'memory_capture_events.processed_at': ['memory_capture_events_finite_check'],
      'memory_extraction_runs.started_at': ['memory_extraction_runs_finite_check'],
      'memory_extraction_runs.finished_at': ['memory_extraction_runs_finite_check'],
      'memory_items.occurred_at': ['memory_items_finite_check'],
      'memory_items.valid_to': ['memory_items_finite_check'],
      'memory_items.restated_at[]': ['memory_items_finite_check'],
      'memory_items.retired_at': ['memory_items_finite_check'],
      'memory_items.forgotten_at': ['memory_items_finite_check'],
      'memory_items.created_at': ['memory_items_finite_check'],
      'memory_projects.updated_at': ['memory_projects_finite_check'],
      'memory_secret_hits.found_at': ['memory_secret_hits_finite_check'],
      'memory_subjects.created_at': ['memory_subjects_finite_check'],
    })
  }, TEST_TIMEOUT_MS)

  it('names a new timestamptz column without the range CHECK, or with a weaker one', async () => {
    const session = await pg.session()
    try {
      await session.run('BEGIN;')
      await session.run(`ALTER TABLE public.memory_capture_events ADD COLUMN tst_seen_at timestamptz;
        ALTER TABLE public.memory_items ADD COLUMN tst_finite_at timestamptz CHECK (isfinite(tst_finite_at));
        ALTER TABLE public.memory_items ADD COLUMN tst_either_at timestamptz
          CHECK (public.engram_time_in_range(tst_either_at) OR tst_either_at > now());
        ALTER TABLE public.memory_items ADD COLUMN tst_seen_ats timestamptz[] CHECK (public.engram_time_in_range(tst_seen_ats[1]));`)
      expect(gaps(await rangeReport((sql) => session.run(sql)))).toEqual([
        'memory_capture_events.tst_seen_at has no range CHECK',
        'memory_items.tst_finite_at has no range CHECK',
        'memory_items.tst_either_at has no range CHECK',
        'memory_items.tst_seen_ats[] has no range CHECK',
      ])
      await session.run('ROLLBACK;')
    } finally {
      await session.close()
    }
  }, TEST_TIMEOUT_MS)

  it('accepts the first and last instants of the range and nothing outside it', async () => {
    expect(
      await pg.psql(`SELECT concat_ws(',',
        public.engram_time_in_range('0001-01-01T00:00:00Z'), public.engram_time_in_range('${BC}'),
        public.engram_time_in_range('9999-12-31T23:59:59.999999Z'), public.engram_time_in_range('10000-01-01T00:00:00Z'),
        public.engram_time_in_range('0001-01-01T00:00:00+01:00'), public.engram_time_in_range('infinity'),
        public.engram_time_in_range('-infinity'), public.engram_time_in_range(NULL),
        public.engram_times_in_range('{}'), public.engram_times_in_range(ARRAY[NULL]::timestamptz[]),
        public.engram_times_in_range(ARRAY['2026-01-01T00:00:00Z', '${YEAR_12000}']::timestamptz[]))`),
    ).toBe('t,f,t,f,f,f,f,t,t,f,f')
  }, TEST_TIMEOUT_MS)

  it.each([
    ['occurred_at', 'a BC time', BC],
    ['occurred_at', 'year 12000', YEAR_12000],
  ])('refuses an item whose %s is %s', async (_column, _label, value) => {
    const message = await refusal(
      `INSERT INTO public.memory_items (class, kind, speaker, trust, content, search_text, occurred_at, source)
         VALUES ('artifact', 'commit', 'artifact', 1, 'chore: out of range', 'chore: out of range', '${value}', '{"type": "git"}'::jsonb);`,
    )
    expect(message).toMatch(/ERROR:\s+23514: new row for relation "memory_items" violates check constraint "memory_items_finite_check"/)
    expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE content = 'chore: out of range'`)).toBe('0')
  }, TEST_TIMEOUT_MS)

  it.each([
    ['retired_at', 'a BC time', `retired_at = '${BC}', retired_reason = 'tst: retired long ago'`],
    ['retired_at', 'year 12000', `retired_at = '${YEAR_12000}', retired_reason = 'tst: retired far ahead'`],
    ['a restated_at element', 'a BC time', `restated_at = ARRAY['2026-05-06T08:00:00Z', '${BC}']::timestamptz[]`],
    ['a restated_at element', 'year 12000', `restated_at = ARRAY['${YEAR_12000}']::timestamptz[]`],
  ])('refuses an UPDATE that sets %s to %s', async (_column, _label, assignment) => {
    const id = await insertArtifact()
    const message = await refusal(`UPDATE public.memory_items SET ${assignment} WHERE id = '${id}';`)
    expect(message).toMatch(/ERROR:\s+23514: new row for relation "memory_items" violates check constraint "memory_items_finite_check"/)
    expect(await pg.psql(`SELECT retired_at IS NULL AND restated_at = '{}' FROM public.memory_items WHERE id = '${id}'`)).toBe('t')
  }, TEST_TIMEOUT_MS)

  it('stores the last instant of year 9999 and the first of year 1 and writes both as ISO-8601', async () => {
    const id = await insertArtifact('0001-01-01T00:00:00Z')
    await pg.psql(`UPDATE public.memory_items SET retired_at = '9999-12-31T23:59:59.999999Z', retired_reason = 'tst: at the end'
      WHERE id = '${id}';`)
    expect(await pg.psql(`SELECT to_json(occurred_at) || ' ' || to_json(retired_at) FROM public.memory_items WHERE id = '${id}'`)).toBe(
      '"0001-01-01T00:00:00+00:00" "9999-12-31T23:59:59.999999+00:00"',
    )
  }, TEST_TIMEOUT_MS)

  it.each([
    ['memory_capture_events', `INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload)
       VALUES ('tst-range-session', 'tst-range-event', 'user_prompt', '${YEAR_12000}', '{}'::jsonb);`],
    ['memory_extraction_runs', `INSERT INTO public.memory_extraction_runs (extractor_version, status, started_at)
       VALUES ('tst-extractor-1', 'running', '${BC}');`],
    ['memory_projects', `INSERT INTO public.memory_projects (id, kind, updated_at) VALUES ('tst-range-project', 'project', '${BC}');`],
    ['memory_secret_hits', `INSERT INTO public.memory_secret_hits (found_at, target_table, target_id, field, detector)
       VALUES ('${YEAR_12000}', 'memory_items', 'tst-target', 'content', 'tst-detector');`],
    ['memory_subjects', `INSERT INTO public.memory_subjects (label, created_at) VALUES ('tst range subject', '${BC}');`],
  ])('refuses a %s row with a time out of range', async (table, sql) => {
    expect(await refusal(sql)).toMatch(new RegExp(`ERROR:\\s+23514: .*violates check constraint "${table}_finite_check"`))
  }, TEST_TIMEOUT_MS)
})
