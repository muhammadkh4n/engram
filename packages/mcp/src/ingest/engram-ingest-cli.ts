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
 * Every storable ingestion flows through Memory.ingest(), which means
 * the full Wave 2 pipeline runs: SQL insert + LLM entity extraction +
 * Neo4j graph decomposition. One entry point, one pipeline, no special
 * cases.
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
 *   --project <name|auto|none>    Project scope (default: auto) [Phase 2]
 *   --source <string>             Provenance tag (claude-code-hook, git-commit, cli, ...)
 *   --session-id <string>         Session ID to attach to the memory
 *   --raw                          Skip classifier; store content as-is
 *   --no-dedup                    Skip dedup check [Phase 2]
 *   --classifier-model <name>     Override model (default: gpt-4o-mini)
 *   --threshold <0..1>            Classifier confidence threshold (default: env or 0.7)
 *   --dry-run                      Classify and log only; do not write
 *   --verbose                      Emit classifier decision to stderr
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY
 * Optional env: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD,
 *               ENGRAM_SALIENCE_THRESHOLD, ENGRAM_SALIENCE_DISABLED
 */

import { readFileSync } from 'node:fs'
import { createMemory } from '@engram-mem/core'
import type { SalienceClassification } from '@engram-mem/core'
import { SupabaseStorageAdapter } from '@engram-mem/supabase'
import { openaiIntelligence } from '@engram-mem/openai'
import { tryCreateGraph } from '../graph-helper.js'
import { resolveProject } from './project-detect.js'
import { findDuplicate, boostDuplicate } from './dedup.js'
import { logRejection } from './rejection-log.js'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Args {
  content: string | null
  stdin: boolean
  transcript: string | null
  turn: 'user' | 'assistant' | 'system'
  project: string
  source: string
  sessionId: string | null
  raw: boolean
  noDedup: boolean
  classifierModel: string | null
  threshold: number
  dryRun: boolean
  verbose: boolean
}

function parseArgs(argv: string[]): Args {
  const envThreshold = process.env['ENGRAM_SALIENCE_THRESHOLD']
  const args: Args = {
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
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--verbose':
        args.verbose = true
        break
      case '--help':
      case '-h':
        printUsageAndExit(0)
        break
    }
  }
  return args
}

function printUsageAndExit(code: number): never {
  process.stderr.write(
    'Usage: engram-ingest [--content <str> | --stdin | --transcript <path>] [options]\n' +
    '  See source header for full option list.\n',
  )
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Content resolution
// ---------------------------------------------------------------------------

async function resolveContent(args: Args): Promise<string | null> {
  if (args.content) return args.content.trim()

  if (args.stdin) {
    const buf: Buffer[] = []
    for await (const chunk of process.stdin) buf.push(chunk as Buffer)
    return Buffer.concat(buf).toString('utf-8').trim()
  }

  if (args.transcript) {
    return readTranscriptLastTurn(args.transcript, args.turn)
  }

  return null
}

/**
 * Read a Claude Code JSONL transcript and extract the content of the most
 * recent turn matching the specified role. Returns null if no match.
 *
 * The Claude Code transcript format is one JSON object per line with a
 * shape like { type: 'user'|'assistant'|..., message: { role, content }, ... }.
 * We tolerate shape variance by pulling content defensively.
 */
function readTranscriptLastTurn(
  path: string,
  role: 'user' | 'assistant' | 'system',
): string | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    process.stderr.write(
      `[engram-ingest] failed to read transcript ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
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
        return extractTextContent(msgContent)
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
  if (verbose) process.stderr.write(`[engram-ingest] ${msg}\n`)
}

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    process.stderr.write(`[engram-ingest] missing required env: ${name}\n`)
    process.exit(1)
  }
  return val
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Kill switch
  if (process.env['ENGRAM_SALIENCE_DISABLED'] === '1') {
    log(args.verbose, 'salience disabled via env, exiting')
    process.exit(0)
  }

  const content = await resolveContent(args)
  if (!content) {
    log(args.verbose, 'no content to ingest, exiting')
    process.exit(0)
  }

  if (content.length < 2) {
    log(args.verbose, `content too short (${content.length} chars)`)
    process.exit(0)
  }

  // --- Project resolution ---
  const project = resolveProject(args.project, process.cwd())
  log(args.verbose, `project: ${project} (flag=${args.project})`)

  // --- Classification ---
  let classification: SalienceClassification
  if (args.raw) {
    classification = {
      store: true,
      category: 'fact',
      confidence: 1,
      distilled: content,
      reason: 'raw_mode',
    }
  } else {
    const openaiKey = requireEnv('OPENAI_API_KEY')
    const intelligence = openaiIntelligence({
      apiKey: openaiKey,
      ...(args.classifierModel ? { summarizationModel: args.classifierModel } : {}),
    })

    if (!intelligence.extractSalience) {
      process.stderr.write('[engram-ingest] intelligence adapter lacks extractSalience\n')
      process.exit(2)
    }

    classification = await intelligence.extractSalience(content, {
      turnRole: args.turn,
      project,
    })
  }

  log(
    args.verbose,
    `classifier: store=${classification.store} category=${classification.category} confidence=${classification.confidence.toFixed(2)} reason="${classification.reason}"`,
  )

  // --- Gate ---
  if (!classification.store || classification.confidence < args.threshold) {
    // Append to rolling rejection log for audit + prompt tuning.
    // Skip logging for --raw mode because raw mode always stores, and
    // for the too-short short-circuit (no useful signal there).
    if (!args.raw && classification.reason !== 'too_short') {
      logRejection({
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        project,
        role: args.turn,
        source: args.source,
        category: classification.category,
        confidence: classification.confidence,
        reason: classification.reason,
        contentPreview: content.slice(0, 300),
      })
    }
    log(
      args.verbose,
      `rejected: store=${classification.store} confidence=${classification.confidence.toFixed(2)} threshold=${args.threshold}`,
    )
    process.exit(0)
  }

  if (args.dryRun) {
    log(args.verbose, `[dry-run] would store: "${classification.distilled}"`)
    process.exit(0)
  }

  // --- Ingest ---
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const supabaseKey = requireEnv('SUPABASE_KEY')
  const openaiKey = requireEnv('OPENAI_API_KEY')

  const storage = new SupabaseStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  const intelligence = openaiIntelligence({ apiKey: openaiKey })

  // --- Dedup gate ---
  // Fires BEFORE the graph/memory stack is constructed so we avoid the
  // cost of initializing Neo4j on the duplicate path.
  if (!args.noDedup) {
    await storage.initialize()
    try {
      const dup = await findDuplicate(classification.distilled, storage, intelligence, {
        project,
      })
      if (args.verbose && dup.debug) {
        const d = dup.debug
        log(
          args.verbose,
          `dedup: candidates=${d.candidatesReturned} topSim=${d.topSimilarity.toFixed(3)} topProj=${d.topProject ?? 'null'} rejByThresh=${d.rejectedByThreshold} rejByWindow=${d.rejectedByWindow} rejByProj=${d.rejectedByProject}`,
        )
      }
      if (dup.duplicateId) {
        await boostDuplicate(storage, dup.duplicateId)
        log(
          args.verbose,
          `deduped: existing=${dup.duplicateId.slice(0, 8)} similarity=${dup.similarity.toFixed(3)}`,
        )
        await storage.dispose()
        return
      }
    } finally {
      // Dispose the shallow storage before constructing the full Memory.
      // This avoids double-dispose later.
      await storage.dispose().catch(() => {})
    }
  }

  // --- Full Memory construction + ingest ---
  // Use a fresh storage instance because we disposed the dedup-check one.
  const ingestStorage = new SupabaseStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  const graph = await tryCreateGraph('[engram-ingest]')

  const memory = createMemory({
    storage: ingestStorage,
    intelligence,
    ...(graph ? { graph } : {}),
  })
  await memory.initialize()

  try {
    await memory.ingest({
      content: classification.distilled,
      role: args.turn,
      sessionId: args.sessionId ?? undefined,
      metadata: {
        salienceCategory: classification.category,
        salienceConfidence: classification.confidence,
        salienceReason: classification.reason,
        source: args.source,
        project,
        rawTurn: content.slice(0, 4000),
      },
    })
    // Wait for fire-and-forget graph decomposition to finish before the
    // process exits. Without this, the CLI can return immediately after
    // the SQL insert and process.exit() kills the inflight Neo4j write.
    await memory.flushPendingWrites()
    log(args.verbose, `stored as ${classification.category} in project=${project}`)
  } finally {
    await memory.dispose()
  }
}

// Hard timeout in case something upstream wedges (OpenAI network, Supabase,
// Neo4j). Exit cleanly so the spawning hook doesn't hold resources.
const timeoutId = setTimeout(() => {
  process.stderr.write('[engram-ingest] timeout after 60s, exiting\n')
  process.exit(3)
}, 60_000)
timeoutId.unref()

main()
  .then(() => {
    // Force a clean exit even if OpenAI / Supabase clients are holding
    // onto keep-alive agents or background timers.
    process.exit(0)
  })
  .catch((err) => {
    process.stderr.write(
      `[engram-ingest] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    )
    process.exit(1)
  })
