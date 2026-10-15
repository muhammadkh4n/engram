#!/usr/bin/env node
/**
 * engram-recall-calibrate: measures the recall floor of the reranker in use.
 *
 *   engram-recall-calibrate [--replay <cases.jsonl> --channels <profile.json>]
 *     [--calibration-before <iso>] [--split calibration|check|all]
 *     [--gold <gold.jsonl>] --report <report.json>
 *
 * Each request is scored as recall would score it, with no floor: model steps,
 * one candidate call, fusion, the rerank of the first 50. A slate item is
 * needed when the case or gold row names it. Then, by the rule fixed before
 * any measurement:
 *   n = the needed items that reached a slate;
 *   F = the largest grid value (0.000, 0.005, …, 0.995) at which at most
 *       max(1, ⌊0.01·n⌋) needed items score below F;
 *   S = the median needed score rounded down to the grid, or F when lower.
 * It prints n, F, S and a ready floor entry, and writes a report of ids and
 * scores only, never text. It runs only against a database on this machine
 * (SUPABASE_URL on 127.0.0.1 or localhost): the measurement reads a copy.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { DEFAULT_RECALL_CLASSES, scoreSlate } from '@engram-mem/core'
import type { FloorCalibration, ItemClass, RecallChannel, RecallRequest, RecallScope, SlateDeps } from '@engram-mem/core'
import { PostgRestRecallStore } from '@engram-mem/postgrest'
import { exitWhenFlushed } from './cli-exit.js'
import { isEntryPoint } from './ingest/entry-point.js'

export const DEFAULT_CALIBRATION_BEFORE = '2026-09-29T19:00:00Z'
const QUERY_CHANNELS: ReadonlySet<string> = new Set(['prompt', 'agent_dispatch', 'executor_start', 'hand_recall'])
const GRID_STEPS = 200
const SPLITS = ['calibration', 'check', 'all'] as const
type Split = (typeof SPLITS)[number]

export interface CalibrateArgs {
  replay?: string
  channels?: string
  calibrationBefore: string
  split: Split
  gold?: string
  report: string
}

export function parseCalibrateArgs(argv: readonly string[]): CalibrateArgs | { error: string } {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!
    const value = argv[i + 1]
    if (!['--replay', '--channels', '--calibration-before', '--split', '--gold', '--report'].includes(key)) {
      return { error: `unexpected argument: ${key}` }
    }
    if (value === undefined || value.startsWith('--')) return { error: `${key} needs a value` }
    if (values.has(key)) return { error: `${key} given twice` }
    values.set(key, value)
  }
  const split = (values.get('--split') ?? 'calibration') as Split
  if (!SPLITS.includes(split)) return { error: '--split must be calibration, check or all' }
  const calibrationBefore = values.get('--calibration-before') ?? DEFAULT_CALIBRATION_BEFORE
  if (Number.isNaN(Date.parse(calibrationBefore))) return { error: '--calibration-before is not a time' }
  const report = values.get('--report')
  if (report === undefined) return { error: 'name the --report file' }
  const replay = values.get('--replay')
  const channels = values.get('--channels')
  if ((replay === undefined) !== (channels === undefined)) return { error: '--replay and --channels go together' }
  const gold = values.get('--gold')
  if (replay === undefined && gold === undefined) return { error: 'name --replay or --gold, or both' }
  return { calibrationBefore, split, report, ...(replay ? { replay } : {}), ...(channels ? { channels } : {}), ...(gold ? { gold } : {}) }
}

/** The measurement reads a database copy on this machine, never prod. */
export function checkLocalUrl(url: string | undefined): string | null {
  if (!url) return 'SUPABASE_URL is not set'
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return 'SUPABASE_URL is not a URL'
  }
  return host === '127.0.0.1' || host === 'localhost' ? null : `SUPABASE_URL must point at 127.0.0.1 or localhost, not ${host}`
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** A group matches when every one of its phrases is in the text; an empty group matches nothing. */
export function matchesGroup(text: string, groups: readonly (readonly string[])[]): boolean {
  const normalized = normalizeText(text)
  return groups.some((g) => g.length > 0 && g.every((p) => normalized.includes(normalizeText(p))))
}

interface Profile {
  classes?: string[]
  limit?: number
  max_chars?: number
  budget_chars?: number
  include_history?: boolean
  exclude_live_session?: boolean
}

interface NeededEntry {
  itemIds: string[]
  legacyIds: string[]
  phrases: string[][]
}

/** One request to score, with what in its slate counts as needed or as stale. */
export interface CalibrationRequest {
  source: 'replay' | 'gold'
  id: string
  request: RecallRequest
  needed: NeededEntry[]
  staleLegacyIds: string[]
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} is not an object`)
  return value as Record<string, unknown>
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Error(`${where} must be a list of strings`)
  return value as string[]
}

function jsonLines(text: string, file: string): Array<{ line: number; value: Record<string, unknown> }> {
  const out: Array<{ line: number; value: Record<string, unknown> }> = []
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`${file}:${i + 1} is not JSON`)
    }
    out.push({ line: i + 1, value: asRecord(parsed, `${file}:${i + 1}`) })
  })
  return out
}

export function caseSplit(decidedAt: string, before: string): 'calibration' | 'check' {
  return Date.parse(decidedAt) < Date.parse(before) ? 'calibration' : 'check'
}

/**
 * The replay requests of the reviewed query-lane cases in the split: the
 * case's query, its own channel, the channel profile's fields, its scope (no
 * project at a root; plan slugs from its plan dirs), as of its decision time,
 * and its own session excluded when the profile says so. Needed: the entries
 * expected in the query lane.
 */
export function replayRequests(casesText: string, profilesText: string, args: Pick<CalibrateArgs, 'split' | 'calibrationBefore'>): CalibrationRequest[] {
  const profiles = asRecord(JSON.parse(profilesText), 'the channel profile') as Record<string, Profile>
  const out: CalibrationRequest[] = []
  for (const { line, value: c } of jsonLines(casesText, 'cases')) {
    const where = `case line ${line}`
    if (c.status !== 'reviewed' || typeof c.channel !== 'string' || !QUERY_CHANNELS.has(c.channel)) continue
    if (typeof c.query_text !== 'string' || typeof c.decided_at !== 'string') continue
    if (args.split !== 'all' && caseSplit(c.decided_at, args.calibrationBefore) !== args.split) continue
    const profile = profiles[c.channel] ?? {}
    const scope: RecallScope = {}
    if (c.at_root === true) scope.atRoot = true
    else if (typeof c.project_id === 'string') scope.projectId = c.project_id
    if (typeof c.workspace_id === 'string') scope.workspaceId = c.workspace_id
    const planDirs = c.plan_dirs === undefined ? [] : strings(c.plan_dirs, `${where} plan_dirs`)
    if (planDirs.length > 0) scope.planSlugs = planDirs.map((d) => basename(d.replace(/\/+$/, '')))
    const request: RecallRequest = {
      query: c.query_text.trim(),
      channel: c.channel as RecallChannel,
      scope,
      asOf: new Date(c.decided_at),
      ...(profile.classes ? { classes: profile.classes as ItemClass[] } : {}),
      ...(profile.limit !== undefined ? { limit: profile.limit } : {}),
      ...(profile.max_chars !== undefined ? { maxChars: profile.max_chars } : {}),
      ...(profile.budget_chars !== undefined ? { budgetChars: profile.budget_chars } : {}),
      ...(profile.include_history !== undefined ? { includeHistory: profile.include_history } : {}),
      ...(profile.exclude_live_session === true && typeof c.session_id === 'string' ? { excludeSessionId: c.session_id } : {}),
    }
    const needed = (Array.isArray(c.needed) ? c.needed : [])
      .map((n, i) => asRecord(n, `${where} needed ${i + 1}`))
      .filter((n) => n.expected_lane === 'query')
      .map((n, i) => ({
        itemIds: strings(n.item_ids ?? [], `${where} needed ${i + 1} item_ids`),
        legacyIds: strings(n.legacy_ids ?? [], `${where} needed ${i + 1} legacy_ids`),
        phrases: (Array.isArray(n.phrases) ? n.phrases : []).map((g, j) => strings(g, `${where} needed ${i + 1} phrases ${j + 1}`)),
      }))
    out.push({ source: 'replay', id: String(c.id), request, needed, staleLegacyIds: [] })
  }
  return out
}

/** The gold requests: the calibration channel, the default classes plus legacy, the row's project. */
export function goldRequests(goldText: string): CalibrationRequest[] {
  return jsonLines(goldText, 'gold').map(({ line, value: g }) => {
    if (typeof g.query !== 'string') throw new Error(`gold line ${line} has no query`)
    return {
      source: 'gold',
      id: String(g.id),
      request: {
        query: g.query.trim(),
        channel: 'calibration',
        scope: typeof g.project_id === 'string' ? { projectId: g.project_id } : {},
        classes: [...DEFAULT_RECALL_CLASSES, 'legacy'],
      },
      needed: [{ itemIds: [], legacyIds: strings(g.gold_ids ?? [], `gold line ${line} gold_ids`), phrases: [] }],
      staleLegacyIds: strings(g.stale_ids ?? [], `gold line ${line} stale_ids`),
    }
  })
}

export interface FloorResult {
  n: number
  floor: number
  strong: number
  neededBelowFloor: number
}

const toGrid = (k: number) => Math.round((k / GRID_STEPS) * 1000) / 1000

/** The pre-registered rule over the needed items' scores. */
export function floorFromScores(scores: readonly number[]): FloorResult {
  const n = scores.length
  if (n === 0) throw new Error('no needed item reached a slate: nothing to measure')
  const allowed = Math.max(1, Math.floor(0.01 * n))
  let k = 0
  for (let step = GRID_STEPS - 1; step >= 0; step -= 1) {
    if (scores.filter((s) => s < step / GRID_STEPS).length <= allowed) {
      k = step
      break
    }
  }
  const sorted = [...scores].sort((a, b) => a - b)
  const mid = Math.floor(n / 2)
  const median = n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  const medianStep = Math.max(0, Math.min(GRID_STEPS - 1, Math.floor(median * GRID_STEPS + 1e-9)))
  const floor = toGrid(k)
  return { n, floor, strong: toGrid(Math.max(medianStep, k)), neededBelowFloor: scores.filter((s) => s < floor).length }
}

export interface CalibrateIo {
  readText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  deps(): Promise<SlateDeps & { rerankerId: string }>
  /** Legacy item ids by old-table row id. */
  legacyItems(ids: readonly string[]): Promise<Map<string, string>>
  now(): Date
  out(text: string): void
}

export async function runCalibration(args: CalibrateArgs, io: CalibrateIo): Promise<FloorResult> {
  const requests = [
    ...(args.replay && args.channels ? replayRequests(await io.readText(args.replay), await io.readText(args.channels), args) : []),
    ...(args.gold ? goldRequests(await io.readText(args.gold)) : []),
  ]
  const legacy = await io.legacyItems([...new Set(requests.flatMap((r) => [...r.needed.flatMap((n) => n.legacyIds), ...r.staleLegacyIds]))])
  const deps = await io.deps()
  const neededScores: number[] = []
  const reportRequests: unknown[] = []
  for (const r of requests) {
    const { items } = await scoreSlate(deps, r.request)
    const stale = new Set(r.staleLegacyIds.flatMap((id) => (legacy.has(id) ? [legacy.get(id)!] : [])))
    const slate = items.map((s) => {
      const isNeeded = r.needed.some(
        (n) =>
          n.itemIds.includes(s.row.id) ||
          n.legacyIds.some((l) => legacy.get(l) === s.row.id) ||
          matchesGroup(s.row.contentHead, n.phrases),
      )
      const isStale = !isNeeded && stale.has(s.row.id)
      if (isNeeded) neededScores.push(s.score)
      return { id: s.row.id, class: s.row.class, trust: s.row.trust, score: s.score, needed: isNeeded, stale: isStale }
    })
    reportRequests.push({ source: r.source, id: r.id, slate })
  }
  const result = floorFromScores(neededScores)
  const entry: FloorCalibration = {
    reranker: deps.rerankerId,
    floor: result.floor,
    strong: result.strong,
    calibratedAt: io.now().toISOString(),
    dataset: [args.replay ? `replay:${args.split}` : null, args.gold ? `gold:${basename(args.gold)}` : null].filter(Boolean).join('+'),
    neededInSlate: result.n,
    neededBelowFloor: result.neededBelowFloor,
  }
  await io.writeText(
    args.report,
    `${JSON.stringify({ reranker: deps.rerankerId, split: args.split, calibration_before: args.calibrationBefore, ...result, requests: reportRequests }, null, 2)}\n`,
  )
  io.out(`n=${result.n} F=${result.floor.toFixed(3)} S=${result.strong.toFixed(3)}\n${JSON.stringify(entry, null, 2)}\n`)
  return result
}

if (isEntryPoint(import.meta.url)) {
  void (async () => {
    const args = parseCalibrateArgs(process.argv.slice(2))
    if ('error' in args) {
      process.stderr.write(`engram-recall-calibrate: ${args.error}\n`)
      return exitWhenFlushed(2)
    }
    const urlError = checkLocalUrl(process.env['SUPABASE_URL'])
    if (urlError !== null) {
      process.stderr.write(`engram-recall-calibrate: ${urlError}\n`)
      return exitWhenFlushed(2)
    }
    // Imported here, past the URL guard: building the deps reaches the database.
    const { getRecallDeps } = await import('./server-core.js')
    const store = new PostgRestRecallStore({ url: process.env['SUPABASE_URL']!, key: process.env['SUPABASE_KEY'] ?? '' })
    try {
      await runCalibration(args, {
        readText: (p) => readFile(p, 'utf8'),
        writeText: (p, t) => writeFile(p, t, { mode: 0o600 }),
        deps: async () => {
          const deps = await getRecallDeps()
          return { ...deps, rerankerId: deps.rerank.id }
        },
        legacyItems: async (ids) => new Map((await store.itemsByLegacyIds(ids)).map((r) => [r.legacyId, r.itemId])),
        now: () => new Date(),
        out: (t) => process.stdout.write(t),
      })
      return exitWhenFlushed(0)
    } catch (err) {
      process.stderr.write(`engram-recall-calibrate: ${err instanceof Error ? err.message : String(err)}\n`)
      return exitWhenFlushed(1)
    }
  })()
}
