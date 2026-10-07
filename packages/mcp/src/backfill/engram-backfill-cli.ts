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
 *
 * Dry run by default: prints what would be sent, sends nothing and writes no
 * state. `--apply` spools to the backfill's own state directory and drains it
 * in the foreground; a file's cursor moves only after the server
 * acknowledged all of its events. Re-running is safe: the route drops an
 * event it already holds and reports it as a duplicate.
 *
 * Usage:
 *   engram-backfill transcripts [--projects-dir DIR] [--overrides FILE] [sending flags] [--apply] [--json]
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
import { captureEventsEndpoint } from '../capture/endpoint.js'
import { captureClientInfo } from '../capture/events.js'
import { isEntryPoint } from '../ingest/entry-point.js'
import { openPrivateHandle } from '../ingest/private-files.js'
import { createProjectResolver, loadOverrides, loadResolverRegistry } from './project-resolver.js'
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

export const COMMANDS = ['transcripts'] as const
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
}

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

export class UsageError extends Error {}

const USAGE =
  'engram-backfill — replay past sessions through the capture route (dry run by default)\n' +
  '  engram-backfill transcripts [--projects-dir DIR] [--overrides FILE] [sending flags] [--apply] [--json]\n' +
  '  Commands:\n' +
  '  transcripts          Claude Code main-session transcripts, oldest first; files modified in\n' +
  '                       the last hour are left to live capture\n' +
  '  Sending flags:\n' +
  '  --target URL         the server (default ENGRAM_SERVER_URL)\n' +
  '  --token-file FILE    the capture token (default ENGRAM_CAPTURE_TOKEN_FILE, else ENGRAM_CAPTURE_TOKEN)\n' +
  '  --registry FILE      the project registry (default ENGRAM_PROJECT_REGISTRY_FILE)\n' +
  '  --state-dir DIR      cursors, spool and state (default ~/.engram/backfill/<12 hex of the endpoint>/)\n' +
  '  transcripts:\n' +
  '  --projects-dir DIR   default ~/.claude/projects\n' +
  '  --overrides FILE     JSON object: raw project value -> project name or null\n' +
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
} as const satisfies Record<string, keyof BackfillCliArgs>

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
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '--apply') args.apply = true
    else if (flag === '--json') args.json = true
    else if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = rest[++i]?.trim()
      if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value`)
      args[VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS]] = value
    } else throw new UsageError(`unknown flag "${flag}"`)
  }
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

export function formatTranscriptsSummary(s: TranscriptsSummary): string {
  const pairs = (counts: Record<string, number>): string =>
    Object.keys(counts).length === 0 ? 'none' : Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')
  return (
    `${s.apply ? 'apply' : 'dry run'}: transcripts\n` +
    `  files: found=${s.files.found} read=${s.files.read} skipped_recent=${s.files.skipped_recent} ` +
    `skipped_unchanged=${s.files.skipped_unchanged} not_reached=${s.files.not_reached}\n` +
    `  events: ${pairs(s.events)}\n` +
    `  accepted=${s.accepted} duplicates=${s.duplicates}\n` +
    `  rejected: ${pairs(s.rejected)}\n` +
    `  stopped: ${s.stopped ?? 'none'}\n`
  )
}

async function runTranscriptsCommand(args: BackfillCliArgs, env: Env, io: CliIo): Promise<TranscriptsSummary> {
  const endpoint = endpointOf(required(args.target ?? env.ENGRAM_SERVER_URL, '--target or ENGRAM_SERVER_URL'))
  const registryFile = required(args.registry ?? env.ENGRAM_PROJECT_REGISTRY_FILE, '--registry or ENGRAM_PROJECT_REGISTRY_FILE')
  const registry = loadResolverRegistry(registryFile, env)
  const overrides = args.overrides ? loadOverrides(args.overrides, env) : new Map<string, string | null>()
  const resolver = createProjectResolver({ registry, overrides }, env)
  const paths = backfillPaths(args.stateDir ? expandHome(args.stateDir, env) : defaultStateDir(endpoint, env))
  const projectsDir = args.projectsDir ? expandHome(args.projectsDir, env) : join(env.HOME || homedir(), '.claude', 'projects')
  const log = (line: string): void => io.err(`[engram-backfill] ${line}\n`)
  const base = { env, projectsDir, registry, resolver, paths, log }
  if (!args.apply) return runTranscripts(base)

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
      const summary = await runTranscripts({ ...base, send })
      await saveBackfillState(paths, withRun(state, 'transcripts', summary, new Date()))
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
    const summary = await runTranscriptsCommand(args, env, io)
    io.out(args.json ? `${JSON.stringify(summary)}\n` : formatTranscriptsSummary(summary))
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
