import type { EffectiveFilters } from './channels.js'
import type { FloorCalibration } from './floor-calibration.js'
import { compareShown, scopeTier, type Band, type ScopeContext } from './rank.js'
import type { RecallItemRow, RecallRequest, RecallStore } from './types.js'

/** The first shown query items whose links are followed. */
export const ASSOCIATION_SEEDS = 3
/** Items kept per seed and per source (subject, entity, lineage). */
export const ASSOCIATIONS_PER_SOURCE = 2

export interface AssociationStage {
  store: RecallStore
  request: RecallRequest
  filters: EffectiveFilters
  floor: FloorCalibration
  scope: ScopeContext
  /** Ids already read for the query items, chain ends included: never shown twice. */
  known: ReadonlySet<string>
  /** Rerank scores by id for these rows against the request's query, or null when the reranker failed. */
  score(rows: readonly RecallItemRow[]): Promise<Map<string, number> | null>
}

export interface Associated {
  /** The new items at or above the floor, in shown order. */
  ordered: RecallItemRow[]
  /** Every row read, chain ends included, by id. */
  rows: Map<string, RecallItemRow>
}

/**
 * The items the store links to the seeds, under the request's own filters,
 * that the query did not already find. Each is reranked against the query,
 * kept at or above the floor and ordered by the same key as query items, the
 * order the store returned them standing in for the fused position. Null
 * when the reranker failed: with no score there is no floor to keep them by.
 */
export async function findAssociations(stage: AssociationStage, seeds: readonly string[]): Promise<Associated | null> {
  const empty: Associated = { ordered: [], rows: new Map() }
  if (seeds.length === 0) return empty
  const { store, request, filters } = stage
  const links = await store.associations({
    seedIds: seeds,
    classes: filters.classes,
    kinds: filters.kinds,
    ...(request.excludeSessionId !== undefined ? { excludeSessionId: request.excludeSessionId } : {}),
    ...(request.asOf !== undefined ? { asOf: request.asOf } : {}),
    includeHistory: request.includeHistory === true,
    ...(filters.maxObservationTrust !== undefined ? { maxObservationTrust: filters.maxObservationTrust } : {}),
    perSource: ASSOCIATIONS_PER_SOURCE,
  })
  const ids = [...new Set(links.map((l) => l.itemId))].filter((id) => !stage.known.has(id) && !seeds.includes(id))
  if (ids.length === 0) return empty

  const read = await store.items(ids, {
    ...(request.asOf !== undefined ? { asOf: request.asOf } : {}),
    ...(request.excludeSessionId !== undefined ? { excludeSessionId: request.excludeSessionId } : {}),
  })
  const rows = new Map(read.map((row) => [row.id, row]))
  const requested = read.filter((row) => row.requested)
  const scores = await stage.score(requested)
  if (scores === null) return null

  const position = new Map(ids.map((id, i) => [id, i]))
  const { floor, scope } = stage
  const ordered = requested
    .map((row) => ({ row, score: scores.get(row.id) ?? Number.NEGATIVE_INFINITY }))
    .filter((s) => s.score >= floor.floor)
    .map((s) => {
      const band: Band = s.score >= floor.strong ? 'A' : 'B'
      return {
        row: s.row,
        key: {
          id: s.row.id,
          band,
          tier: scopeTier(s.row, scope),
          trust: s.row.trust,
          score: s.score,
          fusedPosition: position.get(s.row.id) ?? ids.length,
          occurredAt: s.row.occurredAt,
        },
      }
    })
    .sort((a, b) => compareShown(a.key, b.key))
    .map((x) => x.row)
  return { ordered, rows }
}
