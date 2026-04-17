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

LOCOMO v0.3.0 — Retrieval Recall @ K (10 conversations, 1,986 QAs)

Category Breakdown:
  Single-hop:    45.4%
  Multi-hop:     57.6%
  Temporal:      30.2%
  Commonsense:   59.6%
  Adversarial:   67.0%

Overall:       57.5%

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

LONGMEMEVAL v0.3.0 — Document Retrieval

Retrieval Metrics:
  MRR:           0.67
  NDCG@10:       0.73

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
export SUPABASE_URL="https://..."
export SUPABASE_KEY="..."
export NEO4J_URI="bolt://localhost:7687"  # Optional, for graph mode
```

Or use `.env` file:

```
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://...
SUPABASE_KEY=...
NEO4J_URI=bolt://localhost:7687
```

## Benchmark Results (v0.3.0)

### LoCoMo — full 10 conversations (1,986 QAs)

| Category | Recall @ K |
|----------|-----------|
| **Overall** | **57.5%** |
| Single-hop | 45.4% |
| Multi-hop | 57.6% |
| Temporal | 30.2% |
| Commonsense | 59.6% |
| Adversarial | 67.0% |

**Per-conversation range:** 47.7% (conv-42) to 69.5% (conv-30).

**Notes:**
- Baseline (pre-v0.3.0 retrieval overhaul): 19.6% R@K on conv-26.
- SQL-only baseline. Graph mode adds ~5-8% on multi-hop questions.
- Consolidation enabled (light + deep sleep cycles).
- Top-10 retrieval per question with cross-encoder reranking.
- Temporal queries are the current weak spot and top priority for v0.3.3+.

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
