/**
 * Scan, judge and apply loop for the fact supersession backfill CLI
 * (engram-fact-supersession-cli.ts).
 *
 * Deep sleep retires a stored fact only when a fact consolidated after it
 * replaces it, so facts stored before the supersession judge existed can
 * still hold several versions of one claim. This pass replays that decision
 * over the live facts already stored:
 *   - facts are visited newest first, so each one is judged as the latest
 *     statement on its subject against the facts stored before it;
 *   - the pool of a fact is the live facts in its own project (a shared,
 *     NULL-project fact pairs only with shared facts) that are strictly older
 *     than it, at cosine >= the floor, nearest first, at most POOL_MAX;
 *   - a fact retired earlier in the same pass is neither judged nor offered
 *     as a candidate again, in a dry run as in an apply, so a dry run proposes
 *     exactly what an apply would write.
 *
 * Similarity is computed here over the embeddings read once, rather than by
 * a nearest-neighbour query per fact: a global top-k can be filled by other
 * projects' or newer facts and miss the older same-project neighbours this
 * pass is about.
 *
 * An apply sets only `superseded_by` (and bumps `updated_at`, which is how
 * the recall-engine index and the graph reconcile find supersessions) and
 * only on a row that is still live, so clearing `superseded_by` restores the
 * row exactly. Each write is appended to the rollback sink after it lands.
 *
 * Network access goes through the injected store and judge, so the loop is
 * testable with an in-memory store and a stub judge.
 */
import type { PostgrestClient } from '@supabase/postgrest-js'
import type { SupersessionCandidate, SupersessionFact, SupersessionVerdict } from '@engram-mem/core'

/** Candidates offered to the judge per fact; matches deep sleep's pool size. */
export const POOL_MAX = 5
/** Lower edges of the reported similarity bands; 0.88 is deep sleep's duplicate cosine. */
export const BAND_EDGES: readonly number[] = [0.7, 0.8, 0.88, 0.95]

const SEMANTIC_TABLE = 'memory_semantic'
const FACT_COLUMNS = 'id, topic, content, created_at, project_id, embedding'

// ---------------------------------------------------------------------------
// Rows and seams
// ---------------------------------------------------------------------------

export interface RawFactRow {
  id: string
  topic: string | null
  content: string | null
  created_at: string
  project_id: string | null
  /** pgvector text form "[x,y,...]" from PostgREST, or an array from a stub. */
  embedding: unknown
}

export interface FactSupersessionStore {
  /**
   * Live semantic facts (not superseded, not forgotten) with an embedding,
   * ordered by id, strictly after `afterId`.
   */
  fetchPage(afterId: string | null, pageSize: number): Promise<RawFactRow[]>
  /**
   * Point a still-live fact at its replacement and bump its `updated_at`.
   * Returns false when the row was no longer live, so nothing changed.
   */
  markSuperseded(oldId: string, newId: string): Promise<boolean>
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
  apply: boolean
  /** The judge is called at most this many times. */
  maxCalls: number
  minCosine: number
  pageSize: number
  /** Required with `apply`. */
  rollback?: RollbackSink
  /** One line per judge failure; ids only. */
  warn?: (line: string) => void
}

export interface Proposal {
  newId: string
  oldId: string
  cosine: number
  newCreatedAt: string
  oldCreatedAt: string
  projectId: string | null
}

export interface BandSummary {
  band: string
  /** Candidate pairs offered to the judge in this band. */
  pairs: number
  /** Pairs the judge said the newer fact replaces. */
  proposals: number
}

export interface FactBackfillResult {
  /** Live facts read with a usable embedding and timestamp. */
  scanned: number
  /** Live rows skipped because their embedding or created_at did not parse. */
  unusable: number
  calls: number
  judgeErrors: number
  /** True when a fact still needed a judgement after `maxCalls` calls. */
  stoppedAtCap: boolean
  proposals: Proposal[]
  /** Rows actually written; always 0 in a dry run. */
  applied: number
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
  createdAt: string
  time: number
  projectId: string | null
  vector: number[]
  norm: number
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

function toFact(row: RawFactRow): Fact | null {
  const vector = parseEmbedding(row.embedding)
  const time = Date.parse(row.created_at)
  if (!vector || Number.isNaN(time)) return null
  return {
    id: row.id,
    topic: row.topic ?? '',
    content: row.content ?? '',
    createdAt: row.created_at,
    time,
    projectId: row.project_id ?? null,
    vector,
    norm: norm(vector),
  }
}

/** Newest first; equal timestamps in descending id order, so the order is total. */
function newestFirst(a: Fact, b: Fact): number {
  return b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

/**
 * PostgREST truncates a response at its max-rows setting without saying so,
 * so only an empty page ends the walk; a short page may just be the cap.
 */
async function loadLiveFacts(
  store: FactSupersessionStore,
  pageSize: number,
): Promise<{ facts: Fact[]; unusable: number }> {
  const facts: Fact[] = []
  let unusable = 0
  let after: string | null = null
  for (;;) {
    const page = await store.fetchPage(after, pageSize)
    if (page.length === 0) return { facts, unusable }
    for (const row of page) {
      const fact = toFact(row)
      if (fact) facts.push(fact)
      else unusable++
    }
    after = page[page.length - 1]!.id
  }
}

interface PoolEntry {
  fact: Fact
  cosine: number
}

/** `older` is the fact's project list after it, newest first. */
function olderPool(fact: Fact, older: readonly Fact[], retired: ReadonlySet<string>, minCosine: number): PoolEntry[] {
  const pool: PoolEntry[] = []
  for (const other of older) {
    if (other.time >= fact.time || retired.has(other.id)) continue
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

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

export async function runFactSupersessionBackfill(
  store: FactSupersessionStore,
  judge: SupersessionJudge,
  opts: FactBackfillOptions,
): Promise<FactBackfillResult> {
  if (!Number.isInteger(opts.maxCalls) || opts.maxCalls <= 0) {
    throw new Error(`maxCalls must be a positive integer, got ${opts.maxCalls}`)
  }
  if (opts.apply && !opts.rollback) throw new Error('apply requires a rollback sink')

  const { facts, unusable } = await loadLiveFacts(store, opts.pageSize)
  const ordered = [...facts].sort(newestFirst)
  const byProject = groupByProject(ordered)
  const indexInProject = new Map<string, number>()
  for (const list of byProject.values()) list.forEach((f, i) => indexInProject.set(f.id, i))

  const retired = new Set<string>()
  const bandCounts = new Map(allBands().map((b) => [b, { pairs: 0, proposals: 0 }]))
  const proposals: Proposal[] = []
  const texts = new Map<string, { topic: string; content: string }>()
  let calls = 0
  let judgeErrors = 0
  let applied = 0
  let stoppedAtCap = false

  for (const fact of ordered) {
    if (retired.has(fact.id)) continue
    const projectFacts = byProject.get(fact.projectId)!
    const older = projectFacts.slice(indexInProject.get(fact.id)! + 1)
    const pool = olderPool(fact, older, retired, opts.minCosine)
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
        { topic: fact.topic, content: fact.content, statedAt: fact.createdAt },
        pool.map((e) => ({ id: e.fact.id, topic: e.fact.topic, content: e.fact.content, statedAt: e.fact.createdAt })),
      )
    } catch (err) {
      judgeErrors++
      opts.warn?.(`judge failed for fact ${fact.id} (${pool.length} candidates): ${err instanceof Error ? err.name : 'error'}`)
      continue
    }

    // Every pool fact is older than `fact`, so a conflict retires the pool fact.
    const replaced = new Set(verdict.conflicts)
    for (const entry of pool) {
      if (!replaced.has(entry.fact.id) || retired.has(entry.fact.id)) continue
      retired.add(entry.fact.id)
      bandCounts.get(similarityBand(entry.cosine))!.proposals++
      proposals.push({
        newId: fact.id,
        oldId: entry.fact.id,
        cosine: entry.cosine,
        newCreatedAt: fact.createdAt,
        oldCreatedAt: entry.fact.createdAt,
        projectId: fact.projectId,
      })
      texts.set(fact.id, { topic: fact.topic, content: fact.content })
      texts.set(entry.fact.id, { topic: entry.fact.topic, content: entry.fact.content })
      if (opts.apply && (await store.markSuperseded(entry.fact.id, fact.id))) {
        opts.rollback!.append({ oldId: entry.fact.id, newId: fact.id, cosine: entry.cosine })
        applied++
      }
    }
  }

  return {
    scanned: facts.length,
    unusable,
    calls,
    judgeErrors,
    stoppedAtCap,
    proposals,
    applied,
    bands: [...bandCounts].map(([band, c]) => ({ band, ...c })),
    texts,
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Ids, cosines, dates and counts only: safe for stdout. */
export function summaryJson(result: FactBackfillResult, opts: Pick<FactBackfillOptions, 'apply' | 'maxCalls' | 'minCosine'>): string {
  return JSON.stringify(
    {
      mode: opts.apply ? 'apply' : 'dry-run',
      maxCalls: opts.maxCalls,
      minCosine: opts.minCosine,
      scanned: result.scanned,
      unusable: result.unusable,
      calls: result.calls,
      judgeErrors: result.judgeErrors,
      stoppedAtCap: result.stoppedAtCap,
      applied: result.applied,
      bands: result.bands,
      proposals: result.proposals.map((p) => ({ ...p, cosine: Number(p.cosine.toFixed(6)) })),
    },
    null,
    2,
  )
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

    async markSuperseded(oldId, newId) {
      // updated_at is how listTombstonesSince finds a supersession; a write
      // without it never leaves the recall-engine index or the graph.
      const { data, error } = await client
        .from(SEMANTIC_TABLE)
        .update({ superseded_by: newId, updated_at: new Date().toISOString() })
        .eq('id', oldId)
        .is('superseded_by', null)
        .is('forgotten_at', null)
        .select('id')
      if (error) throw new Error(`mark ${oldId} superseded by ${newId} failed: ${error.message}`)
      return ((data ?? []) as unknown[]).length > 0
    },
  }
}
