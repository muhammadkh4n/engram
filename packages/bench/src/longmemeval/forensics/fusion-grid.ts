#!/usr/bin/env node
/**
 * LongMemEval fusion grid: recall every question under several fusion
 * configs while ingesting each question once.
 *
 * Per question: one fresh store, one ingest, then one recall per grid cell
 * with `{ strategyOverride: { fusion }, reconsolidate: false }`. Expansion,
 * HyDE, embeddings and rerank scores are memoised per question, and the
 * sensory buffer is reset before each cell, so cells differ only by their
 * weights (see fusion-grid-lib.ts).
 *
 * Required env: OPENAI_API_KEY. ENGRAM_RECALL_FUSION must be unset: per-call
 * keys merge over it, so the `default` cell would not be the shipped defaults.
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/fusion-grid.ts \
 *     --data ./data/longmemeval/longmemeval_s_cleaned.json \
 *     --question-ids ids.json \
 *     --grid grid.json            # JSON array of { name, fusion }; must hold { "name": "default", "fusion": {} }
 *     --context-mode formatted \
 *     [--reranker openai|onnx|none] [--onnx-model <hf id>] \
 *     [--embed-backend openai|onnx] [--embed-model <id>] [--embed-dims N] \
 *     [--no-graph] \
 *     --output-dir ./results/longmemeval/grid-1 \
 *     [--resume]                  # continue from every cell's <name>.json.partial.jsonl
 *
 * Writes `<output-dir>/<name>.json` per cell with recall-sweep's formatted
 * row schema; `meta` adds the cell's fusion, the grid file's sha256 and
 * `shared_ingest: true`. The embed flags mean what they mean to recall-sweep,
 * and the embedder's backend, model and width are recorded in the run identity
 * and `meta` the same way, so a resume under other embed settings is refused.
 */
import * as fs from 'node:fs'
import { LongMemEvalAdapter } from '../adapter.js'
import { createBenchMemory, resolveEmbedDims } from '../../memory-factory.js'
import { sensoryResetter } from '../../sensory-reset.js'
import { FUSION_ENV_VAR, recallOutputPolicyFromEnv } from '@engram-mem/core'
import { buildModelMeta, resolveEmbedSettings } from './reranker-meta-lib.js'
import type { BenchmarkOpts, RerankerBackend } from '../../types.js'
import {
  idListSha256,
  orderRowsByDataset,
  outputPolicyRecord,
  parseQuestionIdList,
  pendingQuestions,
  selectQuestions,
} from './sweep-checkpoint-lib.js'
import {
  K_VALUES,
  aggregateRecall,
  appendCheckpointRow,
  gridIdentity,
  gridRunIdentity,
  memoizeIntelligence,
  openGridCheckpoints,
  parseGrid,
  parseGridArgs,
  recallCells,
  sha256Hex,
  type GridRow,
} from './fusion-grid-lib.js'

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = exitOnError(() => parseGridArgs(process.argv.slice(2)))
  validateEnv()

  const gridText = exitOnError(() => fs.readFileSync(args.grid, 'utf8'))
  const cells = exitOnError(() => parseGrid(gridText))
  const gridSha = sha256Hex(gridText)

  const adapter = new LongMemEvalAdapter()
  const allQs = await adapter.loadDataset(args.data)
  const ids = exitOnError(() => parseQuestionIdList(fs.readFileSync(args.questionIds, 'utf8')))
  const idsSha = idListSha256(ids)
  const questions = exitOnError(() => selectQuestions(allQs, { limit: 0, ids }))
  console.log(`Loaded ${allQs.length} questions, evaluating ${questions.length} across ${cells.length} cells: ${cells.map((c) => c.name).join(', ')}`)

  const outputPolicy = exitOnError(() => outputPolicyRecord(recallOutputPolicyFromEnv(process.env)))
  const benchOpts: BenchmarkOpts = {
    consolidate: true,
    graph: !args.noGraph,
    topK: Math.max(...K_VALUES),
    noRerank: false,
    ...(args.rerankerBackend ? { rerankerBackend: args.rerankerBackend } : {}),
    ...(args.onnxRerankerModel ? { onnxRerankerModel: args.onnxRerankerModel } : {}),
    ...(args.embedBackend ? { embedBackend: args.embedBackend } : {}),
    ...(args.embedModel ? { embedModel: args.embedModel } : {}),
    ...(args.embedDims !== undefined ? { embedDims: args.embedDims } : {}),
  }
  // Resolved before the identity so a resume compares the width the vectors
  // are built at, not just the flag.
  const embedDims = await resolveEmbedDims(benchOpts)
  const embed = resolveEmbedSettings(args, embedDims)
  console.log(`Embedding: ${embed.backend} ${embed.model} @${embed.dims}`)
  const base = gridRunIdentity(args, idsSha, outputPolicy, embedDims)
  const checkpoints = exitOnError(() =>
    openGridCheckpoints(args.outputDir, cells, (cell) => gridIdentity(base, gridSha, cell), args.resume === true),
  )
  const todo = pendingQuestions(questions, checkpoints.completed)
  if (args.resume) console.log(`Resuming: ${checkpoints.completed.size} questions done in every cell, ${todo.length} to run`)

  const newRows = new Map<string, GridRow[]>(cells.map((c) => [c.name, []]))
  const partialByCell = new Map(checkpoints.cells.map((c) => [c.cell.name, c.partialPath]))
  let resolvedBackend: RerankerBackend | null = null
  const totalStart = Date.now()

  for (let i = 0; i < todo.length; i++) {
    const q = todo[i]!
    const qStart = Date.now()
    // A fresh memo per question: cached outputs never cross questions.
    const { memory, config } = await createBenchMemory(benchOpts, { wrapIntelligence: memoizeIntelligence })
    resolvedBackend = config.rerankerBackend
    try {
      const ingestStart = Date.now()
      const { episodesIngested } = await adapter.ingestQuestion(q, memory)
      // Fire-and-forget writes (graph decomposition) must land before the
      // first cell, or later cells would recall over a different store.
      await memory.flushPendingWrites()
      const ingest = { episodes: episodesIngested, ingestMs: Date.now() - ingestStart }
      await recallCells(memory, q, cells, ingest, {
        beforeCell: sensoryResetter(memory, 'fusion-grid'),
        onRow: (cell, row) => {
          appendCheckpointRow(partialByCell.get(cell.name)!, row)
          newRows.get(cell.name)!.push(row)
        },
      })
    } finally {
      await memory.dispose().catch(() => {})
    }
    console.log(`  Q ${i + 1}/${todo.length} ${q.question_id}  ${cells.length} cells  (${((Date.now() - qStart) / 1000).toFixed(1)}s)`)
  }

  const totalDur = parseFloat(((Date.now() - totalStart) / 1000).toFixed(1))
  if (resolvedBackend === null) resolvedBackend = base.reranker_backend as RerankerBackend

  console.log()
  console.log('| cell | r@5 | r@10 | r@30 |')
  for (const cp of checkpoints.cells) {
    const rows = orderRowsByDataset(questions, [...(cp.rows as unknown as GridRow[]), ...newRows.get(cp.cell.name)!])
    const agg = aggregateRecall(rows)
    const output = {
      meta: {
        args: args as unknown as Record<string, unknown>,
        ...buildModelMeta(resolvedBackend, args.onnxRerankerModel, embed.model),
        embedBackend: embed.backend,
        embedDims: embed.dims,
        output_policy: outputPolicy,
        K_values: K_VALUES,
        total_questions: rows.length,
        total_seconds: totalDur,
        eval_seconds_all_rows: sumSeconds(rows, (r) => r.eval_ms),
        ingest_seconds_all_rows: sumSeconds(rows, (r) => r.ingest_ms),
        generated_at: new Date().toISOString(),
        ...(args.resume ? { resumed_rows: cp.rows.length } : {}),
        question_ids_file: args.questionIds,
        question_ids_sha256: idsSha,
        cell: cp.cell.name,
        fusion: cp.cell.fusion,
        grid_file: args.grid,
        grid_sha256: gridSha,
        shared_ingest: true,
      },
      ...agg,
      rows,
    }
    fs.writeFileSync(cp.outputPath, JSON.stringify(output, null, 2))
    fs.rmSync(cp.partialPath, { force: true })
    const pct = (k: number): string => `${(agg.recall_at_K[k]!.rate * 100).toFixed(1)}%`
    console.log(`| ${cp.cell.name} | ${pct(5)} | ${pct(10)} | ${pct(30)} |`)
  }
  console.log(`Grid complete in ${totalDur}s; wrote ${cells.length} files to ${args.outputDir}`)
}

function sumSeconds(rows: readonly GridRow[], ms: (r: GridRow) => number): number {
  return parseFloat((rows.reduce((acc, r) => acc + ms(r), 0) / 1000).toFixed(1))
}

function validateEnv(): void {
  if (!process.env['OPENAI_API_KEY']) {
    console.error('Missing OPENAI_API_KEY')
    process.exit(1)
  }
  if ((process.env[FUSION_ENV_VAR] ?? '').trim() !== '') {
    console.error(`Error: unset ${FUSION_ENV_VAR}; per-call fusion keys merge over it, so the "default" cell would not measure the shipped defaults`)
    process.exit(1)
  }
}

function exitOnError<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
}
