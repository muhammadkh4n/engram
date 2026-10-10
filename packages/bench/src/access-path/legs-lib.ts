/**
 * The pure parts of the per-leg contribution measurement: the queries built
 * from reviewed decision cases and gold entries, the SQL that runs each with
 * and without its entities, the parse of its output, which legs hold each
 * target, and the entity-leg rule.
 *
 * The rule: the entity leg is kept if and only if, on the calibration split,
 * (a) at least one needed memory or gold target is held by the entity leg's
 * top k and by no other leg's, and (b) no harmful or stale item is held by the
 * entity leg's top k and by no other leg's. A query without a recorded query
 * vector is left out and counted: without its vector leg, the entity leg
 * would be credited with items the vector leg finds. The check split is
 * reported and never decides.
 *
 * Item text is read only to match phrase groups; nothing here prints it.
 */
import { extractItemEntities, type EntityProject } from '@engram-mem/core'
import { caseSplit, type CaseSplit, type DecisionCase } from '../decisions/cases.js'
import type { GoldEntry } from '../eval/gold.js'
import type { PinTable } from '../eval/pins.js'
import { normalizeText } from '../eval/score.js'
import { vectorLiteral } from './measure-lib.js'
import { pinnedEmbedding, pinnedHydeEmbedding } from './recall-lib.js'

export const CANDIDATE_LEGS = ['vector', 'hyde', 'bm25', 'subject', 'entity'] as const
export type CandidateLeg = (typeof CANDIDATE_LEGS)[number]

/** The classes a call without p_classes reads; gold queries add legacy, since gold ids name old-store rows. */
export const DEFAULT_CLASSES = ['utterance', 'mk_statement', 'observation', 'artifact', 'document_section'] as const

export type TargetRole = 'needed' | 'gold' | 'harmful' | 'stale'

export interface Target {
  key: string
  role: TargetRole
  itemIds: string[]
  legacyIds: string[]
  registerIds: string[]
  phrases: string[][]
  /** A harmful or stale match that also states the change does not mislead. */
  currentPhrases: string[][]
}

export interface LegQuery {
  id: string
  source: 'case' | 'gold'
  split: CaseSplit
  text: string
  vector: number[] | null
  hydeVector: number[] | null
  terms: string[]
  entities: string[]
  classes: string[] | null
  projectId: string | null
  asOf: string | null
  excludeSession: string | null
  targets: Target[]
}

export interface SkippedQuery {
  id: string
  reason: 'no_query'
}

/** Lexical terms: whitespace tokens, lower-cased, edge punctuation stripped; inner `.`, `-`, `_` and `/` stay. */
export function queryTerms(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\s+/)) {
    const term = raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (term !== '' && !out.includes(term)) out.push(term)
  }
  return out
}

function queryFields(
  text: string,
  projects: readonly EntityProject[],
  pins: readonly PinTable[],
): Pick<LegQuery, 'text' | 'vector' | 'hydeVector' | 'terms' | 'entities'> {
  return {
    text,
    vector: pinnedEmbedding(pins, text),
    hydeVector: pinnedHydeEmbedding(pins, text),
    terms: queryTerms(text),
    entities: extractItemEntities(text, projects).map((e) => e.entity),
  }
}

/**
 * One query per reviewed case with a query text, as the replay's query lane
 * asks it: as of the decision time, without the case's own session. A
 * reviewed case without a query text has nothing to search and is skipped.
 */
export function caseQueries(
  cases: readonly DecisionCase[],
  calibrationBefore: string,
  projects: readonly EntityProject[],
  pins: readonly PinTable[],
): { queries: LegQuery[]; skipped: SkippedQuery[] } {
  const queries: LegQuery[] = []
  const skipped: SkippedQuery[] = []
  for (const c of cases) {
    if (c.status !== 'reviewed') continue
    if (c.query_text === null || c.query_text.trim() === '') {
      skipped.push({ id: c.id, reason: 'no_query' })
      continue
    }
    queries.push({
      id: c.id,
      source: 'case',
      split: caseSplit(c, calibrationBefore),
      ...queryFields(c.query_text, projects, pins),
      classes: null,
      projectId: c.project_id,
      asOf: c.decided_at,
      excludeSession: c.session_id,
      targets: [
        ...c.needed.map((n): Target => ({
          key: n.key, role: 'needed', itemIds: n.item_ids, legacyIds: n.legacy_ids, registerIds: n.register_ids,
          phrases: n.phrases, currentPhrases: [],
        })),
        ...c.harmful.map((h): Target => ({
          key: h.key, role: 'harmful', itemIds: h.item_ids, legacyIds: h.legacy_ids, registerIds: [],
          phrases: h.phrases, currentPhrases: h.current_phrases,
        })),
      ],
    })
  }
  return { queries, skipped }
}

/** One query per gold entry, all in the calibration split, reading legacy rows too. */
export function goldQueries(gold: readonly GoldEntry[], projects: readonly EntityProject[], pins: readonly PinTable[]): LegQuery[] {
  return gold.map((g) => {
    const targets: Target[] = []
    if (g.gold_ids.length > 0 || g.gold_phrases.length > 0) {
      targets.push({ key: 'gold', role: 'gold', itemIds: g.gold_ids, legacyIds: g.gold_ids, registerIds: [], phrases: g.gold_phrases, currentPhrases: [] })
    }
    if (g.stale_ids.length > 0 || g.stale_phrases.length > 0) {
      targets.push({
        key: 'stale', role: 'stale', itemIds: g.stale_ids, legacyIds: g.stale_ids, registerIds: [],
        phrases: g.stale_phrases, currentPhrases: g.current_phrases,
      })
    }
    return {
      id: g.id,
      source: 'gold',
      split: 'calibration',
      ...queryFields(g.query, projects, pins),
      classes: [...DEFAULT_CLASSES, 'legacy'],
      projectId: g.project_id ?? null,
      asOf: null,
      excludeSession: null,
      targets,
    }
  })
}

/** The request one query sends, as JSON the SQL reads field by field. */
export function legsRequest(q: LegQuery, k: number): Record<string, unknown> {
  if (q.vector === null) throw new Error(`query ${q.id} has no query vector and is not run`)
  return {
    embedding: vectorLiteral(q.vector),
    hyde_embedding: q.hydeVector === null ? null : vectorLiteral(q.hydeVector),
    query: q.text,
    terms: q.terms,
    entities: q.entities,
    ...(q.classes === null ? {} : { classes: q.classes }),
    project_id: q.projectId,
    exclude_session: q.excludeSession,
    as_of: q.asOf,
    k,
  }
}

function sqlLiteral(text: string): string {
  if (text.includes('\0')) throw new Error('a request holds a NUL character')
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * SQL that runs every query (n from 1) twice, with its entities and without,
 * and prints one JSON line per candidate, then one per candidate item with
 * the fields targets match on. Requests travel as quoted JSON literals under
 * standard_conforming_strings, so no request text becomes SQL.
 */
export function legsSql(queries: readonly LegQuery[], k: number): string {
  if (queries.length === 0) throw new Error('no query to run')
  const values = queries
    .flatMap((q, i) => {
      const request = sqlLiteral(JSON.stringify(legsRequest(q, k)))
      return [`(${i + 1}, true, ${request}::jsonb)`, `(${i + 1}, false, ${request}::jsonb)`]
    })
    .join(',\n')
  const textArray = (field: string) => `ARRAY(SELECT jsonb_array_elements_text(q.r -> '${field}'))`
  return [
    '\\set QUIET on',
    'SET standard_conforming_strings = on;',
    'CREATE TEMP TABLE ap_requests (n integer, with_entities boolean, r jsonb, PRIMARY KEY (n, with_entities));',
    `INSERT INTO ap_requests VALUES ${values};`,
    `CREATE TEMP TABLE ap_rows AS
     SELECT q.n, q.with_entities, c.leg, c.rank, c.item_id
       FROM ap_requests q
       CROSS JOIN LATERAL public.engram_item_candidates(
         p_embedding => (q.r ->> 'embedding')::public.vector,
         p_hyde_embedding => (q.r ->> 'hyde_embedding')::public.vector,
         p_query => q.r ->> 'query',
         p_terms => ${textArray('terms')},
         p_entities => CASE WHEN q.with_entities THEN ${textArray('entities')} END,
         p_classes => CASE WHEN q.r ? 'classes' THEN ${textArray('classes')} END,
         p_project_id => q.r ->> 'project_id',
         p_exclude_session => q.r ->> 'exclude_session',
         p_as_of => (q.r ->> 'as_of')::timestamptz,
         p_k => (q.r ->> 'k')::integer) c;`,
    `SELECT json_build_object('kind', 'row', 'n', n, 'with_entities', with_entities, 'leg', leg, 'rank', rank,
                              'item_id', item_id)::text
       FROM ap_rows ORDER BY n, with_entities, array_position(ARRAY[${CANDIDATE_LEGS.map((l) => `'${l}'`).join(', ')}], leg), rank;`,
    `SELECT json_build_object('kind', 'item', 'id', i.id,
                              'legacy_id', CASE WHEN i.source ->> 'type' = 'legacy' THEN i.source ->> 'id' END,
                              'register_ref', i.register_ref, 'content', i.content, 'context', i.context)::text
       FROM public.memory_items i WHERE i.id IN (SELECT item_id FROM ap_rows) ORDER BY i.id;`,
  ].join('\n')
}

export interface CandidateRow {
  n: number
  withEntities: boolean
  leg: CandidateLeg
  rank: number
  itemId: string
}

export interface ItemText {
  id: string
  legacyId: string | null
  registerRef: string | null
  content: string
  context: string | null
}

const nullableString = (value: unknown): value is string | null => typeof value === 'string' || value === null

/** Parses legsSql's output. An error names the line number only: an item line holds its text. */
export function parseLegsOutput(output: string): { rows: CandidateRow[]; items: Map<string, ItemText> } {
  const rows: CandidateRow[] = []
  const items = new Map<string, ItemText>()
  output.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    const r = JSON.parse(line) as Record<string, unknown>
    if (
      r.kind === 'row' && Number.isInteger(r.n) && typeof r.with_entities === 'boolean' &&
      (CANDIDATE_LEGS as readonly unknown[]).includes(r.leg) && Number.isInteger(r.rank) && typeof r.item_id === 'string'
    ) {
      rows.push({ n: r.n as number, withEntities: r.with_entities, leg: r.leg as CandidateLeg, rank: r.rank as number, itemId: r.item_id })
      return
    }
    if (
      r.kind === 'item' && typeof r.id === 'string' && nullableString(r.legacy_id) && nullableString(r.register_ref) &&
      typeof r.content === 'string' && nullableString(r.context)
    ) {
      items.set(r.id, { id: r.id, legacyId: r.legacy_id, registerRef: r.register_ref, content: r.content, context: r.context })
      return
    }
    throw new Error(`legs output line ${i + 1} has an unexpected shape`)
  })
  return { rows, items }
}

/** The legs whose rows hold an item, in leg order. */
export function legsHolding(rows: readonly CandidateRow[], itemId: string): CandidateLeg[] {
  return CANDIDATE_LEGS.filter((leg) => rows.some((r) => r.leg === leg && r.itemId === itemId))
}

/**
 * The call without entities must return exactly the call with entities minus
 * the entity leg: every other leg ignores p_entities. A difference means the
 * two calls did not read the same store, and the comparison is void.
 */
export function assertOtherLegsUnchanged(id: string, withRows: readonly CandidateRow[], withoutRows: readonly CandidateRow[]): void {
  const key = (r: CandidateRow) => `${r.leg}|${r.rank}|${r.itemId}`
  const expected = withRows.filter((r) => r.leg !== 'entity').map(key)
  const actual = withoutRows.map(key)
  if (expected.length !== actual.length || expected.some((k, i) => k !== actual[i])) {
    throw new Error(`query ${id}: the call without entities changed the other legs`)
  }
}

function matchesGroup(normalized: string, groups: readonly (readonly string[])[]): boolean {
  return groups.some((group) => group.length > 0 && group.every((phrase) => normalized.includes(normalizeText(phrase))))
}

/**
 * Whether an item is a target: by item id, by legacy id, by register ref, or
 * by a phrase group on its content and context. A harmful or stale item that
 * also matches a current phrase states the change and is not counted,
 * except that a stale id stands on its own, as in the gold scorer.
 */
export function matchesTarget(target: Target, item: ItemText): boolean {
  const normalized = normalizeText(`${item.content}\n${item.context ?? ''}`)
  const byId =
    target.itemIds.includes(item.id) ||
    (item.legacyId !== null && target.legacyIds.includes(item.legacyId)) ||
    (item.registerRef !== null && target.registerIds.includes(item.registerRef))
  if (!byId && !matchesGroup(normalized, target.phrases)) return false
  if (target.role === 'needed' || target.role === 'gold') return true
  if (matchesGroup(normalized, target.currentPhrases)) return target.role === 'stale' && byId
  return true
}

export interface TargetResult {
  key: string
  role: TargetRole
  /** Every leg whose top k holds an item matching the target. */
  legs: CandidateLeg[]
  itemIds: string[]
  /** Matching items held by the entity leg and by no other leg. */
  entityOnlyItemIds: string[]
}

export interface QueryResult {
  id: string
  source: 'case' | 'gold'
  split: CaseSplit
  status: 'ok' | 'no_vector'
  entities: number
  hyde: boolean
  targets: TargetResult[]
}

/** Which legs hold each target, over the rows of the call with entities. Gold wins over stale for one item. */
export function evaluateQuery(q: LegQuery, rows: readonly CandidateRow[], items: ReadonlyMap<string, ItemText>): QueryResult {
  const candidateIds = [...new Set(rows.map((r) => r.itemId))]
  const candidates = candidateIds.map((id) => {
    const item = items.get(id)
    if (item === undefined) throw new Error(`query ${q.id}: candidate ${id} has no item row`)
    return item
  })
  const goldTargets = q.targets.filter((t) => t.role === 'gold')
  const targets = q.targets.map((target): TargetResult => {
    const matching = candidates.filter(
      (item) => matchesTarget(target, item) && !(target.role === 'stale' && goldTargets.some((g) => matchesTarget(g, item))),
    )
    const legSets = matching.map((item) => ({ id: item.id, legs: legsHolding(rows, item.id) }))
    return {
      key: target.key,
      role: target.role,
      legs: CANDIDATE_LEGS.filter((leg) => legSets.some((s) => s.legs.includes(leg))),
      itemIds: legSets.map((s) => s.id),
      entityOnlyItemIds: legSets.filter((s) => s.legs.length === 1 && s.legs[0] === 'entity').map((s) => s.id),
    }
  })
  return { id: q.id, source: q.source, split: q.split, status: 'ok', entities: q.entities.length, hyde: q.hydeVector !== null, targets }
}

/** A query left out for want of a query vector. */
export function noVectorResult(q: LegQuery): QueryResult {
  return { id: q.id, source: q.source, split: q.split, status: 'no_vector', entities: q.entities.length, hyde: q.hydeVector !== null, targets: [] }
}

export interface SplitCounts {
  queries: number
  noVector: number
  helped: Array<{ query: string; key: string }>
  harmed: Array<{ query: string; key: string; itemId: string }>
}

export interface EntityRuleVerdict {
  keep: boolean
  calibration: SplitCounts
  check: SplitCounts
  noQuery: number
}

function splitCounts(results: readonly QueryResult[]): SplitCounts {
  const ok = results.filter((r) => r.status === 'ok')
  return {
    queries: ok.length,
    noVector: results.length - ok.length,
    helped: ok.flatMap((r) =>
      r.targets
        .filter((t) => (t.role === 'needed' || t.role === 'gold') && t.legs.length === 1 && t.legs[0] === 'entity')
        .map((t) => ({ query: r.id, key: t.key })),
    ),
    harmed: ok.flatMap((r) =>
      r.targets
        .filter((t) => t.role === 'harmful' || t.role === 'stale')
        .flatMap((t) => t.entityOnlyItemIds.map((itemId) => ({ query: r.id, key: t.key, itemId }))),
    ),
  }
}

/** The entity-leg rule over the calibration split; the check split is counted alongside and never decides. */
export function entityRule(results: readonly QueryResult[], skipped: readonly SkippedQuery[]): EntityRuleVerdict {
  const calibration = splitCounts(results.filter((r) => r.split === 'calibration'))
  const check = splitCounts(results.filter((r) => r.split === 'check'))
  return {
    keep: calibration.helped.length > 0 && calibration.harmed.length === 0,
    calibration,
    check,
    noQuery: skipped.length,
  }
}

export function formatLegs(results: readonly QueryResult[], verdict: EntityRuleVerdict): string {
  const lines: string[] = []
  for (const r of results) {
    lines.push(`${r.source} ${r.id} (${r.split}): ${r.status}; ${r.entities} entities; hyde ${r.hyde ? 'yes' : 'no'}`)
    for (const t of r.targets) {
      const legs = t.legs.length === 0 ? 'none' : t.legs.join(',')
      const entityOnly = t.entityOnlyItemIds.length === 0 ? '' : `; entity only: ${t.entityOnlyItemIds.join(',')}`
      lines.push(`  ${t.role} ${t.key}: legs ${legs}; items ${t.itemIds.length === 0 ? 'none' : t.itemIds.join(',')}${entityOnly}`)
    }
  }
  const counts = (name: string, s: SplitCounts) =>
    `${name}: ${s.queries} queries run, ${s.noVector} no_vector; needed or gold held by the entity leg alone: ${s.helped.length}; ` +
    `harmful or stale items held by the entity leg alone: ${s.harmed.length}`
  lines.push(
    counts('calibration', verdict.calibration),
    `${counts('check', verdict.check)} (reported, not used)`,
    `reviewed cases without a query text: ${verdict.noQuery}`,
    `entity leg: ${verdict.keep ? 'keep' : 'drop'} (needs at least one target held by it alone and no harmful or stale item held by it alone)`,
  )
  return lines.join('\n')
}
