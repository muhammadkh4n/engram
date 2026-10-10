/**
 * The pure parts of the candidate statement's exact-scan measurement: the
 * threshold rule, its percentiles, the seeded query vectors, the seed and
 * timing SQL, and the argument parser. Everything that touches a container
 * lives in engram-access-path.ts.
 *
 * The threshold rule: exact_max_rows is the largest size in THRESHOLD_GRID
 * whose exact-branch p95 is at most BUDGET_MS, over QUERY_VECTORS query
 * vectors times TIMED_CALLS timed calls after one warm-up call per size, with
 * parallel workers off. If the smallest size already exceeds the budget, the
 * value is the smallest size and the result says so.
 */

export const THRESHOLD_GRID = [1000, 2000, 5000, 10000, 20000, 40000, 80000] as const
export const BUDGET_MS = 250
export const QUERY_VECTORS = 20
export const TIMED_CALLS = 3
export const DIMS = 1536
export const DEFAULT_K = 50
/** Seeded rows occur one minute apart from this instant, so an as-of bound selects a prefix of them. */
export const SEED_BASE_TIME = '2026-01-01T00:00:00.000Z'
export const SEED_BATCH_ROWS = 5000
export const MIN_TEXT_CHARS = 200
export const MAX_TEXT_CHARS = 2000
export const DEFAULT_SEED = 1729

/** Text for synthetic search_text; fixed so every seed is reproducible. */
export const WORDS = [
  'anchor', 'basin', 'cedar', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'island', 'juniper',
  'kernel', 'lantern', 'meadow', 'nickel', 'orchard', 'pepper', 'quarry', 'ribbon', 'saddle', 'timber',
  'umbrella', 'velvet', 'walnut', 'yarrow', 'zephyr', 'bridge', 'canyon', 'driftwood', 'estuary', 'falcon',
  'glacier', 'heron', 'inkwell', 'jasper', 'kestrel', 'lagoon', 'marble', 'nectar', 'obsidian', 'pebble',
  'quiver', 'rampart', 'sorrel', 'thistle', 'upland', 'vortex', 'willow', 'xylem', 'yonder', 'zinnia',
  'migration', 'schema', 'index', 'replica', 'latency', 'budget', 'cursor', 'buffer', 'vector', 'ranking',
] as const

const CONTAINER_NAME = /^[a-z0-9][\w.-]*$/i
const MINUTE_MS = 60_000

export interface TimingSummary {
  calls: number
  p50: number
  p95: number
  max: number
}

export interface SizeTimings {
  size: number
  timingsMs: readonly number[]
}

export interface SizeResult extends TimingSummary {
  size: number
  withinBudget: boolean
}

export interface ThresholdResult {
  exactMaxRows: number
  /** False when even the smallest measured size is over the budget. */
  anyWithinBudget: boolean
  rows: SizeResult[]
}

/** Nearest-rank percentile: the smallest value with at least p% of the values at or below it. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of no values')
  if (!(p > 0 && p <= 100)) throw new Error(`percentile must be in (0, 100], got ${p}`)
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}

export function summarize(timingsMs: readonly number[]): TimingSummary {
  return {
    calls: timingsMs.length,
    p50: percentile(timingsMs, 50),
    p95: percentile(timingsMs, 95),
    max: Math.max(...timingsMs),
  }
}

/** Applies the threshold rule to timings per grid size. */
export function applyThresholdRule(measured: readonly SizeTimings[], budgetMs: number = BUDGET_MS): ThresholdResult {
  if (measured.length === 0) throw new Error('the threshold rule needs at least one measured size')
  const rows = [...measured]
    .sort((a, b) => a.size - b.size)
    .map(({ size, timingsMs }) => {
      const summary = summarize(timingsMs)
      return { size, ...summary, withinBudget: summary.p95 <= budgetMs }
    })
  const within = rows.filter((r) => r.withinBudget)
  return {
    exactMaxRows: within.length > 0 ? within[within.length - 1].size : rows[0].size,
    anyWithinBudget: within.length > 0,
    rows,
  }
}

/** mulberry32: a small seeded generator of uniform numbers in [0, 1). */
export function seededUniform(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A unit vector with normally distributed components (Box-Muller), so its direction is uniform on the sphere. */
export function unitVector(uniform: () => number, dims: number = DIMS): number[] {
  const values: number[] = []
  while (values.length < dims) {
    const u1 = 1 - uniform()
    const u2 = uniform()
    const radius = Math.sqrt(-2 * Math.log(u1))
    values.push(radius * Math.cos(2 * Math.PI * u2), radius * Math.sin(2 * Math.PI * u2))
  }
  const components = values.slice(0, dims)
  const norm = Math.sqrt(components.reduce((sum, x) => sum + x * x, 0))
  return components.map((x) => x / norm)
}

export function queryVectors(seed: number, count: number = QUERY_VECTORS, dims: number = DIMS): number[][] {
  const uniform = seededUniform(seed)
  return Array.from({ length: count }, () => unitVector(uniform, dims))
}

export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`
}

/** The as-of bound under which exactly `size` seeded rows are visible. */
export function asOfForSize(size: number, base: string = SEED_BASE_TIME): string {
  if (!Number.isInteger(size) || size < 1) throw new Error(`size must be a positive integer, got ${size}`)
  return new Date(Date.parse(base) + (size - 1) * MINUTE_MS).toISOString()
}

/** setseed takes a value in [-1, 1]; an integer seed maps into it one to one below 2^31. */
export function pgSeed(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 31) throw new Error(`seed must be an integer in [0, 2^31), got ${seed}`)
  return seed / 2 ** 31
}

/**
 * SQL that writes `rows` synthetic document notes after checking the table is
 * empty: search_text of 200 to 2000 characters drawn from WORDS, a unit
 * embedding with normally distributed components, occurred_at one minute
 * apart from SEED_BASE_TIME. Postgres' random() and random_normal() draw from
 * one generator per session, seeded by setseed, so the same seed writes the
 * same rows. Each batch is its own INSERT so progress shows. Every lateral
 * subquery refers to g: the planner may cache a lateral subquery's result per
 * value of the outer columns it reads (Memoize), and one keyed on the text
 * length alone would hand two rows of equal length the same text.
 */
export function seedSql(rows: number, seed: number = DEFAULT_SEED): string {
  if (!Number.isInteger(rows) || rows < 1) throw new Error(`rows must be a positive integer, got ${rows}`)
  const words = `ARRAY[${WORDS.map((w) => `'${w}'`).join(', ')}]::text[]`
  const statements = [
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.memory_items) THEN
       RAISE EXCEPTION 'memory_items is not empty: seed a fresh database'; END IF; END $$;`,
    `SELECT setseed(${pgSeed(seed)});`,
  ]
  for (let start = 1; start <= rows; start += SEED_BATCH_ROWS) {
    const end = Math.min(rows, start + SEED_BATCH_ROWS - 1)
    statements.push(
      `INSERT INTO public.memory_items (class, kind, speaker, trust, content, search_text, embedding, embedding_model,
                                       occurred_at, source)
       SELECT 'document_section', 'note', 'artifact', 1, t.body, t.body, e.v, 'synthetic-unit',
              timestamptz '${SEED_BASE_TIME}' + (g - 1) * interval '1 minute', '{"type": "vault"}'::jsonb
         FROM generate_series(${start}, ${end}) AS g
         CROSS JOIN LATERAL (SELECT left(string_agg((${words})[1 + floor(random() * ${WORDS.length})::int], ' '), n.chars) AS body
                               FROM (SELECT ${MIN_TEXT_CHARS} + floor(random() * ${MAX_TEXT_CHARS - MIN_TEXT_CHARS + 1})::int AS chars
                                      WHERE g IS NOT NULL) n
                               CROSS JOIN generate_series(1, n.chars / 3) AS w
                              GROUP BY n.chars) t
         CROSS JOIN LATERAL (SELECT public.l2_normalize(array_agg(random_normal())::real[]::public.vector) AS v
                               FROM generate_series(1, ${DIMS}) AS d WHERE g IS NOT NULL) e;`,
      `\\echo seeded ${end} rows`,
    )
  }
  statements.push('ANALYZE public.memory_items;', 'SELECT count(*) FROM public.memory_items;')
  return statements.join('\n')
}

export interface TimedCall {
  label: 'warmup' | 'timed'
  query: number
}

/** One warm-up call, then TIMED_CALLS rounds over every query vector. */
export function callSchedule(queries: number = QUERY_VECTORS, rounds: number = TIMED_CALLS): TimedCall[] {
  const timed = Array.from({ length: rounds }, () =>
    Array.from({ length: queries }, (_, q) => ({ label: 'timed' as const, query: q + 1 })),
  ).flat()
  return [{ label: 'warmup', query: 1 }, ...timed]
}

/**
 * SQL that times the exact branch for one size: the query vectors go into a
 * temporary table, then each scheduled call runs
 * engram_item_candidates_explain with p_analyze and prints
 * label|query|filtered_rows|path|execution ms|statements.
 */
export function latencySql(size: number, vectors: readonly number[][], k: number = DEFAULT_K): string {
  const values = vectors.map((v, i) => `(${i + 1}, '${vectorLiteral(v)}'::public.vector)`).join(',\n')
  const lines = [
    // Quiet mode keeps command tags (SET, INSERT 0 20) out of the rows parseLatencyOutput reads.
    '\\set QUIET on',
    'SET max_parallel_workers_per_gather = 0;',
    'CREATE TEMP TABLE access_path_queries (n integer PRIMARY KEY, v public.vector);',
    `INSERT INTO access_path_queries VALUES ${values};`,
  ]
  for (const call of callSchedule(vectors.length)) {
    lines.push(
      `SELECT '${call.label}', q.n, max(e.filtered_rows), string_agg(e.path, ','),
              sum((e.plan -> 0 ->> 'Execution Time')::double precision), count(*)
         FROM access_path_queries q
         CROSS JOIN LATERAL public.engram_item_candidates_explain(p_embedding => q.v,
              p_as_of => timestamptz '${asOfForSize(size)}', p_k => ${k}, p_force_path => 'exact', p_analyze => true) e
        WHERE q.n = ${call.query}
        GROUP BY q.n;`,
    )
  }
  return lines.join('\n')
}

export interface CallResult {
  label: 'warmup' | 'timed'
  query: number
  executionMs: number
}

/** Parses latencySql's output and refuses any call that did not run one exact statement over `size` rows. */
export function parseLatencyOutput(output: string, size: number): CallResult[] {
  const results = output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [label, query, filtered, path, ms, statements] = line.split('|')
      if (label !== 'warmup' && label !== 'timed') throw new Error(`unexpected output line: ${line}`)
      if (Number(filtered) !== size) throw new Error(`size ${size}: a call filtered ${filtered} rows`)
      if (path !== 'exact' || statements !== '1') throw new Error(`size ${size}: a call ran ${statements} statement(s) on ${path}`)
      // Number('') is 0, so an empty field must be refused before it is converted.
      if (!/^\d+(\.\d+)?$/.test(ms ?? '')) throw new Error(`size ${size}: no execution time in ${line}`)
      const executionMs = Number(ms)
      return { label, query: Number(query), executionMs } as CallResult
    })
  const expected = callSchedule().length
  if (results.length !== expected) throw new Error(`size ${size}: ${results.length} calls, expected ${expected}`)
  return results
}

export function formatTable(result: ThresholdResult, budgetMs: number = BUDGET_MS): string {
  const lines = [
    `| filtered rows | timed calls | p50 ms | p95 ms | max ms | p95 <= ${budgetMs} ms |`,
    '|---:|---:|---:|---:|---:|:---:|',
    ...result.rows.map(
      (r) =>
        `| ${r.size} | ${r.calls} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} | ${r.withinBudget ? 'yes' : 'no'} |`,
    ),
  ]
  return lines.join('\n')
}

export const DEFAULT_SAMPLE_ITEMS = 200
/** A sampled item asks for k + 1 rows and p_k is at most 200. */
export const MAX_RECALL_K = 199

export type Command =
  | { command: 'seed'; container: string; rows: number; seed: number }
  | { command: 'latency'; container: string; sizes: number[]; seed: number; k: number }
  | { command: 'recall'; container: string; db: string; pins: string[]; sampleItems: number; k: number }
  | {
      command: 'legs'
      container: string
      db: string
      cases: string
      gold: string
      pins: string[]
      calibrationBefore: string
      k: number
    }

const COMMANDS = ['seed', 'latency', 'recall', 'legs'] as const
const FLAGS: Record<(typeof COMMANDS)[number], readonly string[]> = {
  seed: ['container', 'rows', 'seed'],
  latency: ['container', 'sizes', 'seed', 'k'],
  recall: ['container', 'db', 'pins', 'sample-items', 'k'],
  legs: ['container', 'db', 'cases', 'gold', 'pins', 'calibration-before', 'k'],
}
/** Flags that take one or more values: every argument up to the next flag. */
const LIST_FLAGS = new Set(['pins'])
const DB_NAME = /^[A-Za-z0-9_][\w.-]*$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

function positiveInteger(name: string, value: string | undefined): number {
  const n = Number(value)
  if (value === undefined || !Number.isInteger(n) || n < 1) throw new Error(`${name} needs a positive integer`)
  return n
}

function nonNegativeInteger(name: string, value: string | undefined): number {
  const n = Number(value)
  if (value === undefined || !Number.isInteger(n) || n < 0) throw new Error(`${name} needs a non-negative integer`)
  return n
}

function parseFlags(command: (typeof COMMANDS)[number], rest: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>()
  let i = 0
  while (i < rest.length) {
    const flag = rest[i]
    if (!flag.startsWith('--') || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) {
      throw new Error(`expected --flag value at ${flag}`)
    }
    const name = flag.slice(2)
    if (!FLAGS[command].includes(name)) throw new Error(`${command} does not take --${name}`)
    const values: string[] = []
    i += 1
    do {
      values.push(rest[i])
      i += 1
    } while (LIST_FLAGS.has(name) && i < rest.length && !rest[i].startsWith('--'))
    if (flags.has(name) && !LIST_FLAGS.has(name)) throw new Error(`--${name} is given twice`)
    flags.set(name, [...(flags.get(name) ?? []), ...values])
  }
  return flags
}

function required(flags: Map<string, string[]>, name: string): string {
  const value = flags.get(name)?.[0]
  if (value === undefined || value === '') throw new Error(`--${name} is required`)
  return value
}

function kFlag(flags: Map<string, string[]>, max: number): number {
  const k = flags.has('k') ? positiveInteger('--k', flags.get('k')?.[0]) : DEFAULT_K
  if (k > max) throw new Error(`--k is at most ${max}`)
  return k
}

function isCommandName(name: string | undefined): name is (typeof COMMANDS)[number] {
  return (COMMANDS as readonly (string | undefined)[]).includes(name)
}

export function parseCommand(argv: readonly string[]): Command {
  const [name, ...rest] = argv
  if (!isCommandName(name)) throw new Error(`the command is ${COMMANDS.join(', ')}`)
  const command = name
  const flags = parseFlags(command, rest)
  const container = flags.get('container')?.[0]
  if (!container || !CONTAINER_NAME.test(container)) throw new Error('--container needs a docker container name')

  if (command === 'recall' || command === 'legs') {
    const db = required(flags, 'db')
    if (!DB_NAME.test(db)) throw new Error('--db needs a database name')
    const pins = flags.get('pins') ?? []
    if (pins.length === 0) throw new Error('--pins needs at least one file')
    if (command === 'recall') {
      const sampleItems = flags.has('sample-items')
        ? nonNegativeInteger('--sample-items', flags.get('sample-items')?.[0])
        : DEFAULT_SAMPLE_ITEMS
      return { command, container, db, pins, sampleItems, k: kFlag(flags, MAX_RECALL_K) }
    }
    const calibrationBefore = required(flags, 'calibration-before')
    if (!ISO_TIME.test(calibrationBefore)) throw new Error('--calibration-before needs an ISO-8601 time with an offset')
    return {
      command,
      container,
      db,
      cases: required(flags, 'cases'),
      gold: required(flags, 'gold'),
      pins,
      calibrationBefore,
      k: kFlag(flags, 200),
    }
  }

  const seed = flags.has('seed') ? Number(flags.get('seed')?.[0]) : DEFAULT_SEED
  pgSeed(seed)
  if (command === 'seed') return { command, container, rows: positiveInteger('--rows', flags.get('rows')?.[0]), seed }

  const sizes = flags.has('sizes')
    ? (flags.get('sizes')?.[0] as string).split(',').map((s) => positiveInteger('--sizes', s))
    : [...THRESHOLD_GRID]
  for (const size of sizes) {
    if (!(THRESHOLD_GRID as readonly number[]).includes(size)) {
      throw new Error(`--sizes takes grid sizes only (${THRESHOLD_GRID.join(', ')}), got ${size}`)
    }
  }
  return { command, container, sizes: [...new Set(sizes)].sort((a, b) => a - b), seed, k: kFlag(flags, 200) }
}
