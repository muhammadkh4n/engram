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
