#!/usr/bin/env node
/**
 * engram-ingest — unified ingestion CLI for external callers.
 *
 * Used by:
 *   - Claude Code UserPromptSubmit and Stop hooks (Layers 1 & 2)
 *   - Git post-commit hooks (future)
 *   - Telegram / VPS agent workflows (future)
 *   - Manual CLI usage for ad-hoc captures
 *
 * Default behavior runs the salience classifier before storing. Pass
 * `--raw` to skip the classifier (e.g. git commit messages are always
 * stored). Pass `--dry-run` to classify and log without writing.
 *
 * With ENGRAM_SERVER_URL set, the capture is posted to the server's
 * `POST /capture` route, which runs the classifier, dedup and storage with
 * the server's model configuration; a capture the server cannot take now is
 * spooled under ~/.engram/ and resent on the next run. Without it, the same
 * pipeline runs in-process against this machine's store credentials. The
 * content, its secret scrub and the project tag are resolved here in both
 * modes.
 *
 * Usage:
 *   engram-ingest --content "..."                # classify then store
 *   engram-ingest --stdin                         # read content from stdin
 *   engram-ingest --transcript /path/to.jsonl --turn user
 *   engram-ingest --raw --content "..." --source git-commit
 *   engram-ingest --content "..." --dry-run --verbose
 *
 * Options:
 *   --content <str>              Inline content (or use --stdin / --transcript)
 *   --stdin                       Read content from stdin
 *   --transcript <path>           Read last turn from a Claude Code JSONL
 *   --turn <user|assistant|system>  Role hint for the classifier (default: system)
 *   --project <name|auto|none>    Project tag (default: auto = ENGRAM_PROJECT_ID, else the
 *                                 git repository, worktrees resolving to their main repo,
 *                                 else shared; none = shared)
 *   --source <string>             Provenance tag (claude-code-hook, git-commit, cli, ...)
 *   --session-id <string>         Session ID to attach to the memory
 *   --raw                          Skip classifier; store content as-is
 *   --no-dedup                    Skip the near-duplicate check
 *   --classifier-model <name>     Override model (local mode only; default: the summarizer's
 *                                 default chat model)
 *   --threshold <0..1>            Classifier confidence threshold (local mode only; default:
 *                                 env or 0.7)
 *   --dry-run                      Classify and log only; do not write
 *   --verbose                      Emit classifier decision to stderr
 *
 * Server mode env: ENGRAM_SERVER_URL, plus ENGRAM_SERVER_TOKEN_FILE or
 * ENGRAM_SERVER_TOKEN.
 * Local mode env: SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY (`--raw --dry-run`
 * reaches neither a model nor a store and needs none of them); optional
 * NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, ENGRAM_SALIENCE_THRESHOLD.
 * Both: ENGRAM_SALIENCE_DISABLED=1 exits without capturing.
 */

import { exitWhenFlushed } from '../cli-exit.js'
import { readFileSync } from 'node:fs'
import { CAPTURE_CONTENT_MAX_CHARS } from '../capture-route.js'
import type { CaptureInput, CaptureOutcome } from './capture.js'
import { isEntryPoint } from './entry-point.js'
import {
  CLAIM_STALE_MS,
  TURN_TIMEOUT_MS,
  captureKey,
  cwdMeta,
  sendCapture,
  type CaptureEnv,
  type CapturePayload,
} from './capture-client.js'
import { resolveProject } from './project-detect.js'
import { logRejection } from './rejection-log.js'
import { scrubModelInput } from './scrub-model-input.js'

const LOG_PREFIX = '[engram-ingest]'
const REJECTION_PREVIEW_CHARS = 300
const LOCAL_TIMEOUT_MS = 60_000
/** A server run posts its own capture, then flushes the spool for at most the claim window. */
const SERVER_TIMEOUT_MS = TURN_TIMEOUT_MS + CLAIM_STALE_MS

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type Role = 'user' | 'assistant' | 'system'

interface Args {
  help: boolean
  content: string | null
  stdin: boolean
  transcript: string | null
  turn: Role
  project: string
  source: string
  sessionId: string | null
  raw: boolean
  noDedup: boolean
  classifierModel: string | null
  threshold: number
  /** --threshold was passed (the env default does not count). */
  thresholdFlag: boolean
  dryRun: boolean
  verbose: boolean
}

function parseArgs(argv: readonly string[], env: CaptureEnv): Args {
  const envThreshold = env['ENGRAM_SALIENCE_THRESHOLD']
  const args: Args = {
    help: false,
    content: null,
    stdin: false,
    transcript: null,
    turn: 'system',
    project: 'auto',
    source: 'cli',
    sessionId: null,
    raw: false,
    noDedup: false,
    classifierModel: null,
    threshold: envThreshold ? Number.parseFloat(envThreshold) : 0.7,
    thresholdFlag: false,
    dryRun: false,
    verbose: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--content':
        args.content = argv[++i] ?? null
        break
      case '--stdin':
        args.stdin = true
        break
      case '--transcript':
        args.transcript = argv[++i] ?? null
        break
      case '--turn': {
        const v = argv[++i]
        if (v === 'user' || v === 'assistant' || v === 'system') args.turn = v
        break
      }
      case '--project':
        args.project = argv[++i] ?? 'auto'
        break
      case '--source':
        args.source = argv[++i] ?? 'cli'
        break
      case '--session-id':
        args.sessionId = argv[++i] ?? null
        break
      case '--raw':
        args.raw = true
        break
      case '--no-dedup':
        args.noDedup = true
        break
      case '--classifier-model':
        args.classifierModel = argv[++i] ?? null
        break
      case '--threshold':
        args.threshold = Number.parseFloat(argv[++i] ?? '0.7')
        args.thresholdFlag = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--verbose':
        args.verbose = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
    }
  }
  return args
}

function printUsage(): void {
  process.stderr.write(
    'Usage: engram-ingest [--content <str> | --stdin | --transcript <path>] [options]\n' +
    '  See source header for full option list.\n',
  )
}

// ---------------------------------------------------------------------------
// Content resolution
// ---------------------------------------------------------------------------

interface ResolvedContent {
  text: string
  /** The transcript entry's uuid, when the content came from --transcript. */
  uuid?: string
}

async function resolveContent(args: Args): Promise<ResolvedContent | null> {
  if (args.content) return { text: args.content.trim() }

  if (args.stdin) {
    const buf: Buffer[] = []
    for await (const chunk of process.stdin) buf.push(chunk as Buffer)
    return { text: Buffer.concat(buf).toString('utf-8').trim() }
  }

  if (args.transcript) {
    return readTranscriptLastTurn(args.transcript, args.turn)
  }

  return null
}

/**
 * Read a Claude Code JSONL transcript and extract the content of the most
 * recent turn matching the specified role, with the entry's uuid. Returns
 * null if no match.
 *
 * The Claude Code transcript format is one JSON object per line with a
 * shape like { type: 'user'|'assistant'|..., uuid, message: { role, content }, ... }.
 * We tolerate shape variance by pulling content defensively.
 */
export function readTranscriptLastTurn(path: string, role: Role): ResolvedContent | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    process.stderr.write(
      `${LOG_PREFIX} failed to read transcript ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return null
  }

  // Walk lines in reverse, find the most recent line with matching role
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      // Shape 1: { type: 'user', message: { role: 'user', content: '...' } }
      // Shape 2: { role: 'user', content: '...' }
      const type = obj['type']
      const message = obj['message'] as Record<string, unknown> | undefined
      const msgRole = (message?.['role'] ?? obj['role']) as string | undefined
      const msgContent = (message?.['content'] ?? obj['content']) as unknown

      if ((type === role || msgRole === role) && msgContent !== undefined) {
        const text = extractTextContent(msgContent)
        if (text === null) return null
        const uuid = obj['uuid']
        return typeof uuid === 'string' && uuid.length > 0 ? { text, uuid } : { text }
      }
    } catch {
      // Skip malformed lines
      continue
    }
  }
  return null
}

/**
 * Content can be a plain string or an array of content blocks
 * ({ type: 'text', text: '...' } | { type: 'tool_use', ... } | ...).
 * Return the concatenated text content only.
 */
function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
      } else if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          parts.push(b['text'])
        }
      }
    }
    const joined = parts.join('\n').trim()
    return joined.length > 0 ? joined : null
  }
  return null
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(verbose: boolean, msg: string): void {
  if (verbose) process.stderr.write(`${LOG_PREFIX} ${msg}\n`)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Raw mode always stores, and a too-short turn carries no signal worth auditing. */
function shouldLogRejection(args: Args, reason: string | undefined): boolean {
  return !args.raw && reason !== 'too_short'
}

function writeRejection(
  args: Args,
  project: string | null,
  content: string,
  verdict: { category?: string; confidence?: number; reason?: string },
): void {
  logRejection({
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    project,
    role: args.turn,
    source: args.source,
    category: verdict.category ?? 'unknown',
    confidence: verdict.confidence ?? 0,
    reason: verdict.reason ?? '',
    contentPreview: content.slice(0, REJECTION_PREVIEW_CHARS),
  })
}

// ---------------------------------------------------------------------------
// Server mode
// ---------------------------------------------------------------------------

async function runServerMode(
  args: Args,
  resolved: ResolvedContent,
  project: string | null,
  env: CaptureEnv,
): Promise<number> {
  if (args.classifierModel !== null || args.thresholdFlag) {
    process.stderr.write(
      `${LOG_PREFIX} --classifier-model and --threshold apply to local mode only; ` +
        'with ENGRAM_SERVER_URL set the server decides the model and threshold\n',
    )
    return 2
  }

  const content = (await scrubModelInput(resolved.text, LOG_PREFIX)).slice(0, CAPTURE_CONTENT_MAX_CHARS)
  const payload: CapturePayload = {
    content,
    source: args.source,
    role: args.turn,
    project_id: project,
    gate: !args.raw,
    dedup: !args.noDedup,
    dry_run: args.dryRun,
    // The server checks a key only within its session; without a session id
    // a key would promise idempotency it cannot give, so dedup is the guard.
    ...(args.sessionId
      ? { session_id: args.sessionId, key: captureKey(args.source, args.sessionId, resolved.uuid ?? content) }
      : {}),
    // cwd lets a later retag recover the project of a capture made outside a repository.
    meta: { capturedAt: new Date().toISOString(), ...cwdMeta(process.cwd(), LOG_PREFIX) },
  }

  const sent = await sendCapture(payload, env, { label: 'engram-ingest' })
  process.stderr.write(`${sent.line}\n`)

  if (!sent.result.ok) return sent.disposition === 'dead' ? 1 : 0
  const outcome: CaptureOutcome = sent.result.outcome
  log(args.verbose, `server: outcome=${outcome.outcome} category=${outcome.category ?? '-'} reason="${outcome.reason ?? ''}"`)
  if (outcome.outcome === 'rejected' && shouldLogRejection(args, outcome.reason)) {
    writeRejection(args, project, content, outcome)
  }
  return 0
}

// ---------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------

async function runLocalMode(
  args: Args,
  resolved: ResolvedContent,
  project: string | null,
  env: CaptureEnv,
): Promise<number> {
  const startMs = Date.now()
  // Loaded on demand so server mode never loads the model and store clients.
  const { runLocalCapture } = await import('./local-capture.js')
  const input: CaptureInput = {
    content: resolved.text,
    role: args.turn,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    project,
    source: args.source,
    gate: !args.raw,
    dedup: !args.noDedup,
    dryRun: args.dryRun,
  }
  const { outcome, model } = await runLocalCapture(input, {
    env,
    classifierModel: args.classifierModel,
    threshold: args.threshold,
    logPrefix: LOG_PREFIX,
    ...(args.verbose ? { log: (line: string) => log(true, line) } : {}),
    onRejected: (rejected) => {
      if (!shouldLogRejection(args, rejected.classification.reason)) return
      writeRejection(args, rejected.project, rejected.content, rejected.classification)
    },
  })
  process.stderr.write(
    `${LOG_PREFIX} mode=local model=${model} source=${args.source} outcome=${outcome.outcome} ms=${Date.now() - startMs}\n`,
  )
  // The local mode has no dead-letter file: an unclassifiable turn fails
  // the run so the hook's log shows it.
  if (outcome.outcome === 'error') {
    process.stderr.write(`${LOG_PREFIX} capture failed (${outcome.reason ?? 'error'}): ${outcome.message ?? ''}\n`)
    return 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Runs one ingest and returns the process exit code. */
export async function runIngestCli(argv: readonly string[], env: CaptureEnv = process.env): Promise<number> {
  const args = parseArgs(argv, env)
  if (args.help) {
    printUsage()
    return 0
  }

  if (env['ENGRAM_SALIENCE_DISABLED'] === '1') {
    log(args.verbose, 'salience disabled via env, exiting')
    return 0
  }

  const resolved = await resolveContent(args)
  if (!resolved || !resolved.text) {
    log(args.verbose, 'no content to ingest, exiting')
    return 0
  }

  const project = resolveProject(args.project, process.cwd())
  log(args.verbose, `project: ${project ?? '<shared>'} (flag=${args.project})`)

  try {
    return env['ENGRAM_SERVER_URL']
      ? await runServerMode(args, resolved, project, env)
      : await runLocalMode(args, resolved, project, env)
  } catch (err) {
    // A missing credential is a configuration message, not a crash.
    const isMissingEnv = err instanceof Error && err.name === 'MissingEnvError'
    const detail = isMissingEnv ? errorText(err) : `FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
    process.stderr.write(`${LOG_PREFIX} ${detail}\n`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  // Hard timeout in case something upstream wedges (network, store, graph).
  // Exit cleanly so the spawning hook doesn't hold resources. Server mode
  // outlasts its own post plus the spool flush, so a flush is never cut off
  // mid-claim.
  const timeoutMs = process.env['ENGRAM_SERVER_URL'] ? SERVER_TIMEOUT_MS : LOCAL_TIMEOUT_MS
  const timeoutId = setTimeout(() => {
    process.stderr.write(`${LOG_PREFIX} timeout after ${timeoutMs / 1000}s, exiting\n`)
    void exitWhenFlushed(3)
  }, timeoutMs)
  timeoutId.unref()

  // Force a clean exit even if HTTP or store clients hold keep-alive agents
  // or background timers.
  runIngestCli(process.argv.slice(2)).then(
    (code) => exitWhenFlushed(code),
    (err: unknown) => {
      process.stderr.write(`${LOG_PREFIX} FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
      return exitWhenFlushed(1)
    },
  )
}
