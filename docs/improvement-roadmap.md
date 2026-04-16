# Engram Improvement Roadmap

**Date**: 2026-03-27
**Based on**: Deep research sweep across agent memory SOTA, OpenClaw ecosystem, neuroscience, technical options, and competitive landscape

---

## Executive Summary

Engram's brain-inspired architecture is genuinely differentiated. No competing system has five neuroscience-modeled memory subsystems with consolidation cycles, association graphs, and reconsolidation on access. However, the field is moving fast. Between Letta's 74% LoCoMo score with a *filesystem*, Mem0's graph memory, and A-Mem's Zettelkasten approach, Engram needs to ship fast, benchmark publicly, and nail the developer experience to claim the cognitive memory niche.

This roadmap is organized into three milestones: **v0.2** (4-6 weeks, foundational), **v0.5** (2-3 months, competitive), and **v1.0** (4-6 months, production-grade).

---

## 1. State of the Art — What the Competition Does

### 1.1 Competitive Landscape (March 2026)

| System | Architecture | LoCoMo Score | Latency (p95) | Local-First | Open Source |
|--------|-------------|-------------|---------------|-------------|-------------|
| **Letta** | Filesystem + agent tools | 74.0% (GPT-4o-mini) | N/A | Yes | Yes |
| **Mem0** | Fact extraction + graph | 67.1% (managed) | 200ms | No (SaaS) | Partial |
| **Mem0g** (graph) | Temporal knowledge graph | 58.1% on temporal | 200ms | No | Partial |
| **Zep** | Temporal knowledge graph | N/A | N/A | No (SaaS) | Partial |
| **LangMem** | LangGraph-native | 58.1% | 59.82s (!!) | No | Yes |
| **SuperLocalMemory** | Local-only, no LLM | 60% (zero-LLM) / 87.7% (LLM) | N/A | Yes | Yes |
| **A-Mem** | Zettelkasten + LLM links | NeurIPS 2025 paper | N/A | Yes | Yes |
| **Engram** | 5 cognitive systems | **Not yet benchmarked** | N/A | Yes (SQLite) | Yes |

### 1.2 Key Insight: Letta's Filesystem Baseline

Letta demonstrated that simply storing conversation history in files and letting GPT-4o-mini use filesystem tools achieves 74% on LoCoMo — beating Mem0's best graph variant (68.5%). This suggests:

1. **Current memory benchmarks may not capture what matters.** They test retrieval accuracy but not learning, not association, not reconsolidation.
2. **Engram's value proposition isn't better retrieval — it's better cognition.** The association graph, consolidation cycles, and decay dynamics are features no benchmark currently measures.
3. **We need our own benchmark** that tests cognitive memory behaviors: Does the system learn patterns? Does it strengthen frequently-accessed memories? Does it form useful associations?

### 1.3 What Each Competitor Does Well

**Mem0**: Elegant fact extraction pipeline (ADD/UPDATE/DELETE/NOOP operations per memory). Graph memory variant excels at temporal reasoning (58.1% vs OpenAI's 21.7% on temporal questions). Production-ready SaaS with 200ms p95.

**Zep**: Temporal knowledge graph that tracks how facts change over time. Combines graph traversal with vector search. Strong enterprise positioning — structured business data + conversational history.

**A-Mem (NeurIPS 2025)**: Zettelkasten-inspired. Each memory is an atomic "note" with keywords, tags, and contextual descriptions. Link generation identifies semantic + LLM-analyzed connections. Doubles performance on multi-hop reasoning. Most architecturally similar to Engram's association graph.

**Letta**: Stateful agent with explicit, editable memory blocks. Memory is transparent and developer-controlled. Open source commitment. Memory-as-filesystem insight.

**SuperLocalMemory**: Local-only, zero-cloud. 60% LoCoMo with no LLM calls, 87.7% with LLM. Proves local-first agent memory is viable and in-demand.

### 1.4 Common Failure Modes of Agent Memory

Research identifies these recurring problems:

1. **Context drift** — 65% of enterprise AI failures in 2025 attributed to context drift, not context exhaustion
2. **Silent quality degradation** — Models degrade before hitting context limits; a 200K model is unreliable past ~130K
3. **Compounding errors** — 95% per-step reliability over 20 steps = 36% overall success rate
4. **Memory staleness** — Facts change but memories don't update, leading to contradictions
5. **Embedding cost explosion** — Vector retrieval represents 30-40% of agent operating costs in data-dense applications
6. **Deduplication failure** — Without explicit dedup, knowledge bases accumulate redundant entries

### 1.5 Research Papers to Study

- **A-Mem** (NeurIPS 2025) — Zettelkasten-style agentic memory with autonomous link generation
- **Hebbian Memory-Augmented Recurrent Networks** (July 2025) — Differentiable memory matrix with Hebbian plasticity, directly relevant to our association graph strengthening
- **SleepGate** (2025) — Sleep-inspired KV cache management with key decay, learned gating, consolidation
- **ACT-R for LLM Agents** (HAI 2025) — Temporal decay + semantic similarity + noise for human-like memory dynamics
- **MAGMA** (Jan 2026) — Multi-graph agentic memory architecture
- **LifeBench** (2026) — Long-horizon multi-source memory benchmark
- **MEMTRACK** (2025) — Evaluating long-term memory tracking capabilities
- **Learning to Forget** (March 2026) — Sleep-inspired memory consolidation for resolving proactive interference in LLMs
- **MemOS** (July 2025) — Memory operating system for AI systems from MemTensor

---

## 2. Technical Improvements

### 2.1 SQLite Vector Search: sqlite-vec

**Current state**: Engram uses FTS5 with BM25 for Level 0 search. Vector search requires Supabase (pgvector).

**Recommendation**: Adopt **sqlite-vec** for local vector search.

- sqlite-vss (Faiss-based) is **deprecated** — author abandoned it for sqlite-vec
- sqlite-vec is pure C, zero dependencies, runs anywhere SQLite runs (mobile, WASM, edge)
- Brute-force search strategy (no approximate indexing), but good enough for the memory scales Engram targets (<100K memories)
- Vectors must live in separate virtual tables — requires schema adaptation
- Enables **hybrid search**: FTS5 BM25 scores + sqlite-vec cosine similarity, combined via Reciprocal Rank Fusion (RRF)

**Implementation**:
```
Level 0: FTS5 BM25 only (zero-config, no embeddings)
Level 1: FTS5 + sqlite-vec hybrid (local embeddings via nomic-embed or server-side)
Level 2: Supabase pgvector + FTS (cloud, existing path)
```

### 2.2 Embedding Models for 2026

| Model | Params | Max Tokens | Cost | Strengths |
|-------|--------|-----------|------|-----------|
| **Nomic Embed v2** | 137M | 8,192 | Free (local) | Best quality-to-size ratio, runs on CPU, open source |
| **Voyage 4 Large** | — | — | $$$ | +14% over OpenAI, MoE architecture, best for code/technical |
| **Cohere embed-v4** | — | — | $$ | 100+ languages, multimodal, enterprise SLAs |
| **OpenAI text-embedding-3-small** | — | 8,191 | $0.02/1M | Good default, wide adoption |
| **EmbeddingGemma** (Google) | — | — | Free (local) | Best for on-device, 2026 release |

**Recommendation**: Default to **Nomic Embed v2** for Level 1 (local, free, 137M params runs on CPU). Keep OpenAI as the cloud alternative. Add Voyage adapter for code-heavy use cases.

### 2.3 Hybrid Search Architecture

```
Query -> [Intent Analysis] -> parallel:
  ├── FTS5 BM25 search (always available)
  ├── sqlite-vec cosine similarity (if embeddings available)
  └── Association graph walk (1-hop from working memory primed topics)

Results -> Reciprocal Rank Fusion (RRF) -> Relevance scoring:
  score = rrf_score + priming_boost + recency_bonus + access_count_bonus
```

### 2.4 Edge Runtime Compatibility

| Runtime | SQLite | sqlite-vec | FTS5 | Status |
|---------|--------|-----------|------|--------|
| **Node.js** | better-sqlite3 | Yes (native addon) | Yes | Current target |
| **Bun** | bun:sqlite (built-in, 3-6x faster) | Needs testing | Yes | High priority |
| **Deno** | deno.land/x/sqlite | Possibly via FFI | Yes | Medium priority |
| **Cloudflare Workers** | D1 (managed) or Durable Objects | No (no native addons) | D1 has FTS5 | Low priority (BM25 only) |
| **WASM** | sql.js | sqlite-vec compiles to WASM | Yes | Experimental |

**Recommendation**: Target Bun as first-class runtime (3-6x faster SQLite), Node.js as stable default. Cloudflare D1 as serverless option (BM25 only, no vector search). Defer Deno and WASM.

---

## 3. Architecture Improvements

### 3.1 Hierarchical Digest DAG (Critical for Scale)

**Problem**: Flat digest layer saturates at ~10K conversations. LCM uses a multi-level DAG that scales logarithmically.

**Solution**: Add `digest_groups` table for hierarchical summarization.

```
Episodes (raw) -> Digests (daily) -> DigestGroups (weekly/100+) -> SuperGroups (monthly/1000+)
```

Each level reduces token count by ~5-10x. Three levels gives ~1000x compression, handling 1M+ token histories.

### 3.2 Three-Level Summarization Escalation

**Problem**: Single LLM summarization pass can fail to converge (LLM refuses to condense further).

**Solution**:
- Level 1: LLM detail-preserving summarization (current)
- Level 2: LLM aggressive bullet-point mode ("reduce to 5 key points")
- Level 3: Deterministic truncation (no LLM, just first N tokens + entity list)

Guarantees convergence regardless of LLM behavior.

### 3.3 Transactional Compaction

**Problem**: Fire-and-forget background storage with no rollback on failure.

**Solution**: Wrap all storage operations in SQLite transactions. On failure, roll back and retry. Use WAL mode for concurrent reads during writes.

### 3.4 ACT-R-Inspired Activation Function

**Current**: `relevance = similarity + (accessCount * 0.01)`

**Proposed** (based on ACT-R research): Replace with a psychologically grounded activation function:

```
activation(m) = ln(sum(t_i^(-d))) + S * similarity(q, m) + noise(sigma)

where:
  t_i = time since i-th access (captures both recency and frequency)
  d = decay parameter (0.5 default, calibrate per memory type)
  S = scaling factor for semantic similarity
  sigma = stochastic noise (simulates human variability)
```

This produces more natural memory dynamics: frequently and recently accessed memories surface naturally, old unused memories fade but never disappear, and noise prevents deterministic retrieval (enabling serendipitous associations).

### 3.5 Hebbian Association Strengthening

**Current design**: Association strength is set at creation and decays.

**Improvement** (based on Hebbian Memory-Augmented Networks paper):
- When two memories are co-recalled, strengthen edges between them: `strength += learning_rate * activation(A) * activation(B)`
- When one memory is recalled and the other isn't, weaken: `strength *= (1 - decay_rate)`
- This implements "neurons that fire together wire together" — associations that prove useful in practice get stronger

### 3.6 Dream Cycle Enhancement

**Current design**: Dream cycle detects cross-session patterns.

**Enhancement** (based on SleepGate and sleep consolidation research):
- **Replay**: Re-activate high-salience episodes from recent sessions, run association detection
- **Pruning**: Weaken associations that were never co-activated (synaptic homeostasis)
- **Novel linking**: During dream cycle, test low-strength associations by checking if their endpoints share latent similarity (embedding cosine > threshold). Promote surprising connections.
- **Interference resolution**: When contradictory semantic memories exist, dream cycle runs conflict resolution (newer memory supersedes unless older has significantly higher access count)

---

## 4. OpenClaw Plugin Strategy

### 4.1 Current Ecosystem State

- **ClawHub** is now the default plugin registry (as of v2026.3.22), replacing npm as primary distribution
- **13,000+ skills** available on ClawHub
- Context engine plugins were introduced in v2026.3.7 via `api.registerContextEngine()`
- Plugins run in-process (no sandbox) — same trust boundary as core
- **Lossless-claw** is the only major context engine plugin currently

### 4.2 Plugin Registration

```typescript
// @engram-mem/openclaw plugin-entry.ts
export function register(api) {
  api.registerContextEngine('engram', (config) => {
    return new EngramContextEngine(config)
  })
}
```

Config selection: `plugins.slots.contextEngine: engram`

### 4.3 Seven Context Engine Hooks

The ContextEngine interface provides hooks for the full conversation lifecycle:
1. **init** — Engine startup, load persistent state
2. **onSessionStart** — Initialize working memory for session
3. **beforeModelCall** — Given token budget, build context (this is the critical hook)
4. **afterModelCall** — Ingest response, update working memory
5. **onCompaction** — Triggered when context nears budget, consolidate
6. **onSessionEnd** — Persist working memory, flush write buffer
7. **dispose** — Clean shutdown

### 4.4 Distribution Strategy

1. **ClawHub**: Publish `@engram-mem/openclaw` as a context engine plugin on ClawHub (primary)
2. **npm**: Publish all packages (`@engram-mem/core`, `@engram-mem/sqlite`, etc.) on npm (for standalone usage)
3. **GitHub**: Source code + documentation
4. **Dual identity**: ClawHub for OpenClaw users, npm for standalone library users

---

## 5. Framework Adapters (Beyond OpenClaw)

### 5.1 Priority Adapters

| Framework | Package | Integration Pattern | Priority |
|-----------|---------|-------------------|----------|
| **OpenClaw** | `@engram-mem/openclaw` | Context engine plugin | Already planned |
| **Vercel AI SDK** | `@engram-mem/vercel-ai` | Memory provider (like Mem0's integration) | High |
| **LangChain/LangGraph** | `@engram-mem/langchain` | BaseMemory subclass + LangGraph store | High |
| **AutoGen** | `@engram-mem/autogen` | Memory plugin | Medium |
| **Mastra** | `@engram-mem/mastra` | Memory integration | Medium |
| **Plain TypeScript** | `@engram-mem/core` + `@engram-mem/sqlite` | Direct API | Already the default |

### 5.2 Vercel AI SDK Integration

Mem0 already has a Vercel AI SDK provider. Engram should follow the same pattern:

```typescript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { engramProvider } from '@engram-mem/vercel-ai'

const memory = createMemory({ storage: sqliteAdapter() })
const provider = engramProvider({ memory })

// Use with Vercel AI SDK
const result = await generateText({
  model: openai('gpt-4o'),
  messages,
  experimental_providerMetadata: { engram: { userId: 'user-123' } },
})
```

### 5.3 LangChain Integration

```typescript
import { EngramMemory } from '@engram-mem/langchain'

const memory = new EngramMemory({ path: './memory.db' })
const chain = new ConversationChain({ llm, memory })
```

---

## 6. Benchmarking Strategy

### 6.1 Standard Benchmarks

Run Engram against LoCoMo, MemBench, and OOLONG to establish a public baseline.

**LoCoMo** (primary): Tests long-term conversational memory across 300 turns, 35 sessions. QA, summarization, and dialogue generation. Target: **>70%** (beating Mem0's 67.1%, competitive with Letta's 74%).

**MemBench**: Tests information extraction, multi-hop reasoning, knowledge updating, preference following, temporal reasoning. Target: Top-3 on preference following and knowledge updating (our strength areas).

**OOLONG**: Tests long-context reasoning and aggregation. Even frontier models score <50%. Use as a stretch target and LCM comparison point.

### 6.2 Cognitive Memory Benchmark (Engram-Bench)

No existing benchmark tests cognitive memory behaviors. Create one:

1. **Association recall**: "We discussed X in relation to Y. What else was related to Y?" (tests association graph walking)
2. **Preference persistence**: "I said I prefer X three conversations ago. What's my preference?" (tests semantic memory + reconsolidation)
3. **Pattern learning**: "I always do X before Y across 5 sessions. What should I do before Y?" (tests procedural memory)
4. **Contradictionresolution**: "I said X is true, then later said X is false. What's current state?" (tests supersession)
5. **Decay dynamics**: "I mentioned Z once 100 conversations ago. How confident is the system?" (tests decay)
6. **Priming**: After discussing topic A, does retrieving topic B (related to A) improve? (tests working memory priming)

Publishing this benchmark establishes Engram as the authority on cognitive memory evaluation.

### 6.3 Benchmark Infrastructure

- Use Vitest bench mode for micro-benchmarks (ingestion throughput, recall latency)
- Create a `benchmarks/` directory with reproducible scripts
- Publish results in README and on a simple static site
- Run benchmarks in CI to track regressions

---

## 7. Competitive Edge Analysis

### 7.1 What Makes Engram Unique

| Feature | Engram | Mem0 | Zep | Letta | A-Mem |
|---------|--------|------|-----|-------|-------|
| 5 cognitive memory systems | Yes | No | No | No | No |
| Association graph with typed edges | Yes | Partial (graph) | Yes (temporal) | No | Yes (links) |
| Consolidation cycles (sleep analogy) | Yes | No | No | No | No |
| Reconsolidation on access | Yes | No | No | No | No |
| Procedural memory (habits/patterns) | Yes | No | No | No | No |
| Working memory with priming | Yes | No | No | Yes (blocks) | No |
| Confidence decay + strengthening | Yes | No | No | No | No |
| Zero-config local-first | Yes | No | No | Yes | Yes |
| No cloud required | Yes | No | No | Yes | Yes |

**The pitch**: "Mem0 remembers facts. Zep tracks changes. Letta manages state. Engram **learns** — it forms associations, strengthens useful memories, lets unused ones fade, and discovers patterns across sessions. It's the difference between a filing cabinet and a brain."

### 7.2 Market Positioning

The $6.27B agentic AI memory market (2025) growing to $28.45B by 2030 is dominated by cloud services. Engram's position:

1. **Local-first**: No cloud, no API keys, no data leaving the machine. Privacy-sensitive industries (healthcare, legal, finance) need this.
2. **Zero-config**: `npm install @engram-mem/core @engram-mem/sqlite` and it works. No Supabase, no Neo4j, no Redis.
3. **Cognitive, not just storage**: Brain-inspired architecture is a story that sells. Developers and product managers understand "your AI agent has a brain" better than "your AI agent has a vector database."
4. **Framework-agnostic**: Works with OpenClaw, Vercel AI SDK, LangChain, or standalone. Not locked to any ecosystem.

### 7.3 When to Choose Engram vs Others

| Need | Choose |
|------|--------|
| Managed cloud memory, enterprise SLAs | Mem0 or Zep |
| Temporal knowledge tracking, fact versioning | Zep |
| LangGraph-native memory | LangMem |
| Transparent, editable agent state | Letta |
| **Local-first cognitive memory that learns** | **Engram** |
| **Brain-inspired architecture for research** | **Engram** |
| **Zero-config, no API keys required** | **Engram** |
| **OpenClaw context engine plugin** | **Engram** |

---

## 8. Distribution and Adoption Strategy

### 8.1 Package Publishing

Use **Changesets** with Turborepo for monorepo versioning:

```
npm install -D @changesets/cli @changesets/changelog-github
npx changeset init
```

Publishing workflow:
1. PR includes a changeset file describing the change
2. CI runs `turbo run build lint test`
3. Merge to main triggers `changeset version` (bumps versions) + `changeset publish` (publishes to npm)
4. GitHub Action also publishes `@engram-mem/openclaw` to ClawHub

Start with **fixed versioning** (all packages share version). Move to independent versioning when packages stabilize.

### 8.2 README Strategy

Based on what makes successful AI libraries stand out:

1. **One-liner value prop**: "Brain-inspired cognitive memory for AI agents. Local-first. Zero-config."
2. **5-second quickstart**: `const memory = createMemory()` — works immediately
3. **Progressive disclosure**: Zero-config -> add embeddings -> add cloud -> full cognitive engine
4. **Benchmark badges**: LoCoMo score, latency, memory footprint
5. **Architecture diagram**: The 5 memory systems visual from the design doc
6. **Comparison table**: Engram vs Mem0 vs Zep vs Letta (be fair, highlight genuine strengths)
7. **Framework badges**: "Works with OpenClaw | Vercel AI SDK | LangChain | Standalone"

### 8.3 Traction Playbook

1. **Publish benchmark results** comparing against Mem0 and Letta on LoCoMo
2. **Write "Building a Brain for AI Agents"** blog post explaining the neuroscience behind each memory system
3. **Ship the OpenClaw plugin** on ClawHub — 13K+ skills means an active audience
4. **Create a Vercel AI SDK example** — Vercel's ecosystem has massive reach
5. **Submit to Hacker News** with the brain-inspired angle (neuroscience + AI is catnip for HN)
6. **Open an ICLR/NeurIPS workshop submission** — the MemAgents ICLR 2026 workshop is actively seeking contributions on memory for agentic systems
7. **Create interactive demo** — web page where you chat, and you can see memory formation, associations, consolidation in real time

---

## 9. Prioritized Roadmap

### v0.2 — Foundation (4-6 weeks)

**Goal**: Ship the core library with the designed architecture. Benchmarkable.

| # | Item | Impact | Effort | Details |
|---|------|--------|--------|---------|
| 1 | **Implement @engram-mem/core** | Critical | Large | createMemory() factory, 5 memory systems, intent analyzer, recall engine, consolidation scheduler |
| 2 | **Implement @engram-mem/sqlite with sqlite-vec** | Critical | Medium | SQLite adapter with FTS5 + sqlite-vec hybrid search, migration system |
| 3 | **Nomic Embed v2 local adapter** | High | Small | Local embedding without API keys, runs on CPU |
| 4 | **Hierarchical digest DAG** | High | Medium | digest_groups table, auto-grouping at 100 digests |
| 5 | **Three-level summarization escalation** | High | Small | LLM -> bullets -> truncation fallback |
| 6 | **Transactional storage** | High | Small | WAL mode, BEGIN/COMMIT wrappers |
| 7 | **LoCoMo benchmark runner** | High | Medium | Automated benchmark against LoCoMo dataset |
| 8 | **Changesets + Turborepo publish** | Medium | Small | Monorepo versioning and npm publishing pipeline |

### v0.5 — Competitive (2-3 months after v0.2)

**Goal**: Beat Mem0 on LoCoMo. Ship OpenClaw plugin. Framework adapters.

| # | Item | Impact | Effort | Details |
|---|------|--------|--------|---------|
| 9 | **@engram-mem/openclaw plugin** | Critical | Medium | Register as context engine, implement 7 lifecycle hooks, publish to ClawHub |
| 10 | **ACT-R activation function** | High | Medium | Replace linear scoring with psychologically-grounded activation (recency, frequency, decay, noise) |
| 11 | **Hebbian association strengthening** | High | Medium | Co-recall strengthens edges, non-activation weakens them |
| 12 | **Enhanced dream cycle** | Medium | Medium | Replay, pruning, novel linking, interference resolution |
| 13 | **@engram-mem/vercel-ai adapter** | High | Small | Memory provider for Vercel AI SDK |
| 14 | **@engram-mem/langchain adapter** | High | Small | BaseMemory subclass for LangChain/LangGraph |
| 15 | **Large file handling** | Medium | Medium | MIME-aware summarization for files >25K tokens |
| 16 | **Engram-Bench** | High | Medium | Custom cognitive memory benchmark (associations, priming, decay, patterns) |
| 17 | **Bun runtime support** | Medium | Small | Test and optimize for bun:sqlite (3-6x faster) |

### v1.0 — Production-Grade (4-6 months after v0.2)

**Goal**: Production-ready for enterprises. Comprehensive docs. Community.

| # | Item | Impact | Effort | Details |
|---|------|--------|--------|---------|
| 18 | **Memory inspector UI** | High | Large | Web-based visualization of memory systems, associations, consolidation history |
| 19 | **Multi-agent shared memory** | High | Large | Multiple agents sharing a memory store with conflict resolution |
| 20 | **Cloudflare D1 adapter** | Medium | Medium | Serverless SQLite storage (BM25 only, no vector) |
| 21 | **MCP server** | High | Medium | Expose Engram as an MCP resource/tool for any LLM client |
| 22 | **Spaced repetition scheduling** | Medium | Medium | Optimize consolidation timing based on memory access patterns |
| 23 | **Privacy controls** | High | Medium | Selective forgetting, PII detection, GDPR compliance tooling |
| 24 | **Streaming/incremental embeddings** | Medium | Medium | Embed in background as messages arrive, not in batch |
| 25 | **Operator-level recursion** | Low | Large | Parallel sub-agent spawning for massive dataset processing |
| 26 | **Academic paper** | High | Large | Submit to MemAgents workshop or NeurIPS on brain-inspired agent memory |

---

## 10. Key Decisions Needed

### 10.1 sqlite-vec vs pure FTS5

**Recommendation**: Ship v0.2 with FTS5-only as Level 0, add sqlite-vec as Level 1. sqlite-vec requires native addon compilation which complicates distribution. FTS5 is built into SQLite and works everywhere.

**Tradeoff**: FTS5 BM25 is keyword-only. Semantic search requires embeddings + sqlite-vec. For the OpenClaw plugin, BM25 may be sufficient since the LLM can reformulate queries.

### 10.2 Default embedding model

**Recommendation**: Nomic Embed v2 (local, free, 137M params, CPU-runnable) as the "Level 1" default. OpenAI text-embedding-3-small as the cloud alternative.

**Tradeoff**: Nomic requires downloading a ~500MB model. First-run experience is slower. Could offer a "download embeddings" CLI command.

### 10.3 ClawHub vs npm for primary distribution

**Recommendation**: Both. ClawHub is primary for OpenClaw users, npm for standalone library users. Automate both in CI.

### 10.4 Whether to implement the association graph in SQLite or in-memory

**Recommendation**: SQLite. The association graph needs to persist across sessions. Store edges in an `associations` table with indexes on (source_id, edge_type) and (target_id, edge_type). Graph walks are just JOINs — SQLite handles this fine for the scale we're targeting (<1M edges).

### 10.5 Consolidation: timer-based vs turn-based

**Recommendation**: Turn-based for light sleep (every N turns), timer-based for deep sleep and dream cycles (cron-like scheduling). This matches the neuroscience: short-term consolidation happens during brief pauses (between turns), long-term consolidation happens during extended rest (between sessions).

---

## 11. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LoCoMo score below 60% | Medium | High | Letta's filesystem baseline shows retrieval is solvable; focus on hybrid search quality |
| sqlite-vec compilation issues on some platforms | Medium | Medium | FTS5 as zero-config fallback; sqlite-vec as opt-in upgrade |
| OpenClaw context engine API changes | Low | High | Pin to v2026.3.7+ API; maintain adapter layer |
| Mem0/Zep add cognitive features | Medium | Medium | Ship fast; establish "cognitive memory" category ownership |
| LLM summarization costs too high | Low | Medium | Three-level escalation with deterministic fallback; local summarization via small models |
| ClawHub security concerns | Medium | Low | Follow emerging security best practices; signed packages |

---

## 12. Success Metrics

### v0.2
- [ ] `createMemory()` works zero-config with SQLite + BM25
- [ ] All 5 memory systems implemented with tests
- [ ] LoCoMo score measured and published
- [ ] Published to npm as `@engram-mem/core` and `@engram-mem/sqlite`

### v0.5
- [ ] LoCoMo score >70%
- [ ] OpenClaw plugin live on ClawHub
- [ ] Vercel AI SDK and LangChain adapters shipped
- [ ] Engram-Bench published
- [ ] 100+ GitHub stars

### v1.0
- [ ] Production deployments (at least 3 known users)
- [ ] Memory inspector UI
- [ ] MCP server
- [ ] Academic paper submitted
- [ ] 1000+ GitHub stars
- [ ] 500+ weekly npm downloads

---

## Sources

### Agent Memory Systems
- [Letta vs Mem0 vs Zep comparison](https://medium.com/asymptotic-spaghetti-integration/from-beta-to-battle-tested-picking-between-letta-mem0-zep-for-ai-memory-6850ca8703d1)
- [Mem0 benchmark: OpenAI vs LangMem vs MemGPT vs Mem0](https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up)
- [Survey of AI Agent Memory Frameworks](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [Mem0 Graph Memory for AI Agents](https://mem0.ai/blog/graph-memory-solutions-ai-agents)
- [5 AI Agent Memory Systems Compared (2026)](https://dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared-mem0-zep-letta-supermemory-superlocalmemory-2026-benchmark-59p3)
- [Letta: Benchmarking AI Agent Memory](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- [SuperLocalMemory](https://github.com/qualixar/superlocalmemory)

### Benchmarks
- [LoCoMo: Evaluating Very Long-Term Conversational Memory](https://snap-research.github.io/locomo/)
- [OOLONG: Evaluating Long Context Reasoning](https://arxiv.org/abs/2511.02817)
- [MemBench: Benchmarking Long-Term Memory in LLMs](https://arxiv.org/pdf/2510.27246)
- [LifeBench: Long-Horizon Multi-Source Memory](https://arxiv.org/html/2603.03781)
- [MEMTRACK: Evaluating Long-Term Memory](https://arxiv.org/pdf/2510.01353)

### Research Papers
- [A-Mem: Agentic Memory for LLM Agents (NeurIPS 2025)](https://arxiv.org/abs/2502.12110)
- [Hebbian Memory-Augmented Recurrent Networks](https://arxiv.org/abs/2507.21474)
- [ACT-R-Inspired Memory for LLM Agents](https://dl.acm.org/doi/10.1145/3765766.3765803)
- [MAGMA: Multi-Graph Agentic Memory](https://arxiv.org/html/2601.03236v1)
- [SleepGate / Learning to Forget](https://arxiv.org/html/2603.14517)
- [Memory in the Age of AI Agents: A Survey](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- [ICLR 2026 MemAgents Workshop Proposal](https://openreview.net/pdf?id=U51WxL382H)
- [Agentic Memory: Unified Long-Term and Short-Term](https://arxiv.org/html/2601.01885v1)
- [Zep: Temporal Knowledge Graph Architecture](https://arxiv.org/abs/2501.13956)
- [MemOS: Memory OS for AI Systems](https://statics.memtensor.com.cn/files/MemOS_0707.pdf)

### Brain-Inspired Computing
- [Dragon Hatchling: Linking Transformers & Brain Models](https://www.emergentmind.com/papers/2509.26507)
- [Memory Networks: Towards Fully Biologically Plausible Learning](https://arxiv.org/pdf/2409.17282)
- [Sleep Consolidation Mechanisms (Nature Neuroscience)](https://www.nature.com/articles/s41593-019-0467-3)
- [Machine Memory Intelligence (M2I)](https://www.engineering.org.cn/engi/EN/10.1016/j.eng.2025.01.012)
- [Claude Code AutoDream and Sleep Consolidation](https://www.mindstudio.ai/blog/what-is-claude-code-autodream-memory-consolidation-2)

### Technical
- [sqlite-vec: Vector Search for SQLite](https://github.com/asg017/sqlite-vec)
- [Hybrid FTS + Vector Search in SQLite](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)
- [State of Vector Search in SQLite](https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite)
- [Bun SQLite (3-6x faster)](https://bun.com/docs/runtime/sqlite)
- [Cloudflare D1 SQLite](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [SQLite on the Edge: Production Ready?](https://www.sitepoint.com/sqlite-edge-production-readiness-2026/)
- [Best Embedding Models 2026](https://elephas.app/blog/best-embedding-models)
- [Voyage 4 vs OpenAI vs Cohere 2026](https://www.buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026)

### OpenClaw Ecosystem
- [OpenClaw Plugins Documentation](https://docs.openclaw.ai/tools/plugin)
- [OpenClaw ContextEngine Deep Dive](https://openclaws.io/blog/openclaw-contextengine-deep-dive)
- [ClawHub Plugin Registry](https://docs.openclaw.ai/tools/clawhub)
- [OpenClaw v2026.3.22: ClawHub Registry Guide](https://www.elegantsoftwaresolutions.com/blog/openclaw-v2026-3-22-clawhub-plugin-registry-guide)
- [lossless-claw (LCM)](https://github.com/Martian-Engineering/lossless-claw)
- [MemOS Cloud OpenClaw Plugin](https://github.com/MemTensor/MemOS-Cloud-OpenClaw-Plugin)

### Distribution & Adoption
- [Turborepo Publishing Guide](https://turborepo.dev/docs/guides/publishing-libraries)
- [npm Monorepo Publishing with Changesets](https://npmdigest.com/guides/monorepo-publishing)
- [Agentic AI Memory Market ($6.27B -> $28.45B)](https://www.mordorintelligence.com/industry-reports/agentic-artificial-intelligence-orchestration-and-memory-systems-market)
- [Agent Memory Failure Modes](https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/)
- [Context Drift: 65% of Enterprise AI Failures](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies)
- [Mem0 Vercel AI SDK Integration](https://docs.mem0.ai/integrations/vercel-ai-sdk)
