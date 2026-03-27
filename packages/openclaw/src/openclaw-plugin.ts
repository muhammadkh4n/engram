/**
 * Real OpenClaw plugin entry point for Engram.
 *
 * This file is the production plugin entry — it uses definePluginEntry from
 * the OpenClaw plugin SDK and registers Engram as a ContextEngine with four
 * agent tools. It is built by tsup into dist/openclaw-plugin.js and loaded
 * by OpenClaw at runtime on the VPS.
 *
 * Test files do NOT import this file. They import from plugin-entry.ts
 * (the framework-agnostic adapter) which has no openclaw dependency.
 */

// @ts-ignore — openclaw is only available on the VPS at runtime
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { Type } from '@sinclair/typebox'
import { Memory } from '@engram/core'
import { SqliteStorageAdapter } from '@engram/sqlite'
import type { StorageAdapter } from '@engram/core'

// ---------------------------------------------------------------------------
// Type definitions (mirrors openclaw ContextEngine interface)
// ---------------------------------------------------------------------------

interface AgentMessage {
  role: string
  content: string | unknown[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveContent(content: string | unknown[]): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content)
}

function extractQuery(
  messages: AgentMessage[],
  prompt?: string
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') {
      const text = resolveContent(msg.content)
      if (text.length > 0) return text
    }
  }
  return prompt ?? ''
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
    supabaseUrl: Type.Optional(Type.String()),
    supabaseKey: Type.Optional(Type.String()),
    openaiApiKey: Type.Optional(Type.String()),
    embeddingDimensions: Type.Optional(Type.Number({ default: 1536 })),
    storagePath: Type.Optional(Type.String({ default: '~/.openclaw/engram.db' })),
  }),

  register(api: {
    config?: Record<string, unknown>
    pluginConfig?: Record<string, unknown>
    registerContextEngine: (id: string, factory: () => unknown) => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool: (tool: any) => void
  }) {
    // Resolve storage path from plugin-specific config
    const cfg: Record<string, unknown> = api.pluginConfig ?? {}
    const rawPath = (cfg.storagePath as string | undefined) ??
      (process.env.HOME ?? '/root') + '/.openclaw/engram.db'

    // Expand leading ~ to $HOME
    const storagePath = rawPath.startsWith('~/')
      ? (process.env.HOME ?? '/root') + rawPath.slice(1)
      : rawPath

    const storage: StorageAdapter = new SqliteStorageAdapter(storagePath)

    // Intelligence adapter placeholder — add @engram/openai when ready
    const intelligence = undefined

    const memory = new Memory({ storage, intelligence })

    // -----------------------------------------------------------------------
    // Context Engine registration
    // -----------------------------------------------------------------------

    api.registerContextEngine('engram', () => ({
      info: {
        id: 'engram',
        name: 'Engram',
        version: '0.1.0',
        ownsCompaction: true,
      },

      async bootstrap({ sessionId: _sessionId }: { sessionId: string }) {
        await memory.initialize()
        return { bootstrapped: true }
      },

      async ingest({
        sessionId,
        message,
        isHeartbeat,
      }: {
        sessionId: string
        message: AgentMessage
        isHeartbeat?: boolean
      }) {
        if (isHeartbeat) return { ingested: false }
        const content = resolveContent(message.content)
        if (!content || content.length < 2) return { ingested: false }
        await memory.ingest({
          sessionId,
          role: message.role as 'user' | 'assistant' | 'system',
          content,
        })
        return { ingested: true }
      },

      async ingestBatch({
        sessionId,
        messages,
        isHeartbeat,
      }: {
        sessionId: string
        messages: AgentMessage[]
        isHeartbeat?: boolean
      }) {
        if (isHeartbeat) return { ingestedCount: 0 }
        let count = 0
        for (const msg of messages) {
          const content = resolveContent(msg.content)
          if (!content || content.length < 2) continue
          await memory.ingest({
            sessionId,
            role: msg.role as 'user' | 'assistant' | 'system',
            content,
          })
          count++
        }
        return { ingestedCount: count }
      },

      async assemble({
        messages,
        tokenBudget,
        prompt,
      }: {
        sessionId: string
        messages: AgentMessage[]
        tokenBudget?: number
        prompt?: string
        model?: string
      }) {
        const query = extractQuery(messages, prompt)
        if (!query) {
          return { messages, estimatedTokens: 0 }
        }
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

      async compact({
        sessionId: _sessionId,
      }: {
        sessionId: string
        sessionFile: string
        tokenBudget?: number
        force?: boolean
      }) {
        try {
          await memory.consolidate('light')
          return { ok: true, compacted: true }
        } catch (err) {
          console.error('[engram] compact error:', err)
          return { ok: false, compacted: false, reason: String(err) }
        }
      },

      async afterTurn({
        sessionId,
        messages,
        prePromptMessageCount,
        isHeartbeat,
      }: {
        sessionId: string
        sessionFile: string
        messages: AgentMessage[]
        prePromptMessageCount: number
        isHeartbeat?: boolean
        tokenBudget?: number
      }) {
        // The runtime calls afterTurn instead of ingest/ingestBatch when afterTurn
        // exists on the engine. This is the canonical place to persist new messages.
        if (isHeartbeat) return
        const newMessages = messages.slice(prePromptMessageCount)
        for (const msg of newMessages) {
          const content = resolveContent(msg.content)
          if (!content || content.length < 2) continue
          try {
            await memory.ingest({
              sessionId,
              role: msg.role as 'user' | 'assistant' | 'system',
              content,
            })
          } catch (err) {
            console.error('[engram] afterTurn ingest error:', err)
          }
        }
      },

      async dispose() {
        await memory.dispose()
      },
    }))

    // -----------------------------------------------------------------------
    // Agent tools
    // -----------------------------------------------------------------------

    api.registerTool({
      name: 'engram_search',
      label: 'Search Memory',
      description:
        'Deep search across all memory systems (episodes, semantic, procedural)',
      parameters: Type.Object({
        query: Type.String({ description: 'Search query' }),
      }),
      async execute(_toolCallId: unknown, params: { query: string }) {
        const result = await memory.recall(params.query)
        return {
          content: [
            {
              type: 'text' as const,
              text: result.formatted || 'No memories found.',
            },
          ],
          details: { memoriesFound: result.memories.length },
        }
      },
    })

    api.registerTool({
      name: 'engram_stats',
      label: 'Memory Stats',
      description:
        'Get memory statistics: episode, digest, semantic, procedural counts',
      parameters: Type.Object({}),
      async execute() {
        const stats = await memory.stats()
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(stats, null, 2),
            },
          ],
          details: stats,
        }
      },
    })

    api.registerTool({
      name: 'engram_forget',
      label: 'Forget Memory',
      description:
        'Deprioritize memories matching a query (lossless — never deletes)',
      parameters: Type.Object({
        query: Type.String({ description: 'What to forget' }),
        confirm: Type.Optional(
          Type.Boolean({
            default: false,
            description: 'Set true to confirm forgetting',
          })
        ),
      }),
      async execute(
        _toolCallId: unknown,
        params: { query: string; confirm?: boolean }
      ) {
        const result = await memory.forget(params.query, {
          confirm: params.confirm,
        })
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          details: result,
        }
      },
    })

    api.registerTool({
      name: 'engram_consolidate',
      label: 'Consolidate Memory',
      description:
        'Run memory consolidation: light (episodes→digests), deep (→knowledge), dream (→associations), decay (confidence reduction)',
      parameters: Type.Object({
        cycle: Type.Optional(
          Type.Union(
            [
              Type.Literal('light'),
              Type.Literal('deep'),
              Type.Literal('dream'),
              Type.Literal('decay'),
              Type.Literal('all'),
            ],
            { default: 'all' }
          )
        ),
      }),
      async execute(
        _toolCallId: unknown,
        params: { cycle?: 'light' | 'deep' | 'dream' | 'decay' | 'all' }
      ) {
        const result = await memory.consolidate(params.cycle ?? 'all')
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          details: result,
        }
      },
    })
  },
})
