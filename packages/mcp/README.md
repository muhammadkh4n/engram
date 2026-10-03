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

- `ENGRAM_RERANK_LOCAL=true` — swap the LLM-pointwise reranker for a local cross-encoder via ONNX Runtime (zero per-query cost). Requires `@engram-mem/rerank-onnx` to be installed.
- `ENGRAM_RERANK_LOCAL_MODEL` — pick the model. Default: `Alibaba-NLP/gte-reranker-modernbert-base` (rerank p50 3.6 s, RSS 1.66 GB on a CPU host). `mixedbread-ai/mxbai-rerank-large-v1` is the previous default (about 4× slower rerank, RSS 2.84 GB); `mixedbread-ai/mxbai-rerank-base-v1` and `mixedbread-ai/mxbai-rerank-xsmall-v1` are smaller mxbai variants. Rerank scores are not comparable across models. Upgrading with this variable unset switches the model and downloads its weights on first use; set it to `mixedbread-ai/mxbai-rerank-large-v1` to keep the previous one.
- `ENGRAM_INGEST_CONTEXTUAL=true` — Anthropic-style Contextual Retrieval. Memory.ingest will call `intelligence.contextualizeChunk` to generate a 50-100 token preamble per turn and use it to enrich the embedding (content stays pristine so FTS keeps lexical precision).
- `ENGRAM_SALIENCE_THRESHOLD` — server env for the capture route and the local ingest CLIs: the salience classifier's confidence cut, `0`..`1`, default `0.7`. A capture the classifier marks not worth storing, or scores below it, is rejected.
- `ENGRAM_PROJECT_ID` — explicit default project for the **ingest CLIs** (the git post-commit hook, pre-compact, and session-summary). These run inside a project directory, so they auto-detect the project from the git repo basename; set this to override that detection. It does **not** scope the MCP server (see project scoping below). `global`/`none` map to the shared bucket.

Recall output policy (server-wide; every variable unset means an unbounded payload, the same text as before these settings existed):

- `ENGRAM_RECALL_EMIT_K` — positive integer: emit only the first K Recalled memories.
- `ENGRAM_RECALL_TOKEN_BUDGET` — positive integer: cap the recall text at this many estimated tokens (`ceil(chars / 4)`), headers included. The per-call `token_budget` argument of `memory_recall` overrides it. A value below 128 (the header plus the 120 chars one section needs for a memory) fails startup, since it could never show one.
- `ENGRAM_RECALL_FAINT` — `on` (default) or `off`: emit the Faint Associations section.
- `ENGRAM_RECALL_RELATED_SHARE` — decimal from `0` to `0.9`, default `0.3`: the part of the budget room (the budget minus the header and any notice) held for Related Memories. Recalled memories fill the rest first; room either section leaves unused goes to the other (Recalled first), then Domain, Context and Faint fill what is left, in that order. Each section emits a prefix of its own ranking.
- `ENGRAM_RECALL_ITEM_MAX_TOKENS` — positive integer, default a quarter of the budget: the longest single item in estimated tokens. A longer item is cut and ends with ` …` (see "Cut items" below), so one long memory cannot take the whole budget and the text never exceeds it. The cap in force is never larger than the budget in force: a per-call `token_budget` below the configured cap lowers the cap to that budget. When both `ENGRAM_RECALL_ITEM_MAX_TOKENS` and `ENGRAM_RECALL_TOKEN_BUDGET` are set, a cap larger than the budget fails startup.

**First item of each section.** Under a budget, the first Recalled memory and the first Related memory are each cut to fit their section's room (its share of the budget room, minus the heading), as described under "Cut items", and never past the item cap. Later items keep the item cap. So each of the two sections shows its best-ranked memory whatever the share, as long as its room is at least 120 chars and the room and cap can hold the item's tag and 40 content chars; a section with less room (or with no candidates) reserves nothing, and the other section takes its room. A recall whose memories matched but whose budget shows none of them answers that the budget is too small, not that nothing matched.

**Cut items.** A cut item always shows content. The cut lands at the last word boundary within the final 20% of the item's room; without one there it is a hard cut at the room, never inside a surrogate pair (so an emoji is never split). It never lands inside the `- [type · role · date]` tag: the item keeps at least 40 content chars after the tag, or all of its content when that is shorter. An item whose room cannot hold its tag and that much content is not emitted, and its section's prefix ends before it.

The share and the item cap apply only when a token budget is in force (from `ENGRAM_RECALL_TOKEN_BUDGET` or the per-call `token_budget`); with no budget they change nothing, and with no budget and no emit-K the payload is the unbounded text. A per-call `token_budget` replaces only the budget: the share still comes from the server, and the item cap does too when `ENGRAM_RECALL_ITEM_MAX_TOKENS` is set, otherwise it is a quarter of the per-call budget.

An empty value counts as unset. Any other malformed value fails server startup with an error naming the variable, before the server listens; the resolved policy is logged once at startup as `[engram-mcp] recall output policy: emitK=… tokenBudget=… faint=… relatedShare=… itemMaxTokens=…`.

Recall LLM step cache (read once when the server builds its memory instance; an empty value counts as unset, any other malformed value fails startup with an error naming the variable):

- `ENGRAM_RECALL_LLM_CACHE_MAX` — non-negative integer, default `1000`: query expansions and HyDE documents the server keeps, so a repeated question on the same day reuses its first expansion instead of sampling a new one. `0` disables the cache.
- `ENGRAM_RECALL_LLM_CACHE_TTL_MIN` — positive integer, default `1440`: minutes a cached expansion is reused.

Fact supersession in deep sleep (parsed once at server startup; a malformed value fails startup with an error naming the variable, and the resolved settings are logged once):

- `ENGRAM_SUPERSESSION` — `regex` (default), `llm` or `off`: how deep sleep retires a stored fact that a newer one replaces. `llm` asks the chat model whether nearby facts repeat or conflict with the new fact and whether each fact is a state, an event or a plan, orders a conflict by when each fact was stated, and retires only a current-state fact. See "Fact supersession in deep sleep" in the core README.
- `ENGRAM_SUPERSESSION_MIN_COSINE` — a number in [-1, 1], default `0.6`: the cosine floor for a stored fact to be compared with a new one.

Ranking priors (read on every recall call; each is `on` or `off`, default `off`; any other value throws, naming the variable). With both off, ranking is unchanged.

- `ENGRAM_RECALL_HUB_DAMPING` — damps memories recalled far more often than their tier. For episode, semantic and procedural candidates, T = max(p99 of the tier's access_count, 10); the factor is 1 when access ≤ T, else `1 / (1 + ln(access / T))`. Digests get 1. The p99 comes from the storage's `accessCountQuantile` and is cached per storage instance for 10 minutes. On PostgREST it needs the `engram_access_count_quantile` function, so re-apply `packages/postgrest/schema.sql` before turning this on; with the function missing, hub damping is a no-op that logs one warning per process.
- `ENGRAM_RECALL_SEMANTIC_CONFIDENCE` — semantic candidates are scaled by `0.5 + 0.5 · clamp(confidence, 0, 1)`.

The prior is the product of the enabled factors. It multiplies each primary candidate's score, and after reranking it multiplies the rerank component again: `blended = w · rerank · prior + (1 − w) · relevance`. Graph associations are unaffected. A memory whose prior is not 1 carries it as `rankPrior`.

- `ENGRAM_RECALL_FUSION` — JSON object overriding recall fusion weights, thresholds and candidate counts (e.g. `{"lexicalWeight":0.2,"rerankWeight":0.8}`), read on every recall. Unset or empty means the built-in defaults and unchanged ranking; an unknown key, a non-number or an out-of-range value fails the recall with an error naming the key. Keys, defaults and ranges are listed in the `@engram-mem/core` README (Fusion config). Meant only for adopting a config a measured bench grid has shown to beat the defaults, not for hand tuning.

The payload is assembled in a fixed section order: Recalled Memories, Related Memories, Knowledge Domain Context, Context, Faint Associations. Each section emits a prefix of its own ranking (the prefix rule): within a section, items are added in rank order and the first item that does not fit ends that section, so a smaller item never jumps a better-ranked one. Recalled and Related split the room as described above, and the room either leaves unused goes to the other; Domain, Context and Faint then fill what is left in that order, and the first of their items that does not fit ends assembly. No item exceeds the item cap, the first Recalled and Related items are cut to their section's room as described above, and a section heading is written only with its first item. Access counts, co-recall edges and graph weights are recorded only for the memories and associations the payload emitted; an item counts as emitted only when it shows content, which every emitted item does.

**Optional (enables Neo4j neural graph):**
- `NEO4J_URI` — e.g., `bolt://localhost:7687`
- `NEO4J_USER` — default: `neo4j`
- `NEO4J_PASSWORD` — default: `engram-dev`

When `NEO4J_URI` is set and reachable, Engram runs in full "graph mode" with spreading activation recall. Otherwise, the server degrades gracefully to SQL-only mode.

### 3. Start Using

Claude Code now has access to Engram's memory tools. The server auto-includes instructions telling Claude when and how to use them.

### Project scoping

A project tag **ranks** memories; it never hides one. Tags come from the working directory at write time, so a memory written from a worktree, a sibling repo of the same product, or outside any repo would otherwise vanish exactly where it is needed. The scope is **declarative and per-call** — the server holds no project state of its own (important for a shared HTTP server, which has no project context):

- `memory_recall` and `memory_ingest` accept an optional **`project_id`** parameter. The agent passes the current working project (typically the git repo name); omitting it means no project preference.
- A recall for project X returns every matching memory. X's memories get `+ENGRAM_PROJECT_BOOST` (default `0.10`), memories of another project in X's product group get `+ENGRAM_PROJECT_GROUP_BOOST` (default `0.05`), shared and unrelated memories get nothing. The boost is applied before the candidate cut the reranker sees and again after reranking.
- Product groups come from the JSON file named by `ENGRAM_PROJECT_GROUPS_FILE`: `{ "groups": { "aithentic": ["aithentic-*", "*-mfe"], "engram": ["engram*"] } }`. Patterns are project names or `*`/`?` globs, matched case-insensitively against the whole name; a project belongs to the first group that matches. Unset, missing or malformed means no groups; each distinct failure is reported once on stderr. The file is re-checked at most every 60 s and re-read when its modification time or existence changes, so an edit takes effect without a restart.
- Ingest with `project_id` tags the stored memory; without it the memory is shared.
- The git/hook ingest CLIs auto-detect the project from their working directory (see `ENGRAM_PROJECT_ID` above to override).
- Hard scoping (only X plus shared memories) exists as the `projectStrict` recall option of `@engram-mem/core`; neither the MCP server nor the CLIs enable it.

## MCP Tools

All tools are available as MCP resources. Claude uses them automatically based on context.

### memory_recall

Search memory for content relevant to a query.

**Input:**
```json
{
  "query": "What deployment preferences did we discuss?",
  "session_id": "optional-session-id",
  "conversation_id": "optional-conversation-id",
  "token_budget": 4000
}
```

`conversation_id` is optional: a non-blank string of at most 200 characters (trimmed) naming the caller's current conversation. It scopes priming to that conversation: keywords shared by several memories an earlier recall of the same `conversation_id` returned give a small score boost (whole-token match, capped) and seed the graph walk in its next recalls, and the last recall's intent informs the next one. It does **not** filter results, unlike `session_id`. A recall without `conversation_id` gets no priming and writes no priming state, so until a client sends it, priming is off. `ENGRAM_RECALL_PRIMING=off` disables priming even when it is sent. A blank, non-string or longer value returns an error result.

`token_budget` is optional: an integer from 256 to 32000 that raises or lowers the server's `ENGRAM_RECALL_TOKEN_BUDGET` for this call only. Any other value returns an error result. Omitted, the server default applies (unbounded when unset). The budget covers the whole payload, Related Memories included, split by `ENGRAM_RECALL_RELATED_SHARE` and with every item capped by `ENGRAM_RECALL_ITEM_MAX_TOKENS` (default a quarter of this budget).

The request time is the recall's reference date. Query expansion states it to the model as today's date, so a relative phrase ("last week", "yesterday") expands to the dates it means. The model gets the weekday and the calendar day (`Today's date is Friday, 2026-10-02.`) in `ENGRAM_TIMEZONE`, an IANA zone name such as `Asia/Karachi` (default `UTC`), read once at startup. A name the runtime does not know fails startup.

**Returns:** Formatted memories with attribution (role, date, session). Includes direct matches and associated memories found via graph walk, in the section order and under the per-section prefix rule described in the recall output policy above.

With `ENGRAM_RECALL_TIMING=1` the server writes one `[recall]` line per call to stderr: stage timings in milliseconds (`total expand search hyde pattern mmr rerank graph`, then any `graph.*` sub-stages sorted; a stage that did not run is absent), `items=` (the ranked pool), `chars=`, `emitted=` (Recalled memories in the payload), `tokens=` (estimated tokens of the payload) and `truncated=1` when the token budget cut it short.

With `ENGRAM_RECALL_LOG=<file path>` (unset = off) the server also appends one JSON line per recall to that file, for replaying real recall traffic in order and for counting how often each memory is shown:

```json
{"ts":"2026-09-30T12:00:00.000Z","query":"deploy window","project_id":"engram","session_id":null,"conversation_id":null,"mode":"QUESTION","emitted":[{"id":"…","type":"episode","rank":1}],"associated":[{"id":"…","type":"semantic"}],"timings":{"total":120}}
```

- `query` is the query as received, trimmed, with credentials replaced by the same secret scrubber ingest uses. The recall itself still runs on the unscrubbed query.
- `project_id` is the normalised `project_id` argument; `session_id` and `conversation_id` are the call's arguments of those names, `null` when absent. `mode` is the intent type the recall classified the query as.
- `emitted` lists the Recalled section's memories in display order (`rank` from 1); `associated` lists every other memory the payload carried (related, domain, context and faint sections), in display order. `timings` is the same stage map the `[recall]` line prints when `ENGRAM_RECALL_TIMING=1`, else `null`.
- The file is created with mode 0600 (an existing file is tightened to it). Lines are written in the background, one at a time: a slow or failing write never delays or fails a recall, and a write error is logged to stderr at most once per minute.
- `ENGRAM_RECALL_LOG_MAX_MB` (default 200) caps the file: when the next line would push it past the cap, it is renamed to `<file>.1` (replacing any previous one) and a new file is started. A non-positive or non-numeric value fails startup.

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

Agents call `memory_ingest` as shown; its schema has no capture options. Hook and CLI captures go through the HTTP server's `POST /capture` route instead (below).

## Capture route (HTTP server)

`POST /capture` on the HTTP server (`engram-mcp-http`) runs the capture pipeline: secret scrub, salience classification, dedup and storage, with the server's model configuration. It is for hooks and ingest CLIs, not agents, and sits behind the same `Authorization: Bearer $BEARER_TOKEN` check as `/mcp`. One request per capture; no MCP handshake.

**Body** (JSON object; unknown fields are refused with 400):

| Field | Type | Notes |
|---|---|---|
| `content` | string, required | Non-empty, at most 100,000 characters |
| `source` | string, required | Lowercase slug naming the caller, e.g. `git-commit` |
| `role` | `"user"` \| `"assistant"` \| `"system"` | Required unless `derive` is set |
| `session_id` | string | At most 256 characters |
| `project_id` | string | Project tag; omitted or `null` means shared; any other non-string is a 400 |
| `gate` | boolean, default `true` | Run the salience classifier; `false` stores without it |
| `dedup` | boolean, default `true` | Skip near-duplicates of recent memories |
| `derive` | `"session-summary"` \| `"pre-compact"` | `content` is a transcript; the server digests it first |
| `dry_run` | boolean, default `false` | Classify but store nothing |
| `key` | string | Idempotency key, at most 128 characters; a repeat within the same `session_id` returns `replayed` |
| `meta` | object of strings | Provenance only. Allowed keys: `transcriptPath`, `trigger`, `cwd`, `capturedAt`; any other key is refused with 400 naming it. Values at most 512 characters |

**Response:** always a JSON outcome:

```json
{ "outcome": "stored", "model": "…", "category": "decision", "confidence": 0.86, "project": "engram" }
```

- `outcome`: `stored`, `rejected` (with `reason`), `deduped` (with `duplicateOf`, `similarity`), `replayed`, `dry_run` or `error`.
- A `key` is only checked against captures in the same session. A capture with a `key` and no `session_id` is stored under session `default` and is not idempotent: only the dedup check can catch a repeat.
- `pre-compact` derives also return `context`, the text to re-inject, whenever the model produced one, whether the memory was stored, deduped or rejected as `empty_digest`. A `replayed` retry returns no `context`: the digest is not re-run.
- Classifier failures come in two classes:
  - The chat call failed (network, 429, 5xx), or it answered 200 with no visible text (null, empty or whitespace content, as when a reasoning model spends `max_tokens` before replying). An empty reply gets one inline retry; if the second reply is empty too, or the call failed (never retried inline): `500`, `retryable: true`. Send the capture again later. The response message is the generic `capture failed; retry later`; the cause goes to the server log only.
  - The model answered, but its reply could not be read as a verdict (not JSON, or no boolean `store`). The server asks once more, as for an empty reply. If the second reply is unreadable too, it answers `422` with `outcome: "error"`, `reason: "unclassifiable"`, `retryable: false`. Resending the same content will not help, so a client dead-letters it instead of retrying.
- Status: 200 for every other pipeline outcome, rejections included; 400 invalid JSON or body (`retryable: false`); 413 body above 1 MiB (`retryable: false`); 422 unclassifiable (`retryable: false`); 500 any other failure after validation, or a request body that could not be read (`retryable: true`, generic message, detail in the server log); 405 for methods other than POST.
- The local `engram-ingest` CLI exits 1 on an unclassifiable turn, as on any other failure. It needs `OPENAI_API_KEY` whenever it calls a model or the store; `--raw --dry-run` calls neither and needs no credentials.

## Capture clients (hooks and ingest CLIs)

`engram-ingest` (git post-commit, the Stop and UserPromptSubmit hooks), `engram-session-summary` (SessionEnd) and the pre-compact hook run in one of two modes.

**Server mode** — `ENGRAM_SERVER_URL` is set. The client resolves the content, scrubs secrets and detects the project, then posts one request to `POST /capture`. The server runs the classifier, the digest (session summary, pre-compact) and the store with its own model configuration, so the laptop needs no `SUPABASE_*`, `OPENAI_API_KEY` or `NEO4J_*`.

- `ENGRAM_SERVER_URL` — the server's MCP endpoint, e.g. `http://host:3850/mcp`, shared with the MCP client config. A trailing `/mcp` (or `/capture`) path segment is replaced by `/capture`; any other URL gets `/capture` appended.
- `ENGRAM_SERVER_TOKEN_FILE` — file holding the bearer token (trimmed; `~/` expands). Wins over `ENGRAM_SERVER_TOKEN`, the token inline. One of the two is required.
- Request timeouts: 60 s for a turn, 180 s for a derive capture. The server keeps working after a client gives up and the key has no unique constraint, so a shorter timeout followed by a retry could store twice. The one exception is pre-compact, which uses 25 s because its hook blocks compaction until it returns: on a timeout it spools the capture, and the pre-compact dedup (cosine 0.62 over 30 days) absorbs a digest re-sent while the first request was still running.
- A capture carries a `key` only when it also carries a `session_id`, so a rerun of the same hook on the same input returns `replayed`. Without a session id (ad-hoc `engram-ingest`, a hook input with no `session_id`) the client sends neither, and the server's dedup check is the only repeat guard.
- Outcome classes: a 2xx with a pipeline outcome is sent; 400/413/422 or `retryable: false` is dead-lettered; network errors, timeouts, 5xx, 401/403 and 404/405 are spooled (a wrong URL or token is fixed on the client, and the captures wait for it).
- `engram-ingest` exits 0 when the capture was sent or spooled, 1 when it was dead-lettered, 2 on conflicting flags.

**Local mode** — `ENGRAM_SERVER_URL` is unset. The same pipeline (`runCapture`) runs in-process against this machine's store and model credentials (`SUPABASE_URL`, `SUPABASE_KEY`, `OPENAI_API_KEY`, optional `NEO4J_*`, `ENGRAM_SALIENCE_THRESHOLD`). Model and store clients load only in this mode. There is no spool: a failure is logged and the capture is lost.

**Files in `~/.engram/`** (server mode). The directory is mode `0700` and every file the hooks and ingest CLIs write there (these, `hook.log` in either mode, `rejected.jsonl` in local mode) is `0600`. A mode only applies when a file is created, so each writer also clears group and other bits it finds on the directory or on the file it opens, which tightens files an earlier version created under the process umask.

| File | Contents |
|---|---|
| `spool.jsonl` | One `{"v":1,"at":"<ISO>","attempts":1,"payload":{…}}` line per capture not yet sent. After the next successful post the client resends up to 20 entries, oldest first; on a retryable failure it spools its own capture and leaves the backlog alone. `attempts` counts the posts that reached the server and failed retryably (an HTTP answer or a timeout), starting at 1 when the capture is first spooled; a line without it reads as 1. When a resent entry fails that way its count grows by one and it stays at the head, and the flush stops. On its 8th attempt it is dead-lettered instead and the flush continues with the next entry, so one entry the server keeps failing cannot hold the backlog. A connection error (server unreachable) stops the flush without counting an attempt. |
| `spool.flushing.<pid>.<claimedAtMs>.<rand>.jsonl` | A flush claims the spool by renaming it, so two hooks firing together never send one entry twice. A claim older than 10 minutes (by the timestamp in its name) belongs to a dead flusher and is taken over. A flush stops before a post could outlive its claim and appends the rest back to the spool. |
| `spool.dead.jsonl` | Captures the server refused permanently: `{"v":1,"at":"<ISO>","status":422,"message":"…","payload":{…}}` (`status` absent when there was none), and spooled captures dead-lettered on their 8th attempt, which also carry `"attempts":8` and the last error. Unreadable spool lines land here as `{"v":1,"at":…,"message":"unreadable spool line","raw":"…"}`. Nothing resends them; the SessionStart capture-health check reports the file when it is non-empty and was modified within its window. |
| `capture-state.json` | Rewritten atomically after every attempt; health checks read it. Schema below. |
| `spool.lock` | Advisory lock (`O_CREAT\|O_EXCL`) held only for the file operations on the spool, the dead-letter file and `capture-state.json`, never across a post, so an append cannot land in a claim the flusher already read and two state rewrites cannot drop each other's update. A lock older than 30 s belongs to a dead process and is taken over. A writer that cannot take it within 2 s appends or rewrites anyway (a flush is skipped instead) and logs a `[capture-client] spool.lock held …` line to `hook.log`. |
| `hook.log` | One summary line per capture: `[label] mode=server source=… outcome=… ms=… spool=<entries left>`. |

`capture-state.json`:

```json
{
  "v": 1,
  "createdAt": "2026-10-01T09:00:00.000Z",
  "sources": {
    "git-commit": {
      "lastOkAt": "2026-10-01T09:12:03.000Z",
      "lastStoredAt": "2026-10-01T09:12:03.000Z",
      "lastErrorAt": "2026-10-01T08:40:11.000Z",
      "lastError": "fetch failed"
    }
  }
}
```

- `sources` is keyed by the capture's `source`. Every field is optional and absent until it first happens.
- `lastOkAt`: the server answered with a pipeline outcome (stored, rejected, deduped, replayed, dry run).
- `lastStoredAt`: the outcome was `stored`.
- `lastErrorAt` / `lastError`: the last spooled or dead-lettered attempt and its message (at most 300 characters).
- A source with `lastErrorAt` newer than `lastOkAt`, or a non-empty `spool.jsonl` whose oldest `at` is old, means captures are not reaching the server.

### memory_forget

Forget in two steps. Pass exactly one of `query` or `ids`.

1. **Preview** with a query. Nothing is deleted; each candidate is listed on one line with its id:

   ```json
   { "query": "deprecated API endpoint" }
   ```

   ```
   - [semantic · 2026-03-14] 3f2c… · relevance 0.71 · The v1 /export endpoint is deprecated …
   To forget, call memory_forget again with ids set to the ones to remove.
   ```

2. **Forget** the ids you approved. Exactly those memories are tombstoned (at most 50 per call):

   ```json
   { "ids": ["3f2c…"] }
   ```

   The reply lists the ids per outcome: forgotten, not found, out of scope (tagged with another project), not forgettable (digests).

A tombstone hides a memory from every recall path. The row stays in storage, so a forget is reversible there. The `confirm` flag no longer exists: a query never deletes.

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

1. **Sensory Buffer** — In-memory working memory (~100 items). Primed topics boost later recalls of the same conversation (`conversation_id`).
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
- `engram-derived-project-backfill` — Tag digests and semantic facts stored without a `project_id` from their `derives_from` sources: episodes → digests first, then digests → semantic facts in the same run. A row gets a project only when every tagged source holds that project; mixed sources (`mixed`) and rows with no tagged source (`no-source-tag`) stay NULL. Only NULL rows are read or written, so a repeat run is a no-op. Dry-run by default (counts per project and per reason, up to ten sample ids per bucket, never content); `--apply --applied-out FILE` writes in batches and records every row it tagged in a new CSV as (tier, id, project_id), so the apply can be undone exactly
- `engram-semantic-dedup` — Report clusters of near-duplicate live semantic facts: each row's top-k nearest neighbours (default 10) within the same `project_id` (NULL only with NULL) at cosine ≥ `--report-sim` (default 0.88), joined by union-find. Canonical row: highest confidence, then most `derives_from` sources, then newest. Dry-run by default: JSON on stdout (ids, similarities, `access_count` / `shown_count`, canonical choice) and a summary on stderr; content only goes to a new local file named with `--report`. `--apply --merge-sim S` (S ≥ 0.95) sets `superseded_by = <canonical>` on the other rows of clusters whose every pair is ≥ S, deletes nothing, and appends each written row to a new `--rollback-csv` file as (row, canonical, sim, graph_forgotten_at). Each write also sets `updated_at`, which is how tombstone readers (the graph decay pass, the recall-engine index) see the supersession. With `NEO4J_URI` set, the apply stamps `forgottenAt` on each written row's graph node in the same run (the CSV records the stamp time), so it stops relaying spreading activation at once; an unreachable Neo4j stops the apply before any write, and without `NEO4J_URI` the run says the graph was not stamped and that `engram-graph-reconcile --apply` must follow. Clearing `superseded_by` restores a row in Postgres, and removing `forgottenAt` where it still equals the CSV's `graph_forgotten_at` restores its node; the recall-engine index re-adds the row only on a rebuild
- `engram-episode-reembed` — Re-embed episodes whose stored vector was built from a cut text. Dry-run by default; `--apply` writes
- `engram-fact-supersession` — Retire stored semantic facts that a later stored fact replaces, using the same
  supersession judge deep sleep uses (`ENGRAM_CHAT_*` select its model and host). Two steps: a dry run proposes, an
  apply writes exactly the proposals of a reviewed report.
  - Facts are ordered by statement time, the time of the conversation a fact came from: the latest source episode of
    its source digests, else the digest's own time, else the row's insert time. Insert time alone cannot order facts,
    because deep sleep re-reads a week of digests on every run.
  - Each fact, latest statement first, is judged against the live facts of its own project (shared facts only against
    shared facts) stated strictly earlier, at cosine at or above `--min-cosine` (default
    `ENGRAM_SUPERSESSION_MIN_COSINE`, else 0.6), at most five. The judge also labels each fact `state`, `event` or `plan`; a conflict
    proposes retiring the earlier fact only when it is a `state` and the later fact a `state` or an `event` (the rule
    deep sleep applies; a conflict where either kind is missing or invalid retires nothing). A fact proposed for retirement is neither judged nor
    offered again.
  - Dry run (`--max-calls N` required; the run stops at the cap and says so): the judge runs, nothing is written.
    Stdout is JSON with the proposals (new id, old id, cosine, both statement dates, both rows' `updated_at` and a
    hash of their topic and content, both kinds), the count of judged conflicts per rule outcome (`retire`,
    `kept-earlier-not-state`, `kept-later-not-current`, `kept-kind-missing`) and counts per similarity band. Fact text never goes to stdout; `--report PATH`
    writes the proposals with both facts' text to a new local file (mode 0600), `--sample N` writes N random ones.
  - Apply: `--apply --from-report PATH --rollback PATH` writes exactly the proposals in that report and calls no
    judge. A report written with `--sample` holds only the sample. Every entry must carry `newKind` and `oldKind`: a
    report without them, written before the state rule, is refused as a whole (regenerate the dry run on this
    version), and an invalid kind refuses the report. The rule runs again on each entry's kinds; an entry it does not
    let retire is not written and is listed under `rejected` on stdout with its outcome. A pair is skipped, and listed on stdout with a
    reason, when either row is missing, no longer live, or changed since the report (its `updated_at` or its text).
    A decay pass bumps `updated_at` on the facts it decays, so run the apply before the next decay pass or dry-run
    again. Each write sets `superseded_by` and bumps `updated_at`, only while the old row is still live and
    unchanged, and appends `old_id,new_id,cosine,graph_forgotten_at` to the rollback CSV (a new file).
  - Graph: with `NEO4J_URI` set, each retired fact's Neo4j node gets `forgottenAt` right after its write, and the
    stamp time goes into the CSV first. An unreachable Neo4j stops the apply before any write; a failed stamp is
    counted and the run asks for `engram-graph-reconcile --apply`. Without `NEO4J_URI` the run says once that the
    graph was not stamped and that `engram-graph-reconcile --apply` must follow.
  - Rollback: nothing is deleted. Clearing `superseded_by` (and bumping `updated_at`) on the CSV's old ids restores
    the SQL rows, and removing `forgottenAt` from each old id's node where it still equals the line's
    `graph_forgotten_at` restores the graph; a node forgotten before the apply keeps its own stamp. The decay pass
    re-stamps a superseded fact's node, so restore SQL before the graph. The same applies to the facts
    `engram-semantic-dedup` retires.
- `engram-graph-reconcile` — Reconcile the Neo4j Memory nodes with the SQL memory tables, which are the source of
  truth. Dry run by default; prints counts only.
  - `--apply --undo-log PATH` stamps `forgottenAt` on the nodes of forgotten or superseded rows and sets `projectId`
    and `memoryType` from SQL. `--delete-missing` and `--delete-orphans` (with `--apply`) also delete nodes with no
    SQL row and orphans of dead or absent rows; a delete is undone only from a Neo4j dump.
  - Context links: every run reports, per tier and split live/retired, the CONTEXTUAL edges from digest and
    semantic nodes to Person/Entity/Topic nodes that the memory's own text (digest summary; fact topic and content)
    does not name, plus the entities that would lose their last link from a live memory. `--apply` alone never
    deletes one; only `--apply --prune-context-links --undo-log PATH` does, and a run without the flag says the
    prune was not requested.
  - Every write appends its undo lines to the undo log before its batch runs. `--undo PATH` re-creates every pruned
    context link the log records, with all its properties, finding the context node by its label and `id` (an
    element id may be reused after a delete). A line whose memory or context node no longer exists is reported as
    `unmatched` and makes the run exit non-zero. Stamp, project and tier lines are undone by hand.

## Troubleshooting

**Q: Claude isn't using memory_recall automatically**

A: The server includes built-in instructions that guide Claude to use recall proactively. If it's not working, check that the MCP server is running and that Claude can see the tools (they should appear in the tools list).

**Q: No memories found on recall**

A: Memories are only retrieved after they're ingested and consolidated. Wait a moment for consolidation to run, then try again. Check that you're using the same session ID if you scoped to a specific session.

**Q: High token estimates**

A: Set `ENGRAM_RECALL_TOKEN_BUDGET` (or `ENGRAM_RECALL_EMIT_K`) on the server, or pass `token_budget` to `memory_recall` for one call. Memories are ranked by relevance and the payload keeps a prefix of that ranking, so the top results always survive. Or configure `AUTO_CONSOLIDATE=true` to create digests (summaries) that reduce token count.

**Q: "Missing required environment variable"**

A: Ensure `SUPABASE_URL` (any PostgREST endpoint), `SUPABASE_KEY` (service-role JWT), and `OPENAI_API_KEY` are set in your Claude config.

## Learn More

- **@engram-mem/core** — Core memory engine API
- **@engram-mem/graph** — Neo4j neural graph (Wave 2+)
- **@engram-mem/sqlite** — Local SQLite adapter

## License

Apache 2.0
