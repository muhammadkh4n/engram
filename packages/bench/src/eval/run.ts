/**
 * `engram-recall-eval run`: every gold query is recalled once per run, on the
 * eval stack, and scored against its gold line. Two runs of the same build,
 * gold set and pins must give byte-identical `formatted` text; a query whose
 * text differs between runs is marked unstable and every run's metrics are
 * kept, so a comparison can leave it out instead of reading noise as a change.
 *
 * The meta block identifies what was measured (build sha, model ids, gold and
 * pins sha256, guard counters) and never carries a credential: only env names
 * that identify a model are copied, and any name that looks like a secret is
 * dropped even then.
 */
import { execFileSync } from 'node:child_process'
import { parsePinsMode, type PinsMode } from '../replay/replay-lib.js'
import { parseReferenceDate } from '../replay/probe-lib.js'
import { assertRecallNotDegraded, DegradedRecallError } from '../refuse-degraded.js'
import { GraphCheckError, type EvalRecall } from './eval-stack.js'
import type { GoldClass, GoldEntry } from './gold.js'
import { PinMissError, PinsViolationError, type PinStats } from './pins.js'
import { aggregateScores, scoreQuery, type QueryScore, type ScoreAggregate, type ScoreAggregates } from './score.js'
import { BlockedWriteError, blockedCallCount, type GuardStats } from './write-guards.js'

// --- arguments ------------------------------------------------------------

export interface RunArgs {
  gold: string
  dist: string
  envFile: string
  pins: string
  pinsMode: PinsMode
  runs: number
  calibrationQuery: string
  label: string
  out: string
  /** `--now`: the reference date of every recall; the run's start when absent.
   *  Runs that share a strict pins file pass the same value, since expansion pins are keyed by it. */
  referenceDate?: Date
}

export const DEFAULT_RUNS = 3

const RUN_FLAGS: ReadonlySet<string> = new Set([
  '--gold', '--dist', '--env', '--pins', '--pins-mode', '--runs', '--calibration-query', '--label', '--out', '--now',
])
const REQUIRED_RUN_FLAGS = ['--gold', '--dist', '--env', '--pins', '--calibration-query', '--label', '--out'] as const

/** `--flag value` pairs, each flag at most once. `--env` names a file here, not a K=V switch. */
export function parseFlags(argv: readonly string[], flags: ReadonlySet<string>): Record<string, string> {
  const one: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (!flags.has(flag)) throw new Error(`unknown flag ${flag}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    if (flag in one) throw new Error(`${flag} given twice`)
    one[flag] = value
  }
  return one
}

function parseRuns(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUNS
  const runs = /^\d+$/.test(raw) ? Number(raw) : NaN
  // One run cannot tell a stable query from an unstable one.
  if (!Number.isSafeInteger(runs) || runs < 2) throw new Error(`--runs must be an integer of at least 2; got ${JSON.stringify(raw)}`)
  return runs
}

export function assertLabel(label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('--label may hold only letters, digits, ".", "_" and "-"')
}

export function parseRunArgs(argv: readonly string[]): RunArgs {
  const one = parseFlags(argv, RUN_FLAGS)
  for (const flag of REQUIRED_RUN_FLAGS) {
    if (!one[flag]) throw new Error(`${flag} is required`)
  }
  assertLabel(one['--label']!)
  const referenceDate = parseReferenceDate(one['--now'])
  return {
    gold: one['--gold']!,
    dist: one['--dist']!,
    envFile: one['--env']!,
    pins: one['--pins']!,
    pinsMode: parsePinsMode(one['--pins-mode']),
    runs: parseRuns(one['--runs']),
    calibrationQuery: one['--calibration-query']!,
    label: one['--label']!,
    out: one['--out']!,
    ...(referenceDate ? { referenceDate } : {}),
  }
}

// --- running the gold set -------------------------------------------------

export interface QueryRun {
  score: QueryScore
  estimatedTokens: number
  timings: Record<string, number> | null
}

export interface QueryResult {
  id: string
  class: GoldClass
  query: string
  project_id: string | null
  /** Every run returned the same `formatted` text. */
  stable: boolean
  runs: QueryRun[]
  /** The formatted text by its sha256, one entry per distinct output. */
  formatted: Record<string, string>
}

export interface RunBody {
  queries: QueryResult[]
  /** Aggregates per run, in run order. */
  aggregates: ScoreAggregates[]
  unstable: string[]
}

/** The memory_recall arguments a gold line stands for. */
export function goldRecallArgs(entry: GoldEntry): Record<string, unknown> {
  return entry.project_id ? { project_id: entry.project_id } : {}
}

function scorable(recall: EvalRecall) {
  return {
    formatted: recall.formatted,
    payload: {
      items: recall.items.map((it) => ({
        section: it.section,
        ...(it.id !== null ? { id: it.id } : {}),
        start: it.start,
        end: it.end,
      })),
    },
  }
}

/**
 * A recall in which one retrieval leg failed while the others answered. The
 * engine records the failure as a `<leg>Error` timing flag and still returns a
 * full-looking result, so scoring it would credit the whole pipeline with what
 * the surviving legs found.
 */
export class FailedLegError extends Error {
  constructor(readonly question: string, readonly legs: readonly string[]) {
    super(`recall for question "${question}" ran with a failed ${legs.join(' and ')} leg; refusing to score it`)
    this.name = 'FailedLegError'
  }
}

const LEG_ERROR_FLAG = /^([A-Za-z]+)Error$/

/** The legs the engine flagged as failed in a recall's timings, sorted. */
export function failedLegs(timings: Readonly<Record<string, number>> | null): string[] {
  if (timings === null) return []
  return Object.entries(timings)
    .flatMap(([key, value]) => {
      const leg = LEG_ERROR_FLAG.exec(key)?.[1]
      return leg !== undefined && value > 0 ? [leg] : []
    })
    .sort()
}

export function assertNoFailedLeg(recall: Pick<EvalRecall, 'timings'>, question: string): void {
  const legs = failedLegs(recall.timings)
  if (legs.length > 0) throw new FailedLegError(question, legs)
}

/** Checks that stop a run with exit 4: what they caught makes the run's numbers describe a different recall. */
const RUN_STOPS = [BlockedWriteError, PinsViolationError, PinMissError, GraphCheckError, DegradedRecallError, FailedLegError]

export function isRunStop(err: unknown): boolean {
  return RUN_STOPS.some((cls) => err instanceof cls)
}

/**
 * Recalls every gold query once per run, in gold order, and scores each
 * recall. A degraded recall (no query vector) or one with a failed retrieval
 * leg stops the run: its numbers would describe the surviving legs alone.
 */
export async function runGold(deps: {
  gold: readonly GoldEntry[]
  runs: number
  recall: (entry: GoldEntry) => Promise<EvalRecall>
  onRecall?: (run: number, index: number) => void
}): Promise<RunBody> {
  const perQuery = deps.gold.map(() => ({ runs: [] as QueryRun[], formatted: {} as Record<string, string> }))
  const aggregates: ScoreAggregates[] = []
  for (let run = 0; run < deps.runs; run++) {
    const scores: QueryScore[] = []
    for (const [index, entry] of deps.gold.entries()) {
      const recall = await deps.recall(entry)
      if (recall.degraded) assertRecallNotDegraded({ degraded: recall.degraded }, entry.id)
      assertNoFailedLeg(recall, entry.id)
      const score = scoreQuery(entry, scorable(recall))
      const slot = perQuery[index]!
      slot.runs.push({ score, estimatedTokens: recall.estimatedTokens, timings: recall.timings })
      slot.formatted[score.formattedSha] = recall.formatted
      scores.push(score)
      deps.onRecall?.(run, index)
    }
    aggregates.push(aggregateScores(scores))
  }
  const queries = deps.gold.map((entry, index): QueryResult => {
    const slot = perQuery[index]!
    return {
      id: entry.id,
      class: entry.class,
      query: entry.query,
      project_id: entry.project_id ?? null,
      stable: Object.keys(slot.formatted).length === 1,
      runs: slot.runs,
      formatted: slot.formatted,
    }
  })
  return { queries, aggregates, unstable: queries.filter((q) => !q.stable).map((q) => q.id) }
}

// --- meta -----------------------------------------------------------------

/** Env names that may hold a credential; their values never enter a result. */
export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD/i

/** Env names that identify a model or which reranker runs. */
const MODEL_NAME = /MODEL/i
const MODEL_SWITCHES: ReadonlySet<string> = new Set(['ENGRAM_RERANK_LOCAL'])

/** The model ids the env file selects, sorted by name; secret-looking names are dropped. */
export function envModelIds(vars: Readonly<Record<string, string>>): Record<string, string> {
  const picked = Object.entries(vars)
    .filter(([name]) => (MODEL_NAME.test(name) || MODEL_SWITCHES.has(name)) && !SECRET_NAME.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(picked)
}

/** HEAD of the build's checkout, or null when the dist is not a git checkout. */
export function distGitSha(dist: string): string | null {
  try {
    return execFileSync('git', ['-C', dist, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export interface RunMeta {
  label: string
  started: string
  finished: string
  reference_date: string
  dist: string
  dist_git_sha: string | null
  env_file: string
  model_ids: Record<string, string>
  gold_file: string
  gold_sha256: string
  queries: number
  runs: number
  pins_file: string
  pins_mode: PinsMode
  pins_sha256_at_start: string
  pins_sha256: string
  pin_stats: { hits: number; fills: number; misses: number; blocked: Record<string, number>; fetch_blocked: Record<string, number> }
  guards: GuardStats
  blocked_calls: number
  calibration_query: string
  graph: boolean
  unstable: number
  recall_options: string
  sensory: string
}

export function buildRunMeta(input: {
  args: RunArgs
  envVars: Readonly<Record<string, string>>
  distSha: string | null
  goldSha: string
  pinsShaAtStart: string
  pinsSha: string
  pinStats: PinStats
  guards: GuardStats
  graph: boolean
  started: Date
  finished: Date
  referenceDate: Date
  body: RunBody
}): RunMeta {
  const { args, pinStats } = input
  return {
    label: args.label,
    started: input.started.toISOString(),
    finished: input.finished.toISOString(),
    reference_date: input.referenceDate.toISOString(),
    dist: args.dist,
    dist_git_sha: input.distSha,
    env_file: args.envFile,
    model_ids: envModelIds(input.envVars),
    gold_file: args.gold,
    gold_sha256: input.goldSha,
    queries: input.body.queries.length,
    runs: input.body.aggregates.length,
    pins_file: args.pins,
    pins_mode: args.pinsMode,
    pins_sha256_at_start: input.pinsShaAtStart,
    pins_sha256: input.pinsSha,
    pin_stats: {
      hits: pinStats.hits,
      fills: pinStats.fills,
      misses: pinStats.misses.length,
      blocked: { ...pinStats.blocked },
      fetch_blocked: { ...pinStats.fetchBlocked },
    },
    guards: input.guards,
    blocked_calls: blockedCallCount(input.guards),
    calibration_query: args.calibrationQuery,
    graph: input.graph,
    unstable: input.body.unstable.length,
    recall_options: 'memory_recall options from the gold project_id, plus reconsolidate: false and now = reference_date',
    sensory: 'reset before each query',
  }
}

export interface RunResult extends RunBody {
  meta: RunMeta
}

// --- markdown summary -----------------------------------------------------

function pct(n: number | null): string {
  return n === null ? 'n/a' : (n * 100).toFixed(1)
}

function aggregateRow(scope: string, a: ScoreAggregate): string {
  const stale = a.staleBeforeCurrent === null ? 'n/a' : `${pct(a.staleBeforeCurrent)} (${a.staleLabelled})`
  const chars = `${a.payloadChars.p50} / ${a.payloadChars.p90} / ${a.payloadChars.max}`
  return `| ${scope} | ${a.queries} | ${a.mrr30.toFixed(4)} | ${pct(a.hitAt5)} | ${pct(a.hitAt10)} | ${pct(a.hitAt30)} | ${pct(a.goldInPayload)} | ${stale} | ${chars} |`
}

const AGGREGATE_HEADER = [
  '| scope | queries | MRR@30 | hit@5 % | hit@10 % | hit@30 % | gold in payload % | stale before current % (labelled) | chars p50 / p90 / max |',
  '|---|---|---|---|---|---|---|---|---|',
]

export function formatRunSummary(result: RunResult): string {
  const m = result.meta
  const first = result.aggregates[0]!
  const lines = [
    `# Recall eval: ${m.label}`,
    '',
    '| field | value |',
    '|---|---|',
    `| dist | ${m.dist} @ ${m.dist_git_sha ?? 'not a git checkout'} |`,
    `| gold sha256 | ${m.gold_sha256} (${m.queries} queries) |`,
    `| pins sha256 | ${m.pins_sha256} (${m.pins_mode}; ${m.pin_stats.hits} hits, ${m.pin_stats.fills} fills) |`,
    `| runs | ${m.runs} |`,
    `| reference date | ${m.reference_date} |`,
    `| graph | ${m.graph ? 'Neo4j wired' : 'none'} |`,
    `| blocked calls | ${m.blocked_calls} |`,
    ...Object.entries(m.model_ids).map(([name, value]) => `| ${name} | ${value} |`),
    '',
    '## Run 1',
    '',
    ...AGGREGATE_HEADER,
    aggregateRow('overall', first.overall),
    ...Object.entries(first.byClass).map(([cls, a]) => aggregateRow(cls, a!)),
    '',
    '## Overall per run',
    '',
    ...AGGREGATE_HEADER,
    ...result.aggregates.map((a, i) => aggregateRow(`run ${i + 1}`, a.overall)),
    '',
    '## Repeatability',
    '',
    `${result.unstable.length} of ${m.queries} queries returned different text between runs.`,
    ...result.unstable.map((id) => `- ${id}`),
    '',
  ]
  return lines.join('\n')
}
