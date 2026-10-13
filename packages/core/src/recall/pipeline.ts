import { extractEntities } from '../extraction/entities.js'
import type { Candidate, CandidateRequest } from '../items/item-store.js'
import { effectiveFilters, type EffectiveFilters } from './channels.js'
import { failureReason } from './failure-reason.js'
import type { FloorCalibration } from './floor-calibration.js'
import { ModelSteps, type ModelStepDeps, type ModelStepVersions } from './model-steps.js'
import { isLookupQuestion, isMultiHop, isTemporal, lexicalTerms } from './query-signals.js'
import { compareShown, fuse, scopeTier, SLATE_SIZE, type Band, type FusedCandidate, type ScopeContext } from './rank.js'
import { resolveItems } from './resolve.js'
import type {
  RecallDegraded,
  RecallItemRow,
  RecallProject,
  RecallRequest,
  RecallResponse,
  RecallStore,
} from './types.js'

/** Candidates per leg asked of the candidate statement. */
const CANDIDATES_PER_LEG = 50
const MAX_TERMS = 64
const DEFAULT_LIMIT = 12

/** The reranker in use, with the id its floor is recorded under. */
export interface RecallReranker {
  id: string
  /** Scores each document against the query on its own; a document past the reranker's cap gets no score. */
  rerank(query: string, documents: ReadonlyArray<{ id: string; content: string }>): Promise<Array<{ id: string; score: number }>>
}

export interface RecallDeps {
  store: RecallStore
  embed(text: string): Promise<number[]>
  rerank: RecallReranker
  expand?: ModelStepDeps['expand']
  hyde?: ModelStepDeps['hyde']
  /** The calendar date the expansion prompt states for an instant. */
  referenceDate(now: Date): string
  /** The measured floor for `rerank.id`; null when none is recorded. */
  floor: FloorCalibration | null
  versions: ModelStepVersions
  now(): Date
}

export interface RecallTimings {
  embed: number
  expand: number
  hyde: number
  candidates: number
  hydrate: number
  rerank: number
  associations: number
  total: number
}

/** What one recall did, for the log line: never the query or item text. */
export interface RecallTrace {
  referenceDate: string
  reranker: string
  floor: number | null
  strong: number | null
  storeVersion: [before: number, after: number]
  steps: { expansion: boolean; hyde: boolean; rescue: boolean }
  projectKnown: boolean
  cacheFailures: number
  counts: { candidates: number; slate: number; scored: number; passed: number }
  timings: RecallTimings
}

/** No floor is recorded for the reranker in use, so no recall can tell relevant from not. */
export class RecallNotCalibratedError extends Error {
  readonly reranker: string

  constructor(reranker: string) {
    super(`recall is not calibrated for reranker ${reranker}`)
    this.name = 'RecallNotCalibratedError'
    this.reranker = reranker
  }
}

/** The request asks for something no recall can answer (a channel rule, an empty filter). */
export class RecallRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecallRequestError'
  }
}

type Settled<T> = { ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number }

async function timed<T>(work: () => Promise<T>): Promise<Settled<T>> {
  const start = performance.now()
  try {
    const value = await work()
    return { ok: true, value, ms: performance.now() - start }
  } catch (error) {
    return { ok: false, error, ms: performance.now() - start }
  }
}

/** One slate item after the reranker: its row, its rerank score (null without a reranker) and fused position. */
export interface ScoredItem {
  row: RecallItemRow
  fusedPosition: number
  score: number | null
}

/** Shared state of one recall while its stages run. */
interface RecallRun {
  deps: RecallDeps
  request: RecallRequest
  steps: ModelSteps
  base: CandidateRequest
  degraded: RecallDegraded
  timings: RecallTimings
}

/** What the model steps and the registry gave before the candidate call. */
interface Inputs {
  queryVector: number[] | null
  phrases: string[]
  hydeEmbedding: number[] | null
  hydeRan: boolean
  expansionRan: boolean
  projects: RecallProject[]
  scopeWorkspace: string | null
}

/**
 * One recall over the typed item store. The steps:
 * 1. Refuse at once when the reranker has no measured floor; read the store version.
 * 2. In parallel: the query embedding; expansion for a temporal, multi-hop or
 *    lookup question; HyDE for a temporal or multi-hop one. All cached.
 * 3. One candidate call with the effective filters.
 * 4. Reciprocal rank fusion; the slate is the first 50.
 * 5. Read the slate's items; rerank each against the query; keep scores at or
 *    above the floor, band A at or above the strong score.
 * 6. Nothing passed and HyDE did not run: run HyDE, call again with its vector
 *    alone, fuse again and rerank the next 50 unscored. At most once.
 * 7. Resolve supersession as of the recall's time: a replaced item gives its
 *    place to its current successor; status and flags.
 * Then apply the limit and read the store version again. A recall writes no
 * item state.
 */
export async function runRecall(deps: RecallDeps, request: RecallRequest): Promise<{ response: RecallResponse; trace: RecallTrace }> {
  const started = performance.now()
  const floor = deps.floor
  if (floor === null) throw new RecallNotCalibratedError(deps.rerank.id)
  const filters = effectiveFilters(request)
  if ('error' in filters) throw new RecallRequestError(filters.error)

  const run = startRun(deps, request, filters)
  const at = request.asOf ?? deps.now()
  const versionBefore = await deps.store.storeVersion()
  const inputs = await gatherInputs(run, at)
  const slate = new Slate(run)
  await slate.add(await firstCandidates(run, inputs))
  let passed = passing(slate, floor)
  const rescue = passed.length === 0 && !slate.rerankFailed && !inputs.hydeRan && inputs.queryVector !== null
  if (rescue) {
    await rescueWithHyde(run, slate)
    passed = passing(slate, floor)
  }

  const scope = scopeOf(request, inputs)
  const ordered = order(passed, floor, slate.rerankFailed, scope)
  const tokens = needsTokens(ordered, slate.rows) ? await deps.store.registerTokens(request.asOf) : []
  const items = resolveItems(ordered, slate.rows, { includeHistory: request.includeHistory === true, filters, tokens }).map((r) => r.item)
  const shown = items.slice(0, request.limit ?? DEFAULT_LIMIT)
  const versionAfter = await deps.store.storeVersion()
  run.timings.total = performance.now() - started

  const response: RecallResponse = {
    items: shown,
    omitted: { limit: items.length - shown.length, budget: 0, uncuttable: 0 },
    ...(Object.keys(run.degraded).length > 0 ? { degraded: run.degraded } : {}),
  }
  const trace: RecallTrace = {
    referenceDate: deps.referenceDate(at),
    reranker: deps.rerank.id,
    floor: floor.floor,
    strong: floor.strong,
    storeVersion: [versionBefore, versionAfter],
    steps: { expansion: inputs.expansionRan, hyde: inputs.hydeRan || rescue, rescue },
    projectKnown: scope.projectKnown,
    cacheFailures: run.steps.cacheFailures,
    counts: { candidates: slate.candidates.length, slate: Math.min(slate.fused.length, SLATE_SIZE), scored: slate.scored.size, passed: passed.length },
    timings: run.timings,
  }
  return { response, trace }
}

function startRun(deps: RecallDeps, request: RecallRequest, filters: EffectiveFilters): RecallRun {
  const steps = new ModelSteps({
    cache: deps.store,
    embed: deps.embed,
    expand: deps.expand,
    hyde: deps.hyde,
    referenceDate: deps.referenceDate,
    versions: deps.versions,
  })
  const timings: RecallTimings = { embed: 0, expand: 0, hyde: 0, candidates: 0, hydrate: 0, rerank: 0, associations: 0, total: 0 }
  return { deps, request, steps, base: candidateFilters(filters, request), degraded: {}, timings }
}

function projectOf(request: RecallRequest): string | undefined {
  return request.scope.atRoot === true ? undefined : request.scope.projectId
}

/** Step 2: the model steps and the registry reads, in parallel. A failed model step degrades; a failed read fails. */
async function gatherInputs(run: RecallRun, at: Date): Promise<Inputs> {
  const { store } = run.deps
  const query = run.request.query
  const temporal = isTemporal(query)
  const multiHop = isMultiHop(query)
  const wantExpansion = temporal || multiHop || isLookupQuestion(query)
  const wantHyde = temporal || multiHop
  const projectId = projectOf(run.request)
  const [vector, expansion, hyde, projects, scopeWorkspace] = await Promise.all([
    timed(() => run.steps.embedQuery(query)),
    wantExpansion ? timed(() => run.steps.expand(query, at)) : null,
    wantHyde ? timed(() => hydeVector(run.steps, query)) : null,
    store.projects(),
    projectId !== undefined && run.request.scope.workspaceId === undefined ? store.projectWorkspace(projectId) : null,
  ])

  run.timings.embed = vector.ms
  let queryVector: number[] | null = null
  if (vector.ok && vector.value.length > 0) queryVector = vector.value
  else run.degraded.vector = vector.ok ? 'embedder returned no vector' : await failureReason(vector.error, 'embedder error')

  let phrases: string[] = []
  if (expansion !== null) {
    run.timings.expand = expansion.ms
    if (expansion.ok) phrases = expansion.value
    else run.degraded.expansion = await failureReason(expansion.error, 'expansion error')
  }
  let hydeEmbedding: number[] | null = null
  if (hyde !== null) {
    run.timings.hyde = hyde.ms
    if (hyde.ok) hydeEmbedding = hyde.value
    else run.degraded.hyde = await failureReason(hyde.error, 'hyde error')
  }
  // Without a query vector the vector legs do not run at all, HyDE's included.
  if (queryVector === null) hydeEmbedding = null
  return { queryVector, phrases, hydeEmbedding, hydeRan: hyde !== null, expansionRan: expansion !== null, projects, scopeWorkspace }
}

/** Step 3: one candidate call with every input that is set. */
async function firstCandidates(run: RecallRun, inputs: Inputs): Promise<Candidate[]> {
  const query = run.request.query
  const terms = [...new Set([...lexicalTerms(query), ...inputs.phrases.flatMap((p) => lexicalTerms(p))])].slice(0, MAX_TERMS)
  const entities = [...new Set(extractEntities(query, inputs.projects).map((e) => e.entity))]
  const result = await timed(() =>
    run.deps.store.candidates({
      ...run.base,
      ...(inputs.queryVector !== null ? { embedding: inputs.queryVector } : {}),
      ...(inputs.hydeEmbedding !== null ? { hydeEmbedding: inputs.hydeEmbedding } : {}),
      ...(terms.length > 0 ? { terms } : {}),
      query,
      ...(entities.length > 0 ? { entities } : {}),
    }),
  )
  run.timings.candidates += result.ms
  if (!result.ok) throw result.error
  return result.value
}

/** Step 6: HyDE's vector alone, fused with what the first call found; the next 50 unscored are reranked. */
async function rescueWithHyde(run: RecallRun, slate: Slate): Promise<void> {
  const rescued = await timed(() => hydeVector(run.steps, run.request.query))
  run.timings.hyde += rescued.ms
  if (!rescued.ok) {
    run.degraded.hyde = await failureReason(rescued.error, 'hyde error')
    return
  }
  if (rescued.value === null) return
  const hydeEmbedding = rescued.value
  const second = await timed(() => run.deps.store.candidates({ ...run.base, hydeEmbedding }))
  run.timings.candidates += second.ms
  if (!second.ok) throw second.error
  await slate.add(second.value.filter((c) => c.leg === 'hyde'))
}

/**
 * Steps 4 and 5: the fused candidates, and the items read and reranked so far.
 * Each `add` fuses the new candidates with the old ones and scores the next 50
 * that have no score yet. A reranker that throws once leaves every later item
 * unscored, in fused order.
 */
class Slate {
  candidates: Candidate[] = []
  fused: FusedCandidate[] = []
  readonly scored = new Map<string, ScoredItem>()
  /** Every row read, chain ends included, by id. */
  readonly rows = new Map<string, RecallItemRow>()
  rerankFailed = false

  constructor(private readonly run: RecallRun) {}

  async add(candidates: readonly Candidate[]): Promise<void> {
    this.candidates = [...this.candidates, ...candidates]
    this.fused = fuse(this.candidates)
    const batch = this.fused.filter((f) => !this.scored.has(f.itemId)).slice(0, SLATE_SIZE)
    if (batch.length === 0) return
    const rows = await this.hydrate(batch.map((f) => f.itemId))
    const position = new Map(this.fused.map((f, i) => [f.itemId, i]))
    const scores = await this.rerank(rows)
    for (const row of rows) {
      // A document past the reranker's cap gets no score, so it does not pass.
      const score = scores === null ? null : (scores.get(row.id) ?? Number.NEGATIVE_INFINITY)
      this.scored.set(row.id, { row, fusedPosition: position.get(row.id) ?? this.fused.length, score })
    }
  }

  private async hydrate(ids: string[]): Promise<RecallItemRow[]> {
    const { request, deps, timings } = this.run
    const result = await timed(() =>
      deps.store.items(ids, {
        ...(request.asOf !== undefined ? { asOf: request.asOf } : {}),
        ...(request.excludeSessionId !== undefined ? { excludeSessionId: request.excludeSessionId } : {}),
      }),
    )
    timings.hydrate += result.ms
    if (!result.ok) throw result.error
    for (const row of result.value) this.rows.set(row.id, row)
    return result.value.filter((row) => row.requested)
  }

  /** Scores by id, or null once the reranker has failed. */
  private async rerank(rows: RecallItemRow[]): Promise<Map<string, number> | null> {
    if (this.rerankFailed || rows.length === 0) return this.rerankFailed ? null : new Map()
    const { deps, request, timings, degraded } = this.run
    const result = await timed(() =>
      deps.rerank.rerank(request.query, rows.map((row) => ({ id: row.id, content: rerankDocument(row) }))),
    )
    timings.rerank += result.ms
    if (result.ok) return new Map(result.value.map((r) => [r.id, r.score]))
    this.rerankFailed = true
    degraded.rerank = await failureReason(result.error, 'rerank error')
    return null
  }
}

/** HyDE's passage embedded, or null when the model wrote no passage. */
async function hydeVector(steps: ModelSteps, query: string): Promise<number[] | null> {
  const passage = await steps.hyde(query)
  if (passage === '') return null
  const vector = await steps.embedHyde(passage)
  return vector.length === 0 ? null : vector
}

function candidateFilters(filters: EffectiveFilters, request: RecallRequest): CandidateRequest {
  const projectId = projectOf(request)
  return {
    classes: filters.classes,
    kinds: filters.kinds,
    ...(filters.maxObservationTrust !== undefined ? { maxObservationTrust: filters.maxObservationTrust } : {}),
    includeHistory: request.includeHistory === true,
    k: CANDIDATES_PER_LEG,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(request.excludeSessionId !== undefined ? { excludeSessionId: request.excludeSessionId } : {}),
    ...(request.asOf !== undefined ? { asOf: request.asOf } : {}),
  }
}

/** What the reranker reads: the subject label, when set, then the search text. */
export function rerankDocument(row: Pick<RecallItemRow, 'subjectLabel' | 'searchHead'>): string {
  return row.subjectLabel !== null && row.subjectLabel !== '' ? `${row.subjectLabel}\n${row.searchHead}` : row.searchHead
}

/** The scored items at or above the floor; every scored item when the reranker failed. */
function passing(slate: Slate, floor: FloorCalibration): ScoredItem[] {
  const all = [...slate.scored.values()]
  return slate.rerankFailed ? all : all.filter((s) => s.score !== null && s.score >= floor.floor)
}

function scopeOf(request: RecallRequest, inputs: Inputs): ScopeContext {
  const projectId = projectOf(request)
  return {
    atRoot: request.scope.atRoot === true,
    ...(projectId !== undefined ? { projectId } : {}),
    projectKnown: projectId === undefined || inputs.projects.some((p) => p.id === projectId),
    workspaceId: request.scope.workspaceId ?? inputs.scopeWorkspace,
    planSlugs: request.scope.planSlugs ?? [],
  }
}

/** Without rerank scores there are no bands: every item sorts as one band, in fused order within its tier and trust. */
function order(passed: ScoredItem[], floor: FloorCalibration, rerankFailed: boolean, scope: ScopeContext): RecallItemRow[] {
  const band = (s: ScoredItem): Band => (rerankFailed || s.score === null || s.score >= floor.strong ? 'A' : 'B')
  return passed
    .map((s) => ({ row: s.row, key: { id: s.row.id, band: band(s), tier: scopeTier(s.row, scope), trust: s.row.trust, score: s.score, fusedPosition: s.fusedPosition, occurredAt: s.row.occurredAt } }))
    .sort((a, b) => compareShown(a.key, b.key))
    .map((x) => x.row)
}

/** Register tokens matter only when a document section can be shown: matched, or the end of a matched chain. */
function needsTokens(ordered: readonly RecallItemRow[], rows: ReadonlyMap<string, RecallItemRow>): boolean {
  return ordered.some((row) => {
    if (row.class === 'document_section') return true
    const end = row.currentId === null ? undefined : rows.get(row.currentId)
    return end?.class === 'document_section'
  })
}
