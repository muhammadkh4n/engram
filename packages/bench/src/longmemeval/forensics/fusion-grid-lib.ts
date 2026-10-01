// Fusion grid: one store per question, one recall per weight cell.
//
// Fusion weights act only at recall time, so every cell of a grid can share a
// question's ingest. Cells must then differ by their weights alone: the
// LLM-dependent steps (query expansion, HyDE, embeddings) and the reranker are
// memoised per question so every cell reads the same outputs, recall runs with
// `reconsolidate: false` so no cell changes access counts or edges for the
// next, and the sensory buffer is reset to its post-ingest state before each
// cell because a recall primes topics that boost the following recall.
//
// Rows have the recall-sweep `formatted` row schema, one output file per cell,
// so judge.ts, mcnemar-judged and drift-compare read a cell like a sweep.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { validateFusionOverride, type FusionConfig, type IntelligenceAdapter } from '@engram-mem/core'
import { parseContextMode, runSweepRecall, type FormattedContextFields, type SweepMemory } from './context-modes.js'
import { parseRerankerArgs } from './reranker-meta-lib.js'
import {
  diffRunIdentity,
  formatCheckpointText,
  formatHeaderLine,
  formatRowLine,
  parsePartial,
  partialPathFor,
  type CheckpointRow,
  type RunIdentity,
} from './sweep-checkpoint-lib.js'
import type { LongMemEvalQuestionType } from '../types.js'
import type { RerankerBackend } from '../../types.js'

export const DEFAULT_CELL = 'default'
export const K_VALUES: readonly number[] = [5, 10, 20, 30]

// A cell name becomes `<output-dir>/<name>.json`, so it must be a plain file name.
const CELL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface GridCell {
  name: string
  fusion: Partial<FusionConfig>
}

/**
 * Parse a grid file: a JSON array of `{ name, fusion }`. Every fusion object
 * is checked by core's validator, so a bad key fails before any ingest. The
 * grid must hold a `default` cell with an empty fusion: it is the shipped
 * configuration every other cell is compared against.
 */
export function parseGrid(text: string, source = '--grid'): GridCell[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`${source} file is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${source} file must hold a non-empty JSON array of { name, fusion } cells`)
  }
  const cells: GridCell[] = []
  const names = new Set<string>()
  parsed.forEach((entry: unknown, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${source} cell ${i}: must be an object { name, fusion }`)
    }
    const extra = Object.keys(entry).filter((k) => k !== 'name' && k !== 'fusion')
    if (extra.length > 0) throw new Error(`${source} cell ${i}: unknown field "${extra[0]}"`)
    const { name, fusion } = entry as { name?: unknown; fusion?: unknown }
    if (typeof name !== 'string' || !CELL_NAME.test(name)) {
      throw new Error(`${source} cell ${i}: name must match ${CELL_NAME} (it names the output file), got ${JSON.stringify(name)}`)
    }
    if (names.has(name)) throw new Error(`${source}: duplicate cell name "${name}"`)
    names.add(name)
    cells.push({ name, fusion: validateFusionOverride(fusion, `${source} cell "${name}"`) })
  })
  const def = cells.find((c) => c.name === DEFAULT_CELL)
  if (!def) throw new Error(`${source} must contain a cell named "${DEFAULT_CELL}" with an empty fusion`)
  if (Object.keys(def.fusion).length > 0) {
    throw new Error(`${source} cell "${DEFAULT_CELL}" must have an empty fusion, got ${JSON.stringify(def.fusion)}`)
  }
  return cells
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export interface GridArgs {
  data: string
  questionIds: string
  grid: string
  contextMode: 'formatted'
  rerankerBackend?: RerankerBackend
  onnxRerankerModel?: string
  noGraph: boolean
  outputDir: string
  // Set only when the flag is given, as in recall-sweep's meta.args.
  resume?: true
}

const VALUE_FLAGS = ['data', 'question-ids', 'grid', 'context-mode', 'reranker', 'onnx-model', 'output-dir']
const BOOLEAN_FLAGS = ['no-graph', 'resume']

/** Parse the grid's argv; throws with a message the caller prints. */
export function parseGridArgs(argv: readonly string[]): GridArgs {
  if (parseContextMode(argv) !== 'formatted') {
    throw new Error('--context-mode formatted is required: each cell records the MCP payload')
  }
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const flag = arg.slice(2)
    if (!VALUE_FLAGS.includes(flag) && !BOOLEAN_FLAGS.includes(flag)) throw new Error(`unknown flag ${arg}`)
  }
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(`--${flag}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`--${flag} needs a value`)
    return next
  }
  const required = (flag: string): string => {
    const v = value(flag)
    if (v === undefined) throw new Error(`--${flag} is required`)
    return v
  }
  return {
    data: value('data') ?? './data/longmemeval/longmemeval_s_cleaned.json',
    questionIds: required('question-ids'),
    grid: required('grid'),
    contextMode: 'formatted',
    ...parseRerankerArgs(argv),
    noGraph: argv.includes('--no-graph'),
    outputDir: required('output-dir'),
    ...(argv.includes('--resume') ? { resume: true as const } : {}),
  }
}

/**
 * Memoise the recall-time model calls for one question: `embed`,
 * `expandQuery` and `generateHypotheticalDoc` by input text, `rerank` by
 * (query, document id). A settled failure is memoised too, so every cell sees
 * the same outcome. Methods the base lacks stay absent, because recall checks
 * for their presence; every other method passes through.
 */
export function memoizeIntelligence(base: IntelligenceAdapter): IntelligenceAdapter {
  const out: IntelligenceAdapter = { ...base }
  if (base.embed) out.embed = memoByText(base.embed.bind(base))
  if (base.expandQuery) out.expandQuery = memoByText(base.expandQuery.bind(base))
  if (base.generateHypotheticalDoc) out.generateHypotheticalDoc = memoByText(base.generateHypotheticalDoc.bind(base))
  if (base.rerank) out.rerank = memoRerank(base.rerank.bind(base))
  return out
}

function memoByText<T>(fn: (text: string) => Promise<T>): (text: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>()
  return (text) => {
    let hit = cache.get(text)
    if (!hit) {
      hit = fn(text)
      // A cached rejection may never be awaited again; mark it handled.
      hit.catch(() => {})
      cache.set(text, hit)
    }
    return hit
  }
}

type RerankFn = NonNullable<IntelligenceAdapter['rerank']>

function memoRerank(fn: RerankFn): RerankFn {
  // undefined = the reranker returned no score for that document.
  const cache = new Map<string, Promise<number | undefined>>()
  const keyOf = (query: string, id: string): string => JSON.stringify([query, id])
  return async (query, documents) => {
    const missing = new Map<string, { id: string; content: string }>()
    for (const d of documents) {
      if (!cache.has(keyOf(query, d.id)) && !missing.has(d.id)) missing.set(d.id, d)
    }
    if (missing.size > 0) {
      const call = fn(query, [...missing.values()])
      for (const id of missing.keys()) {
        const score = call.then((results) => results.find((r) => r.id === id)?.score)
        score.catch(() => {})
        cache.set(keyOf(query, id), score)
      }
    }
    const scores = await Promise.all(documents.map((d) => cache.get(keyOf(query, d.id))!))
    return documents.flatMap((d, i) => (scores[i] === undefined ? [] : [{ id: d.id, score: scores[i]! }]))
  }
}

interface SensoryBufferLike {
  snapshot(sessionId: string): unknown
  restore(snapshot: unknown): void
  getIntent(): unknown
  setIntent(intent: unknown): void
}

function isSensoryBuffer(v: unknown): v is SensoryBufferLike {
  if (v === null || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return ['snapshot', 'restore', 'getIntent', 'setIntent'].every((m) => typeof s[m] === 'function')
}

/**
 * Captures the memory's sensory buffer (working items, primed topics, active
 * intent) as it is now and returns a function that puts it back. Each recall
 * primes topics from its results and those priming boosts feed the next
 * recall's scores, so without the reset a cell's ranking would depend on the
 * cells before it. Memory keeps the buffer private; this fails loudly if that
 * field changes rather than letting cells leak into each other.
 */
export function sensoryResetter(memory: object): () => void {
  const sensory = (memory as { sensory?: unknown }).sensory
  if (!isSensoryBuffer(sensory)) {
    throw new Error('Memory has no sensory buffer with snapshot/restore; cannot isolate grid cells from each other')
  }
  const snapshot = sensory.snapshot('fusion-grid')
  const intent = sensory.getIntent()
  return () => {
    sensory.restore(snapshot)
    sensory.setIntent(intent)
  }
}

export interface GridQuestion {
  question_id: string
  question_type: LongMemEvalQuestionType
  question: string
  answer_session_ids: string[]
}

/** A recall-sweep `formatted` row. */
export interface GridRow extends FormattedContextFields {
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
  relevance_top: Array<number | null>
}

export interface IngestStats {
  episodes: number
  ingestMs: number
}

export interface RecallCellsOpts {
  /** Runs before each cell's recall; the CLI passes the sensory reset. */
  beforeCell?: () => void
  /** Called with each row as soon as its cell finishes. */
  onRow?: (cell: GridCell, row: GridRow) => void
}

/** Recall one ingested question once per cell, in grid order. */
export async function recallCells(
  memory: SweepMemory,
  q: GridQuestion,
  cells: readonly GridCell[],
  ingest: IngestStats,
  opts: RecallCellsOpts = {},
): Promise<Map<string, GridRow>> {
  const rows = new Map<string, GridRow>()
  for (const cell of cells) {
    opts.beforeCell?.()
    const start = Date.now()
    const outcome = await runSweepRecall(memory, q, {
      contextMode: 'formatted',
      maxK: Math.max(...K_VALUES),
      synthesize: false,
      fusion: cell.fusion as Record<string, number>,
      reconsolidate: false,
    })
    const evalMs = Date.now() - start
    const recallAtK: Record<number, boolean> = {}
    for (const k of K_VALUES) {
      const top = outcome.recalledSessionIds.slice(0, k)
      recallAtK[k] = q.answer_session_ids.some((id) => top.includes(id))
    }
    const row: GridRow = {
      question_id: q.question_id,
      question_type: q.question_type,
      question: q.question,
      gold_session_ids: q.answer_session_ids,
      retrieved_session_ids: outcome.recalledSessionIds,
      retrieved_count: outcome.recalledSessionIds.length,
      episodes_ingested: ingest.episodes,
      ingest_ms: ingest.ingestMs,
      eval_ms: evalMs,
      recall_at_k: recallAtK,
      relevance_top: outcome.relevanceTop,
      ...outcome.formattedFields!,
    }
    rows.set(cell.name, row)
    opts.onRow?.(cell, row)
  }
  return rows
}

/** A sweep run identity plus what makes a cell's rows its own. */
export interface GridRunIdentity extends RunIdentity {
  grid_sha256: string
  cell: string
  /** The cell's fusion object as JSON. */
  fusion: string
}

const GRID_IDENTITY_FIELDS = ['grid_sha256', 'cell', 'fusion'] as const

export function gridIdentity(base: RunIdentity, gridSha: string, cell: GridCell): GridRunIdentity {
  return { ...base, grid_sha256: gridSha, cell: cell.name, fusion: JSON.stringify(cell.fusion) }
}

export interface CellCheckpoint {
  cell: GridCell
  outputPath: string
  partialPath: string
  /** Rows kept from an earlier run; only questions finished in every cell. */
  rows: CheckpointRow[]
}

export interface GridCheckpoints {
  cells: CellCheckpoint[]
  /** Questions with a row in every cell's checkpoint. */
  completed: Set<string>
}

export function cellOutputPath(outputDir: string, cell: GridCell): string {
  return path.join(outputDir, `${cell.name}.json`)
}

/**
 * Create or reopen one checkpoint per cell. A fresh run refuses existing
 * checkpoints. A resume needs every cell's checkpoint with a matching
 * identity, keeps only the questions present in all of them, and rewrites
 * each file to that set: a question stopped part-way through its cells reruns
 * in every cell, and the rewrite drops a truncated tail before any append.
 */
export function openGridCheckpoints(
  outputDir: string,
  cells: readonly GridCell[],
  identityFor: (cell: GridCell) => GridRunIdentity,
  resume: boolean,
): GridCheckpoints {
  const paths = cells.map((cell) => {
    const outputPath = cellOutputPath(outputDir, cell)
    return { cell, outputPath, partialPath: partialPathFor(outputPath) }
  })
  const existing = paths.filter((p) => fs.existsSync(p.partialPath))

  if (existing.length > 0 && !resume) {
    throw new Error(`${existing[0]!.partialPath} exists from an earlier run. Pass --resume to continue it, or delete the cell checkpoints to start over.`)
  }
  if (existing.length === 0) {
    fs.mkdirSync(outputDir, { recursive: true })
    for (const p of paths) fs.writeFileSync(p.partialPath, formatHeaderLine(identityFor(p.cell)), { flag: 'wx' })
    return { cells: paths.map((p) => ({ ...p, rows: [] })), completed: new Set() }
  }
  const missing = paths.find((p) => !fs.existsSync(p.partialPath))
  if (missing) {
    throw new Error(`cannot resume: cell "${missing.cell.name}" has no checkpoint at ${missing.partialPath} while other cells do`)
  }

  const parsed = paths.map((p) => {
    const partial = parsePartial(fs.readFileSync(p.partialPath, 'utf8'))
    const field = diffGridIdentity(partial.header as GridRunIdentity, identityFor(p.cell))
    if (field !== null) {
      const recorded = (partial.header as unknown as Record<string, unknown>)[field]
      const current = (identityFor(p.cell) as unknown as Record<string, unknown>)[field]
      throw new Error(`cannot resume ${p.partialPath}: ${field} differs (checkpoint ${JSON.stringify(recorded)}, this run ${JSON.stringify(current)})`)
    }
    return { ...p, partial }
  })

  const completed = new Set(parsed[0]!.partial.rows.map((r) => r.question_id))
  for (const p of parsed.slice(1)) {
    const ids = new Set(p.partial.rows.map((r) => r.question_id))
    for (const id of completed) if (!ids.has(id)) completed.delete(id)
  }

  const reopened = parsed.map((p) => {
    const rows = p.partial.rows.filter((r) => completed.has(r.question_id))
    const tmpPath = `${p.partialPath}.tmp`
    fs.writeFileSync(tmpPath, formatCheckpointText(p.partial.header, rows))
    fs.renameSync(tmpPath, p.partialPath)
    return { cell: p.cell, outputPath: p.outputPath, partialPath: p.partialPath, rows }
  })
  return { cells: reopened, completed }
}

function diffGridIdentity(recorded: GridRunIdentity, current: GridRunIdentity): keyof GridRunIdentity | null {
  const base = diffRunIdentity(recorded, current)
  if (base !== null) return base
  return GRID_IDENTITY_FIELDS.find((f) => !Object.is(recorded[f], current[f])) ?? null
}

export function appendCheckpointRow(partialPath: string, row: GridRow): void {
  fs.appendFileSync(partialPath, formatRowLine(row))
}

interface RateCell {
  hits: number
  total: number
  rate: number
}

/** recall@K overall and per question type, as recall-sweep writes them. */
export function aggregateRecall(rows: readonly Pick<GridRow, 'question_type' | 'recall_at_k'>[]): {
  recall_at_K: Record<string, RateCell>
  by_question_type: Record<string, Record<string, RateCell>>
} {
  const rate = (bucket: readonly Pick<GridRow, 'recall_at_k'>[], k: number): RateCell => {
    const hits = bucket.filter((r) => r.recall_at_k[k]).length
    return { hits, total: bucket.length, rate: hits / Math.max(1, bucket.length) }
  }
  const overall: Record<string, RateCell> = {}
  for (const k of K_VALUES) overall[k] = rate(rows, k)
  const byType: Record<string, Record<string, RateCell>> = {}
  const types = new Map<string, Pick<GridRow, 'question_type' | 'recall_at_k'>[]>()
  for (const r of rows) types.set(r.question_type, [...(types.get(r.question_type) ?? []), r])
  for (const [type, bucket] of types) {
    byType[type] = {}
    for (const k of K_VALUES) byType[type]![k] = rate(bucket, k)
  }
  return { recall_at_K: overall, by_question_type: byType }
}
