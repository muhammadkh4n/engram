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
import { supersessionRuleOutcome } from '../../src/adapters/intelligence.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { Digest, SearchResult, SemanticMemory } from '../../src/types.js'
import { makeDigest, makeEpisode, makeMockStorage, resetIdCounter } from './mock-storage.js'
import { createMemory } from '../../src/create-memory.js'

const STORED_AT = new Date('2026-09-01T10:00:00Z')
/** Later than STORED_AT, so a conflicting candidate is the newer statement. */
const DIGEST_AT = new Date('2026-09-20T10:00:00Z')
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
    makeDigest({ summary: 'Session notes one.', projectId, createdAt: DIGEST_AT }),
    makeDigest({ summary: 'Session notes two.', projectId, createdAt: DIGEST_AT }),
    makeDigest({ summary: 'Session notes three.', projectId, createdAt: DIGEST_AT }),
  ]
}

/** Every fact labelled a current state, the kinds under which a conflict may retire. */
function allState(...ids: string[]): SupersessionVerdict['kinds'] {
  return Object.fromEntries(['new', ...ids].map(id => [id, 'state' as const]))
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
    judgeSupersession: vi.fn(judge ?? (async () => ({ same: [], conflicts: [], kinds: {} }))),
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
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ conflicts: ['old-1'], same: [], kinds: allState('old-1') }))

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

    it('passes the new fact and each neighbour with its statement date to the judge', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'The reranker is bge.', 0.95)],
      })
      const intelligence = intelligenceWith('The reranker is gte.')

      await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

      expect(intelligence.judgeSupersession).toHaveBeenCalledWith(
        { topic: 'reranker', content: 'The reranker is gte.', statedAt: DIGEST_AT },
        [{ id: 'old-1', topic: 'reranker', content: 'The reranker is bge.', statedAt: STORED_AT }],
      )
    })

    it('still deduplicates a true duplicate the judge calls the same claim', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [neighbour('old-1', 'We rerank with gte.', 0.97)],
      })
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ same: ['old-1'], conflicts: [] }))

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
        async () => ({ conflicts: ['old-1', 'stranger', 'old-2'], same: [], kinds: allState('old-1', 'stranger', 'old-2') }),
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

    it('stamps forgottenAt on exactly the retired facts\' graph nodes, in the statement that sets validUntil', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests(),
        semanticNearestResults: [
          neighbour('old-1', 'The reranker is bge.', 0.9),
          neighbour('old-2', 'The reranker is mxbai.', 0.8),
          neighbour('kept', 'The reranker runs on the CPU.', 0.7),
        ],
      })
      const intelligence = intelligenceWith(
        'The reranker is gte.',
        async () => ({ conflicts: ['old-1', 'stranger', 'old-2'], same: [], kinds: allState('old-1', 'stranger', 'old-2') }),
      )
      const graph = graphStub()

      await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM }, graph)

      const newId = storage.semantic._memories[0].id
      const stamping = graph.runCypherWrite.mock.calls.filter(([q]) => String(q).includes('forgottenAt'))
      expect(stamping.map(([, params]) => params)).toEqual([
        expect.objectContaining({ oldId: 'old-1', newId }),
        expect.objectContaining({ oldId: 'old-2', newId }),
      ])
      for (const [query, params] of stamping) {
        expect(String(query)).toMatch(/old\.validUntil = \$now,\s+old\.forgottenAt = coalesce\(old\.forgottenAt, \$now\)/)
        expect(String(query)).not.toMatch(/new\.forgottenAt/)
        expect((params as { now: unknown }).now).toEqual(expect.any(String))
      }
    })

    it('ignores a neighbour from a different project', async () => {
      const storage = makeMockStorage({
        initialDigests: plainDigests('engram'),
        semanticNearestResults: [neighbour('other-1', 'The reranker is bge.', 0.95, { projectId: 'ouija' })],
      })
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ conflicts: ['other-1'], same: [], kinds: allState('other-1') }))

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
      const intelligence = intelligenceWith('The reranker is gte.', async () => ({ conflicts: ['old-1'], same: [], kinds: allState('old-1') }))

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
      const judge = vi.fn(async () => ({ conflicts: ['existing-1'], same: [], kinds: allState('existing-1') }))
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
      const judge = vi.fn(async () => ({ same: [], conflicts: [] }))
      const intelligence: IntelligenceAdapter = { embed: vi.fn(async () => VECTOR), judgeSupersession: judge }

      const result = await deepSleep(storage, intelligence, { minDigests: 3 })

      expect(judge).not.toHaveBeenCalled()
      expect(storage.semantic.markSuperseded).toHaveBeenCalledWith('existing-1', expect.any(String))
      expect(result.supersessionJudged).toBe(0)
    })

    it.each([['llm'], ['not-a-mode']])(
      'reads no environment variable when given no settings (ENGRAM_SUPERSESSION=%s)',
      async (mode) => {
        vi.stubEnv('ENGRAM_SUPERSESSION', mode)
        vi.stubEnv('ENGRAM_SUPERSESSION_MIN_COSINE', 'high')
        const storage = makeMockStorage({
          initialDigests: plainDigests(),
          semanticNearestResults: [neighbour('old-1', 'The reranker is bge.', 0.95)],
        })
        const intelligence = intelligenceWith('The reranker is gte.', async () => ({ same: [], conflicts: ['old-1'], kinds: allState('old-1') }))

        const result = await deepSleep(storage, intelligence, { minDigests: 3 })

        expect(intelligence.judgeSupersession).not.toHaveBeenCalled()
        expect(result.supersessionJudged).toBe(0)
      },
    )
  })
})

describe('deep sleep supersession direction from statement time', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const MONDAY = new Date('2026-09-28T09:00:00Z')
  const WEDNESDAY = new Date('2026-09-30T09:00:00Z')
  const BGE = 'The reranker is bge.'
  const GTE = 'The reranker is gte.'

  /** Extracts one reranker fact from each digest that names a model. */
  function extractingIntelligence(): IntelligenceAdapter & { judgeSupersession: ReturnType<typeof vi.fn> } {
    return {
      embed: vi.fn(async () => VECTOR),
      extractKnowledge: vi.fn(async (summary: string) => {
        const content = summary.includes('bge') ? BGE : summary.includes('gte') ? GTE : null
        return content ? [{ topic: 'reranker', content, confidence: 0.8, sourceDigestIds: [], sourceEpisodeIds: [] }] : []
      }),
      // Relation only: equal text is the same claim, any other reranker
      // value conflicts. The stub knows nothing about dates.
      judgeSupersession: vi.fn(async (fact: SupersessionFact, candidates: ReadonlyArray<SupersessionCandidate>) => ({
        same: candidates.filter(c => c.content === fact.content).map(c => c.id),
        conflicts: candidates.filter(c => c.content !== fact.content).map(c => c.id),
        kinds: allState(...candidates.map(c => c.id)),
      })),
    }
  }

  /** Nearest-neighbour and supersession over the stored rows, so several
   *  runs see each other's writes. */
  function statefulSemantic(storage: ReturnType<typeof makeMockStorage>): void {
    vi.mocked(storage.semantic.findNearest).mockImplementation(async () =>
      storage.semantic._memories.filter(m => m.supersededBy == null).map(item => ({ item, similarity: 0.95 })),
    )
    vi.mocked(storage.semantic.markSuperseded).mockImplementation(async (id, by) => {
      const row = storage.semantic._memories.find(m => m.id === id)
      if (row) row.supersededBy = by
    })
  }

  function liveContents(storage: ReturnType<typeof makeMockStorage>): string[] {
    return storage.semantic._memories.filter(m => m.supersededBy == null).map(m => m.content)
  }

  it('keeps the Wednesday value live over three runs on the same window that still holds the Monday digest', async () => {
    const monEp = makeEpisode({ sessionId: 'mon', createdAt: MONDAY })
    const wedEp = makeEpisode({ sessionId: 'wed', createdAt: WEDNESDAY })
    // getRecent returns newest first, as the stores do.
    const digests = [
      makeDigest({ sessionId: 'wed', summary: 'Wednesday: moved the reranker to gte.', sourceEpisodeIds: [wedEp.id], createdAt: new Date('2026-09-30T23:00:00Z') }),
      makeDigest({ sessionId: 'x', summary: 'Unrelated notes.', createdAt: new Date('2026-09-29T23:00:00Z') }),
      makeDigest({ sessionId: 'mon', summary: 'Monday: the reranker is bge.', sourceEpisodeIds: [monEp.id], createdAt: new Date('2026-09-28T23:00:00Z') }),
    ]
    const storage = makeMockStorage({
      initialDigests: digests,
      episodesPerSession: new Map([['mon', [monEp]], ['wed', [wedEp]]]),
    })
    statefulSemantic(storage)
    const intelligence = extractingIntelligence()

    const first = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })
    expect(liveContents(storage)).toEqual([GTE])
    expect(first).toEqual(expect.objectContaining({ promoted: 2, superseded: 1, stale: 0 }))

    for (let run = 0; run < 2; run++) {
      const again = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })
      expect(liveContents(storage)).toEqual([GTE])
      expect(again).toEqual(expect.objectContaining({ promoted: 0, superseded: 0, stale: 1, deduplicated: 1 }))
    }
    expect(storage.semantic._memories).toHaveLength(2)
  })

  it('takes the statement time from the source episodes, not from when the digest was written', async () => {
    const monEp = makeEpisode({ sessionId: 'mon', createdAt: MONDAY })
    const wedEp = makeEpisode({ sessionId: 'wed', createdAt: WEDNESDAY })
    // Both digests written by one light sleep: their own times cannot order them.
    const writtenAt = new Date('2026-10-01T02:00:00Z')
    const storage = makeMockStorage({
      initialDigests: [
        makeDigest({ sessionId: 'wed', summary: 'Wednesday: moved the reranker to gte.', sourceEpisodeIds: [wedEp.id], createdAt: writtenAt }),
        makeDigest({ sessionId: 'mon', summary: 'Monday: the reranker is bge.', sourceEpisodeIds: [monEp.id], createdAt: writtenAt }),
        makeDigest({ sessionId: 'x', summary: 'Unrelated notes.', createdAt: writtenAt }),
      ],
      episodesPerSession: new Map([['mon', [monEp]], ['wed', [wedEp]]]),
    })
    statefulSemantic(storage)

    const result = await deepSleep(storage, extractingIntelligence(), { minDigests: 3, supersession: LLM })

    expect(liveContents(storage)).toEqual([GTE])
    expect(result).toEqual(expect.objectContaining({ promoted: 1, stale: 1, tie: 0 }))
  })

  it('does not insert a candidate that conflicts with a stored fact stated later', async () => {
    const storage = makeMockStorage({
      initialDigests: plainDigests(),
      semanticNearestResults: [neighbour('newer-1', 'The reranker is bge.', 0.95, { createdAt: new Date('2026-09-25T10:00:00Z') })],
    })
    const intelligence = intelligenceWith('The reranker is gte.', async () => ({ same: [], conflicts: ['newer-1'], kinds: allState('newer-1') }))

    const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

    expect(storage.semantic.insert).not.toHaveBeenCalled()
    expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
    expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ promoted: 0, superseded: 0, stale: 1, tie: 0, supersessionJudged: 1 }))
  })

  it('does nothing when the conflicting facts were stated at the same time', async () => {
    const storage = makeMockStorage({
      initialDigests: plainDigests(),
      semanticNearestResults: [neighbour('same-time', 'The reranker is bge.', 0.95, { createdAt: DIGEST_AT })],
    })
    const intelligence = intelligenceWith('The reranker is gte.', async () => ({ same: [], conflicts: ['same-time'], kinds: allState('same-time') }))

    const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

    expect(storage.semantic.insert).not.toHaveBeenCalled()
    expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
    expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ promoted: 0, superseded: 0, stale: 0, tie: 1 }))
  })

  it('re-reads pool rows so the judge sees their topics and the statement time of their digests', async () => {
    const oldEp = makeEpisode({ sessionId: 'old', createdAt: new Date('2026-08-10T08:00:00Z') })
    const oldDigest = makeDigest({ sessionId: 'old', sourceEpisodeIds: [oldEp.id], createdAt: new Date('2026-08-11T00:00:00Z') })
    const current = plainDigests()
    // A vector-recall row as PostgREST maps it: no topic, no source digests.
    const partial = neighbour('old-1', 'The reranker is bge.', 0.95, { topic: '', sourceDigestIds: [] })
    const stored = { ...partial.item, topic: 'reranker', sourceDigestIds: [oldDigest.id], createdAt: new Date('2026-09-02T00:00:00Z') }
    const storage = makeMockStorage({
      initialDigests: [...current, oldDigest],
      episodesPerSession: new Map([['old', [oldEp]]]),
      initialSemanticMemories: [stored],
      semanticNearestResults: [partial],
    })
    vi.mocked(storage.digests.getRecent).mockResolvedValue(current)
    const intelligence = intelligenceWith('The reranker is gte.')

    await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

    expect(intelligence.judgeSupersession).toHaveBeenCalledWith(
      { topic: 'reranker', content: 'The reranker is gte.', statedAt: DIGEST_AT },
      [{ id: 'old-1', topic: 'reranker', content: 'The reranker is bge.', statedAt: oldEp.createdAt }],
    )
  })

  it('makes no judge call for a pool row retired since the nearest-neighbour read', async () => {
    const partial = neighbour('old-1', 'The reranker is bge.', 0.95)
    const storage = makeMockStorage({
      initialDigests: plainDigests(),
      initialSemanticMemories: [{ ...partial.item, supersededBy: 'someone-else' }],
      semanticNearestResults: [partial],
    })
    const intelligence = intelligenceWith('The reranker is gte.')

    const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })

    expect(intelligence.judgeSupersession).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ promoted: 1, supersessionJudged: 0 }))
  })

  it('applies the settings passed to Memory to consolidate()', async () => {
    const storage = makeMockStorage({
      initialDigests: plainDigests(),
      semanticNearestResults: [neighbour('old-1', 'The reranker is bge.', 0.95)],
    })
    const intelligence = intelligenceWith('The reranker is gte.', async () => ({ same: [], conflicts: ['old-1'], kinds: allState('old-1') }))
    const memory = createMemory({ storage, intelligence, supersession: LLM })
    await memory.initialize()

    const result = await memory.consolidate('deep')

    expect(intelligence.judgeSupersession).toHaveBeenCalledTimes(1)
    expect(result.superseded).toBe(1)
    await memory.dispose()
  })
})

describe('deep sleep supersession retires only current-state facts', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const LATER = new Date('2026-09-25T10:00:00Z')

  async function runWith(
    neighbours: SearchResult<SemanticMemory>[],
    verdict: Partial<SupersessionVerdict>,
  ): Promise<{ storage: ReturnType<typeof makeMockStorage>; result: Awaited<ReturnType<typeof deepSleep>> }> {
    const storage = makeMockStorage({ initialDigests: plainDigests(), semanticNearestResults: neighbours })
    const intelligence = intelligenceWith('The reranker is gte.', async () => verdict as SupersessionVerdict)
    const result = await deepSleep(storage, intelligence, { minDigests: 3, supersession: LLM })
    return { storage, result }
  }

  function expectStoredAsNewOnly(storage: ReturnType<typeof makeMockStorage>): void {
    expect(storage.semantic.insert).toHaveBeenCalledTimes(1)
    expect(storage.semantic.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedes: null }))
    expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
    expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
  }

  it('retires an earlier state that a later state conflicts with, as before', async () => {
    const { storage, result } = await runWith([neighbour('old-1', 'The reranker is bge.', 0.95)], {
      same: [], conflicts: ['old-1'], kinds: { new: 'state', 'old-1': 'state' },
    })
    expect(storage.semantic.markSuperseded).toHaveBeenCalledWith('old-1', storage.semantic._memories[0].id)
    expect(result).toEqual(expect.objectContaining({ promoted: 1, superseded: 1, keptNotState: 0 }))
  })

  it('lets a later event retire an earlier state', async () => {
    const { storage, result } = await runWith([neighbour('old-1', 'The migration is in progress.', 0.9)], {
      same: [], conflicts: ['old-1'], kinds: { new: 'event', 'old-1': 'state' },
    })
    expect(storage.semantic.markSuperseded).toHaveBeenCalledWith('old-1', storage.semantic._memories[0].id)
    expect(result).toEqual(expect.objectContaining({ superseded: 1, keptNotState: 0 }))
  })

  it('never retires an earlier event, and stores the later fact as new even above the duplicate cosine', async () => {
    const { storage, result } = await runWith([neighbour('old-1', 'Stage one of the rollout completed.', 0.95)], {
      same: [], conflicts: ['old-1'], kinds: { new: 'state', 'old-1': 'event' },
    })
    expectStoredAsNewOnly(storage)
    expect(result).toEqual(
      expect.objectContaining({ promoted: 1, superseded: 0, deduplicated: 0, stale: 0, tie: 0, keptNotState: 1 }),
    )
  })

  it('never lets a later plan retire a state', async () => {
    const { storage, result } = await runWith([neighbour('old-1', 'The table migration completed.', 0.9)], {
      same: [], conflicts: ['old-1'], kinds: { new: 'plan', 'old-1': 'state' },
    })
    expectStoredAsNewOnly(storage)
    expect(result).toEqual(expect.objectContaining({ superseded: 0, keptNotState: 1 }))
  })

  it('does not make a candidate stale when the later stored fact is a plan or the candidate an event', async () => {
    const laterPlan = await runWith([neighbour('later-1', 'The reranker will move to bge.', 0.9, { createdAt: LATER })], {
      same: [], conflicts: ['later-1'], kinds: { new: 'state', 'later-1': 'plan' },
    })
    expectStoredAsNewOnly(laterPlan.storage)
    expect(laterPlan.result).toEqual(expect.objectContaining({ stale: 0, keptNotState: 1 }))

    const earlierEvent = await runWith([neighbour('later-1', 'The reranker is bge.', 0.9, { createdAt: LATER })], {
      same: [], conflicts: ['later-1'], kinds: { new: 'event', 'later-1': 'state' },
    })
    expect(earlierEvent.result).toEqual(expect.objectContaining({ promoted: 1, stale: 0, keptNotState: 1 }))
  })

  it('still drops a state candidate that a later stored event ends', async () => {
    const { storage, result } = await runWith([neighbour('later-1', 'The reranker moved to bge.', 0.9, { createdAt: LATER })], {
      same: [], conflicts: ['later-1'], kinds: { new: 'state', 'later-1': 'event' },
    })
    expect(storage.semantic.insert).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ stale: 1, keptNotState: 0 }))
  })

  it('is a tie at the same statement time only when both facts are states', async () => {
    const mixed = await runWith([neighbour('same-time', 'The reranker moved to bge.', 0.9, { createdAt: DIGEST_AT })], {
      same: [], conflicts: ['same-time'], kinds: { new: 'state', 'same-time': 'event' },
    })
    expectStoredAsNewOnly(mixed.storage)
    expect(mixed.result).toEqual(expect.objectContaining({ tie: 0, keptNotState: 1 }))
  })

  it.each([
    ['no kinds at all', undefined],
    ['an empty kinds map', {}],
    ['a missing new-fact kind', { 'old-1': 'state' }],
    ['a missing stored-fact kind', { new: 'state' }],
    ['invalid kind values', { new: 'current', 'old-1': 'STATE' }],
    ['an uppercase kind', { new: 'State', 'old-1': 'state' }],
  ])('counts a conflict with %s as kindMissing, apart from keptNotState, and changes nothing', async (_label, kinds) => {
    const { storage, result } = await runWith([neighbour('old-1', 'The reranker is bge.', 0.95)], {
      same: [], conflicts: ['old-1'], kinds: kinds as SupersessionVerdict['kinds'],
    })
    expectStoredAsNewOnly(storage)
    expect(result).toEqual(expect.objectContaining({ superseded: 0, stale: 0, tie: 0, keptNotState: 0, kindMissing: 1 }))
  })

  it('logs one warning line per run when kinds are missing, and none when every kind is valid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kindLines = () => warn.mock.calls.filter(([line]) => String(line).includes('no valid kind'))

    const { result } = await runWith(
      [neighbour('old-1', 'The reranker is bge.', 0.95), neighbour('old-2', 'The reranker is mxbai.', 0.9)],
      { same: [], conflicts: ['old-1', 'old-2'], kinds: { new: 'state' } },
    )
    expect(result.kindMissing).toBe(2)
    expect(kindLines()).toHaveLength(1)
    expect(String(kindLines()[0]![0])).toContain('2 conflict(s)')

    warn.mockClear()
    await runWith([neighbour('old-1', 'The reranker is bge.', 0.95)], {
      same: [], conflicts: ['old-1'], kinds: { new: 'state', 'old-1': 'event' },
    })
    expect(kindLines()).toHaveLength(0)
  })

  it('still deduplicates an exact-text duplicate the judge wrongly calls a conflict', async () => {
    const { storage, result } = await runWith([neighbour('old-1', 'The reranker is  GTE.', 0.85)], {
      same: [], conflicts: ['old-1'], kinds: allState('old-1'),
    })
    expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledWith('old-1', 0.1)
    expect(storage.semantic.insert).not.toHaveBeenCalled()
    expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ deduplicated: 1, superseded: 0, keptNotState: 0, kindMissing: 0 }))
  })

  it('a kept conflict next to a neighbour the judge calls the same claim gives a duplicate of that one', async () => {
    const { storage, result } = await runWith(
      [neighbour('event-1', 'Stage one of the rollout completed.', 0.95), neighbour('same-1', 'Reranker: gte.', 0.8)],
      { same: ['same-1'], conflicts: ['event-1'], kinds: { new: 'state', 'event-1': 'event', 'same-1': 'state' } },
    )
    expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledWith('same-1', 0.1)
    expect(storage.semantic.insert).not.toHaveBeenCalled()
    expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ deduplicated: 1, keptNotState: 1, kindMissing: 0 }))
  })

  it('counts each kept conflict and retires only the allowed ones', async () => {
    const { storage, result } = await runWith(
      [
        neighbour('state-1', 'The reranker is bge.', 0.9),
        neighbour('event-1', 'The reranker was benchmarked.', 0.8),
        neighbour('plan-1', 'The reranker will be replaced.', 0.7),
        neighbour('unrelated', 'Embeddings use 1536 dimensions.', 0.65),
      ],
      {
        same: [],
        conflicts: ['state-1', 'event-1', 'plan-1'],
        kinds: { new: 'state', 'state-1': 'state', 'event-1': 'event', 'plan-1': 'plan', unrelated: 'state' },
      },
    )
    const newId = storage.semantic._memories[0].id
    expect(vi.mocked(storage.semantic.markSuperseded).mock.calls).toEqual([['state-1', newId]])
    expect(storage.semantic.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedes: 'state-1' }))
    expect(result).toEqual(expect.objectContaining({ promoted: 1, superseded: 1, keptNotState: 2, supersessionJudged: 1 }))
  })

  it('reports keptNotState from consolidate()', async () => {
    const storage = makeMockStorage({
      initialDigests: plainDigests(),
      semanticNearestResults: [neighbour('old-1', 'Stage one of the rollout completed.', 0.95)],
    })
    const intelligence = intelligenceWith('The reranker is gte.', async () => ({
      same: [], conflicts: ['old-1'], kinds: { new: 'state', 'old-1': 'event' },
    }))
    const memory = createMemory({ storage, intelligence, supersession: LLM })
    await memory.initialize()

    const result = await memory.consolidate('deep')

    expect(result.keptNotState).toBe(1)
    expect(result.kindMissing).toBe(0)
    expect(result.superseded).toBe(0)
    await memory.dispose()
  })
})

describe('supersessionRuleOutcome', () => {
  it.each([
    ['state', 'state', 'retire'],
    ['state', 'event', 'retire'],
    ['state', 'plan', 'kept-later-not-current'],
    ['state', undefined, 'kept-kind-missing'],
    ['state', 'State', 'kept-kind-missing'],
    ['event', 'state', 'kept-earlier-not-state'],
    ['plan', 'state', 'kept-earlier-not-state'],
    [undefined, 'state', 'kept-kind-missing'],
    ['current', 'event', 'kept-kind-missing'],
    ['event', 'Plan', 'kept-kind-missing'],
    ['__proto__', 'state', 'kept-kind-missing'],
  ])('earlier %s, later %s: %s', (earlier, later, outcome) => {
    expect(supersessionRuleOutcome(earlier, later)).toBe(outcome)
  })
})
