#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook — Layer 1 salience gate.
 *
 * Fires before the assistant processes each user message. Reads the
 * hook input JSON from stdin, detaches a background engram-ingest
 * process to classify and (conditionally) store the user's turn, and
 * exits within milliseconds so the user sees no lag.
 *
 * Hook input shape from Claude Code:
 *   {
 *     session_id: string,
 *     transcript_path: string,
 *     cwd: string,
 *     trigger?: string,
 *     ...
 *   }
 *
 * Must pass stdin through unchanged on stdout so downstream hooks in
 * the pipeline still receive the original event.
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve the engram-ingest CLI script relative to this hook file.
// Both live in the same packages/mcp/dist tree after build.
const thisFile = fileURLToPath(import.meta.url)
const thisDir = dirname(thisFile)
const INGEST_CLI = resolve(thisDir, '../ingest/engram-ingest-cli.js')

interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  trigger?: string
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

async function main(): Promise<void> {
  const raw = await readStdin()

  // Pass through unchanged so downstream hooks receive the same event.
  // We do this FIRST so any exception path doesn't break the pipeline.
  process.stdout.write(raw)

  if (process.env['ENGRAM_SALIENCE_DISABLED'] === '1') return

  let input: HookInput
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    // Malformed hook input — nothing we can do, just exit clean
    return
  }

  const transcript = input.transcript_path
  if (!transcript) return

  // Build engram-ingest args. We use --transcript mode with --turn user
  // so the CLI reads the last user message directly from the JSONL file.
  const args: string[] = [
    INGEST_CLI,
    '--transcript', transcript,
    '--turn', 'user',
    '--source', 'claude-code-hook',
    '--verbose',
  ]
  if (input.session_id) {
    args.push('--session-id', input.session_id)
  }

  // Project is detected from cwd inside engram-ingest. We can also
  // override here, but letting the CLI use process.cwd() works because
  // the child process inherits cwd from the parent hook process.

  // Log child process stdout and stderr to ~/.engram/hook.log so we
  // can audit the classifier's decisions and debug failures without
  // blocking the user's prompt. Append-open gives us a persistent
  // record across sessions.
  const logPath = join(homedir(), '.engram', 'hook.log')
  let logFd: number
  try {
    // Ensure directory exists. Use mkdirSync because this hook runs
    // before the async pipeline.
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
    // Spawn failed — don't block the user prompt. Silent fail is
    // correct here because the hook already wrote stdin through to
    // stdout and the pipeline continues.
  }
}

// Hard safety timeout: if anything wedges, exit within 2 seconds.
// The hook's only contract is "write stdin to stdout and exit quickly".
const safety = setTimeout(() => {
  process.exit(0)
}, 2000)
safety.unref()

main().then(
  () => process.exit(0),
  () => process.exit(0),
)
