// Pure helpers for resumable recall sweeps and explicit question lists.
//
// A long sweep (tens of seconds per question under a local cross-encoder)
// appends each finished row to `<output>.partial.jsonl` so a stop loses at most
// the question in flight. The first line is a header carrying the run
// identity; a resume is only sound when every field that changes a row's
// content matches, otherwise the final file would mix rows from two configs.
import { createHash } from 'node:crypto'

/** Every setting that changes which questions run or what a row contains. */
export interface RunIdentity {
  data: string
  context_mode: string
  reranker_backend: string
  reranker_model: string | null
  graph: boolean
  consolidate: boolean
  vector_mode: string
  max_results: number
  synthesize: boolean
  question_selection: string
}

const IDENTITY_FIELDS: readonly (keyof RunIdentity)[] = [
  'data',
  'context_mode',
  'reranker_backend',
  'reranker_model',
  'graph',
  'consolidate',
  'vector_mode',
  'max_results',
  'synthesize',
  'question_selection',
]

export interface CheckpointRow {
  question_id: string
  [key: string]: unknown
}

export interface ParsedPartial {
  header: RunIdentity
  rows: CheckpointRow[]
}

export interface QuestionRef {
  question_id: string
}

export interface SelectionOpts {
  limit: number
  ids?: readonly string[]
}

export function partialPathFor(outputPath: string): string {
  return `${outputPath}.partial.jsonl`
}

export function formatHeaderLine(identity: RunIdentity): string {
  return JSON.stringify({ header: identity }) + '\n'
}

export function formatRowLine<R extends QuestionRef>(row: R): string {
  return JSON.stringify(row) + '\n'
}

/**
 * The whole checkpoint as text: header plus one line per row. A resume writes
 * this back before appending, so a truncated tail from a killed run is gone
 * from disk and the next append starts on a fresh line.
 */
export function formatCheckpointText(header: RunIdentity, rows: readonly QuestionRef[]): string {
  return formatHeaderLine(header) + rows.map((r) => formatRowLine(r)).join('')
}

/** The first identity field whose value differs, or null when the runs match. */
export function diffRunIdentity(recorded: RunIdentity, current: RunIdentity): keyof RunIdentity | null {
  for (const field of IDENTITY_FIELDS) {
    if (!Object.is(recorded[field], current[field])) return field
  }
  return null
}

/**
 * Parse a checkpoint file. A process killed mid-write can leave the final line
 * truncated; that line is dropped because its question simply reruns. A bad
 * line anywhere else means the file was edited or corrupted, so it is refused.
 */
export function parsePartial(text: string): ParsedPartial {
  const lines = text.split('\n')
  const hasTrailingNewline = lines[lines.length - 1] === ''
  if (hasTrailingNewline) lines.pop()

  const first = lines[0] !== undefined ? tryParse(lines[0]) : undefined
  if (!isHeader(first)) {
    throw new Error('checkpoint file has no header line; delete it and rerun without --resume')
  }

  const rows: CheckpointRow[] = []
  const seen = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const parsed = tryParse(lines[i]!)
    const isLast = i === lines.length - 1
    if (!isRow(parsed)) {
      if (isLast && !hasTrailingNewline) break
      throw new Error(`checkpoint file line ${i + 1} is not a sweep row`)
    }
    if (seen.has(parsed.question_id)) {
      throw new Error(`checkpoint file records question_id "${parsed.question_id}" twice`)
    }
    seen.add(parsed.question_id)
    rows.push(parsed)
  }
  return { header: first.header, rows }
}

export function pendingQuestions<Q extends QuestionRef>(questions: readonly Q[], doneIds: ReadonlySet<string>): Q[] {
  return questions.filter((q) => !doneIds.has(q.question_id))
}

/** Refuse checkpoint rows whose questions are not in this run's selection. */
export function assertRowsInSelection(questions: readonly QuestionRef[], rows: readonly QuestionRef[]): void {
  const selected = new Set(questions.map((q) => q.question_id))
  for (const r of rows) {
    if (!selected.has(r.question_id)) {
      throw new Error(`row for question_id "${r.question_id}" is not in the selected questions`)
    }
  }
}

/** Rows in the order their questions appear in the selected dataset slice. */
export function orderRowsByDataset<R extends QuestionRef>(questions: readonly QuestionRef[], rows: readonly R[]): R[] {
  assertRowsInSelection(questions, rows)
  const position = new Map(questions.map((q, i) => [q.question_id, i]))
  return [...rows].sort((a, b) => position.get(a.question_id)! - position.get(b.question_id)!)
}

/**
 * Apply `--limit` or `--question-ids`. Listed ids come back in dataset order so
 * a subset sweep lines up row-for-row with a full sweep of the same data.
 */
export function selectQuestions<Q extends QuestionRef>(all: readonly Q[], opts: SelectionOpts): Q[] {
  if (opts.ids === undefined) return opts.limit > 0 ? all.slice(0, opts.limit) : [...all]
  if (opts.limit > 0) throw new Error('--limit cannot be combined with --question-ids')

  const wanted = new Set<string>()
  for (const id of opts.ids) {
    if (wanted.has(id)) throw new Error(`duplicate question_id "${id}" in --question-ids`)
    wanted.add(id)
  }
  const known = new Set(all.map((q) => q.question_id))
  for (const id of opts.ids) {
    if (!known.has(id)) throw new Error(`unknown question_id "${id}" in --question-ids`)
  }
  return all.filter((q) => wanted.has(q.question_id))
}

export function parseQuestionIdList(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`--question-ids file is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === 'string')) {
    throw new Error('--question-ids file must hold a JSON array of question_id strings')
  }
  if (parsed.length === 0) throw new Error('--question-ids file is empty')
  return parsed
}

/** sha256 of the sorted, newline-joined ids: identifies the set, not the file's order. */
export function idListSha256(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex')
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function isHeader(v: unknown): v is { header: RunIdentity } {
  if (v === null || typeof v !== 'object') return false
  const h = (v as { header?: unknown }).header
  return h !== null && typeof h === 'object'
}

function isRow(v: unknown): v is CheckpointRow {
  return v !== null && typeof v === 'object' && typeof (v as { question_id?: unknown }).question_id === 'string'
}
