# The Pollution Problem in Agent Memory: Research Report

**Date**: 2026-03-29
**Scope**: How production retrieval systems handle noisy, irrelevant content polluting search indexes

---

## 1. The Pollution Problem: Definition and Landscape

### What Is Memory Pollution?

Memory pollution occurs when an agent's memory index accumulates low-signal, irrelevant content that outranks genuinely useful information during retrieval. In a typical AI conversation, the majority of messages have *zero future recall value*:

- **Tool invocations**: `memory_search("project deadlines")` -- the *search command itself* gets stored and later retrieved when someone asks about deadlines
- **Acknowledgments**: "ok thanks", "got it", "let me think about that"
- **System metadata**: session headers, model configuration, rate limit warnings
- **Agent internal monologue**: chain-of-thought reasoning, error recovery attempts
- **Stale tool outputs**: File reads, web search results (4,000-8,000 chars each) that served their purpose and now pollute context

CAMEL-AI measured the concrete impact: after multiple tool calls, agents accumulate 60,000+ tokens of stale tool output, causing *measurable degradation in model reasoning quality*. They call this "context rot" -- simply having more context makes the model dumber, because it must attend to irrelevant information.

### Why It Matters for RAG-Based Memory

The pollution problem is *fundamentally worse* for RAG systems than for in-context systems:

- **In-context** (LCM/Lossless Claw): The model reads everything and uses its own attention to decide relevance. Noise wastes tokens but doesn't break ranking.
- **RAG** (Engram, Mem0, etc.): The *retrieval system* must rank content before the model sees it. If noisy content has high vector similarity to a query, it displaces genuinely relevant content. The model never gets a chance to judge.

This is the core asymmetry: RAG delegates relevance judgment to an embedding model that has no understanding of *why* a message exists in the conversation.

### How Current Systems Handle It

| System | Approach | Pollution Handling |
|--------|----------|--------------------|
| **Mem0** | LLM-based extraction -> ADD/UPDATE/DELETE/NOOP | Implicit: relies on LLM judgment to extract only salient facts |
| **Zep/Graphiti** | Temporal knowledge graph extraction | Structural: only entities with explicit relationships survive extraction |
| **Hindsight** | Four-network epistemic memory (World/Experience/Opinion/Observation) | Narrative extraction: 2-5 facts per conversation, naturally excludes noise |
| **Letta/MemGPT** | Agent self-editing memory with tool calls | Delegated: the agent itself decides what to store via tool functions |
| **ChatGPT Memory** | Automated profiling + saved memories | Selective: stores only user messages in recent history; LLM extracts preference-level facts |
| **CAMEL-AI** | Context summarization + workflow memory + tool caching | Active: monitors token usage, triggers summarization at 80% capacity |
| **AWS AgentCore** | LLM extraction + consolidation pipeline | Pipelined: async extraction identifies meaningful content, consolidation deduplicates |
| **SmartSearch** | Raw storage + deterministic ranking | Deferred: stores everything raw, relies on NER-weighted ranking to surface quality |
| **LCM/Lossless Claw** | DAG-based hierarchical summarization | Compressed: summarization naturally excludes noise; session patterns filter at ingestion |

---

## 2. Intent-Aware Retrieval for Conversational Memory

### The Problem of Undifferentiated Queries

Not all recall queries are the same. The research identifies at least five distinct intent types, each requiring different retrieval strategies:

| Intent Type | Example | Best Source | Strategy |
|------------|---------|-------------|----------|
| **Factual lookup** | "What is X's email?" | Semantic/Knowledge facts | High-precision entity match |
| **Topic recall** | "What did we discuss about auth?" | Episodic + Digests | Broad topical similarity |
| **Temporal recall** | "When did we decide to use Postgres?" | Temporal-indexed events | Time-range filtering + event search |
| **Preference recall** | "What are my coding style preferences?" | Opinion/Preference store | Category filter + preference aggregation |
| **Procedural recall** | "How did we deploy last time?" | Procedural memory / step sequences | Action-oriented retrieval |
| **Multi-hop reasoning** | "Which team members attended both the Q1 and Q2 reviews?" | Cross-entity graph walk | Entity linking + temporal join |

### How Production Systems Handle Intent

**Chronos** (March 2026, SOTA on LongMemEval at 95.6%) decomposes queries into subject-verb-object event tuples with resolved datetime ranges. At query time, it generates *dynamic prompts* tailored to each question type -- directing the retrieval system on what to retrieve, how to filter across time ranges, and how to approach multi-hop reasoning. This intent-adaptive approach yields a 7.67% improvement over the previous SOTA.

**Hindsight** classifies extracted information into four epistemic networks (World, Experience, Opinion, Observation), enabling the retrieval system to search the right network based on query type. Facts, observations, and opinions are kept structurally distinct, so a preference query searches the Opinion network, not the raw episodic log.

**ChatGPT** differentiates via structured system prompt sections: Saved Memories (explicit facts), Assistant Response Preferences (with confidence tags), Notable Past Conversation Topics, Helpful User Insights, and Recent Conversation Content. Each section is injected differently, with preferences always present and recent content limited to ~40 chats.

**SmartSearch** (March 2026) uses NER/POS-weighted term extraction: proper nouns weighted 3.0, regular nouns 2.0, verbs 1.0, with +1.0 bonus for named entities. This linguistic approach means queries about people/places naturally match differently than queries about actions/concepts.

### Key Insight for Engram

The Engram design already has an intent analyzer (`intent/analyzer.ts`, `intent/salience.ts`). The research confirms this is the right direction. The critical addition would be **query-type-specific retrieval routing** -- not just routing to tiers, but adapting the retrieval strategy (similarity threshold, time filtering, entity matching) based on classified intent.

---

## 3. Content Classification at Ingestion Time

### The Spectrum of Approaches

Systems fall on a spectrum from "store everything, filter at retrieval" to "extract only high-value content at ingestion":

```
Store Everything                                     Extract Only Facts
     |                                                       |
  SmartSearch    LCM    ChatGPT    AgentCore    Mem0    Zep/Graphiti    Hindsight
     |           |        |          |           |          |              |
  Raw storage  Summarize  Profile   Pipeline   LLM-judge  KG extraction  Narrative
  + ranking    into DAG   extract   extract    ADD/NOOP   Entity+Rel     2-5 facts
```

### Signals That Indicate High Recall Value

From the research, these signals reliably predict future recall value:

**High-value signals:**
- Contains named entities (people, organizations, projects, dates)
- Contains a decision or preference ("we decided to...", "I prefer...")
- Contains factual claims with specific details (numbers, URLs, configurations)
- Contains action items or commitments ("let's do X by Friday")
- Is the assistant's synthesized answer (vs. the user's question)
- Has been referenced by later messages (backward links)

**Low-value signals:**
- Pure acknowledgment ("ok", "thanks", "got it", "sure")
- System prompts and tool invocations
- Error messages and retries
- Repetitive/redundant content (says the same thing as another message)
- Hedging and filler ("hmm", "let me think", "interesting")
- Tool outputs that have been summarized elsewhere

**Medium-value (context-dependent):**
- User questions (valuable for understanding *what* was asked, but the answer is more valuable)
- Partial/incomplete responses
- Debugging discussions (valuable if the fix is novel, noise if routine)

### Information Density Scoring

Academic research on information density finds that **lexical density** (ratio of content words -- nouns, verbs, adjectives, adverbs -- to total words) is the most reliable automated proxy. However, there is no unified methodology for measuring information density in natural language.

For practical purposes, a simpler heuristic works well: messages containing named entities, specific quantities, or declarative statements about facts/preferences score higher than messages dominated by discourse markers, acknowledgments, or meta-commentary.

### How Mem0 Does It

Mem0's pipeline is instructive:
1. Process message pair (previous + current) plus last 10 messages for context
2. LLM extracts candidate facts
3. For each fact, retrieve top-10 semantically similar existing memories
4. LLM decides: ADD (new), UPDATE (augment existing), DELETE (contradicts), NOOP (redundant)
5. Graph variant also extracts entity-relationship triples

The key insight: Mem0 does **not** have explicit noise filters. It relies entirely on the LLM's judgment during extraction. If the LLM doesn't extract "ok thanks" as a fact, it never enters memory. This works surprisingly well -- Mem0 achieves 26% higher accuracy than OpenAI's memory with 91% lower latency.

### How Zep/Graphiti Does It

Zep's approach is structurally rigorous:
1. Process current message + last n=4 messages for context
2. Entity extraction with reflection (re-check for hallucinations)
3. Facts require **explicit relationships between distinct entities** -- "a clear relationship between two DISTINCT nodes"
4. Deduplication via hybrid search (cosine + BM25) against existing graph
5. Temporal invalidation for contradicted facts (set `t_invalid`, never delete)

The structural requirement that facts must connect distinct entities is a powerful implicit noise filter. "Ok thanks" cannot form a valid entity-relationship triple, so it never enters the knowledge graph.

---

## 4. The Summarization Solution

### Summarization as De-Pollution

Summarization naturally filters noise because:
- An LLM writing a summary will not include "ok thanks" or tool invocations
- It consolidates redundant information
- It preserves the information hierarchy (decisions > context > acknowledgments)
- It adds structure (topic grouping, temporal ordering)

### Three Approaches Compared

**1. Summarize-at-ingestion (Mem0, Hindsight, Zep)**
- Extract structured facts/entities during message processing
- Pros: Index stays clean; retrieval is fast and precise
- Cons: Lossy -- details the extractor didn't consider important are lost forever
- Risk: The LLM may miss something that matters later

**2. Summarize-at-compaction (LCM/Lossless Claw)**
- Store everything raw; summarize into DAG when context window fills
- Pros: Nothing lost -- originals preserved in database, summaries provide efficient access
- Cons: More storage; retrieval must navigate summary hierarchy
- LCM specifics: `contextThreshold=0.75` triggers compaction; `freshTailCount=32` protects recent messages

**3. Filter-at-retrieval (SmartSearch)**
- Store everything raw; use intelligent ranking to surface quality at query time
- Pros: Truly lossless; no ingestion overhead
- Cons: Retrieval must be very good; larger indexes to search
- SmartSearch achieves 93.5% on LoCoMo with *no LLM in the retrieval loop*

### The Fundamental Tradeoff

```
                    Lossy but Clean              Lossless but Noisy
                    (Extract at ingest)          (Store everything)
                          |                              |
Retrieval complexity:    LOW                           HIGH
Storage cost:            LOW                           HIGH
Risk of missing info:    HIGH                          LOW
Index pollution:         LOW                           HIGH
Ingestion latency:       HIGH (LLM calls)              LOW
```

### The Hybrid Solution (Recommended for Engram)

The research strongly suggests a **dual-track architecture**:

1. **Primary index**: Extracted/summarized high-quality content (facts, entities, decisions, preferences). This is what retrieval searches first.
2. **Secondary store**: Raw conversation history, searchable but not the default retrieval target. Accessible via `memory_expand` for drill-down.

This is essentially what LCM already does with its DAG + raw message store, and what Zep does with its knowledge graph + episode subgraph. The episode/raw layer preserves everything; the semantic/structured layer provides efficient retrieval.

---

## 5. Multi-Index Architecture

### The Pattern

Multiple production systems use architecturally distinct indexes for different content types:

**Zep/Graphiti** maintains three subgraphs:
- Episode Subgraph: raw events and messages (ground truth)
- Entity Subgraph: extracted entities with temporal versioning
- Relationship Subgraph: facts connecting entities

**Hindsight** uses four logical networks:
- World Network: objective external facts
- Experience Network: agent's biographical actions
- Opinion Network: subjective judgments with confidence scores
- Observation Network: preference-neutral entity summaries

**Elasticsearch** supports multi-index search with `indices_boost`:
```json
{
  "indices_boost": [
    { "high_quality_facts": 1.5 },
    { "conversation_summaries": 1.2 },
    { "raw_episodes": 1.0 }
  ]
}
```

### Elasticsearch Field-Level Boosting

For within-index relevance tuning, Elasticsearch supports field-level boosting:
- `title^3, content^1` -- title matches weighted 3x over body
- Sensible boost values: 1-15 range (higher values have diminishing returns)
- Query-time boosting preferred over index-time (avoids reindexing)
- Boost optimization reduces to a regression problem: `score = field1_boost * field1_bm25 + field2_boost * field2_bm25`

### Applying Multi-Index to Agent Memory

For Engram, the recommended architecture maps to:

| Index | Content | Boost | Search Priority |
|-------|---------|-------|-----------------|
| **Semantic facts** | Extracted entities, decisions, preferences | 2.0 | Primary |
| **Digests** | Conversation summaries with key topics | 1.5 | Primary |
| **Procedural** | How-to sequences, workflows | 1.5 | Intent-conditional |
| **Episodic** | Raw conversation messages | 1.0 | Secondary / drill-down |

This is already reflected in Engram's tier architecture. The key addition would be **explicit boost weights when combining results across tiers**, rather than treating all tiers equally.

---

## 6. Relevance Feedback and Boosting

### Field-Level Boosting for Agent Memory

The enterprise search pattern of boosting title over body translates directly to agent memory:

| Content Attribute | Suggested Boost | Rationale |
|-------------------|-----------------|-----------|
| **Assistant's synthesized answer** | 2.0 | Contains the actual knowledge/decision |
| **User's question** | 1.0 | Provides query context but answer is more valuable |
| **Decision/preference statement** | 2.5 | Highest future recall value |
| **Entity mentions** | 1.5 | Anchor points for association graph |
| **Tool output** | 0.5 | Usually superseded by the answer that uses it |
| **System message** | 0.0 | Never retrieve |
| **Acknowledgment** | 0.0 | Never retrieve |

### Learning to Rank for RAG

The state of the art has evolved significantly:

**MAIN-RAG** (ACL 2025) uses three LLM agents collaboratively: Agent-1 "Predictor" infers expected answers, Agent-2 "Judge" scores document-query-answer triplets, Agent-3 "Final-Predictor" generates from filtered results. This achieves 2-11% improvement in answer accuracy while reducing irrelevant documents.

**SmartSearch** demonstrates that a fully deterministic pipeline (NER-weighted substring matching + CrossEncoder+ColBERT rank fusion) achieves 93.5% on LoCoMo -- matching or exceeding LLM-based structuring approaches. Key insight: retrieval recall is already 98.6%, but without intelligent ranking only 22.5% of gold evidence survives truncation. **The bottleneck is ranking, not retrieval.**

**Algolia** retrains Dynamic Re-Ranking daily using click/conversion signals with 30-day time decay. Each record gets an "attractiveness score" per query.

### Practical Application for Engram

The SmartSearch finding is particularly relevant: if Engram achieves high recall (which vector + keyword hybrid search should provide), the critical investment is in **re-ranking**, not in more sophisticated retrieval. A CrossEncoder re-ranker running on the top-K results would likely yield larger gains than any improvement to the embedding model.

---

## 7. LCM Approach vs. RAG Approach

### Architecture Comparison

| Dimension | LCM (Lossless Claw) | RAG (Engram) |
|-----------|---------------------|--------------|
| **Primary retrieval** | Model reads DAG summaries in context window | Vector + keyword search finds relevant content |
| **Who judges relevance** | The LLM (via attention mechanism) | The retrieval system (embeddings + ranking) |
| **Pollution handling** | Summarization naturally excludes noise; session patterns filter at ingestion | Must explicitly filter or the index gets polluted |
| **Precision on specific facts** | Requires `lcm_expand_query` delegation (~120s) | Direct vector match (fast) |
| **Temporal reasoning** | DAG preserves chronological structure | Requires explicit temporal metadata + filtering |
| **Cross-session recall** | Each session has its own DAG; cross-session via separate Continuity plugin | Single index spans all sessions |
| **Token cost** | High: summaries always in context (~75% of window) | Low: only relevant memories injected |
| **Latency** | Low for summaries; high for expansion | Moderate for search; low for injection |
| **Failure mode** | Model may overlook relevant summary node | Search may miss relevant content entirely |

### Which Handles Pollution Better?

**LCM wins** on pollution resistance because:
1. Summarization naturally strips noise -- an LLM summarizing a conversation will not include "ok thanks" or tool invocations
2. The model itself decides relevance, not a retrieval system
3. Session patterns (`ignoreSessionPatterns`, `statelessSessionPatterns`) filter entire sessions at ingestion
4. Even if noise enters the DAG, the model can recognize and ignore it during reading

**RAG wins** on precision and efficiency because:
1. Only relevant memories use context tokens (vs. LCM using ~75% of window for summaries)
2. Can retrieve across all sessions without expansion
3. Faster for specific factual lookups
4. Scales better with conversation volume

### Can They Be Combined?

Yes, and this is the recommended approach. The pattern:

1. **LCM-style summarization** at ingestion: Extract high-quality summaries and structured facts from raw conversations. These become the primary search index.
2. **RAG-style retrieval** at query time: Vector + keyword search over the summarized/structured index.
3. **LCM-style expansion** for drill-down: When a summary match needs more detail, expand into the raw episode store.

This is effectively what Engram's tier architecture already enables: Semantic tier (extracted facts) and Digest tier (summaries) serve as the "clean" retrieval targets, while the Episodic tier preserves raw content for expansion.

The critical missing piece: **ingestion-time extraction/filtering** to prevent noise from entering the Episodic tier's search index (or at minimum, to tag episodes with quality scores so retrieval can deprioritize them).

---

## 8. Practical Anti-Pollution Patterns (Ranked by Impact)

### Tier 1: High Impact, Moderate Complexity

#### 1. LLM-Based Fact Extraction at Ingestion
**How it works**: Before storing a message, an LLM extracts structured facts, entities, and decisions. Only extracted artifacts enter the primary search index. Raw messages go to a secondary store.
**Implementation complexity**: Medium (requires LLM calls at ingestion time; 20-40 seconds per extraction per AgentCore benchmarks)
**Expected impact**: HIGH -- eliminates 80-90% of noise from the search index. Mem0 achieves 26% accuracy improvement and 90% token reduction.
**Downsides**: Lossy extraction risk; ingestion latency; LLM cost per message
**Who uses it**: Mem0, Zep/Graphiti, Hindsight, AWS AgentCore

#### 2. Role-Based Filtering at Ingestion
**How it works**: Simple rule: skip indexing for system messages, tool invocations, and messages matching noise patterns (regex for acknowledgments, empty content, tool call syntax).
**Implementation complexity**: LOW (regex matching, no LLM needed)
**Expected impact**: HIGH -- eliminates 30-50% of index volume with zero false positives
**Downsides**: Cannot catch subtle noise; only handles obvious cases
**Who uses it**: ChatGPT (only stores user messages in recent history), LCM (ignoreSessionPatterns)

#### 3. Narrative-Level Extraction (Not Sentence-Level)
**How it works**: Instead of extracting facts per-message, process conversation *chunks* (5-10 turns) and extract 2-5 comprehensive facts per chunk. Preserves cross-turn context.
**Implementation complexity**: Medium (requires chunking strategy + LLM extraction)
**Expected impact**: HIGH -- Hindsight's TEMPR system achieves 91.4% on LongMemEval with this approach, reducing sensitivity to per-message noise
**Downsides**: Higher latency per extraction; requires batching
**Who uses it**: Hindsight (TEMPR), Memori (Advanced Augmentation pipeline)

### Tier 2: High Impact, Higher Complexity

#### 4. Temporal Knowledge Graph
**How it works**: Extract entities and relationships into a temporal graph. Facts have validity windows. Contradictions invalidate old edges (not delete). Search uses semantic + BM25 + breadth-first graph traversal.
**Implementation complexity**: HIGH (requires graph database, entity resolution, temporal reasoning)
**Expected impact**: HIGH -- Zep achieves 94.8% on DMR benchmark. Structural requirement that facts connect distinct entities is a powerful noise filter.
**Downsides**: Infrastructure complexity; entity resolution is hard; ingestion cost
**Who uses it**: Zep/Graphiti (Graphiti is open source)

#### 5. Score-Adaptive Retrieval Truncation
**How it works**: Instead of returning top-K results, set a dynamic threshold: tau = alpha * max(reranker_scores). Easy queries with steep score drop-offs get compact context; hard queries with flat curves retain more results.
**Implementation complexity**: Low-Medium (requires a reranker, but the truncation logic is simple)
**Expected impact**: HIGH -- SmartSearch achieves worst-case recall of 0.945 with this approach at alpha=0.03
**Downsides**: Requires calibrated reranker scores
**Who uses it**: SmartSearch

#### 6. CrossEncoder Re-Ranking
**How it works**: After initial retrieval (vector + keyword), run a CrossEncoder model over top-K candidates to produce refined relevance scores. Optionally fuse with ColBERT late-interaction scores via Reciprocal Rank Fusion.
**Implementation complexity**: Medium (add a reranker model to the pipeline; ~650ms on CPU per SmartSearch benchmarks)
**Expected impact**: HIGH -- SmartSearch shows reranker quality yields +6.0pp improvement, more than any other component. The bottleneck in retrieval is ranking, not recall.
**Downsides**: Additional latency; model selection matters
**Who uses it**: SmartSearch, MAIN-RAG, most production RAG systems

### Tier 3: Medium Impact, Low Complexity

#### 7. Salience Scoring at Ingestion
**How it works**: Assign each message a salience score (0-1) based on heuristics: contains named entities? contains decision language? is an assistant answer? is a tool output? Use score as a retrieval boost factor.
**Implementation complexity**: LOW (heuristic rules, no LLM needed)
**Expected impact**: MEDIUM -- does not remove noise but deprioritizes it in retrieval
**Downsides**: Heuristics may misjudge edge cases
**Who uses it**: Engram (designed but not yet implemented in `intent/salience.ts`); Slack (message metadata signals)

#### 8. Category-Tagged Storage
**How it works**: Tag each memory with a category (fact, decision, preference, tool-output, acknowledgment, meta) at ingestion time. Allow retrieval queries to filter by category.
**Implementation complexity**: LOW (classification can be rule-based or LLM-based)
**Expected impact**: MEDIUM -- enables intent-aware retrieval to search the right subset
**Downsides**: Classification accuracy; requires query-time category inference
**Who uses it**: Hindsight (four networks), Engram WorkingMemoryItem (has `category` field)

#### 9. Write-Time Field Filters
**How it works**: Configure which content types should not persist: temporary instructions, test data, system prompts, tool debugging output. Rule-based exclusion at the write layer.
**Implementation complexity**: LOW (configuration + regex)
**Expected impact**: MEDIUM -- prevents the most obvious pollution sources
**Downsides**: Requires maintenance as new noise patterns emerge
**Who uses it**: Mem0 (field-level filters at write time), LCM (ignoreSessionPatterns)

### Tier 4: Medium Impact, Medium Complexity

#### 10. Hierarchical Summarization (DAG Compaction)
**How it works**: Periodically summarize older messages into progressively higher-level summaries. Original messages preserved but not in primary search path. Summaries form a DAG enabling multi-level drill-down.
**Implementation complexity**: Medium (requires summarization pipeline + DAG management)
**Expected impact**: MEDIUM -- reduces index noise over time; provides clean retrieval targets
**Downsides**: Lossy unless originals preserved; latency for compaction
**Who uses it**: LCM (core architecture), CAMEL-AI (automatic token-based summarization)

#### 11. Semantic Deduplication
**How it works**: Before storing, check if a semantically similar memory already exists (cosine similarity > threshold). If so, merge/update rather than add a duplicate.
**Implementation complexity**: Medium (requires embedding comparison at write time)
**Expected impact**: MEDIUM -- prevents redundant content from diluting search results
**Downsides**: Aggressive deduplication may lose nuance; embedding cost
**Who uses it**: Mem0 (UPDATE operation), Zep/Graphiti (entity/edge deduplication)

#### 12. Tiered Boost Weights
**How it works**: When combining search results across multiple indexes/tiers, apply different boost weights. Facts/decisions boosted higher than raw episodes.
**Implementation complexity**: LOW (configuration at retrieval time)
**Expected impact**: MEDIUM -- ensures high-quality content outranks raw noise in combined results
**Downsides**: Requires tuning; static boosts may not fit all query types
**Who uses it**: Elasticsearch (indices_boost), Algolia (Dynamic Re-Ranking)

---

## 9. Key Papers and Systems Referenced

### Papers
- **Mem0**: "Building Production-Ready AI Agents with Scalable Long-Term Memory" (arXiv 2504.19413, April 2025)
- **Zep**: "A Temporal Knowledge Graph Architecture for Agent Memory" (arXiv 2501.13956, January 2025)
- **Hindsight**: "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects" (arXiv 2512.12818, December 2025)
- **SmartSearch**: "How Ranking Beats Structure for Conversational Memory Retrieval" (arXiv 2603.15599, March 2026)
- **Chronos**: "Temporal-Aware Conversational Agents with Structured Event Retrieval" (arXiv 2603.16862, March 2026)
- **Memori**: "A Persistent Memory Layer for Efficient, Context-Aware LLM Agents" (arXiv 2603.19935, March 2026)
- **Memory in the Age of AI Agents**: Survey paper (arXiv 2512.13564, January 2026)
- **MAIN-RAG**: "Multi-Agent Filtering Retrieval-Augmented Generation" (ACL 2025)
- **LCM**: "Lossless Context Management" (Voltropy PBC)

### Systems / Products
- **Letta/MemGPT**: Agent self-editing memory with tiered storage
- **ChatGPT Memory**: Automated profiling + saved memories + chat history
- **AWS Bedrock AgentCore Memory**: Managed extraction + consolidation pipeline
- **CAMEL-AI**: Context summarization + workflow memory + brainwash protocols
- **Supermemory**: Disambiguation-focused memory engine (~85% LongMemEval)
- **Algolia**: Dynamic Re-Ranking with daily model retraining + attractiveness scores
- **Slack Search**: Two-stage Solr + SVM re-ranking with message quality signals

---

## 10. Recommendations for Engram

### Immediate (Low-Hanging Fruit)

1. **Add role-based ingestion filters** -- Skip indexing system messages, tool invocations matching known patterns, and pure acknowledgments. This is ~20 lines of regex logic that eliminates 30-50% of noise.

2. **Add salience scoring** -- The `WorkingMemoryItem` already has an `importance` field. Extend this to all episodes. Score based on: named entity count, decision/preference language detection, role (assistant > user > system), content length. Use as retrieval boost factor.

3. **Implement tiered boost weights** -- When the tier router combines results from episodes, digests, and knowledge, apply configurable boost multipliers (knowledge: 2.0, digests: 1.5, episodes: 1.0).

### Short-Term (Next Sprint)

4. **Add a re-ranker stage** -- After vector + keyword retrieval returns top-K candidates, run a CrossEncoder (e.g., `mxbai-rerank-large-v1`) to re-score. SmartSearch shows this is the highest-leverage single improvement. Can run on CPU in ~650ms.

5. **Implement score-adaptive truncation** -- Instead of hard top-K, use `tau = 0.03 * max(reranker_scores)` to dynamically determine how many results to return. Compact context for easy queries, more results for ambiguous ones.

6. **Narrative-level extraction** -- Instead of processing messages individually, batch 5-10 turns and extract 2-5 comprehensive facts per chunk. This naturally filters acknowledgments and meta-queries while preserving cross-turn context.

### Medium-Term (Engram v2)

7. **Dual-index architecture** -- Clean semantic/fact index as primary retrieval target; raw episodic index as secondary/drill-down store. The Engram tier architecture already supports this conceptually; make it explicit with separate search priorities and boost weights.

8. **Intent-adaptive retrieval** -- Use the intent analyzer to not just route to tiers, but to adapt the retrieval strategy: temporal queries get time-range filtering, preference queries search the working memory category field, factual queries use high-precision entity matching.

9. **Temporal fact management** -- Add validity windows to knowledge entries (similar to Zep's bi-temporal model). When new facts contradict old ones, mark old facts as `invalid_at` rather than deleting. Enables "what was true at time X?" queries.

### The Core Insight

The single most important finding from this research: **the bottleneck in agent memory retrieval is ranking, not recall**. SmartSearch demonstrates that even naive substring matching achieves 98.6% recall, but without intelligent ranking, only 22.5% of gold evidence survives truncation. Investing in re-ranking and score-adaptive truncation will yield larger improvements than any amount of ingestion-time filtering alone.

However, ingestion-time filtering and re-ranking are complementary, not competing strategies. The ideal pipeline is:

```
Ingest -> Filter obvious noise -> Extract/score -> Store in tiered indexes
                                                          |
Query -> Intent analysis -> Retrieve from appropriate tiers -> Re-rank -> Score-adaptive truncate -> Format
```

---

## Sources

- [Letta/MemGPT Agent Memory](https://www.letta.com/blog/agent-memory)
- [Mem0 Research Paper](https://arxiv.org/abs/2504.19413)
- [Mem0 Full Paper](https://arxiv.org/html/2504.19413v1)
- [Mem0 AI Memory Layer Guide](https://mem0.ai/blog/ai-memory-layer-guide)
- [Zep: Temporal Knowledge Graph Architecture](https://arxiv.org/html/2501.13956v1)
- [Graphiti Knowledge Graph](https://github.com/getzep/graphiti)
- [Hindsight: Agent Memory That Retains, Recalls, and Reflects](https://arxiv.org/html/2512.12818v1)
- [SmartSearch: How Ranking Beats Structure](https://arxiv.org/html/2603.15599)
- [Chronos: Temporal-Aware Conversational Agents](https://arxiv.org/abs/2603.16862)
- [Memori: Persistent Memory Layer](https://arxiv.org/abs/2603.19935)
- [Memory in the Age of AI Agents: Survey](https://arxiv.org/abs/2512.13564)
- [MAIN-RAG: Multi-Agent Filtering RAG](https://arxiv.org/abs/2501.00332)
- [CAMEL-AI: Brainwash Your Agent](https://www.camel-ai.org/blogs/brainwash-your-agent-how-we-keep-the-memory-clean)
- [AWS AgentCore Long-Term Memory](https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive/)
- [ChatGPT Memory Reverse Engineered](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/)
- [ChatGPT Memory Feature](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- [Lossless Claw / LCM](https://github.com/Martian-Engineering/lossless-claw)
- [LCM Paper](https://papers.voltropy.com/LCM)
- [Slack Search Architecture](https://slack.engineering/search-at-slack/)
- [Slack AI Message Processing](https://engineering.salesforce.com/how-slack-ai-processes-billions-of-messages-to-reduce-information-overload-with-ai-powered-search-and-summarization/)
- [Elasticsearch Multi-Index Search](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-multiple-indices.html)
- [Elasticsearch Field-Level Boosting](https://www.elastic.co/guide/en/app-search/current/relevance-tuning-guide.html)
- [Algolia AI Ranking](https://www.algolia.com/products/features/ai-ranking)
- [Typesense Ranking and Relevance](https://typesense.org/docs/guide/ranking-and-relevance.html)
- [Letta Benchmarking Agent Memory](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- [Supermemory Research](https://supermemory.ai/research/)
- [Mem0 vs Letta Comparison](https://vectorize.io/articles/mem0-vs-letta)
