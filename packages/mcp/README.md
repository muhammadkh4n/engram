# @engram-mem/mcp

MCP server exposing Engram memory tools for Claude Code and other MCP clients. Persistent memory across conversations with semantic search, neural graph recall, and consolidation cycles.

## Installation

```bash
npm install -g @engram-mem/mcp
```

This installs the `engram-mcp` command and related utilities.

## Quick Start

### 1. Set Up Claude Code MCP Config

Add Engram to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "engram-mcp",
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_KEY": "<service-role JWT — needs RLS bypass to write>",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### 2. Set Environment Variables

**Required:**
- `SUPABASE_URL` — PostgREST endpoint URL (hosted Supabase project URL, self-hosted Postgres + PostgREST, or any PostgREST-compatible deployment; env keys kept named `SUPABASE_*` for back-compat per v0.4.0)
- `SUPABASE_KEY` — service-role JWT signed with your `PGRST_JWT_SECRET` (the anon key won't authorize writes — RLS bypass is required)
- `OPENAI_API_KEY` — OpenAI API key (for embeddings + summarization + contextualization + rerank if not using local)

**Optional v0.4.x env flags:**

- `ENGRAM_RERANK_LOCAL=true` — swap the LLM-pointwise reranker for the local mxbai-rerank cross-encoder via ONNX Runtime (zero per-query cost). Requires `@engram-mem/rerank-onnx` to be installed.
- `ENGRAM_RERANK_LOCAL_MODEL` — pick the mxbai variant. Default: `mixedbread-ai/mxbai-rerank-large-v1` (~1-1.5 GB peak RAM at load). For memory-constrained boxes try `mixedbread-ai/mxbai-rerank-base-v1` (~50-70 MB) or `mixedbread-ai/mxbai-rerank-xsmall-v1` (smaller still).
- `ENGRAM_INGEST_CONTEXTUAL=true` — Anthropic-style Contextual Retrieval. Memory.ingest will call `intelligence.contextualizeChunk` to generate a 50-100 token preamble per turn and use it to enrich the embedding (content stays pristine so FTS keeps lexical precision).
- `ENGRAM_PROJECT_ID` — explicit default project for the **ingest CLIs** (the git post-commit hook, pre-compact, and session-summary). These run inside a project directory, so they auto-detect the project from the git repo basename; set this to override that detection. It does **not** scope the MCP server (see project isolation below). `global`/`none` map to the shared bucket.

**Optional (enables Neo4j neural graph):**
- `NEO4J_URI` — e.g., `bolt://localhost:7687`
- `NEO4J_USER` — default: `neo4j`
- `NEO4J_PASSWORD` — default: `engram-dev`

When `NEO4J_URI` is set and reachable, Engram runs in full "graph mode" with spreading activation recall. Otherwise, the server degrades gracefully to SQL-only mode.

### 3. Start Using

Claude Code now has access to Engram's memory tools. The server auto-includes instructions telling Claude when and how to use them.

### Project isolation (Wave 5)

Recall and ingest can be scoped to a project so one project's memories never leak into another's. The scope is **declarative and per-call** — the server holds no project state of its own (important for a shared HTTP server, which has no project context):

- `memory_recall` and `memory_ingest` accept an optional **`project_id`** parameter. The agent passes the current working project (typically the git repo name) to scope the call; omitting it means unscoped (all projects).
- A recall scoped to project X returns only X's memories plus shared ones (`project_id IS NULL`); every other project is excluded — enforced in SQL and in the graph spreading-activation traversal.
- Ingest with `project_id` tags the stored memory; without it the memory is shared.
- The git/hook ingest CLIs auto-detect the project from their working directory (see `ENGRAM_PROJECT_ID` above to override).

Because the parameter is optional and agent-driven, cross-project recall is possible when the agent intends it — it simply passes a different `project_id` (or none).

## MCP Tools

All tools are available as MCP resources. Claude uses them automatically based on context.

### memory_recall

Search memory for content relevant to a query.

**Input:**
```json
{
  "query": "What deployment preferences did we discuss?",
  "session_id": "optional-session-id"
}
```

**Returns:** Formatted memories with attribution (role, date, session). Includes direct matches and associated memories found via graph walk.

**When Claude uses it:** Automatically before answering questions about past work, decisions, or preferences. Also when you reference a previous session ("remember when...", "what did we decide about...").

### memory_ingest

Store a message into memory.

**Input:**
```json
{
  "content": "User prefers TypeScript with strict mode enabled",
  "role": "user",
  "session_id": "optional-session-id"
}
```

**Role must be:** `"user"`, `"assistant"`, or `"system"`

**When Claude uses it:** After important user statements, decisions, preferences, or assistant responses worth remembering.

### memory_forget

Deprioritize memories matching a query. Lossless — memories are never deleted, only decayed below retrieval floor.

**Input:**
```json
{
  "query": "deprecated API endpoint",
  "confirm": false
}
```

Pass `confirm: true` to apply. Omit or `false` to preview only.

### memory_timeline

Show how a topic evolved over time. Returns chronological semantic memories including superseded beliefs.

**Input:**
```json
{
  "topic": "authentication strategy",
  "from_date": "2024-01-01",
  "to_date": "2024-12-31"
}
```

Useful for understanding how knowledge changed and what beliefs were replaced.

### memory_overview

High-level summary of what Engram knows, organized by knowledge clusters (communities).

**Input:**
```json
{
  "topic": "optional-filter",
  "max_communities": 5,
  "project_id": "optional-namespace"
}
```

Returns community labels, member counts, top topics, entities, people, and dominant tone.

### memory_consolidation_status

Reports when each consolidation cycle (light / deep / dream / decay) last ran and its result. Reads from the `memory_consolidation_runs` table — no compute, just lookups. Useful for verifying that auto-consolidation is healthy or diagnosing why `memory_overview` returns no clusters.

No parameters.

**Example response:**
```
## Engram — Consolidation Status

- **light**: completed at 2026-05-25T03:34:33Z in 80943ms
  - digests=3
- **deep**: completed at 2026-05-25T03:19:01Z in 52225ms
  - promoted=0
- **dream**: completed at 2026-05-24T14:13:01Z in 184438ms
  - associations=0, communities=11525, summaries=52, llmCalls=52, ~$0.0053, episodeCount=4733
- **decay**: completed at 2026-05-24T14:19:18Z in 5456ms
```

### memory_bridges

Find shared people or entities that bridge two projects.

**Input:**
```json
{
  "project_a": "project-1-id",
  "project_b": "project-2-id"
}
```

Returns cross-project connections (people/entities shared between projects). Useful for understanding what or who connects two workstreams.

## How It Works

### Memory Systems

Engram has 5 cognitive systems:

1. **Sensory Buffer** — In-memory working memory (~100 items). Primed topics boost future recall.
2. **Episodic System** — Raw conversation turns (ground truth, never deleted).
3. **Semantic System** — Extracted facts with confidence scores. Decays over time.
4. **Procedural System** — Learned workflows, preferences, habits.
5. **Associative Network** — Graph edges (temporal, causal, topical, supports, contradicts, etc.).

### Consolidation Cycles

Memory auto-consolidates (episodes → digests → semantic/procedural facts). Optional Neo4j neural graph adds spreading activation and community detection.

### SQL-Only Mode

To run Engram without Neo4j (local, minimal setup):

```bash
# Use @engram-mem/sqlite instead
npm install @engram-mem/sqlite
```

Then configure in your app code:

```typescript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { openaiIntelligence } from '@engram-mem/openai'

const memory = createMemory({
  storage: sqliteAdapter({ path: './engram.db' }),
  intelligence: openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY })
})
```

The MCP server uses Supabase by default, but the core library supports any storage backend.

## Configuration

### Consolidation

By default, consolidation runs automatically on ingest. To control it:

```json
{
  "mcpServers": {
    "engram": {
      "command": "engram-mcp",
      "env": {
        "AUTO_CONSOLIDATE": "false"
      }
    }
  }
}
```

### Neo4j Graph Setup (Optional)

If using Neo4j for graph-powered recall:

```bash
docker run -d \
  --name neo4j \
  -p 7474:7474 \
  -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/engram-dev \
  neo4j:community
```

Then set `NEO4J_URI=bolt://localhost:7687` in your config.

## Utilities

The package includes CLI utilities for advanced use cases:

- `engram-ingest` — Bulk ingest from files or stdin
- `engram-session-summary` — Summarize a session
- `engram-git-setup` — Set up git hooks for automatic ingestion
- `engram-shell-setup` — Set up shell hooks

## Troubleshooting

**Q: Claude isn't using memory_recall automatically**

A: The server includes built-in instructions that guide Claude to use recall proactively. If it's not working, check that the MCP server is running and that Claude can see the tools (they should appear in the tools list).

**Q: No memories found on recall**

A: Memories are only retrieved after they're ingested and consolidated. Wait a moment for consolidation to run, then try again. Check that you're using the same session ID if you scoped to a specific session.

**Q: High token estimates**

A: Use `tokenBudget` option to limit results. Memories are ranked by relevance, so top results are highest value. Or configure `AUTO_CONSOLIDATE=true` to create digests (summaries) that reduce token count.

**Q: "Missing required environment variable"**

A: Ensure `SUPABASE_URL` (any PostgREST endpoint), `SUPABASE_KEY` (service-role JWT), and `OPENAI_API_KEY` are set in your Claude config.

## Learn More

- **@engram-mem/core** — Core memory engine API
- **@engram-mem/graph** — Neo4j neural graph (Wave 2+)
- **@engram-mem/sqlite** — Local SQLite adapter

## License

Apache 2.0
