import { describe, expect, it } from 'vitest'
import {
  BUDGET_MS,
  DIMS,
  QUERY_VECTORS,
  SEED_BASE_TIME,
  THRESHOLD_GRID,
  TIMED_CALLS,
  WORDS,
  applyThresholdRule,
  asOfForSize,
  callSchedule,
  formatTable,
  latencySql,
  parseCommand,
  parseLatencyOutput,
  percentile,
  pgSeed,
  queryVectors,
  seedSql,
  summarize,
} from '../src/access-path/measure-lib.js'

function constant(ms: number): number[] {
  return Array(QUERY_VECTORS * TIMED_CALLS).fill(ms)
}

/** 60 timings: 57 fast ones and 3 slow ones, so p95 (the 57th value) is fast while the max is slow. */
function withTail(fastMs: number, slowMs: number): number[] {
  return [...Array(57).fill(fastMs), ...Array(3).fill(slowMs)]
}

function outputLine(label: string, query: number, filtered: number, ms: number): string {
  return `${label}|${query}|${filtered}|exact|${ms}|1`
}

describe('percentile', () => {
  it('returns the nearest-rank value', () => {
    const values = Array.from({ length: 60 }, (_, i) => 60 - i)
    expect(percentile(values, 95)).toBe(57)
    expect(percentile(values, 50)).toBe(30)
    expect(percentile(values, 100)).toBe(60)
    expect(percentile([7], 95)).toBe(7)
  })

  it('refuses no values and a percentile outside (0, 100]', () => {
    expect(() => percentile([], 95)).toThrow('no values')
    expect(() => percentile([1], 0)).toThrow('(0, 100]')
    expect(() => percentile([1], 101)).toThrow('(0, 100]')
  })

  it('summarizes calls, p50, p95 and max without reordering its input', () => {
    const timings = withTail(10, 900)
    const copy = [...timings]
    expect(summarize(timings)).toEqual({ calls: 60, p50: 10, p95: 10, max: 900 })
    expect(timings).toEqual(copy)
  })
})

describe('the threshold rule', () => {
  it('picks the largest grid size whose p95 is within the budget', () => {
    const result = applyThresholdRule([
      { size: 20000, timingsMs: constant(260) },
      { size: 1000, timingsMs: constant(8) },
      { size: 10000, timingsMs: constant(BUDGET_MS) },
      { size: 5000, timingsMs: constant(40) },
    ])
    expect(result.exactMaxRows).toBe(10000)
    expect(result.anyWithinBudget).toBe(true)
    expect(result.rows.map((r) => [r.size, r.withinBudget])).toEqual([
      [1000, true],
      [5000, true],
      [10000, true],
      [20000, false],
    ])
  })

  it('decides on p95, so a few slow calls do not move the value', () => {
    expect(applyThresholdRule([{ size: 40000, timingsMs: withTail(200, 1000) }]).exactMaxRows).toBe(40000)
    expect(applyThresholdRule([{ size: 40000, timingsMs: withTail(200, 1000) }, { size: 80000, timingsMs: withTail(240, 251) }]).exactMaxRows).toBe(80000)
  })

  it('falls back to the smallest size and says so when every size is over the budget', () => {
    const result = applyThresholdRule([
      { size: 2000, timingsMs: constant(600) },
      { size: 1000, timingsMs: constant(300) },
    ])
    expect(result.exactMaxRows).toBe(1000)
    expect(result.anyWithinBudget).toBe(false)
  })

  it('formats one table row per size', () => {
    const table = formatTable(applyThresholdRule([{ size: 1000, timingsMs: withTail(8, 12) }]))
    expect(table.split('\n')).toEqual([
      '| filtered rows | timed calls | p50 ms | p95 ms | max ms | p95 <= 250 ms |',
      '|---:|---:|---:|---:|---:|:---:|',
      '| 1000 | 60 | 8.0 | 8.0 | 12.0 | yes |',
    ])
  })
})

describe('query vectors', () => {
  it('are unit vectors of the embedding width, the same for the same seed', () => {
    const vectors = queryVectors(7)
    expect(vectors).toHaveLength(QUERY_VECTORS)
    for (const v of vectors) {
      expect(v).toHaveLength(DIMS)
      expect(Math.hypot(...v)).toBeCloseTo(1, 9)
    }
    expect(queryVectors(7)).toEqual(vectors)
    expect(queryVectors(8)[0]).not.toEqual(vectors[0])
  })
})

describe('the seed', () => {
  it('maps an integer seed into setseed range and refuses others', () => {
    expect(pgSeed(0)).toBe(0)
    expect(pgSeed(2 ** 30)).toBe(0.5)
    expect(() => pgSeed(-1)).toThrow('seed')
    expect(() => pgSeed(1.5)).toThrow('seed')
    expect(() => pgSeed(2 ** 31)).toThrow('seed')
  })

  it('refuses a non-empty table, seeds the generator and inserts in batches', () => {
    const sql = seedSql(12000, 42)
    expect(sql.indexOf('memory_items is not empty')).toBeLessThan(sql.indexOf('setseed'))
    expect(sql).toContain(`SELECT setseed(${42 / 2 ** 31});`)
    expect(sql.match(/INSERT INTO public\.memory_items/g)).toHaveLength(3)
    expect(sql).toContain('generate_series(1, 5000)')
    expect(sql).toContain('generate_series(10001, 12000)')
    expect(sql).toContain("'document_section', 'note', 'artifact', 1")
    expect(sql).toContain(`timestamptz '${SEED_BASE_TIME}' + (g - 1) * interval '1 minute'`)
    expect(sql).toContain('200 + floor(random() * 1801)::int')
    expect(sql).toContain(`floor(random() * ${WORDS.length})`)
    expect(sql).toContain(`random_normal())::real[]::public.vector`)
    expect(sql).toContain(`generate_series(1, ${DIMS})`)
    expect(sql.trimEnd().endsWith('SELECT count(*) FROM public.memory_items;')).toBe(true)
  })
})

describe('the latency run', () => {
  it('bounds as-of so exactly `size` seeded rows are visible', () => {
    expect(asOfForSize(1)).toBe(SEED_BASE_TIME)
    expect(asOfForSize(1000)).toBe('2026-01-01T16:39:00.000Z')
    expect(() => asOfForSize(0)).toThrow('positive integer')
  })

  it('schedules one warm-up call, then every query vector in each timed round', () => {
    const schedule = callSchedule()
    expect(schedule).toHaveLength(1 + QUERY_VECTORS * TIMED_CALLS)
    expect(schedule[0]).toEqual({ label: 'warmup', query: 1 })
    expect(schedule.slice(1, QUERY_VECTORS + 1).map((c) => c.query)).toEqual(
      Array.from({ length: QUERY_VECTORS }, (_, i) => i + 1),
    )
    expect(schedule.slice(1).every((c) => c.label === 'timed')).toBe(true)
  })

  it('times the forced exact branch under EXPLAIN ANALYZE with parallel workers off', () => {
    const sql = latencySql(5000, queryVectors(1), 50)
    expect(sql.split('\n').slice(0, 2)).toEqual(['\\set QUIET on', 'SET max_parallel_workers_per_gather = 0;'])
    expect(sql.match(/engram_item_candidates_explain/g)).toHaveLength(1 + QUERY_VECTORS * TIMED_CALLS)
    expect(sql).toContain(`p_as_of => timestamptz '${asOfForSize(5000)}', p_k => 50, p_force_path => 'exact', p_analyze => true`)
    expect(sql).toContain("(e.plan -> 0 ->> 'Execution Time')")
  })

  it('parses every call and refuses a wrong filtered size, path or call count', () => {
    const lines = callSchedule().map((c, i) => outputLine(c.label, c.query, 2000, 10 + i))
    const parsed = parseLatencyOutput(`${lines.join('\n')}\n`, 2000)
    expect(parsed).toHaveLength(61)
    expect(parsed[0]).toEqual({ label: 'warmup', query: 1, executionMs: 10 })
    expect(parsed[60]).toEqual({ label: 'timed', query: 20, executionMs: 70 })

    expect(() => parseLatencyOutput(lines.join('\n'), 1000)).toThrow('filtered 2000 rows')
    expect(() => parseLatencyOutput(lines.slice(1).join('\n'), 2000)).toThrow('60 calls, expected 61')
    const fallback = [...lines.slice(0, 60), 'timed|20|2000|hnsw,exact_fallback|80|2']
    expect(() => parseLatencyOutput(fallback.join('\n'), 2000)).toThrow('2 statement(s) on hnsw,exact_fallback')
    expect(() => parseLatencyOutput(`${lines.slice(0, 60).join('\n')}\ntimed|20|2000|exact||1`, 2000)).toThrow(
      'no execution time',
    )
  })
})

describe('parseCommand', () => {
  it('parses seed and latency with their defaults', () => {
    expect(parseCommand(['seed', '--container', 'tst-ap', '--rows', '80000'])).toEqual({
      command: 'seed',
      container: 'tst-ap',
      rows: 80000,
      seed: 1729,
    })
    expect(parseCommand(['latency', '--container', 'tst-ap'])).toEqual({
      command: 'latency',
      container: 'tst-ap',
      sizes: [...THRESHOLD_GRID],
      seed: 1729,
      k: 50,
    })
    expect(parseCommand(['latency', '--container', 'tst-ap', '--sizes', '5000,1000,5000', '--k', '20'])).toMatchObject({
      sizes: [1000, 5000],
      k: 20,
    })
  })

  it('refuses unknown commands, flags, container names, off-grid sizes and bad numbers', () => {
    expect(() => parseCommand(['recall', '--container', 'tst-ap'])).toThrow('seed or latency')
    expect(() => parseCommand(['seed', '--container', 'tst-ap', '--rows', '10', '--sizes', '1000'])).toThrow(
      'does not take --sizes',
    )
    expect(() => parseCommand(['seed', '--container', 'tst ap; rm', '--rows', '10'])).toThrow('--container')
    expect(() => parseCommand(['seed', '--container', 'tst-ap'])).toThrow('--rows')
    expect(() => parseCommand(['latency', '--container', 'tst-ap', '--sizes', '3000'])).toThrow('grid sizes only')
    expect(() => parseCommand(['latency', '--container', 'tst-ap', '--k', '201'])).toThrow('at most 200')
    expect(() => parseCommand(['latency', '--container'])).toThrow('--flag value')
  })
})
