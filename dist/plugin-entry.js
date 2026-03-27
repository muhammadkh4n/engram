import {
  CircuitBreaker,
  DigestStore,
  EpisodeStore,
  KnowledgeStore,
  OpenAIEmbeddingService,
  RetrievalGate,
  TIMEOUTS,
  TierRouter
} from "./chunk-U45FSCD6.js";

// src/plugin-entry.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { createClient } from "@supabase/supabase-js";
function resolveConfig(pluginConfig) {
  const supabaseUrl = pluginConfig.supabaseUrl || process.env.SUPABASE_URL;
  const supabaseKey = pluginConfig.supabaseKey || process.env.SUPABASE_SERVICE_KEY;
  const openaiApiKey = pluginConfig.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!supabaseUrl) throw new Error("openclaw-memory: supabaseUrl not configured (config or SUPABASE_URL env)");
  if (!supabaseKey) throw new Error("openclaw-memory: supabaseKey not configured (config or SUPABASE_SERVICE_KEY env)");
  if (!openaiApiKey) throw new Error("openclaw-memory: openaiApiKey not configured (config or OPENAI_API_KEY env)");
  return {
    ...pluginConfig,
    supabaseUrl,
    supabaseKey,
    openaiApiKey
  };
}
function formatMemories(episodeResults, digestResults, knowledgeResults) {
  const parts = [];
  if (knowledgeResults.length > 0) {
    parts.push("### Known Facts");
    for (const k of knowledgeResults) {
      parts.push(`- **${k.item.topic}** (confidence ${(k.item.confidence * 100).toFixed(0)}%): ${k.item.content}`);
    }
  }
  if (digestResults.length > 0) {
    parts.push("### Session Summaries");
    for (const d of digestResults) {
      parts.push(`- ${d.item.summary} [topics: ${d.item.key_topics.join(", ")}]`);
    }
  }
  if (episodeResults.length > 0) {
    parts.push("### Recent Episodes");
    for (const e of episodeResults) {
      const truncated = e.item.content.length > 200 ? e.item.content.slice(0, 200) + "\u2026" : e.item.content;
      parts.push(`- [${e.item.role}] ${truncated}`);
    }
  }
  return parts.join("\n");
}
var plugin_entry_default = definePluginEntry({
  id: "openclaw-memory",
  name: "OpenClaw Memory",
  description: "Three-tier agentic RAG memory with automatic ingestion and retrieval",
  kind: "context-engine",
  register(api) {
    let supabase;
    let retrievalEmbeddings;
    let storageEmbeddings;
    let episodeStore;
    let storageEpisodeStore;
    let digestStore;
    let knowledgeStore;
    let gate;
    let router;
    function init() {
      if (supabase) return;
      const cfg = resolveConfig(api.pluginConfig ?? {});
      const retrievalBreaker = new CircuitBreaker({ threshold: 5, cooldownMs: 3e4 });
      const storageBreaker = new CircuitBreaker({ threshold: 10, cooldownMs: 6e4 });
      supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey);
      retrievalEmbeddings = new OpenAIEmbeddingService({
        apiKey: cfg.openaiApiKey,
        model: cfg.embeddingModel ?? "text-embedding-3-small",
        dimensions: cfg.embeddingDimensions ?? 768,
        breaker: retrievalBreaker,
        timeoutMs: TIMEOUTS.EMBEDDING_RETRIEVAL
      });
      storageEmbeddings = new OpenAIEmbeddingService({
        apiKey: cfg.openaiApiKey,
        model: cfg.embeddingModel ?? "text-embedding-3-small",
        dimensions: cfg.embeddingDimensions ?? 768,
        breaker: storageBreaker,
        timeoutMs: TIMEOUTS.EMBEDDING_STORAGE
      });
      episodeStore = new EpisodeStore(supabase, retrievalEmbeddings, retrievalBreaker, {
        retrievalTimeoutMs: TIMEOUTS.RETRIEVAL,
        storageTimeoutMs: TIMEOUTS.STORAGE
      });
      storageEpisodeStore = new EpisodeStore(supabase, storageEmbeddings, storageBreaker, {
        retrievalTimeoutMs: TIMEOUTS.RETRIEVAL,
        storageTimeoutMs: TIMEOUTS.STORAGE
      });
      digestStore = new DigestStore(supabase, retrievalEmbeddings, retrievalBreaker);
      knowledgeStore = new KnowledgeStore(supabase, retrievalEmbeddings, retrievalBreaker);
      gate = new RetrievalGate({
        minScore: cfg.minRelevanceScore ?? 0.3,
        maxResults: 10
      });
      router = new TierRouter();
    }
    api.registerContextEngine("openclaw-memory", () => ({
      info: {
        id: "openclaw-memory",
        name: "OpenClaw Memory",
        ownsCompaction: false
      },
      async ingest({ isHeartbeat }) {
        if (isHeartbeat) return { ingested: false };
        return { ingested: true };
      },
      async ingestBatch({ sessionId, messages }) {
        init();
        const storableMessages = messages.filter(
          (msg) => msg.role === "user" || msg.role === "assistant"
        );
        if (storableMessages.length > 0) {
          setTimeout(() => {
            (async () => {
              for (const msg of storableMessages) {
                try {
                  const textContent = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : JSON.stringify(msg.content);
                  if (!textContent || textContent.length < 2) continue;
                  await storageEpisodeStore.insert({
                    session_id: sessionId,
                    role: msg.role,
                    content: textContent
                  });
                } catch (err) {
                  console.error(`[openclaw-memory] background ingest failed for ${msg.role}:`, err);
                }
              }
            })().catch((err) => {
              console.error(`[openclaw-memory] background ingest batch error:`, err);
            });
          }, 0);
        }
        return { ingestedCount: storableMessages.length };
      },
      async assemble({ messages, tokenBudget, prompt }) {
        init();
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        const queryText = prompt || lastUserMsg?.content;
        if (!gate.shouldRetrieve(queryText)) {
          return {
            messages,
            estimatedTokens: tokenBudget
          };
        }
        const query = queryText;
        const tiers = router.route(query);
        const [epRaw, dgRaw, kwRaw] = await Promise.all([
          tiers.includes("episode") ? episodeStore.search({ query, limit: 5 }).catch(() => []) : Promise.resolve([]),
          tiers.includes("digest") ? digestStore.search({ query, limit: 3 }).catch(() => []) : Promise.resolve([]),
          tiers.includes("knowledge") ? knowledgeStore.search({ query, limit: 3 }).catch(() => []) : Promise.resolve([])
        ]);
        const episodeResults = tiers.includes("episode") ? gate.filter(epRaw, "episode").results : [];
        const digestResults = tiers.includes("digest") ? gate.filter(dgRaw, "digest").results : [];
        const knowledgeResults = tiers.includes("knowledge") ? gate.filter(kwRaw, "knowledge").results : [];
        const totalResults = episodeResults.length + digestResults.length + knowledgeResults.length;
        if (totalResults === 0) {
          return {
            messages,
            estimatedTokens: tokenBudget
          };
        }
        const memoryBlock = formatMemories(
          episodeResults,
          digestResults,
          knowledgeResults
        );
        return {
          messages,
          estimatedTokens: tokenBudget,
          systemPromptAddition: `## Retrieved Memories
${memoryBlock}`
        };
      },
      async compact(_opts) {
        return { ok: true, compacted: false, reason: "Delegated to runtime" };
      },
      async dispose() {
        supabase = void 0;
      }
    }));
    api.registerTool({
      name: "memory_search_deep",
      label: "Deep Memory Search",
      description: "Search across all memory tiers (episodes, digests, knowledge) for relevant information.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Max results per tier", default: 5 }))
      }),
      async execute({ query, limit }) {
        init();
        const maxPerTier = limit ?? 5;
        const [epResults, dgResults, kwResults] = await Promise.all([
          episodeStore.search({ query, limit: maxPerTier }).catch(() => []),
          digestStore.search({ query, limit: maxPerTier }).catch(() => []),
          knowledgeStore.search({ query, limit: maxPerTier }).catch(() => [])
        ]);
        const output = [];
        if (kwResults.length > 0) {
          output.push("**Knowledge:**");
          for (const k of kwResults) {
            const item = k.item;
            output.push(`  - [${(k.similarity * 100).toFixed(0)}%] ${item.topic}: ${item.content}`);
          }
        }
        if (dgResults.length > 0) {
          output.push("**Digests:**");
          for (const d of dgResults) {
            const item = d.item;
            output.push(`  - [${(d.similarity * 100).toFixed(0)}%] ${item.summary}`);
          }
        }
        if (epResults.length > 0) {
          output.push("**Episodes:**");
          for (const e of epResults) {
            output.push(`  - [${(e.similarity * 100).toFixed(0)}%] [${e.item.role}] ${e.item.content.slice(0, 150)}`);
          }
        }
        const text = output.length > 0 ? output.join("\n") : "No memories found matching the query.";
        return {
          content: [{ type: "text", text }],
          details: { status: "ok" }
        };
      }
    });
    api.registerTool({
      name: "memory_stats",
      label: "Memory Statistics",
      description: "Get counts of stored episodes, digests, and knowledge entries.",
      parameters: Type.Object({}),
      async execute() {
        init();
        const counts = await Promise.all([
          supabase.from("memory_episodes").select("id", { count: "exact", head: true }).then((r) => r.count ?? 0),
          supabase.from("memory_digests").select("id", { count: "exact", head: true }).then((r) => r.count ?? 0),
          supabase.from("memory_knowledge").select("id", { count: "exact", head: true }).then((r) => r.count ?? 0)
        ]);
        const text = [
          "Memory Stats:",
          `- Episodes: ${counts[0]}`,
          `- Digests: ${counts[1]}`,
          `- Knowledge: ${counts[2]}`,
          `- Total: ${counts[0] + counts[1] + counts[2]}`
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: { status: "ok" }
        };
      }
    });
    api.registerTool({
      name: "memory_forget",
      label: "Forget Memory",
      description: "Search and delete memories matching a topic across all tiers.",
      parameters: Type.Object({
        topic: Type.String({ description: "Topic or query to find and delete" }),
        tier: Type.Optional(Type.Union([
          Type.Literal("episode"),
          Type.Literal("digest"),
          Type.Literal("knowledge")
        ], { description: "Specific tier to delete from (default: all)" })),
        confirm: Type.Boolean({ description: "Must be true to actually delete", default: false })
      }),
      async execute({ topic, tier, confirm }) {
        init();
        const targetTiers = tier ? [tier] : ["episode", "digest", "knowledge"];
        if (!confirm) {
          const preview = [];
          for (const t of targetTiers) {
            const store = t === "episode" ? episodeStore : t === "digest" ? digestStore : knowledgeStore;
            const results = await store.search({ query: topic, limit: 5 }).catch(() => []);
            if (results.length > 0) {
              preview.push(`${t}: ${results.length} matches`);
            }
          }
          const text = preview.length > 0 ? `Would delete from: ${preview.join(", ")}. Set confirm=true to proceed.` : "No matching memories found.";
          return {
            content: [{ type: "text", text }],
            details: { status: "ok" }
          };
        }
        let deleted = 0;
        for (const t of targetTiers) {
          const store = t === "episode" ? episodeStore : t === "digest" ? digestStore : knowledgeStore;
          const results = await store.search({ query: topic, limit: 10 }).catch(() => []);
          for (const r of results) {
            try {
              await store.delete(r.item.id);
              deleted++;
            } catch {
            }
          }
        }
        return {
          content: [{ type: "text", text: `Deleted ${deleted} memories matching "${topic}".` }],
          details: { status: "ok" }
        };
      }
    });
  }
});
export {
  plugin_entry_default as default
};
