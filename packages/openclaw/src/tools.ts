import type { Memory } from '@engram-mem/core'
import { executeForget, FORGET_DESCRIPTION } from './forget.js'
import type { ForgetParams } from './forget.js'

export function createEngramTools(memory: Memory) {
  return {
    engram_search: {
      name: 'engram_search',
      description: 'Search across all memory systems with intent analysis',
      async execute(params: { query: string; limit?: number }) {
        void params.limit
        const result = await memory.recall(params.query)
        return { content: [{ type: 'text', text: result.formatted }] }
      },
    },

    engram_stats: {
      name: 'engram_stats',
      description: 'Get memory statistics',
      async execute() {
        const stats = await memory.stats()
        return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] }
      },
    },

    engram_forget: {
      name: 'engram_forget',
      description: FORGET_DESCRIPTION,
      async execute(params: ForgetParams) {
        return executeForget(memory, params)
      },
    },

    engram_expand: {
      name: 'engram_expand',
      description: 'Drill into a digest to retrieve original episodes',
      async execute(params: { memoryId: string }) {
        const result = await memory.expand(params.memoryId)
        const text = result.episodes.map(e => `[${e.role}] ${e.content}`).join('\n---\n')
        return { content: [{ type: 'text', text }] }
      },
    },
  }
}
