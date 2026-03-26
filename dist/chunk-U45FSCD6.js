// src/utils/circuit-breaker.ts
var CircuitBreaker = class {
  state = "closed";
  failures = 0;
  lastFailureTime = 0;
  threshold;
  cooldownMs;
  constructor(opts) {
    this.threshold = opts.threshold;
    this.cooldownMs = opts.cooldownMs;
  }
  getState() {
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.cooldownMs) {
        this.state = "half-open";
      }
    }
    return this.state;
  }
  async execute(fn) {
    const currentState = this.getState();
    if (currentState === "open") {
      throw new CircuitOpenError(
        `Circuit is open. ${this.remainingCooldownMs()}ms until retry.`
      );
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }
  onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }
  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
    }
  }
  remainingCooldownMs() {
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.cooldownMs - elapsed);
  }
  reset() {
    this.state = "closed";
    this.failures = 0;
    this.lastFailureTime = 0;
  }
  getFailureCount() {
    return this.failures;
  }
};
var CircuitOpenError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CircuitOpenError";
  }
};

// src/utils/timeout.ts
var TIMEOUTS = {
  /** Retrieval path — must be fast */
  RETRIEVAL: 200,
  /** Storage path — generous, background work */
  STORAGE: 3e4,
  /** Embedding for retrieval path — fast, skip if slow */
  EMBEDDING_RETRIEVAL: 200,
  /** Embedding for storage path — generous, don't lose data */
  EMBEDDING_STORAGE: 3e4,
  /** Supabase insert timeout for storage path */
  SUPABASE_INSERT: 1e4,
  /** @deprecated Use EMBEDDING_RETRIEVAL or EMBEDDING_STORAGE */
  EMBEDDING: 500
};
var TimeoutError = class extends Error {
  constructor(budgetMs) {
    super(`Operation timed out after ${budgetMs}ms`);
    this.budgetMs = budgetMs;
    this.name = "TimeoutError";
  }
};
function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(ms));
    }, ms);
    fn(controller.signal).then((val) => {
      clearTimeout(timer);
      resolve(val);
    }).catch((err) => {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        reject(new TimeoutError(ms));
      } else {
        reject(err);
      }
    });
  });
}
function withTimeoutSimple(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then((val) => {
      clearTimeout(timer);
      resolve(val);
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// src/tiers/episodes.ts
import { v4 as uuidv4 } from "uuid";
var EpisodeStore = class {
  supabase;
  embeddings;
  breaker;
  retrievalTimeout;
  storageTimeout;
  constructor(supabase, embeddings, breaker, opts) {
    this.supabase = supabase;
    this.embeddings = embeddings;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 3e4 });
    this.retrievalTimeout = opts?.retrievalTimeoutMs ?? TIMEOUTS.RETRIEVAL;
    this.storageTimeout = opts?.storageTimeoutMs ?? TIMEOUTS.STORAGE;
  }
  async insert(episode) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const id = episode.id ?? uuidv4();
        const embedding = episode.embedding ?? await this.embeddings.embed(episode.content);
        const { data, error } = await this.supabase.from("memory_episodes").insert({
          id,
          session_id: episode.session_id,
          role: episode.role,
          content: episode.content,
          embedding: JSON.stringify(embedding),
          metadata: episode.metadata ?? {}
        }).select().single();
        if (error) throw new Error(`Episode insert failed: ${error.message}`);
        return data;
      })(), this.storageTimeout);
    });
  }
  async search(opts) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const embedding = opts.embedding ?? await this.embeddings.embed(opts.query);
        const { data, error } = await this.supabase.rpc("match_episodes", {
          query_embedding: JSON.stringify(embedding),
          match_count: opts.limit ?? 10,
          min_similarity: opts.minScore ?? 0.3,
          filter_session_id: opts.sessionId ?? null
        });
        if (error) throw new Error(`Episode search failed: ${error.message}`);
        return (data ?? []).map((row) => ({
          item: {
            id: row.id,
            session_id: row.session_id,
            role: row.role,
            content: row.content,
            metadata: row.metadata,
            created_at: row.created_at
          },
          similarity: row.similarity
        }));
      })(), this.retrievalTimeout);
    });
  }
  async delete(id) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { error } = await this.supabase.from("memory_episodes").delete().eq("id", id);
        if (error) throw new Error(`Episode delete failed: ${error.message}`);
      })(), this.storageTimeout);
    });
  }
  async getBySession(sessionId) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { data, error } = await this.supabase.from("memory_episodes").select("*").eq("session_id", sessionId).order("created_at", { ascending: true });
        if (error) throw new Error(`Episode fetch failed: ${error.message}`);
        return data ?? [];
      })(), this.retrievalTimeout);
    });
  }
};

// src/tiers/digests.ts
import { v4 as uuidv42 } from "uuid";
var DigestStore = class {
  supabase;
  embeddings;
  breaker;
  retrievalTimeout;
  storageTimeout;
  constructor(supabase, embeddings, breaker, opts) {
    this.supabase = supabase;
    this.embeddings = embeddings;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 3e4 });
    this.retrievalTimeout = opts?.retrievalTimeoutMs ?? TIMEOUTS.RETRIEVAL;
    this.storageTimeout = opts?.storageTimeoutMs ?? TIMEOUTS.STORAGE;
  }
  async insert(digest) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const id = digest.id ?? uuidv42();
        const embedding = digest.embedding ?? await this.embeddings.embed(digest.summary);
        const { data, error } = await this.supabase.from("memory_digests").insert({
          id,
          session_id: digest.session_id,
          summary: digest.summary,
          key_topics: digest.key_topics,
          embedding: JSON.stringify(embedding),
          episode_ids: digest.episode_ids,
          metadata: digest.metadata ?? {}
        }).select().single();
        if (error) throw new Error(`Digest insert failed: ${error.message}`);
        return data;
      })(), this.storageTimeout);
    });
  }
  async search(opts) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const embedding = opts.embedding ?? await this.embeddings.embed(opts.query);
        const { data, error } = await this.supabase.rpc("match_digests", {
          query_embedding: JSON.stringify(embedding),
          match_count: opts.limit ?? 10,
          min_similarity: opts.minScore ?? 0.3
        });
        if (error) throw new Error(`Digest search failed: ${error.message}`);
        return (data ?? []).map((row) => ({
          item: {
            id: row.id,
            session_id: row.session_id,
            summary: row.summary,
            key_topics: row.key_topics,
            episode_ids: row.episode_ids,
            metadata: row.metadata,
            created_at: row.created_at
          },
          similarity: row.similarity
        }));
      })(), this.retrievalTimeout);
    });
  }
  async delete(id) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { error } = await this.supabase.from("memory_digests").delete().eq("id", id);
        if (error) throw new Error(`Digest delete failed: ${error.message}`);
      })(), this.storageTimeout);
    });
  }
};

// src/tiers/knowledge.ts
import { v4 as uuidv43 } from "uuid";
var KnowledgeStore = class {
  supabase;
  embeddings;
  breaker;
  retrievalTimeout;
  storageTimeout;
  constructor(supabase, embeddings, breaker, opts) {
    this.supabase = supabase;
    this.embeddings = embeddings;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 3e4 });
    this.retrievalTimeout = opts?.retrievalTimeoutMs ?? TIMEOUTS.RETRIEVAL;
    this.storageTimeout = opts?.storageTimeoutMs ?? TIMEOUTS.STORAGE;
  }
  async insert(knowledge) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const id = knowledge.id ?? uuidv43();
        const embedding = knowledge.embedding ?? await this.embeddings.embed(knowledge.content);
        const { data, error } = await this.supabase.from("memory_knowledge").insert({
          id,
          topic: knowledge.topic,
          content: knowledge.content,
          confidence: knowledge.confidence,
          embedding: JSON.stringify(embedding),
          source_digest_ids: knowledge.source_digest_ids,
          metadata: knowledge.metadata ?? {}
        }).select().single();
        if (error) throw new Error(`Knowledge insert failed: ${error.message}`);
        return data;
      })(), this.storageTimeout);
    });
  }
  async search(opts) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const embedding = opts.embedding ?? await this.embeddings.embed(opts.query);
        const { data, error } = await this.supabase.rpc("match_knowledge", {
          query_embedding: JSON.stringify(embedding),
          match_count: opts.limit ?? 10,
          min_similarity: opts.minScore ?? 0.3
        });
        if (error) throw new Error(`Knowledge search failed: ${error.message}`);
        return (data ?? []).map((row) => ({
          item: {
            id: row.id,
            topic: row.topic,
            content: row.content,
            confidence: row.confidence,
            source_digest_ids: row.source_digest_ids,
            metadata: row.metadata,
            created_at: row.created_at,
            updated_at: row.updated_at
          },
          similarity: row.similarity
        }));
      })(), this.retrievalTimeout);
    });
  }
  async delete(id) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { error } = await this.supabase.from("memory_knowledge").delete().eq("id", id);
        if (error) throw new Error(`Knowledge delete failed: ${error.message}`);
      })(), this.storageTimeout);
    });
  }
  async updateConfidence(id, confidence) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { error } = await this.supabase.from("memory_knowledge").update({ confidence, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", id);
        if (error) throw new Error(`Knowledge update failed: ${error.message}`);
      })(), this.storageTimeout);
    });
  }
};

// src/retrieval/gate.ts
var DEFAULT_GATE_OPTIONS = {
  minScore: 0.3,
  maxResults: 10
};
var SKIP_PATTERNS = [
  /^(hi|hey|hello|yo|sup|hola|greetings|good\s*(morning|afternoon|evening|night))[\s!?.]*$/i,
  /^(ok|okay|k|sure|yep|yeah|yes|no|nah|nope|fine|cool|nice|great|thanks|thank you|thx|ty|np)[\s!?.]*$/i,
  /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u,
  /^(lol|lmao|haha|heh|rofl|xd)[\s!?.]*$/i,
  /^HEARTBEAT/i,
  /^\s*$/
];
var TRIGGER_PATTERNS = [
  // Questions
  /\b(what|who|when|where|why|how|which|can you|do you|did|does|is there|are there)\b.*\?/i,
  /\?$/,
  // Temporal references
  /\b(last\s*(week|month|time|session|year)|yesterday|before|earlier|previously|ago|back when)\b/i,
  // Preference / memory queries
  /\b(remember|recall|my\s*(preference|favorite|name|email|address)|you\s*(told|said|mentioned))\b/i,
  // Explicit memory requests
  /\b(search\s*memory|look\s*up|find\s*(in|from)\s*memory)\b/i
];
function shouldRetrieve(text) {
  if (!text || text.trim().length === 0) return false;
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  if (SKIP_PATTERNS.some((p) => p.test(trimmed))) return false;
  if (TRIGGER_PATTERNS.some((p) => p.test(trimmed))) return true;
  return trimmed.length > 15;
}
var RetrievalGate = class {
  opts;
  constructor(opts) {
    this.opts = { ...DEFAULT_GATE_OPTIONS, ...opts };
  }
  /**
   * Pre-filter: should we even attempt retrieval for this message?
   */
  shouldRetrieve(text) {
    return shouldRetrieve(text);
  }
  filter(results, tier) {
    const qualifying = results.filter((r) => r.similarity >= this.opts.minScore);
    const sorted = qualifying.sort((a, b) => b.similarity - a.similarity);
    const capped = sorted.slice(0, this.opts.maxResults);
    return {
      results: capped,
      filtered: results.length - capped.length,
      tier
    };
  }
  getMinScore() {
    return this.opts.minScore;
  }
  getMaxResults() {
    return this.opts.maxResults;
  }
};

// src/retrieval/tier-router.ts
var TierRouter = class _TierRouter {
  static EPISODE_PATTERNS = [
    /\b(just|recently|last|earlier|today|now|current)\b/i,
    /\b(said|told|asked|mentioned|wrote)\b/i,
    /\b(this session|this chat|this conversation)\b/i
  ];
  static KNOWLEDGE_PATTERNS = [
    /\b(what is|who is|how to|explain|define|meaning)\b/i,
    /\b(always|generally|usually|typically|in general)\b/i,
    /\b(fact|rule|principle|concept|definition)\b/i,
    /\b(preference|like|dislike|favorite|hate)\b/i
  ];
  static DIGEST_PATTERNS = [
    /\b(summary|summarize|overview|recap|review)\b/i,
    /\b(previous session|last time|before|history)\b/i,
    /\b(pattern|trend|theme|recurring)\b/i
  ];
  route(query) {
    if (!query || query.trim().length === 0) {
      return ["episode", "digest", "knowledge"];
    }
    const trimmed = query.trim();
    if (trimmed.length < 20) {
      return ["episode"];
    }
    const tiers = /* @__PURE__ */ new Set();
    if (_TierRouter.EPISODE_PATTERNS.some((p) => p.test(trimmed))) {
      tiers.add("episode");
    }
    if (_TierRouter.KNOWLEDGE_PATTERNS.some((p) => p.test(trimmed))) {
      tiers.add("knowledge");
    }
    if (_TierRouter.DIGEST_PATTERNS.some((p) => p.test(trimmed))) {
      tiers.add("digest");
    }
    if (tiers.size > 0) {
      if (tiers.has("episode") && !tiers.has("digest")) {
        tiers.add("digest");
      }
      if (tiers.has("knowledge") && !tiers.has("digest")) {
        tiers.add("digest");
      }
      return [...tiers];
    }
    if (trimmed.length > 80) {
      return ["episode", "digest", "knowledge"];
    }
    return ["episode", "digest", "knowledge"];
  }
};

// src/utils/embeddings.ts
import OpenAI from "openai";
var OpenAIEmbeddingService = class {
  client;
  model;
  dimensions;
  breaker;
  timeoutMs;
  constructor(opts) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? "text-embedding-3-small";
    this.dimensions = opts.dimensions ?? 1536;
    this.breaker = opts.breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 3e4 });
    this.timeoutMs = opts.timeoutMs ?? TIMEOUTS.EMBEDDING;
  }
  async embed(text) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple(
        this.client.embeddings.create({
          model: this.model,
          input: text,
          dimensions: this.dimensions
        }).then((resp) => resp.data[0].embedding),
        this.timeoutMs
      );
    });
  }
  async embedBatch(texts) {
    return this.breaker.execute(async () => {
      return withTimeoutSimple(
        this.client.embeddings.create({
          model: this.model,
          input: texts,
          dimensions: this.dimensions
        }).then((resp) => resp.data.map((d) => d.embedding)),
        this.timeoutMs
      );
    });
  }
};
var NullEmbeddingService = class {
  dimensions;
  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }
  async embed(_text) {
    return new Array(this.dimensions).fill(0);
  }
  async embedBatch(texts) {
    return texts.map(() => new Array(this.dimensions).fill(0));
  }
};

export {
  CircuitBreaker,
  CircuitOpenError,
  TIMEOUTS,
  TimeoutError,
  withTimeout,
  withTimeoutSimple,
  EpisodeStore,
  DigestStore,
  KnowledgeStore,
  RetrievalGate,
  TierRouter,
  OpenAIEmbeddingService,
  NullEmbeddingService
};
