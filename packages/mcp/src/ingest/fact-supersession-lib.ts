/**
 * Scan, judge and apply steps for the fact supersession backfill CLI
 * (engram-fact-supersession-cli.ts).
 *
 * Deep sleep retires a stored fact only when a fact consolidated after it
 * conflicts with it and was stated later, so facts stored before the
 * supersession judge existed can still hold several versions of one claim.
 * The backfill replays that decision over the live facts already stored, in
 * two separate steps.
 *
 * Proposing (the dry run) reads every live fact and calls the judge; it never
 * writes:
 *   - each fact's statement time is the time of the conversation it came
 *     from (`statementClock` from core, the helper deep sleep uses), falling
 *     back to the row's insert time when its source digests cannot be read.
 *     Insert time alone cannot order facts: deep sleep re-reads a week of
 *     digests on every run, so a later row can hold an older statement;
 *   - facts are visited latest statement first, and the pool of a fact is the
 *     live facts of its own project (a shared, NULL-project fact pairs only
 *     with shared facts) stated strictly earlier, at cosine >= the floor,
 *     nearest first, at most POOL_MAX;
 *   - the judge names the relation and each fact's kind (state, event or
 *     plan). Every pool fact was stated earlier, so a conflict proposes
 *     retiring the pool fact when core's `supersessionRuleOutcome` allows it:
 *     the pool fact is a state and the fact a state or an event. Any other
 *     conflict is counted and left alone, as are `same` and unrelated facts
 *     (both rows are already stored);
 *   - a fact proposed for retirement is neither judged nor offered again.
 * Each proposal carries both rows' `updated_at` and a hash of their text, so
 * the apply step can tell whether a row changed after it was reviewed.
 *
 * Applying writes exactly the proposals of a reviewed report and calls no
 * judge. A pair is skipped, and listed, when either row is missing, no longer
 * live, or changed since the report. A write sets only `superseded_by` and
 * bumps `updated_at` (how the recall-engine index and the graph reconcile find
 * supersessions), conditional on the old row still being live and unchanged,
 * so clearing `superseded_by` restores the SQL row exactly.
 *
 * Similarity is computed here over the embeddings read once, rather than by
 * a nearest-neighbour query per fact: a global top-k can be filled by other
 * projects' or later facts and miss the earlier same-project neighbours this
 * pass is about.
 *
 * Network access goes through the injected store, clock and judge, so both
 * steps are testable with an in-memory store and a stub judge.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { SUPERSESSION_NEW_FACT_KEY, epochMs, supersessionRuleOutcome, supersessionSettingsFromEnv } from '@engram-mem/core'
import type {
  StatementClock,
  SupersessionCandidate,
  SupersessionFact,
  SupersessionFactKind,
  SupersessionRuleOutcome,
  SupersessionVerdict,
} from '@engram-mem/core'

/** Candidates offered to the judge per fact; matches deep sleep's pool size. */
export const POOL_MAX = 5
/** Lower edges of the reported similarity bands; 0.88 is deep sleep's duplicate cosine. */
export const BAND_EDGES: readonly number[] = [0.7, 0.8, 0.88, 0.95]
/**
 * Facts whose source digests and episodes are read in one batch. Episode rows
 * carry their embeddings, so one batch over every fact would hold the whole
 * episode table in memory.
 */
export const STATEMENT_BATCH = 50

const SEMANTIC_TABLE = 'memory_semantic'
const FACT_COLUMNS = 'id, topic, content, created_at, updated_at, project_id, source_digest_ids, embedding'
const STATE_COLUMNS = 'id, topic, content, updated_at, superseded_by, forgotten_at'
const HASH_PATTERN = /^[0-9a-f]{64}$/

// ---------------------------------------------------------------------------
// Rows and seams
// ---------------------------------------------------------------------------

export interface RawFactRow {
  id: string
  topic: string | null
  content: string | null
  created_at: string
  updated_at: string
  project_id: string | null
  source_digest_ids: string[] | null
  /** pgvector text form "[x,y,...]" from PostgREST, or an array from a stub. */
  embedding: unknown
}

/** A fact row as the apply step re-reads it, live or not. */
export interface FactStateRow {
  id: string
  topic: string | null
  content: string | null
  updated_at: string
  superseded_by: string | null
  forgotten_at: string | null
}

export interface FactSupersessionStore {
  /**
   * Live semantic facts (not superseded, not forgotten) with an embedding,
   * ordered by id, strictly after `afterId`.
   */
  fetchPage(afterId: string | null, pageSize: number): Promise<RawFactRow[]>
  /** The named facts whatever their state; a missing id is absent from the result. */
  fetchRows(ids: ReadonlyArray<string>): Promise<FactStateRow[]>
  /**
   * Point a fact at its replacement and bump its `updated_at`, only while it
   * is live and its `updated_at` is still `expectedUpdatedAt`. Returns false
   * when nothing changed.
   */
  markSuperseded(oldId: string, newId: string, expectedUpdatedAt: string): Promise<boolean>
}

export type SupersessionJudge = (
  fact: SupersessionFact,
  candidates: ReadonlyArray<SupersessionCandidate>,
) => Promise<SupersessionVerdict>

export interface RollbackRow {
  oldId: string
  newId: string
  cosine: number
}

/** Receives each applied pair right after its write succeeds. */
export interface RollbackSink {
  append(row: RollbackRow): void
}

export interface FactBackfillOptions {
  /** The judge is called at most this many times. */
  maxCalls: number
  minCosine: number
  pageSize: number
  /** One line per judge failure; ids only. */
  warn?: (line: string) => void
}

export interface Proposal {
  newId: string
  oldId: string
  cosine: number
  /** Statement times, ISO. */
  newStatedAt: string
  oldStatedAt: string
  /** Each row's `updated_at` as read, verbatim. */
  newUpdatedAt: string
  oldUpdatedAt: string
  /** `factContentHash` of each row's topic and content as read. */
  newContentHash: string
  oldContentHash: string
  projectId: string | null
  /** The judge's kind for each fact; the rule retires only a `state` old fact. */
  newKind: SupersessionFactKind
  oldKind: SupersessionFactKind
}

export interface BandSummary {
  band: string
  /** Candidate pairs offered to the judge in this band. */
  pairs: number
  /** Conflicting pairs the kind rule lets retire, proposed for retirement. */
  proposals: number
}

export interface FactBackfillResult {
  /** Live facts read with a usable embedding and statement time. */
  scanned: number
  /** Live rows skipped because their embedding or statement time did not parse. */
  unusable: number
  calls: number
  judgeErrors: number
  /** True when a fact still needed a judgement after `maxCalls` calls. */
  stoppedAtCap: boolean
  proposals: Proposal[]
  /** Every conflict the judge named, by what the kind rule made of it. */
  ruleOutcomes: Record<SupersessionRuleOutcome, number>
  bands: BandSummary[]
  /** Topic and content of every fact named in a proposal, for the local report only. */
  texts: ReadonlyMap<string, { topic: string; content: string }>
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface Fact {
  id: string
  topic: string
  content: string
  statedAt: number
  updatedAt: string
  contentHash: string
  projectId: string | null
  vector: number[]
  norm: number
}

/** sha256 over topic and content; a missing value hashes as the empty string. */
export function factContentHash(topic: string | null, content: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([topic ?? '', content ?? '']))
    .digest('hex')
}

export function parseEmbedding(v: unknown): number[] | null {
  let arr: unknown = v
  if (typeof v === 'string') {
    if (!v.startsWith('[') || !v.endsWith(']')) return null
    try {
      arr = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null
  return arr.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (arr as number[]) : null
}

function norm(v: readonly number[]): number {
  let s = 0
  for (const x of v) s += x * x
  return Math.sqrt(s)
}

function cosine(a: Fact, b: Fact): number {
  if (a.vector.length !== b.vector.length || a.norm === 0 || b.norm === 0) return -1
  let dot = 0
  for (let i = 0; i < a.vector.length; i++) dot += a.vector[i]! * b.vector[i]!
  return dot / (a.norm * b.norm)
}

export function similarityBand(c: number): string {
  const fmt = (x: number) => x.toFixed(2)
  if (c < BAND_EDGES[0]!) return `<${fmt(BAND_EDGES[0]!)}`
  for (let i = 1; i < BAND_EDGES.length; i++) {
    if (c < BAND_EDGES[i]!) return `${fmt(BAND_EDGES[i - 1]!)}-${fmt(BAND_EDGES[i]!)}`
  }
  return `>=${fmt(BAND_EDGES[BAND_EDGES.length - 1]!)}`
}

function allBands(): string[] {
  return [-1, ...BAND_EDGES].map((edge) => similarityBand(edge))
}

/** Latest statement first; equal times in descending id order, so the order is total. */
function latestStatementFirst(a: Fact, b: Fact): number {
  return b.statedAt - a.statedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

async function toFacts(rows: readonly RawFactRow[], clock: StatementClock): Promise<{ facts: Fact[]; unusable: number }> {
  const withVectors = rows.flatMap((row) => {
    const vector = parseEmbedding(row.embedding)
    return vector ? [{ row, vector }] : []
  })
  let unusable = rows.length - withVectors.length
  const facts: Fact[] = []
  for (let i = 0; i < withVectors.length; i += STATEMENT_BATCH) {
    const batch = withVectors.slice(i, i + STATEMENT_BATCH)
    // One clock call over the batch's digests fills its cache for the per-fact calls.
    await clock(batch.flatMap(({ row }) => row.source_digest_ids ?? []))
    for (const { row, vector } of batch) {
      // Insert time is never earlier than the statement, so it stands in
      // when the source digests cannot be read.
      const statedAt = (await clock(row.source_digest_ids ?? [])) ?? epochMs(row.created_at)
      if (statedAt === null) {
        unusable++
        continue
      }
      facts.push({
        id: row.id,
        topic: row.topic ?? '',
        content: row.content ?? '',
        statedAt,
        updatedAt: row.updated_at,
        contentHash: factContentHash(row.topic, row.content),
        projectId: row.project_id ?? null,
        vector,
        norm: norm(vector),
      })
    }
  }
  return { facts, unusable }
}

/**
 * PostgREST truncates a response at its max-rows setting without saying so,
 * so only an empty page ends the walk; a short page may just be the cap.
 */
async function loadLiveFacts(
  store: FactSupersessionStore,
  clock: StatementClock,
  pageSize: number,
): Promise<{ facts: Fact[]; unusable: number }> {
  const facts: Fact[] = []
  let unusable = 0
  let after: string | null = null
  for (;;) {
    const page = await store.fetchPage(after, pageSize)
    if (page.length === 0) return { facts, unusable }
    const parsed = await toFacts(page, clock)
    facts.push(...parsed.facts)
    unusable += parsed.unusable
    after = page[page.length - 1]!.id
  }
}

interface PoolEntry {
  fact: Fact
  cosine: number
}

/** `earlier` is the fact's project list after it, latest statement first. */
function earlierPool(fact: Fact, earlier: readonly Fact[], retired: ReadonlySet<string>, minCosine: number): PoolEntry[] {
  const pool: PoolEntry[] = []
  for (const other of earlier) {
    if (other.statedAt >= fact.statedAt || retired.has(other.id)) continue
    const c = cosine(fact, other)
    if (c >= minCosine) pool.push({ fact: other, cosine: c })
  }
  return pool.sort((a, b) => b.cosine - a.cosine).slice(0, POOL_MAX)
}

function groupByProject(facts: readonly Fact[]): Map<string | null, Fact[]> {
  const groups = new Map<string | null, Fact[]>()
  for (const fact of facts) {
    const list = groups.get(fact.projectId)
    if (list) list.push(fact)
    else groups.set(fact.projectId, [fact])
  }
  return groups
}

const iso = (ms: number): string => new Date(ms).toISOString()

function proposalOf(
  fact: Fact,
  entry: PoolEntry,
  newKind: SupersessionFactKind,
  oldKind: SupersessionFactKind,
): Proposal {
  return {
    newId: fact.id,
    oldId: entry.fact.id,
    cosine: entry.cosine,
    newStatedAt: iso(fact.statedAt),
    oldStatedAt: iso(entry.fact.statedAt),
    newUpdatedAt: fact.updatedAt,
    oldUpdatedAt: entry.fact.updatedAt,
    newContentHash: fact.contentHash,
    oldContentHash: entry.fact.contentHash,
    projectId: fact.projectId,
    newKind,
    oldKind,
  }
}

// ---------------------------------------------------------------------------
// Proposing (dry run)
// ---------------------------------------------------------------------------

/** Judges the live facts and returns the proposed retirements; never writes. */
export async function runFactSupersessionBackfill(
  store: FactSupersessionStore,
  judge: SupersessionJudge,
  clock: StatementClock,
  opts: FactBackfillOptions,
): Promise<FactBackfillResult> {
  if (!Number.isInteger(opts.maxCalls) || opts.maxCalls <= 0) {
    throw new Error(`maxCalls must be a positive integer, got ${opts.maxCalls}`)
  }

  const { facts, unusable } = await loadLiveFacts(store, clock, opts.pageSize)
  const ordered = [...facts].sort(latestStatementFirst)
  const byProject = groupByProject(ordered)
  const indexInProject = new Map<string, number>()
  for (const list of byProject.values()) list.forEach((f, i) => indexInProject.set(f.id, i))

  const retired = new Set<string>()
  const bandCounts = new Map(allBands().map((b) => [b, { pairs: 0, proposals: 0 }]))
  const proposals: Proposal[] = []
  const texts = new Map<string, { topic: string; content: string }>()
  let calls = 0
  let judgeErrors = 0
  let stoppedAtCap = false
  const ruleOutcomes: Record<SupersessionRuleOutcome, number> = {
    retire: 0,
    'kept-earlier-not-state': 0,
    'kept-later-not-current': 0,
  }

  for (const fact of ordered) {
    if (retired.has(fact.id)) continue
    const projectFacts = byProject.get(fact.projectId)!
    const earlier = projectFacts.slice(indexInProject.get(fact.id)! + 1)
    const pool = earlierPool(fact, earlier, retired, opts.minCosine)
    if (pool.length === 0) continue
    if (calls >= opts.maxCalls) {
      stoppedAtCap = true
      break
    }
    calls++
    for (const entry of pool) bandCounts.get(similarityBand(entry.cosine))!.pairs++

    let verdict: SupersessionVerdict
    try {
      verdict = await judge(
        { topic: fact.topic, content: fact.content, statedAt: iso(fact.statedAt) },
        pool.map((e) => ({ id: e.fact.id, topic: e.fact.topic, content: e.fact.content, statedAt: iso(e.fact.statedAt) })),
      )
    } catch (err) {
      judgeErrors++
      opts.warn?.(`judge failed for fact ${fact.id} (${pool.length} candidates): ${err instanceof Error ? err.name : 'error'}`)
      continue
    }

    // Every pool fact was stated earlier than `fact`: a conflict retires the
    // pool fact when it is a state and `fact` a state or an event.
    const conflicts = new Set(verdict.conflicts)
    const kinds = verdict.kinds ?? {}
    const newKind = kinds[SUPERSESSION_NEW_FACT_KEY]
    for (const entry of pool) {
      if (!conflicts.has(entry.fact.id) || retired.has(entry.fact.id)) continue
      const oldKind = kinds[entry.fact.id]
      const outcome = supersessionRuleOutcome(oldKind, newKind)
      ruleOutcomes[outcome]++
      if (outcome !== 'retire') continue
      retired.add(entry.fact.id)
      bandCounts.get(similarityBand(entry.cosine))!.proposals++
      proposals.push(proposalOf(fact, entry, newKind!, oldKind!))
      texts.set(fact.id, { topic: fact.topic, content: fact.content })
      texts.set(entry.fact.id, { topic: entry.fact.topic, content: entry.fact.content })
    }
  }

  return {
    scanned: facts.length,
    unusable,
    calls,
    judgeErrors,
    stoppedAtCap,
    proposals,
    ruleOutcomes,
    bands: [...bandCounts].map(([band, c]) => ({ band, ...c })),
    texts,
  }
}

// ---------------------------------------------------------------------------
// Applying a reviewed report
// ---------------------------------------------------------------------------

/** What the apply step needs from a report entry. */
export type ReviewedProposal = Pick<
  Proposal,
  'newId' | 'oldId' | 'cosine' | 'newUpdatedAt' | 'oldUpdatedAt' | 'newContentHash' | 'oldContentHash'
>

export type SkipReason =
  | 'new-missing'
  | 'old-missing'
  | 'new-not-live'
  | 'old-not-live'
  | 'new-changed'
  | 'old-changed'
  /** The old row passed the check but changed before the conditional write. */
  | 'old-changed-during-apply'

export interface SkippedPair {
  newId: string
  oldId: string
  reason: SkipReason
}

export interface ApplyResult {
  /** Proposals in the report. */
  reviewed: number
  applied: number
  skipped: SkippedPair[]
}

function nonEmptyString(entry: Record<string, unknown>, key: string, at: string): string {
  const v = entry[key]
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${at}: ${key} must be a non-empty string`)
  return v
}

function timestamp(entry: Record<string, unknown>, key: string, at: string): string {
  const v = nonEmptyString(entry, key, at)
  if (Number.isNaN(Date.parse(v))) throw new Error(`${at}: ${key} is not a timestamp`)
  return v
}

function contentHash(entry: Record<string, unknown>, key: string, at: string): string {
  const v = entry[key]
  if (typeof v !== 'string' || !HASH_PATTERN.test(v)) throw new Error(`${at}: ${key} must be a sha256 hex digest`)
  return v
}

/**
 * The proposals of a dry-run report (the JSON array `--report` writes).
 * Throws on the first malformed entry, so a bad file fails before any write.
 */
export function parseReviewedProposals(raw: unknown): ReviewedProposal[] {
  if (!Array.isArray(raw)) throw new Error('report must be a JSON array of proposals')
  return raw.map((item, i) => {
    const at = `report entry ${i}`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`${at}: not an object`)
    const entry = item as Record<string, unknown>
    const newId = nonEmptyString(entry, 'newId', at)
    const oldId = nonEmptyString(entry, 'oldId', at)
    if (newId === oldId) throw new Error(`${at}: newId and oldId are the same fact`)
    const cos = entry['cosine']
    if (typeof cos !== 'number' || !Number.isFinite(cos)) throw new Error(`${at}: cosine must be a number`)
    return {
      newId,
      oldId,
      cosine: cos,
      newUpdatedAt: timestamp(entry, 'newUpdatedAt', at),
      oldUpdatedAt: timestamp(entry, 'oldUpdatedAt', at),
      newContentHash: contentHash(entry, 'newContentHash', at),
      oldContentHash: contentHash(entry, 'oldContentHash', at),
    }
  })
}

function rowCheck(
  side: 'new' | 'old',
  row: FactStateRow | undefined,
  updatedAt: string,
  hash: string,
): SkipReason | null {
  if (!row) return `${side}-missing`
  if (row.superseded_by !== null || row.forgotten_at !== null) return `${side}-not-live`
  const changed =
    Date.parse(row.updated_at) !== Date.parse(updatedAt) || factContentHash(row.topic, row.content) !== hash
  return changed ? `${side}-changed` : null
}

/**
 * Writes exactly the reviewed proposals, in report order, with no judge.
 * Each pair is re-read just before its write, so an earlier pair of the same
 * report that retired one of its rows makes it `*-not-live`.
 */
export async function applyReviewedProposals(
  store: FactSupersessionStore,
  proposals: ReadonlyArray<ReviewedProposal>,
  rollback: RollbackSink,
): Promise<ApplyResult> {
  const skipped: SkippedPair[] = []
  let applied = 0
  for (const p of proposals) {
    const rows = new Map((await store.fetchRows([p.newId, p.oldId])).map((r) => [r.id, r]))
    const reason =
      rowCheck('new', rows.get(p.newId), p.newUpdatedAt, p.newContentHash) ??
      rowCheck('old', rows.get(p.oldId), p.oldUpdatedAt, p.oldContentHash) ??
      ((await store.markSuperseded(p.oldId, p.newId, rows.get(p.oldId)!.updated_at))
        ? null
        : 'old-changed-during-apply')
    if (reason) {
      skipped.push({ newId: p.newId, oldId: p.oldId, reason })
      continue
    }
    rollback.append({ oldId: p.oldId, newId: p.newId, cosine: p.cosine })
    applied++
  }
  return { reviewed: proposals.length, applied, skipped }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Ids, cosines, dates, hashes and counts only: safe for stdout. */
export function summaryJson(result: FactBackfillResult, opts: Pick<FactBackfillOptions, 'maxCalls' | 'minCosine'>): string {
  return JSON.stringify(
    {
      mode: 'dry-run',
      maxCalls: opts.maxCalls,
      minCosine: opts.minCosine,
      scanned: result.scanned,
      unusable: result.unusable,
      calls: result.calls,
      judgeErrors: result.judgeErrors,
      stoppedAtCap: result.stoppedAtCap,
      ruleOutcomes: result.ruleOutcomes,
      bands: result.bands,
      proposals: result.proposals.map((p) => ({ ...p, cosine: Number(p.cosine.toFixed(6)) })),
    },
    null,
    2,
  )
}

/** Ids, reasons and counts only: safe for stdout. */
export function applySummaryJson(result: ApplyResult): string {
  return JSON.stringify({ mode: 'apply', ...result }, null, 2)
}

/** `n` proposals drawn without replacement (all of them when n is null or larger). */
export function sampleProposals(
  proposals: readonly Proposal[],
  n: number | null,
  rng: () => number = Math.random,
): Proposal[] {
  const pick = [...proposals]
  if (n === null || n >= pick.length) return pick
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (pick.length - i))
    ;[pick[i], pick[j]] = [pick[j]!, pick[i]!]
  }
  return pick.slice(0, n)
}

export interface ReportEntry extends Proposal {
  newTopic: string
  newContent: string
  oldTopic: string
  oldContent: string
}

/** Proposals with both facts' text, for the operator's local review file. */
export function reportEntries(result: FactBackfillResult, chosen: readonly Proposal[]): ReportEntry[] {
  return chosen.map((p) => {
    const n = result.texts.get(p.newId) ?? { topic: '', content: '' }
    const o = result.texts.get(p.oldId) ?? { topic: '', content: '' }
    return { ...p, newTopic: n.topic, newContent: n.content, oldTopic: o.topic, oldContent: o.content }
  })
}

export const ROLLBACK_HEADER = 'old_id,new_id,cosine'

export function rollbackLine(row: RollbackRow): string {
  return `${row.oldId},${row.newId},${row.cosine.toFixed(6)}`
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export class UsageError extends Error {}

export type CliOptions =
  | {
      mode: 'dry-run'
      maxCalls: number
      reportPath: string | null
      sample: number | null
      minCosine: number
      pageSize: number
    }
  | { mode: 'apply'; fromReportPath: string; rollbackPath: string }

const DRY_RUN_ONLY = ['--max-calls', '--report', '--sample', '--min-cosine', '--page-size'] as const

function positiveInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${flag} requires a positive integer, got ${raw === undefined ? '(missing value)' : `"${raw}"`}`)
  }
  return n
}

function cosineFlag(raw: string | undefined): number {
  const n = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n) || n < -1 || n > 1) {
    throw new UsageError(`--min-cosine requires a number in [-1, 1], got ${raw === undefined ? '(missing value)' : `"${raw}"`}`)
  }
  return n
}

function pathFlag(raw: string | undefined, flag: string): string {
  if (!raw || raw.startsWith('--')) throw new UsageError(`${flag} requires a path`)
  return raw
}

/**
 * `--apply` writes only from a reviewed report and takes no judge flags; a
 * dry run judges and writes nothing to the database. Output files must be new.
 */
export function parseFactSupersessionArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): CliOptions {
  const values = new Map<string, string>()
  let apply = false
  const takesValue = new Set(['--from-report', '--rollback', ...DRY_RUN_ONLY])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--apply') apply = true
    else if (takesValue.has(a)) values.set(a, argv[++i] ?? '')
    else throw new UsageError(`unknown argument "${a}"`)
  }
  const raw = (flag: string) => (values.has(flag) ? values.get(flag) : undefined)
  const newFile = (flag: string): string | null => {
    if (!values.has(flag)) return null
    const path = pathFlag(raw(flag), flag)
    if (exists(path)) throw new UsageError(`${flag} ${path} already exists; name a new file`)
    return path
  }

  if (apply) {
    const misplaced = DRY_RUN_ONLY.filter((f) => values.has(f))
    if (misplaced.length > 0) {
      throw new UsageError(`${misplaced.join(', ')} apply only to a dry run; --apply writes the report as reviewed`)
    }
    if (!values.has('--from-report')) throw new UsageError('--apply requires --from-report PATH (a dry-run report)')
    const fromReportPath = pathFlag(raw('--from-report'), '--from-report')
    if (!exists(fromReportPath)) throw new UsageError(`--from-report ${fromReportPath} does not exist`)
    const rollbackPath = newFile('--rollback')
    if (!rollbackPath) throw new UsageError('--apply requires --rollback PATH')
    return { mode: 'apply', fromReportPath, rollbackPath }
  }

  if (values.has('--from-report')) throw new UsageError('--from-report is only read with --apply')
  if (values.has('--rollback')) throw new UsageError('--rollback is only written with --apply')
  if (!values.has('--max-calls')) throw new UsageError('--max-calls is required for a dry run')
  const reportPath = newFile('--report')
  const sample = values.has('--sample') ? positiveInt(raw('--sample'), '--sample') : null
  if (sample !== null && !reportPath) throw new UsageError('--sample requires --report PATH')
  return {
    mode: 'dry-run',
    maxCalls: positiveInt(raw('--max-calls'), '--max-calls'),
    reportPath,
    sample,
    minCosine: values.has('--min-cosine') ? cosineFlag(raw('--min-cosine')) : supersessionSettingsFromEnv(env).minCosine,
    pageSize: values.has('--page-size') ? positiveInt(raw('--page-size'), '--page-size') : 500,
  }
}

// ---------------------------------------------------------------------------
// PostgREST store
// ---------------------------------------------------------------------------

export function createPostgrestFactStore(client: PostgrestClient): FactSupersessionStore {
  return {
    async fetchPage(afterId, pageSize) {
      let q = client
        .from(SEMANTIC_TABLE)
        .select(FACT_COLUMNS)
        .is('superseded_by', null)
        .is('forgotten_at', null)
        .not('embedding', 'is', null)
      if (afterId !== null) q = q.gt('id', afterId)
      const { data, error } = await q.order('id', { ascending: true }).limit(pageSize)
      if (error) throw new Error(`fetch live facts failed: ${error.message}`)
      return (data ?? []) as unknown as RawFactRow[]
    },

    async fetchRows(ids) {
      if (ids.length === 0) return []
      const { data, error } = await client.from(SEMANTIC_TABLE).select(STATE_COLUMNS).in('id', [...ids])
      if (error) throw new Error(`fetch facts ${ids.join(', ')} failed: ${error.message}`)
      return (data ?? []) as unknown as FactStateRow[]
    },

    async markSuperseded(oldId, newId, expectedUpdatedAt) {
      // updated_at is how listTombstonesSince finds a supersession; a write
      // without it never leaves the recall-engine index or the graph. The
      // updated_at match makes the write fail when the row changed after it
      // was checked.
      const { data, error } = await client
        .from(SEMANTIC_TABLE)
        .update({ superseded_by: newId, updated_at: new Date().toISOString() })
        .eq('id', oldId)
        .eq('updated_at', expectedUpdatedAt)
        .is('superseded_by', null)
        .is('forgotten_at', null)
        .select('id')
      if (error) throw new Error(`mark ${oldId} superseded by ${newId} failed: ${error.message}`)
      return ((data ?? []) as unknown[]).length > 0
    },
  }
}
