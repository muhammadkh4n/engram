import { describe, it, expect, beforeEach } from 'vitest'
import {
  SensoryBuffer,
  ConversationStore,
  PRIMING_HORIZON_RECALLS,
} from '../../src/systems/sensory-buffer.js'
import type { WorkingMemoryItem, IntentResult } from '../../src/types.js'
import { stagePrime } from '../../src/retrieval/priming.js'

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

function makeIntent(type: IntentResult['type']): IntentResult {
  return {
    type,
    confidence: 0.8,
    strategy: {
      shouldRecall: true,
      tiers: [],
      queryTransform: null,
      maxResults: 5,
      minRelevance: 0.3,
      includeAssociations: false,
      associationHops: 0,
      boostProcedural: false,
    },
    extractedCues: [],
    salience: 0.5,
  }
}

describe('SensoryBuffer whole-token priming', () => {
  it('does not boost a word that merely contains a primed topic', () => {
    const buf = new SensoryBuffer()
    buf.prime(['art'], 0.15, 5)
    expect(buf.getPrimingBoost('start the deploy')).toBe(0)
    expect(buf.getPrimingBoost('party smart cart')).toBe(0)
  })

  it('boosts the topic as a whole token, punctuation and case aside', () => {
    const buf = new SensoryBuffer()
    buf.prime(['art'], 0.15, 5)
    expect(buf.getPrimingBoost('Modern ART, mostly.')).toBe(0.15)
  })

  it('does not let a long row collect more boost by repeating a topic', () => {
    const buf = new SensoryBuffer()
    buf.prime(['deploy'], 0.15, 5)
    expect(buf.getPrimingBoost('deploy deploy deploy deploy')).toBe(0.15)
  })

  it('matches every topic stagePrime primes from the same text', () => {
    const buf = new SensoryBuffer()
    const memories = ['pgvector reindex ran on staging', 'staging pgvector index rebuilt'].map((content, i) => ({
      id: `m${i}`, type: 'episode' as const, content, relevance: 0.5, source: 'recall' as const, metadata: {},
    }))
    expect(stagePrime(memories, [], buf).sort()).toEqual(['pgvector', 'staging'])
    expect(buf.getPrimingBoost('the pgvector staging box')).toBe(0.3)
  })
})

describe('SensoryBuffer intent horizon', () => {
  it('forgets an intent after the horizon of recalls without a new one', () => {
    const buf = new SensoryBuffer()
    buf.setIntent(makeIntent('QUESTION'))
    for (let i = 0; i < PRIMING_HORIZON_RECALLS - 1; i++) buf.tick()
    expect(buf.getIntent()?.type).toBe('QUESTION')
    buf.tick()
    expect(buf.getIntent()).toBeNull()
    expect(buf.isEmpty()).toBe(true)
  })

  it('restarts the horizon when a new intent is set', () => {
    const buf = new SensoryBuffer()
    buf.setIntent(makeIntent('QUESTION'))
    for (let i = 0; i < PRIMING_HORIZON_RECALLS - 1; i++) buf.tick()
    buf.setIntent(makeIntent('DEBUGGING'))
    buf.tick()
    expect(buf.getIntent()?.type).toBe('DEBUGGING')
  })

  it('clone() copies priming and intent without sharing later writes', () => {
    const buf = new SensoryBuffer()
    buf.prime(['deploy'], 0.15, 5)
    buf.setIntent(makeIntent('QUESTION'))
    const copy = buf.clone()
    buf.prime(['other'], 0.15, 5)
    copy.tick()
    expect(copy.getPrimed().map((p) => p.topic)).toEqual(['deploy'])
    expect(copy.getIntent()?.type).toBe('QUESTION')
    expect(buf.getPrimed().map((p) => p.turnsRemaining)).toEqual([5, 5])
  })
})

describe('ConversationStore', () => {
  it('keeps each key\'s state apart', () => {
    const store = new ConversationStore()
    store.acquire('a').prime(['deploy'], 0.15, 5)
    store.acquire('b').setIntent(makeIntent('DEBUGGING'))
    expect(store.acquire('b').getPrimingBoost('deploy now')).toBe(0)
    expect(store.acquire('a').getIntent()).toBeNull()
    expect(store.acquire('a').getPrimingBoost('deploy now')).toBe(0.15)
  })

  it('drops the least recently used key past the cap', () => {
    const store = new ConversationStore({ maxConversations: 2 })
    store.acquire('a').prime(['alpha'], 0.15, 5)
    store.acquire('b').prime(['beta'], 0.15, 5)
    store.acquire('a') // a is now the most recent
    store.acquire('c').prime(['gamma'], 0.15, 5)
    expect(store.keys()).toEqual(['a', 'c'])
    expect(store.peek('b')).toBeUndefined()
    expect(store.size()).toBe(2)
  })

  it('peek() does not refresh a key', () => {
    const store = new ConversationStore({ maxConversations: 2 })
    store.acquire('a')
    store.acquire('b')
    store.peek('a')
    store.acquire('c')
    expect(store.keys()).toEqual(['b', 'c'])
  })

  it('tick() advances only the named key', () => {
    const store = new ConversationStore()
    store.acquire('a').prime(['alpha'], 0.15, 5)
    store.acquire('b').prime(['beta'], 0.15, 5)
    store.tick('a')
    store.tick('a')
    expect(store.peek('a')?.getPrimed()[0]?.turnsRemaining).toBe(3)
    expect(store.peek('b')?.getPrimed()[0]?.turnsRemaining).toBe(5)
  })

  it('expires a key after its own horizon of recalls', () => {
    const store = new ConversationStore()
    const a = store.acquire('a')
    a.prime(['alpha'], 0.15, PRIMING_HORIZON_RECALLS)
    a.setIntent(makeIntent('QUESTION'))
    store.acquire('b').prime(['beta'], 0.15, PRIMING_HORIZON_RECALLS)
    for (let i = 0; i < PRIMING_HORIZON_RECALLS - 1; i++) store.tick('a')
    expect(store.keys()).toEqual(['a', 'b'])
    store.tick('a')
    expect(store.keys()).toEqual(['b'])
    expect(store.peek('b')?.getPrimed()[0]?.turnsRemaining).toBe(PRIMING_HORIZON_RECALLS)
  })

  it('tick() on an unknown key creates nothing', () => {
    const store = new ConversationStore()
    store.tick('missing')
    expect(store.size()).toBe(0)
  })

  it('snapshot()/restore() put every key back as it was', () => {
    const store = new ConversationStore()
    store.acquire('a').prime(['alpha'], 0.15, 5)
    const snap = store.snapshot()
    store.acquire('a').prime(['later'], 0.15, 5)
    store.acquire('b')
    store.restore(snap)
    expect(store.keys()).toEqual(['a'])
    expect(store.peek('a')?.getPrimed().map((p) => p.topic)).toEqual(['alpha'])
  })

  it('rejects a cap that is not a positive integer', () => {
    expect(() => new ConversationStore({ maxConversations: 0 })).toThrow(RangeError)
  })
})
