import type { StorageAdapter } from '../adapters/storage.js'
import type { Digest, Episode } from '../types.js'

/**
 * When a fact derived from digests was stated, in epoch milliseconds, or
 * null when none of the digests can be read.
 *
 * A digest's statement time is the latest `createdAt` among its source
 * episodes (the last turn it summarises), or the digest's own `createdAt`
 * when none of those episodes can be read. A fact's statement time is the
 * latest over its source digests.
 *
 * Insert time cannot order facts: a digest whose extraction failed is
 * retried on a later run and a rederive pass re-reads old digests, so a fact
 * extracted later can come from an older conversation than a fact already
 * stored.
 */
export type StatementClock = (sourceDigestIds: ReadonlyArray<string>) => Promise<number | null>

/** Epoch milliseconds of a Date or a timestamp string; null when it does not parse. */
export function epochMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function latest(values: ReadonlyArray<number | null>): number | null {
  let max: number | null = null
  for (const v of values) {
    if (v !== null && (max === null || v > max)) max = v
  }
  return max
}

/**
 * One clock per consolidation run. Digest and per-digest times are cached,
 * so a digest shared by many facts is read once. `knownDigests` (the digests
 * the run already holds) are not read again. Tombstoned episodes and digests
 * still count: forgetting a turn does not change when it was said.
 */
export function statementClock(
  storage: StorageAdapter,
  knownDigests: ReadonlyArray<Digest> = [],
): StatementClock {
  const digests = new Map<string, Digest | null>(knownDigests.map(d => [d.id, d]))
  const digestTimes = new Map<string, number | null>()

  async function loadDigests(ids: string[]): Promise<void> {
    const missing = ids.filter(id => !digests.has(id))
    if (missing.length === 0) return
    const found = await storage.getByIds(
      missing.map(id => ({ id, type: 'digest' as const })),
      { includeInactive: true },
    )
    for (const m of found) {
      if (m.type === 'digest') digests.set(m.data.id, m.data)
    }
    for (const id of missing) {
      if (!digests.has(id)) digests.set(id, null)
    }
  }

  async function loadDigestTimes(ids: string[]): Promise<void> {
    const pending = ids
      .map(id => digests.get(id))
      .filter((d): d is Digest => d != null && !digestTimes.has(d.id))
    if (pending.length === 0) return
    const episodeIds = [...new Set(pending.flatMap(d => d.sourceEpisodeIds))]
    // The adapter-level lookup batches ids, so a digest summarising many
    // turns does not build one oversized request.
    const found = episodeIds.length > 0
      ? await storage.getByIds(episodeIds.map(id => ({ id, type: 'episode' as const })), { includeInactive: true })
      : []
    const episodes = found.flatMap((m): Episode[] => (m.type === 'episode' ? [m.data] : []))
    const episodeTimes = new Map(episodes.map(e => [e.id, epochMs(e.createdAt)]))
    for (const d of pending) {
      const fromEpisodes = latest(d.sourceEpisodeIds.map(id => episodeTimes.get(id) ?? null))
      digestTimes.set(d.id, fromEpisodes ?? epochMs(d.createdAt))
    }
  }

  return async (sourceDigestIds) => {
    const ids = [...new Set(sourceDigestIds)]
    if (ids.length === 0) return null
    await loadDigests(ids)
    await loadDigestTimes(ids)
    return latest(ids.map(id => digestTimes.get(id) ?? null))
  }
}

/** The episodes and digests a fact rests on. */
export interface FactSources {
  sourceEpisodeIds: ReadonlyArray<string>
  sourceDigestIds: ReadonlyArray<string>
}

/**
 * When a fact was stated, in epoch milliseconds, or null when none of its
 * sources can be read: the latest `createdAt` of the episodes it cites, or,
 * for a fact that cites none (or none readable), the digest statement time
 * of `StatementClock`. A digest summarises many turns, so a cited fact is
 * dated by the turns that state it, not by the digest's last turn.
 */
export type FactClock = (sources: FactSources) => Promise<number | null>

/**
 * One fact clock per consolidation run, over a `statementClock` for the
 * uncited case. Episode times are cached; tombstoned episodes still count.
 */
export function factStatementClock(
  storage: StorageAdapter,
  knownDigests: ReadonlyArray<Digest> = [],
): FactClock {
  const byDigests = statementClock(storage, knownDigests)
  const episodeTimes = new Map<string, number | null>()

  async function loadEpisodeTimes(ids: string[]): Promise<void> {
    const missing = ids.filter(id => !episodeTimes.has(id))
    if (missing.length === 0) return
    const found = await storage.getByIds(
      missing.map(id => ({ id, type: 'episode' as const })),
      { includeInactive: true },
    )
    for (const m of found) {
      if (m.type === 'episode') episodeTimes.set(m.data.id, epochMs(m.data.createdAt))
    }
    for (const id of missing) {
      if (!episodeTimes.has(id)) episodeTimes.set(id, null)
    }
  }

  return async ({ sourceEpisodeIds, sourceDigestIds }) => {
    const ids = [...new Set(sourceEpisodeIds)]
    if (ids.length > 0) {
      await loadEpisodeTimes(ids)
      const cited = latest(ids.map(id => episodeTimes.get(id) ?? null))
      if (cited !== null) return cited
    }
    return byDigests(sourceDigestIds)
  }
}

/** Latest `createdAt` of the given episodes, in epoch milliseconds; null when none parses. */
export function latestEpisodeTime(episodes: ReadonlyArray<Pick<Episode, 'createdAt'>>): number | null {
  return latest(episodes.map(e => epochMs(e.createdAt)))
}
