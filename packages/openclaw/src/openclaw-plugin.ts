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
import { Memory } from '@engram/core'
import { SqliteStorageAdapter } from '@engram/sqlite'
import type { StorageAdapter } from '@engram/core'
import * as fs from 'node:fs'

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

/** Extract human-readable text AND preserve raw parts from AgentMessage.content.
 *  - text parts: extracted as-is
 *  - tool_use / toolCall: summarized as [Tool call: name]
 *  - tool_result / toolResult: text content extracted
 *  - image / thinking: skipped (not useful for text search)
 *  rawParts is set when content is an array, for later reconstruction. */
function extractContent(content: string | ContentPart[]): { text: string; rawParts?: ContentPart[] } {
  if (typeof content === 'string') return { text: content }
  if (!Array.isArray(content)) return { text: String(content) }

  const textParts: string[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text)
    } else if (part.type === 'tool_use' || part.type === 'toolCall') {
      // Summarize tool call for searchability
      const name = (part.name as string | undefined) ?? (part as Record<string, unknown>).toolName as string | undefined ?? 'unknown_tool'
      textParts.push(`[Tool call: ${name}]`)
    } else if (part.type === 'tool_result' || part.type === 'toolResult') {
      // Extract text from tool result content
      const resultContent = part.content
      if (typeof resultContent === 'string') {
        textParts.push(resultContent)
      } else if (Array.isArray(resultContent)) {
        for (const rc of resultContent) {
          if (rc && typeof rc === 'object' && (rc as ContentPart).type === 'text' && typeof (rc as ContentPart).text === 'string') {
            textParts.push((rc as ContentPart).text!)
          }
        }
      }
    }
    // Skip image, thinking, etc — not useful for text search
  }

  return {
    text: textParts.join('\n'),
    rawParts: content,
  }
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
      const { text } = extractContent(messages[i].content)
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

  // Ingest each message
  for (const msg of toImport) {
    const { text, rawParts } = extractContent(msg.content)
    const content = truncate(text)
    if (content.length < 2) continue
    const validRoles = new Set(['user', 'assistant', 'system'])
    const role = validRoles.has(msg.role) ? (msg.role as 'user' | 'assistant' | 'system') : 'user'
    const metadata: Record<string, unknown> = rawParts ? { rawParts } : {}
    await memory.ingest({ sessionId, role, content, metadata })
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
  }),

  register(api: {
    config?: Record<string, unknown>
    pluginConfig?: Record<string, unknown>
    registerContextEngine: (id: string, factory: () => unknown) => void
    registerTool: (tool: unknown) => void
  }) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>
    const storagePath = expandHome(
      (cfg.storagePath as string | undefined) ??
      '~/.openclaw/engram.db'
    )

    const storage: StorageAdapter = new SqliteStorageAdapter(storagePath)
    const memory = new Memory({ storage })

    let initialized = false
    // dbReady tracks whether DB initialized successfully.
    // ownsCompaction is set to dbReady so OpenClaw's built-in compaction takes
    // over when our DB fails to initialize.
    let dbReady = false
    let episodesSinceConsolidation = 0

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
        if (!dbReady) return { ingested: false }
        if (isHeartbeat) return { ingested: false }
        const { text, rawParts } = extractContent(message.content)
        const content = truncate(text)
        if (content.length < 2) return { ingested: false }
        try {
          const metadata: Record<string, unknown> = rawParts ? { rawParts } : {}
          await memory.ingest({ sessionId, role: message.role as 'user' | 'assistant' | 'system', content, metadata })
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
        if (!dbReady) return { ingestedCount: 0 }
        if (isHeartbeat) return { ingestedCount: 0 }
        let count = 0
        for (const msg of messages) {
          const { text, rawParts } = extractContent(msg.content)
          const content = truncate(text)
          if (content.length < 2) continue
          try {
            const metadata: Record<string, unknown> = rawParts ? { rawParts } : {}
            await memory.ingest({ sessionId, role: msg.role as 'user' | 'assistant' | 'system', content, metadata })
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
        if (!dbReady) return { messages, estimatedTokens: 0 }

        const query = extractQuery(messages, prompt)
        if (!query) return { messages, estimatedTokens: 0 }
        try {
          const result = await memory.recall(query, { tokenBudget })
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
        if (!dbReady) {
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
        if (!dbReady) return
        if (isHeartbeat) return

        return withSessionQueue(sessionId, async () => {
          // Ingest only the new messages from this turn
          const newMessages = messages.slice(prePromptMessageCount)
          for (const msg of newMessages) {
            const { text, rawParts } = extractContent(msg.content)
            const content = truncate(text)
            if (content.length < 2) continue
            try {
              const metadata: Record<string, unknown> = rawParts ? { rawParts } : {}
              await memory.ingest({
                sessionId,
                role: msg.role as 'user' | 'assistant' | 'system',
                content,
                metadata,
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
        const result = await memory.consolidate((params.cycle as 'light' | 'deep' | 'dream' | 'decay' | 'all') ?? 'all')
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        }
      },
    })
  },
})
