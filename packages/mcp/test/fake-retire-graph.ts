import type { RetireGraph } from '../src/ingest/graph-retire.js'

/**
 * In-memory Memory nodes with the stamp semantics of STAMP_CYPHER and
 * UNSTAMP_CYPHER: a stamp sets `forgottenAt` only where it is missing, an
 * unstamp removes it only where it equals the given time.
 */
export class FakeRetireGraph implements RetireGraph {
  readonly forgottenAt = new Map<string, string | null>()
  readonly stampCalls: Array<{ ids: string[]; at: string }> = []
  failStamps = false

  constructor(ids: readonly string[], forgotten: Record<string, string> = {}) {
    for (const id of ids) this.forgottenAt.set(id, forgotten[id] ?? null)
  }

  async stamp(ids: readonly string[], at: string): Promise<number> {
    this.stampCalls.push({ ids: [...ids], at })
    if (this.failStamps) throw new Error('neo4j unavailable')
    let n = 0
    for (const id of ids) {
      if (this.forgottenAt.has(id) && this.forgottenAt.get(id) === null) {
        this.forgottenAt.set(id, at)
        n++
      }
    }
    return n
  }

  async unstamp(ids: readonly string[], at: string): Promise<number> {
    let n = 0
    for (const id of ids) {
      if (this.forgottenAt.get(id) === at) {
        this.forgottenAt.set(id, null)
        n++
      }
    }
    return n
  }

  /** Ids whose node carries `forgottenAt`, sorted. */
  forgotten(): string[] {
    return [...this.forgottenAt].filter(([, at]) => at !== null).map(([id]) => id).sort()
  }

  snapshot(): Record<string, string | null> {
    return Object.fromEntries(this.forgottenAt)
  }
}
