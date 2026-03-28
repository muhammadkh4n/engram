import { describe, it, expect, beforeEach } from 'vitest'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import type { WorkingMemoryItem, IntentResult } from '../../src/types.js'

function makeItem(key: string, importance: number): WorkingMemoryItem {
  return {
    key,
    value: `value for ${key}`,
    category: 'topic',
    importance,
    timestamp: Date.now(),
  }
}

describe('SensoryBuffer', () => {
  let buf: SensoryBuffer

  beforeEach(() => {
    buf = new SensoryBuffer()
  })

  // === Basic item operations ===

  describe('set / get / remove', () => {
    it('stores and retrieves an item by key', () => {
      const item = makeItem('foo', 0.5)
      buf.set(item)
      expect(buf.get('foo')).toEqual(item)
    })

    it('overwrites an existing item with the same key', () => {
      buf.set(makeItem('foo', 0.5))
      const updated = { ...makeItem('foo', 0.9), value: 'updated' }
      buf.set(updated)
      expect(buf.get('foo')).toEqual(updated)
      expect(buf.size()).toBe(1)
    })

    it('returns undefined for a missing key', () => {
      expect(buf.get('missing')).toBeUndefined()
    })

    it('removes an item by key', () => {
      buf.set(makeItem('foo', 0.5))
      buf.remove('foo')
      expect(buf.get('foo')).toBeUndefined()
      expect(buf.size()).toBe(0)
    })

    it('remove is a no-op for a non-existent key', () => {
      expect(() => buf.remove('nope')).not.toThrow()
    })

    it('size() reflects the current item count', () => {
      expect(buf.size()).toBe(0)
      buf.set(makeItem('a', 0.1))
      buf.set(makeItem('b', 0.2))
      expect(buf.size()).toBe(2)
    })

    it('clear() removes all items', () => {
      buf.set(makeItem('a', 0.5))
      buf.set(makeItem('b', 0.7))
      buf.clear()
      expect(buf.size()).toBe(0)
    })

    it('getAll() returns items sorted by descending importance', () => {
      buf.set(makeItem('low', 0.1))
      buf.set(makeItem('high', 0.9))
      buf.set(makeItem('mid', 0.5))
      const all = buf.getAll()
      expect(all.map((i) => i.key)).toEqual(['high', 'mid', 'low'])
    })
  })

  // === Eviction ===

  describe('eviction', () => {
    it('evicts the item with the lowest importance when at capacity', () => {
      buf = new SensoryBuffer({ maxItems: 3 })
      buf.set(makeItem('a', 0.8))
      buf.set(makeItem('b', 0.2)) // lowest importance
      buf.set(makeItem('c', 0.5))
      // Buffer is now full (3/3). Adding a 4th item should evict 'b'.
      buf.set(makeItem('d', 0.6))

      expect(buf.size()).toBe(3)
      expect(buf.get('b')).toBeUndefined()
      expect(buf.get('a')).toBeDefined()
      expect(buf.get('c')).toBeDefined()
      expect(buf.get('d')).toBeDefined()
    })

    it('does NOT evict when updating an existing key at capacity', () => {
      buf = new SensoryBuffer({ maxItems: 3 })
      buf.set(makeItem('a', 0.8))
      buf.set(makeItem('b', 0.2))
      buf.set(makeItem('c', 0.5))
      // Update 'b' in place — no eviction should occur
      buf.set({ ...makeItem('b', 0.3), value: 'updated b' })
      expect(buf.size()).toBe(3)
      expect(buf.get('b')?.value).toBe('updated b')
    })
  })

  // === Priming ===

  describe('prime / getPrimed', () => {
    it('adds primed topics via prime()', () => {
      buf.prime(['typescript', 'memory'], 0.15, 5)
      const primed = buf.getPrimed()
      expect(primed).toHaveLength(2)
      const topics = primed.map((p) => p.topic)
      expect(topics).toContain('typescript')
      expect(topics).toContain('memory')
    })

    it('stores the boost and turnsRemaining on each primed topic', () => {
      buf.prime(['foo'], 0.2, 3)
      const [primed] = buf.getPrimed()
      expect(primed.boost).toBe(0.2)
      expect(primed.turnsRemaining).toBe(3)
    })

    it('overwrites a topic if primed again with the same name', () => {
      buf.prime(['foo'], 0.1, 5)
      buf.prime(['foo'], 0.25, 2)
      expect(buf.getPrimed()).toHaveLength(1)
      expect(buf.getPrimed()[0].boost).toBe(0.25)
    })

    it('getPrimed() returns empty array when nothing is primed', () => {
      expect(buf.getPrimed()).toEqual([])
    })
  })

  // === getPrimingBoost ===

  describe('getPrimingBoost', () => {
    it('returns the boost for content that contains a primed topic', () => {
      buf.prime(['typescript'], 0.15, 5)
      const boost = buf.getPrimingBoost('I am learning TypeScript today')
      expect(boost).toBe(0.15)
    })

    it('returns 0 for content that matches no primed topic', () => {
      buf.prime(['typescript'], 0.15, 5)
      expect(buf.getPrimingBoost('python is great')).toBe(0)
    })

    it('is case-insensitive', () => {
      buf.prime(['TypeScript'], 0.15, 5)
      expect(buf.getPrimingBoost('typescript rocks')).toBe(0.15)
    })

    it('accumulates boost across multiple matching topics', () => {
      buf.prime(['typescript', 'memory'], 0.1, 5)
      // Both topics appear in the content → 0.1 + 0.1 = 0.2
      const boost = buf.getPrimingBoost('typescript and memory systems')
      expect(boost).toBeCloseTo(0.2)
    })

    it('caps total boost at 0.3 even when multiple topics match (A5)', () => {
      // 5 topics × 0.15 each = 0.75 raw, but must be capped at 0.3
      buf.prime(['alpha', 'beta', 'gamma', 'delta', 'epsilon'], 0.15, 5)
      const boost = buf.getPrimingBoost('alpha beta gamma delta epsilon all here')
      expect(boost).toBe(0.3)
    })

    it('returns 0 when no topics are primed', () => {
      expect(buf.getPrimingBoost('anything')).toBe(0)
    })
  })

  // === tick ===

  describe('tick', () => {
    it('decrements turnsRemaining on each primed topic', () => {
      buf.prime(['foo'], 0.15, 3)
      buf.tick()
      expect(buf.getPrimed()[0].turnsRemaining).toBe(2)
    })

    it('removes topics whose turnsRemaining reaches 0', () => {
      buf.prime(['foo'], 0.15, 1)
      buf.tick()
      expect(buf.getPrimed()).toHaveLength(0)
    })

    it('removes only expired topics, keeping others alive', () => {
      buf.prime(['short'], 0.1, 1)
      buf.prime(['long'], 0.1, 5)
      buf.tick()
      const remaining = buf.getPrimed()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].topic).toBe('long')
      expect(remaining[0].turnsRemaining).toBe(4)
    })

    it('is a no-op when nothing is primed', () => {
      expect(() => buf.tick()).not.toThrow()
      expect(buf.getPrimed()).toHaveLength(0)
    })
  })

  // === Intent ===

  describe('setIntent / getIntent', () => {
    it('returns null before any intent is set', () => {
      expect(buf.getIntent()).toBeNull()
    })

    it('stores and returns the intent', () => {
      const intent: IntentResult = {
        type: 'QUESTION',
        confidence: 0.9,
        strategy: {
          shouldRecall: true,
          tiers: [],
          queryTransform: null,
          maxResults: 10,
          minRelevance: 0.3,
          includeAssociations: false,
          associationHops: 0,
          boostProcedural: false,
        },
        extractedCues: ['memory', 'systems'],
        salience: 0.7,
        expandedQueries: ['memory systems'],
      }
      buf.setIntent(intent)
      expect(buf.getIntent()).toEqual(intent)
    })

    it('overwrites the previous intent', () => {
      const intent1: IntentResult = {
        type: 'QUESTION',
        confidence: 0.5,
        strategy: {
          shouldRecall: false,
          tiers: [],
          queryTransform: null,
          maxResults: 5,
          minRelevance: 0.2,
          includeAssociations: false,
          associationHops: 0,
          boostProcedural: false,
        },
        extractedCues: [],
        salience: 0.3,
        expandedQueries: [],
      }
      const intent2 = { ...intent1, type: 'TASK_START' as const }
      buf.setIntent(intent1)
      buf.setIntent(intent2)
      expect(buf.getIntent()?.type).toBe('TASK_START')
    })
  })

  // === Snapshot / Restore ===

  describe('snapshot / restore', () => {
    it('round-trips items through snapshot and restore', () => {
      buf.set(makeItem('x', 0.6))
      buf.set(makeItem('y', 0.4))
      const snap = buf.snapshot('session-42')

      const buf2 = new SensoryBuffer()
      buf2.restore(snap)

      expect(buf2.size()).toBe(2)
      expect(buf2.get('x')).toMatchObject({ key: 'x', importance: 0.6, category: 'topic' })
      expect(buf2.get('y')).toMatchObject({ key: 'y', importance: 0.4, category: 'topic' })
    })

    it('round-trips primed topics through snapshot and restore', () => {
      buf.prime(['rust', 'wasm'], 0.2, 4)
      const snap = buf.snapshot('session-42')

      const buf2 = new SensoryBuffer()
      buf2.restore(snap)

      const primed = buf2.getPrimed()
      expect(primed).toHaveLength(2)
      const topics = primed.map((p) => p.topic)
      expect(topics).toContain('rust')
      expect(topics).toContain('wasm')
    })

    it('snapshot includes the correct sessionId and a savedAt date', () => {
      const snap = buf.snapshot('session-99')
      expect(snap.sessionId).toBe('session-99')
      expect(snap.savedAt).toBeInstanceOf(Date)
    })

    it('restore replaces existing state entirely', () => {
      buf.set(makeItem('old', 0.9))
      buf.prime(['old-topic'], 0.1, 3)

      const fresh = new SensoryBuffer()
      fresh.set(makeItem('new', 0.5))
      const snap = fresh.snapshot('s1')

      buf.restore(snap)
      expect(buf.get('old')).toBeUndefined()
      expect(buf.get('new')).toBeDefined()
      expect(buf.getPrimed()).toHaveLength(0)
    })

    it('restored priming boost works correctly after restore', () => {
      buf.prime(['typescript'], 0.15, 5)
      const snap = buf.snapshot('s1')

      const buf2 = new SensoryBuffer()
      buf2.restore(snap)

      expect(buf2.getPrimingBoost('I love TypeScript')).toBe(0.15)
    })
  })
})
