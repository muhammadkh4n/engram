import type {
  WorkingMemoryItem,
  PrimedTopic,
  SensorySnapshot,
  IntentResult,
} from '../types.js'
import { extractKeywords } from '../retrieval/keywords.js'

const MAX_PRIMING_BOOST = 0.3

/** Recalls a primed topic, and a stored intent, stay live for. Counted per
 *  conversation: only that conversation's recalls advance it. */
export const PRIMING_HORIZON_RECALLS = 5

/** Conversations whose state is kept at once. The least recently recalled
 *  conversation is dropped first. A state holds the keywords shared by one
 *  recall's results (tens to a few hundred short strings), so the cap bounds
 *  the store to a few megabytes. */
export const DEFAULT_MAX_CONVERSATIONS = 500

/**
 * One conversation's recall context: the topics its recent recalls primed and
 * the intent of its last recall. Never shared between conversations.
 */
export class SensoryBuffer {
  private items: Map<string, WorkingMemoryItem>
  private primedTopics: Map<string, PrimedTopic>
  private activeIntent: IntentResult | null
  private recallsSinceIntent: number
  private maxItems: number

  constructor(opts?: { maxItems?: number }) {
    this.items = new Map()
    this.primedTopics = new Map()
    this.activeIntent = null
    this.recallsSinceIntent = 0
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
   * Total priming boost for content whose own keywords include a primed
   * topic. Topics are matched as whole keywords (the same tokenisation that
   * primes them), so "art" never matches "start" and a long row gains nothing
   * from containing more substrings. Accumulates across matching topics,
   * capped at MAX_PRIMING_BOOST.
   */
  getPrimingBoost(content: string): number {
    if (this.primedTopics.size === 0) return 0
    const keywords = new Set(extractKeywords(content))
    let total = 0
    for (const [key, primed] of this.primedTopics) {
      if (keywords.has(key)) {
        total += primed.boost
      }
    }
    return Math.min(total, MAX_PRIMING_BOOST)
  }

  /**
   * Advance one recall: decrement turnsRemaining on all primed topics, remove
   * any whose counter reaches zero, and forget an intent set more than
   * PRIMING_HORIZON_RECALLS recalls ago.
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
    if (this.activeIntent !== null) {
      this.recallsSinceIntent += 1
      if (this.recallsSinceIntent >= PRIMING_HORIZON_RECALLS) {
        this.activeIntent = null
        this.recallsSinceIntent = 0
      }
    }
  }

  /** True when nothing in the buffer can affect a later recall. */
  isEmpty(): boolean {
    return this.items.size === 0 && this.primedTopics.size === 0 && this.activeIntent === null
  }

  // === Intent ===

  setIntent(intent: IntentResult): void {
    this.activeIntent = intent
    this.recallsSinceIntent = 0
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

  /** An independent copy: later writes to either buffer do not reach the other. */
  clone(): SensoryBuffer {
    const copy = new SensoryBuffer({ maxItems: this.maxItems })
    copy.restore(this.snapshot('clone'))
    copy.activeIntent = this.activeIntent
    copy.recallsSinceIntent = this.recallsSinceIntent
    return copy
  }
}

/** A point-in-time copy of every conversation's state, in LRU order. */
export type ConversationStoreSnapshot = ReadonlyArray<readonly [string, SensoryBuffer]>

/**
 * Recall context per conversation, keyed by the caller's conversation key.
 * Bounded by an LRU over keys; a key's state is dropped once its primed
 * topics and intent have all expired.
 */
export class ConversationStore {
  // Map iteration order is insertion order: the first key is the least
  // recently used, and acquire() re-inserts a key to mark it most recent.
  private buffers = new Map<string, SensoryBuffer>()
  private readonly maxConversations: number

  constructor(opts?: { maxConversations?: number }) {
    const max = opts?.maxConversations ?? DEFAULT_MAX_CONVERSATIONS
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`maxConversations must be a positive integer, got ${max}`)
    }
    this.maxConversations = max
  }

  /** The key's state, created on first use, and marked most recently used.
   *  Creating one past the cap drops the least recently used key. */
  acquire(key: string): SensoryBuffer {
    const existing = this.buffers.get(key)
    if (existing) {
      this.buffers.delete(key)
      this.buffers.set(key, existing)
      return existing
    }
    const created = new SensoryBuffer()
    this.buffers.set(key, created)
    while (this.buffers.size > this.maxConversations) {
      const oldest = this.buffers.keys().next().value as string
      this.buffers.delete(oldest)
    }
    return created
  }

  /** The key's state without touching its LRU position. */
  peek(key: string): SensoryBuffer | undefined {
    return this.buffers.get(key)
  }

  /** Advance only this key by one recall; drop its state once it is empty. */
  tick(key: string): void {
    const buffer = this.buffers.get(key)
    if (!buffer) return
    buffer.tick()
    if (buffer.isEmpty()) this.buffers.delete(key)
  }

  size(): number {
    return this.buffers.size
  }

  keys(): string[] {
    return [...this.buffers.keys()]
  }

  snapshot(): ConversationStoreSnapshot {
    return [...this.buffers].map(([key, buffer]) => [key, buffer.clone()] as const)
  }

  restore(snap: ConversationStoreSnapshot): void {
    this.buffers = new Map(snap.map(([key, buffer]) => [key, buffer.clone()]))
  }
}
