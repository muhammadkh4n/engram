import type { Candidate, CandidateLeg } from '../items/item-store.js'

/** Reciprocal rank fusion's constant: a rank r adds 1 / (60 + r). */
export const RRF_K = 60
/** Items fused into the slate that the reranker scores. */
export const SLATE_SIZE = 50

export interface FusedCandidate {
  itemId: string
  score: number
  /** The best (lowest) rank the item held in any list. */
  bestRank: number
  legs: CandidateLeg[]
}

/**
 * Reciprocal rank fusion over every list in the candidates: each item scores
 * Σ 1/(60 + rank), with ranks 1-based within their leg. Ordered by score,
 * then best rank in any list, then id, so equal inputs always give one order.
 */
export function fuse(candidates: readonly Candidate[]): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate>()
  for (const c of candidates) {
    const fused = byId.get(c.itemId)
    if (fused === undefined) {
      byId.set(c.itemId, { itemId: c.itemId, score: 1 / (RRF_K + c.rank), bestRank: c.rank, legs: [c.leg] })
    } else {
      fused.score += 1 / (RRF_K + c.rank)
      fused.bestRank = Math.min(fused.bestRank, c.rank)
      if (!fused.legs.includes(c.leg)) fused.legs.push(c.leg)
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.score - a.score || a.bestRank - b.bestRank || compareIds(a.itemId, b.itemId),
  )
}

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Band A holds items at or above the strong score, band B the rest that passed the floor. */
export type Band = 'A' | 'B'

/** 0: the asking project or plan; 1: its workspace; 2: anything else. */
export type ScopeTier = 0 | 1 | 2

export interface ScopeContext {
  atRoot: boolean
  projectId?: string
  projectKnown: boolean
  workspaceId: string | null
  planSlugs: readonly string[]
}

export interface ScopedFields {
  projectId: string | null
  workspaceId: string | null
  planSlug: string | null
}

/**
 * Where an item stands relative to the asker. Scope orders and never removes.
 * A null on either side never matches, so a project without a workspace puts
 * nothing in tier 1, and items with no project are tier 2 unless their plan is
 * asked for. At a workspace root, and for a project the registry does not
 * know, every item is tier 2. With plans and no project only the plan rule
 * applies.
 */
export function scopeTier(item: ScopedFields, scope: ScopeContext): ScopeTier {
  if (scope.atRoot) return 2
  if (scope.projectId !== undefined && !scope.projectKnown) return 2
  if (scope.projectId !== undefined && item.projectId !== null && item.projectId === scope.projectId) return 0
  if (item.planSlug !== null && scope.planSlugs.includes(item.planSlug)) return 0
  if (
    scope.projectId !== undefined &&
    scope.workspaceId !== null &&
    item.workspaceId !== null &&
    item.workspaceId === scope.workspaceId
  ) {
    return 1
  }
  return 2
}

export interface OrderFields {
  id: string
  band: Band
  tier: ScopeTier
  trust: number
  /** The rerank score; null when reranking failed and the fused order stands. */
  score: number | null
  /** The fused position, used only when there is no rerank score. */
  fusedPosition: number
  occurredAt: Date
}

/**
 * The order shown: band A before band B, then scope tier, trust ascending
 * (MK's own words first), rerank score, newest, id. Without rerank scores the
 * fused position stands in for the score.
 */
export function compareShown(a: OrderFields, b: OrderFields): number {
  if (a.band !== b.band) return a.band === 'A' ? -1 : 1
  if (a.tier !== b.tier) return a.tier - b.tier
  if (a.trust !== b.trust) return a.trust - b.trust
  if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score
  if ((a.score === null || b.score === null) && a.fusedPosition !== b.fusedPosition) return a.fusedPosition - b.fusedPosition
  const time = b.occurredAt.getTime() - a.occurredAt.getTime()
  if (time !== 0) return time
  return compareIds(a.id, b.id)
}
