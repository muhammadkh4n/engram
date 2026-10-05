#!/usr/bin/env node
/**
 * git post-commit capture: `engram-capture-commit`, run by the post-commit
 * script in the background from the repository's working directory. It
 * builds the `git_commit` event for HEAD, scrubs it, spools it and drains
 * the spool in this process. It takes no arguments, prints nothing, and
 * exits 0 on every path, within GIT_COMMIT_WATCHDOG_MS.
 */

import { readyForRoute } from '../capture/route-fit.js'
import {
  appendCaptureLog,
  buildGitCommitEvent,
  type DrainResult,
  drainSpool,
  scrubEvent,
  spoolRoot,
  writeDeadLetters,
  writeSpoolBatch,
} from '../capture/index.js'
import { isEntryPoint } from '../ingest/entry-point.js'

type Env = Record<string, string | undefined>

export const GIT_COMMIT_WATCHDOG_MS = 60_000
/** No drain request starts after this; one request may take 30 s, which still ends inside the watchdog. */
export const GIT_COMMIT_DRAIN_BUDGET_MS = 25_000

export interface GitCommitCaptureResult {
  /** 1 when the commit's event reached the spool, else 0. */
  events: number
  redactions: number
  /** Why no event was spooled: `no-commit` (outside a repository, unreadable, blank message) or `refused`. */
  skipped: 'no-commit' | 'refused' | null
  drain: DrainResult | null
  failures: string[]
}

function errorLabel(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string') return code
  return err instanceof Error ? err.name : 'error'
}

async function spoolCommit(cwd: string, env: Env, result: GitCommitCaptureResult): Promise<void> {
  const event = buildGitCommitEvent(cwd, 'HEAD', { env })
  if (event === null) {
    result.skipped = 'no-commit'
    return
  }
  const scrubbed = await scrubEvent(event)
  result.redactions = scrubbed.masked.length
  const check = readyForRoute(scrubbed.event, { now: new Date(), log: (line) => appendCaptureLog(env, line) })
  const root = spoolRoot(env)
  if (!check.ok) {
    writeDeadLetters(event.session_id, [{ reason: check.reason, event: scrubbed.event }], { root })
    appendCaptureLog(env, `git-commit dead-lettered an event the capture route refuses: ${check.reason.slice(0, 300)}`)
    result.skipped = 'refused'
    return
  }
  await writeSpoolBatch(event.session_id, [check.event], { root })
  result.events = 1
}

/**
 * Spools HEAD's commit event, then drains. The drain runs even when the
 * commit could not be spooled, so earlier batches still go out.
 */
export async function runGitCommitCapture(cwd: string, env: Env): Promise<GitCommitCaptureResult> {
  const started = Date.now()
  const result: GitCommitCaptureResult = { events: 0, redactions: 0, skipped: null, drain: null, failures: [] }
  try {
    await spoolCommit(cwd, env, result)
  } catch (err) {
    result.failures.push(`spool:${errorLabel(err)}`)
  }
  try {
    result.drain = await drainSpool({ env, deadlineMs: started + GIT_COMMIT_DRAIN_BUDGET_MS })
  } catch (err) {
    result.failures.push(`drain:${errorLabel(err)}`)
  }
  return result
}

/** The run's capture-log line: counts only, never the message, file names or tokens. */
export function gitCommitLogLine(result: GitCommitCaptureResult, ms: number): string {
  const d = result.drain
  const drain =
    d === null
      ? 'drain=failed'
      : `sent=${d.files_sent} accepted=${d.accepted} duplicates=${d.duplicates} rejected=${d.rejected} ` +
        `dead=${d.dead} remaining=${d.remaining} stopped=${d.stopped ?? 'none'}`
  const skipped = result.skipped === null ? '' : ` skipped=${result.skipped}`
  const failed = result.failures.length > 0 ? ` failed=${result.failures.join(',')}` : ''
  return `git-commit events=${result.events} redactions=${result.redactions}${skipped} ${drain} ms=${ms}${failed}`
}

async function main(): Promise<void> {
  const env = process.env
  const started = Date.now()
  const result = await runGitCommitCapture(process.cwd(), env)
  appendCaptureLog(env, gitCommitLogLine(result, Date.now() - started))
}

if (isEntryPoint(import.meta.url)) {
  const watchdog = setTimeout(() => {
    appendCaptureLog(process.env, `git-commit watchdog fired after ${GIT_COMMIT_WATCHDOG_MS} ms`)
    process.exit(0)
  }, GIT_COMMIT_WATCHDOG_MS)
  watchdog.unref()
  main()
    .catch((err: unknown) => appendCaptureLog(process.env, `git-commit failed: ${errorLabel(err)}`))
    .finally(() => process.exit(0))
}
