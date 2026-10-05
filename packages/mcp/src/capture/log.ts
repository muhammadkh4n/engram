/**
 * The capture library's own log, `~/.engram/capture.log`: one line per
 * notable outcome (a registry that could not be read, a drain that failed).
 * Callers pass outcomes and counts only, never event text, headers or
 * tokens, since the file outlives the session that wrote it.
 */

import { renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendPrivateFile, ensurePrivateDir } from '../ingest/private-files.js'

type Env = Record<string, string | undefined>

export const CAPTURE_LOG_MAX_BYTES = 5 * 1024 * 1024

export function captureLogPath(env: Env): string {
  return join(env.HOME || homedir(), '.engram', 'capture.log')
}

/**
 * Appends `<ISO time> <line>` (newlines folded to spaces). A log already past
 * CAPTURE_LOG_MAX_BYTES is first moved to `capture.log.1`, replacing the
 * previous one. Never throws: a log that cannot be written must not fail
 * capture.
 */
export function appendCaptureLog(env: Env, line: string): void {
  try {
    const path = captureLogPath(env)
    ensurePrivateDir(dirname(path))
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      size = 0
    }
    if (size > CAPTURE_LOG_MAX_BYTES) renameSync(path, `${path}.1`)
    appendPrivateFile(path, `${new Date().toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`)
  } catch {
    // Logging is best effort.
  }
}
