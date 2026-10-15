import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DecisionCase } from '../../src/decisions/cases.js'
import { main, type OldArmHandle, type RunDeps } from '../../src/decisions/engram-decision-replay.js'
import type {
  CaseLanes,
  NewQueryItem,
  OldQueryItem,
  RegisterEntryItem,
  RuleParagraphItem,
  ScopeItem,
} from '../../src/decisions/lanes.js'
import type { RecallRequest } from '../../src/decisions/recall-client.js'
import {
  aggregateCases,
  BarInputError,
  evaluateBars,
  scoreCase,
  withRunShas,
  type BarName,
  type CaseScore,
  type ScoredRun,
} from '../../src/decisions/score.js'
import { createGuardStats } from '../../src/eval/write-guards.js'

const DECIDED = '2026-09-30T10:00:00.000Z'
const CUT = '2026-09-29T19:00:00Z'
const OPTS = { calibrationBefore: CUT }

function makeCase(o: Partial<DecisionCase> = {}): DecisionCase {
  return {
    id: 'TST-CASE-1',
    source: { kind: 'incident', ref: 'TST-CASE-1' },
    status: 'reviewed',
    decided_at: DECIDED,
    agent: 'main',
    channel: 'prompt',
    session_id: 'abcdefab-1111-2222-3333-444455556666',
    transcript: null,
    cwd: null,
    project_id: 'synthetic-project',
    workspace_id: null,
    at_root: false,
    plan_dirs: [],
    query_text: 'which port does the reporting api use',
    prior_prompts: [],
    decision_kind: null,
    tool_text: null,
    expect_contradiction: false,
    needed: [
      { key: 'port', kind: 'fact', expected_lane: 'query', phrases: [['reporting api', 'port 3000']], register_ids: [], item_ids: [], legacy_ids: [] },
    ],
    harmful: [],
    audit: null,
    note: 'synthetic',
    ...o,
  }
}

function paragraph(text: string): RuleParagraphItem {
  return { form: 'rule_paragraph', id: null, text, origin: 'dotfiles', path: 'claude/CLAUDE.md', sha: 'a'.repeat(40) }
}

function entry(id: string, text: string, o: Partial<RegisterEntryItem> = {}): RegisterEntryItem {
  return {
    form: 'register_entry',
    id,
    text: `## ${id} · synthetic\n${text}`,
    file: '/synthetic/notes/Synthetic/Rulings.md',
    scope: 'project',
    scope_id: 'synthetic-project',
    status: 'active',
    quoted_at: '2026-09-01T10:00:00.000Z',
    verified: { level: 'transcript', ref: 'synthetic.jsonl line 3' },
    ...o,
  }
}

function newItem(id: string, text: string, o: Partial<NewQueryItem> = {}): NewQueryItem {
  return {
    form: 'recall_item',
    request: 0,
    id,
    class: 'mk_statement',
    kind: 'fact',
    speaker: 'mk',
    trust: 3,
    occurred_at: '2026-09-20T08:00:00Z',
    project_id: 'synthetic-project',
    session_id: null,
    subject: null,
    text,
    source: { type: 'transcript', ref: 'synthetic.jsonl:12' },
    status: 'current',
    superseded_by: null,
    flags: [],
    via: 'query',
    ...o,
  }
}

function oldItem(id: string, text: string, future = false): OldQueryItem {
  return { form: 'old_recall_item', request: 0, id, section: 'recalled', text, created_at: '2026-09-01T00:00:00Z', future }
}

interface LaneParts {
  scope?: ScopeItem[]
  decisionPoint?: RegisterEntryItem[]
  hits?: { entry_id: string; file: string; tokens: string[] }[]
  newQuery?: NewQueryItem[]
  oldQuery?: OldQueryItem[]
  budget?: number
  payload?: number
}

function lanes(parts: LaneParts, caseId = 'TST-CASE-1'): CaseLanes {
  const arm = parts.oldQuery ? 'old' : 'new'
  const request = {
    input: 'query_text' as const,
    index: 0,
    at: DECIDED,
    channel: 'prompt' as const,
    budget_chars: arm === 'new' ? (parts.budget ?? 9000) : null,
    payload_chars: parts.payload ?? 100,
    items: 1,
    omitted: null,
  }
  return {
    case_id: caseId,
    arm,
    scope: { items: parts.scope ?? [], dotfiles_sha: 'a'.repeat(40), checkout_sha: null, registers: [], gaps: [] },
    decision_point:
      parts.decisionPoint || parts.hits
        ? {
            decision_kind: 'deploy',
            items: (parts.decisionPoint ?? []).map((e) => ({ ...e, matched_by: ['trigger' as const] })),
            contradiction_hits: parts.hits ?? [],
          }
        : null,
    query: parts.oldQuery
      ? {
          arm: 'old',
          requests: [request],
          items: parts.oldQuery,
          future_items: parts.oldQuery.filter((i) => i.future).length,
          undated_ids: [],
        }
      : parts.newQuery
        ? { arm: 'new', requests: [request], items: parts.newQuery }
        : null,
  }
}

describe('scoreCase', () => {
  it('matches a phrase group only when one item holds every phrase', () => {
    const c = makeCase()
    const split = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'the reporting api is ours'), newItem('item-b', 'it listens on port 3000')] }), OPTS)
    expect(split.needed[0]!.delivered_by).toEqual([])
    const whole = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'The Reporting  API listens on PORT 3000')] }), OPTS)
    expect(whole.needed[0]!.delivered_by).toEqual(['query'])
    expect(whole.needed[0]!.hits).toEqual([{ lane: 'query', form: 'recall_item', ref: 'item-a', status: 'current', with_provenance: true, by: 'phrase' }])
    expect(whole.needed[0]!.with_provenance).toBe(true)
  })

  it('cancels harm when the same item also states the change', () => {
    const c = makeCase({
      harmful: [{ key: 'old-port', phrases: [['port 8080']], current_phrases: [['moved to port 3000']], item_ids: [], legacy_ids: [] }],
    })
    const misleading = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'the api uses port 8080')] }), OPTS)
    expect(misleading.harmful_as_current).toEqual([{ key: 'old-port', lane: 'query', item_id: 'item-a' }])
    const stated = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'the api used port 8080 and moved to port 3000')] }), OPTS)
    expect(stated.harmful_as_current).toEqual([])
    const superseded = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'the api uses port 8080', { status: 'superseded' })] }), OPTS)
    expect(superseded.harmful_as_current).toEqual([])
  })

  it('never counts an old-arm item created after the prompt as delivered', () => {
    const c = makeCase({
      needed: [{ key: 'port', kind: 'fact', expected_lane: 'query', phrases: [], register_ids: [], item_ids: [], legacy_ids: ['legacy-later'] }],
      harmful: [{ key: 'stale', phrases: [['port 8080']], current_phrases: [], item_ids: [], legacy_ids: [] }],
    })
    const s = scoreCase(c, lanes({ oldQuery: [oldItem('legacy-later', 'the api uses port 8080', true)] }), { ...OPTS, snapshotDumpedAt: '2026-09-29T10:00:00Z' })
    expect(s.needed[0]!.delivered_by).toEqual([])
    expect(s.harmful_as_current).toEqual([])
    expect(s.future_items).toBe(1)
    expect(s.snapshot_gap_hours).toBe(24)
    const seen = scoreCase(c, lanes({ oldQuery: [oldItem('legacy-later', 'the api uses port 8080', false)] }), OPTS)
    expect(seen.needed[0]!.delivered_by).toEqual(['query'])
    expect(seen.needed[0]!.with_provenance).toBe(false)
    expect(seen.harmful_as_current).toEqual([{ key: 'stale', lane: 'query', item_id: 'legacy-later' }])
  })

  it('lists every lane that delivered a memory', () => {
    const c = makeCase({
      channel: 'decision_point',
      decision_kind: 'deploy',
      query_text: null,
      needed: [{ key: 'rule', kind: 'ruling', expected_lane: 'decision_point', phrases: [], register_ids: ['R-TST-1'], item_ids: [], legacy_ids: [] }],
    })
    const s = scoreCase(c, lanes({ scope: [entry('R-TST-1', 'deploys wait for review')], decisionPoint: [entry('R-TST-1', 'deploys wait for review')] }), OPTS)
    expect(s.needed[0]!.delivered_by).toEqual(['scope', 'decision_point'])
    expect(s.needed[0]!.hits.map((h) => [h.lane, h.by])).toEqual([['scope', 'id'], ['decision_point', 'id']])
  })

  it('puts a harmful rule-file paragraph in harmful_in_rule_files, outside nothing-false-as-current', () => {
    const c = makeCase({ harmful: [{ key: 'old-rule', phrases: [['never use worktrees']], current_phrases: [], item_ids: [], legacy_ids: [] }] })
    const s = scoreCase(c, lanes({ scope: [paragraph('Never use worktrees here.')], newQuery: [newItem('item-a', 'the reporting api listens on port 3000')] }), OPTS)
    expect(s.harmful_in_rule_files).toEqual(['old-rule'])
    expect(s.harmful_as_current).toEqual([])
    const run: ScoredRun = { meta: { arm: 'new', case_file_sha256: 'f'.repeat(64), runs: 2 }, cases: [s] }
    expect(evaluateBars(run).find((b) => b.name === 'nothing-false-as-current')!.pass).toBe(true)
  })

  it('counts payload per lane and splits at the calibration cut', () => {
    const c = makeCase({ decided_at: CUT })
    const s = scoreCase(c, lanes({ scope: [paragraph('12345'), entry('R-TST-1', 'x')], newQuery: [newItem('item-a', 'y')], payload: 40 }), OPTS)
    expect(s.payload_chars).toEqual({ rule_files: 5, registers: entry('R-TST-1', 'x').text.length, decision_point: 0, query: 40, total: 45 + entry('R-TST-1', 'x').text.length })
    expect(s.split).toBe('check')
    expect(scoreCase(makeCase({ decided_at: '2026-09-29T18:59:59.999Z' }), lanes({}), OPTS).split).toBe('calibration')
    const agg = aggregateCases([s])
    expect(agg.overall.by_expected_lane.query).toEqual({ expected: 1, delivered: 0 })
    expect(agg.overall.payload_chars.query).toEqual({ p50: 40, p90: 40, max: 40 })
    expect(Object.keys(agg.by_split)).toEqual(['check'])
  })
})

// ── Bars ──────────────────────────────────────────────────────────────────

function run(cases: CaseScore[], o: Partial<ScoredRun['meta']> = {}): ScoredRun {
  return { meta: { arm: 'new', case_file_sha256: 'f'.repeat(64), runs: 2, ...o }, cases }
}

function barOf(results: ReturnType<typeof evaluateBars>, name: BarName) {
  return results.find((b) => b.name === name)!
}

const needs = (key: string, lane: 'scope' | 'decision_point' | 'query', o: Partial<DecisionCase['needed'][number]> = {}) => ({
  key,
  kind: 'ruling' as const,
  expected_lane: lane,
  phrases: [],
  register_ids: [],
  item_ids: [],
  legacy_ids: [],
  ...o,
})

describe('evaluateBars', () => {
  it('scope-coverage needs the scope lane to deliver with provenance', () => {
    const c = makeCase({ needed: [needs('rule', 'scope', { register_ids: ['R-TST-1'] })] })
    const pass = scoreCase(c, lanes({ scope: [entry('R-TST-1', 'a rule')] }), OPTS)
    const fail = scoreCase(c, lanes({ scope: [entry('R-TST-1', 'a rule', { verified: { level: '', ref: '' } })] }), OPTS)
    expect(barOf(evaluateBars(run([pass])), 'scope-coverage')).toEqual({ name: 'scope-coverage', pass: true, failing_case_ids: [] })
    expect(barOf(evaluateBars(run([fail])), 'scope-coverage')).toEqual({ name: 'scope-coverage', pass: false, failing_case_ids: ['TST-CASE-1'] })
  })

  it('decision-point-coverage needs the lane to deliver and an expected contradiction to be hit', () => {
    const c = makeCase({
      channel: 'decision_point',
      decision_kind: 'deploy',
      query_text: null,
      expect_contradiction: true,
      needed: [needs('rule', 'decision_point', { register_ids: ['R-TST-1'] })],
    })
    const hit = { entry_id: 'R-TST-1', file: 'Rulings.md', tokens: ['deploy'] }
    const pass = scoreCase(c, lanes({ decisionPoint: [entry('R-TST-1', 'x')], hits: [hit] }), OPTS)
    const noHit = scoreCase(c, lanes({ decisionPoint: [entry('R-TST-1', 'x')] }), OPTS)
    const notDelivered = scoreCase(c, lanes({ scope: [entry('R-TST-1', 'x')], hits: [hit] }), OPTS)
    expect(barOf(evaluateBars(run([pass])), 'decision-point-coverage').pass).toBe(true)
    expect(barOf(evaluateBars(run([noHit])), 'decision-point-coverage').failing_case_ids).toEqual(['TST-CASE-1'])
    expect(barOf(evaluateBars(run([notDelivered])), 'decision-point-coverage').failing_case_ids).toEqual(['TST-CASE-1'])
  })

  it('query-coverage needs a current item with provenance', () => {
    const c = makeCase({ needed: [needs('port', 'query', { item_ids: ['item-a'] })] })
    const pass = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'x')] }), OPTS)
    const superseded = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'x', { status: 'superseded' })] }), OPTS)
    const bare = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'x', { speaker: null })] }), OPTS)
    expect(barOf(evaluateBars(run([pass])), 'query-coverage').pass).toBe(true)
    expect(barOf(evaluateBars(run([superseded])), 'query-coverage').pass).toBe(false)
    expect(barOf(evaluateBars(run([bare])), 'query-coverage').failing_case_ids).toEqual(['TST-CASE-1'])
  })

  it('no-regression fails when the old arm delivered a memory the new arm misses, and needs the old run', () => {
    const c = makeCase({ needed: [needs('port', 'query', { legacy_ids: ['legacy-a'] })] })
    const oldScore = scoreCase(c, lanes({ oldQuery: [oldItem('legacy-a', 'x')] }), OPTS)
    const oldRun = run([oldScore], { arm: 'old' })
    const kept = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'x', { source: { type: 'legacy', ref: 'legacy-a' } })] }), OPTS)
    const lost = scoreCase(c, lanes({ newQuery: [newItem('item-a', 'x')] }), OPTS)
    expect(barOf(evaluateBars(run([kept]), oldRun), 'no-regression')).toEqual({ name: 'no-regression', pass: true, failing_case_ids: [] })
    expect(barOf(evaluateBars(run([lost]), oldRun), 'no-regression').failing_case_ids).toEqual(['TST-CASE-1'])
    expect(barOf(evaluateBars(run([kept])), 'no-regression')).toEqual({ name: 'no-regression', pass: false, failing_case_ids: [], needs: 'old-run' })
    expect(() => evaluateBars(run([kept]), run([oldScore], { arm: 'old', case_file_sha256: 'e'.repeat(64) }))).toThrow(BarInputError)
    expect(() => evaluateBars(oldRun)).toThrow(BarInputError)
  })

  it('nothing-false-as-current fails on a harmful register entry shown as in force', () => {
    const c = makeCase({ harmful: [{ key: 'old-rule', phrases: [], current_phrases: [], item_ids: [], legacy_ids: [] }] })
    const harmfulPhrase = makeCase({ harmful: [{ key: 'old-rule', phrases: [['skip review']], current_phrases: [], item_ids: [], legacy_ids: [] }] })
    const pass = scoreCase(c, lanes({ scope: [entry('R-TST-1', 'skip review')] }), OPTS)
    const fail = scoreCase(harmfulPhrase, lanes({ scope: [entry('R-TST-1', 'skip review')] }), OPTS)
    expect(barOf(evaluateBars(run([pass])), 'nothing-false-as-current').pass).toBe(true)
    expect(fail.harmful_as_current).toEqual([{ key: 'old-rule', lane: 'scope', item_id: 'R-TST-1' }])
    expect(barOf(evaluateBars(run([fail])), 'nothing-false-as-current').failing_case_ids).toEqual(['TST-CASE-1'])
  })

  it('bounded-and-deterministic fails over budget, on an unstable case, and on a single pass', () => {
    const c = makeCase()
    const within = scoreCase(c, lanes({ newQuery: [], budget: 1000, payload: 1000 }), OPTS)
    const over = scoreCase(c, lanes({ newQuery: [], budget: 1000, payload: 1001 }), OPTS)
    const unstable = withRunShas(within, [within.sha256, 'd'.repeat(64)])
    expect(barOf(evaluateBars(run([within])), 'bounded-and-deterministic').pass).toBe(true)
    expect(barOf(evaluateBars(run([over])), 'bounded-and-deterministic').failing_case_ids).toEqual(['TST-CASE-1'])
    expect(barOf(evaluateBars(run([unstable])), 'bounded-and-deterministic').failing_case_ids).toEqual(['TST-CASE-1'])
    expect(barOf(evaluateBars(run([within], { runs: 1 })), 'bounded-and-deterministic')).toEqual({
      name: 'bounded-and-deterministic',
      pass: false,
      failing_case_ids: [],
      needs: 'second-run',
    })
  })

  it('returns the six bars by name and nothing else', () => {
    const results = evaluateBars(run([scoreCase(makeCase(), lanes({}), OPTS)]))
    expect(results.map((b) => b.name)).toEqual([
      'scope-coverage',
      'decision-point-coverage',
      'query-coverage',
      'no-regression',
      'nothing-false-as-current',
      'bounded-and-deterministic',
    ])
    for (const b of results) expect(Object.keys(b).sort()).toEqual(b.needs ? ['failing_case_ids', 'name', 'needs', 'pass'] : ['failing_case_ids', 'name', 'pass'])
  })
})

// ── The run and report commands ───────────────────────────────────────────

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-score-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function io() {
  const out: string[] = []
  const err: string[] = []
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err }
}

const SECRET_PROMPT = 'synthetic secret prompt text that must stay off stdout'

function writeInputs(): Record<string, string> {
  const cases = path.join(tmp, 'cases.jsonl')
  fs.writeFileSync(cases, JSON.stringify(makeCase({ cwd: tmp, query_text: SECRET_PROMPT })) + '\n' + JSON.stringify(makeCase({ id: 'TST-CASE-2', status: 'dropped', cwd: tmp, query_text: SECRET_PROMPT })) + '\n')
  const registry = path.join(tmp, 'projects.json')
  fs.writeFileSync(registry, JSON.stringify({ version: 1, workspaces: {}, projects: {} }))
  const channels = path.join(tmp, 'channels.json')
  fs.writeFileSync(channels, JSON.stringify({ prompt: { limit: 5 }, agent_dispatch: {}, executor_start: {}, hand_recall: {} }))
  const token = path.join(tmp, 'token')
  fs.writeFileSync(token, 'synthetic-bearer')
  const dotfiles = path.join(tmp, 'dotfiles')
  fs.mkdirSync(dotfiles)
  return { cases, registry, channels, token, dotfiles }
}

function commonArgs(f: Record<string, string>, label: string): string[] {
  return [
    '--cases', f['cases']!, '--label', label, '--out', path.join(tmp, 'out'), '--calibration-before', CUT,
    '--registry', f['registry']!, '--vault-root', tmp, '--dotfiles', f['dotfiles']!,
  ]
}

/** A replay whose query item text changes on every call when `drift` is set. */
function fakeReplay(drift: boolean): NonNullable<RunDeps['replay']> {
  let calls = 0
  return async (c, _roots, deps) => {
    calls += 1
    const text = drift ? `the reporting api listens on port 3000 (${calls})` : 'the reporting api listens on port 3000'
    return deps.arm === 'new' ? lanes({ newQuery: [newItem('item-a', text)] }, c.id) : lanes({ oldQuery: [oldItem('legacy-a', text)] }, c.id)
  }
}

const recallStub: RunDeps['openRecall'] = () => ({
  origin: 'http://127.0.0.1:9',
  recall: async (_req: RecallRequest) => ({ items: [], omitted: null }),
})

function oldArmStub(): RunDeps['openOldArm'] {
  return async () =>
    ({
      stack: { recall: async () => { throw new Error('not called') } },
      createdAt: async () => new Map(),
      engramEnv: { ENGRAM_RECALL_TOKEN_BUDGET: '6000', ENGRAM_SERVER_TOKEN: 'synthetic-server-token' },
      guards: createGuardStats(),
      pinStats: { hits: 0, fills: 0, misses: [], blocked: {}, fetchBlocked: {} },
      flushPins: () => 'c'.repeat(64),
      assertClean: () => undefined,
      close: async () => undefined,
    }) satisfies OldArmHandle
}

describe('run and report', () => {
  it('writes a 0600 result of reviewed cases, prints counts only, and refuses to overwrite it', async () => {
    const f = writeInputs()
    const args = ['run', '--arm', 'new', ...commonArgs(f, 'fresh'), '--recall-url', 'http://127.0.0.1:9/recall', '--token-file', f['token']!, '--channels', f['channels']!, '--runs', '2']
    const first = io()
    expect(await main(args, first.io, { openRecall: recallStub, replay: fakeReplay(false) })).toBe(0)
    const file = path.join(tmp, 'out', 'fresh.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const result = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(result.meta).toMatchObject({ arm: 'new', label: 'fresh', cases: 1, dropped: 1, runs: 2, store: 'http://127.0.0.1:9', unstable: 0, calibration_before: CUT })
    expect(result.meta.channel_profiles_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.cases.map((c: CaseScore) => [c.id, c.unstable, c.needed[0]!.delivered_by])).toEqual([['TST-CASE-1', false, ['query']]])
    expect(first.out.join('') + first.err.join('')).not.toContain(SECRET_PROMPT)

    const again = io()
    expect(await main(args, again.io, { openRecall: recallStub, replay: fakeReplay(false) })).toBe(2)

    const rep = io()
    expect(await main(['report', file, '--bars'], rep.io)).toBe(0)
    const text = rep.out.join('')
    expect(text).toContain('query 1/1')
    expect(text).toContain('query-coverage: pass')
    expect(text).toContain('no-regression: fail (needs old-run)')
    expect(text).not.toContain(SECRET_PROMPT)
  })

  it('marks a case unstable when its lanes differ between passes', async () => {
    const f = writeInputs()
    const args = ['run', '--arm', 'new', ...commonArgs(f, 'drift'), '--recall-url', 'http://127.0.0.1:9/recall', '--token-file', f['token']!, '--channels', f['channels']!, '--runs', '2']
    expect(await main(args, io().io, { openRecall: recallStub, replay: fakeReplay(true) })).toBe(0)
    const result = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'drift.json'), 'utf8'))
    expect(result.meta.unstable).toBe(1)
    expect(result.cases[0].unstable).toBe(true)
    expect(new Set(result.cases[0].sha256_runs).size).toBe(2)
  })

  it('stops with exit 4 on an unstable old-arm case under strict pins, and writes nothing', async () => {
    const f = writeInputs()
    const oldArgs = (label: string, mode: string) => [
      'run', '--arm', 'old', ...commonArgs(f, label), '--dist', tmp, '--env', path.join(tmp, 'engram.env'), '--pins', path.join(tmp, 'pins.json'),
      '--pins-mode', mode, '--calibration-query', 'synthetic calibration', '--snapshot-label', 'snap-synthetic',
      '--snapshot-dumped-at', '2026-09-29T10:00:00Z', '--runs', '2',
    ]
    const strict = io()
    expect(await main(oldArgs('strict', 'strict'), strict.io, { openOldArm: oldArmStub(), replay: fakeReplay(true) })).toBe(4)
    expect(fs.existsSync(path.join(tmp, 'out', 'strict.json'))).toBe(false)
    expect(strict.err.join('')).toContain('TST-CASE-1')

    expect(await main(oldArgs('fill', 'fill'), io().io, { openOldArm: oldArmStub(), replay: fakeReplay(false) })).toBe(0)
    const result = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'fill.json'), 'utf8'))
    expect(result.meta).toMatchObject({ arm: 'old', store: 'snap-synthetic', pins_mode: 'fill', snapshot_dumped_at: '2026-09-29T10:00:00Z' })
    expect(result.meta.engram_env).toEqual({ ENGRAM_RECALL_TOKEN_BUDGET: '6000', ENGRAM_SERVER_TOKEN: null })
    expect(result.cases[0].snapshot_gap_hours).toBe(24)
  })

  it('refuses usage errors with exit 2: a missing arm flag and a flag of the other arm', async () => {
    const f = writeInputs()
    expect(await main(['run', '--arm', 'new', ...commonArgs(f, 'x')], io().io)).toBe(2)
    expect(await main(['run', '--arm', 'new', ...commonArgs(f, 'x'), '--recall-url', 'http://127.0.0.1:9', '--token-file', f['token']!, '--channels', f['channels']!, '--dist', tmp], io().io)).toBe(2)
    expect(await main(['run', '--arm', 'sideways', ...commonArgs(f, 'x')], io().io)).toBe(2)
    expect(await main(['report'], io().io)).toBe(2)
  })

  it('stops with exit 4 when the recall URL is the production server', async () => {
    const f = writeInputs()
    const args = ['run', '--arm', 'new', ...commonArgs(f, 'prod'), '--recall-url', 'https://rexvps.example/recall', '--token-file', f['token']!, '--channels', f['channels']!]
    expect(await main(args, io().io)).toBe(4)
  })
})
