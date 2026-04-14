#!/usr/bin/env node
/**
 * Engram Memory MCP Server
 *
 * Exposes three tools over stdio transport:
 *   memory_recall   — search memory by query
 *   memory_ingest   — store a message into memory
 *   memory_forget   — deprioritize memories matching a query
 *
 * Required environment variables:
 *   SUPABASE_URL       — Supabase project URL
 *   SUPABASE_KEY       — Supabase anon/service key
 *   OPENAI_API_KEY     — OpenAI API key for embeddings + summarization
 *
 * Optional Wave 2 (Neo4j neural graph) environment variables:
 *   NEO4J_URI          — e.g. bolt://localhost:7687  (enables graph mode)
 *   NEO4J_USER         — default: neo4j
 *   NEO4J_PASSWORD     — default: engram-dev
 *
 * When NEO4J_URI is set and reachable, ingestion decomposes episodes into
 * the neural graph and recall uses Cypher spreading activation. Otherwise
 * the server runs in SQL-only mode identical to pre-Wave-2 behavior.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createMemory } from '@engram-mem/core'
import { SupabaseStorageAdapter } from '@engram-mem/supabase'
import { openaiIntelligence } from '@engram-mem/openai'
import type { Memory } from '@engram-mem/core'
import { tryCreateGraph } from './graph-helper.js'

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return val
}

// ---------------------------------------------------------------------------
// Memory initialization
// ---------------------------------------------------------------------------

let memory: Memory | null = null

async function getMemory(): Promise<Memory> {
  if (memory) return memory

  const supabaseUrl = requireEnv('SUPABASE_URL')
  const supabaseKey = requireEnv('SUPABASE_KEY')
  const openaiApiKey = requireEnv('OPENAI_API_KEY')

  const storage = new SupabaseStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  const intelligence = openaiIntelligence({ apiKey: openaiApiKey })
  const graph = await tryCreateGraph('[engram-mcp]')

  memory = createMemory({
    storage,
    intelligence,
    autoConsolidate: true,
    ...(graph ? { graph } : {}),
  })
  await memory.initialize()

  return memory
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'engram-memory', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'memory_recall',
        description:
          'Search Engram memory for content relevant to a query. Returns formatted memories with attribution tags (role, date, session). Use this before answering questions about past context, preferences, or decisions.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'The search query to find relevant memories.',
            },
            session_id: {
              type: 'string',
              description:
                'Optional session ID to scope the search to a specific conversation.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'memory_ingest',
        description:
          'Store a message into Engram memory. Call this for important user statements, decisions, preferences, or assistant responses worth remembering.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'The text content to store.',
            },
            role: {
              type: 'string',
              enum: ['user', 'assistant', 'system'],
              description: 'The role of the message author.',
            },
            session_id: {
              type: 'string',
              description: 'Optional session ID to associate this message with.',
            },
          },
          required: ['content', 'role'],
        },
      },
      {
        name: 'memory_forget',
        description:
          'Deprioritize memories matching a query. This is lossless — memories are not deleted but their confidence is reduced to the floor. Returns a count of affected memories.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'Query describing what to forget.',
            },
            confirm: {
              type: 'boolean',
              description:
                'Set to true to apply the forgetting. Omit or false to preview only.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'memory_timeline',
        description:
          'Show how a topic evolved over time. Returns a chronological list of semantic memories for a topic, including superseded (expired) beliefs. Useful for understanding how knowledge changed.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            topic: {
              type: 'string',
              description: 'Topic to trace (e.g. "preference", "TypeScript", "auth architecture").',
            },
            from_date: {
              type: 'string',
              description: 'Optional ISO date string to filter from (inclusive).',
            },
            to_date: {
              type: 'string',
              description: 'Optional ISO date string to filter to (inclusive).',
            },
          },
          required: ['topic'],
        },
      },
      {
        name: 'memory_overview',
        description:
          'Returns a high-level summary of what Engram knows, organized by knowledge clusters. Use this to understand what topics, projects, or domains are heavily represented in memory. Optionally filter by topic to find related clusters.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            topic: {
              type: 'string',
              description: 'Optional topic filter. If provided, returns clusters whose summary or top entities match this topic.',
            },
            max_communities: {
              type: 'number',
              description: 'Maximum number of communities to return. Default 5.',
            },
            project_id: {
              type: 'string',
              description: 'Optional project namespace to scope the query.',
            },
          },
          required: [],
        },
      },
      {
        name: 'memory_bridges',
        description:
          'Find shared people or entities that bridge two different projects. Returns cross-project connections — useful for understanding what or who connects two workstreams. Returns labels and counts only, not full memory content from other projects.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project_a: { type: 'string', description: 'First project ID.' },
            project_b: { type: 'string', description: 'Second project ID.' },
          },
          required: ['project_a', 'project_b'],
        },
      },
    ],
  }
})

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (!args || typeof args !== 'object') {
    return {
      content: [{ type: 'text' as const, text: 'Error: missing tool arguments' }],
      isError: true,
    }
  }

  try {
    const mem = await getMemory()

    // -------------------------------------------------------------------------
    // memory_recall
    // -------------------------------------------------------------------------
    if (name === 'memory_recall') {
      const query = args['query']
      if (typeof query !== 'string' || query.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: query must be a non-empty string' }],
          isError: true,
        }
      }

      const result = await mem.recall(query.trim())

      if (!result.formatted || result.memories.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No relevant memories found.',
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: result.formatted,
          },
        ],
      }
    }

    // -------------------------------------------------------------------------
    // memory_ingest
    // -------------------------------------------------------------------------
    if (name === 'memory_ingest') {
      const content = args['content']
      const role = args['role']
      const sessionId = args['session_id']

      if (typeof content !== 'string' || content.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: content must be a non-empty string' }],
          isError: true,
        }
      }

      if (role !== 'user' && role !== 'assistant' && role !== 'system') {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: role must be one of "user", "assistant", or "system"',
            },
          ],
          isError: true,
        }
      }

      await mem.ingest({
        content: content.trim(),
        role,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: 'Memory stored.',
          },
        ],
      }
    }

    // -------------------------------------------------------------------------
    // memory_forget
    // -------------------------------------------------------------------------
    if (name === 'memory_forget') {
      const query = args['query']
      const confirm = args['confirm']

      if (typeof query !== 'string' || query.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: query must be a non-empty string' }],
          isError: true,
        }
      }

      const shouldConfirm = confirm === true
      const result = await mem.forget(query.trim(), { confirm: shouldConfirm })

      const action = shouldConfirm ? 'Forgot' : 'Preview'
      const text =
        result.count === 0
          ? 'No matching memories found.'
          : `${action}: ${result.count} memor${result.count === 1 ? 'y' : 'ies'} affected.` +
            (shouldConfirm ? '' : ' Pass confirm=true to apply.')

      return {
        content: [{ type: 'text' as const, text }],
      }
    }

    // -------------------------------------------------------------------------
    // memory_timeline
    // -------------------------------------------------------------------------
    if (name === 'memory_timeline') {
      const topic = args['topic']
      if (typeof topic !== 'string' || topic.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: topic must be a non-empty string' }],
          isError: true,
        }
      }

      const fromDate = typeof args['from_date'] === 'string' ? new Date(args['from_date']) : undefined
      const toDate = typeof args['to_date'] === 'string' ? new Date(args['to_date']) : undefined

      const timeline = await mem.getTimeline(topic.trim(), { fromDate, toDate })

      if (timeline.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No semantic memories found for topic "${topic}".` }],
        }
      }

      const lines = [`## Timeline: "${topic}" (${timeline.length} entries)\n`]
      for (const m of timeline) {
        const status = m.supersededBy ? '~~superseded~~' : '**current**'
        const from = m.createdAt.toISOString().slice(0, 10)
        lines.push(`- [${from}] ${status} — ${m.content}`)
        if (m.supersededBy) lines.push(`  _superseded by: ${m.supersededBy}_`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      }
    }

    // -------------------------------------------------------------------------
    // memory_overview
    // -------------------------------------------------------------------------
    if (name === 'memory_overview') {
      const topic = typeof args['topic'] === 'string' ? args['topic'].trim() : undefined
      const maxCommunities = typeof args['max_communities'] === 'number'
        ? Math.min(args['max_communities'], 20)
        : 5
      const projectId = typeof args['project_id'] === 'string' ? args['project_id'] : undefined

      const communities = await mem.getCommunitySummaries({ topic, limit: maxCommunities, projectId })

      if (communities.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No knowledge clusters found. Run a dream cycle consolidation to generate community summaries.' }],
        }
      }

      const lines = ['## Engram — Knowledge Domain Overview', '']
      for (const c of communities) {
        lines.push(`### ${c.label}`)
        lines.push(`- Members: ${c.memberCount} memories`)
        if (c.topTopics.length > 0) lines.push(`- Topics: ${c.topTopics.join(', ')}`)
        if (c.topEntities.length > 0) lines.push(`- Entities: ${c.topEntities.join(', ')}`)
        if (c.topPersons.length > 0) lines.push(`- People: ${c.topPersons.join(', ')}`)
        if (c.dominantEmotion) lines.push(`- Dominant tone: ${c.dominantEmotion}`)
        lines.push('')
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      }
    }

    // -------------------------------------------------------------------------
    // memory_bridges
    // -------------------------------------------------------------------------
    if (name === 'memory_bridges') {
      const projectA = args['project_a']
      const projectB = args['project_b']

      if (typeof projectA !== 'string' || typeof projectB !== 'string') {
        return {
          content: [{ type: 'text' as const, text: 'Error: project_a and project_b are required.' }],
          isError: true,
        }
      }

      const bridges = await mem.findBridges(projectA, projectB)

      if (bridges.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No shared entities or people found between ${projectA} and ${projectB}.` }],
        }
      }

      const lines = [`## Cross-Project Bridges: ${projectA} ↔ ${projectB}`, '']
      for (const b of bridges) {
        lines.push(`### ${b.nodeType === 'person' ? 'Person' : 'Entity'}: ${b.label}`)
        lines.push(`  - ${projectA}: ${b.projectACount} memories`)
        lines.push(`  - ${projectB}: ${b.projectBCount} memories`)
        lines.push('')
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      }
    }

    return {
      content: [{ type: 'text' as const, text: `Error: unknown tool "${name}"` }],
      isError: true,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    }
  }
})

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Intentionally silent — stdio transport; any stdout output corrupts the JSON-RPC stream.
}

main().catch((err) => {
  process.stderr.write(`[engram-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
