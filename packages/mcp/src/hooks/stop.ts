#!/usr/bin/env node
/**
 * Claude Code Stop hook — Layer 2 salience gate.
 *
 * Fires when the assistant finishes responding to a user turn. Reads
 * the hook input JSON from stdin, detaches a background engram-ingest
 * process that classifies the LAST ASSISTANT TURN for decisions,
 * lessons, milestones, and other durable signals, and exits within
 * milliseconds.
 *
 * This is the output-side counterpart to Layer 1 (user-side capture
 * via user-prompt-submit hook). Where Layer 1 captures declared facts,
 * preferences, and plans from the user, Layer 2 captures the model's
 * own completed reasoning: decisions made, lessons learned, milestones
 * reached, summaries produced.
 *
 * The classifier prompt is shared with Layer 1 — it's the --turn flag
 * (user|assistant) that hints which categories the classifier should
 * weight toward.
 *
 * Hook input shape:
 *   { session_id, transcript_path, cwd, stop_hook_active?, ... }
 *
 * Stop hook passes stdin through unchanged on stdout so downstream
 * hooks continue to see the original event.
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const thisFile = fileURLToPath(import.meta.url)
const thisDir = dirname(thisFile)
const INGEST_CLI = resolve(thisDir, '../ingest/engram-ingest-cli.js')

interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  stop_hook_active?: boolean
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

async function main(): Promise<void> {
  const raw = await readStdin()

  // Pass through unchanged first, so any exception after this point
  // doesn't break the downstream hook pipeline.
  process.stdout.write(raw)

  if (process.env['ENGRAM_SALIENCE_DISABLED'] === '1') return

  let input: HookInput
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    return
  }

  // Avoid re-triggering when the stop hook is already active in this
  // chain. Some Claude Code setups flag recursive stops.
  if (input.stop_hook_active === true) return

  const transcript = input.transcript_path
  if (!transcript) return

  const args: string[] = [
    INGEST_CLI,
    '--transcript', transcript,
    '--turn', 'assistant',
    '--source', 'claude-code-hook-stop',
    '--verbose',
  ]
  if (input.session_id) {
    args.push('--session-id', input.session_id)
  }

  // Append-log the child's output to ~/.engram/hook.log for audit
  const logPath = join(homedir(), '.engram', 'hook.log')
  let logFd: number
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(homedir(), '.engram'), { recursive: true })
    logFd = openSync(logPath, 'a')
  } catch {
    logFd = -1
  }

  try {
    const child = spawn('node', args, {
      cwd: input.cwd ?? process.cwd(),
      env: process.env,
      detached: true,
      stdio: logFd >= 0 ? ['ignore', logFd, logFd] : 'ignore',
    })
    child.unref()
  } catch {
    // Silent fail — stdin already passed through to stdout
  }
}

const safety = setTimeout(() => {
  process.exit(0)
}, 2000)
safety.unref()

main().then(
  () => process.exit(0),
  () => process.exit(0),
)
