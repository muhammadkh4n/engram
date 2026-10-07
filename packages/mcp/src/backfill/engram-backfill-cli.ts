#!/usr/bin/env node
/**
 * Engram backfill
 *
 * Replays what was said before live capture existed through the capture
 * route, so it gets the same scrubbing, materialization and extraction as a
 * live prompt.
 *
 * Commands:
 *   - transcripts: every Claude Code main-session transcript under
 *     `--projects-dir`, oldest first, from the backfill's own cursor. Files
 *     modified in the last hour are left to live capture.
 *   - history: the prompts in `--history-file` of every session that has no
 *     transcript left, pastes put back; a bang command is not a prompt.
 *   - git: the user's non-merge commits on each registered repository's
 *     default branch, each built as the post-commit hook builds it.
 *
 * Dry run by default: prints what would be sent, sends nothing and writes no
 * state. `--apply` spools to the backfill's own state directory and drains it
 * in the foreground; a file's cursor moves only after the server
 * acknowledged all of its events. Re-running is safe: the route drops an
 * event it already holds and reports it as a duplicate.
 *
 * Usage:
 *   engram-backfill transcripts [--projects-dir DIR] [--overrides FILE] [sending flags] [--apply] [--json]
 *   engram-backfill history [--history-file FILE] [--projects-dir DIR] [--overrides FILE] [sending flags] [--apply] [--json]
 *   engram-backfill git (--repo DIR | --repos-under DIR)... [--author-email EMAIL]... [--since ISO] [sending flags] [--apply] [--json]
 *
 * Sending flags:
 *   --target URL        the server (default ENGRAM_SERVER_URL); events go to its /capture/events
 *   --token-file FILE   the capture token (default ENGRAM_CAPTURE_TOKEN_FILE, else ENGRAM_CAPTURE_TOKEN)
 *   --registry FILE     the project registry (default ENGRAM_PROJECT_REGISTRY_FILE)
 *   --state-dir DIR     cursors, spool and state (default ~/.engram/backfill/<sha256 of the endpoint, 12 hex>/)
 *
 * Exit codes: 0 done, 1 stopped or failed, 2 usage.
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectRegistry } from '../capture-events/project-registry.js'
import { captureEventsEndpoint } from '../capture/endpoint.js'
import { captureClientInfo } from '../capture/events.js'
import { isEntryPoint } from '../ingest/entry-point.js'
import { openPrivateHandle } from '../ingest/private-files.js'
import { type GitSummary, runGit } from './git.js'
import { type HistorySummary, runHistory } from './history.js'
import { createProjectResolver, loadOverrides, loadResolverRegistry, type ProjectResolver } from './project-resolver.js'
import { BACKFILL_CLIENT_NAME, type SendTarget } from './send.js'
import {
  backfillPaths,
  type BackfillPaths,
  defaultStateDir,
  openStateDir,
  saveBackfillState,
  withRun,
  withRunLock,
} from './state.js'
import { runTranscripts, type TranscriptsSummary } from './transcripts.js'

type Env = Record<string, string | undefined>

export const COMMANDS = ['transcripts', 'history', 'git'] as const
export type BackfillCommand = (typeof COMMANDS)[number]

export interface BackfillCliArgs {
  command: BackfillCommand
  apply: boolean
  json: boolean
  target: string | null
  tokenFile: string | null
  registry: string | null
  stateDir: string | null
  overrides: string | null
  projectsDir: string | null
  historyFile: string | null
  since: string | null
  repos: string[]
  reposUnder: string[]
  authorEmails: string[]
}

type BackfillSummary = TranscriptsSummary | HistorySummary | GitSummary

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

export class UsageError extends Error {}

const USAGE =
  'engram-backfill — replay past sessions through the capture route (dry run by default)\n' +
  '  engram-backfill transcripts [--projects-dir DIR] [--overrides FILE] [sending flags] [--apply] [--json]\n' +
  '  engram-backfill history [--history-file FILE] [--projects-dir DIR] [--overrides FILE] [sending flags] [--apply] [--json]\n' +
  '  engram-backfill git (--repo DIR | --repos-under DIR)... [--author-email EMAIL]... [--since ISO] [sending flags]\n' +
  '                      [--apply] [--json]\n' +
  '  Commands:\n' +
  '  transcripts          Claude Code main-session transcripts, oldest first; files modified in\n' +
  '                       the last hour are left to live capture\n' +
  '  history              prompts from the history file of sessions with no transcript left\n' +
  '  git                  your non-merge commits on each registered repository\'s default branch\n' +
  '  Sending flags:\n' +
  '  --target URL         the server (default ENGRAM_SERVER_URL)\n' +
  '  --token-file FILE    the capture token (default ENGRAM_CAPTURE_TOKEN_FILE, else ENGRAM_CAPTURE_TOKEN)\n' +
  '  --registry FILE      the project registry (default ENGRAM_PROJECT_REGISTRY_FILE)\n' +
  '  --state-dir DIR      cursors, spool and state (default ~/.engram/backfill/<12 hex of the endpoint>/)\n' +
  '  transcripts:\n' +
  '  --projects-dir DIR   default ~/.claude/projects\n' +
  '  --overrides FILE     JSON object: raw project value -> project name or null\n' +
  '  history:\n' +
  '  --history-file FILE  default ~/.claude/history.jsonl; pastes stored by hash are read from its paste-cache/\n' +
  '  --projects-dir DIR   the transcripts that decide which sessions are covered (default ~/.claude/projects)\n' +
  '  --overrides FILE     as for transcripts\n' +
  '  git:\n' +
  '  --repo DIR           a checkout to read (repeatable)\n' +
  '  --repos-under DIR    read every main clone directly under DIR (repeatable)\n' +
  '  --author-email EMAIL whose commits to send (repeatable; default each repository\'s user.email)\n' +
  '  --since ISO          only commits after this time\n' +
  '  Common:\n' +
  '  --apply              send, and move cursors once the server acknowledged\n' +
  '  --json               print the summary as JSON\n'

const VALUE_FLAGS = {
  '--target': 'target',
  '--token-file': 'tokenFile',
  '--registry': 'registry',
  '--state-dir': 'stateDir',
  '--overrides': 'overrides',
  '--projects-dir': 'projectsDir',
  '--history-file': 'historyFile',
  '--since': 'since',
} as const satisfies Record<string, keyof BackfillCliArgs>

const REPEATED_FLAGS = {
  '--repo': 'repos',
  '--repos-under': 'reposUnder',
  '--author-email': 'authorEmails',
} as const satisfies Record<string, keyof BackfillCliArgs>

const SENDING_FLAGS = ['--target', '--token-file', '--registry', '--state-dir', '--apply', '--json']

/** The flags each command takes; another command's flag is a usage error, not silently ignored. */
const COMMAND_FLAGS: Record<BackfillCommand, ReadonlySet<string>> = {
  transcripts: new Set([...SENDING_FLAGS, '--projects-dir', '--overrides']),
  history: new Set([...SENDING_FLAGS, '--history-file', '--projects-dir', '--overrides']),
  git: new Set([...SENDING_FLAGS, '--repo', '--repos-under', '--author-email', '--since']),
}

function isCommand(value: string): value is BackfillCommand {
  return (COMMANDS as readonly string[]).includes(value)
}

/** Parses argv after the program name; throws UsageError on an unknown command or flag. */
export function parseBackfillCliArgs(argv: readonly string[]): BackfillCliArgs | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help'
  const [command, ...rest] = argv
  if (command === undefined) throw new UsageError('a command is required')
  if (!isCommand(command)) throw new UsageError(`unknown command "${command}"`)
  const args: BackfillCliArgs = {
    command,
    apply: false,
    json: false,
    target: null,
    tokenFile: null,
    registry: null,
    stateDir: null,
    overrides: null,
    projectsDir: null,
    historyFile: null,
    since: null,
    repos: [],
    reposUnder: [],
    authorEmails: [],
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!
    if (!COMMAND_FLAGS[command].has(flag)) {
      const known = flag in VALUE_FLAGS || flag in REPEATED_FLAGS || SENDING_FLAGS.includes(flag)
      throw new UsageError(known ? `${command} does not take ${flag}` : `unknown flag "${flag}"`)
    }
    if (flag === '--apply') args.apply = true
    else if (flag === '--json') args.json = true
    else {
      const value = rest[++i]?.trim()
      if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value`)
      if (Object.hasOwn(REPEATED_FLAGS, flag)) args[REPEATED_FLAGS[flag as keyof typeof REPEATED_FLAGS]].push(value)
      else args[VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS]] = value
    }
  }
  if (command === 'git' && args.repos.length === 0 && args.reposUnder.length === 0) {
    throw new UsageError('git needs --repo or --repos-under')
  }
  if (args.since !== null && Number.isNaN(Date.parse(args.since))) throw new UsageError('--since must be an ISO date')
  return args
}

function expandHome(path: string, env: Env): string {
  return path === '~' || path.startsWith('~/') ? join(env.HOME || homedir(), path.slice(1)) : path
}

function required(value: string | null | undefined, what: string): string {
  const v = value?.trim()
  if (!v) throw new UsageError(`${what} is required`)
  return v
}

function endpointOf(target: string): string {
  try {
    return captureEventsEndpoint(target)
  } catch {
    throw new UsageError('--target must be a URL')
  }
}

/**
 * The capture token file to send with. A token given only as
 * ENGRAM_CAPTURE_TOKEN is written to an owner-only file in the state
 * directory for the run, because the drainer reads tokens from files only;
 * the returned cleanup removes it.
 */
async function tokenFileFor(
  args: BackfillCliArgs,
  env: Env,
  paths: BackfillPaths,
): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const file = args.tokenFile ?? env.ENGRAM_CAPTURE_TOKEN_FILE?.trim()
  if (file) return { file: expandHome(file, env), cleanup: async () => {} }
  const token = env.ENGRAM_CAPTURE_TOKEN?.trim()
  if (!token) throw new UsageError('--token-file, ENGRAM_CAPTURE_TOKEN_FILE or ENGRAM_CAPTURE_TOKEN is required with --apply')
  const path = join(paths.root, '.capture-token')
  const handle = await openPrivateHandle(path, 'w')
  try {
    await handle.writeFile(`${token}\n`)
  } finally {
    await handle.close()
  }
  return { file: path, cleanup: () => fs.rm(path, { force: true }) }
}

function pairs(counts: Record<string, number>): string {
  return Object.keys(counts).length === 0 ? 'none' : Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')
}

/** The lines every command prints: what it read, then what the server answered. */
function commandLines(s: BackfillSummary): string {
  if (s.command === 'transcripts') {
    return (
      `  files: found=${s.files.found} read=${s.files.read} skipped_recent=${s.files.skipped_recent} ` +
      `skipped_unchanged=${s.files.skipped_unchanged} not_reached=${s.files.not_reached}\n`
    )
  }
  if (s.command === 'history') return `  entries: ${pairs({ ...s.entries })}\n`
  const repos = s.repos.map((r) => `    ${r.repo} ${r.branch} commits=${r.commits} (${r.path})\n`).join('')
  const skipped = s.skipped.map((r) => `    ${r.repo ?? '-'} ${r.reason} (${r.path})\n`).join('')
  return `  repos:\n${repos || '    none\n'}  skipped:\n${skipped || '    none\n'}  unreadable=${s.unreadable}\n`
}

export function formatSummary(s: BackfillSummary): string {
  return (
    `${s.apply ? 'apply' : 'dry run'}: ${s.command}\n` +
    commandLines(s) +
    `  events: ${pairs(s.events)}\n` +
    `  accepted=${s.accepted} duplicates=${s.duplicates}\n` +
    `  rejected: ${pairs(s.rejected)}\n` +
    `  stopped: ${s.stopped ?? 'none'}\n`
  )
}

interface CommandContext {
  env: Env
  registryFile: string
  registry: ProjectRegistry
  resolver: ProjectResolver
  paths: BackfillPaths
  log: (line: string) => void
}

function runSource(args: BackfillCliArgs, ctx: CommandContext, send: SendTarget | undefined): Promise<BackfillSummary> {
  const home = ctx.env.HOME || homedir()
  const projectsDir = args.projectsDir ? expandHome(args.projectsDir, ctx.env) : join(home, '.claude', 'projects')
  const common = { env: ctx.env, log: ctx.log, ...(send ? { send } : {}) }
  if (args.command === 'transcripts') {
    return runTranscripts({ ...common, projectsDir, registry: ctx.registry, resolver: ctx.resolver, paths: ctx.paths })
  }
  if (args.command === 'history') {
    const historyFile = args.historyFile ? expandHome(args.historyFile, ctx.env) : join(home, '.claude', 'history.jsonl')
    return runHistory({ ...common, historyFile, projectsDir, resolver: ctx.resolver })
  }
  return runGit({
    ...common,
    repos: args.repos.map((p) => expandHome(p, ctx.env)),
    reposUnder: args.reposUnder.map((p) => expandHome(p, ctx.env)),
    authorEmails: args.authorEmails,
    since: args.since,
    registry: ctx.registry,
    registryFile: ctx.registryFile,
  })
}

async function runCommand(args: BackfillCliArgs, env: Env, io: CliIo): Promise<BackfillSummary> {
  const endpoint = endpointOf(required(args.target ?? env.ENGRAM_SERVER_URL, '--target or ENGRAM_SERVER_URL'))
  const registryArg = required(args.registry ?? env.ENGRAM_PROJECT_REGISTRY_FILE, '--registry or ENGRAM_PROJECT_REGISTRY_FILE')
  const registryFile = expandHome(registryArg, env)
  const registry = loadResolverRegistry(registryFile, env)
  const overrides = args.overrides ? loadOverrides(args.overrides, env) : new Map<string, string | null>()
  const ctx: CommandContext = {
    env,
    registryFile,
    registry,
    resolver: createProjectResolver({ registry, overrides }, env),
    paths: backfillPaths(args.stateDir ? expandHome(args.stateDir, env) : defaultStateDir(endpoint, env)),
    log: (line: string): void => io.err(`[engram-backfill] ${line}\n`),
  }
  if (!args.apply) return runSource(args, ctx, undefined)

  const { paths } = ctx
  const state = await openStateDir(paths, endpoint)
  return withRunLock(paths, async () => {
    const token = await tokenFileFor(args, env, paths)
    try {
      const send: SendTarget = {
        env,
        spool: paths.spool,
        endpoint,
        tokenFile: token.file,
        client: { name: BACKFILL_CLIENT_NAME, version: captureClientInfo().version },
      }
      const summary = await runSource(args, ctx, send)
      await saveBackfillState(paths, withRun(state, args.command, summary, new Date()))
      return summary
    } finally {
      await token.cleanup()
    }
  })
}

/** Runs one command and returns the exit code. */
export async function runBackfillCli(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  let args: BackfillCliArgs | 'help'
  try {
    args = parseBackfillCliArgs(argv)
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`)
    return 2
  }
  if (args === 'help') {
    io.out(USAGE)
    return 0
  }
  try {
    const summary = await runCommand(args, env, io)
    io.out(args.json ? `${JSON.stringify(summary)}\n` : formatSummary(summary))
    return summary.stopped === null ? 0 : 1
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n${USAGE}`)
      return 2
    }
    io.err(`[engram-backfill] failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  runBackfillCli(process.argv.slice(2), process.env, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }).then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
