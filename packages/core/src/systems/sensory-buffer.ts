import type {
  WorkingMemoryItem,
  PrimedTopic,
  SensorySnapshot,
  IntentResult,
} from '../types.js'

const MAX_PRIMING_BOOST = 0.3

export class SensoryBuffer {
  private items: Map<string, WorkingMemoryItem>
  private primedTopics: Map<string, PrimedTopic>
  private activeIntent: IntentResult | null
  private maxItems: number

  constructor(opts?: { maxItems?: number }) {
    this.items = new Map()
    this.primedTopics = new Map()
    this.activeIntent = null
    this.maxItems = opts?.maxItems ?? 100
  }

  // === Item operations ===

  set(item: WorkingMemoryItem): void {
    if (this.items.size >= this.maxItems && !this.items.has(item.key)) {
      let minKey = ''
      let minImportance = Infinity
      for (const [key, existing] of this.items) {
        if (existing.importance < minImportance) {
          minImportance = existing.importance
          minKey = key
        }
      }
      if (minKey) this.items.delete(minKey)
    }
    this.items.set(item.key, item)
  }

  get(key: string): WorkingMemoryItem | undefined {
    return this.items.get(key)
  }

  getAll(): WorkingMemoryItem[] {
    return [...this.items.values()].sort((a, b) => b.importance - a.importance)
  }

  remove(key: string): void {
    this.items.delete(key)
  }

  size(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  // === Priming ===

  prime(topics: string[], boost: number, turnsRemaining: number): void {
    for (const topic of topics) {
      const key = topic.toLowerCase()
      this.primedTopics.set(key, {
        topic,
        boost,
        decayRate: 0,
        source: 'recall',
        turnsRemaining,
      })
    }
  }

  getPrimed(): PrimedTopic[] {
    return [...this.primedTopics.values()]
  }

  /**
   * Returns the total priming boost for content that matches any primed topic.
   * Accumulates boost across all matching topics, capped at MAX_PRIMING_BOOST (0.3)
   * per audit resolution A5.
   */
  getPrimingBoost(content: string): number {
    const lower = content.toLowerCase()
    let total = 0
    for (const primed of this.primedTopics.values()) {
      if (lower.includes(primed.topic.toLowerCase())) {
        total += primed.boost
      }
    }
    return Math.min(total, MAX_PRIMING_BOOST)
  }

  /**
   * Advance one turn: decrement turnsRemaining on all primed topics and remove
   * any whose counter reaches zero.
   */
  tick(): void {
    for (const [key, primed] of this.primedTopics) {
      const updated = primed.turnsRemaining - 1
      if (updated <= 0) {
        this.primedTopics.delete(key)
      } else {
        this.primedTopics.set(key, { ...primed, turnsRemaining: updated })
      }
    }
  }

  // === Intent ===

  setIntent(intent: IntentResult): void {
    this.activeIntent = intent
  }

  getIntent(): IntentResult | null {
    return this.activeIntent
  }

  // === Persistence ===

  snapshot(sessionId: string): SensorySnapshot {
    return {
      sessionId,
      items: this.getAll(),
      primedTopics: this.getPrimed(),
      savedAt: new Date(),
    }
  }

  restore(snap: SensorySnapshot): void {
    this.items.clear()
    for (const item of snap.items) {
      this.items.set(item.key, item)
    }
    this.primedTopics.clear()
    for (const primed of snap.primedTopics) {
      this.primedTopics.set(primed.topic.toLowerCase(), primed)
    }
  }
}
