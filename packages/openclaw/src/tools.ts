import type { Memory } from '@engram-mem/core'

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
      description: 'Deprioritize memories by topic (lossless)',
      async execute(params: { query: string; confirm?: boolean }) {
        const result = await memory.forget(params.query, { confirm: params.confirm })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
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
