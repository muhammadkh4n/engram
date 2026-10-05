/**
 * Transcript to spool: reads the lines after the session's cursor, scrubs
 * every event, fits it to the route, writes the batch, and only then saves
 * the cursor. A crash between the write and the save makes the next read
 * send repeats, which the server drops by event key; saving first would lose
 * events for good. An event the route would refuse is dead-lettered here,
 * scrubbed and whole, instead of being sent to be refused.
 */

import { basename } from 'node:path'
import { scrubEvent } from '../capture-events/scrub.js'
import type { CaptureEvent, EventProject } from './events.js'
import { type CaptureRegistry, loadCaptureRegistry, resolveEventProject } from './event-project.js'
import { appendCaptureLog } from './log.js'
import { readyForRoute } from './route-fit.js'
import { spoolRoot, writeDeadLetters, writeSpoolBatch } from './spool.js'
import { cursorRoot, type FileLease, loadCursor, saveCursor, withReaderLock } from './transcript-cursor.js'
import { readTranscriptEvents } from './transcript-reader.js'

type Env = Record<string, string | undefined>

export interface SpoolTranscriptOptions {
  env: Env
  /** Close a turn still open at EOF (session end, an idle file). */
  forceClose?: boolean
}

export interface SpoolTranscriptResult {
  /** Events written to the spool. */
  events: number
  /** Batch files written. */
  files: number
  /** Values masked across those events. */
  redactions: number
  /** Events dead-lettered because the route would refuse them. */
  dead: number
}

const LOG_REASONS_MAX_CHARS = 300

/** The session id of a transcript: its file name without `.jsonl`. */
function transcriptSessionId(path: string): string {
  return basename(path).replace(/\.jsonl$/, '')
}

/** One project lookup per (cwd, branch) pair: most lines of a transcript share the same few pairs. */
function projectResolver(registry: CaptureRegistry): (cwd: string | null, branch: string | null) => EventProject {
  const cache = new Map<string, EventProject>()
  return (cwd, branch) => {
    const key = `${cwd ?? ''}\u0000${branch ?? ''}`
    let project = cache.get(key)
    if (project === undefined) {
      project = resolveEventProject(cwd, branch, registry)
      cache.set(key, project)
    }
    return project
  }
}

/**
 * Spools the transcript's new events under the session's reader lock and
 * returns counts only. A reader that could not take the lock returns zeros:
 * the holder reads once more for it. A failed spool write throws and leaves
 * the cursor where it was. A reader whose lock was taken over mid-read keeps
 * the batch it wrote, whose events the server drops as repeats, and saves no
 * cursor, which could land behind the one the new holder saves.
 */
export async function spoolTranscript(path: string, opts: SpoolTranscriptOptions): Promise<SpoolTranscriptResult> {
  const sessionId = transcriptSessionId(path)
  const cursors = cursorRoot(opts.env)
  const spool = spoolRoot(opts.env)
  const resolveProject = projectResolver(loadCaptureRegistry(opts.env))
  const total: SpoolTranscriptResult = { events: 0, files: 0, redactions: 0, dead: 0 }
  const log = (line: string): void => appendCaptureLog(opts.env, line)

  const once = async (lease: FileLease): Promise<void> => {
    const cursor = await loadCursor(cursors, sessionId)
    const read = await readTranscriptEvents(path, cursor, { resolveProject, forceClose: opts.forceClose })
    const now = new Date()
    const ready: CaptureEvent[] = []
    const refused: Array<{ reason: string; event: CaptureEvent }> = []
    let redactions = 0
    for (const event of read.events) {
      const result = await scrubEvent(event)
      redactions += result.masked.length
      const check = readyForRoute(result.event, { now, log })
      if (check.ok) ready.push(check.event)
      else refused.push({ reason: check.reason, event: result.event })
    }
    const files = await writeSpoolBatch(sessionId, ready, { root: spool })
    writeDeadLetters(sessionId, refused, { root: spool })
    if (refused.length > 0) logRefused(log, refused)
    total.events += ready.length
    total.files += files.length
    total.redactions += redactions
    total.dead += refused.length
    if (!(await lease.renew())) {
      log('spool reader lost its lock mid-read; its cursor was not saved')
      return
    }
    await saveCursor(cursors, sessionId, read.cursor)
  }

  await withReaderLock(cursors, sessionId, once)
  return total
}

/** One capture-log line: the count and the distinct reasons, which name fields and rules, never values. */
function logRefused(log: (line: string) => void, refused: ReadonlyArray<{ reason: string }>): void {
  const reasons = [...new Set(refused.map((r) => r.reason))].join('; ')
  const clipped = reasons.length > LOG_REASONS_MAX_CHARS ? reasons.slice(0, LOG_REASONS_MAX_CHARS) : reasons
  log(`spool dead-lettered ${refused.length} event(s) the capture route refuses: ${clipped}`)
}
