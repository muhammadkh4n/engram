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
import {
  MIN_BUCKET_PAIRS,
  bucketOf,
  embeddingReplies,
  pairRecall,
  parseRecallOutput,
  pinnedEmbedding,
  pinnedHydeEmbedding,
  recallSql,
  summarizeRecall,
  type RecallPair,
} from '../src/access-path/recall-lib.js'
import {
  assertOtherLegsUnchanged,
  caseQueries,
  entityRule,
  evaluateQuery,
  goldQueries,
  legsHolding,
  legsSql,
  matchesTarget,
  parseLegsOutput,
  queryTerms,
  type CandidateRow,
  type ItemText,
  type LegQuery,
} from '../src/access-path/legs-lib.js'
import type { DecisionCase } from '../src/decisions/cases.js'
import type { GoldEntry } from '../src/eval/gold.js'

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
    expect(() => parseCommand(['probe', '--container', 'tst-ap'])).toThrow('the command is seed, latency, recall, legs')
    expect(() => parseCommand(['seed', '--container', 'tst-ap', '--rows', '10', '--sizes', '1000'])).toThrow(
      'does not take --sizes',
    )
    expect(() => parseCommand(['seed', '--container', 'tst ap; rm', '--rows', '10'])).toThrow('--container')
    expect(() => parseCommand(['seed', '--container', 'tst-ap'])).toThrow('--rows')
    expect(() => parseCommand(['latency', '--container', 'tst-ap', '--sizes', '3000'])).toThrow('grid sizes only')
    expect(() => parseCommand(['latency', '--container', 'tst-ap', '--k', '201'])).toThrow('at most 200')
    expect(() => parseCommand(['latency', '--container'])).toThrow('--flag value')
    expect(() => parseCommand(['latency', '--container', 'tst-ap', '--k', '5', '--k', '6'])).toThrow('given twice')
  })

  it('parses recall and legs, with every file after --pins', () => {
    expect(parseCommand(['recall', '--container', 'tst-copy', '--db', 'engram', '--pins', 'a.json', 'b.json'])).toEqual({
      command: 'recall',
      container: 'tst-copy',
      db: 'engram',
      pins: ['a.json', 'b.json'],
      sampleItems: 200,
      k: 50,
    })
    expect(
      parseCommand([
        'legs', '--container', 'tst-copy', '--db', 'engram', '--cases', 'cases.jsonl', '--gold', 'gold.jsonl',
        '--pins', 'a.json', '--calibration-before', '2026-09-01T00:00:00Z', '--pins', 'b.json',
      ]),
    ).toEqual({
      command: 'legs',
      container: 'tst-copy',
      db: 'engram',
      cases: 'cases.jsonl',
      gold: 'gold.jsonl',
      pins: ['a.json', 'b.json'],
      calibrationBefore: '2026-09-01T00:00:00Z',
      k: 50,
    })
  })

  it('refuses recall and legs without their inputs or with a k a sampled item cannot get', () => {
    const recall = ['recall', '--container', 'tst-copy', '--db', 'engram', '--pins', 'a.json']
    expect(() => parseCommand([...recall, '--k', '200'])).toThrow('at most 199')
    expect(() => parseCommand(['recall', '--container', 'tst-copy', '--pins', 'a.json'])).toThrow('--db is required')
    expect(() => parseCommand(['recall', '--container', 'tst-copy', '--db', 'engram'])).toThrow('--pins needs at least one file')
    expect(() => parseCommand(['recall', '--container', 'tst-copy', '--db', 'x;y', '--pins', 'a.json'])).toThrow(
      '--db needs a database name',
    )
    expect(() => parseCommand([...recall, '--cases', 'c.jsonl'])).toThrow('does not take --cases')
    const legs = ['legs', '--container', 'tst-copy', '--db', 'engram', '--cases', 'c', '--gold', 'g', '--pins', 'p']
    expect(() => parseCommand(legs)).toThrow('--calibration-before is required')
    expect(() => parseCommand([...legs, '--calibration-before', '2026-09-01'])).toThrow('ISO-8601')
  })
})

function axis(i: number): number[] {
  return Array.from({ length: DIMS }, (_, d) => (d === i ? 1 : 0))
}

function pair(overrides: Partial<RecallPair>): RecallPair {
  return { filter: 'default', query: 1, itemId: null, filtered: 0, exactIds: [], hnswIds: [], hnswPath: 'hnsw', ...overrides }
}

describe('recall query vectors from pins', () => {
  const table = {
    embedQuery: { '["tst heron"]': axis(0) },
    embed: { '["tst heron"]': axis(0), '["tst hyde doc"]': axis(2), '["tst osprey"]': axis(1) },
    generateHypotheticalDoc: { '["tst heron"]': 'tst hyde doc' },
  }

  it('reads every embedding reply once, and refuses a reply of the wrong width', () => {
    expect(embeddingReplies([table, { embed: { '["tst again"]': axis(1) } }])).toEqual([axis(0), axis(2), axis(1)])
    expect(() => embeddingReplies([{ embed: { '["tst short"]': [1, 0] } }])).toThrow('not a 1536-dimension vector')
  })

  it('finds a text\'s recorded embedding and its HyDE document\'s, or null', () => {
    expect(pinnedEmbedding([table], 'tst osprey')).toEqual(axis(1))
    expect(pinnedEmbedding([table], 'tst unknown')).toBeNull()
    expect(pinnedHydeEmbedding([table], 'tst heron')).toEqual(axis(2))
    expect(pinnedHydeEmbedding([table], 'tst osprey')).toBeNull()
  })
})

describe('recall against exact', () => {
  it('scores overlap over min(k, exact rows) when the exact list is shorter than k', () => {
    const p = pair({ exactIds: ['a', 'b', 'c'], hnswIds: ['a', 'c', 'x'] })
    expect(pairRecall(p, 50)).toEqual({ recall: 2 / 3, fallback: false })
  })

  it('drops a sampled item from both lists and keeps k rows of each', () => {
    const p = pair({ itemId: 's', exactIds: ['s', 'a', 'b', 'c'], hnswIds: ['a', 's', 'c', 'b'] })
    expect(pairRecall(p, 2)).toEqual({ recall: 0.5, fallback: false })
  })

  it('scores a fallback as 1.0 and flags it', () => {
    expect(pairRecall(pair({ exactIds: ['a'], hnswIds: ['b'], hnswPath: 'exact_fallback' }), 50)).toEqual({ recall: 1, fallback: true })
  })

  it('buckets filtered sizes above T into (T, 2T], (2T, 4T] and (4T, inf)', () => {
    expect(bucketOf(5000, 5000)).toBeNull()
    expect(bucketOf(5001, 5000)).toBe('(T, 2T]')
    expect(bucketOf(10000, 5000)).toBe('(T, 2T]')
    expect(bucketOf(10001, 5000)).toBe('(2T, 4T]')
    expect(bucketOf(20000, 5000)).toBe('(2T, 4T]')
    expect(bucketOf(20001, 5000)).toBe('(4T, inf)')
  })

  it('leaves a bucket under 100 pairs unresolved and judges one at 100 on its mean', () => {
    const exactIds = ['a', 'b', 'c', 'd']
    const full = (query: number) => pair({ query, filtered: 15000, exactIds, hnswIds: exactIds })
    const pairs = [
      ...Array.from({ length: MIN_BUCKET_PAIRS - 1 }, (_, i) => full(i + 1)),
      pair({ query: 500, filtered: 7000, exactIds, hnswIds: ['a', 'b', 'c', 'x'] }),
      ...Array.from({ length: MIN_BUCKET_PAIRS }, (_, i) =>
        pair({ query: 1000 + i, filtered: 7000, exactIds, hnswIds: i < 10 ? ['a', 'x', 'y', 'z'] : exactIds }),
      ),
      pair({ query: 2000, filtered: 30000, exactIds, hnswIds: [], hnswPath: 'exact_fallback' }),
      pair({ query: 3000, filtered: 100, exactIds, hnswIds: [] }),
    ]
    const summary = summarizeRecall(pairs, 5000, 4)
    expect(summary.atOrBelowThreshold).toBe(1)
    const [low, mid, high] = summary.buckets
    expect(low).toMatchObject({ bucket: '(T, 2T]', n: 101, fallbacks: 0, min: 0.25, verdict: 'fail' })
    expect(low.mean).toBeCloseTo((90 + 0.75 + 10 * 0.25) / 101, 10)
    expect(low.low).toBe(0.25)
    expect(mid).toMatchObject({ bucket: '(2T, 4T]', n: 99, mean: 1, verdict: 'unresolved' })
    expect(high).toMatchObject({ bucket: '(4T, inf)', n: 1, fallbacks: 1, mean: 1, verdict: 'unresolved' })
    expect(summary.worst).toEqual({ filter: 'default', query: 1000, itemId: null, filtered: 7000, recall: 0.25 })
  })

  it('passes a bucket of 100 pairs whose mean reaches the bar', () => {
    const exactIds = Array.from({ length: 50 }, (_, i) => `id-${i}`)
    const pairs = Array.from({ length: MIN_BUCKET_PAIRS }, (_, i) =>
      pair({ query: i + 1, filtered: 6000, exactIds, hnswIds: i === 0 ? [...exactIds.slice(0, 49), 'x'] : exactIds }),
    )
    expect(summarizeRecall(pairs, 5000, 50).buckets[0]).toMatchObject({ n: 100, verdict: 'pass', min: 0.98 })
  })

  it('writes one filter\'s run with forced exact and hnsw calls, k + 1 rows for sampled items', () => {
    const sql = recallSql('exclude_largest_session', [axis(0)], 200, 50)
    expect(sql).toContain("INSERT INTO ap_queries VALUES (1, NULL, '[1,0,")
    expect(sql).toContain('ORDER BY md5(id::text), id LIMIT 200')
    expect(sql).toContain('CASE WHEN item_id IS NULL THEN 50 ELSE 51 END')
    expect(sql).toContain("p_exclude_session => f.value, p_k => q.k, p_force_path => 'exact'")
    expect(sql).toContain("p_exclude_session => f.value, p_k => q.k, p_force_path => 'hnsw'")
    expect(sql).toContain('engram_item_candidates_explain(p_embedding => q.v, p_exclude_session => f.value, p_k => q.k')
    expect(recallSql('utterances', [], 10, 50)).toContain("p_classes => ARRAY['utterance'],")
    expect(recallSql('as_of_p25', [], 10, 50)).toContain('percentile_disc(0.25)')
  })

  it('parses a run and refuses a malformed pair', () => {
    const out = [
      '{"kind" : "filter", "value" : "tst-session"}',
      '{"kind" : "pair", "n" : 1, "item_id" : null, "filtered" : 6000, "exact" : ["a"], "hnsw" : ["a"], "hnsw_path" : "hnsw"}',
    ].join('\n')
    expect(parseRecallOutput('default', out)).toEqual({
      filter: 'default',
      value: 'tst-session',
      pairs: [pair({ filtered: 6000, exactIds: ['a'], hnswIds: ['a'] })],
    })
    expect(() => parseRecallOutput('default', out.replace('"hnsw"}', '"seq"}'))).toThrow('unexpected output line')
    expect(() => parseRecallOutput('default', '')).toThrow('no filter line')
  })
})

function decisionCase(overrides: Partial<DecisionCase>): DecisionCase {
  return {
    id: 'tst-case-alpha', source: { kind: 'incident', ref: 'tst' }, status: 'reviewed', decided_at: '2026-08-01T00:00:00Z',
    agent: 'main', channel: 'prompt', session_id: 'tst-session', transcript: null, cwd: null, project_id: 'tst-proj',
    workspace_id: null, at_root: false, plan_dirs: [], query_text: 'Fix TST-42 in packages/tst/src/a.ts now.',
    prior_prompts: [], decision_kind: null, tool_text: null, expect_contradiction: false,
    needed: [{ key: 'tst-need', kind: 'fact', expected_lane: 'query', phrases: [['heron rule']], register_ids: ['R-TSTQ-907'], item_ids: [], legacy_ids: [] }],
    harmful: [{ key: 'tst-harm', phrases: [['old heron rule']], current_phrases: [['heron rule changed']], item_ids: [], legacy_ids: [] }],
    audit: null, note: '', ...overrides,
  }
}

function goldEntry(overrides: Partial<GoldEntry>): GoldEntry {
  return {
    id: 'tst-gold-alpha', class: 'identifier', query: 'where is TST-42', gold_ids: ['legacy-1'], gold_phrases: [],
    stale_ids: [], stale_phrases: [['osprey stale']], current_phrases: [], note: '', ...overrides,
  }
}

function itemText(id: string, content: string, extra: Partial<ItemText> = {}): ItemText {
  return { id, legacyId: null, registerRef: null, content, context: null, ...extra }
}

function row(leg: CandidateRow['leg'], rank: number, itemId: string, withEntities = true): CandidateRow {
  return { n: 1, withEntities, leg, rank, itemId }
}

describe('the leg queries', () => {
  const pins = [{ embedQuery: { '["Fix TST-42 in packages/tst/src/a.ts now."]': axis(0), '["where is TST-42"]': axis(1) } }]
  const projects = [{ id: 'tst-proj', kind: 'project' }]

  it('splits tokens into lexical terms, keeping inner identifier punctuation', () => {
    expect(queryTerms('Fix TST-42, in "packages/tst/src/a.ts"; v1.2_b now. now')).toEqual([
      'fix', 'tst-42', 'in', 'packages/tst/src/a.ts', 'v1.2_b', 'now',
    ])
  })

  it('builds case queries as of the decision, without its session, and skips a case without a query', () => {
    const cases = [
      decisionCase({}),
      decisionCase({ id: 'tst-case-beta', decided_at: '2026-09-02T00:00:00Z', query_text: 'tst unpinned words' }),
      decisionCase({ id: 'tst-case-gamma', channel: 'session_start', query_text: null }),
      decisionCase({ id: 'tst-case-delta', status: 'dropped' }),
    ]
    const { queries, skipped } = caseQueries(cases, '2026-09-01T00:00:00Z', projects, pins)
    expect(skipped).toEqual([{ id: 'tst-case-gamma', reason: 'no_query' }])
    expect(queries.map((q) => [q.id, q.split, q.vector === null])).toEqual([
      ['tst-case-alpha', 'calibration', false],
      ['tst-case-beta', 'check', true],
    ])
    expect(queries[0]).toMatchObject({
      entities: ['TST-42', 'packages/tst/src/a.ts'], classes: null, projectId: 'tst-proj',
      asOf: '2026-08-01T00:00:00Z', excludeSession: 'tst-session',
    })
    expect(queries[0].targets.map((t) => [t.role, t.key])).toEqual([['needed', 'tst-need'], ['harmful', 'tst-harm']])
  })

  it('builds gold queries in the calibration split, reading legacy rows', () => {
    const [q] = goldQueries([goldEntry({})], projects, pins)
    expect(q).toMatchObject({ split: 'calibration', vector: axis(1), entities: ['TST-42'] })
    expect(q.classes).toContain('legacy')
    expect(q.targets.map((t) => t.role)).toEqual(['gold', 'stale'])
  })

  it('quotes each request as one JSON literal and runs it with and without entities', () => {
    const q = goldQueries([goldEntry({ query: "it's TST-42" })], projects, [{ embedQuery: { '["it\'s TST-42"]': axis(1) } }])[0]
    const sql = legsSql([q], 50)
    expect(sql).toContain("\"query\":\"it''s TST-42\"")
    expect(sql).toContain('(1, true, ')
    expect(sql).toContain('(1, false, ')
    expect(sql).toContain('p_entities => CASE WHEN q.with_entities THEN')
    expect(() => legsSql([{ ...q, vector: null }], 50)).toThrow('no query vector')
  })

  it('parses rows and items, and names only the line of a malformed one', () => {
    const out = [
      '{"kind" : "row", "n" : 1, "with_entities" : true, "leg" : "entity", "rank" : 1, "item_id" : "a"}',
      '{"kind" : "item", "id" : "a", "legacy_id" : null, "register_ref" : null, "content" : "secret words", "context" : null}',
    ]
    const parsed = parseLegsOutput(out.join('\n'))
    expect(parsed.rows).toEqual([row('entity', 1, 'a')])
    expect(parsed.items.get('a')?.content).toBe('secret words')
    expect(() => parseLegsOutput(out[1].replace('"content"', '"body"'))).toThrow(/^legs output line 1 has an unexpected shape$/)
  })
})

describe('legs holding targets and the entity rule', () => {
  function query(overrides: Partial<LegQuery>): LegQuery {
    return {
      id: 'tst-q', source: 'case', split: 'calibration', text: 't', vector: axis(0), hydeVector: null, terms: [], entities: ['TST-42'],
      classes: null, projectId: null, asOf: null, excludeSession: null, targets: [], ...overrides,
    }
  }
  const needed = { key: 'need', role: 'needed' as const, itemIds: [], legacyIds: [], registerIds: [], phrases: [['heron rule']], currentPhrases: [] }
  const harmful = { key: 'harm', role: 'harmful' as const, itemIds: [], legacyIds: [], registerIds: [], phrases: [['old osprey']], currentPhrases: [] }

  it('lists every leg holding an item', () => {
    const rows = [row('vector', 1, 'a'), row('bm25', 3, 'a'), row('entity', 1, 'b')]
    expect(legsHolding(rows, 'a')).toEqual(['vector', 'bm25'])
    expect(legsHolding(rows, 'c')).toEqual([])
  })

  it('matches by id, legacy id, register ref or phrase, and lets a current phrase clear harm', () => {
    expect(matchesTarget({ ...needed, phrases: [], registerIds: ['R-TSTQ-907'] }, itemText('a', 'x', { registerRef: 'R-TSTQ-907' }))).toBe(true)
    expect(matchesTarget({ ...needed, phrases: [], legacyIds: ['l-1'] }, itemText('a', 'x', { legacyId: 'l-1' }))).toBe(true)
    expect(matchesTarget(needed, itemText('a', 'x', { context: 'The HERON   rule' }))).toBe(true)
    const cleared = { ...harmful, currentPhrases: [['osprey changed']] }
    expect(matchesTarget(cleared, itemText('a', 'old osprey; osprey changed'))).toBe(false)
    expect(matchesTarget({ ...cleared, role: 'stale', itemIds: ['a'] }, itemText('a', 'old osprey; osprey changed'))).toBe(true)
  })

  it('keeps the leg when it alone holds a needed target and no harmful item', () => {
    const items = new Map([['a', itemText('a', 'the heron rule')], ['b', itemText('b', 'old osprey note')]])
    const rows = [row('entity', 1, 'a'), row('vector', 1, 'b'), row('entity', 2, 'b')]
    const result = evaluateQuery(query({ targets: [needed, harmful] }), rows, items)
    expect(result.targets).toEqual([
      { key: 'need', role: 'needed', legs: ['entity'], itemIds: ['a'], entityOnlyItemIds: ['a'] },
      { key: 'harm', role: 'harmful', legs: ['vector', 'entity'], itemIds: ['b'], entityOnlyItemIds: [] },
    ])
    const verdict = entityRule([result], [])
    expect(verdict.keep).toBe(true)
    expect(verdict.calibration.helped).toEqual([{ query: 'tst-q', key: 'need' }])
  })

  it('drops the leg when it alone brings a harmful item, or helps only in the check split', () => {
    const items = new Map([['a', itemText('a', 'the heron rule')], ['b', itemText('b', 'old osprey note')]])
    const harms = evaluateQuery(query({ targets: [needed, harmful] }), [row('entity', 1, 'a'), row('entity', 2, 'b')], items)
    const verdict = entityRule([harms], [{ id: 'tst-skip', reason: 'no_query' }])
    expect(verdict.keep).toBe(false)
    expect(verdict.calibration.harmed).toEqual([{ query: 'tst-q', key: 'harm', itemId: 'b' }])
    expect(verdict.noQuery).toBe(1)

    const lateOnly = evaluateQuery(query({ split: 'check', targets: [needed] }), [row('entity', 1, 'a')], items)
    const shared = evaluateQuery(query({ id: 'tst-q2', targets: [needed] }), [row('entity', 1, 'a'), row('subject', 1, 'a')], items)
    const second = entityRule([lateOnly, shared], [])
    expect(second.keep).toBe(false)
    expect(second.check.helped).toHaveLength(1)
    expect(second.calibration.helped).toEqual([])
  })

  it('refuses a call without entities that changed another leg', () => {
    const withRows = [row('vector', 1, 'a'), row('entity', 1, 'b')]
    expect(() => assertOtherLegsUnchanged('tst-q', withRows, [row('vector', 1, 'a', false)])).not.toThrow()
    expect(() => assertOtherLegsUnchanged('tst-q', withRows, [row('vector', 1, 'c', false)])).toThrow('changed the other legs')
  })
})
