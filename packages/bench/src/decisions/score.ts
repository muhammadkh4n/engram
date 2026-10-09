/**
 * Scores one replayed case, aggregates a run, and checks the pass bars.
 *
 * Everything here is deterministic matching over the lanes a case was
 * replayed through; no model judges anything. A needed memory is delivered by
 * a lane when one item of that lane carries one of its ids, or holds every
 * phrase of one of its phrase groups. An item is the unit an agent read as one
 * piece: a recalled item with its question, a register entry's whole block, a
 * plan decision line, a rule-file paragraph. A phrase group split across two
 * items is not a delivery, since no single item told the agent the fact.
 *
 * Results carry ids, keys, counts and sha256s only, never an item's text.
 */

import * as path from 'node:path'
import { canonicalJson } from '../eval/pins.js'
import { normalizeText } from '../eval/score.js'
import { sha256 } from '../replay/replay-lib.js'
import { caseSplit, LANES, type CaseSplit, type Channel, type DecisionCase, type Lane, type PhraseGroups, type SourceKind } from './cases.js'
import type { Arm, CaseLanes, ContradictionHit, ScopeGap } from './lanes.js'

/** The lanes a replay can deliver through; `none` and `state` are expectations only. */
export const SCORED_LANES = ['scope', 'decision_point', 'query'] as const
export type ScoredLane = (typeof SCORED_LANES)[number]

export const PAYLOAD_KEYS = ['rule_files', 'registers', 'decision_point', 'query', 'total'] as const
export type PayloadKey = (typeof PAYLOAD_KEYS)[number]
export type PayloadChars = Record<PayloadKey, number>

const HOUR_MS = 3_600_000

// ── Lane items, as the scorer sees them ─────────────────────────────────

interface ScoredItem {
  lane: ScoredLane
  form: string
  /** Stable reference for the result: an entry or item id, `plan:decision`, or `path@sha` for a paragraph. */
  ref: string
  registerId: string | null
  itemId: string | null
  legacyId: string | null
  normalized: string
  status: string
  isCurrent: boolean
  hasProvenance: boolean
  isRuleFile: boolean
}

const nonEmpty = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim() !== ''

/** Every item a case's lanes delivered to the agent. An old-arm item created after the prompt is left out: the agent could not have seen it. */
function deliveredItems(lanes: CaseLanes): ScoredItem[] {
  const out: ScoredItem[] = []
  for (const it of lanes.scope.items) {
    if (it.form === 'rule_paragraph') {
      out.push({
        lane: 'scope', form: it.form, ref: `${it.origin}:${it.path}@${it.sha}`, registerId: null, itemId: null, legacyId: null,
        normalized: normalizeText(it.text), status: 'current', isCurrent: true,
        hasProvenance: nonEmpty(it.path) && nonEmpty(it.sha), isRuleFile: true,
      })
    } else if (it.form === 'register_entry') {
      out.push({
        lane: 'scope', form: it.form, ref: it.id, registerId: it.id, itemId: null, legacyId: null,
        normalized: normalizeText(it.text), status: 'in_force', isCurrent: true,
        hasProvenance: nonEmpty(it.quoted_at) && nonEmpty(it.verified.level) && nonEmpty(it.verified.ref), isRuleFile: false,
      })
    } else {
      out.push({
        lane: 'scope', form: it.form, ref: `${path.basename(it.plan_dir)}:${it.id}`, registerId: it.id, itemId: null, legacyId: null,
        normalized: normalizeText(it.text), status: 'in_force', isCurrent: true,
        hasProvenance: nonEmpty(it.id) && nonEmpty(it.decided), isRuleFile: false,
      })
    }
  }
  for (const it of lanes.decision_point?.items ?? []) {
    out.push({
      lane: 'decision_point', form: it.form, ref: it.id, registerId: it.id, itemId: null, legacyId: null,
      normalized: normalizeText(it.text), status: 'in_force', isCurrent: true,
      hasProvenance: nonEmpty(it.quoted_at) && nonEmpty(it.verified.level) && nonEmpty(it.verified.ref), isRuleFile: false,
    })
  }
  const query = lanes.query
  if (query?.arm === 'new') {
    for (const it of query.items) {
      out.push({
        lane: 'query', form: it.form, ref: it.id, registerId: null, itemId: it.id,
        legacyId: it.source.type === 'legacy' ? it.source.ref : null,
        normalized: normalizeText(it.text), status: it.status, isCurrent: it.status === 'current',
        hasProvenance: nonEmpty(it.speaker) && nonEmpty(it.occurred_at) && nonEmpty(it.source.type) && nonEmpty(it.source.ref),
        isRuleFile: false,
      })
    }
  } else if (query?.arm === 'old') {
    query.items.forEach((it, index) => {
      if (it.future) return
      // The old system had no status: everything it showed read as current.
      out.push({
        lane: 'query', form: it.form, ref: it.id ?? `${it.section}#${index}`, registerId: null, itemId: null, legacyId: it.id,
        normalized: normalizeText(it.text), status: 'current', isCurrent: true, hasProvenance: false, isRuleFile: false,
      })
    })
  }
  return out
}

function matchesGroup(normalized: string, groups: PhraseGroups): boolean {
  return groups.some((group) => group.length > 0 && group.every((phrase) => normalized.includes(normalizeText(phrase))))
}

function includes(list: readonly string[], value: string | null): boolean {
  return value !== null && list.includes(value)
}

// ── One case ─────────────────────────────────────────────────────────────

export interface NeededHit {
  lane: ScoredLane
  form: string
  ref: string
  status: string
  with_provenance: boolean
  by: 'id' | 'phrase'
}

export interface NeededScore {
  key: string
  kind: string
  expected_lane: Lane | null
  delivered_by: ScoredLane[]
  /** Delivered with provenance by its expected lane; by any lane when the expected lane is `none` or `state`. */
  with_provenance: boolean
  hits: NeededHit[]
}

export interface HarmfulHit {
  key: string
  lane: ScoredLane
  item_id: string
}

export interface QueryRequestScore {
  input: string
  index: number
  channel: Channel
  budget_chars: number | null
  payload_chars: number
  items: number
}

export interface CaseScore {
  id: string
  split: CaseSplit
  source_kind: SourceKind
  channel: Channel | null
  agent: string | null
  expect_contradiction: boolean
  needed: NeededScore[]
  harmful_as_current: HarmfulHit[]
  harmful_in_rule_files: string[]
  contradiction_hits: ContradictionHit[]
  payload_chars: PayloadChars
  query_requests: QueryRequestScore[]
  future_items: number
  /** Old-arm payload ids with no row in the snapshot: their creation time is unknown. */
  undated_ids: number
  snapshot_gap_hours: number | null
  scope_gaps: ScopeGap[]
  sha256: string
  /** The case's sha256 differed between runs of the same arm. */
  unstable: boolean
  sha256_runs: string[]
}

export interface ScoreOptions {
  /** Cases decided before this time are the calibration split. */
  calibrationBefore: string
  /** The old arm's snapshot dump time; the snapshot cannot hold rows written after it. */
  snapshotDumpedAt?: string | null
}

function scoreNeeded(n: DecisionCase['needed'][number], items: readonly ScoredItem[]): NeededScore {
  const hits: NeededHit[] = []
  for (const it of items) {
    const byId = includes(n.register_ids, it.registerId) || includes(n.item_ids, it.itemId) || includes(n.legacy_ids, it.legacyId)
    const byPhrase = !byId && matchesGroup(it.normalized, n.phrases)
    if (!byId && !byPhrase) continue
    if (hits.some((h) => h.lane === it.lane && h.ref === it.ref)) continue
    hits.push({ lane: it.lane, form: it.form, ref: it.ref, status: it.status, with_provenance: it.hasProvenance, by: byId ? 'id' : 'phrase' })
  }
  const deliveredBy = SCORED_LANES.filter((lane) => hits.some((h) => h.lane === lane))
  const expected = n.expected_lane
  const counted = expected !== null && (SCORED_LANES as readonly string[]).includes(expected) ? hits.filter((h) => h.lane === expected) : hits
  return {
    key: n.key,
    kind: n.kind,
    expected_lane: expected,
    delivered_by: deliveredBy,
    with_provenance: counted.some((h) => h.with_provenance),
    hits,
  }
}

function scoreHarm(c: DecisionCase, items: readonly ScoredItem[]): { asCurrent: HarmfulHit[]; inRuleFiles: string[] } {
  const asCurrent: HarmfulHit[] = []
  const inRuleFiles: string[] = []
  for (const h of c.harmful) {
    for (const it of items) {
      const matches = includes(h.item_ids, it.itemId) || includes(h.legacy_ids, it.legacyId) || matchesGroup(it.normalized, h.phrases)
      // An item that also states the change does not mislead.
      if (!matches || matchesGroup(it.normalized, h.current_phrases)) continue
      if (it.isRuleFile) {
        if (!inRuleFiles.includes(h.key)) inRuleFiles.push(h.key)
      } else if (it.isCurrent && !asCurrent.some((x) => x.key === h.key && x.lane === it.lane && x.item_id === it.ref)) {
        asCurrent.push({ key: h.key, lane: it.lane, item_id: it.ref })
      }
    }
  }
  return { asCurrent, inRuleFiles }
}

function payloadChars(lanes: CaseLanes): PayloadChars {
  let ruleFiles = 0
  let registers = 0
  for (const it of lanes.scope.items) {
    if (it.form === 'rule_paragraph') ruleFiles += it.text.length
    else registers += it.text.length
  }
  const decisionPoint = (lanes.decision_point?.items ?? []).reduce((n, it) => n + it.text.length, 0)
  const query = (lanes.query?.requests ?? []).reduce((n, r) => n + r.payload_chars, 0)
  return { rule_files: ruleFiles, registers, decision_point: decisionPoint, query, total: ruleFiles + registers + decisionPoint + query }
}

/** sha256 over the canonical JSON of each lane's delivered ids and texts, in delivery order. */
export function lanesSha256(lanes: CaseLanes): string {
  const query = lanes.query
  return sha256(
    canonicalJson({
      scope: lanes.scope.items.map((it) => ({ id: it.form === 'rule_paragraph' ? `${it.origin}:${it.path}@${it.sha}` : it.id, text: it.text })),
      decision_point: lanes.decision_point === null
        ? null
        : { items: lanes.decision_point.items.map((it) => ({ id: it.id, text: it.text })), hits: lanes.decision_point.contradiction_hits },
      query: query === null
        ? null
        : query.arm === 'new'
          ? query.items.map((it) => ({ id: it.id, request: it.request, status: it.status, text: it.text }))
          : query.items.map((it) => ({ id: it.id, request: it.request, future: it.future, text: it.text })),
    }),
  )
}

function snapshotGapHours(c: DecisionCase, lanes: CaseLanes, dumpedAt: string | null | undefined): number | null {
  if (lanes.arm !== 'old' || dumpedAt == null || c.decided_at === null) return null
  const gap = (Date.parse(c.decided_at) - Date.parse(dumpedAt)) / HOUR_MS
  return gap > 0 ? Math.round(gap * 100) / 100 : null
}

/** One case's score in one arm. */
export function scoreCase(c: DecisionCase, lanes: CaseLanes, opts: ScoreOptions): CaseScore {
  if (lanes.case_id !== c.id) throw new Error(`lanes of ${lanes.case_id} scored against case ${c.id}`)
  const items = deliveredItems(lanes)
  const harm = scoreHarm(c, items)
  const query = lanes.query
  const sha = lanesSha256(lanes)
  return {
    id: c.id,
    split: caseSplit(c, opts.calibrationBefore),
    source_kind: c.source.kind,
    channel: c.channel,
    agent: c.agent,
    expect_contradiction: c.expect_contradiction,
    needed: c.needed.map((n) => scoreNeeded(n, items)),
    harmful_as_current: harm.asCurrent,
    harmful_in_rule_files: harm.inRuleFiles,
    contradiction_hits: lanes.decision_point?.contradiction_hits.map((h) => ({ ...h, tokens: [...h.tokens] })) ?? [],
    payload_chars: payloadChars(lanes),
    query_requests: (query?.requests ?? []).map((r) => ({
      input: r.input, index: r.index, channel: r.channel, budget_chars: r.budget_chars, payload_chars: r.payload_chars, items: r.items,
    })),
    future_items: query?.arm === 'old' ? query.future_items : 0,
    undated_ids: query?.arm === 'old' ? query.undated_ids.length : 0,
    snapshot_gap_hours: snapshotGapHours(c, lanes, opts.snapshotDumpedAt),
    scope_gaps: lanes.scope.gaps.map((g) => ({ ...g })) as ScopeGap[],
    sha256: sha,
    unstable: false,
    sha256_runs: [sha],
  }
}

/** The first run's score with every run's sha256; a case whose sha256 differs between runs is unstable. */
export function withRunShas(first: CaseScore, shas: readonly string[]): CaseScore {
  return { ...first, sha256_runs: [...shas], unstable: new Set(shas).size > 1 }
}

// ── Aggregates ───────────────────────────────────────────────────────────

export interface Spread {
  p50: number
  p90: number
  max: number
}

export interface LaneCount {
  expected: number
  /** Delivered by the expected lane; by any lane for `none` and `state`. */
  delivered: number
}

export interface ScoreGroup {
  cases: number
  needed: number
  by_expected_lane: Record<Lane, LaneCount>
  delivered_by_lane: Record<ScoredLane, number>
  harmful_as_current: number
  harmful_in_rule_files: number
  future_items: number
  payload_chars: Record<PayloadKey, Spread | null>
}

export interface RunAggregates {
  overall: ScoreGroup
  by_split: Record<string, ScoreGroup>
  by_source: Record<string, ScoreGroup>
  by_channel: Record<string, ScoreGroup>
  by_expected_lane: Record<string, ScoreGroup>
}

/** Nearest-rank percentile: the smallest value with at least p of the values at or below it. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
}

function spread(values: readonly number[]): Spread | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted[sorted.length - 1]! }
}

export function isDeliveredAsExpected(n: NeededScore): boolean {
  const lane = n.expected_lane
  if (lane !== null && (SCORED_LANES as readonly string[]).includes(lane)) return n.delivered_by.includes(lane as ScoredLane)
  return n.delivered_by.length > 0
}

function group(cases: readonly CaseScore[], keep: (n: NeededScore) => boolean = () => true): ScoreGroup {
  const needed = cases.flatMap((c) => c.needed.filter(keep))
  const byExpected = Object.fromEntries(LANES.map((lane) => [lane, { expected: 0, delivered: 0 }])) as Record<Lane, LaneCount>
  for (const n of needed) {
    if (n.expected_lane === null) continue
    byExpected[n.expected_lane].expected += 1
    if (isDeliveredAsExpected(n)) byExpected[n.expected_lane].delivered += 1
  }
  const deliveredBy = Object.fromEntries(SCORED_LANES.map((lane) => [lane, needed.filter((n) => n.delivered_by.includes(lane)).length]))
  return {
    cases: cases.length,
    needed: needed.length,
    by_expected_lane: byExpected,
    delivered_by_lane: deliveredBy as Record<ScoredLane, number>,
    harmful_as_current: cases.reduce((n, c) => n + c.harmful_as_current.length, 0),
    harmful_in_rule_files: cases.reduce((n, c) => n + c.harmful_in_rule_files.length, 0),
    future_items: cases.reduce((n, c) => n + c.future_items, 0),
    payload_chars: Object.fromEntries(PAYLOAD_KEYS.map((k) => [k, spread(cases.map((c) => c.payload_chars[k]))])) as Record<PayloadKey, Spread | null>,
  }
}

function groupBy(cases: readonly CaseScore[], key: (c: CaseScore) => string): Record<string, ScoreGroup> {
  const buckets = new Map<string, CaseScore[]>()
  for (const c of cases) buckets.set(key(c), [...(buckets.get(key(c)) ?? []), c])
  return Object.fromEntries([...buckets.keys()].sort().map((k) => [k, group(buckets.get(k)!)]))
}

/** Delivered over expected per lane, harm and payload spreads, overall and per split, source, channel and expected lane. */
export function aggregateCases(cases: readonly CaseScore[]): RunAggregates {
  const byExpectedLane: Record<string, ScoreGroup> = {}
  for (const lane of LANES) {
    const withLane = cases.filter((c) => c.needed.some((n) => n.expected_lane === lane))
    if (withLane.length > 0) byExpectedLane[lane] = group(withLane, (n) => n.expected_lane === lane)
  }
  return {
    overall: group(cases),
    by_split: groupBy(cases, (c) => c.split),
    by_source: groupBy(cases, (c) => c.source_kind),
    by_channel: groupBy(cases, (c) => c.channel ?? 'none'),
    by_expected_lane: byExpectedLane,
  }
}

// ── Bars ─────────────────────────────────────────────────────────────────

export const BAR_NAMES = [
  'scope-coverage',
  'decision-point-coverage',
  'query-coverage',
  'no-regression',
  'nothing-false-as-current',
  'bounded-and-deterministic',
] as const
export type BarName = (typeof BAR_NAMES)[number]

export interface BarResult {
  name: BarName
  pass: boolean
  failing_case_ids: string[]
  /** The input a bar could not be checked without; such a bar fails. */
  needs?: 'old-run' | 'second-run'
}

/** The part of a run result the bars read. */
export interface ScoredRun {
  meta: { arm: Arm; case_file_sha256: string; runs: number }
  cases: CaseScore[]
}

export class BarInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BarInputError'
  }
}

function failingWhere(cases: readonly CaseScore[], fails: (c: CaseScore) => boolean): string[] {
  return cases.filter(fails).map((c) => c.id)
}

function bar(name: BarName, failing: string[], needs?: BarResult['needs']): BarResult {
  return { name, pass: failing.length === 0 && needs === undefined, failing_case_ids: failing, ...(needs ? { needs } : {}) }
}

const neededOn = (c: CaseScore, lane: Lane): NeededScore[] => c.needed.filter((n) => n.expected_lane === lane)

function noRegression(newRun: ScoredRun, oldRun: ScoredRun): string[] {
  const fresh = new Map(newRun.cases.map((c) => [c.id, c]))
  return oldRun.cases
    .filter((old) => {
      const now = fresh.get(old.id)
      return old.needed.some((n) => {
        if (n.delivered_by.length === 0) return false
        const counterpart = now?.needed.find((m) => m.key === n.key)
        return counterpart === undefined || counterpart.delivered_by.length === 0
      })
    })
    .map((c) => c.id)
}

/**
 * The six bars this instrument measures, by name, each pass or fail with the
 * failing case ids. `no-regression` needs the old arm's run over the same case
 * file; `bounded-and-deterministic` needs a run of at least two passes. A bar
 * missing its input fails and names what it needs.
 */
export function evaluateBars(newRun: ScoredRun, oldRun?: ScoredRun): BarResult[] {
  if (newRun.meta.arm !== 'new') throw new BarInputError('the bars apply to a new-arm run')
  if (oldRun !== undefined) {
    if (oldRun.meta.arm !== 'old') throw new BarInputError('no-regression compares against an old-arm run')
    if (oldRun.meta.case_file_sha256 !== newRun.meta.case_file_sha256) throw new BarInputError('the two runs scored different case files')
  }
  const cases = newRun.cases
  const overBudget = (c: CaseScore) => c.query_requests.some((r) => r.budget_chars !== null && r.payload_chars > r.budget_chars)
  return [
    bar('scope-coverage', failingWhere(cases, (c) => neededOn(c, 'scope').some((n) => !n.hits.some((h) => h.lane === 'scope' && h.with_provenance)))),
    bar(
      'decision-point-coverage',
      failingWhere(cases, (c) => neededOn(c, 'decision_point').some((n) => !n.delivered_by.includes('decision_point')) || (c.expect_contradiction && c.contradiction_hits.length === 0)),
    ),
    bar(
      'query-coverage',
      failingWhere(cases, (c) => neededOn(c, 'query').some((n) => !n.hits.some((h) => h.lane === 'query' && h.status === 'current' && h.with_provenance))),
    ),
    oldRun === undefined ? bar('no-regression', [], 'old-run') : bar('no-regression', noRegression(newRun, oldRun)),
    bar('nothing-false-as-current', failingWhere(cases, (c) => c.harmful_as_current.length > 0)),
    bar('bounded-and-deterministic', failingWhere(cases, (c) => overBudget(c) || c.unstable), newRun.meta.runs < 2 ? 'second-run' : undefined),
  ]
}
