/**
 * What every Claude Code capture hook does: read the hook JSON on stdin,
 * hand the work to a detached capture worker, and exit. A hook never blocks
 * a prompt or a tool call, so it prints nothing on any path, exits 0 on any
 * failure, and is gone within HOOK_EXIT_MS whatever the worker does.
 */

import { exitWhenFlushed } from '../cli-exit.js'
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { closeSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forwardedInput, HOOK_AT_ENV, HOOK_INPUT_ENV, type WorkerKind } from '../capture/hook-input.js'
import { captureLogPath } from '../capture/log.js'
import { ensurePrivateDir, openPrivateFile } from '../ingest/private-files.js'

type Env = Record<string, string | undefined>

export const HOOK_EXIT_MS = 2_000

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface StartWorkerOptions {
  env: Env
  /** The hook's start time, ISO 8601. */
  at: string
  spawn?: Spawn
}

/** The worker module beside this one, with this module's own extension (`.js` built, `.ts` under a loader). */
function workerPath(): string {
  const here = fileURLToPath(import.meta.url)
  return join(dirname(dirname(here)), 'capture', `worker${extname(here)}`)
}

/** The capture log opened for appending, or null when it cannot be. */
function openCaptureLog(env: Env): number | null {
  try {
    const path = captureLogPath(env)
    ensurePrivateDir(dirname(path))
    return openPrivateFile(path, 'a')
  } catch {
    return null
  }
}

/**
 * Starts `capture/worker --hook <kind>` detached, its output appended to the
 * capture log, and returns whether a child was spawned. A Stop hook fired
 * while a Stop hook is already active, or stdin that is not a JSON object,
 * starts nothing. Never throws.
 */
export function startWorker(kind: WorkerKind, raw: string, opts: StartWorkerOptions): boolean {
  try {
    const parsed = forwardedInput(raw)
    if (parsed === null) return false
    if (kind === 'stop' && parsed.stopHookActive) return false
    const logFd = openCaptureLog(opts.env)
    try {
      const spawn = opts.spawn ?? nodeSpawn
      // The parent's loader flags (none in a built install) go along, so the worker runs wherever the hook runs.
      const child = spawn(process.execPath, [...process.execArgv, workerPath(), '--hook', kind], {
        detached: true,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
        env: { ...opts.env, [HOOK_INPUT_ENV]: JSON.stringify(parsed.input), [HOOK_AT_ENV]: opts.at },
      })
      child.on('error', () => undefined)
      child.unref()
      return true
    } finally {
      if (logFd !== null) closeSync(logFd)
    }
  } catch {
    return false
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

/** The body of a hook entry file: read stdin, start the worker, exit 0. */
export function runHookEntry(kind: WorkerKind): void {
  const at = new Date().toISOString()
  // Exits at once: the deadline bounds the hook even when stdin never closes,
  // so it must not wait on a stdout/stderr reader; the hook writes nothing.
  const safety = setTimeout(() => process.exit(0), HOOK_EXIT_MS)
  safety.unref()
  readStdin()
    .then((raw) => {
      startWorker(kind, raw, { env: process.env, at })
    })
    .catch(() => undefined)
    .finally(() => exitWhenFlushed(0))
}
