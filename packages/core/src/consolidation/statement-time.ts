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
 * Insert time cannot order facts: deep sleep re-reads every digest of the
 * last week on each run, so a fact extracted later can come from an older
 * conversation than a fact already stored.
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
