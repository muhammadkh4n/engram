#!/usr/bin/env node
/**
 * `engram-capture-drain`: drains the capture spool in the foreground and
 * prints one line of counts, never event text. Exits 1 when the drain
 * stopped on an error. Another drainer holding the lock (`locked`,
 * `lock_lost`), a backoff still running, or the deadline are not errors.
 */

import { exitWhenFlushed } from '../cli-exit.js'
import { isEntryPoint } from '../ingest/entry-point.js'
import { type DrainResult, type DrainStop, drainSpool } from './index.js'

type Env = Record<string, string | undefined>

const NOT_ERRORS: ReadonlySet<DrainStop | null> = new Set<DrainStop | null>([null, 'locked', 'lock_lost', 'backoff', 'deadline'])

export function drainLine(result: DrainResult): string {
  return (
    `sent=${result.files_sent} accepted=${result.accepted} duplicates=${result.duplicates} rejected=${result.rejected} ` +
    `dead=${result.dead} remaining=${result.remaining} stopped=${result.stopped ?? 'none'}`
  )
}

export function drainExitCode(result: DrainResult): 0 | 1 {
  return NOT_ERRORS.has(result.stopped) ? 0 : 1
}

/** Drains once, writes the counts line, and returns the exit code. */
export async function runDrainCli(env: Env, write: (line: string) => void): Promise<0 | 1> {
  try {
    const result = await drainSpool({ env })
    write(`${drainLine(result)}\n`)
    return drainExitCode(result)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    write(`stopped=error (${typeof code === 'string' ? code : err instanceof Error ? err.name : 'error'})\n`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  runDrainCli(process.env, (line) => process.stdout.write(line)).then(
    (code) => exitWhenFlushed(code),
    () => exitWhenFlushed(1),
  )
}
