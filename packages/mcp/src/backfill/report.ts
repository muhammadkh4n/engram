/**
 * The backfill report: what the item store holds once the backfill ran, as
 * markdown for review.
 *
 * Every number is read from the store as it is now, so the report can be run
 * again at any point of the backfill. Samples are drawn with a seeded
 * generator from the id-ordered population, so one seed against one store
 * gives the same samples. Stored text is already masked by the scrubber; the
 * report prints it cut to a sample length and never reads anything else.
 */
import { legacyUserText } from './legacy-text.js'

/** The old tables the copy reads, with the legacy kind each becomes. */
export const OLD_TABLES = {
  memory_episodes: 'legacy_episode',
  memory_digests: 'legacy_digest',
  memory_semantic: 'legacy_fact',
} as const
export type OldTable = keyof typeof OLD_TABLES

export const SAMPLE_SIZES = {
  register_candidates: 30,
  salvage_observations: 60,
  legacy_utterances: 20,
  history_utterances: 20,
} as const
export type SamplePopulation = keyof typeof SAMPLE_SIZES

/** Sample text is cut to this many characters (code points). */
export const SAMPLE_TEXT_CHARS = 500
/** Capture errors are grouped by type and this many leading characters. */
export const ERROR_PREFIX_CHARS = 60
/** MK utterances the legacy text rule would exclude are listed up to this many. */
const EXCLUDED_LISTED = 20

export interface ItemFacet {
  id: string
  class: string
  kind: string
  speaker: string
  source_type: string | null
  time_basis: string | null
  project_id: string | null
  forgotten: boolean
}

export interface OldRow {
  id: string
  project_id: string | null
  forgotten: boolean
}

export interface RunRow {
  extractor_version: string
  status: string
  stats: unknown
}

export interface CaptureErrorRow {
  type: string
  error: string
}

export interface SampleRow {
  id: string
  content: string
  context: string | null
  /** The item's `source.quote`, when its source carries one. */
  quote: string | null
  occurred_at: string
  project_id: string | null
  lineage: string[]
}

/** The store reads the report needs. Every listing yields its rows in pages. */
export interface ReportStore {
  itemFacets(): AsyncIterable<ItemFacet>
  oldRows(table: OldTable): AsyncIterable<OldRow>
  proceduralRows(): Promise<number>
  /** Ids of items whose content the scrubber masked. */
  maskedItemIds(): Promise<ReadonlySet<string>>
  /** Legacy facts whose old row named a superseder, by link state. */
  factSupersessions(): Promise<Record<string, number>>
  /** The content of every live MK utterance. */
  mkUtterances(): AsyncIterable<{ id: string; content: string }>
  invariantCounts(): Promise<Array<{ name: string; violations: number }>>
  embeddedByClass(): Promise<Record<string, number>>
  extractionRuns(): AsyncIterable<RunRow>
  unprocessedEvents(): Promise<number>
  captureErrors(): AsyncIterable<CaptureErrorRow>
  /** The live ids of a sample population, in id order. */
  sampleIds(population: SamplePopulation): Promise<string[]>
  itemsByIds(ids: readonly string[]): Promise<SampleRow[]>
}

type Counts = Record<string, number>

export interface TableCompleteness {
  table: OldTable
  kind: string
  old_rows: number
  old_forgotten: number
  items: number
  items_forgotten: number
  not_copied: number
  masked: number
}

export interface ObservationSample extends SampleRow {
  evidence: SampleRow[]
}

export interface BackfillReport {
  generated_at: string
  seed: number
  /** Count per `class|kind|source.type|source.time_basis`. */
  items: Array<{ class: string; kind: string; source_type: string | null; time_basis: string | null; live: number; forgotten: number }>
  legacy: {
    tables: TableCompleteness[]
    procedural_rows: number
    fact_supersessions: Counts
  }
  mk_words: { utterances: number; excluded: number; by_reason: Counts; listed: Array<{ id: string; reason: string }> }
  invariants: Array<{ name: string; violations: number }>
  projects: Array<{ project_id: string | null; live: number; forgotten: number }>
  unmapped: Array<{ raw: string; rows: number }>
  extraction: {
    runs: Array<{ extractor_version: string; status: string; runs: number }>
    rejected: Array<{ extractor_version: string; reason: string; count: number }>
    embedded: Counts
  }
  capture: { unprocessed: number; errors: Array<{ type: string; error: string; count: number }> }
  samples: {
    register_candidates: SampleRow[]
    salvage_observations: ObservationSample[]
    legacy_utterances: SampleRow[]
    history_utterances: SampleRow[]
  }
  populations: Record<SamplePopulation, number>
}

// --- Seeded sampling ---------------------------------------------------------

/** mulberry32: a small, fast generator whose sequence is fixed by its seed. */
function generator(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Up to `size` ids drawn without replacement; the population is sorted first, so its read order cannot move the draw. */
export function sampleOf(ids: readonly string[], size: number, seed: number): string[] {
  const pool = [...new Set(ids)].sort()
  const next = generator(seed)
  const n = Math.min(size, pool.length)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(next() * (pool.length - i))
    const swap = pool[i]!
    pool[i] = pool[j]!
    pool[j] = swap
  }
  return pool.slice(0, n)
}

// --- Aggregation -------------------------------------------------------------

function bump(counts: Counts, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by
}

function byTime(a: SampleRow, b: SampleRow): number {
  return a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

interface FacetTotals {
  items: BackfillReport['items']
  projects: BackfillReport['projects']
  /** Legacy item id -> its project and whether it is forgotten. */
  legacy: Map<string, { kind: string; project_id: string | null; forgotten: boolean }>
}

async function facetTotals(store: ReportStore): Promise<FacetTotals> {
  const groups = new Map<string, BackfillReport['items'][number]>()
  const projects = new Map<string | null, BackfillReport['projects'][number]>()
  const legacy: FacetTotals['legacy'] = new Map()
  for await (const f of store.itemFacets()) {
    const key = JSON.stringify([f.class, f.kind, f.source_type, f.time_basis])
    let g = groups.get(key)
    if (!g) {
      g = { class: f.class, kind: f.kind, source_type: f.source_type, time_basis: f.time_basis, live: 0, forgotten: 0 }
      groups.set(key, g)
    }
    let p = projects.get(f.project_id)
    if (!p) {
      p = { project_id: f.project_id, live: 0, forgotten: 0 }
      projects.set(f.project_id, p)
    }
    if (f.forgotten) {
      g.forgotten++
      p.forgotten++
    } else {
      g.live++
      p.live++
    }
    if (f.class === 'legacy') legacy.set(f.id, { kind: f.kind, project_id: f.project_id, forgotten: f.forgotten })
  }
  const items = [...groups.values()].sort((a, b) =>
    JSON.stringify([a.class, a.kind, a.source_type, a.time_basis]).localeCompare(JSON.stringify([b.class, b.kind, b.source_type, b.time_basis])),
  )
  const projectRows = [...projects.values()].sort((a, b) => b.live + b.forgotten - (a.live + a.forgotten) || String(a.project_id).localeCompare(String(b.project_id)))
  return { items, projects: projectRows, legacy }
}

async function legacyCompleteness(
  store: ReportStore,
  legacy: FacetTotals['legacy'],
): Promise<{ tables: TableCompleteness[]; unmapped: BackfillReport['unmapped'] }> {
  const masked = await store.maskedItemIds()
  const unmapped: Counts = {}
  const tables: TableCompleteness[] = []
  for (const [table, kind] of Object.entries(OLD_TABLES) as Array<[OldTable, string]>) {
    const row: TableCompleteness = { table, kind, old_rows: 0, old_forgotten: 0, items: 0, items_forgotten: 0, not_copied: 0, masked: 0 }
    for await (const old of store.oldRows(table)) {
      row.old_rows++
      if (old.forgotten) row.old_forgotten++
      const item = legacy.get(old.id)
      if (!item || item.kind !== kind) {
        row.not_copied++
        continue
      }
      // A raw value the map sent to no project leaves its copied rows without one.
      if (old.project_id !== null && item.project_id === null) bump(unmapped, old.project_id)
    }
    for (const [id, item] of legacy) {
      if (item.kind !== kind) continue
      row.items++
      if (item.forgotten) row.items_forgotten++
      if (masked.has(id)) row.masked++
    }
    tables.push(row)
  }
  const unmappedRows = Object.entries(unmapped)
    .map(([raw, rows]) => ({ raw, rows }))
    .sort((a, b) => b.rows - a.rows || a.raw.localeCompare(b.raw))
  return { tables, unmapped: unmappedRows }
}

async function mkWords(store: ReportStore): Promise<BackfillReport['mk_words']> {
  const out: BackfillReport['mk_words'] = { utterances: 0, excluded: 0, by_reason: {}, listed: [] }
  for await (const u of store.mkUtterances()) {
    out.utterances++
    const result = legacyUserText(u.content)
    if (!('excluded' in result)) continue
    out.excluded++
    bump(out.by_reason, result.excluded)
    if (out.listed.length < EXCLUDED_LISTED) out.listed.push({ id: u.id, reason: result.excluded })
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rejection reasons a run's stats record: extraction lists each rejected
 * proposal with its rule; the salvage counts them by reason.
 */
export function rejectionReasons(stats: unknown): Counts {
  const reasons: Counts = {}
  if (!isRecord(stats)) return reasons
  if (Array.isArray(stats.rejected)) {
    for (const r of stats.rejected) bump(reasons, isRecord(r) && typeof r.rule === 'string' ? r.rule : 'unknown')
  }
  if (isRecord(stats.rejected_by_reason)) {
    for (const [reason, n] of Object.entries(stats.rejected_by_reason)) {
      if (typeof n === 'number' && Number.isFinite(n)) bump(reasons, reason, n)
    }
  }
  return reasons
}

async function extraction(store: ReportStore): Promise<BackfillReport['extraction']> {
  const runs = new Map<string, BackfillReport['extraction']['runs'][number]>()
  const rejected = new Map<string, BackfillReport['extraction']['rejected'][number]>()
  for await (const r of store.extractionRuns()) {
    const key = JSON.stringify([r.extractor_version, r.status])
    const run = runs.get(key) ?? { extractor_version: r.extractor_version, status: r.status, runs: 0 }
    run.runs++
    runs.set(key, run)
    for (const [reason, count] of Object.entries(rejectionReasons(r.stats))) {
      const rkey = JSON.stringify([r.extractor_version, reason])
      const entry = rejected.get(rkey) ?? { extractor_version: r.extractor_version, reason, count: 0 }
      entry.count += count
      rejected.set(rkey, entry)
    }
  }
  const byKey = <T extends { extractor_version: string }>(second: (x: T) => string) => (a: T, b: T) =>
    a.extractor_version.localeCompare(b.extractor_version) || second(a).localeCompare(second(b))
  return {
    runs: [...runs.values()].sort(byKey((x) => x.status)),
    rejected: [...rejected.values()].sort(byKey((x) => x.reason)),
    embedded: await store.embeddedByClass(),
  }
}

async function capture(store: ReportStore): Promise<BackfillReport['capture']> {
  const errors = new Map<string, { type: string; error: string; count: number }>()
  for await (const e of store.captureErrors()) {
    const prefix = [...e.error].slice(0, ERROR_PREFIX_CHARS).join('')
    const key = JSON.stringify([e.type, prefix])
    const entry = errors.get(key) ?? { type: e.type, error: prefix, count: 0 }
    entry.count++
    errors.set(key, entry)
  }
  return {
    unprocessed: await store.unprocessedEvents(),
    errors: [...errors.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type) || a.error.localeCompare(b.error)),
  }
}

async function samples(store: ReportStore, seed: number): Promise<Pick<BackfillReport, 'samples' | 'populations'>> {
  const populations = {} as Record<SamplePopulation, number>
  const drawn = {} as Record<SamplePopulation, SampleRow[]>
  for (const population of Object.keys(SAMPLE_SIZES) as SamplePopulation[]) {
    const ids = await store.sampleIds(population)
    populations[population] = new Set(ids).size
    const picked = sampleOf(ids, SAMPLE_SIZES[population], seed)
    drawn[population] = picked.length === 0 ? [] : (await store.itemsByIds(picked)).sort(byTime)
  }
  const evidenceIds = [...new Set(drawn.salvage_observations.flatMap((o) => o.lineage))]
  const evidence = new Map((evidenceIds.length === 0 ? [] : await store.itemsByIds(evidenceIds)).map((r) => [r.id, r]))
  const observations = drawn.salvage_observations.map((o) => ({
    ...o,
    evidence: o.lineage.map((id) => evidence.get(id)).filter((r): r is SampleRow => r !== undefined).sort(byTime),
  }))
  return {
    populations,
    samples: {
      register_candidates: drawn.register_candidates,
      salvage_observations: observations,
      legacy_utterances: drawn.legacy_utterances,
      history_utterances: drawn.history_utterances,
    },
  }
}

/** Reads the store and assembles the report. */
export async function buildReport(store: ReportStore, opts: { seed: number; now: Date }): Promise<BackfillReport> {
  const facets = await facetTotals(store)
  const { tables, unmapped } = await legacyCompleteness(store, facets.legacy)
  const drawn = await samples(store, opts.seed)
  return {
    generated_at: opts.now.toISOString(),
    seed: opts.seed,
    items: facets.items,
    legacy: { tables, procedural_rows: await store.proceduralRows(), fact_supersessions: await store.factSupersessions() },
    mk_words: await mkWords(store),
    invariants: await store.invariantCounts(),
    projects: facets.projects,
    unmapped,
    extraction: await extraction(store),
    capture: await capture(store),
    ...drawn,
  }
}

// --- Markdown ----------------------------------------------------------------

/** One line, whitespace runs collapsed, cut to the sample length. */
export function sampleText(text: string | null): string {
  if (text === null) return '-'
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length <= SAMPLE_TEXT_CHARS ? line : `${chars.slice(0, SAMPLE_TEXT_CHARS).join('')} [cut]`
}

function cell(value: string | number | null): string {
  if (value === null) return '-'
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ')
}

function table(head: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  if (rows.length === 0) return '_none_\n'
  const line = (cells: ReadonlyArray<string | number | null>): string => `| ${cells.map(cell).join(' | ')} |\n`
  return line(head) + `|${head.map(() => ' --- ').join('|')}|\n` + rows.map(line).join('')
}

function sampleBlock(n: number, row: SampleRow, fields: ReadonlyArray<readonly [string, string | null]>): string {
  const head = `${n}. \`${row.id}\` ${row.occurred_at.slice(0, 10)} project=${row.project_id ?? '-'}\n`
  return head + fields.map(([label, text]) => `   - ${label}: ${sampleText(text)}\n`).join('')
}

function samplesSection(r: BackfillReport): string {
  const heading = (title: string, population: SamplePopulation, shown: number): string =>
    `### ${title} (${shown} of ${r.populations[population]})\n\n`
  const plain = (rows: SampleRow[]): string =>
    rows.map((row, i) => sampleBlock(i + 1, row, [['text', row.content]])).join('') || '_none_\n'
  const s = r.samples
  return (
    `## Samples (seed ${r.seed})\n\n` +
    heading('Register candidates', 'register_candidates', s.register_candidates.length) +
    (s.register_candidates
      .map((row, i) => sampleBlock(i + 1, row, [['quote', row.content], ['question', row.context]]))
      .join('') || '_none_\n') +
    '\n' +
    heading('Salvage observations', 'salvage_observations', s.salvage_observations.length) +
    (s.salvage_observations
      .map(
        (o, i) =>
          sampleBlock(i + 1, o, [
            ['claim', o.content],
            ['quote', o.quote],
          ]) +
          (o.evidence.length === 0
            ? '   - evidence: none readable\n'
            : o.evidence.map((e) => `   - evidence \`${e.id}\` ${e.occurred_at.slice(0, 10)}: ${sampleText(e.content)}\n`).join('')),
      )
      .join('') || '_none_\n') +
    '\n' +
    heading('Legacy utterances', 'legacy_utterances', s.legacy_utterances.length) +
    plain(s.legacy_utterances) +
    '\n' +
    heading('History utterances', 'history_utterances', s.history_utterances.length) +
    plain(s.history_utterances)
  )
}

/** The report as markdown. */
export function formatReport(r: BackfillReport): string {
  const violated = r.invariants.filter((i) => i.violations !== 0).length
  const fs = r.legacy.fact_supersessions
  return (
    `# Backfill report\n\nGenerated ${r.generated_at}, sample seed ${r.seed}.\n\n` +
    `## Items by class, kind, source type and time basis\n\n` +
    table(['class', 'kind', 'source.type', 'source.time_basis', 'live', 'forgotten'], r.items.map((i) => [i.class, i.kind, i.source_type, i.time_basis, i.live, i.forgotten])) +
    `\n## Legacy completeness\n\n` +
    table(
      ['old table', 'kind', 'old rows', 'old forgotten', 'items', 'items forgotten', 'not copied', 'masked'],
      r.legacy.tables.map((t) => [t.table, t.kind, t.old_rows, t.old_forgotten, t.items, t.items_forgotten, t.not_copied, t.masked]),
    ) +
    `\nmemory_procedural rows (not copied): ${r.legacy.procedural_rows}\n\n` +
    `Fact supersessions: linked ${fs.linked ?? 0}, not_later ${fs.not_later ?? 0}, pending ${fs.pending ?? 0}, skipped ${fs.skipped ?? 0}\n\n` +
    `## MK utterances the legacy text rule would exclude\n\n` +
    `${r.mk_words.excluded} of ${r.mk_words.utterances} MK utterances (must be 0).\n\n` +
    (r.mk_words.excluded === 0
      ? ''
      : table(['reason', 'count'], Object.entries(r.mk_words.by_reason).sort()) +
        `\n${r.mk_words.listed.map((x) => `- \`${x.id}\` ${x.reason}\n`).join('')}\n`) +
    `## Invariant counts\n\n` +
    `${violated === 0 ? 'Every invariant holds.' : `${violated} invariant(s) violated.`}\n\n` +
    table(['invariant', 'violations'], r.invariants.map((i) => [i.name, i.violations])) +
    `\n## Items per project\n\n` +
    table(['project', 'live', 'forgotten'], r.projects.map((p) => [p.project_id ?? '(none)', p.live, p.forgotten])) +
    `\n## Raw legacy project values left unmapped\n\n` +
    table(['raw value', 'rows'], r.unmapped.map((u) => [u.raw, u.rows])) +
    `\n## Extraction\n\n### Model calls: runs by version and status\n\n` +
    table(['version', 'status', 'runs'], r.extraction.runs.map((x) => [x.extractor_version, x.status, x.runs])) +
    `\n### Rejection reasons\n\n` +
    table(['version', 'reason', 'count'], r.extraction.rejected.map((x) => [x.extractor_version, x.reason, x.count])) +
    `\n### Items embedded by class\n\n` +
    table(['class', 'embedded'], Object.entries(r.extraction.embedded).sort()) +
    `\n## Capture events\n\nUnprocessed: ${r.capture.unprocessed}\n\n### Errors by type\n\n` +
    table(['type', `error (first ${ERROR_PREFIX_CHARS} chars)`, 'count'], r.capture.errors.map((e) => [e.type, e.error, e.count])) +
    `\n${samplesSection(r)}`
  )
}
