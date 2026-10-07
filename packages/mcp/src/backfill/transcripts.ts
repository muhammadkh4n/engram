/**
 * Replays Claude Code transcripts through the capture route.
 *
 * Main-session files only (`<projects-dir>/<dir>/<session>.jsonl`; the files
 * under `<dir>/<session>/subagents/` are not the user's conversation), oldest
 * first. A file written to in the last hour belongs to live capture and is
 * left alone. Each file is read with live capture's own reader from the
 * backfill cursor, so the events carry the same exclusions and the same
 * event uuids, and a session live capture already sent comes back as
 * duplicates. A `session_start` at the first line and a `session_end` at the
 * last frame the session. The cursor moves only after the server
 * acknowledged every batch of the file.
 */

import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { CAPTURE_PROJECT_BRANCH_MAX_CHARS } from '../capture-events/contract.js'
import type { ProjectRegistry } from '../capture-events/project-registry.js'
import { resolveEventProject } from '../capture/event-project.js'
import { eventUuidFromParts } from '../capture/event-uuid.js'
import type { CaptureEvent, EventProject } from '../capture/events.js'
import { loadCursor, saveCursor } from '../capture/transcript-cursor.js'
import { readTranscriptEvents } from '../capture/transcript-reader.js'
import type { ProjectResolver } from './project-resolver.js'
import { countPrepared, emptyTally, prepareEvents, sendSession, type SendTally, type SendTarget } from './send.js'
import type { BackfillPaths } from './state.js'

type Env = Record<string, string | undefined>

/** Files modified more recently than this are still live capture's. */
export const LIVE_CAPTURE_WINDOW_MS = 60 * 60_000

export interface TranscriptsOptions {
  env: Env
  projectsDir: string
  registry: ProjectRegistry
  resolver: ProjectResolver
  paths: BackfillPaths
  /** Absent for a dry run, which sends nothing and writes no state. */
  send?: SendTarget
  now?: () => Date
  log?: (line: string) => void
}

export interface TranscriptsSummary extends SendTally {
  command: 'transcripts'
  apply: boolean
  files: { found: number; read: number; skipped_recent: number; skipped_unchanged: number; not_reached: number }
  /** Why the run stopped before the last file, or null. */
  stopped: string | null
}

interface TranscriptFile {
  path: string
  sessionId: string
  mtimeMs: number
  size: number
}

/** Every `<dir>/<session>.jsonl` one level below `projectsDir`, oldest modification first. */
export async function listTranscriptFiles(projectsDir: string): Promise<TranscriptFile[]> {
  const files: TranscriptFile[] = []
  for (const dir of await fs.readdir(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const dirPath = join(projectsDir, dir.name)
    for (const entry of await fs.readdir(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(dirPath, entry.name)
      const stat = await fs.stat(path)
      files.push({ path, sessionId: entry.name.slice(0, -'.jsonl'.length), mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The project block for an entry's cwd: git's answer while the directory
 * exists, as live capture computes it; the resolver's once it is gone.
 */
export function backfillProjectFor(
  registry: ProjectRegistry,
  resolver: ProjectResolver,
): (cwd: string | null, branch: string | null) => EventProject {
  const cache = new Map<string, EventProject>()
  return (cwd, branch) => {
    const key = `${cwd ?? ''}\u0000${branch ?? ''}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    let project: EventProject
    if (!cwd || existsSync(cwd)) {
      project = resolveEventProject(cwd, branch, registry)
    } else {
      const resolved = resolver(cwd)
      const fits = branch !== null && branch.length > 0 && branch.length <= CAPTURE_PROJECT_BRANCH_MAX_CHARS
      project = {
        id: resolved.project_id,
        workspace: resolved.workspace_id,
        repo_root: null,
        branch: fits ? branch : null,
        worktree: null,
      }
    }
    cache.set(key, project)
    return project
  }
}

interface MarkerEntry {
  timestamp: string
  cwd: string | null
  branch: string | null
}

function markerEntry(line: string): MarkerEntry | null {
  if (!line.includes('"timestamp"')) return null
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (e.isSidechain === true || typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) return null
  return {
    timestamp: e.timestamp,
    cwd: typeof e.cwd === 'string' ? e.cwd : null,
    branch: typeof e.gitBranch === 'string' ? e.gitBranch : null,
  }
}

/** The first and the last main-session entry of the file that carry a timestamp. */
async function firstAndLastEntries(path: string): Promise<{ first: MarkerEntry; last: MarkerEntry } | null> {
  let first: MarkerEntry | null = null
  let last: MarkerEntry | null = null
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    const entry = markerEntry(line)
    if (entry === null) continue
    first ??= entry
    last = entry
  }
  return first !== null && last !== null ? { first, last } : null
}

function sessionMarker(
  type: 'session_start' | 'session_end',
  sessionId: string,
  entry: MarkerEntry,
  planDirs: string[],
  projectFor: (cwd: string | null, branch: string | null) => EventProject,
): CaptureEvent {
  return {
    session_id: sessionId,
    // The parts live capture's session hooks use, so the same session marker has one uuid.
    event_uuid: eventUuidFromParts(sessionId, type, entry.timestamp),
    type,
    occurred_at: entry.timestamp,
    cwd: entry.cwd,
    project: projectFor(entry.cwd, entry.branch),
    plan_dirs: [...planDirs],
    payload: {},
  } as CaptureEvent
}

type FileStep = 'read' | 'recent' | 'unchanged'

/** Reads one file's new events and frames them; null when there is nothing new. */
async function fileEvents(
  file: TranscriptFile,
  opts: TranscriptsOptions,
  projectFor: (cwd: string | null, branch: string | null) => EventProject,
) {
  const cursor = await loadCursor(opts.paths.cursors, file.sessionId)
  if (cursor !== null && cursor.offset >= file.size) return null
  const read = await readTranscriptEvents(file.path, cursor, { resolveProject: projectFor, forceClose: true })
  const ends = await firstAndLastEntries(file.path)
  const events: CaptureEvent[] = []
  if (ends !== null && cursor === null) events.push(sessionMarker('session_start', file.sessionId, ends.first, [], projectFor))
  events.push(...(read.events as CaptureEvent[]))
  const consumed = read.cursor.offset > (cursor?.offset ?? 0)
  if (ends !== null && consumed && read.cursor.offset >= file.size) {
    events.push(sessionMarker('session_end', file.sessionId, ends.last, read.cursor.plan_dirs, projectFor))
  }
  return { events, cursor: read.cursor }
}

export async function runTranscripts(opts: TranscriptsOptions): Promise<TranscriptsSummary> {
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? (() => {})
  const summary: TranscriptsSummary = {
    command: 'transcripts',
    apply: opts.send !== undefined,
    files: { found: 0, read: 0, skipped_recent: 0, skipped_unchanged: 0, not_reached: 0 },
    ...emptyTally(),
    stopped: null,
  }
  const projectFor = backfillProjectFor(opts.registry, opts.resolver)
  const files = await listTranscriptFiles(opts.projectsDir)
  summary.files.found = files.length
  for (const [index, file] of files.entries()) {
    const step = await processFile(file, opts, projectFor, summary, now(), log)
    if (step === 'recent') summary.files.skipped_recent++
    else if (step === 'unchanged') summary.files.skipped_unchanged++
    else if (step === 'read') summary.files.read++
    else {
      summary.stopped = step.stopped
      summary.files.not_reached = files.length - index
      break
    }
  }
  return summary
}

async function processFile(
  file: TranscriptFile,
  opts: TranscriptsOptions,
  projectFor: (cwd: string | null, branch: string | null) => EventProject,
  summary: TranscriptsSummary,
  now: Date,
  log: (line: string) => void,
): Promise<FileStep | { stopped: string }> {
  if (now.getTime() - file.mtimeMs < LIVE_CAPTURE_WINDOW_MS) return 'recent'
  const read = await fileEvents(file, opts, projectFor)
  if (read === null) return 'unchanged'
  const prepared = await prepareEvents(read.events, { now, log })
  if (opts.send === undefined) {
    countPrepared(summary, prepared)
    return 'read'
  }
  const outcome = await sendSession(opts.send, file.sessionId, prepared, summary)
  if (!outcome.delivered) return { stopped: outcome.stopped }
  await saveCursor(opts.paths.cursors, file.sessionId, read.cursor)
  return 'read'
}
