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

**Recall configuration** (checked once at startup, before the server serves; a bad value stops it, naming the variable):

- `ENGRAM_RECALL_LOG` — a file path: append one JSON line per recall (see "The log" under the recall route). Unset = off.
- `ENGRAM_RECALL_LOG_MAX_MB` — positive number, default 200: past it the log is renamed to `<file>.1` and a new one started.
- `ENGRAM_RECALL_ENGINE` — `true` wraps the old storage adapter in the RAM recall engine (used by the old engine only).
- `ENGRAM_TIMEZONE` — an IANA zone name such as `Asia/Karachi`, default `UTC`: the calendar day query expansion states as today.
- `ENGRAM_CHAT_MODEL`, `ENGRAM_CHAT_BASE_URL`, `ENGRAM_CHAT_API_KEY`, `ENGRAM_CHAT_PROVIDER_PREFS` (a JSON object) — the chat model every LLM step uses.
- `ENGRAM_RERANK_LOCAL`, `ENGRAM_RERANK_LOCAL_MODEL` — name the reranker (above).

Any other `ENGRAM_RECALL_*` key that is set, even to an empty value, stops startup with one message naming every such key: nothing reads it. That covers the old engine's output policy, ranking and cache keys (`ENGRAM_RECALL_TOKEN_BUDGET`, `_EMIT_K`, `_FAINT`, `_RELATED_SHARE`, `_ITEM_MAX_TOKENS`, `_FAN`, `_GRAPH_REINFORCE`, `_CORECALL`, `_WALK_EXCLUDE`, `_HUB_DAMPING`, `_SEMANTIC_CONFIDENCE`, `_FUSION`, `_PRIMING`, `_TIMING`, `_LLM_CACHE_MAX`, `_LLM_CACHE_TTL_MIN`): remove them from the server's environment before upgrading. Startup logs one line, with no secret in it:

```
[engram-mcp] recall: reranker=<id> floor=<F> strong=<S>
[engram-mcp] recall: reranker=<id> not calibrated; /recall and memory_recall refuse
```

Fact supersession in deep sleep (parsed once at server startup; a malformed value fails startup with an error naming the variable, and the resolved settings are logged once):

- `ENGRAM_SUPERSESSION` — `regex` (default), `llm` or `off`: how deep sleep retires a stored fact that a newer one replaces. `llm` asks the chat model whether nearby facts repeat or conflict with the new fact and whether each fact is a state, an event or a plan, orders a conflict by when each fact was stated, and retires only a current-state fact. See "Fact supersession in deep sleep" in the core README.
- `ENGRAM_SUPERSESSION_MIN_COSINE` — a number in [-1, 1], default `0.6`: the cosine floor for a stored fact to be compared with a new one.

**Optional (enables Neo4j neural graph):**
- `NEO4J_URI` — e.g., `bolt://localhost:7687`
- `NEO4J_USER` — default: `neo4j`
- `NEO4J_PASSWORD` — default: `engram-dev`

When `NEO4J_URI` is set and reachable, Engram runs in full "graph mode" with spreading activation recall. Otherwise, the server degrades gracefully to SQL-only mode.

### 3. Start Using

Claude Code now has access to Engram's memory tools. The server's instructions describe the typed items, how to read their trust and status, and to call memory_recall only for memory the session briefing did not cover.

### Project scoping

A project tag **ranks** memories; it never hides one. Tags come from the working directory at write time, so a memory written from a worktree, a sibling repo of the same product, or outside any repo would otherwise vanish exactly where it is needed. The scope is **declarative and per-call** — the server holds no project state of its own (important for a shared HTTP server, which has no project context):

- `memory_recall` and a `memory_ingest` observation accept an optional **`project_id`** parameter. The agent passes the current working project (typically the git repo name); omitting it means no project preference.
- A recall for project X returns every matching item. Within each relevance band, X's items come first, then items of X's workspace (from the project registry), then the rest; a project the registry does not know orders nothing. Scope never removes an item.
- Product groups (used by the old library recall) come from the JSON file named by `ENGRAM_PROJECT_GROUPS_FILE`: `{ "groups": { "aithentic": ["aithentic-*", "*-mfe"], "engram": ["engram*"] } }`. Patterns are project names or `*`/`?` globs, matched case-insensitively against the whole name; a project belongs to the first group that matches. Unset, missing or malformed means no groups; each distinct failure is reported once on stderr. The file is re-checked at most every 60 s and re-read when its modification time or existence changes, so an edit takes effect without a restart.
- Ingest with `project_id` tags the stored memory; without it the memory is shared.
- The git/hook ingest CLIs auto-detect the project from their working directory (see `ENGRAM_PROJECT_ID` above to override).
- Hard scoping (only X plus shared memories) exists as the `projectStrict` recall option of `@engram-mem/core`; neither the MCP server nor the CLIs enable it.

## MCP Tools

| Tool | What it does |
|---|---|
| `memory_recall` | Search the typed items; each result quoted verbatim with its provenance |
| `memory_get` | Stored items by id, as recorded |
| `memory_timeline` | The per-session records of past sessions, newest first |
| `memory_overview` | Counts of what the store holds |
| `memory_capture_status` | The capture path's health in numbers |
| `memory_ingest` | Store one typed item |
| `memory_forget` | Forget items or old rows by id, with a reason |
| `memory_retire`, `memory_unretire` | Retire or restore typed items by id, with a reason |

Every argument outside a tool's schema is an error; a value out of range is refused, never clamped.

### memory_recall

Runs the recall of `POST /recall` (below) in process on channel `mcp`, and writes the same log line.

**Input:** `query` (required, 1 to 2,000 characters), `project_id` (orders that project's items first; hides none), `exclude_session_id` (at most 256 characters; leaves that session's own items out), `include_history` (boolean), `classes` and `kinds` (non-empty lists), `limit` (1 to 30, default 12), `max_chars` (200 to 4,000, default 1,500), `budget_chars` (1,000 to 12,000, default 9,000), `as_of` (ISO 8601 with an offset). Superseded and retired items, session records, commits and assistant turns come only with `include_history`; `legacy` items only when `classes` names it.

**Returns:**

```
## Engram recall: <n> items for "<query, first 120 chars>"
Quoted verbatim. Tag: class · kind · speaker · trust · date · status. Trust 0 = MK's own words; 1 = a durable record; 2 = an assistant observation with evidence; 3 = an unverified assistant claim. Plan state is in the plan's LEDGER.md.
[> <degraded notice, one line per failed stage>]

### Matches
- [<class> · <kind> · <speaker> · trust <t> · <YYYY-MM-DD> · <status>] id <id>
  source: <type> <ref>[ · subject: <label>][ · superseded by <id>][ · flags: <f>, <f>]
  [Answering: <question>]
  <text, each line indented two spaces>
[### Associated
<same item form>]
[<k> more items passed the floor and were not shown: limit <a>, budget <b>, uncuttable <c>.]
```

With no item shown: `No memory item passed the relevance floor for this query.` (after any notice), or the "more items passed" line when items passed and none fit. The notices: `vector` → `> Semantic search failed (<reason>); results come from keyword and subject search only.`, `rerank` → `> Reranking failed (<reason>); items are in candidate order and no relevance floor was applied.`, `expansion` → `> Query expansion failed (<reason>).`, `hyde` → `> Hypothetical-document search failed (<reason>).`

Errors: `recall is not calibrated for reranker <id>` until a floor is measured for the reranker in use; `recall failed` for any other failure, the cause scrubbed on stderr only. The arguments of the first `memory_recall` answer with what replaces them: `session_id` → `exclude_session_id`, `token_budget` → `budget_chars`; `conversation_id` and `synthesize` were removed.

### memory_get

**Input:** `ids` (1 to 20 item ids), `max_chars` (200 to 8,000, default 4,000). Returns each stored item, in the order asked: the tag line, source and subject, scope (project, workspace, plan, session), occurred and stored times, retirement and its reason, standing and register status, restatements, lineage, content hash, embedding model and extraction run, the source record as JSON, the question, the length and how much is shown, then the text. Text is cut at a sentence boundary outside a quote; an MK statement, register entry or plan decision is never cut. Forgotten and unknown ids are listed under `Not found`; a value that is not a uuid is an error naming it.

### memory_timeline

**Input:** `project_id`, `from_date`, `to_date` (an ISO 8601 date, a whole UTC day, or a time with an offset; both inclusive), `query`, `limit` (1 to 50, default 20; 1 to 30 with `query`). Lists the current record of each past session, newest first:

```
- <YYYY-MM-DD HH:MM UTC> · <project or "no project"> · session <id> · item <id>
  <the session record, cut at a line boundary to 1,500 characters>
  [cut: memory_get <id> returns the whole record]
```

With `query`, recall over session records picks them; the project and dates still filter. The old argument `topic` answers that `query` replaced it.

### memory_overview

**Input:** `project_id`, `subjects` (1 to 50, default 20). Lists current items by class and kind; superseded, retired and pending-candidate counts; and the subjects with the most current items, each with the date of its newest item. The old arguments `topic` and `max_communities` answer with what replaces them.

### memory_capture_status

No input. Lists, as counts and UTC times only: events received in 24 h, unprocessed, dead (3 attempts) and the oldest unprocessed one's time, events with an error, the last processed time, items created in 24 h per class, extraction runs in 24 h per status and the last finished time, items the embedding pass covers still without an embedding per class, and the newest vault section's time. Never a payload, text or error message.

### Removed

`memory_bridges` and `memory_consolidation_status` answer `Error: unknown tool "<name>"`. `memory_forget` no longer takes `query`.

### memory_ingest

Store one typed item and get its id. The answer is JSON: `{"id": "<uuid>", "outcome": "stored" | "restated" | "duplicate"}`.

**An observation** is the agent's own claim with evidence:
```json
{
  "class": "observation",
  "kind": "finding",
  "subject": "storage engine",
  "content": "The item store runs on Postgres 17.",
  "evidence": [{ "type": "file", "ref": "packages/postgrest/schema.sql" }],
  "project_id": "my-repo",
  "session_id": "optional-session-id"
}
```
`kind` is `fact`, `procedure` or `finding`; evidence `type` is `item`, `commit`, `pr`, `file` or `url`. The claim is
trust 2 when every `item` ref names a stored item and every `commit` ref prefixes a captured commit's SHA, else trust 3.
A claim that puts a decision or wish in MK's or the user's mouth ("we decided", "MK wants") is refused.

**MK's words** are an exact quote of what MK wrote in an earlier turn of the session, as capture stored it:
```json
{
  "class": "mk_statement",
  "kind": "ruling",
  "subject": "storage engine",
  "quote": "Postgres only",
  "question": "keep SQLite as a fallback?",
  "standing": false,
  "session_id": "the-session-id"
}
```
`kind` is `ruling`, `fact` or `correction`. The quote is matched ignoring whitespace runs and curly quotes; `question`
must come from the assistant turn just before MK's words or from the dialog he answered. Both forms take `supersedes`
(item ids); a correction takes `corrects`. A `content` + `role` call is refused with a message naming these forms.

Its schema has no capture options. Hook and CLI captures go through the HTTP server's `POST /capture` route instead (below).

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

## Recall route (HTTP server)

`POST /recall` on `engram-mcp-http` runs one recall over the typed item store and returns current, attributed items. It sits behind the MCP bearer (`Authorization: Bearer $BEARER_TOKEN`); the capture and documents tokens get 401. Body at most 64 KiB.

**Request** (JSON object; any unknown key, at the top or in `scope`, is a 400; values out of range are a 400, never clamped):

| Field | Type | Notes |
|---|---|---|
| `query` | string, required | 1 to 2,000 characters after trimming |
| `channel` | string, required | `prompt`, `agent_dispatch`, `executor_start`, `hand_recall`, `session_start`, `mcp`, `replay` or `calibration` |
| `scope` | object, required (may be `{}`) | `project_id` (a repository id; `global`, `none` and `shared` mean none), `workspace_id`, `plan_slugs` (1 to 10 kebab-case slugs), `at_root` (with `project_id` it is a 400). Scope orders results and never removes one |
| `classes` | string list | Non-empty, known classes, no repeats. Default: every class but `legacy`, which comes only when named, and `session_index`, which needs history |
| `kinds` | string list | Non-empty; each a kind of a searched class |
| `exclude_session_id` | string | 1 to 256 characters; that session's items, and items built from them, are left out |
| `as_of` | string | ISO 8601 with an offset, at most 5 minutes ahead of the server clock |
| `limit` | integer | 1 to 30, default 12 |
| `max_chars` | integer | 200 to 4,000, default 1,500: characters per item text |
| `budget_chars` | integer | 1,000 to 12,000, default 9,000: text plus question characters across all items |
| `include_history` | boolean | Default `false`; needed for commits, PRs, assistant turns, ledger work logs and session indexes, and to see retired and replaced items |

The `prompt` channel shows only observations whose every evidence pointer was verified (trust 2).

**Response 200:**

```json
{ "items": [ { "id": "…", "class": "mk_statement", "kind": "ruling", "speaker": "mk", "trust": 0,
               "occurred_at": "…", "project_id": "engram", "session_id": "…", "subject": "…",
               "text": "…", "question": "…", "source": { "type": "transcript", "ref": "…" },
               "status": "current", "flags": [], "via": "query" } ],
  "omitted": { "limit": 0, "budget": 0, "uncuttable": 0 },
  "degraded": { "rerank": "…" } }
```

- Items are current by construction: a matched item a later live item replaced gives its place to that item (flagged `supersedes:<id>`), and the replaced one follows it only with `include_history`. Absent optional fields are left out, never null.
- `text` is verbatim. Over `max_chars` it is cut at the last sentence boundary outside a quote and flagged `cut`; an MK statement, register entry or plan decision is never cut: it shows whole or is counted in `omitted.uncuttable`. A question keeps its last 600 characters.
- `via: "association"` marks an item linked to one of the first three shown (same subject, a shared entity, lineage), reranked and kept above the floor like any other; associations take at most 30% of the budget.
- `omitted` counts the items that passed the floor and were not shown: past the limit, past the budget, or uncuttable.
- Flags: `as_of:<date>`, `verify_live`, `contradicted_by:<register id>`, `restated:<n>`, `cut`, `source_truncated`, `successor_retired`, `legacy_superseded`, `supersedes:<id>`.
- `degraded` names a stage that failed and was skipped (`vector`, `rerank`, `expansion`, `hyde`).

**Other statuses:** 400 `{"error"}` (invalid JSON, a rule broken; the message names it); 401; 405 (not POST); 413; 500 `{"error":"recall failed"}` with the cause, scrubbed, on stderr only; 503 `{"error":"recall is not calibrated for reranker <id>"}`.

**The floor.** Rerank scores are on each model's own scale, so recall keeps an item only above a floor measured for the reranker in use (`onnx:<model>:q8` with `ENGRAM_RERANK_LOCAL=true`, else `openai:<chat model>`). Until a measured entry for that id is in the floor table (`packages/core/src/recall/floor-calibration.ts`), every call answers 503. `engram-recall-calibrate` measures it.

**The log.** With `ENGRAM_RECALL_LOG` set, each call appends one JSON line (`v: 2`) through the recall log's queue, rotation and secret scrub: `ts`, `channel`, `request_fp`, `query`, `scope`, the effective `classes` and `kinds`, `include_history`, `as_of`, `exclude_session` (a boolean; the session id is never written), `limit`, `max_chars`, `budget_chars`, `reference_date`, `server`, `reranker`, `floor`, `strong`, `store_version` (before and after), `items` (`id`, `rank`, `via`, `status`, `chars`), `total_chars`, `omitted`, `degraded` (keys), `steps` (`expansion`, `hyde`, `rescue`), `project_known`, `timings` and `output_fp`. `request_fp` is the sha256 of the request with sorted keys and defaults applied (the excluded session only as its hash), the reference date, server version, reranker and floor; `output_fp` the sha256 of the shown `(id, text, question, status, flags)`.

**`engram-recall-invariants --log <file> [--log <file>]...`** counts, over the v2 lines, what a recall must never do: `forgotten_or_retired_shown` (an item shown after it was forgotten, or retired when the call did not ask for history; read now through the item states), `over_budget` (`total_chars` above `budget_chars`) and `nondeterministic_pairs` (one request on one unchanged store, with no degraded stage, giving more than one output). It prints JSON with each count and up to 10 `file:line` places, no query text, writes nothing, and exits 1 when any count is above 0. Needs `SUPABASE_URL` and `SUPABASE_KEY`.

**`engram-recall-calibrate`** measures the floor on a database copy on this machine (it refuses a `SUPABASE_URL` whose host is not `127.0.0.1` or `localhost`):

```
engram-recall-calibrate --replay cases.jsonl --channels profile.json \
  [--calibration-before 2026-09-29T19:00:00Z] [--split calibration|check|all] \
  [--gold gold.jsonl] --report report.json
```

It scores each request as recall would, with no floor: reviewed cases on a query-lane channel, each on its own channel with the profile's fields, its scope and its decision time; gold rows on the `calibration` channel with `legacy` added to the classes. A slate item is needed when the case names its id or legacy id, or holds every phrase of one of its phrase groups; a gold row's stale ids count as neither needed nor noise. Then: n = the needed items that reached a slate; F = the largest value on the 0.005 grid at which at most max(1, ⌊0.01·n⌋) needed items score below it; S = the median needed score rounded down to the grid, or F when lower. It prints n, F, S and a ready floor entry, and the report holds ids and scores only, never text.

## Candidates route (HTTP server)

`POST /candidates` lists what waits for MK's review at session start. It sits behind the MCP bearer; the capture and documents tokens get 401. Body at most 4 KiB.

```
{ "scope": { "project_id": "engram", "workspace_id": "…" },   required, may be {}; both keys optional
  "ids": [ "<uuid>", … ],                                       optional; 1 to 8 distinct uuids
  "limit": 4 }                                                  optional; 1 to 8, default 4
```

Without `ids`: current standing MK statements waiting for the register, current corrections not yet recorded or dismissed with a target neither retired nor forgotten, and current assistant turns that retract a target neither retired nor forgotten; newest first, in scope (the item's project or workspace equals the request's, or it has neither). With `ids`: exactly those items, in the order given, whatever their review state; scope and limit do not apply, and every requested id with no such item is listed in `missing`.

```
200 { "candidates": [ { "id", "kind": "ruling" | "fact" | "correction" | "retraction", "quote", "question",
                        "occurred_at", "session_id", "project_id", "workspace_id", "subject", "proposed_scope",
                        "status", "register_status", "restated_count",
                        "targets": [ { "id", "class", "text", "status" } ] } ],
      "total", "missing": [ "<uuid>", … ] }
```

A statement's `quote` is whole; a retraction's text and each target's text are cut at a sentence boundary to 1,500 characters; `question` keeps its tail. `proposed_scope` is `global`, `project:<id>`, `workspace:<id>` or `plan:<slug>` from the level extraction stored, or null. `status` is `current`, `superseded` or `retired`. `total` counts every pending item in scope before `limit`; with `ids`, the items returned.

Other statuses: 400 `{"error"}` (an unknown key, a wrong type, a value out of range, an empty, over-long, malformed or repeated `ids`); 401; 405 (not POST); 413; 500 `{"error":"candidates failed"}`, the cause scrubbed on stderr only.

## Capture clients (hooks and ingest CLIs)

`engram-ingest` (git post-commit, the Stop and UserPromptSubmit hooks), `engram-session-summary` (SessionEnd) and the pre-compact hook run in one of two modes.

**Server mode** — `ENGRAM_SERVER_URL` is set. The client resolves the content, scrubs secrets and detects the project, then posts one request to `POST /capture`. The server runs the classifier, the digest (session summary, pre-compact) and the store with its own model configuration, so the laptop needs no `SUPABASE_*`, `OPENAI_API_KEY` or `NEO4J_*`.

- `ENGRAM_SERVER_URL` — the server's MCP endpoint, e.g. `http://host:3850/mcp`, shared with the MCP client config. A trailing `/mcp` (or `/capture`) path segment is replaced by `/capture`; any other URL gets `/capture` appended.
- `ENGRAM_SERVER_TOKEN_FILE` — file holding the bearer token (trimmed; `~/` expands). Wins over `ENGRAM_SERVER_TOKEN`, the token inline. One of the two is required.
- Request timeouts: 60 s for a turn, 180 s for a derive capture. The server keeps working after a client gives up and the key has no unique constraint, so a shorter timeout followed by a retry could store twice. The one exception is pre-compact, which uses 25 s because its hook blocks compaction until it returns: on a timeout it spools the capture, and the pre-compact dedup (cosine 0.62 over 30 days) absorbs a digest re-sent while the first request was still running.
- A capture carries a `key` only when it also carries a `session_id`, so a rerun of the same hook on the same input returns `replayed`. Without a session id (ad-hoc `engram-ingest`, a hook input with no `session_id`) the client sends neither, and the server's dedup check is the only repeat guard.
- Each capture's `meta.cwd` records the working directory, so a later backfill can recover the project of a capture made outside a repository. A cwd longer than the 512-character meta limit is left out (one warn line) rather than cut, because a cut path could match a shorter project root by prefix; the capture is still sent with the project resolved from the full path.
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

Takes `ids` and a `reason`, both required. A call that passes `query` is the tool error `query was removed: forget takes explicit ids and a reason. Find ids with memory_recall (include_history: true; add "legacy" to classes for old rows).` and forgets nothing.

Forget the ids you approved, with a reason (1 to 2,000 characters, at most 50 ids per call). An id may name a typed item or a row of the old memory tables:

```json
{ "ids": ["3f2c…"], "reason": "the v1 endpoint notes were imported from the wrong project" }
```

A forget cascades, in one transaction:
- an item takes every item whose lineage holds it (an utterance its statements and session index);
- an episode takes the digests built from it and the facts and procedures citing it; a digest takes the facts, procedures and digests built from it. A digest is one text, so it goes when any of its episodes goes;
- an old row and its `legacy` item take each other.

The reply lists the requested ids, each cascaded id with the id that pulled it in (`via`), the items restored or re-pointed because their successor was forgotten, and the ids not found. A requested id that was already forgotten is listed again. Forgotten old rows are also stamped in Neo4j when it is configured; a graph failure never fails the forget. Every call that finds something writes one `memory_item_actions` row: the ids, what happened to each, the reason and the channel.

A forgotten memory is hidden from every recall path. The row stays in storage as a tombstone.

### memory_retire and memory_unretire

Retire typed items that are no longer current but were true when stored; unretire returns them. Both take `{ "ids": [...], "reason": "..." }` (1 to 50 ids, a reason of 1 to 2,000 characters) and act on items only:

- an id of the old memory tables is answered `not an item: forget it, or retire its legacy item`;
- retiring a statement MK recorded in a register adds `recorded as <register_ref>: change it there too`.

Unretire clears the retire reason; its own reason is kept in the audit row.

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
- `engram-session-projects` — Map Claude Code sessions to projects from their transcripts (`~/.claude/projects/*/*.jsonl`): each session's first recorded cwd resolved as a live capture resolves it (git repository, then a root from `ENGRAM_PROJECT_GROUPS_FILE`, else shared). `--transcripts DIR`, `--since ISO`. Prints `{ "<session id>": { cwd, project, source }, "errors": [...] }` for `engram-project-backfill --sessions`
- `engram-project-backfill` — Set `project_id` on stored memories, one mode per run: the ingest-time `metadata.project` tag (default); `--sessions FILE` and/or `--roots FILE` for untagged episodes (their session's project, else the longest configured root containing `metadata.cwd`; cross-cutting categories stay shared); `--retag FROM=TO` (repeatable) renames a project on episodes, digests, semantic facts and procedures; `--fold-worktrees` prints the worktree → repository pairs it proposes, with per-table counts, and applies nothing. Dry-run by default (counts per source, project and table, never content); `--apply` records each batch in a new rollback CSV (`table,id,old,new`) before writing it, and `--rollback FILE [--apply]` restores it
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

A: By design. Memory reaches a Claude Code session through hooks (standing rulings and a briefing on each prompt); the server's instructions say to call memory_recall only for memory the briefing did not cover, from a subagent where possible.

**Q: No memories found on recall**

A: Recall shows only items whose rerank score passes the floor measured for the reranker in use; without a measured floor it refuses with `recall is not calibrated for reranker <id>`. Captured turns become items once the capture worker has processed them (see memory_capture_status), and superseded, retired and history-only items need `include_history`.

**Q: High token estimates**

A: Pass a smaller `budget_chars`, `max_chars` or `limit` to `memory_recall`. Items are shown in rank order; the text never exceeds `budget_chars`, and the result says how many items passed and were not shown.

**Q: "Missing required environment variable"**

A: Ensure `SUPABASE_URL` (any PostgREST endpoint), `SUPABASE_KEY` (service-role JWT), and `OPENAI_API_KEY` are set in your Claude config.

## Learn More

- **@engram-mem/core** — Core memory engine API
- **@engram-mem/graph** — Neo4j neural graph (Wave 2+)
- **@engram-mem/sqlite** — Local SQLite adapter

## License

Apache 2.0
