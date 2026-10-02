/**
 * Final-state probe: after a replay has written to an arm's copy, run a fixed
 * held-out query set against that copy with reconsolidation off and no
 * conversation key, so the probe reads the state the replay left without
 * changing it, and every arm answers the same queries the same way.
 *
 * Records use the layout the pairwise judges read: `<out>/<arm>/<label>.txt`
 * is the formatted payload and `<out>/<arm>/<label>.json` holds the query and
 * the top ranked memories with id, tier, rank and content.
 */

import type { ArmRecallOptions, ArmRecallResult } from './replay-stack.js'
import { ReplayStopped, assertArmName, parseFlagValues, parsePinsMode, type PinsMode } from './replay-lib.js'

export const PROBE_TOP_N = 10

export interface ProbeQuery {
  label: string
  q: string
  p: string | null
}

/** A JSON array of `{q, p}`; `p` (the project) may be absent, null or empty.
 *  Labels are `s<index>`, zero-padded to at least two digits. */
export function parseProbeQueries(text: string): ProbeQuery[] {
  const raw: unknown = JSON.parse(text)
  if (!Array.isArray(raw)) throw new Error('probe queries must be a JSON array of {q, p}')
  const width = Math.max(2, String(Math.max(raw.length - 1, 0)).length)
  return raw.map((item: unknown, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`probe query ${i} is not an object`)
    const rec = item as Record<string, unknown>
    const q = rec['q']
    if (typeof q !== 'string' || q.trim().length === 0) throw new Error(`probe query ${i} has no q`)
    const p = rec['p']
    if (p !== undefined && p !== null && typeof p !== 'string') throw new Error(`probe query ${i} has a non-string p`)
    return { label: `s${String(i).padStart(width, '0')}`, q, p: p ? p : null }
  })
}

/** `now` is the run's one reference date: every query and every arm of a
 *  probe expands against the same date, so a strict pins file serves them all. */
export function probeRecallOptions(query: ProbeQuery, now: Date): ArmRecallOptions {
  return { ...(query.p ? { projectId: query.p } : {}), reconsolidate: false, now }
}

export interface ProbeMemory {
  rank: number
  id: string
  type: string
  content: string
  relevance: number
  metadata: Record<string, unknown>
}

export interface ProbeRecord {
  label: string
  arm: string
  query: string
  projectId: string | null
  at: string
  wallMs: number
  chars: number
  memories: ProbeMemory[]
  associations: Array<{ id: string; type: string }>
  timings: Record<string, number> | null
  degraded: unknown
}

export function probeRecord(
  query: ProbeQuery,
  arm: string,
  result: ArmRecallResult,
  run: { at: string; wallMs: number },
): ProbeRecord {
  return {
    label: query.label,
    arm,
    query: query.q,
    projectId: query.p,
    at: run.at,
    wallMs: run.wallMs,
    chars: result.formatted.length,
    memories: result.memories.slice(0, PROBE_TOP_N).map((m, i) => ({
      rank: i + 1,
      id: m.id,
      type: m.type,
      content: m.content,
      relevance: m.relevance,
      metadata: m.metadata ?? {},
    })),
    associations: [...result.associations, ...(result.faintAssociations ?? [])].map((m) => ({ id: m.id, type: m.type })),
    timings: result.timings ?? null,
    degraded: result.degraded ?? null,
  }
}

export interface ProbeDeps {
  queries: readonly ProbeQuery[]
  arm: string
  recall(query: string, opts: ArmRecallOptions): Promise<ArmRecallResult>
  /** Wraps each recall: the arm's env is set for that call only. */
  aroundRecall<T>(fn: () => Promise<T>): Promise<T>
  /** Runs before every query; the CLI restores the per-conversation priming
   *  store here so a query's priming never lifts rows in the queries after it. */
  beforeQuery(): void
  violations(): string[]
  write(record: ProbeRecord, formatted: string): void
  clock?: () => number
  now?: () => Date
  /** The reference date every query recalls with. */
  referenceDate: Date
}

/** Runs every probe query once, in file order, each after `beforeQuery`; a
 *  violation stops the probe before that query's record is written. Returns
 *  the number of records. */
export async function runProbe(deps: ProbeDeps): Promise<number> {
  const clock = deps.clock ?? (() => performance.now())
  const now = deps.now ?? (() => new Date())
  let written = 0
  for (const [i, query] of deps.queries.entries()) {
    deps.beforeQuery()
    const t0 = clock()
    const result = await deps.aroundRecall(() => deps.recall(query.q.trim(), probeRecallOptions(query, deps.referenceDate)))
    const wallMs = Math.round(clock() - t0)
    const reasons = deps.violations()
    if (reasons.length > 0) throw new ReplayStopped(i, reasons)
    deps.write(probeRecord(query, deps.arm, result, { at: now().toISOString(), wallMs }), result.formatted)
    written++
  }
  return written
}

export interface ProbeArgs {
  queries: string
  target: string
  keyEnv: string
  engramDist: string
  arm: string
  env: Record<string, string>
  pins: string
  pinsMode: PinsMode
  out: string
  /** `--now`: the reference date for every query; the run's start when absent.
   *  Arms sharing a strict pins file pass the same value. */
  referenceDate?: Date
}

const PROBE_FLAGS = new Set([
  '--queries', '--target', '--key-env', '--engram-dist', '--arm', '--env', '--pins', '--pins-mode', '--out', '--now',
])

function parseReferenceDate(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined
  const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw) ? new Date(raw) : null
  if (date === null || Number.isNaN(date.getTime())) {
    throw new Error(`--now expects an ISO 8601 instant with a zone, such as 2026-10-02T09:00:00Z; got ${JSON.stringify(raw)}`)
  }
  return date
}

export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const { one, env } = parseFlagValues(argv, PROBE_FLAGS, [
    '--queries', '--target', '--key-env', '--engram-dist', '--arm', '--pins', '--out',
  ])
  assertArmName(one['--arm']!)
  return {
    queries: one['--queries']!,
    target: one['--target']!,
    keyEnv: one['--key-env']!,
    engramDist: one['--engram-dist']!,
    arm: one['--arm']!,
    env,
    pins: one['--pins']!,
    pinsMode: parsePinsMode(one['--pins-mode']),
    out: one['--out']!,
    ...(one['--now'] !== undefined ? { referenceDate: parseReferenceDate(one['--now'])! } : {}),
  }
}
