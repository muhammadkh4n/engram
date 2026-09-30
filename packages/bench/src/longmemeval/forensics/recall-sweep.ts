#!/usr/bin/env node
/**
 * LongMemEval recall sweep — Phase 1 baseline harness.
 *
 * Runs LongMemEvalS (or any compatible JSON dataset) end-to-end with the
 * fresh-memory-per-question architecture from adapter.ts. Computes recall@K
 * for multiple K values from a single pass, aggregates by question_type +
 * by mapped ability, writes JSON output.
 *
 * NO judge calls. Recall@K only. For cheap baseline numbers before
 * committing to Phase 2 judge spend.
 *
 * Required env: OPENAI_API_KEY
 * Optional env: NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD  (production-style
 *               graph; see bench-graph.ts for the bench env var)
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/recall-sweep.ts \
 *     --data ./data/longmemeval/longmemeval_s_cleaned.json \
 *     [--limit 50]                # smoke run (default: all 500)
 *     [--question-ids ids.json]   # JSON array of question_id; runs those, in dataset order (not with --limit)
 *     [--resume]                  # continue from <output>.partial.jsonl; the run config must match its header
 *     [--max-results 30]          # passed to memory.recall
 *     [--no-consolidate] [--no-graph] [--no-rerank]
 *     [--reranker openai|onnx|none]  # default openai (none under --no-rerank)
 *     [--onnx-model <hf id>]      # with --reranker onnx; default mixedbread-ai/mxbai-rerank-large-v1
 *     [--vector-mode full|engine]  # 'engine' wraps sqlite with RecallEngine
 *     [--synthesize]              # record per-row RecallResult.synthesis (now = question_date, evidence capped to top-5 sessions)
 *     [--context-mode sessions|formatted]  # formatted: recall as the MCP memory_recall tool does and
 *                                 # record its text payload per row (no --synthesize or --max-results)
 *     --output ./results/longmemeval/baseline.json
 *
 * Every finished row is appended to <output>.partial.jsonl, so a stopped run
 * keeps its rows; the partial file is deleted once the output is written.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { LongMemEvalAdapter } from '../adapter.js'
import { createBenchMemory } from '../../memory-factory.js'
import { parseContextMode, runSweepRecall, type ContextMode, type FormattedContextFields } from './context-modes.js'
import { buildSynthesisField, type SynthesisBlock } from './synthesis-row.js'
import { parseEventDate } from '@engram-mem/core'
import { parseRerankerArgs, buildModelMeta } from './reranker-meta-lib.js'
import type { LongMemEvalQuestionType } from '../types.js'
import type { BenchmarkOpts, RerankerBackend } from '../../types.js'
import {
  diffRunIdentity,
  formatHeaderLine,
  formatRowLine,
  idListSha256,
  orderRowsByDataset,
  parsePartial,
  parseQuestionIdList,
  partialPathFor,
  pendingQuestions,
  selectQuestions,
  type RunIdentity,
} from './sweep-checkpoint-lib.js'

interface SweepArgs {
  data: string
  limit: number
  maxResults: number
  noConsolidate: boolean
  noGraph: boolean
  noRerank: boolean
  rerankerBackend?: RerankerBackend
  onnxRerankerModel?: string
  vectorMode?: 'full' | 'engine'
  synthesize: boolean
  contextMode: ContextMode
  output: string
  // Set only when the flag is given, so meta.args of a plain run is unchanged.
  resume?: true
  questionIds?: string
}

interface PerQRow {
  question_id: string
  question_type: LongMemEvalQuestionType
  question: string
  gold_session_ids: string[]
  retrieved_session_ids: string[]
  retrieved_count: number
  episodes_ingested: number
  ingest_ms: number
  eval_ms: number
  recall_at_k: Record<number, boolean>
  synthesis?: SynthesisBlock | null
}

type SweepRow = PerQRow & Partial<FormattedContextFields>

const K_VALUES = [5, 10, 20, 30]

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  validateEnv(args)

  const adapter = new LongMemEvalAdapter()
  const allQs = await adapter.loadDataset(args.data)
  const selection = loadSelection(args)
  const questions = exitOnError(() => selectQuestions(allQs, { limit: args.limit, ...(selection ? { ids: selection.ids } : {}) }))
  console.log(`Loaded ${allQs.length} questions, evaluating ${questions.length}`)
  console.log(`Config: maxResults=${args.maxResults}, consolidate=${!args.noConsolidate}, graph=${!args.noGraph}, rerank=${args.rerankerBackend ?? (args.noRerank ? 'none' : 'openai')}${args.onnxRerankerModel ? ` (${args.onnxRerankerModel})` : ''}, vectorMode=${args.vectorMode ?? 'full'}, synthesize=${args.synthesize}, contextMode=${args.contextMode}`)
  console.log(`K values: ${K_VALUES.join(', ')}`)
  console.log()

  const benchOpts: BenchmarkOpts = {
    consolidate: !args.noConsolidate,
    graph: !args.noGraph,
    topK: args.maxResults,
    noRerank: args.noRerank,
    ...(args.rerankerBackend ? { rerankerBackend: args.rerankerBackend } : {}),
    ...(args.onnxRerankerModel ? { onnxRerankerModel: args.onnxRerankerModel } : {}),
    ...(args.vectorMode ? { vectorMode: args.vectorMode } : {}),
  }

  const partialPath = partialPathFor(args.output)
  const identity = buildRunIdentity(args, selection?.sha256)
  const resumedRows = openCheckpoint(partialPath, identity, args.resume === true)
  const todo = pendingQuestions(questions, new Set(resumedRows.map((r) => r.question_id)))
  if (args.resume) console.log(`Resuming: ${resumedRows.length} rows from ${partialPath}, ${todo.length} to run`)

  const newRows: SweepRow[] = []
  // The backend createBenchMemory actually wired, not the raw flag.
  let resolvedBackend: RerankerBackend | null = null
  const totalStart = Date.now()

  for (let i = 0; i < todo.length; i++) {
    const q = todo[i]!
    const qStart = Date.now()

    // Use the adapter's runQuestion which already handles fresh-memory + dispose
    // BUT — runQuestion currently slices to topK before computing recall@K.
    // For the sweep we want a fuller view: retrieve max(K_VALUES) once, then
    // compute recall@K from the same list. We need a slightly different path.
    const { memory, config } = await createBenchMemory(benchOpts)
    resolvedBackend = config.rerankerBackend
    let episodes = 0
    let ingestMs = 0
    let evalMs = 0
    let recalledSessionIds: string[] = []
    let synthesisRow: SynthesisBlock | null | undefined
    let formattedFields: FormattedContextFields | undefined

    try {
      const ingestStart = Date.now()
      const { episodesIngested } = await adapter.ingestQuestion(q, memory)
      episodes = episodesIngested
      ingestMs = Date.now() - ingestStart

      const evalStart = Date.now()
      const maxK = Math.max(...K_VALUES)
      const questionNow = parseEventDate(q.question_date)
      const outcome = await runSweepRecall(memory, q, {
        contextMode: args.contextMode,
        maxK,
        synthesize: args.synthesize,
        now: questionNow,
      })
      recalledSessionIds = outcome.recalledSessionIds
      synthesisRow = outcome.synthesisRow
      formattedFields = outcome.formattedFields
      evalMs = Date.now() - evalStart
    } finally {
      await memory.dispose().catch(() => {})
    }

    const recallAtK: Record<number, boolean> = {}
    for (const k of K_VALUES) {
      const topK = recalledSessionIds.slice(0, k)
      recallAtK[k] = q.answer_session_ids.some((id) => topK.includes(id))
    }

    const row: SweepRow = {
      question_id: q.question_id,
      question_type: q.question_type,
      question: q.question,
      gold_session_ids: q.answer_session_ids,
      retrieved_session_ids: recalledSessionIds,
      retrieved_count: recalledSessionIds.length,
      episodes_ingested: episodes,
      ingest_ms: ingestMs,
      eval_ms: evalMs,
      recall_at_k: recallAtK,
      ...buildSynthesisField(args.synthesize, synthesisRow),
      ...(formattedFields ?? {}),
    }
    newRows.push(row)
    fs.appendFileSync(partialPath, formatRowLine(row))

    const qDur = ((Date.now() - qStart) / 1000).toFixed(1)
    if ((i + 1) % 10 === 0 || i + 1 === todo.length) {
      const r5 = newRows.filter((r) => r.recall_at_k[5]).length
      const r10 = newRows.filter((r) => r.recall_at_k[10]).length
      const r30 = newRows.filter((r) => r.recall_at_k[30]).length
      console.log(
        `  Q ${i + 1}/${todo.length}  r@5=${r5}  r@10=${r10}  r@30=${r30}  (last Q: ${qDur}s)`,
      )
    }
  }

  const totalDur = ((Date.now() - totalStart) / 1000).toFixed(1)
  console.log()
  console.log(`Sweep complete in ${totalDur}s`)

  const rows = orderRowsByDataset(questions, [...resumedRows, ...newRows])
  // A resume whose questions were all done wires no memory; report the flag-derived backend.
  if (resolvedBackend === null && resumedRows.length > 0) resolvedBackend = identity.reranker_backend as RerankerBackend

  // Aggregate
  const overall: Record<string, { hits: number; total: number; rate: number }> = {}
  for (const k of K_VALUES) {
    const hits = rows.filter((r) => r.recall_at_k[k]).length
    overall[k] = { hits, total: rows.length, rate: hits / Math.max(1, rows.length) }
  }

  const byType: Record<string, Record<string, { hits: number; total: number; rate: number }>> = {}
  const typeBuckets = new Map<string, SweepRow[]>()
  for (const r of rows) {
    const bucket = typeBuckets.get(r.question_type) ?? []
    bucket.push(r)
    typeBuckets.set(r.question_type, bucket)
  }
  for (const [type, bucket] of typeBuckets) {
    byType[type] = {}
    for (const k of K_VALUES) {
      const hits = bucket.filter((r) => r.recall_at_k[k]).length
      byType[type][k] = { hits, total: bucket.length, rate: hits / Math.max(1, bucket.length) }
    }
  }

  // Output
  const output = {
    meta: {
      args: args as unknown as Record<string, unknown>,
      ...buildModelMeta(resolvedBackend, args.onnxRerankerModel),
      K_values: K_VALUES,
      total_questions: rows.length,
      total_seconds: parseFloat(totalDur),
      generated_at: new Date().toISOString(),
      ...(args.resume ? { resumed_rows: resumedRows.length } : {}),
      ...(selection ? { question_ids_file: args.questionIds, question_ids_sha256: selection.sha256 } : {}),
    },
    recall_at_K: overall,
    by_question_type: byType,
    rows,
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))
  fs.rmSync(partialPath, { force: true })
  console.log(`Wrote ${args.output}`)

  // Print summary
  console.log()
  console.log('═══ Recall@K (overall) ═══')
  console.log(`| K   | hits | total | recall  |`)
  console.log(`|-----|------|-------|---------|`)
  for (const k of K_VALUES) {
    const o = overall[k]!
    console.log(`| ${k.toString().padStart(3)} | ${String(o.hits).padStart(4)} | ${String(o.total).padStart(5)} | ${(o.rate * 100).toFixed(1).padStart(6)}% |`)
  }
  console.log()
  console.log('═══ Per question type ═══')
  const typeKeys = [...typeBuckets.keys()].sort()
  const header = `| ${'type'.padEnd(28)} | ${'n'.padStart(4)} | ` + K_VALUES.map((k) => `r@${k}`.padStart(6)).join(' | ') + ' |'
  console.log(header)
  console.log('|' + '-'.repeat(header.length - 2) + '|')
  for (const t of typeKeys) {
    const b = typeBuckets.get(t)!
    const cells = K_VALUES.map((k) => {
      const o = byType[t]![k]!
      return `${(o.rate * 100).toFixed(1)}%`.padStart(6)
    })
    console.log(`| ${t.padEnd(28)} | ${String(b.length).padStart(4)} | ${cells.join(' | ')} |`)
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

function loadSelection(args: SweepArgs): { ids: string[]; sha256: string } | undefined {
  const file = args.questionIds
  if (file === undefined) return undefined
  return exitOnError(() => {
    const ids = parseQuestionIdList(fs.readFileSync(file, 'utf8'))
    return { ids, sha256: idListSha256(ids) }
  })
}

function buildRunIdentity(args: SweepArgs, idsSha256: string | undefined): RunIdentity {
  const backend: RerankerBackend = args.rerankerBackend ?? (args.noRerank ? 'none' : 'openai')
  const questionSelection = idsSha256 !== undefined
    ? `ids:${idsSha256}`
    : args.limit > 0 ? `limit:${args.limit}` : 'all'
  return {
    data: path.resolve(args.data),
    context_mode: args.contextMode,
    reranker_backend: backend,
    reranker_model: buildModelMeta(backend, args.onnxRerankerModel).rerankModel,
    graph: !args.noGraph,
    consolidate: !args.noConsolidate,
    vector_mode: args.vectorMode ?? 'full',
    max_results: args.maxResults,
    synthesize: args.synthesize,
    question_selection: questionSelection,
  }
}

/**
 * Returns the rows already recorded for this run. A fresh run creates the
 * checkpoint with its header; an existing one is never overwritten, because it
 * may hold hours of work.
 */
function openCheckpoint(partialPath: string, identity: RunIdentity, resume: boolean): SweepRow[] {
  const exists = fs.existsSync(partialPath)
  if (exists && !resume) {
    console.error(`Error: ${partialPath} exists from an earlier run. Pass --resume to continue it, or delete the file to start over.`)
    process.exit(1)
  }
  if (!exists) {
    fs.mkdirSync(path.dirname(partialPath), { recursive: true })
    fs.writeFileSync(partialPath, formatHeaderLine(identity), { flag: 'wx' })
    return []
  }
  const partial = exitOnError(() => parsePartial(fs.readFileSync(partialPath, 'utf8')))
  const field = diffRunIdentity(partial.header, identity)
  if (field !== null) {
    console.error(
      `Error: cannot resume ${partialPath}: ${field} differs (checkpoint ${JSON.stringify(partial.header[field])}, this run ${JSON.stringify(identity[field])})`,
    )
    process.exit(1)
  }
  return partial.rows as unknown as SweepRow[]
}

function validateEnv(_args: SweepArgs): void {
  if (!process.env['OPENAI_API_KEY']) {
    console.error('Missing OPENAI_API_KEY')
    process.exit(1)
  }
  // Graph wiring is opt-in via ENGRAM_BENCH_NEO4J_URI per bench-graph.ts.
  // We don't gate on it here — falling back to SQL-only is fine for a
  // baseline number; the warning is logged from createBenchMemory.
}

function parseArgs(argv: string[]): SweepArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : 'true'
  }
  const has = (k: string): boolean => argv.includes(`--${k}`)
  const vectorModeRaw = get('vector-mode')
  if (vectorModeRaw !== undefined && vectorModeRaw !== 'full' && vectorModeRaw !== 'engine') {
    console.error(`Error: --vector-mode must be "full" or "engine", got ${JSON.stringify(vectorModeRaw)}`)
    process.exit(1)
  }
  let reranker: ReturnType<typeof parseRerankerArgs>
  let contextMode: ContextMode
  try {
    reranker = parseRerankerArgs(argv)
    contextMode = parseContextMode(argv)
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
  const questionIds = get('question-ids')
  if (questionIds === 'true') {
    console.error('Error: --question-ids requires a path to a JSON array of question_id strings')
    process.exit(1)
  }
  return {
    data: get('data') ?? './data/longmemeval/longmemeval_s_cleaned.json',
    limit: parseInt(get('limit') ?? '0', 10),
    maxResults: parseInt(get('max-results') ?? '30', 10),
    noConsolidate: has('no-consolidate'),
    noGraph: has('no-graph'),
    noRerank: has('no-rerank'),
    ...reranker,
    ...(vectorModeRaw !== undefined ? { vectorMode: vectorModeRaw } : {}),
    synthesize: has('synthesize'),
    contextMode,
    output: get('output') ?? './results/longmemeval/baseline.json',
    ...(has('resume') ? { resume: true as const } : {}),
    ...(questionIds !== undefined ? { questionIds } : {}),
  }
}
