/**
 * Pure helpers for reformat.ts: derive an output-policy arm from a recorded
 * formatted sweep without re-running retrieval.
 *
 * A row's payload is rebuilt from its recorded text and item offsets, then
 * re-assembled with core's own `assemble` under the arm's policy. Because the
 * retrieval is the source sweep's, every arm judged from the output pairs
 * row-for-row with the source; two recall sweeps of the same system do not
 * (top-5 membership churns between them).
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  assemble,
  estimateTokens,
  PAYLOAD_SECTION_ORDER,
  type PayloadSection,
  type RecallOutputPolicy,
  type RenderedItem,
  type RenderedPayload,
} from '@engram-mem/core'
import { goldIdsInPayload, type RecordedPayloadItem } from './context-modes.js'
import { outputPolicyRecord, type OutputPolicyRecord } from './sweep-checkpoint-lib.js'

export interface ReformatArgs {
  sweep: string
  output: string
  emitK?: number
  tokenBudget?: number
  faintOff: boolean
}

export interface ReformatRow {
  question_id: string
  gold_session_ids: string[]
  formatted?: string
  payload_items?: RecordedPayloadItem[]
  [k: string]: unknown
}

export interface ReformatSweep {
  meta?: Record<string, unknown>
  rows: ReformatRow[]
  [k: string]: unknown
}

const USAGE =
  'Usage: reformat.ts --sweep <formatted sweep.json> --output <out.json> [--token-budget N] [--emit-k N] [--faint off] (at least one policy flag)'

const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value. ${USAGE}`)
  return next
}

function positiveIntegerFlag(argv: readonly string[], name: string): number | undefined {
  const raw = flagValue(argv, name)
  if (raw === undefined) return undefined
  if (!POSITIVE_INTEGER_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`--${name} must be an integer >= 1, got "${raw}"`)
  }
  return Number(raw)
}

/** Same path, including through a symlink to an existing file. */
function samePath(a: string, b: string): boolean {
  const resolve = (p: string): string => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p))
  return resolve(a) === resolve(b)
}

export function parseReformatArgs(argv: readonly string[]): ReformatArgs {
  const sweep = flagValue(argv, 'sweep')
  const output = flagValue(argv, 'output')
  if (sweep === undefined || output === undefined) throw new Error(`--sweep and --output are required. ${USAGE}`)
  if (samePath(sweep, output)) throw new Error(`--output must differ from --sweep (${sweep}); the source sweep is never overwritten`)

  const emitK = positiveIntegerFlag(argv, 'emit-k')
  const tokenBudget = positiveIntegerFlag(argv, 'token-budget')
  const faint = flagValue(argv, 'faint')
  if (faint !== undefined && faint !== 'off') throw new Error(`--faint takes only "off", got "${faint}"`)
  if (emitK === undefined && tokenBudget === undefined && faint === undefined) {
    throw new Error(`at least one of --token-budget, --emit-k or --faint off is required. ${USAGE}`)
  }
  return {
    sweep,
    output,
    ...(emitK !== undefined ? { emitK } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    faintOff: faint === 'off',
  }
}

export function armPolicy(args: Pick<ReformatArgs, 'emitK' | 'tokenBudget' | 'faintOff'>): RecallOutputPolicy {
  return {
    ...(args.emitK !== undefined ? { emitK: args.emitK } : {}),
    ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
    faint: !args.faintOff,
  }
}

/**
 * A sweep can seed an arm only when it recorded formatted payloads under the
 * unbounded policy: a source already cut by a budget, emit-K or the faint
 * switch lacks the items a looser arm would emit, and its `truncated` flags
 * describe a cut the rebuilt payload cannot see.
 */
export function assertReformattableSweep(sweep: ReformatSweep): void {
  const args = sweep.meta?.['args'] as Record<string, unknown> | undefined
  const mode = args?.['contextMode']
  if (mode !== 'formatted') {
    throw new Error(`source sweep has contextMode ${JSON.stringify(mode ?? null)}; only a --context-mode formatted sweep records a payload to re-cut`)
  }
  const policy = sweep.meta?.['output_policy'] as OutputPolicyRecord | undefined
  if (policy === undefined) {
    throw new Error('source sweep meta has no output_policy; it predates payload item recording and cannot be re-cut')
  }
  if (policy.emit_k !== null || policy.token_budget !== null || policy.faint !== true) {
    throw new Error(`source sweep was recorded under output policy ${JSON.stringify(policy)}; an arm needs a source recorded with no emit-K, no token budget and faint on`)
  }
}

const SECTIONS = new Set<string>(PAYLOAD_SECTION_ORDER)

/**
 * The rendered sections of a recorded row, each item keyed by its index in
 * `payload_items`. Throws unless assembling them with no limit reproduces the
 * recorded text exactly, which proves the item lines and section headers were
 * recovered.
 */
export function rebuildRendered(row: ReformatRow): RenderedPayload {
  const items = row.payload_items
  if (!Array.isArray(items)) {
    throw new Error(`row ${row.question_id} has no payload_items; re-run the formatted sweep with a core that records them`)
  }
  if (typeof row.formatted !== 'string') throw new Error(`row ${row.question_id} has no formatted text`)
  const text = row.formatted
  const sections: Record<PayloadSection, RenderedItem[]> = { recalled: [], related: [], domain: [], context: [], faint: [] }
  items.forEach((item, i) => {
    if (!SECTIONS.has(item.section)) throw new Error(`row ${row.question_id} item ${i} has unknown section "${item.section}"`)
    if (!(Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.start <= item.end && item.end <= text.length)) {
      throw new Error(`row ${row.question_id} item ${i} [${item.start}, ${item.end}) lies outside the ${text.length}-char payload`)
    }
    sections[item.section as PayloadSection].push({ text: text.slice(item.start, item.end), id: String(i) })
  })
  const reassembled = assemble(sections).text
  if (reassembled !== text) {
    throw new Error(`row ${row.question_id}: payload_items do not reassemble to the recorded formatted text; ${describeFirstDifference(text, reassembled, items)}`)
  }
  return sections
}

/**
 * Where a reassembly first departs from the recorded text: the line number and
 * both versions of that line, naming it a header line when no item covers it
 * in the recorded text.
 */
export function describeFirstDifference(
  recorded: string,
  reassembled: string,
  items: ReadonlyArray<Pick<RecordedPayloadItem, 'start' | 'end'>>,
): string {
  const want = recorded.split('\n')
  const got = reassembled.split('\n')
  let i = 0
  while (i < want.length && i < got.length && want[i] === got[i]) i++
  const lineStart = want.slice(0, i).reduce((n, line) => n + line.length + 1, 0)
  const lineEnd = i < want.length ? lineStart + want[i]!.length : lineStart
  const isItemLine = lineStart < lineEnd && items.some((item) => item.start < lineEnd && lineStart < item.end)
  const kind = isItemLine ? 'item line' : 'header lines differ at line'
  const show = (lines: string[]): string => (i < lines.length ? JSON.stringify(lines[i]) : '<end of text>')
  return `${kind} ${i + 1}: recorded ${show(want)}, reassembled ${show(got)}`
}

/** The row under `policy`: payload fields recomputed, every other field kept as recorded. */
export function reformatRow(row: ReformatRow, policy: RecallOutputPolicy): ReformatRow {
  const rendered = rebuildRendered(row)
  const source = row.payload_items!
  const { text, payload } = assemble(rendered, policy)
  const payloadItems: RecordedPayloadItem[] = payload.items.map((item) => ({
    section: item.section,
    start: item.start,
    end: item.end,
    session: source[Number(item.id)]!.session,
  }))
  return {
    ...row,
    formatted: text,
    context_chars: text.length,
    context_items: payload.emittedMemories,
    gold_ids_in_context: goldIdsInPayload(payloadItems, row.gold_session_ids),
    payload_items: payloadItems,
    context_tokens: estimateTokens(text),
    truncated: payload.truncated,
  }
}

export interface SourceFile {
  path: string
  bytes: Buffer
}

/**
 * Model ids the judge copies from a sweep's top-level meta into its output.
 * A derived arm ran no retrieval of its own, so it carries the source's ids.
 */
const MODEL_META_KEYS = ['rerankerBackend', 'rerankModel', 'embedModel'] as const

function sourceModelMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (meta === undefined) return {}
  return Object.fromEntries(MODEL_META_KEYS.filter((key) => key in meta).map((key) => [key, meta[key]]))
}

export function reformatSweep(source: SourceFile, policy: RecallOutputPolicy): ReformatSweep {
  const sweep = JSON.parse(source.bytes.toString('utf8')) as ReformatSweep
  assertReformattableSweep(sweep)
  const rows = sweep.rows.map((row) => reformatRow(row, policy))
  return {
    ...sweep,
    meta: {
      ...sourceModelMeta(sweep.meta),
      derived_from: { path: source.path, sha256: createHash('sha256').update(source.bytes).digest('hex') },
      output_policy: outputPolicyRecord(policy),
      retrieval_rerun: false,
      generated_at: new Date().toISOString(),
      source_meta: sweep.meta ?? null,
    },
    rows,
  }
}
