/**
 * Pure helpers for resynthesize.ts (which runs main() at module load, so
 * anything testable must live here).
 *
 * Evidence hydration rebuilds a row's synthesis input from the dataset and
 * the row's stored retrieval: the same top-K sessions, in the same rank
 * order, that the judged gen context re-hydrates. Retrieval itself is never
 * re-run — that is what keeps cells built from the output pairable
 * within-sweep against cells built from the input.
 */
import type { RetrievedMemory, SessionGroup } from '@engram-mem/core'
import type { LongMemEvalQuestion } from '../types.js'

export interface HydratedEvidence {
  memories: RetrievedMemory[]
  sessions: SessionGroup[]
}

export function hydrateRowEvidence(
  q: LongMemEvalQuestion,
  sessionIds: readonly string[],
): HydratedEvidence {
  const idx = new Map(q.haystack_session_ids.map((s, i) => [s, i] as const))
  const memories: RetrievedMemory[] = []
  const sessions: SessionGroup[] = []
  sessionIds.forEach((sid, rank) => {
    const i = idx.get(sid)
    if (i === undefined) return
    const date = q.haystack_dates?.[i] ?? null
    const turns = q.haystack_sessions[i] ?? []
    const memoryIds: string[] = []
    turns.forEach((t, ti) => {
      if (!t.content || t.content.trim().length === 0) return
      const id = `${sid}:${ti}`
      memoryIds.push(id)
      memories.push({
        id,
        type: 'episode',
        content: t.content.trim(),
        relevance: 1 - rank * 0.01,
        source: 'recall',
        metadata: { occurredAt: date },
        sessionId: sid,
      })
    })
    if (memoryIds.length > 0) {
      sessions.push({ sessionId: sid, score: 1 - rank * 0.01, memoryIds, earliest: date, latest: date })
    }
  })
  return { memories, sessions }
}

export interface TypeFireStats {
  total: number
  /** Question-side classifier fired (compute intent or preference request). */
  intent_fired: number
  /** A synthesis block actually rendered end-to-end. */
  rendered: number
  by_method: Record<string, number>
}

export function newTypeFireStats(): TypeFireStats {
  return { total: 0, intent_fired: 0, rendered: 0, by_method: {} }
}

export function recordFire(
  stats: Record<string, TypeFireStats>,
  questionType: string,
  intentFired: boolean,
  renderedMethod: string | null,
): void {
  const t = (stats[questionType] ??= newTypeFireStats())
  t.total++
  if (intentFired) t.intent_fired++
  if (renderedMethod !== null) {
    t.rendered++
    t.by_method[renderedMethod] = (t.by_method[renderedMethod] ?? 0) + 1
  }
}
