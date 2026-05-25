/**
 * Engram MCP server factory — transport-agnostic.
 *
 * Builds a fresh `Server` instance with all engram-memory tools registered.
 * Reuses a module-scoped Memory singleton across instances so per-request
 * server creation in HTTP mode stays cheap.
 *
 * Used by both stdio (index.ts) and Streamable HTTP (index-http.ts) entries.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createMemory, startConsolidationWorker } from '@engram-mem/core'
import type { StorageAdapter, IntelligenceAdapter, GraphPort } from '@engram-mem/core'
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
import { openaiIntelligence } from '@engram-mem/openai'
import type { Memory } from '@engram-mem/core'
import { tryCreateGraph } from './graph-helper.js'

/**
 * Read the package version once at module load from the colocated package.json.
 * Resolves correctly from both `src/server-core.ts` (dev) and `dist/server-core.js`
 * (published) because both sit one level below `package.json`.
 *
 * Falls back to "0.0.0" rather than throwing if the file is missing or
 * malformed — server startup should never fail just because the version
 * string is unavailable.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const PACKAGE_VERSION = readPackageVersion()

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return val
}


/**
 * Optionally swap the rerank stage to a local ONNX cross-encoder.
 *
 * When `ENGRAM_RERANK_LOCAL=true`, dynamically loads `@engram-mem/rerank-onnx`
 * (mxbai-rerank-large-v1 by default) and spreads its `rerank` over the
 * provided intelligence adapter. The 113MB ONNX weights are downloaded on
 * first use and cached under the HF cache dir; `.load()` is fired
 * fire-and-forget at startup so the cache warm-up overlaps the first user
 * request rather than blocking it.
 *
 * Falls back to the input adapter unchanged if the env flag is off or the
 * package fails to load (e.g. not installed). Errors during load are logged
 * but do not abort server startup.
 */
async function maybeWithLocalRerank(
  intelligence: IntelligenceAdapter,
): Promise<IntelligenceAdapter> {
  if (process.env.ENGRAM_RERANK_LOCAL !== 'true') return intelligence
  try {
    const mod = await import('@engram-mem/rerank-onnx')
    const onnx = mod.createOnnxReranker()
    // Fire-and-forget warm-up. First real query waits at most until model is
    // resident; subsequent queries are zero-latency setup.
    onnx.load().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[engram-mcp] rerank-onnx warmup failed (will retry on first call): ${msg}`)
    })
    console.log('[engram-mcp] ENGRAM_RERANK_LOCAL=true — using local mxbai-rerank cross-encoder')
    return {
      ...intelligence,
      rerank: (query, documents) => onnx.rerank(query, documents),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[engram-mcp] ENGRAM_RERANK_LOCAL=true but @engram-mem/rerank-onnx could not be loaded — falling back to OpenAI rerank: ${msg}`,
    )
    return intelligence
  }
}

let memory: Memory | null = null

export async function getMemory(): Promise<Memory> {
  if (memory) return memory

  const supabaseUrl = requireEnv('SUPABASE_URL')
  const supabaseKey = requireEnv('SUPABASE_KEY')
  const openaiApiKey = requireEnv('OPENAI_API_KEY')

  const storage: StorageAdapter = new PostgRestStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  const baseIntelligence: IntelligenceAdapter = openaiIntelligence({ apiKey: openaiApiKey })
  // v0.4.3: when ENGRAM_RERANK_LOCAL=true, spread the local mxbai-rerank
  // cross-encoder over the openaiIntelligence adapter so the rerank stage
  // uses ONNX CPU inference (~$0 per query) instead of gpt-4o-mini pointwise.
  // Dynamic import keeps the 113MB ONNX dep out of the cold-start path for
  // users who don't opt in. Failure to load logs a warning and falls back
  // to the OpenAI reranker.
  const intelligence: IntelligenceAdapter = await maybeWithLocalRerank(baseIntelligence)
  const graph: GraphPort | null = await tryCreateGraph('[engram-mcp]')

  memory = createMemory({
    storage,
    intelligence,
    autoConsolidate: true,
    // v0.4.3: ENGRAM_INGEST_CONTEXTUAL=true enables Anthropic-style
    // Contextual Retrieval. Memory.ingest will call
    // intelligence.contextualizeChunk to generate a short preamble per
    // turn and use it to enrich the EMBEDDING only. Content stays
    // pristine for FTS lexical precision (Wave 2 bench finding).
    contextualRetrieval: process.env.ENGRAM_INGEST_CONTEXTUAL === 'true',
    ...(graph ? { graph } : {}),
  })
  await memory.initialize()

  // v0.3.12: start the Phase 2 consolidation worker for cheap cycles only.
  // dreamCycle is intentionally excluded — it runs via the separate
  // engram-dream-cycle systemd timer for predictable cost + isolated
  // failure. See results/research/2026-05-24-auto-consolidation-implementation-plan.md.
  const worker = startConsolidationWorker(storage, intelligence, graph, {
    cycles: ['light', 'deep', 'decay'],
    intervalMs: 60_000,
  })
  // Best-effort graceful shutdown — stops the interval so the process can exit
  // cleanly when systemd / docker / a test harness sends SIGTERM.
  process.once('SIGTERM', () => worker.stop())
  process.once('SIGINT', () => worker.stop())

  return memory
}

const INSTRUCTIONS = `You have access to Engram, a persistent memory system that remembers across conversations.

IMPORTANT — When to use memory_recall:
- Before answering questions about past work, decisions, preferences, or architecture
- When the user references something from a previous session ("remember when...", "what did we decide about...", "last time we...")
- When you're about to say "I don't have information about that" or "I can't recall" — CHECK MEMORY FIRST
- When context from previous conversations would help answer the current question
- When the user asks about their own preferences, tools, or workflow

IMPORTANT — When NOT to search memory:
- Routine file reads, test outputs, build commands
- Questions about general programming knowledge (use your training data)
- When the user explicitly says not to use memory

If memory_recall returns relevant results, USE THEM directly in your response. Do not say "I don't have this information" if it appears in recalled memories.`

const TOOLS = [
  {
    name: 'memory_recall',
    description:
      'Search Engram memory for content relevant to a query. Returns formatted memories with attribution tags (role, date, session). ALWAYS use this tool BEFORE saying you don\'t know or can\'t recall something. Use when: answering questions about past work/decisions/preferences, when user says "remember", "recall", "what did we", "last time", or references prior conversations. Do NOT skip this tool and guess — check memory first.',
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
  {
    name: 'memory_consolidation_status',
    description:
      'Return when each Engram consolidation cycle last ran and its result. Use this to verify auto-consolidation is healthy, see whether dream cycle has produced community summaries recently, or diagnose why memory_overview returns no clusters. Reads from the consolidation_runs table — no compute, just lookups.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
]

export function createEngramServer(): Server {
  const server = new Server(
    { name: 'engram-memory', version: PACKAGE_VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

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
            content: [{ type: 'text' as const, text: 'No relevant memories found.' }],
          }
        }

        return {
          content: [{ type: 'text' as const, text: result.formatted }],
        }
      }

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
          content: [{ type: 'text' as const, text: 'Memory stored.' }],
        }
      }

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

      if (name === 'memory_consolidation_status') {
        // Pull recent runs from the SQL tracker. Storage adapters that
        // haven't implemented consolidationRuns yet (e.g. Supabase as of
        // v0.3.12) just return "tracker unavailable" — the tool still
        // serves the diagnostic intent of "tell me whether consolidation
        // is happening" by saying clearly that no records are kept.
        const storage = (mem as unknown as { storage: StorageAdapter }).storage
        const tracker = storage?.consolidationRuns
        if (!tracker) {
          return {
            content: [{
              type: 'text' as const,
              text: '## Engram — Consolidation Status\n\nThe storage adapter does not implement consolidation_runs tracking, so no per-cycle history is available. The in-process Phase 2 worker (lightSleep / deepSleep / decay) may still be running — check journalctl for the engram-mcp process. Dream cycle status is visible via the engram-dream-cycle systemd timer logs on the host.',
            }],
          }
        }
        const cycles: Array<'light' | 'deep' | 'dream' | 'decay'> = ['light', 'deep', 'dream', 'decay']
        const lines = ['## Engram — Consolidation Status', '']
        for (const cycle of cycles) {
          const last = await tracker.getLastRun(cycle).catch(() => null)
          if (!last) {
            lines.push(`- **${cycle}**: never run`)
            continue
          }
          const status = last.status
          const when = last.completedAt ? last.completedAt.toISOString() : last.startedAt.toISOString()
          const dur = last.durationMs !== null ? ` in ${last.durationMs}ms` : ''
          lines.push(`- **${cycle}**: ${status} at ${when}${dur}`)
          if (last.result) {
            const r = last.result
            const detail: string[] = []
            if (r.digestsCreated !== undefined) detail.push(`digests=${r.digestsCreated}`)
            if (r.promoted !== undefined) detail.push(`promoted=${r.promoted}`)
            if (r.associationsCreated !== undefined) detail.push(`associations=${r.associationsCreated}`)
            if (r.communitiesDetected !== undefined) detail.push(`communities=${r.communitiesDetected}`)
            if (r.communitySummariesGenerated !== undefined) detail.push(`summaries=${r.communitySummariesGenerated}`)
            if (r.llmCallsCount !== undefined) detail.push(`llmCalls=${r.llmCallsCount}`)
            if (r.llmCallsUsdEstimate !== undefined) detail.push(`~$${r.llmCallsUsdEstimate.toFixed(4)}`)
            if (r.episodeCount !== undefined) detail.push(`episodeCount=${r.episodeCount}`)
            if (r.cappedAt !== undefined) detail.push(`cappedAt=${r.cappedAt}`)
            if (detail.length > 0) lines.push(`  - ${detail.join(', ')}`)
          }
          if (last.error) lines.push(`  - error: ${last.error}`)
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
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

  return server
}
