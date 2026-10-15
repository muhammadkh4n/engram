#!/usr/bin/env node
/**
 * Builds and checks the case file of real decision points, replays the
 * reviewed cases through one arm's lanes, and reports scores and bars.
 *
 * Usage:
 *   npx tsx packages/bench/src/decisions/engram-decision-replay.ts check --cases cases.jsonl [--drafts]
 *
 *   npx tsx packages/bench/src/decisions/engram-decision-replay.ts draft \
 *     [--incidents incidents.jsonl --class-lanes class-lanes.json] \
 *     [--factcheck-cases cases.jsonl --factcheck-judgements out/ --marked marked-ids.json] \
 *     [--misses "Memory Misses.md"] [--projects-dir ~/.claude/projects] \
 *     [--expect-factcheck <n>] --out drafts.jsonl
 *
 *   npx tsx packages/bench/src/decisions/engram-decision-replay.ts run --arm new|old \
 *     --cases cases.jsonl --label <label> --out <dir> --calibration-before <iso> \
 *     --registry projects.json --vault-root <dir> --dotfiles <dir> [--runs 2] \
 *     new arm: --recall-url <url> --token-file <file> --channels channels.json
 *     old arm: --dist <checkout> --env engram.env --pins pins.json [--pins-mode fill|strict] \
 *              --calibration-query "<query>" --snapshot-label <label> --snapshot-dumped-at <iso>
 *
 *   npx tsx packages/bench/src/decisions/engram-decision-replay.ts report run.json [other-run.json] [--bars]
 *
 * `check` refuses a malformed file and, without `--drafts`, any draft left in
 * it. `draft` writes `<out>` and `<out>.report.json`; `run` writes
 * `<out>/<label>.json`. Every file is written mode 0600 and never overwritten.
 * Case data holds prompts and quotes, so stdout and stderr carry counts, ids
 * and field names only.
 * Exit 2: usage error, or output files that already exist. Exit 4: a stop (a
 * degraded recall, a refused store URL, a write guard, a pin miss, a case
 * whose old-arm lanes changed between passes under strict pins). Exit 1: any
 * other error.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openEvalStack, parseSystemdEnvFile } from '../eval/eval-stack.js'
import { assertPinsClean, openPins, type PinStats } from '../eval/pins.js'
import { assertLabel, engramEnvForMeta, isRunStop } from '../eval/run.js'
import type { GuardStats } from '../eval/write-guards.js'
import { parsePinsMode, sha256, type PinsMode } from '../replay/replay-lib.js'
import { writeAtomic } from '../replay/replay-stack.js'
import { assertReviewed, parseCases, type DecisionCase } from './cases.js'
import { draftCases, parseClassLanes, readFactcheckInput, serializeCases, type DraftInput, type DraftReport } from './draft.js'
import {
  ChannelProfileError,
  parseChannelProfiles,
  postgrestCreatedAt,
  replayCase,
  type Arm,
  type ArmDeps,
  type CreatedAtLookup,
  type OldRecaller,
  type RecallPoster,
} from './lanes.js'
import { RecallClient, RecallStopError } from './recall-client.js'
import {
  buildResult,
  fileSha256s,
  formatBars,
  formatRunReport,
  gitHead,
  parseProjectRegistry,
  parseRunResult,
  planLedgerFiles,
  replayPasses,
  UnstableStrictRunError,
  type DecisionRunMeta,
} from './run.js'
import { evaluateBars } from './score.js'

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700
/** Keeps every file this process creates owner-only, including writeAtomic's temporary file. */
const PRIVATE_UMASK = 0o077

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

class UsageError extends Error {}

const FLAGS_WITH_VALUES = new Set([
  '--cases',
  '--incidents',
  '--class-lanes',
  '--factcheck-cases',
  '--factcheck-judgements',
  '--marked',
  '--misses',
  '--projects-dir',
  '--expect-factcheck',
  '--out',
])
const BOOLEAN_FLAGS = new Set(['--drafts'])

interface ParsedArgs {
  values: Map<string, string>
  booleans: Set<string>
}

function parseArgs(argv: readonly string[], allowed: ReadonlySet<string>): ParsedArgs {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (!allowed.has(flag)) throw new UsageError(`unknown argument ${flag}`)
    if (BOOLEAN_FLAGS.has(flag)) {
      booleans.add(flag)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`)
    if (values.has(flag)) throw new UsageError(`${flag} given twice`)
    values.set(flag, value)
    i += 1
  }
  return { values, booleans }
}

function statusCounts(cases: readonly DecisionCase[]): string {
  const count = (status: DecisionCase['status']): number => cases.filter((c) => c.status === status).length
  const needed = cases.reduce((n, c) => n + c.needed.length, 0)
  return `cases ${cases.length}: draft ${count('draft')}, reviewed ${count('reviewed')}, dropped ${count('dropped')}; needed ${needed}`
}

function check(argv: readonly string[], io: CliIo): number {
  const args = parseArgs(argv, new Set(['--cases', '--drafts']))
  const file = args.values.get('--cases')
  if (file === undefined) throw new UsageError('check needs --cases <file>')
  const cases = parseCases(fs.readFileSync(file, 'utf8'))
  if (!args.booleans.has('--drafts')) assertReviewed(cases)
  io.stdout(`${statusCounts(cases)}\n`)
  return 0
}

function optionalText(file: string | undefined): string | undefined {
  return file === undefined ? undefined : fs.readFileSync(file, 'utf8')
}

function expectedCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new UsageError('--expect-factcheck must be a non-negative integer')
  return n
}

function draftInput(values: ReadonlyMap<string, string>): DraftInput {
  const factcheckFlags = ['--factcheck-cases', '--factcheck-judgements', '--marked']
  const given = factcheckFlags.filter((f) => values.has(f))
  if (given.length !== 0 && given.length !== factcheckFlags.length) throw new UsageError(`fact-check drafting needs ${factcheckFlags.join(', ')}`)
  if (values.has('--incidents') !== values.has('--class-lanes')) throw new UsageError('--incidents and --class-lanes go together')
  if (!values.has('--incidents') && given.length === 0 && !values.has('--misses')) {
    throw new UsageError('draft needs --incidents, --factcheck-cases or --misses')
  }
  const classLanes = values.get('--class-lanes')
  const expectFactcheck = expectedCount(values.get('--expect-factcheck'))
  return {
    incidents: optionalText(values.get('--incidents')),
    ...(classLanes === undefined ? {} : { classLanes: parseClassLanes(fs.readFileSync(classLanes, 'utf8')) }),
    ...(given.length === 0
      ? {}
      : { factcheck: readFactcheckInput(values.get('--factcheck-cases')!, values.get('--factcheck-judgements')!, values.get('--marked')!) }),
    misses: optionalText(values.get('--misses')),
    projectsDir: values.get('--projects-dir') ?? path.join(os.homedir(), '.claude', 'projects'),
    ...(expectFactcheck === undefined ? {} : { expectFactcheck }),
  }
}

function reportLines(report: DraftReport): string[] {
  const { counts } = report
  const lines = [
    `drafts ${counts.drafts}: incidents ${counts.incidents}, factcheck ${counts.factcheck}, misses ${counts.misses}`,
    `factcheck skipped ${report.factcheck_skipped}; orphan judgements ${report.orphan_judgements}`,
    `unresolved refs ${report.unresolved.length}`,
    `possible duplicates ${report.possible_duplicates.length}`,
  ]
  if (report.factcheck_expected !== null && report.factcheck_expected !== counts.factcheck) {
    lines.push(`factcheck count ${counts.factcheck} differs from the expected ${report.factcheck_expected}`)
  }
  return lines
}

function writePrivate(file: string, text: string): void {
  writeAtomic(file, text)
  fs.chmodSync(file, PRIVATE_FILE_MODE)
}

function draft(argv: readonly string[], io: CliIo): number {
  const allowed = new Set([...FLAGS_WITH_VALUES].filter((f) => f !== '--cases'))
  const args = parseArgs(argv, allowed)
  const out = args.values.get('--out')
  if (out === undefined) throw new UsageError('draft needs --out <file>')
  const reportFile = `${out}.report.json`
  for (const file of [out, reportFile]) {
    if (fs.existsSync(file)) throw new UsageError(`${file} exists; pick another --out`)
  }
  const { drafts, report } = draftCases(draftInput(args.values))
  // A draft file that its own checker refuses would stall review; fail here instead.
  parseCases(serializeCases(drafts))
  const previousUmask = process.umask(PRIVATE_UMASK)
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true, mode: PRIVATE_DIR_MODE })
    writePrivate(out, serializeCases(drafts))
    writePrivate(reportFile, JSON.stringify(report, null, 2) + '\n')
  } finally {
    process.umask(previousUmask)
  }
  io.stdout(reportLines(report).map((l) => `${l}\n`).join(''))
  return 0
}

// ── run ──────────────────────────────────────────────────────────────────

const RUN_COMMON_FLAGS = ['--arm', '--cases', '--label', '--out', '--calibration-before', '--registry', '--vault-root', '--dotfiles', '--runs']
const RUN_NEW_FLAGS = ['--recall-url', '--token-file', '--channels']
const RUN_OLD_FLAGS = ['--dist', '--env', '--pins', '--pins-mode', '--calibration-query', '--snapshot-label', '--snapshot-dumped-at']
const RUN_REQUIRED = ['--arm', '--cases', '--label', '--out', '--calibration-before', '--registry', '--vault-root', '--dotfiles']
const NEW_REQUIRED = RUN_NEW_FLAGS
const OLD_REQUIRED = ['--dist', '--env', '--pins', '--calibration-query', '--snapshot-label', '--snapshot-dumped-at']
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

interface RunArgs {
  arm: Arm
  cases: string
  label: string
  out: string
  calibrationBefore: string
  registry: string
  vaultRoot: string
  dotfiles: string
  runs: number
  recallUrl?: string
  tokenFile?: string
  channels?: string
  dist?: string
  env?: string
  pins?: string
  pinsMode?: PinsMode
  calibrationQuery?: string
  snapshotLabel?: string
  snapshotDumpedAt?: string
}

function isoTime(raw: string, flag: string): string {
  if (!ISO_WITH_OFFSET.test(raw) || Number.isNaN(Date.parse(raw))) throw new UsageError(`${flag} must be an ISO-8601 time with an offset`)
  return raw
}

function parseRunCount(raw: string | undefined): number {
  if (raw === undefined) return 1
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError('--runs must be a positive integer')
  return n
}

function parseRunArgs(argv: readonly string[]): RunArgs {
  const args = parseArgs(argv, new Set([...RUN_COMMON_FLAGS, ...RUN_NEW_FLAGS, ...RUN_OLD_FLAGS]))
  const v = args.values
  const arm = v.get('--arm')
  if (arm !== 'new' && arm !== 'old') throw new UsageError('run needs --arm new or --arm old')
  const required = [...RUN_REQUIRED, ...(arm === 'new' ? NEW_REQUIRED : OLD_REQUIRED)]
  const missing = required.filter((f) => !v.has(f))
  if (missing.length > 0) throw new UsageError(`run --arm ${arm} needs ${missing.join(', ')}`)
  const foreign = (arm === 'new' ? RUN_OLD_FLAGS : RUN_NEW_FLAGS).filter((f) => v.has(f))
  if (foreign.length > 0) throw new UsageError(`${foreign.join(', ')} does not apply to the ${arm} arm`)
  const label = v.get('--label')!
  try {
    assertLabel(label)
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  let pinsMode: PinsMode | undefined
  if (arm === 'old') {
    try {
      pinsMode = parsePinsMode(v.get('--pins-mode'))
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err))
    }
  }
  const pick = (flag: string): string | undefined => v.get(flag)
  return {
    arm,
    cases: v.get('--cases')!,
    label,
    out: v.get('--out')!,
    calibrationBefore: isoTime(v.get('--calibration-before')!, '--calibration-before'),
    registry: v.get('--registry')!,
    vaultRoot: v.get('--vault-root')!,
    dotfiles: v.get('--dotfiles')!,
    runs: parseRunCount(v.get('--runs')),
    recallUrl: pick('--recall-url'),
    tokenFile: pick('--token-file'),
    channels: pick('--channels'),
    dist: pick('--dist'),
    env: pick('--env'),
    pins: pick('--pins'),
    pinsMode,
    calibrationQuery: pick('--calibration-query'),
    snapshotLabel: pick('--snapshot-label'),
    snapshotDumpedAt: v.has('--snapshot-dumped-at') ? isoTime(v.get('--snapshot-dumped-at')!, '--snapshot-dumped-at') : undefined,
  }
}

/** The old recall pipeline on a snapshot, opened for one run. */
export interface OldArmHandle {
  stack: OldRecaller
  createdAt: CreatedAtLookup
  engramEnv: Record<string, string>
  guards: GuardStats
  pinStats: PinStats
  /** Saves pending fills and returns the recording's sha256. */
  flushPins(): string
  /** Throws when a strict miss, a blocked model call or a blocked fetch happened. */
  assertClean(): void
  close(): Promise<void>
}

export interface RunDeps {
  openRecall?: (opts: { recallUrl: string; tokenFile: string }) => RecallPoster & { origin: string }
  openOldArm?: (opts: { dist: string; env: string; pins: string; pinsMode: PinsMode; calibrationQuery: string; now: Date }) => Promise<OldArmHandle>
  replay?: typeof replayCase
  now?: () => Date
}

async function openOldArmDefault(opts: Parameters<NonNullable<RunDeps['openOldArm']>>[0]): Promise<OldArmHandle> {
  const envVars = parseSystemdEnvFile(fs.readFileSync(opts.env, 'utf8'))
  const url = envVars['SUPABASE_URL']
  const key = envVars['SUPABASE_KEY']
  if (url === undefined || key === undefined) throw new Error(`${opts.env} sets no SUPABASE_URL or SUPABASE_KEY`)
  const pins = openPins(path.resolve(opts.pins), opts.pinsMode)
  try {
    const stack = await openEvalStack({ engramDist: opts.dist, envFile: opts.env, calibrationQuery: opts.calibrationQuery, now: opts.now, pins })
    return {
      stack,
      createdAt: postgrestCreatedAt({ url, key }),
      engramEnv: stack.engramEnv,
      guards: stack.guards,
      pinStats: pins.stats,
      flushPins: () => pins.flush(),
      assertClean: () => assertPinsClean(pins),
      close: async () => {
        pins.flush()
        await stack.close()
      },
    }
  } catch (err) {
    pins.flush()
    throw err
  }
}

function writePrivateFiles(dir: string, files: readonly { file: string; text: string }[]): void {
  const previousUmask = process.umask(PRIVATE_UMASK)
  try {
    fs.mkdirSync(path.resolve(dir), { recursive: true, mode: PRIVATE_DIR_MODE })
    for (const f of files) writePrivate(f.file, f.text)
  } finally {
    process.umask(previousUmask)
  }
}

function readRegistry(file: string) {
  const text = fs.readFileSync(file, 'utf8')
  return { text, registry: parseProjectRegistry(text) }
}

async function run(argv: readonly string[], io: CliIo, deps: RunDeps): Promise<number> {
  const args = parseRunArgs(argv)
  const outFile = path.join(args.out, `${args.label}.json`)
  if (fs.existsSync(outFile)) throw new UsageError(`${outFile} exists; pick another --label or --out`)
  const now = deps.now ?? (() => new Date())
  const caseText = fs.readFileSync(args.cases, 'utf8')
  const all = parseCases(caseText)
  assertReviewed(all)
  const reviewed = all.filter((c) => c.status === 'reviewed')
  if (reviewed.length === 0) throw new Error('the case file has no reviewed case')
  const { text: registryText, registry } = readRegistry(args.registry)
  const roots = { dotfiles: args.dotfiles, vaultRoot: args.vaultRoot, registry }
  const started = now()

  let armDeps: ArmDeps
  let store: string
  let profilesSha: string | null = null
  let old: OldArmHandle | null = null
  if (args.arm === 'new') {
    let profiles
    try {
      profiles = parseChannelProfiles(fs.readFileSync(args.channels!, 'utf8'))
    } catch (err) {
      if (err instanceof ChannelProfileError) throw new UsageError(err.message)
      throw err
    }
    profilesSha = profiles.sha256
    const open = deps.openRecall ?? ((o) => RecallClient.open(o))
    const client = open({ recallUrl: args.recallUrl!, tokenFile: args.tokenFile! })
    store = client.origin
    armDeps = { arm: 'new', recall: client, profiles }
  } else {
    const open = deps.openOldArm ?? openOldArmDefault
    // The snapshot's own time anchors the stack's calibration recall, so its pinned replies are the same every run.
    old = await open({
      dist: args.dist!,
      env: args.env!,
      pins: args.pins!,
      pinsMode: args.pinsMode!,
      calibrationQuery: args.calibrationQuery!,
      now: new Date(args.snapshotDumpedAt!),
    })
    store = args.snapshotLabel!
    armDeps = { arm: 'old', stack: old.stack, createdAt: old.createdAt }
  }

  try {
    const replayed = await replayPasses({
      cases: reviewed,
      passes: args.runs,
      roots,
      deps: armDeps,
      calibrationBefore: args.calibrationBefore,
      snapshotDumpedAt: args.snapshotDumpedAt ?? null,
      replay: deps.replay ?? replayCase,
      onCase: (pass, index) => {
        if (index === reviewed.length - 1) io.stderr(`[decision-replay] ${args.label}: pass ${pass + 1}/${args.runs} done\n`)
      },
    })
    const unstable = replayed.scores.filter((s) => s.unstable).map((s) => s.id)
    if (old !== null) {
      old.assertClean()
      if (args.pinsMode === 'strict' && unstable.length > 0) throw new UnstableStrictRunError(unstable)
    }
    const meta: Omit<DecisionRunMeta, 'unstable'> = {
      arm: args.arm,
      label: args.label,
      started: started.toISOString(),
      finished: now().toISOString(),
      case_file: args.cases,
      case_file_sha256: sha256(caseText),
      cases: reviewed.length,
      dropped: all.length - reviewed.length,
      runs: args.runs,
      calibration_before: args.calibrationBefore,
      store,
      snapshot_dumped_at: args.snapshotDumpedAt ?? null,
      dist: args.dist ?? null,
      dist_git_sha: args.dist === undefined ? null : gitHead(args.dist),
      dotfiles: args.dotfiles,
      dotfiles_git_sha: gitHead(args.dotfiles),
      registry_sha256: sha256(registryText),
      register_sha256: fileSha256s(replayed.registerFiles),
      plan_ledger_sha256: fileSha256s(planLedgerFiles(reviewed)),
      pins_file: args.pins ?? null,
      pins_mode: args.pinsMode ?? null,
      pins_sha256: old === null ? null : old.flushPins(),
      channel_profiles_sha256: profilesSha,
      calibration_query: args.calibrationQuery ?? null,
      engram_env: old === null ? null : engramEnvForMeta(old.engramEnv),
      guards: old === null ? null : old.guards,
      pin_stats: old === null ? null : { ...old.pinStats, misses: old.pinStats.misses.length },
    }
    const result = buildResult(meta, replayed.scores)
    writePrivateFiles(args.out, [{ file: outFile, text: JSON.stringify(result, null, 2) + '\n' }])
    const o = result.aggregates.overall
    io.stdout(`cases ${o.cases}, needed ${o.needed}, unstable ${result.meta.unstable}; wrote ${outFile}\n`)
    return 0
  } finally {
    await old?.close()
  }
}

// ── report ───────────────────────────────────────────────────────────────

function report(argv: readonly string[], io: CliIo): number {
  const withBars = argv.includes('--bars')
  const files = argv.filter((a) => a !== '--bars')
  if (files.length < 1 || files.length > 2 || files.some((f) => f.startsWith('--'))) {
    throw new UsageError('usage: report <run.json> [<other-run.json>] [--bars]')
  }
  const results = files.map((f) => parseRunResult(fs.readFileSync(f, 'utf8'), f))
  const lines = results.flatMap(formatRunReport)
  if (withBars) {
    const fresh = results.filter((r) => r.meta.arm === 'new')
    const old = results.filter((r) => r.meta.arm === 'old')
    if (fresh.length !== 1 || old.length > 1) throw new UsageError('--bars needs one new-arm run and at most one old-arm run')
    lines.push(...formatBars(evaluateBars(fresh[0]!, old[0])))
  }
  io.stdout(lines.map((l) => `${l}\n`).join(''))
  return 0
}

const USAGE = 'usage: engram-decision-replay check --cases <file> [--drafts] | draft … --out <file> | run --arm new|old … | report <run.json> [<other>] [--bars]'

function isStop(err: unknown): boolean {
  return err instanceof RecallStopError || err instanceof UnstableStrictRunError || isRunStop(err)
}

function exitCode(err: unknown): number {
  if (err instanceof UsageError) return 2
  return isStop(err) ? 4 : 1
}

/** Runs `check`, `draft` or `report`; returns the exit code. Errors go to `io.stderr` as messages without record text. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv
  try {
    if (command === 'check') return check(rest, io)
    if (command === 'draft') return draft(rest, io)
    if (command === 'report') return report(rest, io)
    throw new UsageError(USAGE)
  } catch (err) {
    io.stderr(`[decision-replay] ${err instanceof Error ? err.message : String(err)}\n`)
    return exitCode(err)
  }
}

/** Every command, `run` included; returns the exit code. */
export async function main(argv: readonly string[], io: CliIo, deps: RunDeps = {}): Promise<number> {
  if (argv[0] !== 'run') return runCli(argv, io)
  try {
    return await run(argv.slice(1), io, deps)
  } catch (err) {
    io.stderr(`[decision-replay] ${err instanceof Error ? err.message : String(err)}\n`)
    return exitCode(err)
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  void main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then((code) => process.exit(code))
}
