# @engram-mem/graph

Neo4j-backed neural graph for Engram. Spreading activation recall, community detection, pattern completion, and context-aware memory retrieval across projects.

## Installation

```bash
npm install @engram-mem/graph
npm install @engram-mem/core  # Also required
```

## Quick Start

### 1. Start Neo4j

```bash
docker run -d \
  --name neo4j \
  -p 7474:7474 \
  -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/engram-dev \
  neo4j:community
```

### 2. Create Memory with Graph

```typescript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { openaiIntelligence } from '@engram-mem/openai'
import { NeuralGraph } from '@engram-mem/graph'

const graph = new NeuralGraph({
  uri: 'bolt://localhost:7687',
  user: 'neo4j',
  password: 'engram-dev'
})

await graph.initialize()

const memory = createMemory({
  storage: sqliteAdapter(),
  intelligence: openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY }),
  graph  // Optional: adds neural graph layer
})

await memory.initialize()
```

### 3. Use Memory as Normal

The graph layer works transparently. Recall becomes smarter:

```typescript
// Ingest
await memory.ingest({
  role: 'user',
  content: 'I prefer AWS ECS for deployment'
})

// Recall uses graph spreading activation
const result = await memory.recall('deployment preferences')
console.log(result.formatted)
```

## Architecture

### 8 Node Labels

The graph models knowledge as a network of 8 node types:

| Label | Purpose | Example |
|-------|---------|---------|
| **Memory** | A remembered episode, digest, semantic fact, or procedure | "User prefers TypeScript" |
| **Person** | People mentioned in memories | "Alice", "Bob" |
| **Topic** | Topics/domains of knowledge | "authentication", "deployment" |
| **Entity** | Entities (tech, projects, concepts) | "AWS", "React", "auth-v2" |
| **Emotion** | Emotional context (sentiment, mood) | "frustrated", "excited", "confident" |
| **Intent** | Query/task intents | "DEBUGGING", "PREFERENCE", "TASK_START" |
| **Session** | Conversation sessions | Session IDs for multi-turn tracking |
| **TimeContext** | Temporal context (time of day, day of week, week of year) | Monday morning, Q2 2024 |

Plus **Community** (Wave 5) for cluster detection.

### 14 Relationship Types

The graph connects nodes via semantic relationships:

| Type | Between | Meaning |
|------|---------|---------|
| **MENTIONS** | Memory → Person/Entity | This memory mentions X |
| **ABOUT** | Memory → Topic | This memory is about X |
| **EXTRACTED_FROM** | Semantic → Episode | Fact extracted from this episode |
| **SUPERSEDES** | Semantic → Semantic | Newer fact replaces older belief |
| **CONTRADICTS** | Semantic → Semantic | Facts conflict |
| **SUPPORTS** | Semantic → Semantic | One fact supports another |
| **TEMPORAL** | Memory → Memory | Events happened near in time |
| **CAUSAL** | Memory → Memory | One event caused another |
| **TOPICAL** | Memory → Memory | Share a topic/theme |
| **CO_RECALLED** | Memory → Memory | Often retrieved together |
| **HAS_EMOTION** | Memory → Emotion | Emotional tone |
| **HAS_INTENT** | Memory → Intent | Query intent |
| **IN_SESSION** | Memory → Session | Belongs to session |
| **IN_TIMECONTEXT** | Memory → TimeContext | Temporal context |

## What the Graph Enables

### Spreading Activation Recall

When you recall something, activation spreads through the graph:

1. Query is embedded and matched to Memory nodes
2. Activation spreads to connected Topic, Entity, Person, Emotion nodes
3. Cascade spreads further along relationship paths
4. Neighbor memories "light up" with activation scores
5. Top activated memories are returned (beyond direct matches)

Result: **Context-aware retrieval** that finds related memories you didn't explicitly ask for.

### Community Detection

The graph uses **Louvain community detection** to cluster related memories:

```typescript
const communities = await memory.getCommunitySummaries()
// Returns: [
//   { label: 'Authentication Systems', memberCount: 42, topTopics: ['OAuth', 'JWT', 'OIDC'] },
//   { label: 'Deployment Infrastructure', memberCount: 67, topTopics: ['AWS', 'Kubernetes', 'CI/CD'] },
//   ...
// ]
```

Useful for understanding what knowledge domains you've built up.

### Pattern Completion

Neo4j Graph Data Science algorithms extract patterns:

- **Betweenness Centrality** — Find bridge memories that connect domains
- **PageRank** — Identify most influential facts
- **Similarity** — Find analogous procedures/preferences

## GDS Algorithms Used

The graph layer leverages Neo4j Graph Data Science:

- **Louvain** — Community/cluster detection
- **PageRank** — Importance ranking
- **Betweenness Centrality** — Bridge detection
- **Similarity algorithms** — Pattern completion

These run on-demand during `consolidate()` cycles. No manual tuning required.

## Optional: Works Without Neo4j

If Neo4j is unavailable, Engram degrades gracefully to SQL-only mode:

```typescript
// No graph
const memory = createMemory({
  storage: sqliteAdapter(),
  intelligence: openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY })
  // graph omitted — still works!
})
```

All features work except:
- Spreading activation (uses BM25/vector search instead)
- Community detection
- Betweenness centrality / bridge detection

For local development or small agents, SQL-only is perfectly fine.

## Configuration

### Graph Options

```typescript
interface GraphConfig {
  uri: string            // bolt://localhost:7687
  user: string           // default: neo4j
  password: string       // default: engram-dev
  database?: string      // default: neo4j
  maxConnections?: number // connection pool size
}

const graph = new NeuralGraph(config)
```

### Docker Setup (Production)

For production, use Neo4j enterprise or community with proper persistence:

```bash
docker run -d \
  --name neo4j-prod \
  -p 7474:7474 \
  -p 7687:7687 \
  -v neo4j-data:/var/lib/neo4j/data \
  -e NEO4J_AUTH=neo4j/strong-password \
  -e NEO4J_ACCEPT_LICENSE_AGREEMENT=yes \
  neo4j:community
```

## Usage Patterns

### Session-Scoped Graph Queries

Each session can have its own memory subgraph:

```typescript
const sess = memory.session('user-123')
await sess.ingest({ role: 'user', content: 'I prefer tabs over spaces' })

// Graph isolation: this user's memories form a subgraph
const result = await sess.recall('code style')
```

### Cross-Project Bridges

Find shared entities between projects:

```typescript
const bridges = await memory.findBridges('project-a', 'project-b')
// Returns people/entities that appear in both projects
```

## Types Reference

```typescript
import type {
  NodeLabel,           // 'Memory' | 'Person' | 'Topic' | ...
  RelationType,        // 'TEMPORAL' | 'CAUSAL' | ...
  ActivationResult,    // { nodeId, nodeType, activation, ... }
  EpisodeDecomposition, // Structured episode for graph ingestion
} from '@engram-mem/graph'
```

See `src/types.ts` for complete type definitions.

## Troubleshooting

**Q: Neo4j connection refused**

A: Ensure Neo4j is running on the configured URI. Check `NEO4J_URI` env var and Docker port mappings.

**Q: "Memory not initialized" error**

A: Call `await graph.initialize()` before using `createMemory()`.

**Q: No activation results on recall**

A: Spreading activation requires at least one embedding to match. Make sure you've ingested enough memories and run consolidation to create semantic memories. Also check that `memory.intelligence` is configured (required for embeddings).

**Q: Graph taking too much disk space**

A: Neo4j stores all relationships. For very large memory stores (>1M episodes), consider archiving old sessions or running decay consolidation passes to prune low-confidence edges.

## Learn More

- **Spreading Activation** — `src/spreading-activation.ts`
- **Context Extractors** — `src/context-extractors.ts` (emotion, intent, persons)
- **Pattern Completion** — `src/pattern-completion.ts` (Wave 5)
- **@engram-mem/core** — Core memory engine
- **Neo4j Documentation** — https://neo4j.com/docs/

## License

Apache 2.0
