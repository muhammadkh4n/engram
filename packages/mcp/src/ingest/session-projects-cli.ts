#!/usr/bin/env node
/**
 * Engram session → project map
 *
 * Per-turn captures keep the Claude session id but neither cwd nor project.
 * Every Claude Code transcript (`<sid>.jsonl`) records the session's cwd on
 * its message lines, so resolving that cwd the way a live capture does
 * (resolveProjectScope: git repository, then a configured root, else shared)
 * recovers the project each session belonged to.
 *
 * The cwd is taken from the first line that carries one: transcripts open
 * with bookkeeping lines (queue operations, file-history snapshots) that have
 * no cwd. ENGRAM_PROJECT_ID is ignored on purpose; an explicit project would
 * stamp every session with the same id.
 *
 * Reads `<dir>/*.jsonl` and `<dir>/<project dir>/*.jsonl` (the layout of
 * ~/.claude/projects); subagent transcripts nested deeper share their parent's
 * session and are not read. A transcript that cannot be read, or has no cwd,
 * is listed under `errors`; the run never fails because of one file.
 *
 * Output (stdout, JSON):
 *   { "<sid>": { "cwd": "...", "project": "<id>" | null, "source": "..." }, ...,
 *     "errors": [ { "file": "...", "error": "..." } ] }
 *
 * Usage:
 *   engram-session-projects [--transcripts DIR] [--since ISO]
 *
 * Roots come from ENGRAM_PROJECT_GROUPS_FILE (`roots`).
 */

import { CliExit, exitOnError } from '../cli-exit.js'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { isEntryPoint } from './entry-point.js'
import { resolveProjectScope, type ProjectScopeSource } from './project-detect.js'

const TAG = '[engram-session-projects]'
const TRANSCRIPT_SUFFIX = '.jsonl'

export interface SessionProject {
  cwd: string
  project: string | null
  source: ProjectScopeSource
}

export interface SessionMapError {
  file: string
  error: string
}

export interface SessionProjectMap {
  sessions: Record<string, SessionProject>
  errors: SessionMapError[]
}

export interface SessionMapOptions {
  transcriptsDir: string
  /** Only transcripts whose mtime is at or after this instant. */
  since?: Date
  /** Groups file holding `roots`; unset means no roots. */
  groupsFile?: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Transcript files directly in `dir` and one directory level below it. */
async function listTranscripts(dir: string, errors: SessionMapError[]): Promise<string[]> {
  const files: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    errors.push({ file: dir, error: messageOf(err) })
    return files
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.name.endsWith(TRANSCRIPT_SUFFIX)) {
      files.push(path)
      continue
    }
    if (!entry.isDirectory()) continue
    try {
      const inner = await readdir(path, { withFileTypes: true })
      for (const child of inner) {
        if (child.name.endsWith(TRANSCRIPT_SUFFIX)) files.push(join(path, child.name))
      }
    } catch (err) {
      errors.push({ file: path, error: messageOf(err) })
    }
  }
  return files.sort()
}

/** The cwd of the first transcript line that carries one, or null. */
async function firstCwd(file: string): Promise<string | null> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const cwd = (parsed as { cwd?: unknown } | null)?.cwd
      if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
    }
    return null
  } finally {
    lines.close()
    stream.destroy()
  }
}

export async function mapSessionProjects(opts: SessionMapOptions): Promise<SessionProjectMap> {
  const errors: SessionMapError[] = []
  const sessions: Record<string, SessionProject> = {}
  const env: NodeJS.ProcessEnv = opts.groupsFile ? { ENGRAM_PROJECT_GROUPS_FILE: opts.groupsFile } : {}

  for (const file of await listTranscripts(opts.transcriptsDir, errors)) {
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a regular file')
      if (opts.since && info.mtime.getTime() < opts.since.getTime()) continue
      const cwd = await firstCwd(file)
      if (!cwd) throw new Error('no line carries a cwd')
      const scope = resolveProjectScope({ env, cwd })
      sessions[basename(file, TRANSCRIPT_SUFFIX)] = { cwd, project: scope.id, source: scope.source }
    } catch (err) {
      errors.push({ file, error: messageOf(err) })
    }
  }
  return { sessions, errors }
}

/** The stdout document: session ids at the top level, beside `errors`. */
export function formatSessionMap(map: SessionProjectMap): string {
  return JSON.stringify({ ...map.sessions, errors: map.errors }, null, 2)
}

const HELP =
  'engram-session-projects — map Claude Code sessions to projects from their transcripts\n' +
  '  --transcripts DIR  transcript directory (default ~/.claude/projects)\n' +
  '  --since ISO        only transcripts modified at or after this instant\n' +
  '  Roots come from ENGRAM_PROJECT_GROUPS_FILE.\n'

function fail(message: string): never {
  throw new CliExit(1, `${TAG} ${message}`)
}

export function parseSessionMapArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SessionMapOptions {
  let transcriptsDir = join(homedir(), '.claude', 'projects')
  let since: Date | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--transcripts') {
      const value = argv[++i]?.trim()
      if (!value) fail('--transcripts requires a directory')
      transcriptsDir = value
    } else if (a === '--since') {
      const value = argv[++i]?.trim()
      const parsed = value ? new Date(value) : undefined
      if (!parsed || Number.isNaN(parsed.getTime())) fail(`--since requires an ISO timestamp, got "${value ?? ''}"`)
      since = parsed
    } else if (a === '--help' || a === '-h') {
      console.log(HELP)
      throw new CliExit(0)
    } else fail(`unknown argument "${a}"`)
  }
  const groupsFile = env['ENGRAM_PROJECT_GROUPS_FILE']?.trim() || undefined
  return { transcriptsDir, since, groupsFile }
}

if (isEntryPoint(import.meta.url)) {
  // Parsed inside the chain so a usage error exits through exitOnError.
  Promise.resolve()
    .then(() => mapSessionProjects(parseSessionMapArgs(process.argv.slice(2))))
    .then((map) => {
      process.stdout.write(formatSessionMap(map) + '\n')
      console.error(
        `${TAG} ${Object.keys(map.sessions).length} sessions mapped, ${map.errors.length} errors`,
      )
    })
    .catch((err: unknown) => exitOnError(err, (e) => console.error(`${TAG} ${messageOf(e)}`)))
}
