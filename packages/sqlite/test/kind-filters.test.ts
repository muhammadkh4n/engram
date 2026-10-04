import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MEMORY_KINDS } from '@engram-mem/core'
import type { MemoryKind, MemoryType } from '@engram-mem/core'
import { SqliteStorageAdapter } from '../src/adapter.js'
import { registerEpisodeKindFunction } from '../src/search.js'
import { createTestDb } from './helpers.js'

interface KindCase {
  why: string
  tier: MemoryType
  metadata?: Record<string, unknown> | null
  sessionId?: string | null
  kind: MemoryKind
}

const cases = JSON.parse(
  readFileSync(new URL('../../core/src/memory-kind.cases.json', import.meta.url), 'utf8'),
) as KindCase[]

const TERM = 'quasarfilter'
const SAME_DIRECTION = [1, 0, 0, 0]
const STORED_SESSION = 'fixture-session-9f2c'

async function insertRow(
  adapter: SqliteStorageAdapter,
  tier: MemoryType,
  fields: { metadata?: Record<string, unknown> | null; sessionId: string; content?: string; embedding?: number[] },
): Promise<string> {
  const metadata = fields.metadata ?? {}
  const content = fields.content ?? `${TERM} row`
  const embedding = fields.embedding ?? SAME_DIRECTION
  switch (tier) {
    case 'episode':
      return (await adapter.episodes.insert({
        sessionId: fields.sessionId, role: 'user', content, salience: 0.5, accessCount: 0,
        lastAccessed: null, consolidatedAt: null, embedding, entities: [], metadata,
      })).id
    case 'digest':
      return (await adapter.digests.insert({
        sessionId: fields.sessionId, summary: content, keyTopics: [], sourceEpisodeIds: [],
        sourceDigestIds: [], level: 0, embedding, metadata,
      })).id
    case 'semantic':
      return (await adapter.semantic.insert({
        topic: TERM, content, confidence: 0.8, sourceDigestIds: [], sourceEpisodeIds: [],
        decayRate: 0.02, supersedes: null, supersededBy: null, embedding, metadata,
      })).id
    case 'procedural':
      return (await adapter.procedural.insert({
        category: 'workflow', trigger: TERM, procedure: content, confidence: 0.8, observationCount: 1,
        lastObserved: new Date(), firstObserved: new Date(), decayRate: 0.01, sourceEpisodeIds: [],
        embedding, metadata,
      })).id
  }
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort()
}

describe('engram_episode_kind SQL function', () => {
  it('returns the kind of every episode case, including a NULL session', () => {
    const db = createTestDb()
    registerEpisodeKindFunction(db)
    const stmt = db.prepare('SELECT engram_episode_kind(?, ?) AS kind')
    for (const c of cases.filter((x) => x.tier === 'episode')) {
      const metadataJson = c.metadata === undefined ? null : JSON.stringify(c.metadata)
      const row = stmt.get(metadataJson, c.sessionId ?? null) as { kind: string }
      expect(row.kind, c.why).toBe(c.kind)
    }
    db.close()
  })
})

describe('SqliteStorageAdapter kind and session filters', () => {
  let adapter: SqliteStorageAdapter

  beforeEach(async () => {
    adapter = new SqliteStorageAdapter()
    await adapter.initialize()
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  async function storeCases(): Promise<Map<MemoryKind, Set<string>>> {
    const idsByKind = new Map<MemoryKind, Set<string>>(MEMORY_KINDS.map((k) => [k, new Set<string>()]))
    for (const c of cases) {
      // episodes.session_id is NOT NULL here, so a NULL-session episode cannot
      // be stored; the SQL function test above covers that case.
      if (c.tier === 'episode' && (c.sessionId === null || c.sessionId === undefined)) continue
      const sessionId = c.tier === 'episode' ? (c.sessionId as string) : (c.sessionId ?? STORED_SESSION)
      const id = await insertRow(adapter, c.tier, { metadata: c.metadata, sessionId })
      idsByKind.get(c.kind)!.add(id)
    }
    return idsByKind
  }

  it('vectorSearch returns every stored case only under its own kind', async () => {
    const idsByKind = await storeCases()
    for (const kind of MEMORY_KINDS) {
      const results = await adapter.vectorSearch(SAME_DIRECTION, { kinds: [kind], limit: 500 })
      expect(sorted(results.map((r) => r.item.data.id)), kind).toEqual(sorted(idsByKind.get(kind)!))
    }
  })

  it('textBoost returns every stored case only under its own kind', async () => {
    const idsByKind = await storeCases()
    for (const kind of MEMORY_KINDS) {
      const results = await adapter.textBoost([TERM], { kinds: [kind], limit: 500 })
      expect(sorted(results.map((r) => r.id)), kind).toEqual(sorted(idsByKind.get(kind)!))
    }
  })

  it('without kinds or excludeSessionId every row comes back, as with every kind named', async () => {
    const idsByKind = await storeCases()
    const all = sorted([...idsByKind.values()].flatMap((s) => [...s]))
    const vectorPlain = await adapter.vectorSearch(SAME_DIRECTION, { limit: 500 })
    const textPlain = await adapter.textBoost([TERM], { limit: 500 })
    expect(sorted(vectorPlain.map((r) => r.item.data.id))).toEqual(all)
    expect(sorted(textPlain.map((r) => r.id))).toEqual(all)
    const vectorAll = await adapter.vectorSearch(SAME_DIRECTION, { kinds: [...MEMORY_KINDS], limit: 500 })
    expect(vectorAll.map((r) => r.item.data.id)).toEqual(vectorPlain.map((r) => r.item.data.id))
  })

  it('an empty kinds list matches nothing', async () => {
    await storeCases()
    expect(await adapter.vectorSearch(SAME_DIRECTION, { kinds: [], limit: 500 })).toEqual([])
    expect(await adapter.textBoost([TERM], { kinds: [], limit: 500 })).toEqual([])
  })

  it('excludeSessionId drops that session\'s episodes and digests and nothing else', async () => {
    const dropped = 'session-to-drop-41ab'
    const kept = 'session-kept-7d0e'
    const droppedIds = [
      await insertRow(adapter, 'episode', { sessionId: dropped }),
      await insertRow(adapter, 'digest', { sessionId: dropped }),
    ]
    const keptIds = [
      await insertRow(adapter, 'episode', { sessionId: kept }),
      await insertRow(adapter, 'digest', { sessionId: kept }),
      await insertRow(adapter, 'semantic', { sessionId: dropped }),
      await insertRow(adapter, 'procedural', { sessionId: dropped }),
    ]
    const vector = await adapter.vectorSearch(SAME_DIRECTION, { excludeSessionId: dropped, limit: 50 })
    const text = await adapter.textBoost([TERM], { excludeSessionId: dropped, limit: 50 })
    expect(sorted(vector.map((r) => r.item.data.id))).toEqual(sorted(keptIds))
    expect(sorted(text.map((r) => r.id))).toEqual(sorted(keptIds))
    expect(droppedIds.every((id) => !keptIds.includes(id))).toBe(true)
  })

  it('filters before the limit, so a filtered search still fills it', async () => {
    const session = 'session-limit-c3d9'
    for (let i = 0; i < 12; i++) {
      await insertRow(adapter, 'episode', {
        sessionId: session,
        metadata: { source: 'hook-capture' },
        content: `${TERM} ${TERM} ${TERM} ${TERM} turn ${i}`,
        embedding: SAME_DIRECTION,
      })
    }
    const decisions: string[] = []
    for (let i = 0; i < 3; i++) {
      decisions.push(await insertRow(adapter, 'episode', {
        sessionId: session,
        metadata: { source: 'hook-capture', salienceCategory: 'decision' },
        content: `${TERM} decision ${i} with several other words that dilute the term`,
        embedding: [0.5, 0.5, 0.5, 0.5],
      }))
    }
    const vector = await adapter.vectorSearch(SAME_DIRECTION, { kinds: ['decision'], limit: 3 })
    expect(sorted(vector.map((r) => r.item.data.id))).toEqual(sorted(decisions))
    const text = await adapter.textBoost([TERM], { kinds: ['decision'], limit: 3 })
    expect(sorted(text.map((r) => r.id))).toEqual(sorted(decisions))
  })

  it('a tier left out by tiers stays out whatever kinds says', async () => {
    const decision = await insertRow(adapter, 'episode', {
      sessionId: 'session-tiers-55e1',
      metadata: { source: 'hook-capture', salienceCategory: 'decision' },
    })
    await insertRow(adapter, 'semantic', { sessionId: STORED_SESSION })
    const results = await adapter.vectorSearch(SAME_DIRECTION, {
      tiers: ['episode'],
      kinds: ['fact', 'decision'],
      limit: 50,
    })
    expect(results.map((r) => r.item.data.id)).toEqual([decision])
  })
})
