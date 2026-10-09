/**
 * Exiting a CLI without losing its output.
 *
 * Node writes to a pipe asynchronously once the pipe buffer (64 KiB on Linux)
 * is full, and `process.exit` drops whatever is still queued: a summary piped
 * to `tee` stops mid-line at 65,536 bytes and its last lines never arrive.
 * Every entry point therefore exits through `exitWhenFlushed`, which first
 * waits until stdout and stderr have handed everything written so far to the
 * OS. A reader that closed its end (EPIPE) fails the stream instead of
 * draining it, so the wait ends either way and the exit never hangs on it.
 *
 * This is the one place that calls `process.exit` directly, apart from
 * watchdog timers that bound a process's lifetime and write nothing first.
 */
import type { Writable } from 'node:stream'

/**
 * Stops a CLI from anywhere below its entry point with an exit code. The
 * entry point's catch hands it to `exitOnError`, which writes `message` (when
 * not empty) to stderr and exits with `code` once output is flushed.
 */
export class CliExit extends Error {
  readonly code: number

  constructor(code: number, message = '') {
    super(message)
    this.name = 'CliExit'
    this.code = code
  }
}

/**
 * Resolves once everything written to `stream` before the call has been
 * handed to the OS: true when it was, false when the stream failed (a reader
 * that closed the pipe) or was already destroyed. Writes complete in order,
 * so a zero-length write's callback fires after every earlier write's.
 */
export function whenFlushed(stream: Writable): Promise<boolean> {
  if (stream.destroyed) return Promise.resolve(stream.errored === null)
  return new Promise((resolve) => {
    // Left attached: the process is about to exit, and a write error emitted
    // after the callback must not become an uncaught exception that replaces
    // the exit code with a crash.
    stream.on('error', () => resolve(false))
    stream.write('', (err) => resolve(err === null || err === undefined))
  })
}

export interface ExitDeps {
  streams: readonly Writable[]
  exit: (code: number) => never
}

const processExit = (code: number): never => process.exit(code)

/**
 * Exits with `code` once stdout and stderr are flushed. A stream that failed
 * does not change the code: the command's own result is what it reports.
 */
export async function exitWhenFlushed(code: number, deps: Partial<ExitDeps> = {}): Promise<never> {
  const streams = deps.streams ?? [process.stdout, process.stderr]
  await Promise.all(streams.map((s) => whenFlushed(s)))
  return (deps.exit ?? processExit)(code)
}

/**
 * The catch of a CLI's main promise: a `CliExit` writes its message and exits
 * with its code; any other error is reported by `onFatal` and exits 1.
 */
export function exitOnError(err: unknown, onFatal: (err: unknown) => void, deps: Partial<ExitDeps> = {}): Promise<never> {
  if (err instanceof CliExit) {
    if (err.message !== '') process.stderr.write(`${err.message}\n`)
    return exitWhenFlushed(err.code, deps)
  }
  onFatal(err)
  return exitWhenFlushed(1, deps)
}
