/**
 * Session-id projection for LongMemEval sweeps.
 *
 * Preferred path: RecallResult.sessions (A1 session-completeness ranking) —
 * each group maps to its dataset id via the first member memory that carries
 * metadata.lmeSessionId. Fallback + back-fill: the legacy first-distinct-
 * session-in-memory-rank-order walk, so a core without the sessions field
 * (or memories the grouping missed) still projects.
 *
 * Structurally typed (no @engram-mem/core import) so bench tests run
 * without a built core package.
 */

export interface SessionProjectionInput {
  memories: ReadonlyArray<{ id: string; metadata?: Record<string, unknown> }>
  sessions?: ReadonlyArray<{ sessionId: string; memoryIds: readonly string[] }>
}

export function projectSessionIds(result: SessionProjectionInput): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const byId = new Map(result.memories.map((m) => [m.id, m]))

  if (result.sessions && result.sessions.length > 0) {
    for (const group of result.sessions) {
      for (const mid of group.memoryIds) {
        const sid = byId.get(mid)?.metadata?.['lmeSessionId'] as string | undefined
        if (sid) {
          if (!seen.has(sid)) { seen.add(sid); out.push(sid) }
          break
        }
      }
    }
  }
  // Legacy walk: primary path when sessions is absent; defensive back-fill otherwise.
  for (const m of result.memories) {
    const sid = m.metadata?.['lmeSessionId'] as string | undefined
    if (sid && !seen.has(sid)) { seen.add(sid); out.push(sid) }
  }
  return out
}

/**
 * The bench ingests each dataset session under the engram session id
 * `lme:<questionId>:<lmeSessionId>`; synthesis blocks cite engram session
 * ids. The answerer sees DATASET ids in its context headers, so the sweep
 * rewrites the namespace prefix out of stored block text — the same
 * engram-id → dataset-id mapping the session projection performs.
 */
export function stripBenchSessionNamespace(text: string, questionId: string): string {
  return text.split(`lme:${questionId}:`).join('')
}
