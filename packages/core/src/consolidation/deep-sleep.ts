import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter, SupersessionCandidate, SupersessionVerdict } from '../adapters/intelligence.js'
import { SUPERSESSION_NEW_FACT_KEY, isSupersessionFactKind, supersessionRuleOutcome } from '../adapters/intelligence.js'
import type { GraphPort } from '../adapters/graph.js'
import type { ConsolidateResult, SearchResult, SemanticMemory } from '../types.js'
import { extractCounters } from './graph-counters.js'
import { majorityProjectId } from './inherit-project.js'
import { epochMs, statementClock } from './statement-time.js'
import type { StatementClock } from './statement-time.js'

export interface DeepSleepOptions {
  minDigests?: number
  /** Defaults to DEFAULT_SUPERSESSION. Deep sleep reads no environment
   *  variable: a server parses ENGRAM_SUPERSESSION* once at startup with
   *  supersessionSettingsFromEnv and passes the result here. */
  supersession?: SupersessionSettings
}

/**
 * How deep sleep decides that a new semantic fact replaces a stored one.
 * - `regex`: a fixed list of English contradiction pairs.
 * - `llm`: the intelligence adapter's supersession judge, over the new fact's
 *   nearest live neighbours in its own project.
 * - `off`: no stored fact is ever retired.
 */
export type SupersessionMode = 'regex' | 'llm' | 'off'

export interface SupersessionSettings {
  mode: SupersessionMode
  /** Cosine floor for a stored fact to be a neighbour of the new fact. */
  minCosine: number
}

/** Default neighbour cosine floor: on text-embedding-3-small, facts below it
 *  rarely share a subject, so they can neither repeat nor replace each other. */
export const SUPERSESSION_MIN_COSINE = 0.6
/** The settings when none are passed: the regex check, today's behaviour. */
export const DEFAULT_SUPERSESSION: SupersessionSettings = { mode: 'regex', minCosine: SUPERSESSION_MIN_COSINE }
/** Nearest rows read per candidate before the liveness/project/cosine filter. */
const NEIGHBOUR_SCAN = 10
/** Neighbours kept after filtering; bounds the judge prompt. */
const NEIGHBOUR_POOL_MAX = 5

const SUPERSESSION_MODES: ReadonlySet<string> = new Set(['regex', 'llm', 'off'])

/**
 * Read ENGRAM_SUPERSESSION (regex|llm|off, default regex) and
 * ENGRAM_SUPERSESSION_MIN_COSINE (a number in [-1, 1], default 0.6). Unset or
 * empty means the default; any other value throws, naming the variable.
 */
export function supersessionSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SupersessionSettings {
  const rawMode = env['ENGRAM_SUPERSESSION']
  const mode = rawMode === undefined || rawMode.trim() === '' ? 'regex' : rawMode.trim()
  if (!SUPERSESSION_MODES.has(mode)) {
    throw new Error(`ENGRAM_SUPERSESSION must be "regex", "llm" or "off", got "${rawMode}"`)
  }
  const rawCosine = env['ENGRAM_SUPERSESSION_MIN_COSINE']
  let minCosine = SUPERSESSION_MIN_COSINE
  if (rawCosine !== undefined && rawCosine.trim() !== '') {
    minCosine = Number(rawCosine.trim())
    if (!Number.isFinite(minCosine) || minCosine < -1 || minCosine > 1) {
      throw new Error(`ENGRAM_SUPERSESSION_MIN_COSINE must be a number in [-1, 1], got "${rawCosine}"`)
    }
  }
  return { mode: mode as SupersessionMode, minCosine }
}

// ---------------------------------------------------------------------------
// Extraction patterns
// ---------------------------------------------------------------------------

interface KnowledgeCandidate {
  topic: string
  content: string
  fullMatch?: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
  kind: 'semantic' | 'procedural'
  trigger?: string
}

/**
 * Cosine similarity above which a candidate restates an existing memory:
 * on text-embedding-3-small, 0.88 is "same claim, different phrasing".
 */
const DUPLICATE_COSINE = 0.88

/** Equal after trimming, lowercasing and collapsing whitespace. */
function sameContent(a: string, b: string): boolean {
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')
  return norm(a) === norm(b)
}

const SEMANTIC_PATTERNS: Array<{ pattern: RegExp; topic: string; confidence: number }> = [
  { pattern: /I prefer\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I like\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I want\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.85 },
  { pattern: /I don'?t like\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I hate\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /let'?s go with\s+(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /we decided\s+(?:to\s+)?(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /the plan is to\s+(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /my (?:name|email|timezone|location) is\s+(.+?)(?:\.|,|$)/gi, topic: 'personal_info', confidence: 0.9 },
]

const PROCEDURAL_TRIGGER_PATTERNS: Array<{ pattern: RegExp; category: 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention' }> = [
  { pattern: /\bmy workflow is\b(.+)/i, category: 'workflow' },
  { pattern: /\bi usually\b(.+)/i, category: 'habit' },
  { pattern: /\bmy process is\b(.+)/i, category: 'workflow' },
  { pattern: /\bi always\b(.+)/i, category: 'habit' },
  { pattern: /\bbefore (?:i|we) \w+,\s*(?:i|we)\b(.+)/i, category: 'workflow' },
  { pattern: /\bafter (?:i|we) \w+,\s*(?:i|we)\b(.+)/i, category: 'workflow' },
  { pattern: /\bnever use\b(.+)/i, category: 'convention' },
  { pattern: /\balways run\b(.+)/i, category: 'convention' },
  { pattern: /\bmake sure to\b(.+)/i, category: 'convention' },
]

const CONTRADICTION_PAIRS: Array<[RegExp, RegExp]> = [
  [/I prefer\s+(.+)/i, /I don'?t like\s+(.+)/i],
  [/I like\s+(.+)/i, /I hate\s+(.+)/i],
  [/I like\s+(.+)/i, /I don'?t like\s+(.+)/i],
  [/I always\s+(.+)/i, /I never\s+(.+)/i],
  [/I don'?t like\s+(.+)/i, /I prefer\s+(.+)/i],
  [/I don'?t like\s+(.+)/i, /I like\s+(.+)/i],
  [/I hate\s+(.+)/i, /I like\s+(.+)/i],
  [/I hate\s+(.+)/i, /I prefer\s+(.+)/i],
  [/I never\s+(.+)/i, /I always\s+(.+)/i],
]

function subjectsOverlap(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  let overlap = 0
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++
  }
  const maxSize = Math.max(wordsA.size, wordsB.size)
  if (maxSize === 0) return false
  return overlap / maxSize > 0.5
}

function extractCandidatesFromText(text: string, digestId: string): KnowledgeCandidate[] {
  const candidates: KnowledgeCandidate[] = []
  const seen = new Set<string>()

  for (const { pattern, category } of PROCEDURAL_TRIGGER_PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) {
      const procedure = match[1].trim()
      if (procedure.length < 3) continue
      const key = `procedural:${category}:${procedure}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        topic: category,
        content: procedure,
        confidence: 0.85,
        sourceDigestIds: [digestId],
        sourceEpisodeIds: [],
        kind: 'procedural',
        trigger: category,
      })
    }
  }

  for (const { pattern, topic, confidence } of SEMANTIC_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const content = match[1].trim()
      if (content.length < 3) continue
      const key = `semantic:${topic}:${content}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        topic,
        content,
        fullMatch: match[0].trim(),
        confidence,
        sourceDigestIds: [digestId],
        sourceEpisodeIds: [],
        kind: 'semantic',
      })
    }
  }

  return candidates
}

function detectSupersession(newPhrase: string, existingContent: string): boolean {
  for (const [patternA, patternB] of CONTRADICTION_PAIRS) {
    const newMatchA = newPhrase.match(patternA)
    const existMatchB = existingContent.match(patternB)
    if (newMatchA && existMatchB) {
      if (subjectsOverlap(newMatchA[1], existMatchB[1])) return true
    }
  }
  return false
}

type SemanticNeighbour = SearchResult<SemanticMemory>

/** Outcome for one semantic candidate: boost a stored duplicate; insert the
 *  candidate and retire the listed stored facts; drop a candidate that a
 *  later stored statement contradicts (`stale`); or leave a conflict between
 *  two statements of the same time unresolved (`tie`). */
type SemanticDecision =
  | { kind: 'duplicate'; id: string }
  | { kind: 'insert'; supersededIds: string[] }
  | { kind: 'stale' }
  | { kind: 'tie' }

/** Stores without project tags report undefined; that is the shared scope. */
function inProject(memory: SemanticMemory, projectId: string | null): boolean {
  return (memory.projectId ?? null) === projectId
}

/**
 * Live stored facts in the candidate's project at cosine >= minCosine, nearest
 * first, at most NEIGHBOUR_POOL_MAX. A shared (NULL-project) candidate pairs
 * only with shared facts, so one project's fact never repeats or replaces
 * another project's.
 */
function neighbourPool(
  nearest: ReadonlyArray<SemanticNeighbour>,
  projectId: string | null,
  minCosine: number,
): SemanticNeighbour[] {
  return nearest
    .filter(e => e.item.supersededBy == null && inProject(e.item, projectId) && e.similarity >= minCosine)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, NEIGHBOUR_POOL_MAX)
}

/** A stored fact that restates the candidate: a near-identical vector in the
 *  pool, else (no vector available) text equal after normalisation. */
function findDuplicate(
  content: string,
  pool: ReadonlyArray<SemanticNeighbour>,
  scopedExisting: ReadonlyArray<SemanticNeighbour>,
): string | undefined {
  return (
    pool.find(e => e.similarity > DUPLICATE_COSINE) ??
    scopedExisting.find(e => sameContent(e.item.content, content))
  )?.item.id
}

/** The regex path, and with `retire` false the no-supersession path. */
function ruleDecision(
  candidate: KnowledgeCandidate,
  pool: ReadonlyArray<SemanticNeighbour>,
  scopedExisting: ReadonlyArray<SemanticNeighbour>,
  existing: ReadonlyArray<SemanticNeighbour>,
  retire: boolean,
): SemanticDecision {
  const duplicateId = findDuplicate(candidate.content, pool, scopedExisting)
  if (duplicateId) return { kind: 'duplicate', id: duplicateId }
  if (!retire) return { kind: 'insert', supersededIds: [] }
  const phrase = candidate.fullMatch ?? candidate.content
  const contradicted = existing.find(e => detectSupersession(phrase, e.item.content))
  return { kind: 'insert', supersededIds: contradicted ? [contradicted.item.id] : [] }
}

/**
 * The pool as stored. findNearest rows can be partial (PostgREST's vector
 * recall maps no topic and no source digests) and a row may have been
 * retired since it was read, so rows are read again by id and filtered again.
 */
async function rereadPool(
  storage: StorageAdapter,
  pool: ReadonlyArray<SemanticNeighbour>,
  projectId: string | null,
): Promise<SemanticNeighbour[]> {
  if (pool.length === 0) return []
  const rows = await storage.getByIds(pool.map(e => ({ id: e.item.id, type: 'semantic' as const })))
  const stored = new Map<string, SemanticMemory>()
  for (const m of rows) {
    if (m.type === 'semantic') stored.set(m.data.id, m.data)
  }
  return pool.flatMap(e => {
    const item = stored.get(e.item.id)
    return item && item.supersededBy == null && inProject(item, projectId) ? [{ item, similarity: e.similarity }] : []
  })
}

/** Statement times of the pool's facts. A fact whose source digests cannot
 *  be read falls back to its insert time, which is never earlier than the
 *  time it was stated. */
async function poolStatementTimes(
  clock: StatementClock,
  pool: ReadonlyArray<SemanticNeighbour>,
): Promise<Map<string, number | null>> {
  // One call over every digest fills the clock's cache for the per-fact calls.
  await clock(pool.flatMap(e => e.item.sourceDigestIds))
  const times = new Map<string, number | null>()
  for (const e of pool) {
    times.set(e.item.id, (await clock(e.item.sourceDigestIds)) ?? epochMs(e.item.createdAt))
  }
  return times
}

/** Sign of a - b; an unknown time on either side compares as equal. */
function compareStatementTimes(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0
  return Math.sign(a - b)
}

const asDate = (ms: number | null): Date | null => (ms === null ? null : new Date(ms))

/** What the judged conflicts allow, before the duplicate check. */
interface ConflictResolution {
  /** A later stored statement ends the candidate. */
  stale: boolean
  /** A conflict between two current-state facts of the same statement time. */
  tie: boolean
  /** Stored facts the candidate retires. */
  retire: string[]
  /** Conflicts the kind rule leaves alone: no fact is stored or retired for them. */
  keptNotState: number
  /** Conflicts left alone because either fact's kind is missing or invalid. */
  kindMissing: number
}

/**
 * Applies the statement-time direction and the kind rule to each conflict.
 * Only a `state` can be retired, and only by a `state` or an `event` stated
 * after it: an event stays true of its time, and a plan ends nothing. An
 * unknown or invalid kind is neither; such a conflict is counted in
 * `kindMissing`, apart from the rule's own outcomes. At the same (or an
 * unknown) time the direction is open, so the pair is a tie only when both
 * facts are states, the one pair the rule retires in either direction.
 */
function resolveConflicts(
  conflicts: ReadonlyArray<string>,
  kinds: SupersessionVerdict['kinds'] | undefined,
  candidateStatedAt: number | null,
  storedStatedAt: ReadonlyMap<string, number | null>,
): ConflictResolution {
  const newKind = kinds?.[SUPERSESSION_NEW_FACT_KEY]
  const out: ConflictResolution = { stale: false, tie: false, retire: [], keptNotState: 0, kindMissing: 0 }
  for (const id of conflicts) {
    const storedKind = kinds?.[id]
    if (!isSupersessionFactKind(newKind) || !isSupersessionFactKind(storedKind)) {
      out.kindMissing++
      continue
    }
    const order = compareStatementTimes(candidateStatedAt, storedStatedAt.get(id) ?? null)
    const retires =
      order > 0
        ? supersessionRuleOutcome(storedKind, newKind) === 'retire'
        : order < 0
          ? supersessionRuleOutcome(newKind, storedKind) === 'retire'
          : newKind === 'state' && storedKind === 'state'
    if (!retires) out.keptNotState++
    else if (order > 0) out.retire.push(id)
    else if (order < 0) out.stale = true
    else out.tie = true
  }
  return out
}

/**
 * The judge names the relation and the kinds; the statement times decide
 * the direction (see resolveConflicts). A conflict the kind rule lets a
 * later stored statement win makes the candidate stale, a state/state
 * conflict of the same time is left alone, and otherwise the candidate
 * retires every stored fact the rule lets it retire.
 * A conflicting pair is never a near-duplicate, so a kept conflict is stored
 * as a new fact even above DUPLICATE_COSINE. Because the judge runs before
 * the duplicate check, an update that differs from the stored fact by a word
 * is not dropped as its duplicate. Identical text cannot conflict, so a
 * stored fact whose text equals the candidate's is never taken as a conflict
 * and stays a duplicate whatever the judge said. Verdict ids outside the pool
 * are ignored. Throws when the judge does.
 */
async function judgedDecision(
  judge: NonNullable<IntelligenceAdapter['judgeSupersession']>,
  candidate: KnowledgeCandidate,
  candidateStatedAt: number | null,
  pool: ReadonlyArray<SemanticNeighbour>,
  storedStatedAt: ReadonlyMap<string, number | null>,
  scopedExisting: ReadonlyArray<SemanticNeighbour>,
): Promise<{ decision: SemanticDecision; counts: KeptConflictCounts }> {
  const candidates: SupersessionCandidate[] = pool.map(e => ({
    id: e.item.id,
    topic: e.item.topic,
    content: e.item.content,
    statedAt: asDate(storedStatedAt.get(e.item.id) ?? null),
  }))
  const verdict = await judge(
    { topic: candidate.topic, content: candidate.content, statedAt: asDate(candidateStatedAt) },
    candidates,
  )
  const poolIds = new Set(candidates.map(c => c.id))
  const identical = new Set(pool.filter(e => sameContent(e.item.content, candidate.content)).map(e => e.item.id))
  const conflicts = [...new Set(verdict.conflicts.filter(id => poolIds.has(id) && !identical.has(id)))]
  const resolved = resolveConflicts(conflicts, verdict.kinds, candidateStatedAt, storedStatedAt)
  const counts = { keptNotState: resolved.keptNotState, kindMissing: resolved.kindMissing }
  if (resolved.stale) return { decision: { kind: 'stale' }, counts }
  if (resolved.tie) return { decision: { kind: 'tie' }, counts }
  if (resolved.retire.length > 0) return { decision: { kind: 'insert', supersededIds: resolved.retire }, counts }
  const conflicting = new Set(conflicts)
  const sameId = verdict.same.find(id => poolIds.has(id) && !conflicting.has(id))
  // Conflicting neighbours leave only the cosine part of the check; the
  // exact-text part also reads the re-read pool, which holds the rows the
  // judge saw.
  const duplicateId =
    sameId ??
    findDuplicate(candidate.content, pool.filter(e => !conflicting.has(e.item.id)), [...scopedExisting, ...pool])
  if (duplicateId) return { decision: { kind: 'duplicate', id: duplicateId }, counts }
  return { decision: { kind: 'insert', supersededIds: [] }, counts }
}

/** Judged conflicts that changed nothing, by why. */
interface KeptConflictCounts {
  keptNotState: number
  kindMissing: number
}

const NO_KEPT_CONFLICTS: KeptConflictCounts = { keptNotState: 0, kindMissing: 0 }

interface JudgeContext {
  storage: StorageAdapter
  judge: NonNullable<IntelligenceAdapter['judgeSupersession']>
  clock: StatementClock
  projectId: string | null
}

/** llm mode with a judge and a candidate vector. `judged` is true when the
 *  judge was called. A judge failure takes the regex path for this
 *  candidate; a storage failure propagates as it does elsewhere here. */
async function llmDecision(
  ctx: JudgeContext,
  candidate: KnowledgeCandidate,
  nearestPool: ReadonlyArray<SemanticNeighbour>,
  scopedExisting: ReadonlyArray<SemanticNeighbour>,
  existing: ReadonlyArray<SemanticNeighbour>,
): Promise<{ decision: SemanticDecision; judged: boolean; counts: KeptConflictCounts }> {
  const pool = await rereadPool(ctx.storage, nearestPool, ctx.projectId)
  if (pool.length === 0) {
    return { decision: ruleDecision(candidate, pool, scopedExisting, existing, false), judged: false, counts: NO_KEPT_CONFLICTS }
  }
  const candidateStatedAt = await ctx.clock(candidate.sourceDigestIds)
  const storedStatedAt = await poolStatementTimes(ctx.clock, pool)
  try {
    const judged = await judgedDecision(ctx.judge, candidate, candidateStatedAt, pool, storedStatedAt, scopedExisting)
    return { ...judged, judged: true }
  } catch {
    console.warn(
      `[deep-sleep] supersession judge failed; regex path for neighbours ${pool.map(e => e.item.id).join(',')}`,
    )
    return { decision: ruleDecision(candidate, pool, scopedExisting, existing, true), judged: true, counts: NO_KEPT_CONFLICTS }
  }
}

/**
 * Deep Sleep (Weekly) — Digests -> Semantic + Procedural.
 *
 * Brain analogy: Slow-wave sleep. Transfers hippocampal memories to neocortex,
 * extracting facts, patterns, and procedural rules.
 *
 * Neo4j operations (when graph is available):
 * - Creates Semantic/Procedural Memory nodes
 * - DERIVES_FROM edges to source digests
 * - Transitive context inheritance with MAX weight attenuation
 * - CONTRADICTS relationships on supersession
 * - Temporal validity (validFrom from earliest source episode)
 */
export async function deepSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  opts?: DeepSleepOptions,
  graph?: GraphPort | null,
): Promise<ConsolidateResult> {
  const minDigests = opts?.minDigests ?? 3
  const supersession = opts?.supersession ?? DEFAULT_SUPERSESSION

  // Oldest first, so within a run a fact is stored before the facts stated
  // after it are judged against it. getRecent returns newest first.
  const digests = [...await storage.digests.getRecent(7)]
    .sort((a, b) => (epochMs(a.createdAt) ?? 0) - (epochMs(b.createdAt) ?? 0))

  if (digests.length < minDigests) {
    return {
      cycle: 'deep', promoted: 0, procedural: 0, deduplicated: 0, superseded: 0,
      supersessionJudged: 0, stale: 0, tie: 0, keptNotState: 0, kindMissing: 0,
    }
  }

  const graphAvailable = graph?.runCypherWrite && await graph.isAvailable().catch(() => false)

  let promoted = 0
  let procedural = 0
  let deduplicated = 0
  let superseded = 0
  let supersessionJudged = 0
  let stale = 0
  let tie = 0
  let keptNotState = 0
  let kindMissing = 0
  let graphNodesCreated = 0
  let graphEdgesCreated = 0

  // Collect all candidates from all digests
  const allCandidates: KnowledgeCandidate[] = []
  for (const digest of digests) {
    const candidates = extractCandidatesFromText(digest.summary, digest.id)
    allCandidates.push(...candidates)
  }

  // Semantic promotions inherit the project of the digests they derive from,
  // so same-project ranking survives consolidation. Procedural promotions are
  // stored shared: a procedure or habit describes how the user works, which
  // applies in every project, not only the one it was first observed in.
  const digestProjectById = new Map(digests.map(d => [d.id, d.projectId]))
  const candidateProjectId = (candidate: KnowledgeCandidate): string | null =>
    majorityProjectId(candidate.sourceDigestIds.map(id => digestProjectById.get(id)))

  // If intelligence adapter supports extractKnowledge, use it to augment
  if (intelligence?.extractKnowledge) {
    for (const digest of digests) {
      try {
        const aiCandidates = await intelligence.extractKnowledge(digest.summary)
        for (const c of aiCandidates) {
          allCandidates.push({
            ...c,
            sourceDigestIds: c.sourceDigestIds.length > 0 ? c.sourceDigestIds : [digest.id],
            kind: 'semantic',
          })
        }
      } catch {
        // ignore intelligence errors
      }
    }
  }

  // Process semantic candidates
  const semanticCandidates = allCandidates.filter(c => c.kind === 'semantic')
  const judge = intelligence?.judgeSupersession?.bind(intelligence)
  const clock = statementClock(storage, digests)
  for (const candidate of semanticCandidates) {
    // Pass an embedding so semantic.search uses hybrid BM25+vector.
    // BM25-only dedup misses LLM paraphrases of the same fact
    // ("X published v1.0" ↔ "MK noted X shipped 1.0") because their
    // token sets differ. Cosine similarity catches the semantic match.
    // Embed the same topic+content text that the semantic FTS column and
    // the embed-backfill CLI use — stored rows carry vectors of that shape,
    // so both the dedup comparison here and the persisted embedding below
    // must match it or cosine similarity degrades from shape drift.
    let candidateEmbedding: number[] | undefined
    if (intelligence?.embed) {
      try {
        candidateEmbedding = await intelligence.embed(`${candidate.topic} ${candidate.content}`)
      } catch {
        // ignore — fall back to BM25-only path below
      }
    }

    const searchOpts: { limit: number; embedding?: number[] } = { limit: 5 }
    if (candidateEmbedding) searchOpts.embedding = candidateEmbedding

    const existing = await storage.semantic.search(candidate.content, searchOpts)
    // search() scores are not cosine: hybrid results are fused ranks (RRF on
    // PostgREST, a BM25/cosine blend on SQLite) and text-only results are a
    // constant or a max-normalised BM25, so no fixed threshold on them means
    // "same claim". The paraphrase check uses findNearest's raw cosine; the
    // lexical fallback is an exact match after normalisation.
    const nearest = candidateEmbedding
      ? await storage.semantic.findNearest(candidateEmbedding, NEIGHBOUR_SCAN)
      : []
    const projectId = candidateProjectId(candidate)
    const pool = neighbourPool(nearest, projectId, supersession.minCosine)
    const scopedExisting = existing.filter(e => inProject(e.item, projectId))

    // The judge needs a vector-built pool; without a judge or a vector, llm
    // mode behaves as regex mode.
    let decision: SemanticDecision
    if (supersession.mode === 'llm' && judge && candidateEmbedding) {
      const judged = await llmDecision({ storage, judge, clock, projectId }, candidate, pool, scopedExisting, existing)
      decision = judged.decision
      if (judged.judged) supersessionJudged++
      keptNotState += judged.counts.keptNotState
      kindMissing += judged.counts.kindMissing
    } else {
      decision = ruleDecision(candidate, pool, scopedExisting, existing, supersession.mode !== 'off')
    }

    if (decision.kind === 'stale') {
      stale++
      continue
    }
    if (decision.kind === 'tie') {
      tie++
      continue
    }
    if (decision.kind === 'duplicate') {
      // Re-extracting a known fact is a recurrence: it raises the access
      // count and the fact's confidence.
      await storage.semantic.recordAccessAndBoost(decision.id, 0.1)
      deduplicated++
      continue
    }
    const supersededIds = decision.supersededIds

    // Persist the embedding computed for dedup above: a null embedding
    // leaves the row invisible to vector search AND to this same
    // embedding-based dedup on every future cycle (the duplication leak
    // that flooded the semantic tier ran through exactly that blind spot).
    const knowledge = await storage.semantic.insert({
      topic: candidate.topic,
      content: candidate.content,
      confidence: candidate.confidence,
      sourceDigestIds: candidate.sourceDigestIds,
      sourceEpisodeIds: candidate.sourceEpisodeIds,
      decayRate: 0.02,
      supersedes: supersededIds[0] ?? null,
      supersededBy: null,
      embedding: candidateEmbedding ?? null,
      metadata: {},
      projectId,
    })

    for (const supersededId of supersededIds) {
      await storage.semantic.markSuperseded(supersededId, knowledge.id)
      superseded++
    }

    // SQL derives_from associations
    for (const digestId of candidate.sourceDigestIds) {
      await storage.associations.insert({
        sourceId: digestId,
        sourceType: 'digest',
        targetId: knowledge.id,
        targetType: 'semantic',
        edgeType: 'derives_from',
        strength: 0.8,
        lastActivated: null,
        metadata: {},
      })
    }

    // --- Neo4j: Semantic Memory node ---
    if (graphAvailable && graph?.runCypherWrite) {
      try {
        const now = new Date().toISOString()

        // AUDIT FIX: validFrom = earliest source episode, not consolidation time
        let validFrom = now
        if (storage.episodes.findEarliestInDigests) {
          const earliest = await storage.episodes.findEarliestInDigests(candidate.sourceDigestIds)
          if (earliest) validFrom = earliest.createdAt.toISOString()
        }

        // Step 1: Create Semantic Memory node
        const nodeResult = await graph.runCypherWrite(`
          MERGE (s:Memory {id: $semanticId})
          SET s.memoryType = 'semantic',
              s.label = $label,
              s.topic = $topic,
              s.createdAt = $now,
              s.validFrom = $validFrom,
              s.validUntil = null,
              s.pageRank = 0.0,
              s.betweenness = 0.0,
              s.isBridge = false,
              s.activationCount = 0
        `, {
          semanticId: knowledge.id,
          label: `${candidate.topic}: ${candidate.content.slice(0, 60)}`,
          topic: candidate.topic,
          now,
          validFrom,
        })
        graphNodesCreated += extractCounters(nodeResult).nodesCreated

        // Step 2: DERIVES_FROM edges to source digests
        const derivesResult = await graph.runCypherWrite(`
          UNWIND $sourceDigestIds AS digestId
          MATCH (dig:Memory {id: digestId})
          MATCH (s:Memory {id: $semanticId})
          MERGE (s)-[r:DERIVES_FROM]->(dig)
          ON CREATE SET r.weight = 0.8,
                        r.createdAt = $now,
                        r.lastTraversed = null,
                        r.traversalCount = 0
        `, { sourceDigestIds: candidate.sourceDigestIds, semanticId: knowledge.id, now })
        graphEdgesCreated += extractCounters(derivesResult).relationshipsCreated

        // Step 3: Transitive context inheritance with MAX weight
        const ctxResult = await graph.runCypherWrite(`
          MATCH (dig:Memory)-[r:CONTEXTUAL]->(ctx)
          WHERE dig.id IN $sourceDigestIds
            AND (ctx:Person OR ctx:Entity OR ctx:Topic)
          WITH ctx, max(r.weight) * 0.7 AS inheritedWeight
          MATCH (s:Memory {id: $semanticId})
          MERGE (s)-[rel:CONTEXTUAL]->(ctx)
          ON CREATE SET rel.weight = inheritedWeight,
                        rel.createdAt = $now,
                        rel.lastTraversed = null,
                        rel.traversalCount = 0
          ON MATCH SET rel.weight = CASE
                         WHEN rel.weight < inheritedWeight THEN inheritedWeight
                         ELSE rel.weight
                       END,
                       rel.lastTraversed = $now
        `, { sourceDigestIds: candidate.sourceDigestIds, semanticId: knowledge.id, now })
        graphEdgesCreated += extractCounters(ctxResult).relationshipsCreated

        // Step 4: Supersession → CONTRADICTS + validUntil + forgottenAt.
        // Spreading activation skips only nodes with forgottenAt; without it
        // the retired fact keeps relaying until the decay pass's tombstone
        // sync. coalesce keeps an earlier forget time.
        for (const supersededId of supersededIds) {
          await graph.runCypherWrite(`
            MATCH (old:Memory {id: $oldId})
            MATCH (new:Memory {id: $newId})
            SET old.validUntil = $now,
                old.forgottenAt = coalesce(old.forgottenAt, $now)
            MERGE (new)-[r:CONTRADICTS]->(old)
            ON CREATE SET r.weight = 1.0,
                          r.createdAt = $now,
                          r.lastTraversed = null,
                          r.traversalCount = 0
          `, { oldId: supersededId, newId: knowledge.id, now })
          graphEdgesCreated++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[deep-sleep] Neo4j graph update failed for ${knowledge.id}: ${msg}`)
      }
    }

    promoted++
  }

  // Process procedural candidates
  const proceduralCandidates = allCandidates.filter(c => c.kind === 'procedural')
  for (const candidate of proceduralCandidates) {
    const searchQuery = `${candidate.trigger ?? candidate.topic} ${candidate.content}`

    // Embed the same trigger+procedure text that FTS indexes and the
    // embed-backfill CLI use, so stored vectors stay comparable across
    // write paths. Best-effort: on failure the row lands with null and
    // stays reachable via BM25 until a backfill fills the vector.
    let proceduralEmbedding: number[] | undefined
    if (intelligence?.embed) {
      try {
        proceduralEmbedding = await intelligence.embed(searchQuery)
      } catch {
        // fall through — insert without embedding
      }
    }

    // Same rule as the semantic tier: search()/searchByTrigger() scores are
    // fused ranks, a constant or a max-normalised BM25, never a cosine, so the
    // paraphrase check uses findNearest's raw cosine and the lexical fallback
    // is an exact procedure match after normalisation.
    const nearest = proceduralEmbedding
      ? await storage.procedural.findNearest(proceduralEmbedding, 3)
      : []
    const textHits = await storage.procedural.search(candidate.content, { limit: 3 })
    const match =
      nearest.find(e => e.similarity > DUPLICATE_COSINE) ??
      textHits.find(e => sameContent(e.item.procedure, candidate.content))

    if (match) {
      await storage.procedural.incrementObservation(match.item.id)
      continue
    }

    const proceduralRecord = await storage.procedural.insert({
      category: (candidate.trigger as 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention') ?? 'preference',
      trigger: candidate.trigger ?? candidate.topic,
      procedure: candidate.content,
      confidence: candidate.confidence,
      observationCount: 1,
      lastObserved: new Date(),
      firstObserved: new Date(),
      decayRate: 0.01,
      sourceEpisodeIds: candidate.sourceEpisodeIds,
      embedding: proceduralEmbedding ?? null,
      metadata: {},
      projectId: null,
    })

    // --- Neo4j: Procedural Memory node ---
    if (graphAvailable && graph?.runCypherWrite) {
      try {
        const now = new Date().toISOString()
        const nodeResult = await graph.runCypherWrite(`
          MERGE (p:Memory {id: $proceduralId})
          SET p.memoryType = 'procedural',
              p.label = $label,
              p.triggerPattern = $triggerPattern,
              p.createdAt = $now,
              p.validFrom = $now,
              p.validUntil = null,
              p.pageRank = 0.0,
              p.betweenness = 0.0,
              p.isBridge = false,
              p.activationCount = 0
        `, {
          proceduralId: proceduralRecord.id,
          label: `${candidate.trigger}: ${candidate.content.slice(0, 60)}`,
          triggerPattern: candidate.trigger ?? candidate.topic,
          now,
        })
        graphNodesCreated += extractCounters(nodeResult).nodesCreated
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[deep-sleep] Neo4j graph update failed for procedural ${proceduralRecord.id}: ${msg}`)
      }
    }

    procedural++
  }

  if (kindMissing > 0) {
    console.warn(
      `[deep-sleep] supersession judge gave no valid kind for ${kindMissing} conflict(s) this run; none retired anything`,
    )
  }

  return {
    cycle: 'deep',
    promoted,
    procedural,
    deduplicated,
    superseded,
    supersessionJudged,
    stale,
    tie,
    keptNotState,
    kindMissing,
    graphNodesCreated: graphAvailable ? graphNodesCreated : undefined,
    graphEdgesCreated: graphAvailable ? graphEdgesCreated : undefined,
  }
}
