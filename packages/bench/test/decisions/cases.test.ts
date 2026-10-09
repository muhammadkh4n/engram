import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  CaseFormatError,
  CaseReviewError,
  assertReviewed,
  caseSplit,
  parseCaseLine,
  parseCases,
  type Channel,
  type DecisionCase,
} from '../../src/decisions/cases.js'

const NEEDED = {
  key: 'port',
  kind: 'fact',
  expected_lane: 'query',
  phrases: [['reporting api', 'port 3000']],
  register_ids: [],
  item_ids: [],
  legacy_ids: [],
}

const BASE: DecisionCase = {
  id: 'TST-CASE-1',
  source: { kind: 'incident', ref: 'TST-CASE-1' },
  status: 'reviewed',
  decided_at: '2026-09-30T10:00:00.000Z',
  agent: 'main',
  channel: 'session_start',
  session_id: 'abcdefab-1111-2222-3333-444455556666',
  transcript: { file: '/tmp/synthetic/abcdefab-1111-2222-3333-444455556666.jsonl', line: 4 },
  cwd: '/home/synthetic/project',
  project_id: 'synthetic-project',
  workspace_id: null,
  at_root: false,
  plan_dirs: ['/home/synthetic/plans/demo-plan'],
  query_text: null,
  prior_prompts: [],
  decision_kind: null,
  tool_text: null,
  expect_contradiction: false,
  needed: [NEEDED as DecisionCase['needed'][number]],
  harmful: [{ key: 'old-port', phrases: [['port 8080']], current_phrases: [['port 3000']], item_ids: [], legacy_ids: ['legacy-1'] }],
  audit: null,
  note: 'synthetic',
}

function line(overrides: Record<string, unknown> = {}, drop: string[] = []): string {
  const entry: Record<string, unknown> = { ...BASE, ...overrides }
  for (const key of drop) delete entry[key]
  return JSON.stringify(entry)
}

const CHANNEL_FIELDS: Record<Channel, Record<string, unknown>> = {
  prompt: { query_text: 'which port does the reporting api use' },
  session_start: {},
  compaction: {},
  subagent_start: { agent: 'subagent' },
  agent_dispatch: { query_text: 'dispatch the reviewer on the reporting api' },
  executor_start: { agent: 'executor', query_text: 'start the reporting api task' },
  decision_point: { decision_kind: 'stakeholder-draft:pat', tool_text: 'draft text', expect_contradiction: true },
  hand_recall: { query_text: 'reporting api port' },
}

describe('parseCaseLine', () => {
  it.each(CHANNELS.map((c) => [c]))('parses a valid line on channel %s', (channel) => {
    const parsed = parseCaseLine(line({ channel, ...CHANNEL_FIELDS[channel] }), 1)
    expect(parsed.channel).toBe(channel)
    expect(parsed.needed).toHaveLength(1)
  })

  it('refuses an unknown top-level field with its line', () => {
    expect(() => parseCaseLine(line({ extra: 1 }), 3)).toThrow(/case line 3: extra is an unknown field/)
  })

  it('refuses an unknown field inside needed with its line and path', () => {
    const needed = [{ ...NEEDED, item_id: 'x' }]
    expect(() => parseCaseLine(line({ needed }), 5)).toThrow(/case line 5: needed\[0\]\.item_id is an unknown field/)
  })

  it('refuses a missing field', () => {
    expect(() => parseCaseLine(line({}, ['note']), 2)).toThrow(/case line 2: note is missing/)
  })

  it('refuses decision_point without decision_kind', () => {
    expect(() => parseCaseLine(line({ channel: 'decision_point' }), 1)).toThrow(/decision_kind is required on channel decision_point/)
  })

  it('refuses prompt without query_text', () => {
    expect(() => parseCaseLine(line({ channel: 'prompt' }), 1)).toThrow(/query_text is required on channel prompt/)
  })

  it('refuses a query_text of 2001 chars and accepts 2000', () => {
    expect(() => parseCaseLine(line({ channel: 'prompt', query_text: 'a'.repeat(2001) }), 1)).toThrow(/query_text is 2001 chars/)
    expect(parseCaseLine(line({ channel: 'prompt', query_text: 'a'.repeat(2000) }), 1).query_text).toHaveLength(2000)
  })

  it('refuses a time without an offset', () => {
    expect(() => parseCaseLine(line({ decided_at: '2026-09-30T10:00:00' }), 1)).toThrow(/decided_at must be an ISO-8601 time with an offset/)
    expect(parseCaseLine(line({ decided_at: '2026-09-30T15:00:00+05:00' }), 1).decided_at).toBe('2026-09-30T15:00:00+05:00')
  })

  it('refuses a prior prompt at or after decided_at, and prompts out of order', () => {
    const late = [{ text: 'later prompt', at: '2026-09-30T10:00:00.000Z' }]
    expect(() => parseCaseLine(line({ prior_prompts: late }), 1)).toThrow(/prior_prompts\[0\]\.at must be before decided_at/)
    const unordered = [
      { text: 'second', at: '2026-09-30T09:00:00Z' },
      { text: 'first', at: '2026-09-30T08:00:00Z' },
    ]
    expect(() => parseCaseLine(line({ prior_prompts: unordered }), 1)).toThrow(/oldest first/)
  })

  it('refuses more than five prior prompts', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ text: `prompt ${i}`, at: `2026-09-30T0${i}:00:00Z` }))
    expect(() => parseCaseLine(line({ prior_prompts: six }), 1)).toThrow(/at most 5/)
  })

  it('checks trigger words, and a stakeholder draft needs a name', () => {
    const at = { channel: 'decision_point' }
    expect(parseCaseLine(line({ ...at, decision_kind: 'deploy' }), 1).decision_kind).toBe('deploy')
    expect(() => parseCaseLine(line({ ...at, decision_kind: 'stakeholder-draft:' }), 1)).toThrow(/must be a trigger word/)
    expect(() => parseCaseLine(line({ ...at, decision_kind: 'deploying' }), 1)).toThrow(/must be a trigger word/)
  })

  it('refuses a relative plan dir', () => {
    expect(() => parseCaseLine(line({ plan_dirs: ['plans/demo'] }), 1)).toThrow(/plan_dirs\[0\] must be an absolute path/)
  })

  it('lets only a draft hold null decision fields, an unset lane or no needed memory', () => {
    const gaps = { decided_at: null, agent: null, channel: null, session_id: null, cwd: null, needed: [] }
    expect(parseCaseLine(line({ ...gaps, status: 'draft' }), 1).decided_at).toBeNull()
    expect(() => parseCaseLine(line({ decided_at: null }), 1)).toThrow(/decided_at may be null only in a draft/)
    expect(() => parseCaseLine(line({ needed: [] }), 1)).toThrow(/needs at least one memory once the case is reviewed/)
    const unset = [{ ...NEEDED, expected_lane: null }]
    expect(() => parseCaseLine(line({ needed: unset }), 1)).toThrow(/expected_lane must be set once the case is reviewed/)
    const bare = [{ ...NEEDED, phrases: [] }]
    expect(() => parseCaseLine(line({ needed: bare }), 1)).toThrow(/needs a phrase group or an id/)
  })
})

describe('parseCases', () => {
  it('refuses a duplicate id with both lines', () => {
    const text = [line(), '', line()].join('\n')
    expect(() => parseCases(text)).toThrow(new CaseFormatError(3, 'duplicate id TST-CASE-1 (first on line 1)'))
  })

  it('refuses an empty file', () => {
    expect(() => parseCases('\n\n')).toThrow(/no case lines/)
  })
})

describe('assertReviewed', () => {
  const draftLine = line({ id: 'TST-CASE-2', status: 'draft', needed: [{ ...NEEDED, expected_lane: null, phrases: [] }] })

  it('a draft passes the parser and fails assertReviewed', () => {
    const cases = parseCases([line(), draftLine].join('\n'))
    expect(() => assertReviewed(cases)).toThrow(CaseReviewError)
    expect(() => assertReviewed(cases)).toThrow(/TST-CASE-2 is a draft/)
  })

  it('passes reviewed and dropped cases', () => {
    const cases = parseCases([line(), line({ id: 'TST-CASE-3', status: 'dropped', needed: [] })].join('\n'))
    expect(() => assertReviewed(cases)).not.toThrow()
  })
})

describe('caseSplit', () => {
  const cut = '2026-09-29T19:00:00Z'

  it('is check at the cut and calibration 1 ms before it', () => {
    expect(caseSplit({ id: 'TST-CASE-1', decided_at: '2026-09-29T19:00:00.000Z' }, cut)).toBe('check')
    expect(caseSplit({ id: 'TST-CASE-1', decided_at: '2026-09-29T18:59:59.999Z' }, cut)).toBe('calibration')
  })

  it('compares instants across offsets', () => {
    expect(caseSplit({ id: 'TST-CASE-1', decided_at: '2026-09-30T00:00:00+05:00' }, new Date(cut))).toBe('check')
  })

  it('refuses a case without decided_at', () => {
    expect(() => caseSplit({ id: 'TST-CASE-1', decided_at: null }, cut)).toThrow(/no decided_at/)
  })
})
