/**
 * OpenClaw Context Engine plugin entry point.
 *
 * Registers the three-tier memory system as a context engine with
 * lifecycle hooks (ingest, ingestBatch, assemble, compact, dispose)
 * and exposes agent tools for deep search, stats, and forget.
 */
// @ts-ignore — provided by OpenClaw runtime
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { Type } from '@sinclair/typebox';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { EpisodeStore } from './tiers/episodes.js';
import { DigestStore } from './tiers/digests.js';
import { KnowledgeStore } from './tiers/knowledge.js';
import { RetrievalGate } from './retrieval/gate.js';
import { TierRouter } from './retrieval/tier-router.js';
import { OpenAIEmbeddingService } from './utils/embeddings.js';
import { CircuitBreaker } from './utils/circuit-breaker.js';
import type { EmbeddingService } from './utils/embeddings.js';
import type { Episode, SearchResult, TierName } from './types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

interface PluginConfig {
  supabaseUrl?: string;
  supabaseKey?: string;
  openaiApiKey?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  retrievalBudgetTokens?: number;
  minRelevanceScore?: number;
}

function resolveConfig(pluginConfig: Record<string, unknown>): Required<Pick<PluginConfig, 'supabaseUrl' | 'supabaseKey' | 'openaiApiKey'>> & PluginConfig {
  const supabaseUrl = (pluginConfig.supabaseUrl as string) || process.env.SUPABASE_URL;
  const supabaseKey = (pluginConfig.supabaseKey as string) || process.env.SUPABASE_SERVICE_KEY;
  const openaiApiKey = (pluginConfig.openaiApiKey as string) || process.env.OPENAI_API_KEY;

  if (!supabaseUrl) throw new Error('openclaw-memory: supabaseUrl not configured (config or SUPABASE_URL env)');
  if (!supabaseKey) throw new Error('openclaw-memory: supabaseKey not configured (config or SUPABASE_SERVICE_KEY env)');
  if (!openaiApiKey) throw new Error('openclaw-memory: openaiApiKey not configured (config or OPENAI_API_KEY env)');

  return {
    ...pluginConfig,
    supabaseUrl,
    supabaseKey,
    openaiApiKey,
  } as Required<Pick<PluginConfig, 'supabaseUrl' | 'supabaseKey' | 'openaiApiKey'>> & PluginConfig;
}

/** Format retrieved memories into a system-prompt block. */
function formatMemories(
  episodeResults: SearchResult<Episode>[],
  digestResults: SearchResult<{ summary: string; key_topics: string[] }>[],
  knowledgeResults: SearchResult<{ topic: string; content: string; confidence: number }>[],
): string {
  const parts: string[] = [];

  if (knowledgeResults.length > 0) {
    parts.push('### Known Facts');
    for (const k of knowledgeResults) {
      parts.push(`- **${k.item.topic}** (confidence ${(k.item.confidence * 100).toFixed(0)}%): ${k.item.content}`);
    }
  }

  if (digestResults.length > 0) {
    parts.push('### Session Summaries');
    for (const d of digestResults) {
      parts.push(`- ${d.item.summary} [topics: ${d.item.key_topics.join(', ')}]`);
    }
  }

  if (episodeResults.length > 0) {
    parts.push('### Recent Episodes');
    for (const e of episodeResults) {
      const truncated = e.item.content.length > 200 ? e.item.content.slice(0, 200) + '\u2026' : e.item.content;
      parts.push(`- [${e.item.role}] ${truncated}`);
    }
  }

  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Plugin entry                                                      */
/* ------------------------------------------------------------------ */

export default definePluginEntry((api: any) => {
  let supabase: SupabaseClient;
  let embeddings: EmbeddingService;
  let episodeStore: EpisodeStore;
  let digestStore: DigestStore;
  let knowledgeStore: KnowledgeStore;
  let gate: RetrievalGate;
  let router: TierRouter;

  function init() {
    if (supabase) return; // already initialised

    const cfg = resolveConfig(api.pluginConfig ?? {});
    const breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 30_000 });

    supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey);
    embeddings = new OpenAIEmbeddingService({
      apiKey: cfg.openaiApiKey,
      model: cfg.embeddingModel ?? 'text-embedding-3-small',
      dimensions: cfg.embeddingDimensions ?? 768,
      breaker,
    });
    episodeStore = new EpisodeStore(supabase, embeddings, breaker);
    digestStore = new DigestStore(supabase, embeddings, breaker);
    knowledgeStore = new KnowledgeStore(supabase, embeddings, breaker);
    gate = new RetrievalGate({
      minScore: cfg.minRelevanceScore ?? 0.3,
      maxResults: 10,
    });
    router = new TierRouter();
  }

  /* ---------- Context Engine registration ---------- */

  api.registerContextEngine('openclaw-memory', () => ({

    async ingest({ isHeartbeat }: { sessionId: string; message: unknown; isHeartbeat?: boolean }) {
      if (isHeartbeat) return { ingested: false };
      // Actual storage happens in ingestBatch for efficiency
      return { ingested: true };
    },

    async ingestBatch({ sessionId, messages }: { sessionId: string; messages: Array<{ role: string; content: string }> }) {
      init();
      let count = 0;

      // Store user and assistant messages as episodes
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'user' || msg.role === 'assistant') {
          try {
            await episodeStore.insert({
              session_id: sessionId,
              role: msg.role as 'user' | 'assistant',
              content: msg.content,
            });
            count++;
          } catch (err) {
            console.error(`[openclaw-memory] ingestBatch episode insert failed:`, err);
          }
        }
      }

      return { ingestedCount: count };
    },

    async assemble({ messages, tokenBudget, prompt }: {
      sessionId: string;
      messages: Array<{ role: string; content: string }>;
      tokenBudget: number;
      prompt?: string;
    }) {
      init();

      // Determine the latest user message for retrieval
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      const queryText = prompt || lastUserMsg?.content;

      // Pre-filter: should we retrieve at all?
      if (!gate.shouldRetrieve(queryText)) {
        return {
          messages,
          estimatedTokens: tokenBudget,
        };
      }

      const query = queryText!;
      const tiers = router.route(query);

      // Search across selected tiers in parallel
      const [epRaw, dgRaw, kwRaw] = await Promise.all([
        tiers.includes('episode')
          ? episodeStore.search({ query, limit: 5 }).catch(() => [])
          : Promise.resolve([]),
        tiers.includes('digest')
          ? digestStore.search({ query, limit: 3 }).catch(() => [])
          : Promise.resolve([]),
        tiers.includes('knowledge')
          ? knowledgeStore.search({ query, limit: 3 }).catch(() => [])
          : Promise.resolve([]),
      ]);

      const episodeResults = tiers.includes('episode') ? gate.filter(epRaw, 'episode').results : [];
      const digestResults = tiers.includes('digest') ? gate.filter(dgRaw, 'digest').results : [];
      const knowledgeResults = tiers.includes('knowledge') ? gate.filter(kwRaw, 'knowledge').results : [];

      const totalResults = episodeResults.length + digestResults.length + knowledgeResults.length;

      if (totalResults === 0) {
        return {
          messages,
          estimatedTokens: tokenBudget,
        };
      }

      const memoryBlock = formatMemories(
        episodeResults,
        digestResults as SearchResult<{ summary: string; key_topics: string[] }>[],
        knowledgeResults as SearchResult<{ topic: string; content: string; confidence: number }>[],
      );

      return {
        messages,
        estimatedTokens: tokenBudget,
        systemPromptAddition: `## Retrieved Memories\n${memoryBlock}`,
      };
    },

    async compact(_opts: { sessionId: string }) {
      // Delegate compaction to the runtime; we don't do our own yet
      return { ok: true, compacted: false, reason: 'Delegated to runtime' };
    },

    async dispose() {
      // disposed
      // Supabase client doesn't need explicit disposal
    },
  }));

  /* ---------- Agent tool: memory_search_deep ---------- */

  api.registerTool({
    name: 'memory_search_deep',
    label: 'Deep Memory Search',
    description: 'Search across all memory tiers (episodes, digests, knowledge) for relevant information.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      limit: Type.Optional(Type.Number({ description: 'Max results per tier', default: 5 })),
    }),
    async execute({ query, limit }: { query: string; limit?: number }) {
      init();
      const maxPerTier = limit ?? 5;

      const [epResults, dgResults, kwResults] = await Promise.all([
        episodeStore.search({ query, limit: maxPerTier }).catch(() => []),
        digestStore.search({ query, limit: maxPerTier }).catch(() => []),
        knowledgeStore.search({ query, limit: maxPerTier }).catch(() => []),
      ]);

      const output: string[] = [];

      if (kwResults.length > 0) {
        output.push('**Knowledge:**');
        for (const k of kwResults) {
          const item = k.item as unknown as { topic: string; content: string; confidence: number };
          output.push(`  - [${(k.similarity * 100).toFixed(0)}%] ${item.topic}: ${item.content}`);
        }
      }
      if (dgResults.length > 0) {
        output.push('**Digests:**');
        for (const d of dgResults) {
          const item = d.item as unknown as { summary: string; key_topics: string[] };
          output.push(`  - [${(d.similarity * 100).toFixed(0)}%] ${item.summary}`);
        }
      }
      if (epResults.length > 0) {
        output.push('**Episodes:**');
        for (const e of epResults) {
          output.push(`  - [${(e.similarity * 100).toFixed(0)}%] [${e.item.role}] ${e.item.content.slice(0, 150)}`);
        }
      }

      const text = output.length > 0 ? output.join('\n') : 'No memories found matching the query.';

      return {
        content: [{ type: 'text' as const, text }],
        details: { status: 'ok' },
      };
    },
  });

  /* ---------- Agent tool: memory_stats ---------- */

  api.registerTool({
    name: 'memory_stats',
    label: 'Memory Statistics',
    description: 'Get counts of stored episodes, digests, and knowledge entries.',
    parameters: Type.Object({}),
    async execute() {
      init();

      const counts = await Promise.all([
        supabase.from('memory_episodes').select('id', { count: 'exact', head: true }).then((r) => r.count ?? 0),
        supabase.from('memory_digests').select('id', { count: 'exact', head: true }).then((r) => r.count ?? 0),
        supabase.from('memory_knowledge').select('id', { count: 'exact', head: true }).then((r) => r.count ?? 0),
      ]);

      const text = [
        'Memory Stats:',
        `- Episodes: ${counts[0]}`,
        `- Digests: ${counts[1]}`,
        `- Knowledge: ${counts[2]}`,
        `- Total: ${counts[0] + counts[1] + counts[2]}`,
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text }],
        details: { status: 'ok' },
      };
    },
  });

  /* ---------- Agent tool: memory_forget ---------- */

  api.registerTool({
    name: 'memory_forget',
    label: 'Forget Memory',
    description: 'Search and delete memories matching a topic across all tiers.',
    parameters: Type.Object({
      topic: Type.String({ description: 'Topic or query to find and delete' }),
      tier: Type.Optional(Type.Union([
        Type.Literal('episode'),
        Type.Literal('digest'),
        Type.Literal('knowledge'),
      ], { description: 'Specific tier to delete from (default: all)' })),
      confirm: Type.Boolean({ description: 'Must be true to actually delete', default: false }),
    }),
    async execute({ topic, tier, confirm }: { topic: string; tier?: TierName; confirm: boolean }) {
      init();

      const targetTiers: TierName[] = tier ? [tier] : ['episode', 'digest', 'knowledge'];

      if (!confirm) {
        // Preview what would be deleted
        const preview: string[] = [];

        for (const t of targetTiers) {
          const store = t === 'episode' ? episodeStore : t === 'digest' ? digestStore : knowledgeStore;
          const results = await store.search({ query: topic, limit: 5 }).catch(() => []);
          if (results.length > 0) {
            preview.push(`${t}: ${results.length} matches`);
          }
        }

        const text = preview.length > 0
          ? `Would delete from: ${preview.join(', ')}. Set confirm=true to proceed.`
          : 'No matching memories found.';

        return {
          content: [{ type: 'text' as const, text }],
          details: { status: 'ok' },
        };
      }

      // Actually delete
      let deleted = 0;

      for (const t of targetTiers) {
        const store = t === 'episode' ? episodeStore : t === 'digest' ? digestStore : knowledgeStore;
        const results = await store.search({ query: topic, limit: 10 }).catch(() => []);
        for (const r of results) {
          try {
            await store.delete((r.item as { id?: string }).id!);
            deleted++;
          } catch {
            // skip individual failures
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: `Deleted ${deleted} memories matching "${topic}".` }],
        details: { status: 'ok' },
      };
    },
  });
});
