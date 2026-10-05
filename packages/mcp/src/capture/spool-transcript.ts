/**
 * Transcript to spool: reads the lines after the session's cursor, scrubs
 * every event, writes the batch, and only then saves the cursor. A crash
 * between the write and the save makes the next read send repeats, which the
 * server drops by event key; saving first would lose events for good.
 */

import { basename } from 'node:path'
import { scrubEvent } from '../capture-events/scrub.js'
import type { CaptureEvent, EventProject } from './events.js'
import { type CaptureRegistry, loadCaptureRegistry, resolveEventProject } from './event-project.js'
import { spoolRoot, writeSpoolBatch } from './spool.js'
import { cursorRoot, loadCursor, saveCursor, withReaderLock } from './transcript-cursor.js'
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
}

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
 * the cursor where it was.
 */
export async function spoolTranscript(path: string, opts: SpoolTranscriptOptions): Promise<SpoolTranscriptResult> {
  const sessionId = transcriptSessionId(path)
  const cursors = cursorRoot(opts.env)
  const spool = spoolRoot(opts.env)
  const resolveProject = projectResolver(loadCaptureRegistry(opts.env))
  const total: SpoolTranscriptResult = { events: 0, files: 0, redactions: 0 }

  const once = async (): Promise<void> => {
    const cursor = await loadCursor(cursors, sessionId)
    const read = await readTranscriptEvents(path, cursor, { resolveProject, forceClose: opts.forceClose })
    const scrubbed: CaptureEvent[] = []
    let redactions = 0
    for (const event of read.events) {
      const result = await scrubEvent(event)
      scrubbed.push(result.event)
      redactions += result.masked.length
    }
    const files = await writeSpoolBatch(sessionId, scrubbed, { root: spool })
    await saveCursor(cursors, sessionId, read.cursor)
    total.events += scrubbed.length
    total.files += files.length
    total.redactions += redactions
  }

  await withReaderLock(cursors, sessionId, once)
  return total
}
