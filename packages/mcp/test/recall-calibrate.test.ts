import { describe, expect, it } from 'vitest'
import {
  caseSplit,
  checkLocalUrl,
  floorFromScores,
  matchesGroup,
  parseCalibrateArgs,
  replayRequests,
  runCalibration,
  type CalibrateArgs,
} from '../src/recall-calibrate-cli.js'
import { TST_ITEM_ID, stubRecallDeps, tstRow } from './recall-fixtures.js'

const CUT = '2026-09-29T19:00:00Z'

function reviewedCase(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'tst-case-1',
    status: 'reviewed',
    decided_at: '2026-09-20T10:00:00Z',
    channel: 'agent_dispatch',
    session_id: 'tst-live-session',
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    at_root: false,
    plan_dirs: ['/vault/Plans/Active/tst-plan/'],
    query_text: '  what floor does the tst reranker use?  ',
    needed: [{ key: 'k', kind: 'fact', expected_lane: 'query', phrases: [], register_ids: [], item_ids: [TST_ITEM_ID], legacy_ids: [] }],
    ...overrides,
  })
}

const PROFILES = JSON.stringify({ agent_dispatch: { limit: 8, budget_chars: 4000, exclude_live_session: true }, prompt: { classes: ['mk_statement'] } })

describe('the pre-registered floor rule', () => {
  it('puts F at 0.410 for 150 needed items with one at 0.12, one at 0.41 and the rest above 0.5', () => {
    const scores = [0.12, 0.41, ...Array.from({ length: 148 }, (_, i) => 0.51 + (i % 40) / 100)]
    const r = floorFromScores(scores)
    expect(r.n).toBe(150)
    expect(r.floor).toBe(0.41)
    const sorted = [...scores].sort((a, b) => a - b)
    const median = (sorted[74]! + sorted[75]!) / 2
    expect(r.strong).toBe(Math.floor(median * 200) / 200)
    expect(r.neededBelowFloor).toBe(1)
  })

  it('gives F = 0.000 when needed scores spread down to 0, and S never below F', () => {
    expect(floorFromScores([0, 0, 0.2, 0.4, 0.9]).floor).toBe(0)
    const r = floorFromScores([0.9, 0.9, 0.95])
    expect(r.strong).toBeGreaterThanOrEqual(r.floor)
  })

  it('refuses to measure with no needed item in any slate', () => {
    expect(() => floorFromScores([])).toThrow('no needed item reached a slate')
  })
})

describe('the replay requests', () => {
  it('puts a case 1 ms before the cut in calibration and one at the cut in check', () => {
    expect(caseSplit('2026-09-29T18:59:59.999Z', CUT)).toBe('calibration')
    expect(caseSplit(CUT, CUT)).toBe('check')
  })

  it('sends the case query on its own channel, with the profile, scope, time and excluded session', () => {
    const [r] = replayRequests(reviewedCase(), PROFILES, { split: 'calibration', calibrationBefore: CUT })
    expect(r!.request).toEqual({
      query: 'what floor does the tst reranker use?',
      channel: 'agent_dispatch',
      scope: { projectId: 'tst-repo', workspaceId: 'tst-ws', planSlugs: ['tst-plan'] },
      asOf: new Date('2026-09-20T10:00:00Z'),
      limit: 8,
      budgetChars: 4000,
      excludeSessionId: 'tst-live-session',
    })
  })

  it('sends no project at a root, and skips drafts, other lanes, other channels and the other split', () => {
    const lines = [
      reviewedCase({ id: 'root', at_root: true }),
      reviewedCase({ id: 'draft', status: 'draft' }),
      reviewedCase({ id: 'scope-lane', channel: 'session_start' }),
      reviewedCase({ id: 'late', decided_at: '2026-10-01T00:00:00Z' }),
    ].join('\n')
    const out = replayRequests(lines, PROFILES, { split: 'calibration', calibrationBefore: CUT })
    expect(out.map((r) => r.id)).toEqual(['root'])
    expect(out[0]!.request.scope).toEqual({ atRoot: true, workspaceId: 'tst-ws', planSlugs: ['tst-plan'] })
    expect(replayRequests(lines, PROFILES, { split: 'all', calibrationBefore: CUT }).map((r) => r.id)).toEqual(['root', 'late'])
  })

  it('keeps only the needed entries expected in the query lane', () => {
    const c = reviewedCase({
      needed: [
        { key: 'a', kind: 'fact', expected_lane: 'scope', phrases: [], register_ids: [], item_ids: ['x'], legacy_ids: [] },
        { key: 'b', kind: 'fact', expected_lane: 'query', phrases: [['tst']], register_ids: [], item_ids: [], legacy_ids: ['old-1'] },
      ],
    })
    expect(replayRequests(c, PROFILES, { split: 'all', calibrationBefore: CUT })[0]!.needed).toEqual([{ itemIds: [], legacyIds: ['old-1'], phrases: [['tst']] }])
  })

  it('matches a phrase group only when every phrase is in the one item', () => {
    expect(matchesGroup('The TST floor is  0.3.', [['tst floor', '0.3']])).toBe(true)
    expect(matchesGroup('The tst floor.', [['tst floor', '0.3']])).toBe(false)
    expect(matchesGroup('anything', [[]])).toBe(false)
  })
})

describe('the CLI guard and arguments', () => {
  it('runs only against a database on this machine', () => {
    expect(checkLocalUrl('http://127.0.0.1:3000')).toBeNull()
    expect(checkLocalUrl('http://localhost:54321')).toBeNull()
    expect(checkLocalUrl('https://engram.example.com')).toBe('SUPABASE_URL must point at 127.0.0.1 or localhost, not engram.example.com')
    expect(checkLocalUrl(undefined)).toBe('SUPABASE_URL is not set')
  })

  it('needs a report, and --replay with --channels', () => {
    expect(parseCalibrateArgs(['--gold', 'g.jsonl'])).toEqual({ error: 'name the --report file' })
    expect(parseCalibrateArgs(['--replay', 'c.jsonl', '--report', 'r.json'])).toEqual({ error: '--replay and --channels go together' })
    expect(parseCalibrateArgs(['--report', 'r.json'])).toEqual({ error: 'name --replay or --gold, or both' })
    expect(parseCalibrateArgs(['--gold', 'g.jsonl', '--report', 'r.json', '--split', 'later'])).toEqual({ error: '--split must be calibration, check or all' })
  })
})

describe('runCalibration', () => {
  it('writes ids and scores only, never text, and prints a ready floor entry', async () => {
    const files: Record<string, string> = {
      'cases.jsonl': reviewedCase(),
      'profile.json': PROFILES,
      'gold.jsonl': JSON.stringify({ id: 'g1', class: 'fact', query: 'tst floor?', project_id: 'tst-repo', gold_ids: ['old-1'], stale_ids: [] }),
    }
    const written: Record<string, string> = {}
    const out: string[] = []
    const args: CalibrateArgs = { replay: 'cases.jsonl', channels: 'profile.json', gold: 'gold.jsonl', split: 'calibration', calibrationBefore: CUT, report: 'r.json' }
    const result = await runCalibration(args, {
      readText: async (p) => files[p]!,
      writeText: async (p, t) => {
        written[p] = t
      },
      deps: async () => ({ ...stubRecallDeps(), rerankerId: 'tst-reranker' }),
      legacyItems: async () => new Map([['old-1', TST_ITEM_ID]]),
      now: () => new Date('2026-10-01T00:00:00Z'),
      out: (t) => out.push(t),
    })
    expect(result).toEqual({ n: 2, floor: 0.8, strong: 0.8, neededBelowFloor: 0 })
    const report = written['r.json']!
    expect(report).not.toContain(tstRow().contentHead)
    expect(report).not.toMatch(/"(text|content|content_head|query)"/)
    expect(out.join('')).toContain('"reranker": "tst-reranker"')
    expect(out.join('')).toContain('n=2 F=0.800 S=0.800')
  })
})
