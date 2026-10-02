import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  deepSleep,
  supersessionSettingsFromEnv,
  SUPERSESSION_MIN_COSINE,
} from '../../src/consolidation/deep-sleep.js'
import type { SupersessionSettings } from '../../src/consolidation/deep-sleep.js'
import type {
  IntelligenceAdapter,
  SupersessionCandidate,
  SupersessionFact,
  SupersessionVerdict,
} from '../../src/adapters/intelligence.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { Digest, SearchResult, SemanticMemory } from '../../src/types.js'
import { makeDigest, makeMockStorage, resetIdCounter } from './mock-storage.js'

const STORED_AT = new Date('2026-09-01T10:00:00Z')
const VECTOR = [0.1, 0.2, 0.3]
const LLM: SupersessionSettings = { mode: 'llm', minCosine: SUPERSESSION_MIN_COSINE }
const REGEX: SupersessionSettings = { mode: 'regex', minCosine: SUPERSESSION_MIN_COSINE }
const OFF: SupersessionSettings = { mode: 'off', minCosine: SUPERSESSION_MIN_COSINE }

function neighbour(
  id: string,
  content: string,
  similarity: number,
  extra: Partial<SemanticMemory> = {},
): SearchResult<SemanticMemory> {
  return {
    item: {
      id,
      topic: 'reranker',
      content,
      confidence: 0.8,
      sourceDigestIds: [],
      sourceEpisodeIds: [],
      accessCount: 0,
      lastAccessed: null,
      decayRate: 0.02,
      supersedes: null,
      supersededBy: null,
      embedding: null,
      metadata: {},
      createdAt: STORED_AT,
      updatedAt: STORED_AT,
      projectId: null,
      ...extra,
    },
    similarity,
  }
}

/** Three digests whose text matches no extraction pattern, so the only
 *  semantic candidate is the one the stub extractKnowledge returns. */
function plainDigests(projectId: string | null = null): Digest[] {
  return [
    makeDigest({ summary: 'Session notes one.', projectId }),
    makeDigest({ summary: 'Session notes two.', projectId }),
    makeDigest({ summary: 'Session notes three.', projectId }),
  ]
}

type Judge = (fact: SupersessionFact, candidates: ReadonlyArray<SupersessionCandidate>) => Promise<SupersessionVerdict>

function intelligenceWith(content: string, judge?: Judge): IntelligenceAdapter & {
  judgeSupersession: ReturnType<typeof vi.fn>
} {
  const extractKnowledge = vi.fn()
    .mockResolvedValueOnce([{ topic: 'reranker', content, confidence: 0.8, sourceDigestIds: [], sourceEpisodeIds: [] }])
    .mockResolvedValue([])
  return {
    embed: vi.fn(async () => VECTOR),
    extractKnowledge,
    judgeSupersession: vi.fn(judge ?? (async () => ({ replaces: [], same: [] }))),
  }
}

function graphStub(): GraphPort & { runCypherWrite: ReturnType<typeof vi.fn> } {
  return {
    isAvailable: vi.fn(async () => true),
    runCypherWrite: vi.fn(async () => ({ records: [], summary: { counters: {} } })),
  } as unknown as GraphPort & { runCypherWrite: ReturnType<typeof vi.fn> }
}

describe('deep sleep fact supersession', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  describe('llm mode', () => {
    it('retires a stored fact that a one-word update replaces at cosine 0.95 instead of dropping the update', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'The reranker is bge.', 0.95)],
      })
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ replaces: ['old-1'], same: [] }))

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
      expect(storage.semantic.insert).toHaveBeenCalledTimes(1)
      const inserted = vi.mocked(storage.semantic.insert).mock.calls[0][0]
      expect(inserted).toEqual(expect.objectContaining({ content: 'The reranker is gte.', supersedes: 'old-1' }))
      const newId = storage.semantic._memories[0].id
      expect(storage.semantic.markSuperseded).toHaveBeenCalledWith('old-1', newId)
      expect(result.superseded).toBe(1)
      expect(result.deduplicated).toBe(0)
      expect(result.supersessionJudged).toBe(1)
    })

    it('passes the new fact and each neighbour with its stored date to the judge', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'The reranker is bge.', 0.95)],
      })
      const intelligence = intelligenceWith('The reranker is gte.')

      await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(intelligence.judgeSupersession).toHaveBeenCalledWith(
        { topic: 'reranker', content: 'The reranker is gte.' },
        [{ id: 'old-1', topic: 'reranker', content: 'The reranker is bge.', createdAt: STORED_AT }],
      )
    })

    it('still deduplicates a true duplicate the judge calls the same claim', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'We rerank with gte.', 0.97)],
      })
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ replaces: [], same: ['old-1'] }))

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledWith('old-1', 0.1)
      expect(storage.semantic.insert).not.toHaveBeenCalled()
      expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
      expect(result.deduplicated).toBe(1)
    })

    it('deduplicates on a neighbour above 0.88 when the judge lists it in neither list', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'The reranker is gte!', 0.93)],
      })
      const intelligence = intelligenceWith('The reranker is gte.')

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledWith('old-1', 0.1)
      expect(result.deduplicated).toBe(1)
      expect(storage.semantic.insert).not.toHaveBeenCalled()
    })

    it('inserts as new when the judge finds neither a replacement nor a duplicate', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'The reranker runs on CPU.', 0.7)],
      })
      const intelligence = intelligenceWith('The reranker is gte.')

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(storage.semantic.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedes: null }))
      expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
      expect(result.promoted).toBe(1)
      expect(result.supersessionJudged).toBe(1)
    })

    it('retires every replaced neighbour, records the first as supersedes and ignores ids outside the pool', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [
          neighbour('old-1', 'The reranker is bge.', 0.9),
          neighbour('old-2', 'The reranker is mxbai.', 0.8),
        ],
      })
      const intelligence = intelligenceWith(
        'The reranker is gte.',
        async () => ({ replaces: ['old-1', 'stranger', 'old-2'], same: [] }),
      )
      const graph = graphStub()

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM }, graph)

      const newId = storage.semantic._memories[0].id
      expect(storage.semantic.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedes: 'old-1' }))
      expect(vi.mocked(storage.semantic.markSuperseded).mock.calls).toEqual([
        ['old-1', newId],
        ['old-2', newId],
      ])
      expect(result.superseded).toBe(2)
      const contradicts = graph.runCypherWrite.mock.calls.filter(([q]) => String(q).includes('CONTRADICTS'))
      expect(contradicts.map(([, params]) => (params as { oldId: string }).oldId)).toEqual(['old-1', 'old-2'])
    })

    it('ignores a neighbour from a different project', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests('engram'),
        semanticNearestResults: [neighbour('other-1', 'The reranker is bge.', 0.95, { projectId: 'ouija' })],
      })
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ replaces: ['other-1'], same: [] }))

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(intelligence.judgeSupersession).not.toHaveBeenCalled()
      expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
      expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
      expect(storage.semantic.insert).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'engram' }))
      expect(result.supersessionJudged).toBe(0)
    })

    it('pairs a shared fact only with shared neighbours', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(null),
        semanticNearestResults: [
          neighbour('tagged-1', 'The reranker is bge.', 0.95, { projectId: 'engram' }),
          neighbour('shared-1', 'The reranker is mxbai.', 0.8, { projectId: null }),
        ],
      })
      const intelligence = intelligenceWith('The reranker is gte.')

      await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      const candidates = intelligence.judgeSupersession.mock.calls[0][1] as SupersessionCandidate[]
      expect(candidates.map(c => c.id)).toEqual(['shared-1'])
    })

    it('drops superseded and low-cosine neighbours and keeps at most five, nearest first', async () => {
      const nearest = [
        neighbour('low', 'Unrelated fact.', 0.59),
        neighbour('retired', 'The reranker was bge.', 0.99, { supersededBy: 'x' }),
        ...[0.61, 0.9, 0.7, 0.8, 0.65, 0.75].map((s, i) => neighbour(`n${i}`, `Reranker fact ${i}.`, s)),
      ]
      const storage = makeMockStorage({ initialDigests: plainDigests(), semanticNearestResults: nearest })
      const intelligence = intelligenceWith('The reranker is gte.')

      await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(storage.semantic.findNearest).toHaveBeenCalledWith(VECTOR, 10)
      const candidates = intelligence.judgeSupersession.mock.calls[0][1] as SupersessionCandidate[]
      expect(candidates.map(c => c.id)).toEqual(['n1', 'n3', 'n5', 'n2', 'n4'])
    })

    it('makes no judge call when no neighbour qualifies', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('low', 'Unrelated fact.', 0.3)],
      })
      const intelligence = intelligenceWith('The reranker is gte.')

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(intelligence.judgeSupersession).not.toHaveBeenCalled()
      expect(result.promoted).toBe(1)
      expect(result.supersessionJudged).toBe(0)
    })

    it('falls back to the regex path when the judge throws, logging ids only', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: "I don't like JavaScript." }),
        makeDigest({ summary: 'Filler content.' }),
        makeDigest({ summary: 'More filler.' }),
      ]
      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults: [neighbour('existing-1', 'I like JavaScript.', 0.5)],
        semanticNearestResults: [neighbour('existing-1', 'I like JavaScript.', 0.7)],
      })
      const judge = vi.fn(async () => {
        throw new Error('upstream said: I like JavaScript.')
      })
      const intelligence: IntelligenceAdapter = { embed: vi.fn(async () => VECTOR), judgeSupersession: judge }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(judge).toHaveBeenCalled()
      expect(storage.semantic.markSuperseded).toHaveBeenCalledWith('existing-1', expect.any(String))
      expect(result.superseded).toBeGreaterThanOrEqual(1)
      expect(result.supersessionJudged).toBe(judge.mock.calls.length)
      const lines = warn.mock.calls.map(args => args.join(' '))
      expect(lines.length).toBe(judge.mock.calls.length)
      for (const line of lines) {
        expect(line).toContain('existing-1')
        expect(line).not.toContain('JavaScript')
      }
    })
  })

  describe('regex mode', () => {
    it('does not deduplicate against a neighbour from a different project', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests('engram'),
        semanticNearestResults: [neighbour('other-1', 'The reranker is gte.', 0.97, { projectId: 'ouija' })],
      })
      const intelligence = intelligenceWith('The reranker is gte.')

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: REGEX })

      expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
      expect(result.deduplicated).toBe(0)
      expect(result.promoted).toBe(1)
    })

    it('does not deduplicate on equal text from a different project', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests('engram'),
        semanticSearchResults: [neighbour('other-1', 'The reranker is gte.', 0.5, { projectId: 'ouija' })],
      })
      const intelligence: IntelligenceAdapter = {
        extractKnowledge: vi.fn()
          .mockResolvedValueOnce([{ topic: 'reranker', content: 'The reranker is gte.', confidence: 0.8, sourceDigestIds: [], sourceEpisodeIds: [] }])
          .mockResolvedValue([]),
      }

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: REGEX })

      expect(result.deduplicated).toBe(0)
      expect(result.promoted).toBe(1)
    })

    it('never calls the judge', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'The reranker is bge.', 0.95)],
      })
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ replaces: ['old-1'], same: [] }))

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: REGEX })

      expect(intelligence.judgeSupersession).not.toHaveBeenCalled()
      expect(result.deduplicated).toBe(1)
      expect(result.supersessionJudged).toBe(0)
    })
  })

  describe('off mode', () => {
    it('never supersedes, even on a regex contradiction or a judge verdict', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: "I don't like JavaScript." }),
        makeDigest({ summary: 'Filler content.' }),
        makeDigest({ summary: 'More filler.' }),
      ]
      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults: [neighbour('existing-1', 'I like JavaScript.', 0.5)],
        semanticNearestResults: [neighbour('existing-1', 'I like JavaScript.', 0.7)],
      })
      const judge = vi.fn(async () => ({ replaces: ['existing-1'], same: [] }))
      const intelligence: IntelligenceAdapter = { embed: vi.fn(async () => VECTOR), judgeSupersession: judge }

      const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: OFF })

      expect(judge).not.toHaveBeenCalled()
      expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
      expect(storage.semantic.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedes: null }))
      expect(result.superseded).toBe(0)
    })
  })

  describe('settings from the environment', () => {
    it('defaults to regex mode at cosine 0.6', () => {
      expect(supersessionSettingsFromEnv({})).toEqual({ mode: 'regex', minCosine: 0.6 })
      expect(supersessionSettingsFromEnv({ ENGRAM_SUPERSESSION: ' ', ENGRAM_SUPERSESSION_MIN_COSINE: '' }))
        .toEqual({ mode: 'regex', minCosine: 0.6 })
    })

    it('reads the mode and the cosine floor', () => {
      expect(supersessionSettingsFromEnv({ ENGRAM_SUPERSESSION: 'llm', ENGRAM_SUPERSESSION_MIN_COSINE: '0.7' }))
        .toEqual({ mode: 'llm', minCosine: 0.7 })
      expect(supersessionSettingsFromEnv({ ENGRAM_SUPERSESSION: 'off' }).mode).toBe('off')
    })

    it('throws on a malformed value, naming the variable', () => {
      expect(() => supersessionSettingsFromEnv({ ENGRAM_SUPERSESSION: 'LLM' })).toThrow(/ENGRAM_SUPERSESSION /)
      expect(() => supersessionSettingsFromEnv({ ENGRAM_SUPERSESSION_MIN_COSINE: 'high' }))
        .toThrow(/ENGRAM_SUPERSESSION_MIN_COSINE/)
      expect(() => supersessionSettingsFromEnv({ ENGRAM_SUPERSESSION_MIN_COSINE: '1.5' }))
        .toThrow(/ENGRAM_SUPERSESSION_MIN_COSINE/)
    })

    it('runs the regex path when deep sleep is given no settings and the env is unset', async () => {
      vi.stubEnv('ENGRAM_SUPERSESSION', '')
      vi.stubEnv('ENGRAM_SUPERSESSION_MIN_COSINE', '')
      const digests: Digest[] = [
        makeDigest({ summary: "I don't like JavaScript." }),
        makeDigest({ summary: 'Filler content.' }),
        makeDigest({ summary: 'More filler.' }),
      ]
      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults: [neighbour('existing-1', 'I like JavaScript.', 0.5)],
        semanticNearestResults: [neighbour('existing-1', 'I like JavaScript.', 0.7)],
      })
      const judge = vi.fn(async () => ({ replaces: [], same: [] }))
      const intelligence: IntelligenceAdapter = { embed: vi.fn(async () => VECTOR), judgeSupersession: judge }

      const result = await deepSleep(storage, intelligence, { minDigests: 3 })

      expect(judge).not.toHaveBeenCalled()
      expect(storage.semantic.markSuperseded).toHaveBeenCalledWith('existing-1', expect.any(String))
      expect(result.supersessionJudged).toBe(0)
    })

    it('uses the judge when ENGRAM_SUPERSESSION=llm', async () => {
      vi.stubEnv('ENGRAM_SUPERSESSION', 'llm')
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'The reranker is bge.', 0.95)],
      })
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ replaces: ['old-1'], same: [] }))

      const result = await deepSleep(storage, intelligence, { minDigests: 3 })

      expect(result.supersessionJudged).toBe(1)
      expect(result.superseded).toBe(1)
    })
  })
})
