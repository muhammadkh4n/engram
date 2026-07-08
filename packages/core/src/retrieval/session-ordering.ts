import type { RetrievedMemory, SessionGroup } from '../types.js'
import { resolveEventDate, isoDate } from '../utils/event-date.js'

/** Same k as fuseByReciprocalRank (Cormack et al. 2009): rank 1 contributes
 *  ~1/61, rank 30 ~1/91 — mid-rank members accumulate real mass while a
 *  single deep straggler barely registers. */
const RRF_K = 60

/**
 * Session-completeness ranking (A1). Groups the FINAL ranked memories by
 * session and ranks sessions by rank-discounted RRF mass, EXCEPT slot 1:
 * the session of the global top-ranked memory always holds slot 1 (head
 * protection — preserves the saturated any-hit@5 behavior for single-gold
 * questions). Pure: never mutates or reorders `memories`.
 */
export function rankSessions(memories: readonly RetrievedMemory[]): SessionGroup[] {
  const groups = new Map<string, { score: number; memoryIds: string[]; dates: number[] }>()
  for (let rank = 0; rank < memories.length; rank++) {
    const m = memories[rank]!
    const sid = m.sessionId ?? null
    if (!sid) continue
    const g = groups.get(sid) ?? { score: 0, memoryIds: [], dates: [] }
    g.score += 1 / (RRF_K + rank + 1)
    g.memoryIds.push(m.id)
    const d = resolveEventDate(m.metadata)
    if (d) g.dates.push(d.getTime())
    groups.set(sid, g)
  }
  if (groups.size === 0) return []

  const ranked: SessionGroup[] = [...groups.entries()]
    .map(([sessionId, g]) => ({
      sessionId,
      score: g.score,
      memoryIds: [...g.memoryIds],
      earliest: g.dates.length > 0 ? isoDate(new Date(Math.min(...g.dates))) : null,
      latest: g.dates.length > 0 ? isoDate(new Date(Math.max(...g.dates))) : null,
    }))
    .sort((a, b) => b.score - a.score)

  // Head protection: the top-ranked memory's session owns slot 1.
  // No session on the top-ranked memory → nothing to protect → pure mass order.
  const headSessionId = memories[0]?.sessionId
  if (headSessionId) {
    const idx = ranked.findIndex((g) => g.sessionId === headSessionId)
    if (idx > 0) {
      const [head] = ranked.splice(idx, 1)
      ranked.unshift(head!)
    }
  }
  return ranked
}
