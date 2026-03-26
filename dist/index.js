import {
  CircuitBreaker,
  CircuitOpenError,
  DigestStore,
  EpisodeStore,
  KnowledgeStore,
  NullEmbeddingService,
  OpenAIEmbeddingService,
  RetrievalGate,
  TIMEOUTS,
  TierRouter,
  TimeoutError,
  withTimeout,
  withTimeoutSimple
} from "./chunk-U45FSCD6.js";

// src/tiers/working-memory.ts
var WorkingMemory = class {
  items = /* @__PURE__ */ new Map();
  sessionId;
  supabase;
  breaker;
  maxItems;
  constructor(sessionId, supabase, breaker, maxItems = 50) {
    this.sessionId = sessionId;
    this.supabase = supabase;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 3e4 });
    this.maxItems = maxItems;
  }
  /** Add or update a working memory item */
  set(item) {
    if (this.items.size >= this.maxItems && !this.items.has(item.key)) {
      let minKey = "";
      let minImportance = Infinity;
      for (const [key, existing] of this.items) {
        if (existing.importance < minImportance) {
          minImportance = existing.importance;
          minKey = key;
        }
      }
      if (minKey) this.items.delete(minKey);
    }
    this.items.set(item.key, item);
  }
  get(key) {
    return this.items.get(key);
  }
  remove(key) {
    return this.items.delete(key);
  }
  getAll() {
    return [...this.items.values()].sort((a, b) => b.importance - a.importance);
  }
  getByCategory(category) {
    return this.getAll().filter((item) => item.category === category);
  }
  size() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  extractFromEpisode(episode) {
    const content = episode.content;
    const topicPatterns = [
      /(?:talking about|discussing|working on|building)\s+(.+?)(?:\.|,|$)/gi
    ];
    for (const pattern of topicPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        this.set({
          key: `topic:${match[1].trim().toLowerCase().slice(0, 50)}`,
          value: match[1].trim(),
          category: "topic",
          importance: 0.6,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    }
    const decisionPatterns = [
      /(?:let's|we'll|I'll|going to|decided to)\s+(.+?)(?:\.|,|$)/gi
    ];
    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        this.set({
          key: `decision:${Date.now()}`,
          value: match[1].trim(),
          category: "decision",
          importance: 0.8,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    }
    const prefPatterns = [
      /(?:I prefer|I like|I want|I need)\s+(.+?)(?:\.|,|$)/gi
    ];
    for (const pattern of prefPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        this.set({
          key: `pref:${match[1].trim().toLowerCase().slice(0, 50)}`,
          value: match[1].trim(),
          category: "preference",
          importance: 0.9,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    }
  }
  async persist() {
    if (this.items.size === 0) return;
    const snapshot = {
      session_id: this.sessionId,
      items: this.getAll(),
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    await this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { error } = await this.supabase.from("memory_digests").insert({
          session_id: this.sessionId,
          summary: `Working memory snapshot: ${this.items.size} items`,
          key_topics: this.getByCategory("topic").map((i) => i.value),
          episode_ids: [],
          metadata: {
            source: "working_memory",
            snapshot
          }
        });
        if (error) throw new Error(`Working memory persist failed: ${error.message}`);
      })(), TIMEOUTS.STORAGE);
    });
  }
  async load() {
    try {
      const result = await this.breaker.execute(async () => {
        return withTimeoutSimple((async () => {
          const { data, error } = await this.supabase.from("memory_digests").select("metadata").eq("session_id", this.sessionId).eq("metadata->>source", "working_memory").order("created_at", { ascending: false }).limit(1).single();
          if (error) {
            if (error.code === "PGRST116") return null;
            throw new Error(`Working memory load failed: ${error.message}`);
          }
          return data;
        })(), TIMEOUTS.RETRIEVAL);
      });
      if (result?.metadata?.snapshot) {
        const snapshot = result.metadata.snapshot;
        for (const item of snapshot.items) {
          this.items.set(item.key, item);
        }
      }
    } catch {
    }
  }
};

// src/tiers/summarizer.ts
import OpenAI from "openai";
var SYSTEM_PROMPT = `You are a memory summarizer for an AI assistant. Given a batch of conversation episodes, produce a structured summary.

Respond in JSON with exactly this shape:
{
  "summary": "A concise summary of the conversation (2-4 sentences)",
  "topics": ["topic1", "topic2"],
  "entities": ["person or thing mentioned"],
  "decisions": ["any decisions or conclusions reached"]
}

Be concise. Extract only the most important information. If no decisions were made, use an empty array.`;
var Summarizer = class {
  client;
  model;
  maxTokens;
  constructor(opts) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? "gpt-4o-mini";
    this.maxTokens = opts.maxTokens ?? 500;
  }
  /**
   * Summarize a batch of episodes into a structured result.
   */
  async summarize(episodes) {
    if (episodes.length === 0) {
      return { summary: "", topics: [], entities: [], decisions: [] };
    }
    const conversationText = episodes.map((ep) => `[${ep.role}]: ${ep.content}`).join("\n");
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: conversationText }
      ],
      max_tokens: this.maxTokens,
      temperature: 0.3
    });
    const text = resp.choices[0]?.message?.content ?? "{}";
    return this.parseResponse(text);
  }
  /**
   * Summarize episodes and format as a Digest-compatible object.
   */
  async summarizeToDigest(sessionId, episodes) {
    const result = await this.summarize(episodes);
    const episodeIds = episodes.map((ep) => ep.id).filter((id) => !!id);
    return {
      session_id: sessionId,
      summary: result.summary,
      key_topics: result.topics,
      episode_ids: episodeIds,
      metadata: {
        source: "summarizer",
        entities: result.entities,
        decisions: result.decisions
      }
    };
  }
  parseResponse(text) {
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
      const json = JSON.parse(jsonMatch[1] ?? text);
      return {
        summary: json.summary ?? "",
        topics: Array.isArray(json.topics) ? json.topics : [],
        entities: Array.isArray(json.entities) ? json.entities : [],
        decisions: Array.isArray(json.decisions) ? json.decisions : []
      };
    } catch {
      return {
        summary: text.slice(0, 500),
        topics: [],
        entities: [],
        decisions: []
      };
    }
  }
};

// src/tiers/knowledge-extractor.ts
var IMMEDIATE_PATTERNS = [
  { pattern: /I prefer\s+(.+?)(?:\.|,|$)/gi, category: "preference" },
  { pattern: /I always\s+(.+?)(?:\.|,|$)/gi, category: "preference" },
  { pattern: /I never\s+(.+?)(?:\.|,|$)/gi, category: "preference" },
  { pattern: /I like\s+(.+?)(?:\.|,|$)/gi, category: "preference" },
  { pattern: /I don't like\s+(.+?)(?:\.|,|$)/gi, category: "preference" },
  { pattern: /I hate\s+(.+?)(?:\.|,|$)/gi, category: "preference" },
  { pattern: /let's go with\s+(.+?)(?:\.|,|$)/gi, category: "decision" },
  { pattern: /we decided to\s+(.+?)(?:\.|,|$)/gi, category: "decision" },
  { pattern: /the plan is to\s+(.+?)(?:\.|,|$)/gi, category: "decision" },
  { pattern: /my (?:name|email|timezone|location) is\s+(.+?)(?:\.|,|$)/gi, category: "personal_info" }
];
var KnowledgeExtractor = class {
  patternCounts = /* @__PURE__ */ new Map();
  batchThreshold;
  batchWindowDays;
  constructor(opts) {
    this.batchThreshold = opts?.batchThreshold ?? 3;
    this.batchWindowDays = opts?.batchWindowDays ?? 7;
  }
  /**
   * Extract knowledge from digests — finds both immediate and batch patterns.
   */
  extractFromDigests(digests) {
    const results = [];
    for (const digest of digests) {
      const immediateResults = this.extractImmediate(digest);
      results.push(...immediateResults);
      for (const topic of digest.key_topics) {
        this.trackPattern(topic, digest.id ?? "");
      }
    }
    const batchResults = this.extractBatch();
    results.push(...batchResults);
    return results;
  }
  /**
   * Extract immediately promotable knowledge from a single digest.
   */
  extractImmediate(digest) {
    const results = [];
    const text = digest.summary;
    for (const { pattern, category } of IMMEDIATE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const content = match[1].trim();
        if (content.length < 3) continue;
        results.push({
          topic: category,
          content,
          confidence: 0.9,
          // High confidence for explicit statements
          sourceDigestIds: digest.id ? [digest.id] : [],
          metadata: { extraction: "immediate", category }
        });
      }
    }
    return results;
  }
  /**
   * Track a pattern occurrence for batch promotion.
   */
  trackPattern(topic, digestId) {
    const key = topic.toLowerCase().trim();
    const existing = this.patternCounts.get(key);
    if (existing) {
      existing.count++;
      if (!existing.digestIds.includes(digestId)) {
        existing.digestIds.push(digestId);
      }
    } else {
      this.patternCounts.set(key, {
        count: 1,
        firstSeen: Date.now(),
        digestIds: [digestId]
      });
    }
  }
  /**
   * Extract batch-promoted knowledge (patterns occurring 3+ times within window).
   */
  extractBatch() {
    const results = [];
    const windowMs = this.batchWindowDays * 24 * 60 * 60 * 1e3;
    const now = Date.now();
    for (const [topic, data] of this.patternCounts) {
      if (data.count >= this.batchThreshold && now - data.firstSeen <= windowMs) {
        const confidence = Math.min(0.5 + (data.count - this.batchThreshold) * 0.1, 0.85);
        results.push({
          topic: "recurring_topic",
          content: topic,
          confidence,
          sourceDigestIds: data.digestIds,
          metadata: {
            extraction: "batch",
            occurrences: data.count
          }
        });
      }
    }
    return results;
  }
  /**
   * Check if new knowledge supersedes existing knowledge.
   * Returns the ID of the superseded knowledge, or null.
   */
  checkSupersession(newContent, existingKnowledge) {
    const contradictionPairs = [
      [/I prefer\s+(.+)/i, /I don't like\s+(.+)/i],
      [/I like\s+(.+)/i, /I hate\s+(.+)/i],
      [/I always\s+(.+)/i, /I never\s+(.+)/i]
    ];
    for (const existing of existingKnowledge) {
      for (const [patternA, patternB] of contradictionPairs) {
        const newMatchA = newContent.match(patternA);
        const existMatchB = existing.content.match(patternB);
        if (newMatchA && existMatchB) {
          const newSubject = newMatchA[1].toLowerCase().trim();
          const existSubject = existMatchB[1].toLowerCase().trim();
          if (this.subjectsOverlap(newSubject, existSubject)) {
            return existing.id ?? null;
          }
        }
        const newMatchB = newContent.match(patternB);
        const existMatchA = existing.content.match(patternA);
        if (newMatchB && existMatchA) {
          const newSubject = newMatchB[1].toLowerCase().trim();
          const existSubject = existMatchA[1].toLowerCase().trim();
          if (this.subjectsOverlap(newSubject, existSubject)) {
            return existing.id ?? null;
          }
        }
      }
    }
    return null;
  }
  subjectsOverlap(a, b) {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }
    return overlap / Math.max(wordsA.size, wordsB.size) > 0.5;
  }
  /** Reset pattern tracking (for testing) */
  reset() {
    this.patternCounts.clear();
  }
};

// src/ingestion/write-buffer.ts
import { v4 as uuidv4 } from "uuid";
var DEFAULT_OPTIONS = {
  maxBufferSize: 1e3,
  maxRetries: 3,
  baseRetryMs: 500,
  maxRetryMs: 3e4
};
var WriteBuffer = class {
  supabase;
  breaker;
  opts;
  memoryQueue = [];
  retryTimer = null;
  disposed = false;
  constructor(supabase, breaker, options) {
    this.supabase = supabase;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 3e4 });
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }
  async enqueue(tier, payload) {
    const entry = {
      id: uuidv4(),
      tier,
      payload,
      status: "pending",
      retry_count: 0
    };
    try {
      return await this.persistEntry(entry);
    } catch {
      this.addToMemoryQueue(entry);
      this.scheduleRetry();
      return entry;
    }
  }
  async persistEntry(entry) {
    return this.breaker.execute(async () => {
      const { data, error } = await this.supabase.from("memory_write_buffer").insert(entry).select().single();
      if (error) throw new Error(`Write buffer enqueue failed: ${error.message}`);
      return data;
    });
  }
  addToMemoryQueue(entry) {
    if (this.memoryQueue.length >= this.opts.maxBufferSize) {
      this.memoryQueue.shift();
    }
    this.memoryQueue.push(entry);
  }
  scheduleRetry(attempt = 0) {
    if (this.disposed || this.retryTimer) return;
    const delay = Math.min(
      this.opts.baseRetryMs * Math.pow(2, attempt),
      this.opts.maxRetryMs
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.processRetries(attempt);
    }, delay);
  }
  async processRetries(attempt) {
    if (this.memoryQueue.length === 0) return;
    const toRetry = [...this.memoryQueue];
    const stillFailed = [];
    for (const entry of toRetry) {
      if (entry.retry_count >= this.opts.maxRetries) {
        entry.status = "failed";
        continue;
      }
      try {
        await this.persistEntry(entry);
      } catch {
        entry.retry_count++;
        if (entry.retry_count < this.opts.maxRetries) {
          stillFailed.push(entry);
        } else {
          entry.status = "failed";
        }
      }
    }
    this.memoryQueue = stillFailed;
    if (stillFailed.length > 0 && !this.disposed) {
      this.scheduleRetry(attempt + 1);
    }
  }
  async getPending(limit = 50) {
    return this.breaker.execute(async () => {
      const { data, error } = await this.supabase.from("memory_write_buffer").select("*").eq("status", "pending").lt("retry_count", this.opts.maxRetries).order("created_at", { ascending: true }).limit(limit);
      if (error) throw new Error(`Write buffer fetch failed: ${error.message}`);
      return data ?? [];
    });
  }
  async markProcessing(id) {
    return this.breaker.execute(async () => {
      const { error } = await this.supabase.from("memory_write_buffer").update({ status: "processing" }).eq("id", id);
      if (error) throw new Error(`Write buffer update failed: ${error.message}`);
    });
  }
  async markDone(id) {
    return this.breaker.execute(async () => {
      const { error } = await this.supabase.from("memory_write_buffer").update({ status: "done" }).eq("id", id);
      if (error) throw new Error(`Write buffer update failed: ${error.message}`);
    });
  }
  async markFailed(id) {
    return this.breaker.execute(async () => {
      const { data: current, error: fetchErr } = await this.supabase.from("memory_write_buffer").select("retry_count").eq("id", id).single();
      if (fetchErr) throw new Error(`Write buffer fetch failed: ${fetchErr.message}`);
      const retryCount = (current?.retry_count ?? 0) + 1;
      const status = retryCount >= this.opts.maxRetries ? "failed" : "pending";
      const { error } = await this.supabase.from("memory_write_buffer").update({ status, retry_count: retryCount }).eq("id", id);
      if (error) throw new Error(`Write buffer update failed: ${error.message}`);
    });
  }
  getMemoryQueue() {
    return this.memoryQueue;
  }
  getMemoryQueueSize() {
    return this.memoryQueue.length;
  }
  async flush() {
    if (this.memoryQueue.length === 0) return 0;
    const toFlush = [...this.memoryQueue];
    const remaining = [];
    for (const entry of toFlush) {
      try {
        await this.persistEntry(entry);
      } catch {
        remaining.push(entry);
      }
    }
    this.memoryQueue = remaining;
    return remaining.length;
  }
  async dispose() {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.flush();
  }
};

// src/ingestion/async-ingest.ts
var AsyncIngest = class {
  episodeStore;
  onError;
  constructor(episodeStore, _breaker, onError) {
    this.episodeStore = episodeStore;
    this.onError = onError;
  }
  /**
   * Ingest a single episode asynchronously (fire-and-forget).
   * Returns immediately; the write happens in the background.
   */
  ingest(episode) {
    queueMicrotask(() => {
      this.episodeStore.insert(episode).catch((err) => {
        this.onError?.(err);
      });
    });
  }
  /**
   * Ingest a batch of episodes asynchronously (fire-and-forget).
   */
  ingestBatch(episodes) {
    queueMicrotask(() => {
      const promises = episodes.map(
        (ep) => this.episodeStore.insert(ep).catch((err) => {
          this.onError?.(err);
        })
      );
      void Promise.allSettled(promises);
    });
  }
};

// src/ingestion/compaction-handler.ts
var CompactionHandler = class {
  digestStore;
  workingMemory;
  constructor(digestStore, workingMemory) {
    this.digestStore = digestStore;
    this.workingMemory = workingMemory ?? null;
  }
  /**
   * Handle a compaction event.
   * Summarizes the provided episodes into a digest and persists working memory.
   */
  async onCompact(sessionId, episodes) {
    if (episodes.length === 0) return null;
    const summary = this.buildSummary(episodes);
    const topics = this.extractTopics(episodes);
    const episodeIds = episodes.map((ep) => ep.id).filter((id) => !!id);
    const digest = await this.digestStore.insert({
      session_id: sessionId,
      summary,
      key_topics: topics,
      episode_ids: episodeIds,
      metadata: { source: "compaction" }
    });
    if (this.workingMemory) {
      try {
        await this.workingMemory.persist();
      } catch {
      }
    }
    return digest;
  }
  buildSummary(episodes) {
    const parts = [];
    const userMessages = episodes.filter((ep) => ep.role === "user");
    const assistantMessages = episodes.filter((ep) => ep.role === "assistant");
    if (userMessages.length > 0) {
      const topics = userMessages.map((ep) => ep.content.slice(0, 100)).slice(0, 5);
      parts.push(`User discussed: ${topics.join("; ")}`);
    }
    if (assistantMessages.length > 0) {
      const actions = assistantMessages.map((ep) => ep.content.slice(0, 100)).slice(0, 3);
      parts.push(`Assistant covered: ${actions.join("; ")}`);
    }
    parts.push(`${episodes.length} messages total in this segment.`);
    return parts.join(". ");
  }
  extractTopics(episodes) {
    const stopWords = /* @__PURE__ */ new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "can",
      "shall",
      "to",
      "of",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "it",
      "this",
      "that",
      "not",
      "but",
      "and",
      "or",
      "if",
      "then",
      "so",
      "as",
      "i",
      "you",
      "we",
      "they",
      "he",
      "she",
      "my",
      "your",
      "our",
      "me",
      "us",
      "them",
      "what",
      "how"
    ]);
    const wordCounts = /* @__PURE__ */ new Map();
    for (const ep of episodes) {
      const words = ep.content.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w));
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }
    return [...wordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word]) => word);
  }
};

// src/utils/deduplicator.ts
var Deduplicator = class {
  threshold;
  constructor(threshold = 0.92) {
    this.threshold = threshold;
  }
  /**
   * Check if new content is semantically duplicate of any existing knowledge.
   */
  checkDuplicate(newEmbedding, existingKnowledge) {
    let bestMatch = null;
    for (const existing of existingKnowledge) {
      const similarity = this.cosineSimilarity(newEmbedding, existing.embedding);
      if (similarity > this.threshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { id: existing.id, similarity };
        }
      }
    }
    if (bestMatch) {
      return {
        isDuplicate: true,
        existingId: bestMatch.id,
        similarity: bestMatch.similarity
      };
    }
    return { isDuplicate: false };
  }
  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }
  /** Get the current threshold */
  getThreshold() {
    return this.threshold;
  }
};

// src/utils/entity-extractor.ts
var TECH_PATTERNS = [
  // Languages
  /\b(TypeScript|JavaScript|Python|Rust|Go|Java|Kotlin|Swift|Ruby|PHP|C\+\+|C#)\b/gi,
  // Frameworks/tools
  /\b(React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|FastAPI|Django|Flask|Spring)\b/gi,
  /\b(Node\.js|Deno|Bun|Docker|Kubernetes|Terraform|AWS|GCP|Azure)\b/gi,
  /\b(PostgreSQL|MySQL|MongoDB|Redis|Supabase|Firebase|Prisma|Drizzle)\b/gi,
  /\b(Git|GitHub|GitLab|Bitbucket|Vercel|Netlify|Cloudflare)\b/gi,
  /\b(OpenAI|Claude|GPT-[34o]|Anthropic|LLM|pgvector|Tailscale)\b/gi,
  /\b(Vitest|Jest|Mocha|ESLint|Prettier|Webpack|Vite|tsup|esbuild)\b/gi
];
var PROJECT_PATTERNS = [
  // "the X project", "working on X", "building X"
  /(?:the|our|my)\s+(\w[\w-]*(?:\s+\w[\w-]*)?)\s+project/gi,
  /(?:working on|building|developing)\s+(\w[\w-]*(?:-\w+)*)/gi,
  // kebab-case or camelCase identifiers that look like project names
  /\b([a-z][\w]*-[a-z][\w]*(?:-[a-z][\w]*)*)\b/g
];
var PERSON_PATTERNS = [
  // "tell X", "ask X", "X said", "@X"
  /(?:(?:tell|ask|cc|ping)\s+|@)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  // Two capitalized words together (likely a full name)
  /(?:^|[.!?]\s+)(?!(?:The|This|That|These|Those|What|How|Why|When|Where|Who|I|We|He|She|It|They|You|My|Our|His|Her|Its|Their|Your)\b)([A-Z][a-z]+\s+[A-Z][a-z]+)/gm
];
var NAME_BLACKLIST = /* @__PURE__ */ new Set([
  "The",
  "This",
  "That",
  "These",
  "Those",
  "What",
  "How",
  "Why",
  "When",
  "Where",
  "Who",
  "Which",
  "There",
  "Here",
  "Some",
  "Any",
  "Each",
  "Every",
  "Both",
  "All",
  "Most",
  "Many",
  "Much",
  "More",
  "Other",
  "Another",
  "Such",
  "Same",
  "Good",
  "Great",
  "Best",
  "New",
  "Old",
  "First",
  "Last",
  "Next",
  "Previous"
]);
var EntityExtractor = class {
  /**
   * Extract entities from text.
   */
  extract(text) {
    return {
      people: this.extractPeople(text),
      technologies: this.extractTechnologies(text),
      projects: this.extractProjects(text)
    };
  }
  /**
   * Extract and return as flat metadata tags.
   */
  extractAsTags(text) {
    const entities = this.extract(text);
    const tags = {};
    if (entities.people.length > 0) tags.people = entities.people;
    if (entities.technologies.length > 0) tags.technologies = entities.technologies;
    if (entities.projects.length > 0) tags.projects = entities.projects;
    return tags;
  }
  extractPeople(text) {
    const names = /* @__PURE__ */ new Set();
    for (const pattern of PERSON_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1].trim();
        const firstName = name.split(/\s+/)[0];
        if (!NAME_BLACKLIST.has(firstName) && name.length > 1) {
          names.add(name);
        }
      }
    }
    return [...names];
  }
  extractTechnologies(text) {
    const techs = /* @__PURE__ */ new Set();
    for (const pattern of TECH_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        techs.add(match[1]);
      }
    }
    return [...techs];
  }
  extractProjects(text) {
    const projects = /* @__PURE__ */ new Set();
    for (const pattern of PROJECT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1].trim();
        if (name.length > 3 && !name.match(/^(the|our|my|this|that|some|will|have|been|with)$/i)) {
          projects.add(name);
        }
      }
    }
    return [...projects];
  }
};

// src/utils/batch-embedder.ts
var BatchEmbedder = class {
  embeddings;
  maxBatchSize;
  accumulateMs;
  pending = [];
  timer = null;
  constructor(embeddings, opts) {
    this.embeddings = embeddings;
    this.maxBatchSize = opts?.maxBatchSize ?? 2048;
    this.accumulateMs = opts?.accumulateMs ?? 5e3;
  }
  /**
   * Queue a text for embedding. Returns a promise that resolves
   * when the batch is processed.
   */
  embed(text) {
    return new Promise((resolve, reject) => {
      this.pending.push({ text, resolve, reject });
      if (this.pending.length >= this.maxBatchSize) {
        this.flushNow();
      } else if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flushNow();
        }, this.accumulateMs);
      }
    });
  }
  /** Flush all pending embeddings now */
  flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending.splice(0, this.maxBatchSize);
    if (batch.length === 0) return;
    const texts = batch.map((b) => b.text);
    this.embeddings.embedBatch(texts).then((embeddings) => {
      for (let i = 0; i < batch.length; i++) {
        batch[i].resolve(embeddings[i]);
      }
    }).catch((err) => {
      for (const item of batch) {
        item.reject(err);
      }
    });
  }
  /** Force flush and dispose */
  async dispose() {
    this.flushNow();
  }
  /** Get count of pending embeddings */
  getPendingCount() {
    return this.pending.length;
  }
};

// src/cron/daily-summarizer.ts
var DailySummarizer = class {
  supabase;
  summarizer;
  digestStore;
  batchSize;
  constructor(opts) {
    this.supabase = opts.supabase;
    this.summarizer = opts.summarizer;
    this.digestStore = opts.digestStore;
    this.batchSize = opts.batchSize ?? 20;
  }
  /**
   * Run the daily summarization.
   * Groups unsummarized episodes by session, summarizes each group.
   */
  async run() {
    const unsummarized = await this.getUnsummarizedEpisodes();
    if (unsummarized.length === 0) {
      return { digestsCreated: 0, episodesProcessed: 0 };
    }
    const bySession = /* @__PURE__ */ new Map();
    for (const ep of unsummarized) {
      const group = bySession.get(ep.session_id) ?? [];
      group.push(ep);
      bySession.set(ep.session_id, group);
    }
    let digestsCreated = 0;
    let episodesProcessed = 0;
    for (const [sessionId, episodes] of bySession) {
      for (let i = 0; i < episodes.length; i += this.batchSize) {
        const batch = episodes.slice(i, i + this.batchSize);
        try {
          const digestData = await this.summarizer.summarizeToDigest(sessionId, batch);
          await this.digestStore.insert(digestData);
          digestsCreated++;
          episodesProcessed += batch.length;
        } catch (err) {
          console.error(`Failed to summarize batch for session ${sessionId}:`, err);
        }
      }
    }
    return { digestsCreated, episodesProcessed };
  }
  async getUnsummarizedEpisodes() {
    const { data: digests } = await this.supabase.from("memory_digests").select("episode_ids");
    const summarizedIds = /* @__PURE__ */ new Set();
    for (const digest of digests ?? []) {
      for (const id of digest.episode_ids ?? []) {
        summarizedIds.add(id);
      }
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
    const { data: episodes, error } = await this.supabase.from("memory_episodes").select("*").gte("created_at", since).order("created_at", { ascending: true });
    if (error || !episodes) return [];
    return episodes.filter(
      (ep) => ep.id && !summarizedIds.has(ep.id)
    );
  }
};

// src/cron/weekly-promoter.ts
var WeeklyPromoter = class {
  supabase;
  extractor;
  knowledgeStore;
  deduplicator;
  embeddings;
  constructor(opts) {
    this.supabase = opts.supabase;
    this.extractor = opts.knowledgeExtractor;
    this.knowledgeStore = opts.knowledgeStore;
    this.deduplicator = opts.deduplicator;
    this.embeddings = opts.embeddings;
  }
  async run() {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1e3).toISOString();
    const { data: digests, error } = await this.supabase.from("memory_digests").select("*").gte("created_at", since).order("created_at", { ascending: true });
    if (error || !digests || digests.length === 0) {
      return { promoted: 0, deduplicated: 0, superseded: 0 };
    }
    const extractions = this.extractor.extractFromDigests(digests);
    const { data: existingData } = await this.supabase.from("memory_knowledge").select("id, content, embedding, metadata");
    const existing = existingData ?? [];
    let promoted = 0;
    let deduplicated = 0;
    let superseded = 0;
    for (const extraction of extractions) {
      const embedding = await this.embeddings.embed(extraction.content);
      const existingWithEmbeddings = existing.filter((k) => k.embedding).map((k) => ({
        id: k.id,
        embedding: Array.isArray(k.embedding) ? k.embedding : JSON.parse(k.embedding)
      }));
      const dupResult = this.deduplicator.checkDuplicate(embedding, existingWithEmbeddings);
      if (dupResult.isDuplicate && dupResult.existingId) {
        const existingEntry = existing.find((k) => k.id === dupResult.existingId);
        if (existingEntry) {
          const count = (existingEntry.metadata?.occurrence_count ?? 1) + 1;
          await this.supabase.from("memory_knowledge").update({
            metadata: { ...existingEntry.metadata, occurrence_count: count },
            updated_at: (/* @__PURE__ */ new Date()).toISOString()
          }).eq("id", dupResult.existingId);
          deduplicated++;
        }
        continue;
      }
      const supersededId = this.extractor.checkSupersession(
        extraction.content,
        existing
      );
      if (supersededId) {
        await this.supabase.from("memory_knowledge").update({
          metadata: { superseded: true, superseded_by: extraction.content },
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }).eq("id", supersededId);
        superseded++;
      }
      await this.knowledgeStore.insert({
        topic: extraction.topic,
        content: extraction.content,
        confidence: extraction.confidence,
        embedding,
        source_digest_ids: extraction.sourceDigestIds,
        metadata: extraction.metadata ?? {}
      });
      promoted++;
    }
    return { promoted, deduplicated, superseded };
  }
};

// src/cron/cleanup.ts
var Cleanup = class {
  supabase;
  archiveAfterDays;
  pruneBufferAfterDays;
  constructor(opts) {
    this.supabase = opts.supabase;
    this.archiveAfterDays = opts.archiveAfterDays ?? 30;
    this.pruneBufferAfterDays = opts.pruneBufferAfterDays ?? 7;
  }
  async run() {
    const archived = await this.archiveOldEpisodes();
    const pruned = await this.pruneWriteBuffer();
    return { archived, pruned };
  }
  /**
   * Archive episodes older than archiveAfterDays that have been summarized.
   */
  async archiveOldEpisodes() {
    const cutoff = new Date(
      Date.now() - this.archiveAfterDays * 24 * 60 * 60 * 1e3
    ).toISOString();
    const { data: digests } = await this.supabase.from("memory_digests").select("episode_ids");
    const summarizedIds = /* @__PURE__ */ new Set();
    for (const digest of digests ?? []) {
      for (const id of digest.episode_ids ?? []) {
        summarizedIds.add(id);
      }
    }
    if (summarizedIds.size === 0) return 0;
    const { data: oldEpisodes } = await this.supabase.from("memory_episodes").select("id").lt("created_at", cutoff);
    if (!oldEpisodes || oldEpisodes.length === 0) return 0;
    const toArchive = oldEpisodes.filter((ep) => summarizedIds.has(ep.id)).map((ep) => ep.id);
    if (toArchive.length === 0) return 0;
    const { error } = await this.supabase.from("memory_episodes").update({
      metadata: { archived: true, archived_at: (/* @__PURE__ */ new Date()).toISOString() }
    }).in("id", toArchive);
    if (error) {
      console.error("Failed to archive episodes:", error);
      return 0;
    }
    return toArchive.length;
  }
  /**
   * Prune old/completed write buffer entries.
   */
  async pruneWriteBuffer() {
    const cutoff = new Date(
      Date.now() - this.pruneBufferAfterDays * 24 * 60 * 60 * 1e3
    ).toISOString();
    const { data, error } = await this.supabase.from("memory_write_buffer").delete().lt("created_at", cutoff).in("status", ["done", "failed"]).select("id");
    if (error) {
      console.error("Failed to prune write buffer:", error);
      return 0;
    }
    return data?.length ?? 0;
  }
};
export {
  AsyncIngest,
  BatchEmbedder,
  CircuitBreaker,
  CircuitOpenError,
  Cleanup,
  CompactionHandler,
  DailySummarizer,
  Deduplicator,
  DigestStore,
  EntityExtractor,
  EpisodeStore,
  KnowledgeExtractor,
  KnowledgeStore,
  NullEmbeddingService,
  OpenAIEmbeddingService,
  RetrievalGate,
  Summarizer,
  TIMEOUTS,
  TierRouter,
  TimeoutError,
  WeeklyPromoter,
  WorkingMemory,
  WriteBuffer,
  withTimeout,
  withTimeoutSimple
};
