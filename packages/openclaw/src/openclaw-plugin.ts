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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EPISODE_CHARS = 10_000
const AUTO_CONSOLIDATE_THRESHOLD = 100 // trigger light sleep every N episodes
const VERSION = '0.2.0'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentPart {
  type: string
  text?: string
  [key: string]: unknown
}

interface AgentMessage {
  role: string
  content: string | ContentPart[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract human-readable text from AgentMessage.content.
 *  Skips tool calls, tool results, and image parts — only takes text. */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)

  const textParts: string[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text)
    }
    // Skip toolCall, toolResult, image, etc — not useful for memory
  }
  return textParts.join('\n')
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
      const text = extractText(messages[i].content)
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
    let episodesSinceConsolidation = 0

    // -----------------------------------------------------------------------
    // Context Engine
    // -----------------------------------------------------------------------

    api.registerContextEngine('engram', () => ({
      info: { id: 'engram', name: 'Engram', version: VERSION, ownsCompaction: true },

      async bootstrap() {
        if (!initialized) {
          await memory.initialize()
          initialized = true
        }
        return { bootstrapped: true }
      },

      // ingest/ingestBatch are defined for completeness but OpenClaw will NOT
      // call them when afterTurn exists. They serve as fallback for runtimes
      // that don't use afterTurn.

      async ingest({ sessionId, message, isHeartbeat }: {
        sessionId: string; message: AgentMessage; isHeartbeat?: boolean
      }) {
        if (isHeartbeat) return { ingested: false }
        const content = truncate(extractText(message.content))
        if (content.length < 2) return { ingested: false }
        try {
          await memory.ingest({ sessionId, role: message.role as 'user' | 'assistant' | 'system', content })
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
        if (isHeartbeat) return { ingestedCount: 0 }
        let count = 0
        for (const msg of messages) {
          const content = truncate(extractText(msg.content))
          if (content.length < 2) continue
          try {
            await memory.ingest({ sessionId, role: msg.role as 'user' | 'assistant' | 'system', content })
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
        try {
          await memory.consolidate('light')
          episodesSinceConsolidation = 0
          return { ok: true, compacted: true }
        } catch (err) {
          console.error('[engram] compact error:', err)
          return { ok: false, compacted: false, reason: String(err) }
        }
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
        if (isHeartbeat) return

        // Ingest only the new messages from this turn
        const newMessages = messages.slice(prePromptMessageCount)
        for (const msg of newMessages) {
          const content = truncate(extractText(msg.content))
          if (content.length < 2) continue
          try {
            await memory.ingest({
              sessionId,
              role: msg.role as 'user' | 'assistant' | 'system',
              content,
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
      },

      async dispose() {
        await memory.dispose()
        initialized = false
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
