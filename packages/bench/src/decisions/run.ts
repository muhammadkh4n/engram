/**
 * One replay run: every reviewed case through one arm's lanes, scored, once
 * per pass, with the meta that identifies what was measured. A case whose
 * lanes give a different sha256 between passes is marked unstable; under
 * strict pins the old arm must reproduce itself, so there it stops the run.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { sha256 } from '../replay/replay-lib.js'
import type { ProjectRegistry } from './as-of.js'
import type { DecisionCase } from './cases.js'
import type { Arm, ArmDeps, CaseLanes, ScopeRoots } from './lanes.js'
import { aggregateCases, scoreCase, withRunShas, type CaseScore, type RunAggregates } from './score.js'

const PLAN_DECISIONS_FILE = 'ledger.json'

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A case whose old-arm lanes changed between passes under strict pins: the instrument is not reproducing the old system. */
export class UnstableStrictRunError extends Error {
  constructor(readonly caseIds: readonly string[]) {
    super(`under strict pins the old arm gave different lanes between passes for ${caseIds.length} case(s): ${caseIds.join(', ')}`)
    this.name = 'UnstableStrictRunError'
  }
}

export class RegistryFormatError extends Error {
  constructor(message: string) {
    super(`project registry: ${message}`)
    this.name = 'RegistryFormatError'
  }
}

function nullableString(raw: Json, key: string, where: string): string | null {
  const value = raw[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new RegistryFormatError(`${where}.${key} must be a string or null`)
  return value
}

/** `{version: 1, workspaces: {<id>: {root, vault_folder, register_prefix}}, projects: {<repo>: {workspace, vault_folder, register_prefix}}}`. */
export function parseProjectRegistry(text: string): ProjectRegistry {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RegistryFormatError('not valid JSON')
  }
  if (!isObject(raw) || raw['version'] !== 1) throw new RegistryFormatError('expected an object with version 1')
  const workspacesRaw = raw['workspaces'] ?? {}
  const projectsRaw = raw['projects'] ?? {}
  if (!isObject(workspacesRaw) || !isObject(projectsRaw)) throw new RegistryFormatError('workspaces and projects must be objects')
  const workspaces: ProjectRegistry['workspaces'] = {}
  for (const [id, w] of Object.entries(workspacesRaw)) {
    if (!isObject(w) || typeof w['root'] !== 'string') throw new RegistryFormatError(`workspace ${id} needs a root`)
    workspaces[id] = { root: w['root'], vault_folder: nullableString(w, 'vault_folder', id), register_prefix: nullableString(w, 'register_prefix', id) }
  }
  const projects: ProjectRegistry['projects'] = {}
  for (const [id, p] of Object.entries(projectsRaw)) {
    if (!isObject(p)) throw new RegistryFormatError(`project ${id} is not an object`)
    projects[id] = {
      workspace: nullableString(p, 'workspace', id),
      vault_folder: nullableString(p, 'vault_folder', id),
      register_prefix: nullableString(p, 'register_prefix', id),
    }
  }
  return { version: 1, workspaces, projects }
}

/** HEAD of a checkout, or null when it is not one. */
export function gitHead(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export interface DecisionRunMeta {
  arm: Arm
  label: string
  started: string
  finished: string
  case_file: string
  case_file_sha256: string
  cases: number
  dropped: number
  runs: number
  calibration_before: string
  /** The recall URL's origin (new arm) or the snapshot's label (old arm). */
  store: string
  snapshot_dumped_at: string | null
  dist: string | null
  dist_git_sha: string | null
  dotfiles: string
  dotfiles_git_sha: string | null
  registry_sha256: string
  /** sha256 of each register file read, by path: register files carry no history, so this pins what was read. */
  register_sha256: Record<string, string>
  plan_ledger_sha256: Record<string, string>
  pins_file: string | null
  pins_mode: string | null
  pins_sha256: string | null
  channel_profiles_sha256: string | null
  calibration_query: string | null
  /** The old arm's ENGRAM_* settings; a secret-shaped name is listed with null. */
  engram_env: Record<string, string | null> | null
  guards: unknown
  pin_stats: unknown
  unstable: number
}

export interface DecisionRunResult {
  meta: DecisionRunMeta
  cases: CaseScore[]
  aggregates: RunAggregates
}

export interface ReplayPasses {
  cases: readonly DecisionCase[]
  passes: number
  roots: ScopeRoots
  deps: ArmDeps
  calibrationBefore: string
  snapshotDumpedAt: string | null
  replay: (c: DecisionCase, roots: ScopeRoots, deps: ArmDeps) => Promise<CaseLanes>
  onCase?: (pass: number, index: number) => void
}

export interface ReplayedCases {
  scores: CaseScore[]
  registerFiles: string[]
}

/** Replays every case once per pass; scores come from the first pass, sha256s from all. */
export async function replayPasses(input: ReplayPasses): Promise<ReplayedCases> {
  const first: CaseScore[] = []
  const shas: string[][] = input.cases.map(() => [])
  const registerFiles = new Set<string>()
  for (let pass = 0; pass < input.passes; pass++) {
    for (const [index, c] of input.cases.entries()) {
      const lanes = await input.replay(c, input.roots, input.deps)
      for (const r of lanes.scope.registers) registerFiles.add(r.file)
      const score = scoreCase(c, lanes, { calibrationBefore: input.calibrationBefore, snapshotDumpedAt: input.snapshotDumpedAt })
      if (pass === 0) first.push(score)
      shas[index]!.push(score.sha256)
      input.onCase?.(pass, index)
    }
  }
  return { scores: first.map((s, i) => withRunShas(s, shas[i]!)), registerFiles: [...registerFiles].sort() }
}

export function fileSha256s(files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.filter((f) => fs.existsSync(f)).map((f) => [f, sha256(fs.readFileSync(f, 'utf8'))]))
}

export function planLedgerFiles(cases: readonly DecisionCase[]): string[] {
  return [...new Set(cases.flatMap((c) => c.plan_dirs.map((d) => path.join(d, PLAN_DECISIONS_FILE))))].sort()
}

export function buildResult(meta: Omit<DecisionRunMeta, 'unstable'>, scores: CaseScore[]): DecisionRunResult {
  return { meta: { ...meta, unstable: scores.filter((s) => s.unstable).length }, cases: scores, aggregates: aggregateCases(scores) }
}

/** A run result read back for `report`; only the fields the report and the bars read are checked. */
export function parseRunResult(text: string, file: string): DecisionRunResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  if (!isObject(raw) || !isObject(raw['meta']) || !Array.isArray(raw['cases']) || !isObject(raw['aggregates'])) {
    throw new Error(`${file} is not a decision replay result`)
  }
  const meta = raw['meta']
  if ((meta['arm'] !== 'new' && meta['arm'] !== 'old') || typeof meta['case_file_sha256'] !== 'string' || typeof meta['runs'] !== 'number') {
    throw new Error(`${file} has no arm, case-file sha256 or run count in its meta`)
  }
  return raw as unknown as DecisionRunResult
}

// ── Report ───────────────────────────────────────────────────────────────

function laneLine(g: RunAggregates['overall']): string {
  const lanes = Object.entries(g.by_expected_lane)
    .filter(([, n]) => n.expected > 0)
    .map(([lane, n]) => `${lane} ${n.delivered}/${n.expected}`)
  return `${lanes.length > 0 ? lanes.join(' · ') : 'no needed memories'}; harmful as current ${g.harmful_as_current}; harmful in rule files ${g.harmful_in_rule_files}`
}

function payloadLine(g: RunAggregates['overall']): string {
  return Object.entries(g.payload_chars)
    .map(([key, s]) => `${key} ${s === null ? 'n/a' : `${s.p50}/${s.p90}/${s.max}`}`)
    .join(' · ')
}

/** Counts and case ids of one run; no item text is ever printed. */
export function formatRunReport(result: DecisionRunResult): string[] {
  const { meta, aggregates } = result
  const lines = [
    `${meta.label} (${meta.arm} arm, store ${meta.store}): cases ${meta.cases}, runs ${meta.runs}, unstable ${meta.unstable}, future items ${aggregates.overall.future_items}`,
    `  overall, delivered/expected by expected lane: ${laneLine(aggregates.overall)}`,
  ]
  for (const [name, groups] of [['split', aggregates.by_split], ['source', aggregates.by_source], ['channel', aggregates.by_channel]] as const) {
    for (const [key, g] of Object.entries(groups)) lines.push(`  ${name} ${key} (${g.cases} cases): ${laneLine(g)}`)
  }
  lines.push(`  payload chars p50/p90/max: ${payloadLine(aggregates.overall)}`)
  const unstable = result.cases.filter((c) => c.unstable).map((c) => c.id)
  if (unstable.length > 0) lines.push(`  unstable cases: ${unstable.join(', ')}`)
  return lines
}

export function formatBars(bars: readonly { name: string; pass: boolean; failing_case_ids: string[]; needs?: string }[]): string[] {
  return [
    'bars:',
    ...bars.map((b) => {
      if (b.pass) return `  ${b.name}: pass`
      const why = [...(b.needs ? [`needs ${b.needs}`] : []), ...b.failing_case_ids]
      return `  ${b.name}: fail (${why.join(', ')})`
    }),
  ]
}
