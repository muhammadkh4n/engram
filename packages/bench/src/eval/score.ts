/**
 * Deterministic recall scoring against gold labels. No model reads anything:
 * an item is gold, stale or neither by id or by normalised phrase match, and
 * every metric is a count over the payload recall returned.
 *
 * Items come from the recall payload's offsets (`formatted.slice(start, end)`
 * is one item line, tagged with its section), so a score describes exactly
 * the text a reader of `formatted` sees. Rank is the 1-based position in the
 * Recalled section, the only ranked list; Related, domain, context and faint
 * items count for gold-in-payload but carry no rank.
 */

import { sha256 } from '../replay/replay-lib.js'
import type { GoldClass, GoldEntry } from './gold.js'

/** The ranked section of a recall payload. */
export const RANKED_SECTION = 'recalled'

/** Payload sections in assembly order; every score reports each of them. */
export const SCORED_SECTIONS: readonly string[] = ['recalled', 'related', 'domain', 'context', 'faint']

/** Characters per approximate token, as recall's own token estimate. */
const CHARS_PER_TOKEN = 4

export interface ScorablePayloadItem {
  section: string
  id?: string
  start: number
  end: number
}

/** The parts of a recall result scoring reads. */
export interface ScorableResult {
  formatted: string
  payload?: { items: readonly ScorablePayloadItem[] }
}

export type ItemLabel = 'gold' | 'stale' | 'other'

export interface SectionSize {
  items: number
  chars: number
  tokens: number
}

export interface QueryScore {
  id: string
  class: GoldClass
  /** 1-based rank of the first gold item in the Recalled section; null when none. */
  firstGoldRank: number | null
  hitAt5: boolean
  hitAt10: boolean
  hitAt30: boolean
  /** Gold appears in any section. */
  goldInPayload: boolean
  /** The first section, in payload order, that holds gold. */
  firstGoldSection: string | null
  /** A stale item ranks above the first gold item, or stale appears anywhere while gold appears nowhere. */
  staleBeforeCurrent: boolean
  /** A stale item sits at Recalled rank 1..10. */
  staleInTop10: boolean
  /** The gold line names stale ids or stale phrases, so the stale metrics can be non-zero. */
  hasStaleLabels: boolean
  sections: Record<string, SectionSize>
  /** Length and approximate tokens of the whole formatted text. */
  chars: number
  tokens: number
  formattedSha: string
}

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Any group matches when all of its phrases occur in the normalised text. */
function matchesAnyGroup(normalized: string, groups: readonly (readonly string[])[]): boolean {
  return groups.some((group) => group.every((phrase) => normalized.includes(normalizeText(phrase))))
}

/** Gold wins over stale. A stale phrase match is cancelled by a current phrase
 *  match (the item states the change); a stale id is not. */
export function classifyItem(item: { id?: string; text: string }, gold: GoldEntry): ItemLabel {
  const normalized = normalizeText(item.text)
  const isGoldId = item.id !== undefined && gold.gold_ids.includes(item.id)
  if (isGoldId || matchesAnyGroup(normalized, gold.gold_phrases)) return 'gold'
  if (item.id !== undefined && gold.stale_ids.includes(item.id)) return 'stale'
  if (matchesAnyGroup(normalized, gold.stale_phrases) && !matchesAnyGroup(normalized, gold.current_phrases)) return 'stale'
  return 'other'
}

interface LabelledItem {
  section: string
  text: string
  label: ItemLabel
}

function approxTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function labelItems(gold: GoldEntry, result: ScorableResult): LabelledItem[] {
  if (result.formatted === '') return []
  if (!result.payload) throw new Error(`query ${gold.id}: a non-empty recall has no payload item offsets to score`)
  return result.payload.items.map((item) => {
    const valid = Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.start <= item.end
    if (!valid || item.end > result.formatted.length) {
      throw new Error(`query ${gold.id}: payload item offsets ${item.start}..${item.end} lie outside the formatted text`)
    }
    const text = result.formatted.slice(item.start, item.end)
    return { section: item.section, text, label: classifyItem({ ...(item.id !== undefined ? { id: item.id } : {}), text }, gold) }
  })
}

function sectionSizes(items: readonly LabelledItem[]): Record<string, SectionSize> {
  const chars = new Map<string, { items: number; chars: number }>(SCORED_SECTIONS.map((s) => [s, { items: 0, chars: 0 }]))
  for (const item of items) {
    const prev = chars.get(item.section) ?? { items: 0, chars: 0 }
    chars.set(item.section, { items: prev.items + 1, chars: prev.chars + item.text.length })
  }
  return Object.fromEntries([...chars].map(([s, v]) => [s, { ...v, tokens: approxTokens(v.chars) }]))
}

function firstRank(ranked: readonly LabelledItem[], label: ItemLabel): number | null {
  const index = ranked.findIndex((item) => item.label === label)
  return index === -1 ? null : index + 1
}

export function scoreQuery(gold: GoldEntry, result: ScorableResult): QueryScore {
  const items = labelItems(gold, result)
  const ranked = items.filter((item) => item.section === RANKED_SECTION)
  const firstGoldRank = firstRank(ranked, 'gold')
  const firstStaleRank = firstRank(ranked, 'stale')
  const goldItem = items.find((item) => item.label === 'gold')
  const staleInPayload = items.some((item) => item.label === 'stale')
  const within = (k: number): boolean => firstGoldRank !== null && firstGoldRank <= k
  const staleRankedFirst = firstStaleRank !== null && (firstGoldRank === null || firstStaleRank < firstGoldRank)

  return {
    id: gold.id,
    class: gold.class,
    firstGoldRank,
    hitAt5: within(5),
    hitAt10: within(10),
    hitAt30: within(30),
    goldInPayload: goldItem !== undefined,
    firstGoldSection: goldItem?.section ?? null,
    staleBeforeCurrent: staleRankedFirst || (staleInPayload && goldItem === undefined),
    staleInTop10: firstStaleRank !== null && firstStaleRank <= 10,
    hasStaleLabels: gold.stale_ids.length > 0 || gold.stale_phrases.length > 0,
    sections: sectionSizes(items),
    chars: result.formatted.length,
    tokens: approxTokens(result.formatted.length),
    formattedSha: sha256(result.formatted),
  }
}

// --- aggregates -------------------------------------------------------------

export interface CharsSpread {
  p50: number
  p90: number
  max: number
}

export interface ScoreAggregate {
  queries: number
  /** Mean reciprocal rank, counting ranks past 30 as zero. */
  mrr30: number
  hitAt5: number
  hitAt10: number
  hitAt30: number
  goldInPayload: number
  /** Queries whose gold line carries stale labels; the stale rate's denominator. */
  staleLabelled: number
  /** Share of stale-labelled queries with stale before current; null when none is labelled. */
  staleBeforeCurrent: number | null
  payloadChars: CharsSpread
}

export interface ScoreAggregates {
  overall: ScoreAggregate
  byClass: Partial<Record<GoldClass, ScoreAggregate>>
}

/** Nearest-rank percentile: the smallest value with at least p of the values at or below it. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
}

function rate(scores: readonly QueryScore[], pick: (s: QueryScore) => boolean): number {
  return scores.filter(pick).length / scores.length
}

function aggregate(scores: readonly QueryScore[]): ScoreAggregate {
  const reciprocal = scores.map((s) => (s.firstGoldRank !== null && s.firstGoldRank <= 30 ? 1 / s.firstGoldRank : 0))
  const labelled = scores.filter((s) => s.hasStaleLabels)
  const chars = scores.map((s) => s.chars).sort((a, b) => a - b)
  return {
    queries: scores.length,
    mrr30: reciprocal.reduce((sum, r) => sum + r, 0) / scores.length,
    hitAt5: rate(scores, (s) => s.hitAt5),
    hitAt10: rate(scores, (s) => s.hitAt10),
    hitAt30: rate(scores, (s) => s.hitAt30),
    goldInPayload: rate(scores, (s) => s.goldInPayload),
    staleLabelled: labelled.length,
    staleBeforeCurrent: labelled.length === 0 ? null : rate(labelled, (s) => s.staleBeforeCurrent),
    payloadChars: { p50: percentile(chars, 0.5), p90: percentile(chars, 0.9), max: chars[chars.length - 1]! },
  }
}

export function aggregateScores(scores: readonly QueryScore[]): ScoreAggregates {
  if (scores.length === 0) throw new Error('no scores to aggregate')
  const groups = new Map<GoldClass, QueryScore[]>()
  for (const s of scores) groups.set(s.class, [...(groups.get(s.class) ?? []), s])
  const byClass: Partial<Record<GoldClass, ScoreAggregate>> = {}
  for (const [cls, group] of groups) byClass[cls] = aggregate(group)
  return { overall: aggregate(scores), byClass }
}
