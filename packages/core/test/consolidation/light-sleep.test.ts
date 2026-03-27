import { describe, it, expect, beforeEach, vi } from 'vitest'
import { lightSleep } from '../../src/consolidation/light-sleep.js'
import {
  makeMockStorage,
  makeEpisode,
  resetIdCounter,
} from './mock-storage.js'
import type { Episode } from '../../src/types.js'

function makeSession(
  sessionId: string,
  count: number,
  salienceBase = 0.5
): Episode[] {
  return Array.from({ length: count }, (_, i) =>
    makeEpisode({
      sessionId,
      content: `Episode ${i + 1} content for ${sessionId}. This is important information about topic ${i % 3}.`,
      salience: salienceBase + (i % 3) * 0.1,
    })
  )
}

describe('lightSleep', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  // -------------------------------------------------------------------------
  // Core: digests are created and episodes are marked consolidated
  // -------------------------------------------------------------------------

  describe('creates digests from unconsolidated episodes', () => {
    it('creates one digest for a session with exactly minEpisodes episodes', async () => {
      const session1 = makeSession('s1', 5)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      const result = await lightSleep(storage, undefined, { minEpisodes: 5 })

      expect(result.cycle).toBe('light')
      expect(result.digestsCreated).toBe(1)
      expect(result.episodesProcessed).toBe(5)
    })

    it('creates multiple digests when episodes exceed batchSize', async () => {
      const session1 = makeSession('s1', 25)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      const result = await lightSleep(storage, undefined, { batchSize: 10, minEpisodes: 5 })

      // 25 episodes / 10 per batch = 3 batches (10+10+5)
      expect(result.digestsCreated).toBe(3)
      expect(result.episodesProcessed).toBe(25)
    })

    it('processes multiple sessions independently', async () => {
      const s1 = makeSession('s1', 6)
      const s2 = makeSession('s2', 8)
      const episodesPerSession = new Map([
        ['s1', s1],
        ['s2', s2],
      ])
      const storage = makeMockStorage({
        sessions: ['s1', 's2'],
        episodesPerSession,
      })

      const result = await lightSleep(storage, undefined, { minEpisodes: 5 })

      expect(result.digestsCreated).toBe(2)
      expect(result.episodesProcessed).toBe(14)
    })

    it('inserts digests with sourceEpisodeIds pointing to batch episodes', async () => {
      const session1 = makeSession('s1', 5)
      const episodeIds = session1.map(e => e.id)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      await lightSleep(storage, undefined, { minEpisodes: 5 })

      expect(storage.digests.insert).toHaveBeenCalledOnce()
      const insertCall = vi.mocked(storage.digests.insert).mock.calls[0][0]
      expect(insertCall.sessionId).toBe('s1')
      expect(insertCall.sourceEpisodeIds).toEqual(expect.arrayContaining(episodeIds))
      expect(insertCall.level).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Episodes are marked consolidated
  // -------------------------------------------------------------------------

  describe('marks episodes as consolidated', () => {
    it('calls markConsolidated with all episode ids in the batch', async () => {
      const session1 = makeSession('s1', 5)
      const episodeIds = session1.map(e => e.id)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      await lightSleep(storage, undefined, { minEpisodes: 5 })

      expect(storage.episodes.markConsolidated).toHaveBeenCalledOnce()
      const markedIds = vi.mocked(storage.episodes.markConsolidated).mock.calls[0][0]
      expect(markedIds).toEqual(expect.arrayContaining(episodeIds))
      expect(markedIds).toHaveLength(5)
    })

    it('calls markConsolidated once per batch', async () => {
      const session1 = makeSession('s1', 22)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      await lightSleep(storage, undefined, { batchSize: 10, minEpisodes: 5 })

      // 3 batches → 3 markConsolidated calls
      expect(storage.episodes.markConsolidated).toHaveBeenCalledTimes(3)
    })
  })

  // -------------------------------------------------------------------------
  // Creates derives_from associations
  // -------------------------------------------------------------------------

  describe('creates derives_from association edges', () => {
    it('creates one derives_from edge per episode in the batch', async () => {
      const session1 = makeSession('s1', 5)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      await lightSleep(storage, undefined, { minEpisodes: 5 })

      // 5 episodes → 5 derives_from edges
      expect(storage.associations.insert).toHaveBeenCalledTimes(5)

      const calls = vi.mocked(storage.associations.insert).mock.calls
      for (const [assoc] of calls) {
        expect(assoc.edgeType).toBe('derives_from')
        expect(assoc.sourceType).toBe('episode')
        expect(assoc.targetType).toBe('digest')
        expect(assoc.strength).toBe(0.8)
      }
    })

    it('all edges point to the same digest id', async () => {
      const session1 = makeSession('s1', 5)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      await lightSleep(storage, undefined, { minEpisodes: 5 })

      const insertedDigestId = vi.mocked(storage.digests.insert).mock.results[0].value.then
        ? undefined // async — we'll check via the association calls
        : undefined

      const assocCalls = vi.mocked(storage.associations.insert).mock.calls
      const targetIds = assocCalls.map(([a]) => a.targetId)
      // All should point to the same digest
      const uniqueTargets = new Set(targetIds)
      expect(uniqueTargets.size).toBe(1)
    })

    it('episode ids in association sourceId match the batch episodes', async () => {
      const session1 = makeSession('s1', 5)
      const episodeIds = new Set(session1.map(e => e.id))
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      await lightSleep(storage, undefined, { minEpisodes: 5 })

      const assocCalls = vi.mocked(storage.associations.insert).mock.calls
      for (const [assoc] of assocCalls) {
        expect(episodeIds.has(assoc.sourceId)).toBe(true)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Heuristic summarization when no intelligence adapter
  // -------------------------------------------------------------------------

  describe('uses heuristic summarization when no intelligence adapter', () => {
    it('produces a non-empty summary without LLM', async () => {
      const session1 = makeSession('s1', 5)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({ sessions: ['s1'], episodesPerSession })

      await lightSleep(storage, undefined, { minEpisodes: 5 })

      const insertCall = vi.mocked(storage.digests.insert).mock.calls[0][0]
      expect(insertCall.summary).toBeTruthy()
      expect(typeof insertCall.summary).toBe('string')
    })

    it('produces keyTopics from heuristic extraction', async () => {
      const session1 = makeSession('s1', 5)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({ sessions: ['s1'], episodesPerSession })

      await lightSleep(storage, undefined, { minEpisodes: 5 })

      const insertCall = vi.mocked(storage.digests.insert).mock.calls[0][0]
      expect(Array.isArray(insertCall.keyTopics)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Skips sessions with fewer than minEpisodes
  // -------------------------------------------------------------------------

  describe('skips sessions with fewer than minEpisodes', () => {
    it('skips a session with 4 episodes when minEpisodes is 5', async () => {
      const session1 = makeSession('s1', 4)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({
        sessions: ['s1'],
        episodesPerSession,
      })

      const result = await lightSleep(storage, undefined, { minEpisodes: 5 })

      expect(result.digestsCreated).toBe(0)
      expect(result.episodesProcessed).toBe(0)
      expect(storage.digests.insert).not.toHaveBeenCalled()
    })

    it('processes a session that meets minEpisodes while skipping one that does not', async () => {
      const small = makeSession('s-small', 3)
      const large = makeSession('s-large', 6)
      const episodesPerSession = new Map([
        ['s-small', small],
        ['s-large', large],
      ])
      const storage = makeMockStorage({
        sessions: ['s-small', 's-large'],
        episodesPerSession,
      })

      const result = await lightSleep(storage, undefined, { minEpisodes: 5 })

      expect(result.digestsCreated).toBe(1)
      expect(result.episodesProcessed).toBe(6)
    })

    it('returns zero counts when all sessions are below threshold', async () => {
      const s1 = makeSession('s1', 2)
      const s2 = makeSession('s2', 1)
      const episodesPerSession = new Map([
        ['s1', s1],
        ['s2', s2],
      ])
      const storage = makeMockStorage({
        sessions: ['s1', 's2'],
        episodesPerSession,
      })

      const result = await lightSleep(storage, undefined, { minEpisodes: 5 })

      expect(result.digestsCreated).toBe(0)
      expect(result.episodesProcessed).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Uses intelligence adapter when available
  // -------------------------------------------------------------------------

  describe('uses intelligence adapter when provided', () => {
    it('calls intelligence.summarize with preserve_details mode', async () => {
      const session1 = makeSession('s1', 5)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({ sessions: ['s1'], episodesPerSession })

      const mockSummarize = vi.fn().mockResolvedValue({
        text: 'AI-generated summary for the batch.',
        topics: ['ai', 'summary'],
        entities: ['entity1'],
        decisions: ['use AI'],
      })

      const intelligence = { summarize: mockSummarize }

      await lightSleep(storage, intelligence, { minEpisodes: 5 })

      expect(mockSummarize).toHaveBeenCalledOnce()
      const [_content, opts] = mockSummarize.mock.calls[0]
      expect(opts.mode).toBe('preserve_details')
    })

    it('uses the LLM summary text in the digest', async () => {
      const session1 = makeSession('s1', 5)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({ sessions: ['s1'], episodesPerSession })

      const intelligence = {
        summarize: vi.fn().mockResolvedValue({
          text: 'Precise AI summary text.',
          topics: ['precision'],
          entities: [],
          decisions: [],
        }),
      }

      await lightSleep(storage, intelligence, { minEpisodes: 5 })

      const insertCall = vi.mocked(storage.digests.insert).mock.calls[0][0]
      expect(insertCall.summary).toBe('Precise AI summary text.')
      expect(insertCall.keyTopics).toEqual(['precision'])
    })

    it('falls back to heuristic if intelligence.summarize throws', async () => {
      const session1 = makeSession('s1', 5)
      const episodesPerSession = new Map([['s1', session1]])
      const storage = makeMockStorage({ sessions: ['s1'], episodesPerSession })

      const intelligence = {
        summarize: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      }

      // Should not throw
      const result = await lightSleep(storage, intelligence, { minEpisodes: 5 })

      expect(result.digestsCreated).toBe(1)
      const insertCall = vi.mocked(storage.digests.insert).mock.calls[0][0]
      expect(insertCall.summary).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // Returns correct result shape
  // -------------------------------------------------------------------------

  describe('returns correct ConsolidateResult', () => {
    it('includes cycle: "light" in result', async () => {
      const storage = makeMockStorage({ sessions: [] })
      const result = await lightSleep(storage, undefined)
      expect(result.cycle).toBe('light')
    })

    it('returns zero counts when no sessions', async () => {
      const storage = makeMockStorage({ sessions: [] })
      const result = await lightSleep(storage, undefined)
      expect(result.digestsCreated).toBe(0)
      expect(result.episodesProcessed).toBe(0)
    })
  })
})
