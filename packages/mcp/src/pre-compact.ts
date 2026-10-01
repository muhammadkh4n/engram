#!/usr/bin/env node
/**
 * PreCompact Hook — persist the session's key points before compaction.
 *
 * Fires before Claude Code compresses the conversation. Reads the recent
 * transcript, has it digested into a long-term memory plus a short context
 * paragraph, and prints that paragraph as additionalContext so Claude keeps
 * its bearings after compaction.
 *
 * With ENGRAM_SERVER_URL set the excerpt goes to the server's capture route,
 * which runs the digest and the store; without it the pipeline runs here
 * against this machine's credentials. The hook is synchronous and Claude
 * Code gives it 30 s, so the post is capped below that; a capture that does
 * not get through is spooled and nothing is printed.
 *
 * stdin: { session_id, transcript_path, cwd, hook_event_name, trigger }
 * stdout: { additionalContext: "..." } (injected into post-compaction context)
 */

import { readFileSync } from 'node:fs'
import type { CaptureEnv } from './ingest/capture-client.js'
import { isEntryPoint } from './ingest/entry-point.js'
import { resolveProject } from './ingest/project-detect.js'
import { appendHookLog, sendTranscriptCapture } from './ingest/transcript-capture.js'
import { readTranscriptExcerpt, type TranscriptExcerpt } from './ingest/transcript-excerpt.js'

const LOG_PREFIX = '[engram-compact]'
const EXCERPT_LIMITS = { maxChars: 40_000, perTurnChars: 3_000 }
const MIN_EXCERPT_CHARS = 200
/** Claude Code allows the hook 30 s; the post gets 25 s of it. */
export const PRE_COMPACT_POST_TIMEOUT_MS = 25_000
const HOOK_WATCHDOG_MS = 28_000
const DEFAULT_SESSION_ID = 'claude-code'

interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  trigger?: string
}

function parseHookInput(raw: string): HookInput {
  try {
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {}
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookInput) : {}
  } catch {
    return {}
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Runs the hook for one stdin payload and returns the exit code. The context
 * paragraph is written through `writeStdout` only when the pipeline produced
 * one.
 */
export async function runPreCompact(
  hookJson: string,
  env: CaptureEnv = process.env,
  writeStdout: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  const hook = parseHookInput(hookJson)
  if (!hook.transcript_path) {
    process.stderr.write(`${LOG_PREFIX} No transcript_path in hook input.\n`)
    return 0
  }

  let excerpt: TranscriptExcerpt
  try {
    excerpt = readTranscriptExcerpt(hook.transcript_path, EXCERPT_LIMITS)
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX} Failed to read transcript: ${errorText(err)}\n`)
    return 0
  }
  if (excerpt.text.length < MIN_EXCERPT_CHARS) {
    process.stderr.write(`${LOG_PREFIX} Conversation too short, skipping.\n`)
    return 0
  }

  const cwd = hook.cwd ?? process.cwd()
  try {
    const result = await sendTranscriptCapture(
      {
        derive: 'pre-compact',
        excerpt,
        transcriptPath: hook.transcript_path,
        sessionId: hook.session_id || DEFAULT_SESSION_ID,
        project: resolveProject('auto', cwd),
        meta: {
          ...(hook.trigger ? { trigger: hook.trigger } : {}),
          cwd,
        },
        logPrefix: LOG_PREFIX,
        timeoutMs: PRE_COMPACT_POST_TIMEOUT_MS,
        // The hook is synchronous; the backlog drains on the next capture
        // that runs in the background.
        flushBudgetMs: 0,
      },
      env,
    )
    process.stderr.write(`${result.line}\n`)
    appendHookLog(env, result.line)

    const context = result.outcome?.context?.trim()
    if (context) {
      writeStdout(JSON.stringify({ additionalContext: `[Engram Memory — preserved before compaction]\n${context}` }))
    }
    return result.exitCode
  } catch (err) {
    const line = `${LOG_PREFIX} Error: ${errorText(err)}`
    process.stderr.write(`${line}\n`)
    appendHookLog(env, line)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  // A wedged local model or store call must not hold up compaction.
  setTimeout(() => process.exit(0), HOOK_WATCHDOG_MS).unref()
  let stdin = ''
  try {
    stdin = readFileSync(0, 'utf-8')
  } catch {
    // No stdin: the hook input check below reports it.
  }
  runPreCompact(stdin).then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
