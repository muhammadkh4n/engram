/**
 * Engram — OpenClaw ContextEngine plugin.
 *
 * IMPORTANT for plugin developers:
 * - OpenClaw calls afterTurn EXCLUSIVELY when it exists on the engine.
 *   If afterTurn is present, ingest/ingestBatch are NEVER called.
 *   afterTurn must handle all message persistence itself.
 * - api.pluginConfig has the plugin-specific config (not api.config which is the full OpenClaw config).
 * - AgentMessage.content can be string OR ContentPart[] — always extract text parts.
 *
 * Built by tsup → dist/openclaw-plugin.js. Loaded by OpenClaw at runtime.
 */

// @ts-ignore — openclaw only exists at runtime on the host
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { Type } from '@sinclair/typebox'
import { Memory } from '@engram-mem/core'
import { SqliteStorageAdapter } from '@engram-mem/sqlite'
import { SupabaseStorageAdapter } from '@engram-mem/supabase'
import { openaiIntelligence } from '@engram-mem/openai'
import type { StorageAdapter, IntelligenceAdapter } from '@engram-mem/core'
import * as fs from 'node:fs'
import { shouldIngest } from './ingest-filter.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EPISODE_CHARS = 10_000
const AUTO_CONSOLIDATE_THRESHOLD = 100 // trigger light sleep every N episodes
const VERSION = '0.2.0'
const SESSION_IMPORT_CAP = 500 // max messages to import from historical session file

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentPart {
  type: string
  text?: string
  name?: string        // tool name
  input?: unknown      // tool args
  content?: unknown    // tool result content
  [key: string]: unknown
}

interface AgentMessage {
  role: string
  content: string | ContentPart[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip OpenClaw message headers that every external-channel message carries.
 * These headers are metadata prepended by the runtime — they are NOT part of
 * what the user said and they poison both ingest filtering and recall queries:
 *   - BM25 uses AND between terms, so "Node: RexBook … webhook hub" requires
 *     ALL terms to be present → 0 BM25 matches for any real content.
 *   - Embedding is diluted by device names, IPs, build numbers.
 *   - shouldIngest sees "Sender (untrusted)" at position 0 and drops the msg.
 */
function stripOpenClawHeaders(text: string): string {
  return text
    // "Sender (untrusted) · Name" or "Sender (untrusted metadata): ..."
    .replace(/^Sender \(untrusted[^)]*\)[^\n]*\n/gm, '')
    // "Node: DeviceName (IP) · app version (build) · mode remote"
    .replace(/^Node:\s+\S+[^\n]*·\s*mode\s+\w+\s*\n/gm, '')
    // "Conversation info (untrusted metadata):" + optional fenced block
    .replace(/^Conversation info[^\n]*\n(?:```[\s\S]*?```\s*\n?)?/m, '')
    // "OpenClaw runtime context (internal): ..." (single-line prefix)
    .replace(/^OpenClaw runtime context \(internal\):[^\n]*\n/gm, '')
    // Collapse leftover blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract text from an AgentMessage for use as a recall query string.
 * Also used for the shouldIngest filter — stripping OpenClaw headers is
 * critical so the filter sees the user's actual content, not metadata.
 *
 * NOT used for ingest content — Memory.ingest() receives raw content and
 * lets parseContent handle the text/tool separation.
 */
function extractTextForQuery(content: string | ContentPart[]): string {
  let raw: string
  if (typeof content === 'string') {
    raw = content
  } else if (!Array.isArray(content)) {
    raw = String(content)
  } else {
    const textParts: string[] = []
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text)
      }
      // Tool calls, tool results, images — not useful as recall query text.
    }
    raw = textParts.join('\n')
  }
  return stripOpenClawHeaders(raw)
}

/** Truncate content to MAX_EPISODE_CHARS with a marker. */
function truncate(text: string): string {
  if (text.length <= MAX_EPISODE_CHARS) return text
  return text.slice(0, MAX_EPISODE_CHARS) + '\n[truncated — ' + (text.length - MAX_EPISODE_CHARS) + ' chars omitted]'
}

/** Extract last user message as query. */
function extractQuery(messages: AgentMessage[], prompt?: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const text = extractTextForQuery(messages[i].content)
      if (text.length > 0) return text
    }
  }
  return prompt ?? ''
}

/** Expand ~ to $HOME in a path. */
function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return (process.env.HOME ?? '/root') + p.slice(1)
  }
  return p
}

// ---------------------------------------------------------------------------
// Session serialization queue
// Prevents concurrent afterTurn/compact calls on the same session from
// interleaving and causing SQLite write conflicts.
// ---------------------------------------------------------------------------

const sessionQueues = new Map<string, Promise<void>>()

function withSessionQueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionQueues.get(sessionId) ?? Promise.resolve()
  // Run fn regardless of whether the previous operation succeeded or failed.
  const next = prev.then(fn, fn)
  // Update the chain, swallowing the result so the chain stays void-typed.
  sessionQueues.set(sessionId, next.then(() => {}, () => {}))
  return next
}

// ---------------------------------------------------------------------------
// Session file import
// Reads a JSONL (or JSON array) session file and ingests historical messages
// into Engram so the agent doesn't start with amnesia.
// ---------------------------------------------------------------------------

async function importSessionFile(
  memory: Memory,
  sessionId: string,
  sessionFile: string
): Promise<void> {
  const resolvedPath = expandHome(sessionFile)

  // Skip if file doesn't exist
  if (!fs.existsSync(resolvedPath)) return

  // Skip if already imported — check by marker file
  const markerPath = resolvedPath + '.engram-imported'
  if (fs.existsSync(markerPath)) return

  // Also skip if episodes already exist for this session (e.g. previous run
  // without a marker file, or DB was pre-populated).
  // We do a lightweight check by attempting to read the raw file first —
  // after reading we'll do the episode check only if the file has content.

  let rawContent: string
  try {
    rawContent = fs.readFileSync(resolvedPath, 'utf-8')
  } catch {
    return // can't read file — non-fatal
  }

  if (!rawContent.trim()) return

  // Parse messages — support both JSONL and JSON array formats
  const messages: AgentMessage[] = []
  const trimmed = rawContent.trim()

  if (trimmed.startsWith('[')) {
    // JSON array format
    try {
      const parsed = JSON.parse(trimmed) as unknown[]
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          const msg = item as Record<string, unknown>
          if (typeof msg.role === 'string' && (typeof msg.content === 'string' || Array.isArray(msg.content))) {
            messages.push({ role: msg.role, content: msg.content as string | ContentPart[] })
          }
        }
      }
    } catch {
      return // malformed JSON — non-fatal
    }
  } else {
    // JSONL format — one JSON object per line
    for (const line of trimmed.split('\n')) {
      const l = line.trim()
      if (!l) continue
      try {
        const parsed = JSON.parse(l) as unknown
        if (parsed && typeof parsed === 'object') {
          const msg = parsed as Record<string, unknown>
          if (typeof msg.role === 'string' && (typeof msg.content === 'string' || Array.isArray(msg.content))) {
            messages.push({ role: msg.role, content: msg.content as string | ContentPart[] })
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  if (messages.length === 0) return

  // Cap to last SESSION_IMPORT_CAP messages to avoid importing massive histories
  const toImport = messages.slice(-SESSION_IMPORT_CAP)

  // Ingest each message — pass raw content so Memory.ingest() → parseContent
  // handles the text/tool separation. shouldIngest checks derived text length.
  for (const msg of toImport) {
    const validRoles = new Set(['user', 'assistant', 'system'])
    const role = validRoles.has(msg.role) ? (msg.role as 'user' | 'assistant' | 'system') : 'user'
    // For shouldIngest we need a text representation to check length/noise.
    const textForFilter = extractTextForQuery(msg.content)
    if (textForFilter.length < 2) continue
    if (!shouldIngest(truncate(textForFilter), msg.role)) continue
    await memory.ingest({ sessionId, role, content: msg.content })
  }

  // Write marker file so we don't re-import on the next bootstrap
  try {
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8')
  } catch {
    // non-fatal — we'll just re-import next time (idempotent enough)
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: 'engram',
  name: 'Engram Cognitive Memory',
  description:
    'Brain-inspired cognitive memory engine with 5 memory systems, intent-driven recall, and consolidation cycles',
  kind: 'context-engine',
  configSchema: Type.Object({
    storagePath: Type.Optional(Type.String({ default: '~/.openclaw/engram.db' })),
    supabaseUrl: Type.Optional(Type.String()),
    supabaseKey: Type.Optional(Type.String()),
    openaiApiKey: Type.Optional(Type.String()),
  }),

  register(api: {
    config?: Record<string, unknown>
    pluginConfig?: Record<string, unknown>
    registerContextEngine: (id: string, factory: () => unknown) => void
    registerTool: (tool: unknown) => void
  }) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>

    // ---------------------------------------------------------------------------
    // Storage backend auto-detection
    // Prefer Supabase (pgvector) when credentials are present, fall back to SQLite.
    // ---------------------------------------------------------------------------
    let storage: StorageAdapter

    const supabaseUrl = (cfg.supabaseUrl as string | undefined) ?? process.env.SUPABASE_URL
    const supabaseKey = (cfg.supabaseKey as string | undefined) ?? process.env.SUPABASE_SERVICE_KEY

    if (supabaseUrl && supabaseKey) {
      storage = new SupabaseStorageAdapter({ url: supabaseUrl, key: supabaseKey })
      console.log('[engram] Using Supabase storage (pgvector + cosine similarity)')
    } else {
      const storagePath = expandHome(
        (cfg.storagePath as string | undefined) ??
        '~/.openclaw/engram.db'
      )
      storage = new SqliteStorageAdapter(storagePath)
      console.log('[engram] Using SQLite storage (BM25 keyword search)')
    }

    // ---------------------------------------------------------------------------
    // Intelligence adapter (OpenAI embeddings + LLM summarization)
    // ---------------------------------------------------------------------------
    const openaiKey = (cfg.openaiApiKey as string | undefined) ?? process.env.OPENAI_API_KEY
    let intelligence: IntelligenceAdapter | undefined
    if (openaiKey) {
      try {
        intelligence = openaiIntelligence({
          apiKey: openaiKey,
          embeddingModel: 'text-embedding-3-small',
          embeddingDimensions: 1536,
        })
        console.log('[engram] OpenAI intelligence enabled (vector embeddings + LLM summarization)')
      } catch (err) {
        console.warn('[engram] OpenAI init failed, falling back to BM25:', err)
      }
    } else {
      console.log('[engram] No OPENAI_API_KEY — using BM25 keyword search (Level 0)')
    }

    const memory = new Memory({ storage, intelligence })

    let initialized = false
    // dbReady tracks whether DB initialized successfully.
    // ownsCompaction is set to dbReady so OpenClaw's built-in compaction takes
    // over when our DB fails to initialize.
    let dbReady = false
    let episodesSinceConsolidation = 0

    // Tools may be called before bootstrap() — ensure memory is initialized
    async function ensureInitialized(): Promise<boolean> {
      if (initialized && dbReady) return true
      if (initialized && !dbReady) return false // init was attempted and failed
      try {
        await memory.initialize()
        initialized = true
        dbReady = true
        return true
      } catch (err) {
        console.error('[engram] lazy init failed:', err)
        initialized = true
        dbReady = false
        return false
      }
    }

    // -----------------------------------------------------------------------
    // Context Engine
    // -----------------------------------------------------------------------

    api.registerContextEngine('engram', () => ({
      get info() {
        return { id: 'engram', name: 'Engram', version: VERSION, ownsCompaction: dbReady }
      },

      async bootstrap({ sessionId, sessionFile }: { sessionId: string; sessionKey?: string; sessionFile: string }) {
        if (!initialized) {
          try {
            await memory.initialize()
            initialized = true
            dbReady = true
          } catch (err) {
            console.error('[engram] bootstrap DB init failed:', err)
            return { bootstrapped: false, reason: 'DB init failed: ' + String(err) }
          }
        }

        // Import historical messages from session file (if exists and not already imported)
        try {
          await importSessionFile(memory, sessionId, sessionFile)
        } catch (err) {
          console.error('[engram] session file import error:', err)
          // Non-fatal — we can still function without history
        }

        return { bootstrapped: true }
      },

      // ingest/ingestBatch are defined for completeness but OpenClaw will NOT
      // call them when afterTurn exists. They serve as fallback for runtimes
      // that don't use afterTurn.

      async ingest({ sessionId, message, isHeartbeat }: {
        sessionId: string; message: AgentMessage; isHeartbeat?: boolean
      }) {
        if (!(await ensureInitialized())) return { ingested: false }
        if (isHeartbeat) return { ingested: false }
        // Use text representation only for the shouldIngest filter.
        const textForFilter = truncate(extractTextForQuery(message.content))
        if (textForFilter.length < 2) return { ingested: false }
        if (!shouldIngest(textForFilter, message.role)) return { ingested: false }
        try {
          await memory.ingest({ sessionId, role: message.role as 'user' | 'assistant' | 'system', content: message.content })
          episodesSinceConsolidation++
          return { ingested: true }
        } catch (err) {
          console.error('[engram] ingest error:', err)
          return { ingested: false }
        }
      },

      async ingestBatch({ sessionId, messages, isHeartbeat }: {
        sessionId: string; messages: AgentMessage[]; isHeartbeat?: boolean
      }) {
        if (!(await ensureInitialized())) return { ingestedCount: 0 }
        if (isHeartbeat) return { ingestedCount: 0 }
        let count = 0
        for (const msg of messages) {
          const textForFilter = truncate(extractTextForQuery(msg.content))
          if (textForFilter.length < 2) continue
          if (!shouldIngest(textForFilter, msg.role)) continue
          try {
            await memory.ingest({ sessionId, role: msg.role as 'user' | 'assistant' | 'system', content: msg.content })
            count++
          } catch (err) {
            console.error('[engram] ingestBatch error:', err)
          }
        }
        episodesSinceConsolidation += count
        return { ingestedCount: count }
      },

      async assemble({ messages, tokenBudget, prompt }: {
        sessionId: string; messages: AgentMessage[]; tokenBudget?: number; prompt?: string; model?: string
      }) {
        // Pass-through when DB not ready — no memory injection
        if (!(await ensureInitialized())) return { messages, estimatedTokens: 0 }

        const query = extractQuery(messages, prompt)
        if (!query) return { messages, estimatedTokens: 0 }
        try {
          const result = await memory.recall(query, { tokenBudget })
          console.log(`[engram] assemble: query="${query.slice(0, 80)}" intent=${result.intent.type} memories=${result.memories.length} assoc=${result.associations.length} tokens=${result.estimatedTokens}`)
          if (result.memories.length > 0) {
            console.log(`[engram] top hit: [${result.memories[0].type}] relevance=${result.memories[0].relevance.toFixed(3)} "${result.memories[0].content.slice(0, 80)}"`)
          }
          return {
            messages,
            estimatedTokens: result.estimatedTokens,
            systemPromptAddition: result.formatted || undefined,
          }
        } catch (err) {
          console.error('[engram] assemble error:', err)
          return { messages, estimatedTokens: 0 }
        }
      },

      async compact() {
        if (!(await ensureInitialized())) {
          return { ok: false, compacted: false, reason: 'Engram DB not initialized' }
        }
        // Wrap in session queue using a fixed key for compaction — compaction
        // is global (not per-session) so we serialize under a sentinel key.
        return withSessionQueue('__compact__', async () => {
          try {
            await memory.consolidate('light')
            episodesSinceConsolidation = 0
            return { ok: true, compacted: true }
          } catch (err) {
            console.error('[engram] compact error:', err)
            return { ok: false, compacted: false, reason: String(err) }
          }
        })
      },

      /**
       * CRITICAL: OpenClaw calls afterTurn EXCLUSIVELY when it exists.
       * ingest/ingestBatch are skipped. We must persist messages here.
       *
       * messages = full session history. messages[prePromptMessageCount:] = new this turn.
       */
      async afterTurn({ sessionId, messages, prePromptMessageCount, isHeartbeat }: {
        sessionId: string; sessionFile: string; messages: AgentMessage[]
        prePromptMessageCount: number; isHeartbeat?: boolean; tokenBudget?: number
      }) {
        if (!(await ensureInitialized())) return
        if (isHeartbeat) return

        return withSessionQueue(sessionId, async () => {
          // Ingest only the new messages from this turn.
          // Pass raw content to memory.ingest() — parseContent handles the
          // text/tool separation inside Memory. shouldIngest operates on
          // extracted text for message-level noise filtering only.
          const newMessages = messages.slice(prePromptMessageCount)
          for (const msg of newMessages) {
            const textForFilter = truncate(extractTextForQuery(msg.content))
            if (textForFilter.length < 2) continue
            if (!shouldIngest(textForFilter, msg.role)) continue
            try {
              await memory.ingest({
                sessionId,
                role: msg.role as 'user' | 'assistant' | 'system',
                content: msg.content,
              })
              episodesSinceConsolidation++
            } catch (err) {
              console.error('[engram] afterTurn ingest error:', err)
            }
          }

          // Auto-consolidation: trigger light sleep when enough episodes accumulate
          if (episodesSinceConsolidation >= AUTO_CONSOLIDATE_THRESHOLD) {
            try {
              await memory.consolidate('light')
              episodesSinceConsolidation = 0
            } catch (err) {
              console.error('[engram] auto-consolidation error:', err)
            }
          }
        })
      },

      async dispose() {
        await memory.dispose()
        initialized = false
        dbReady = false
      },
    }))

    // -----------------------------------------------------------------------
    // Agent tools
    // -----------------------------------------------------------------------

    api.registerTool({
      name: 'engram_search',
      label: 'Search Memory',
      description: 'Deep search across all memory systems (episodes, semantic, procedural)',
      parameters: Type.Object({
        query: Type.String({ description: 'Search query' }),
      }),
      async execute(_id: unknown, params: { query: string }) {
        if (!(await ensureInitialized())) {
          return { content: [{ type: 'text' as const, text: 'Engram memory not available (DB init failed)' }] }
        }
        const result = await memory.recall(params.query)
        return {
          content: [{ type: 'text' as const, text: result.formatted || 'No memories found.' }],
          details: { memoriesFound: result.memories.length },
        }
      },
    })

    api.registerTool({
      name: 'engram_stats',
      label: 'Memory Stats',
      description: 'Get memory statistics: episode, digest, semantic, procedural counts',
      parameters: Type.Object({}),
      async execute() {
        if (!(await ensureInitialized())) {
          return { content: [{ type: 'text' as const, text: 'Engram memory not available' }] }
        }
        const stats = await memory.stats()
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
          details: stats,
        }
      },
    })

    api.registerTool({
      name: 'engram_forget',
      label: 'Forget Memory',
      description: 'Deprioritize memories matching a query (lossless — never deletes)',
      parameters: Type.Object({
        query: Type.String({ description: 'What to forget' }),
        confirm: Type.Optional(Type.Boolean({ default: false, description: 'Set true to confirm' })),
      }),
      async execute(_id: unknown, params: { query: string; confirm?: boolean }) {
        if (!(await ensureInitialized())) {
          return { content: [{ type: 'text' as const, text: 'Engram memory not available' }] }
        }
        const result = await memory.forget(params.query, { confirm: params.confirm })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        }
      },
    })

    api.registerTool({
      name: 'engram_consolidate',
      label: 'Consolidate Memory',
      description: 'Run memory consolidation: light (episodes→digests), deep (→knowledge), dream (→associations), decay',
      parameters: Type.Object({
        cycle: Type.Optional(Type.Union([
          Type.Literal('light'), Type.Literal('deep'), Type.Literal('dream'),
          Type.Literal('decay'), Type.Literal('all'),
        ], { default: 'all' })),
      }),
      async execute(_id: unknown, params: { cycle?: string }) {
        if (!(await ensureInitialized())) {
          return { content: [{ type: 'text' as const, text: 'Engram memory not available' }] }
        }
        const result = await memory.consolidate((params.cycle as 'light' | 'deep' | 'dream' | 'decay' | 'all') ?? 'all')
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        }
      },
    })
  },
})
