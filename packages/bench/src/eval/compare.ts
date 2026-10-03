/**
 * `engram-recall-eval compare A B`: pairs two run results by gold id and
 * reports how B moved against A. Only queries stable in both runs are paired;
 * a query whose text changed between repeats of the same build says nothing
 * about the change under test, so it is listed apart. The output is numbers
 * only: whether a difference counts is decided by rules fixed before the run.
 */
import type { GoldClass } from './gold.js'
import type { QueryResult, RunMeta, RunResult } from './run.js'
import type { QueryScore } from './score.js'

export type RankOutcome = 'better' | 'worse' | 'tie'
export type Change = 'gain' | 'loss' | null
export type StaleChange = 'fixed' | 'introduced' | null

export interface ComparedQuery {
  id: string
  class: GoldClass
  rankA: number | null
  rankB: number | null
  /** B against A on firstGoldRank; an absent rank counts as below every rank. */
  outcome: RankOutcome
  hitAt10: Change
  goldInPayload: Change
  staleBeforeCurrent: StaleChange
  charsDelta: number
  tokensDelta: number
}

export interface CompareTotals {
  queries: number
  wins: number
  losses: number
  ties: number
  /** Exact two-sided sign test over the non-tied queries. */
  signTestP: number
  mrrA: number
  mrrB: number
  mrrDelta: number
  hitAt10Gains: number
  hitAt10Losses: number
  goldInPayloadGains: number
  goldInPayloadLosses: number
  staleFixed: number
  staleIntroduced: number
  charsDeltaMean: number
  tokensDeltaMean: number
}

export interface CompareSide {
  label: string
  dist_git_sha: string | null
  gold_sha256: string
  pins_sha256: string
}

export interface Comparison {
  a: CompareSide
  b: CompareSide
  goldShaMatch: boolean
  queries: ComparedQuery[]
  totals: CompareTotals
  byClass: Partial<Record<GoldClass, CompareTotals>>
  unstable: Array<{ id: string; in: Array<'A' | 'B'> }>
  onlyInA: string[]
  onlyInB: string[]
}

// --- statistics -----------------------------------------------------------

/**
 * Exact two-sided sign test: twice the binomial(n, 1/2) tail at the smaller
 * count, capped at 1. Terms are summed in log space so large n neither
 * overflows nor underflows.
 */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0) return 1
  const k = Math.min(wins, losses)
  const logHalfN = -n * Math.LN2
  let logChoose = 0
  let tail = Math.exp(logHalfN)
  for (let i = 1; i <= k; i++) {
    logChoose += Math.log(n - i + 1) - Math.log(i)
    tail += Math.exp(logChoose + logHalfN)
  }
  return Math.min(1, 2 * tail)
}

function reciprocalRank(rank: number | null): number {
  return rank !== null && rank <= 30 ? 1 / rank : 0
}

function rankOutcome(a: number | null, b: number | null): RankOutcome {
  const ra = a ?? Number.POSITIVE_INFINITY
  const rb = b ?? Number.POSITIVE_INFINITY
  if (rb < ra) return 'better'
  if (rb > ra) return 'worse'
  return 'tie'
}

function change(a: boolean, b: boolean): Change {
  if (a === b) return null
  return b ? 'gain' : 'loss'
}

function staleChange(a: boolean, b: boolean): StaleChange {
  if (a === b) return null
  return b ? 'introduced' : 'fixed'
}

function compareQuery(a: QueryScore, b: QueryScore): ComparedQuery {
  return {
    id: a.id,
    class: a.class,
    rankA: a.firstGoldRank,
    rankB: b.firstGoldRank,
    outcome: rankOutcome(a.firstGoldRank, b.firstGoldRank),
    hitAt10: change(a.hitAt10, b.hitAt10),
    goldInPayload: change(a.goldInPayload, b.goldInPayload),
    staleBeforeCurrent: staleChange(a.staleBeforeCurrent, b.staleBeforeCurrent),
    charsDelta: b.chars - a.chars,
    tokensDelta: b.tokens - a.tokens,
  }
}

function count<T>(list: readonly T[], pick: (t: T) => boolean): number {
  return list.filter(pick).length
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length
}

export function compareTotals(queries: readonly ComparedQuery[]): CompareTotals {
  const wins = count(queries, (q) => q.outcome === 'better')
  const losses = count(queries, (q) => q.outcome === 'worse')
  const mrrA = mean(queries.map((q) => reciprocalRank(q.rankA)))
  const mrrB = mean(queries.map((q) => reciprocalRank(q.rankB)))
  return {
    queries: queries.length,
    wins,
    losses,
    ties: queries.length - wins - losses,
    signTestP: signTestP(wins, losses),
    mrrA,
    mrrB,
    mrrDelta: mrrB - mrrA,
    hitAt10Gains: count(queries, (q) => q.hitAt10 === 'gain'),
    hitAt10Losses: count(queries, (q) => q.hitAt10 === 'loss'),
    goldInPayloadGains: count(queries, (q) => q.goldInPayload === 'gain'),
    goldInPayloadLosses: count(queries, (q) => q.goldInPayload === 'loss'),
    staleFixed: count(queries, (q) => q.staleBeforeCurrent === 'fixed'),
    staleIntroduced: count(queries, (q) => q.staleBeforeCurrent === 'introduced'),
    charsDeltaMean: mean(queries.map((q) => q.charsDelta)),
    tokensDeltaMean: mean(queries.map((q) => q.tokensDelta)),
  }
}

// --- pairing --------------------------------------------------------------

function side(meta: RunMeta): CompareSide {
  return { label: meta.label, dist_git_sha: meta.dist_git_sha, gold_sha256: meta.gold_sha256, pins_sha256: meta.pins_sha256 }
}

/** A stable query's runs all score the same text; the first run stands for them. */
function representative(q: QueryResult): QueryScore {
  return q.runs[0]!.score
}

export function compareRuns(a: RunResult, b: RunResult): Comparison {
  const byIdB = new Map(b.queries.map((q) => [q.id, q]))
  const idsA = new Set(a.queries.map((q) => q.id))
  const paired: ComparedQuery[] = []
  const unstable: Comparison['unstable'] = []
  for (const qa of a.queries) {
    const qb = byIdB.get(qa.id)
    if (!qb) continue
    if (qa.query !== qb.query || qa.class !== qb.class || qa.project_id !== qb.project_id) {
      throw new Error(`gold id ${qa.id} has a different query, class or project in the two results; they ran different gold lines`)
    }
    if (!qa.stable || !qb.stable) {
      unstable.push({ id: qa.id, in: [...(qa.stable ? [] : ['A' as const]), ...(qb.stable ? [] : ['B' as const])] })
      continue
    }
    paired.push(compareQuery(representative(qa), representative(qb)))
  }
  const classes = new Map<GoldClass, ComparedQuery[]>()
  for (const q of paired) classes.set(q.class, [...(classes.get(q.class) ?? []), q])
  const byClass: Partial<Record<GoldClass, CompareTotals>> = {}
  for (const [cls, list] of classes) byClass[cls] = compareTotals(list)
  return {
    a: side(a.meta),
    b: side(b.meta),
    goldShaMatch: a.meta.gold_sha256 === b.meta.gold_sha256,
    queries: paired,
    totals: compareTotals(paired),
    byClass,
    unstable,
    onlyInA: a.queries.filter((q) => !byIdB.has(q.id)).map((q) => q.id),
    onlyInB: b.queries.filter((q) => !idsA.has(q.id)).map((q) => q.id),
  }
}

/** Checks a result file has the fields compare reads, with a message naming the file. */
export function parseRunResult(text: string, name: string): RunResult {
  const raw = JSON.parse(text) as Partial<RunResult>
  const ok =
    typeof raw === 'object' &&
    raw !== null &&
    typeof raw.meta?.label === 'string' &&
    Array.isArray(raw.queries) &&
    raw.queries.every((q) => typeof q?.id === 'string' && typeof q.stable === 'boolean' && q.runs?.[0]?.score !== undefined)
  if (!ok) throw new Error(`${name} is not an engram-recall-eval run result`)
  return raw as RunResult
}

// --- text output ----------------------------------------------------------

function totalsRow(scope: string, t: CompareTotals): string {
  const cells = [
    scope,
    t.queries,
    t.wins,
    t.losses,
    t.ties,
    t.signTestP.toFixed(4),
    t.mrrA.toFixed(4),
    t.mrrB.toFixed(4),
    (t.mrrDelta >= 0 ? '+' : '') + t.mrrDelta.toFixed(4),
    `+${t.hitAt10Gains} / -${t.hitAt10Losses}`,
    `+${t.goldInPayloadGains} / -${t.goldInPayloadLosses}`,
    `${t.staleFixed} / ${t.staleIntroduced}`,
    t.charsDeltaMean.toFixed(1),
    t.tokensDeltaMean.toFixed(1),
  ]
  return `| ${cells.join(' | ')} |`
}

function sideLine(name: string, s: CompareSide): string {
  return `${name}: ${s.label}  dist ${s.dist_git_sha ?? 'n/a'}  gold ${s.gold_sha256}  pins ${s.pins_sha256}`
}

export function formatComparison(c: Comparison): string {
  const rank = (r: number | null) => (r === null ? '-' : String(r))
  const mark = (v: string | null) => v ?? ''
  return [
    sideLine('A', c.a),
    sideLine('B', c.b),
    `gold sha256 match: ${c.goldShaMatch ? 'yes' : 'no'}`,
    `paired stable: ${c.totals.queries}  unstable: ${c.unstable.length}  only in A: ${c.onlyInA.length}  only in B: ${c.onlyInB.length}`,
    '',
    '| scope | queries | wins | losses | ties | sign p | MRR@30 A | MRR@30 B | MRR delta | hit@10 | gold in payload | stale fixed / introduced | chars delta mean | tokens delta mean |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    totalsRow('overall', c.totals),
    ...Object.entries(c.byClass).map(([cls, t]) => totalsRow(cls, t!)),
    '',
    '| id | class | rank A | rank B | outcome | hit@10 | gold in payload | stale before current | chars delta |',
    '|---|---|---|---|---|---|---|---|---|',
    ...c.queries.map(
      (q) =>
        `| ${q.id} | ${q.class} | ${rank(q.rankA)} | ${rank(q.rankB)} | ${q.outcome} | ${mark(q.hitAt10)} | ${mark(q.goldInPayload)} | ${mark(q.staleBeforeCurrent)} | ${q.charsDelta} |`,
    ),
    '',
    `unstable (excluded): ${c.unstable.map((u) => `${u.id} (${u.in.join(', ')})`).join(', ') || 'none'}`,
    `only in A: ${c.onlyInA.join(', ') || 'none'}`,
    `only in B: ${c.onlyInB.join(', ') || 'none'}`,
    '',
  ].join('\n')
}
