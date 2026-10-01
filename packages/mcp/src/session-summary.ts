#!/usr/bin/env node
/**
 * Session Summary — Claude Code SessionEnd hook.
 *
 * The hook process only hands off: it re-launches this script detached with
 * `--worker`, passing the hook's stdin JSON in ENGRAM_HOOK_INPUT and the
 * worker's output to ~/.engram/hook.log, and exits at once. Claude Code
 * stops waiting for SessionEnd hooks after a short timeout, so the digest
 * and the post must not run in the hook process.
 *
 * The worker reads the recent transcript and has it digested into one
 * session-summary memory. With ENGRAM_SERVER_URL set the excerpt goes to
 * the server's capture route, which runs the digest and the store, and is
 * spooled if the server cannot take it now; without it the pipeline runs
 * here against this machine's credentials.
 *
 * stdin: { session_id, transcript_path, cwd, ... }. Without a transcript
 * path the most recently written transcript is used.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAIM_STALE_MS, DERIVE_TIMEOUT_MS, engramDir, type CaptureEnv } from './ingest/capture-client.js'
import { isEntryPoint } from './ingest/entry-point.js'
import { resolveProject } from './ingest/project-detect.js'
import { sendTranscriptCapture } from './ingest/transcript-capture.js'
import { readTranscriptExcerpt, type TranscriptExcerpt } from './ingest/transcript-excerpt.js'

const LOG_PREFIX = '[engram-summary]'
const EXCERPT_LIMITS = { maxChars: 30_000, perTurnChars: 2_000 }
const MIN_EXCERPT_CHARS = 100
/** Summaries are stored under one session, outside the conversations they summarise. */
export const SUMMARY_SESSION_ID = 'claude-code-summaries'
export const WORKER_FLAG = '--worker'
export const HOOK_INPUT_ENV = 'ENGRAM_HOOK_INPUT'
/** The worker outlasts its own post plus a spool flush, so a flush is never cut off mid-claim. */
const WORKER_TIMEOUT_MS = DERIVE_TIMEOUT_MS + CLAIM_STALE_MS

interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
}

function parseHookInput(raw: string | undefined): HookInput {
  try {
    const parsed: unknown = raw?.trim() ? JSON.parse(raw) : {}
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookInput) : {}
  } catch {
    return {}
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function findLatestTranscript(env: CaptureEnv): string | null {
  const projectsDir = join(env['HOME'] || homedir(), '.claude', 'projects')
  let latest: { path: string; mtime: number } | null = null
  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const fullDir = join(projectsDir, dir)
    try {
      for (const file of readdirSync(fullDir).filter((f) => f.endsWith('.jsonl'))) {
        const path = join(fullDir, file)
        const mtime = statSync(path).mtimeMs
        if (!latest || mtime > latest.mtime) latest = { path, mtime }
      }
    } catch {
      // Not a directory, or unreadable: skip it.
    }
  }
  return latest?.path ?? null
}

/**
 * Launches the worker detached from the hook process, with its output
 * appended to ~/.engram/hook.log. `scriptPath` and the inherited exec
 * arguments re-run this same module.
 */
export function spawnSummaryWorker(
  hookJson: string,
  env: CaptureEnv = process.env,
  scriptPath: string = fileURLToPath(import.meta.url),
): void {
  let logFd = -1
  try {
    const dir = engramDir(env)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    logFd = openSync(join(dir, 'hook.log'), 'a')
  } catch {
    // Without a log the worker still runs; its output is discarded.
  }
  const child = spawn(process.execPath, [...process.execArgv, scriptPath, WORKER_FLAG], {
    env: { ...env, [HOOK_INPUT_ENV]: hookJson },
    detached: true,
    stdio: logFd >= 0 ? ['ignore', logFd, logFd] : 'ignore',
  })
  child.unref()
}

/** Digests and sends the summary for one hook payload; returns the exit code. */
export async function runSessionSummaryWorker(
  hookJson: string | undefined,
  env: CaptureEnv = process.env,
): Promise<number> {
  const hook = parseHookInput(hookJson)
  const transcriptPath = hook.transcript_path || findLatestTranscript(env)
  if (!transcriptPath) {
    process.stderr.write(`${LOG_PREFIX} No transcript found, skipping.\n`)
    return 0
  }

  let excerpt: TranscriptExcerpt
  try {
    excerpt = readTranscriptExcerpt(transcriptPath, EXCERPT_LIMITS)
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX} Failed to read transcript ${transcriptPath}: ${errorText(err)}\n`)
    return 1
  }
  if (excerpt.text.length < MIN_EXCERPT_CHARS) {
    process.stderr.write(`${LOG_PREFIX} Session too short to summarize.\n`)
    return 0
  }

  try {
    const result = await sendTranscriptCapture(
      {
        derive: 'session-summary',
        excerpt,
        transcriptPath,
        sessionId: SUMMARY_SESSION_ID,
        project: resolveProject('auto', hook.cwd ?? process.cwd()),
        meta: { transcriptPath },
        logPrefix: LOG_PREFIX,
      },
      env,
    )
    process.stderr.write(`${result.line}\n`)
    return result.exitCode
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX} Error: ${errorText(err)}\n`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  if (process.argv.includes(WORKER_FLAG)) {
    setTimeout(() => {
      process.stderr.write(`${LOG_PREFIX} timeout after ${WORKER_TIMEOUT_MS / 1000}s, exiting\n`)
      process.exit(3)
    }, WORKER_TIMEOUT_MS).unref()
    runSessionSummaryWorker(process.env[HOOK_INPUT_ENV]).then(
      (code) => process.exit(code),
      () => process.exit(1),
    )
  } else {
    let stdin = ''
    try {
      stdin = readFileSync(0, 'utf-8')
    } catch {
      // No stdin: the worker falls back to the latest transcript.
    }
    try {
      spawnSummaryWorker(stdin)
    } catch (err) {
      process.stderr.write(`${LOG_PREFIX} could not start the worker: ${errorText(err)}\n`)
    }
    process.exit(0)
  }
}
