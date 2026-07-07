# @engram-mem/bench

Benchmark harness for evaluating Engram retrieval quality on conversational QA and long-context datasets. Measures recall, F1, and answer quality.

## Installation

```bash
npm install -g @engram-mem/bench
```

Or run locally:

```bash
npx @engram-mem/bench --help
```

## Supported Benchmarks

- **LoCoMo** — Conversational QA across multi-turn dialogs with people, topics, and temporal reasoning
- **LongMemEval** — Long-context document retrieval with relevance judgments

## Quick Start

### LoCoMo Benchmark

```bash
engram-bench --benchmark locomo --data ./data/locomo/
```

This ingests conversations, evaluates retrieval recall, and outputs a results table.

### LongMemEval Benchmark

```bash
engram-bench --benchmark longmemeval --data ./data/longmemeval/
```

### A/B Comparison (With/Without Graph)

```bash
engram-bench --benchmark locomo --compare --data ./data/locomo/
```

Runs Engram twice: once with Neo4j graph layer, once SQL-only. Shows improvement from spreading activation.

## CLI Flags

```bash
engram-bench [OPTIONS]

OPTIONS:
  --benchmark <TYPE>     Required. locomo or longmemeval
  --data <PATH>         Required. Directory or JSON file with test data
  --output <DIR>        Where to write results (default: ./results)
  --limit <N>           Cap conversations to N (for quick tests)
  --top-k <N>           Candidates per query (default: 10)
  --consolidate         Run consolidation cycles (default: true)
  --no-consolidate      Skip consolidation
  --graph               Enable Neo4j graph layer (default: true)
  --no-graph            SQL-only mode
  --no-rerank           Disable cross-encoder reranking (A/B testing)
  --compare             Run both modes and compare
  --vector-mode <MODE>  full (default, adapter's own SQL vector scan) or
                        engine (RAM-resident quantized RecallEngine — see
                        "Quantized recall-engine gates" below)
  --verbose             Verbose logging
```

## Example Runs

### Quick Test (First 5 Conversations)

```bash
engram-bench \
  --benchmark locomo \
  --data ./data/locomo/ \
  --limit 5 \
  --output ./results/quick-test
```

### Full Benchmark with Graph

```bash
engram-bench \
  --benchmark locomo \
  --data ./data/locomo/ \
  --consolidate \
  --graph \
  --output ./results/full-run
```

### SQL-Only vs Graph Comparison

```bash
engram-bench \
  --benchmark locomo \
  --data ./data/locomo/ \
  --compare \
  --output ./results/comparison
```

Output shows side-by-side metrics for SQL-only and graph modes.

## Results Format

### LoCoMo Output

```
Benchmark:     locomo
Data:          ./data/locomo/
Graph layer:   ON (Neo4j)
Consolidation: ON

LOCOMO v0.3.6+ — Retrieval Recall @ K (10 conversations, 1,986 QAs)

Overall:       85% (corrected baseline post-v0.3.6)

(Per-category breakdown deferred — LoCoMo is the legacy benchmark.
 LongMemEval-S is now the primary target; see below.)

Results written to: ./results/locomo-results.json
Eval format:       ./results/locomo-eval.json
```

Files generated:
- `locomo-results.json` — Full results object (all QAs, predictions, scores)
- `locomo-eval.json` — Eval format for downstream judges (GPT-4o evaluation)

### LongMemEval Output

```
Benchmark:     longmemeval
Data:          ./data/longmemeval/
Graph layer:   ON (Neo4j)

LONGMEMEVAL-S v0.3.15 — Single-session Retrieval (500 QAs)

R@5:           98.8%
R@10:          99.6%

(Beats published Zep/Graphiti baseline of 63.8% on the same benchmark
 by ~35pp. Single miss across 500 questions was a visual-content query;
 all non-visual categories at 100%.)

Results written to: ./results/longmemeval-results.json
JSONL for GPT-4o:  ./results/longmemeval-predictions.jsonl
```

Files generated:
- `longmemeval-results.json` — Full results object
- `longmemeval-predictions.jsonl` — JSONL format for LLM-as-judge evaluation

## Metrics

### LoCoMo

- **Recall @ K** — Did the gold answer appear in top-K retrieved memories?
- **Retrieval F1** — Fuzzy matching score between prediction and gold answer
- **Category breakdown** — Performance by question type (single-hop, multi-hop, temporal, commonsense, adversarial)

### LongMemEval

- **MRR** — Mean Reciprocal Rank of the first relevant document
- **NDCG@10** — Normalized Discounted Cumulative Gain at 10

## Getting Benchmark Data

### LoCoMo

Download from the official repository:

```bash
git clone https://github.com/localcontextualconversationmodel/locomo.git
cd locomo/data
# Extract conversation JSON files
```

Or use the included test data:

```bash
cd packages/bench
npm run download-locomo-test-data
```

### LongMemEval

Download from the LongMemEval repository:

```bash
git clone https://github.com/longlongmemeval/longmemeval.git
cd longmemeval
# Extract retrieval eval set
```

## Environment Variables

For full benchmark runs, ensure:

```bash
export OPENAI_API_KEY="sk-..."
export SUPABASE_URL="https://..."          # any PostgREST endpoint (Supabase or self-hosted)
export SUPABASE_KEY="<service-role JWT>"   # not the anon key — needs RLS bypass
export NEO4J_URI="bolt://localhost:7687"   # optional, for graph mode
```

Or use a `.env` file with the same keys.

## Current Benchmark Results

### LongMemEval-S (v0.3.15+, May 2026) — primary target

500-question single-session retrieval benchmark.

| Metric | Engram v0.3.15+ | Published Zep/Graphiti |
|---|---|---|
| **R@5** (gold evidence in top-5) | **98.8%** | 63.8% |
| R@10 | 99.6% | — |

Beats the published SOTA by ~35pp on R@K. The single miss across 500 questions was a visual-content query; all non-visual categories at 100%. Full sweep took ~3.2 hours and cost ~$10.

### LoCoMo (legacy benchmark)

Engram hits **85% R@K** overall on the full 10-conversation set (1,986 QAs) after the v0.3.6 correction. Per-category numbers omitted — LoCoMo's compressed-fact recall shape isn't a great match for Engram's design thesis, and the leaderboard is publicly disputed (Zep 84% vs Mem0 rebut 58% vs Zep counter 75%). LongMemEval-S is the more meaningful target.

**Methodology notes:**
- Cross-encoder reranking (LLM-pointwise via OpenAI, or local mxbai-rerank via `@engram-mem/rerank-onnx` with `ENGRAM_RERANK_LOCAL=true`).
- Graph mode adds ~5-8% on multi-hop on LoCoMo; on LongMemEval-S the ceiling is already at 99%.
- Consolidation enabled (light + deep sleep cycles).
- Contextual ingest (Anthropic-style preamble per turn) is opt-in via `ENGRAM_INGEST_CONTEXTUAL=true`.

## Quantized recall-engine gates (`--vector-mode`)

`@engram-mem/recall-engine` is an opt-in, RAM-resident quantized candidate-generation layer that sits in front of the existing SQL/SQLite vector scan. In production it's a no-op unless `ENGRAM_RECALL_ENGINE` is explicitly set; in the bench harness the equivalent switch is `--vector-mode engine` (default remains `--vector-mode full`, the adapter's own SQL scan). The engine narrows candidates through a tier-1 exhaustive sign-code Hamming scan and a tier-2 unbiased `TurboQuant_prod` rescore, then hydrates and re-scores tier-3 against real float embeddings before anything is returned to the caller. Because tier-3 rescore is exact, `full` and `engine` can only ever disagree on which rows get *selected* into the candidate pool before hydration — every similarity score either mode returns is a true float cosine. That's why the gates below measure recall@K (did selection change), not score accuracy (which is structurally guaranteed by tier-3).

These are **operator-run gates, not CI** — each run costs real embedding/LLM spend and, for Gate 1, hours of wall time, so they're triggered deliberately, not on every push.

### Gate 1 (primary) — LongMemEval-S full-500, paired

Run the full 500-question sweep twice on the identical corpus file, once per `--vector-mode`:

```bash
npx tsx packages/bench/src/longmemeval/forensics/recall-sweep.ts \
  --data ./data/longmemeval/longmemeval_s_cleaned.json \
  --vector-mode full \
  --output ./results/longmemeval/full-500-vfull.json

npx tsx packages/bench/src/longmemeval/forensics/recall-sweep.ts \
  --data ./data/longmemeval/longmemeval_s_cleaned.json \
  --vector-mode engine \
  --output ./results/longmemeval/full-500-vengine.json
```

Both cells read the same `--data` file and process all 500 questions in dataset order (fresh memory per question — see the sweep's own docstring) — there's no sampling here, so unlike the containment CLI below there's no `--seed` to hold fixed.

**Pass criteria (both required):**
- **McNemar non-significant** — pair each question's recall@5 hit/miss between the two runs' `rows[]` arrays (matched by `question_id`) and test the discordant pairs (full-hit/engine-miss vs. full-miss/engine-hit). Nothing in this repo computes the statistic automatically — run it externally (e.g. `scipy.stats.mcnemar`, or an exact/mid-p test on the 2×2 discordant table) against the two output JSONs.
- **ΔR@5 ≥ −0.4pp vs. the committed baseline** — `results/longmemeval/baseline-full-500.json` records R@5 = 0.988 (494/500, generated 2026-05-24). The `engine` cell's `recall_at_K["5"].rate` must be ≥ 0.984.

`data/` is gitignored — re-fetch the dataset before running either cell; see "Getting Benchmark Data" → LongMemEval above.

**Result (2026-07-07): PASS.** Committed as `results/longmemeval/full-500-vfull.json` and `results/longmemeval/full-500-vengine.json` (identical config to the baseline run: maxResults=30, consolidation on, OpenAI rerank, no graph).

| Metric | `full` | `engine` |
|---|---|---|
| R@5 | 0.990 (495/500) | 0.988 (494/500) |
| R@10 | 0.996 (498/500) | 0.996 (498/500) |
| R@30 | 0.996 (498/500) | 0.996 (498/500) |

- **McNemar**: 1 discordant pair at K=5 (b=1 full-hit/engine-miss, c=0), exact two-sided p = 1.0; **zero** discordant pairs at K=10 and K=30 — the two modes' hit/miss patterns are literally identical past K=5.
- **Floor**: engine R@5 = 0.988 ≥ 0.984 (and equals the committed baseline exactly).
- The single discordant question (`60bf93ed_abs`, multi-session) is rank jitter, not a retrieval loss: both modes retrieve both gold sessions; they sit at session-ranks 3 and 5 in `full` vs 5 and 6 in `engine`, so the first gold crosses the K=5 boundary and is recovered by K=10.
- The `full` cell doubles as the corrected-path baseline regeneration called for under "Standing rule" below: 0.990 vs the pre-fix 0.988, so the committed floor remains valid (and slightly conservative).

### Gate 2 — LoCoMo all-10, categories 2–3, paired

Not yet run (operator call — LongMemEval-S is the primary target; run this before any default-flip decision, alongside the multi-hop harness described under "Standing rule"). Same paired methodology, on the full 10-conversation set:

```bash
npx tsx packages/bench/src/locomo/forensics/local-recall-sweep.ts \
  --data ./data/locomo/data/locomo10.json \
  --vector-mode full \
  --output ./results/forensics/locomo-all10-vfull.json

npx tsx packages/bench/src/locomo/forensics/local-recall-sweep.ts \
  --data ./data/locomo/data/locomo10.json \
  --vector-mode engine \
  --output ./results/forensics/locomo-all10-vengine.json
```

Restrict the comparison to `by_category["multi_hop"]` (category 2) and `by_category["temporal"]` (category 3) in each output's R@10 and R@30 rates — the categories most exercised by multi-hop retrieval and most sensitive to a candidate-selection regression. There is no committed numeric floor for LoCoMo categories 2–3 yet (the LoCoMo results above omit per-category numbers entirely), so Gate 2's bar is the paired comparison itself: McNemar non-significant on the per-question `recallAtK[10]`/`recallAtK[30]` booleans (rows restricted to category ∈ {2, 3}) between the two cells, with no visible drop in either category's R@10 or R@30.

`data/locomo/` is gitignored the same way — see "Getting Benchmark Data" → LoCoMo above.

### G-containment diagnostic (evidence, not a gate)

`packages/bench/src/forensics/quant-containment.ts` isolates just the quantized-ANN layer (tier-1 Hamming scan + tier-2 `TurboQuant_prod` rescore) against the real production corpus and real embeddings — no curated eval questions, no end-to-end recall@K. It samples leave-one-out queries from the live corpus, computes an exhaustive float-cosine ranking as ground truth, and measures what fraction of that ranking the quantized candidate pool actually contains at each depth. It is read-only against prod — `storage.initialize()`, `scanEmbeddings()`, and count-only `head: true` selects are the only calls made; nothing in the file inserts, updates, upserts, or deletes — and it talks to `PostgRestStorageAdapter`/`CodeStore` directly rather than through `RecallEngine`, so it never triggers the engine's opportunistic snapshot write.

Run against prod with:

```bash
export SUPABASE_URL=...
export SUPABASE_KEY=...   # service-role JWT, not anon
npx tsx packages/bench/src/forensics/quant-containment.ts \
  --queries 200 --tier1-m 960 --tier2-e 480 --exact-k 120 --seed 42 --bits 4 --dims 1536
```

(These are all the CLI's own defaults — pass them explicitly for a reproducible record, or omit entirely for the same result.)

**Current real-prod results** — `results/gates/quant-containment-2026-07-07.json` (pre-backfill: 6,159 embedded rows, episodes-dominated) and `results/gates/quant-containment-2026-07-07-postbackfill.json` (after the NULL-embedding backfill + semantic exact-content dedup: ~10.6k embedded live rows across all four tiers — same result). Committed gate baselines; the CLI writes to `results/quant/` relative to its working directory — move keeper runs into `results/gates/`. (200 queries, corpus of 6,159 embedded rows across all four tiers): containment@10 and @30 are both 1.000 (mean, p10, min, max) for tier-1 and tier-2 alike; containment@exact120 (the engine's own default candidate-pool sizing) is mean 1.000, min 0.992. In plain terms: over this corpus snapshot, the quantized candidate pool the engine actually forms contains essentially everything an exhaustive float scan would have surfaced, at every depth tested.

**Signal-profile caveat:** this diagnostic only describes rows that HAVE an embedding. In the same run, `overallShareWithEmbedding` was 11.2% — the `episode` tier is well covered (99.8% embedded), but `digest` is at 3.2% and `semantic` is at **0%** (48,494/48,494 semantic rows skipped, embedding IS NULL). Those rows are written with `embedding: null` by consolidation until the NULL-embedding backfill CLI processes them, and are invisible to vector search in *either* `--vector-mode` until then — the containment numbers above characterize the ANN layer's fidelity, not the corpus's overall current retrievability.

### Standing rule: opt-in until the multi-hop harness exists

Both gates are meant to compare against **fixed baselines captured after the vector-path-correctness fixes** (exhaustive SQL scan-cap removal, HNSW-drivable per-tier ordering, pgvector text round-trip parsing) are in place — not before, because those fixes changed what `full` mode itself returns, independent of `engine` mode. The currently-committed `results/longmemeval/baseline-full-500.json` (0.988, generated 2026-05-24) predates those fixes; the 2026-07-07 Gate 1 `full` cell re-measured the corrected path at 0.990 (`results/longmemeval/full-500-vfull.json`), confirming 0.988 as a valid — slightly conservative — floor.

Passing Gates 1 and 2 is necessary but **not sufficient** to flip the default. Recall@K on curated single-hop/multi-hop QA benchmarks doesn't exercise the multi-hop bridge-recall path a production agent actually walks (iterative retrieval across hops, re-querying on intermediate results). That harness — a HotpotQA/A3 bridge-recall@K gate — does not exist yet. Until it does, `--vector-mode engine` / `ENGRAM_RECALL_ENGINE` ships **opt-in only**; Gates 1–2 alone never flip the default.

The two invariants from `packages/recall-engine/README.md` hold regardless of gate outcome and are not up for renegotiation by a good gate result:
- Full-precision embeddings in the database are the source of truth and are never dropped or replaced by quantized codes — codes are a disposable, rebuildable cache.
- With exact rescore ON (the default, and the only mode the MCP server allows), no quantized score ever leaves the engine — every similarity returned is true float cosine.

### Cost note

Gate 1 pairs two full-500 sweeps (`full` + `engine`) — recall-only, no judge calls. The existing single-mode LongMemEval-S baseline run (see "Current Benchmark Results" above) took ~3.2h and cost ~$10; a paired Gate 1 run is ~2×(ingest+embed) of that, so budget roughly ~$20 / ~6.5h total.

Gate 2 pairs two all-10 LoCoMo sweeps. Per `local-recall-sweep.ts`'s own cost accounting, a single conversation runs ~$0.03 (no consolidation) to ~$0.10 (with consolidation + HyDE) — all 10 convos single-mode is therefore ~$0.30–$1.00; paired (`full` + `engine`) roughly doubles that, so budget ~$1–2 total, judge-free.

## Troubleshooting

**Q: "Unknown benchmark" error**

A: Use `--benchmark locomo` or `--benchmark longmemeval` (exact spelling).

**Q: Out of memory on large datasets**

A: Use `--limit N` to cap conversations. Start small:
```bash
engram-bench --benchmark locomo --data ./data/ --limit 10
```

**Q: "NEO4J connection refused" on --compare**

A: Ensure Neo4j is running: `docker ps | grep neo4j`

**Q: Results showing 0% recall**

A: Check that consolidation ran (`--consolidate` is default). If first-run, memories need to be consolidated to semantic before recall finds them.

**Q: How do I use these results with GPT-4o judge?**

A: The `eval.json` and `predictions.jsonl` files are formatted for LLM evaluation:
```bash
# Use gpt-4o to judge quality
python scripts/judge.py ./results/locomo-eval.json
```

## Architecture

The benchmark harness:

1. **Loads** conversations from LoCoMo/LongMemEval format
2. **Ingests** turns into Engram memory (with consolidation)
3. **Queries** for each QA pair
4. **Evaluates** retrieval (F1, Recall@K, MRR, NDCG)
5. **Outputs** structured results and eval formats

Each benchmark adapter handles dataset-specific format conversions.

## Contributing

To add a new benchmark:

1. Create `src/<benchmark-name>/adapter.ts` extending `BenchmarkAdapter`
2. Implement `run(dataPath, opts)` to ingest and evaluate
3. Add CLI support in `bin/engram-bench.ts`

## License

Apache 2.0
