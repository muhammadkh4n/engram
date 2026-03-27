import type { StorageAdapter } from '@engram/core'
import type { IntelligenceAdapter } from '@engram/core'
import { Memory } from '@engram/core'

export interface EngramPluginConfig {
  storage: StorageAdapter
  intelligence?: IntelligenceAdapter
}

/**
 * Create an OpenClaw ContextEngine backed by Engram.
 * This is framework-agnostic — it returns a plain object implementing
 * the ContextEngine lifecycle, not an OpenClaw-specific class.
 */
export function createEngramContextEngine(config: EngramPluginConfig) {
  const memory = new Memory({
    storage: config.storage,
    intelligence: config.intelligence,
    consolidation: { schedule: 'manual' },
  })

  return {
    info: { id: 'engram', name: 'Engram Cognitive Memory', ownsCompaction: true },

    async bootstrap(): Promise<void> {
      await memory.initialize()
    },

    async ingest(params: {
      sessionId: string
      message: { role: string; content: string }
      isHeartbeat?: boolean
    }): Promise<void> {
      if (params.isHeartbeat) return
      await memory.ingest({
        sessionId: params.sessionId,
        role: params.message.role as 'user' | 'assistant' | 'system',
        content: params.message.content,
      })
    },

    async ingestBatch(params: {
      sessionId: string
      messages: Array<{ role: string; content: string }>
    }): Promise<void> {
      await memory.ingestBatch(
        params.messages.map(m => ({
          sessionId: params.sessionId,
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
        }))
      )
    },

    async assemble(params: {
      messages: Array<{ role?: string; content?: string }>
      tokenBudget: number
      prompt?: string
    }): Promise<{
      messages: Array<{ role?: string; content?: string }>
      estimatedTokens: number
      systemPromptAddition?: string
    }> {
      const query = extractQuery(params.messages, params.prompt)
      const result = await memory.recall(query, { tokenBudget: params.tokenBudget })
      return {
        messages: params.messages,
        estimatedTokens: result.estimatedTokens,
        systemPromptAddition: result.formatted || undefined,
      }
    },

    async compact(params: { sessionId: string }): Promise<void> {
      // sessionId not needed by consolidate — Engram consolidates globally
      void params.sessionId
      await memory.consolidate('light')
    },

    async afterTurn(): Promise<void> {
      // Background: could trigger consolidation check here
    },

    async dispose(): Promise<void> {
      await memory.dispose()
    },

    // Expose the underlying Memory instance for tool registration
    getMemory(): Memory {
      return memory
    },
  }
}

export function extractQuery(
  messages: Array<{ role?: string; content?: string }>,
  prompt?: string
): string {
  // Use the last user message as the query, or fall back to prompt
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content) {
      return messages[i].content!
    }
  }
  return prompt ?? ''
}
