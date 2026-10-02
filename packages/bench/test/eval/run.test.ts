import { describe, expect, it } from 'vitest'
import { DegradedRecallError } from '../../src/refuse-degraded.js'
import type { EvalItem, EvalRecall } from '../../src/eval/eval-stack.js'
import type { GoldEntry } from '../../src/eval/gold.js'
import type { PinStats } from '../../src/eval/pins.js'
import {
  DEFAULT_RUNS,
  SECRET_NAME,
  buildRunMeta,
  envModelIds,
  formatRunSummary,
  goldRecallArgs,
  parseRunArgs,
  runGold,
  type RunArgs,
} from '../../src/eval/run.js'
import { createGuardStats } from '../../src/eval/write-guards.js'

const NOW = new Date('2026-10-02T09:00:00Z')

function gold(id: string, overrides: Partial<GoldEntry> = {}): GoldEntry {
  return {
    id,
    class: 'recall',
    query: `synthetic query ${id}`,
    gold_ids: [`${id}-gold`],
    gold_phrases: [],
    stale_ids: [],
    stale_phrases: [],
    current_phrases: [],
    note: '',
    ...overrides,
  }
}

/** A recall whose Recalled section lists `ids` in order, one synthetic line each. */
function recall(query: string, ids: string[], extra: Partial<EvalRecall> = {}): EvalRecall {
  let formatted = '## Engram — Recalled Conversation Memory\n\n### Recalled\n'
  const items: EvalItem[] = []
  for (const id of ids) {
    const start = formatted.length
    const line = `- [episode · 2026-09-01] synthetic note ${id}`
    formatted += `${line}\n`
    items.push({ section: 'recalled', id, line, start, end: start + line.length })
  }
  return {
    query,
    recallOpts: { reconsolidate: false, now: NOW },
    formatted,
    items,
    estimatedTokens: Math.ceil(formatted.length / 4),
    degraded: null,
    timings: null,
    ...extra,
  }
}

const REQUIRED = [
  '--gold', 'gold.jsonl', '--dist', '/opt/engram', '--env', '/etc/engram.env', '--pins', 'pins.json',
  '--calibration-query', 'where is the deploy script', '--label', 'control', '--out', './eval',
]

describe('parseRunArgs', () => {
  it('reads --env as a file path and defaults to three fill runs', () => {
    const args = parseRunArgs(REQUIRED)
    expect(args).toEqual({
      gold: 'gold.jsonl',
      dist: '/opt/engram',
      envFile: '/etc/engram.env',
      pins: 'pins.json',
      pinsMode: 'fill',
      runs: DEFAULT_RUNS,
      calibrationQuery: 'where is the deploy script',
      label: 'control',
      out: './eval',
    })
    expect(DEFAULT_RUNS).toBe(3)
  })

  it('takes --runs, --pins-mode strict and --now', () => {
    const args = parseRunArgs([...REQUIRED, '--runs', '5', '--pins-mode', 'strict', '--now', '2026-10-02T09:00:00Z'])
    expect(args.runs).toBe(5)
    expect(args.pinsMode).toBe('strict')
    expect(args.referenceDate).toEqual(NOW)
  })

  it('refuses one run, a missing flag, an unknown flag and an unsafe label', () => {
    expect(() => parseRunArgs([...REQUIRED, '--runs', '1'])).toThrow(/at least 2/)
    expect(() => parseRunArgs(REQUIRED.slice(2))).toThrow('--gold is required')
    expect(() => parseRunArgs([...REQUIRED, '--max-results', '5'])).toThrow('unknown flag --max-results')
    const unsafe = [...REQUIRED]
    unsafe[unsafe.indexOf('control')] = '../control'
    expect(() => parseRunArgs(unsafe)).toThrow(/--label/)
  })
})

describe('goldRecallArgs', () => {
  it('passes the gold project as memory_recall project_id, and nothing else', () => {
    expect(goldRecallArgs(gold('a', { project_id: 'engram' }))).toEqual({ project_id: 'engram' })
    expect(goldRecallArgs(gold('a'))).toEqual({})
  })
})

describe('runGold', () => {
  it('scores every query in every run and marks a query whose text changes between runs unstable', async () => {
    const entries = [gold('a'), gold('b')]
    const calls: string[] = []
    const body = await runGold({
      gold: entries,
      runs: 3,
      recall: async (entry) => {
        calls.push(entry.id)
        const run = calls.filter((c) => c === entry.id).length
        // b's second item flips order on run 2.
        const ids = entry.id === 'b' && run === 2 ? ['x', 'b-gold'] : [`${entry.id}-gold`, 'x']
        return recall(entry.query, ids)
      },
    })
    expect(calls).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
    expect(body.unstable).toEqual(['b'])
    const [a, b] = body.queries
    expect(a!.stable).toBe(true)
    expect(a!.runs.map((r) => r.score.firstGoldRank)).toEqual([1, 1, 1])
    expect(Object.keys(a!.formatted)).toHaveLength(1)
    expect(b!.stable).toBe(false)
    expect(b!.runs.map((r) => r.score.firstGoldRank)).toEqual([1, 2, 1])
    expect(Object.keys(b!.formatted)).toHaveLength(2)
    expect(body.aggregates).toHaveLength(3)
    expect(body.aggregates[1]!.overall.mrr30).toBeCloseTo(0.75)
  })

  it('stops on a degraded recall', async () => {
    const run = runGold({
      gold: [gold('a')],
      runs: 2,
      recall: async (entry) => recall(entry.query, ['a-gold'], { degraded: { vector: 'embed timeout' } }),
    })
    await expect(run).rejects.toBeInstanceOf(DegradedRecallError)
  })
})

describe('run meta', () => {
  const envVars = {
    OPENAI_API_KEY: 'sk-synthetic-openai-value',
    SUPABASE_KEY: 'synthetic-service-role-value',
    SUPABASE_URL: 'http://127.0.0.1:3001',
    NEO4J_PASSWORD: 'synthetic-neo4j-value',
    HF_TOKEN: 'hf_synthetic_value',
    ENGRAM_CHAT_API_KEY: 'synthetic-chat-value',
    CLIENT_SECRET: 'synthetic-client-value',
    ENGRAM_MODEL_TOKEN: 'synthetic-model-token-value',
    ENGRAM_CHAT_MODEL: 'deepseek/deepseek-v4-flash',
    ENGRAM_RERANK_LOCAL: 'true',
    ENGRAM_RERANK_LOCAL_MODEL: 'mixedbread-ai/mxbai-rerank-large-v1',
  }

  it('copies only model ids from the env', () => {
    expect(envModelIds(envVars)).toEqual({
      ENGRAM_CHAT_MODEL: 'deepseek/deepseek-v4-flash',
      ENGRAM_RERANK_LOCAL: 'true',
      ENGRAM_RERANK_LOCAL_MODEL: 'mixedbread-ai/mxbai-rerank-large-v1',
    })
  })

  it('holds no env value whose name contains KEY, SECRET, TOKEN or PASSWORD', async () => {
    const body = await runGold({ gold: [gold('a')], runs: 2, recall: async (e) => recall(e.query, ['a-gold']) })
    const args: RunArgs = parseRunArgs(REQUIRED)
    const pinStats: PinStats = { hits: 4, fills: 0, misses: [], blocked: {}, fetchBlocked: {} }
    const meta = buildRunMeta({
      args,
      envVars,
      distSha: 'a'.repeat(40),
      goldSha: 'b'.repeat(64),
      pinsShaAtStart: 'c'.repeat(64),
      pinsSha: 'c'.repeat(64),
      pinStats,
      guards: createGuardStats(),
      graph: true,
      started: NOW,
      finished: NOW,
      referenceDate: NOW,
      body,
    })
    const text = JSON.stringify(meta)
    for (const [name, value] of Object.entries(envVars)) {
      if (SECRET_NAME.test(name)) {
        expect(text).not.toContain(value)
        expect(text).not.toContain(name)
      }
    }
    expect(meta).toMatchObject({ label: 'control', runs: 2, dist_git_sha: 'a'.repeat(40), blocked_calls: 0, unstable: 0 })
    expect(meta.pin_stats).toEqual({ hits: 4, fills: 0, misses: 0, blocked: {}, fetch_blocked: {} })
    const summary = formatRunSummary({ meta, ...body })
    expect(summary).toContain('# Recall eval: control')
    expect(summary).toContain('0 of 1 queries returned different text between runs.')
    for (const [name, value] of Object.entries(envVars)) {
      if (SECRET_NAME.test(name)) expect(summary).not.toContain(value)
    }
  })
})
