#!/usr/bin/env node
/**
 * Builds and checks the case file of real decision points that the decision
 * replay scores.
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
 * `check` refuses a malformed file and, without `--drafts`, any draft left in
 * it. `draft` writes `<out>` and `<out>.report.json` (mode 0600) and refuses to
 * overwrite either. Case data holds prompts and quotes, so stdout and stderr
 * carry counts, ids and field names only.
 * Exit 2: usage error, or output files that already exist. Exit 1: any other error.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeAtomic } from '../replay/replay-stack.js'
import { assertReviewed, parseCases, type DecisionCase } from './cases.js'
import { draftCases, parseClassLanes, readFactcheckInput, serializeCases, type DraftInput, type DraftReport } from './draft.js'

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

/** Runs one command; returns the exit code. Errors go to `io.stderr` as messages without record text. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv
  try {
    if (command === 'check') return check(rest, io)
    if (command === 'draft') return draft(rest, io)
    throw new UsageError('usage: engram-decision-replay check --cases <file> [--drafts] | draft … --out <file>')
  } catch (err) {
    io.stderr(`[decision-replay] ${err instanceof Error ? err.message : String(err)}\n`)
    return err instanceof UsageError ? 2 : 1
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
  const code = runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
  process.exit(code)
}
