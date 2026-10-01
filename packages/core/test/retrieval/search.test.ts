import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { unifiedSearch, isRecallFailureNoise } from '../../src/retrieval/search.js'
import {
  createMockStorage,
  DIGEST_SEARCH_RESULTS,
  EPISODE_SEARCH_RESULTS,
  SEMANTIC_SEARCH_RESULTS,
} from './mock-storage.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import type { Episode, MemoryType, RecallStrategy, SearchResult, TypedMemory } from '../../src/types.js'
import { DEFAULT_FUSION_CONFIG, type FusionConfig } from '../../src/retrieval/fusion-config.js'

const LIGHT_STRATEGY: RecallStrategy = {
  mode: 'light',
  maxResults: 8,
  associations: false,
  associationHops: 0,
  expand: false,
  recencyBias: 0.4,
}

const DEEP_STRATEGY: RecallStrategy = {
  mode: 'deep',
  maxResults: 15,
  associations: true,
  associationHops: 2,
  expand: true,
  recencyBias: 0.2,
}

const SKIP_STRATEGY: RecallStrategy = {
  mode: 'skip',
  maxResults: 0,
  associations: false,
  associationHops: 0,
  expand: false,
  recencyBias: 0,
}

describe('unifiedSearch', () => {
  it('skip mode returns empty array', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'hi',
      embedding: [0.1, 0.2],
      strategy: SKIP_STRATEGY,
      storage,
      sensory,
    })
    expect(result).toHaveLength(0)
    expect(storage.vectorSearch).not.toHaveBeenCalled()
  })

  it('light mode calls vectorSearch with embedding', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const embedding = [0.1, 0.2, 0.3]
    await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding,
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    // vectorLimit = strategy.maxResults * 4 (LIGHT_STRATEGY.maxResults = 8 → 32)
    expect(storage.vectorSearch).toHaveBeenCalledWith(embedding, {
      limit: 32,
      sessionId: undefined,
    })
  })

  it('calls textBoost with query terms', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    expect(storage.textBoost).toHaveBeenCalled()
    const callArgs = (storage.textBoost as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toContain('typescript')
  })

  it('results are sorted by finalScore descending', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].relevance).toBeGreaterThanOrEqual(result[i].relevance)
    }
  })

  it('BM25 boost adds score to matching results', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    // sem-1 has both vector (0.82) and BM25 boost (0.9) — should have score > 0.82
    const sem1 = result.find(r => r.id === 'sem-1')
    expect(sem1).toBeDefined()
    expect(sem1!.relevance).toBeGreaterThan(0.82)
  })

  it('caps results at strategy.maxResults', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: { ...LIGHT_STRATEGY, maxResults: 2 },
      storage,
      sensory,
    })
    expect(result.length).toBeLessThanOrEqual(2)
  })

  it('includes expanded terms in textBoost when provided', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    await unifiedSearch({
      query: 'blocking bots',
      embedding: [0.1, 0.2],
      strategy: DEEP_STRATEGY,
      storage,
      sensory,
      expandedTerms: ['scraper', 'cloudflare', 'behavioral fingerprinting'],
    })
    const callArgs = (storage.textBoost as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toContain('scraper')
    expect(callArgs[0]).toContain('cloudflare')
  })

  it('all results have source=recall and valid type', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const result = await unifiedSearch({
      query: 'TypeScript strict mode',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory,
    })
    for (const r of result) {
      expect(r.source).toBe('recall')
      expect(['episode', 'digest', 'semantic', 'procedural']).toContain(r.type)
    }
  })
})

describe('isRecallFailureNoise', () => {
  it('flags pure assistant failure messages (penalized)', () => {
    expect(isRecallFailureNoise('assistant', "I can't find anything about that.")).toBe(true)
    expect(isRecallFailureNoise('assistant', 'No record of that decision in my notes.')).toBe(true)
    expect(isRecallFailureNoise('assistant', 'Nothing stored about that topic.')).toBe(true)
    expect(isRecallFailureNoise('assistant', "Genuinely can't recall.")).toBe(true)
    expect(isRecallFailureNoise('assistant', 'Searched everything, nothing relevant.')).toBe(true)
    expect(isRecallFailureNoise('assistant', "I don't have any details on that.")).toBe(true)
  })

  it('does NOT flag hedged-confident answers with continuation', () => {
    expect(
      isRecallFailureNoise('assistant', "I can't find the exact date, but it was around March."),
    ).toBe(false)
    expect(
      isRecallFailureNoise(
        'assistant',
        "I don't have full details on that, though the project shipped in Q3.",
      ),
    ).toBe(false)
    expect(
      isRecallFailureNoise(
        'assistant',
        'No mention of that in the logs, however the build did fail at noon.',
      ),
    ).toBe(false)
    expect(
      isRecallFailureNoise(
        'assistant',
        'No record of the meeting, although the calendar shows a 3pm slot was booked.',
      ),
    ).toBe(false)
  })

  it('only applies to assistant role (user/system messages pass through)', () => {
    expect(isRecallFailureNoise('user', "I can't find the docs anywhere.")).toBe(false)
    expect(isRecallFailureNoise('system', 'No record of that event.')).toBe(false)
    expect(isRecallFailureNoise(undefined, 'no record of that.')).toBe(false)
  })

  it('does NOT flag messages without any failure phrase', () => {
    expect(isRecallFailureNoise('assistant', 'The deployment happened on Tuesday.')).toBe(false)
    expect(isRecallFailureNoise('assistant', 'We decided to use Postgres for the cutover.')).toBe(
      false,
    )
    expect(isRecallFailureNoise('assistant', '')).toBe(false)
  })

  it('does not rescue when hedge marker is far past the failure phrase', () => {
    // Hedge appears > 80 chars after the failure phrase — too distant to count
    // as a same-clause qualifier. Treat as pure failure.
    const longTail =
      "I can't find that record. " +
      'The system was running normally and the deployment proceeded as planned without errors or warnings whatsoever. ' +
      'But the audit flagged one entry.'
    expect(isRecallFailureNoise('assistant', longTail)).toBe(true)
  })

  it('rescues when hedge marker appears within the 80-char window', () => {
    // Hedge appears immediately after the failure phrase.
    expect(isRecallFailureNoise('assistant', "I can't find that, but it shipped on May 12.")).toBe(
      false,
    )
  })
})

describe('unifiedSearch — failed lexical leg', () => {
  function failingTextBoost(message: string) {
    const storage = createMockStorage()
    storage.textBoost = vi.fn().mockRejectedValue(new Error(message))
    return storage
  }

  it('returns the vector hits, logs the error and reports it', async () => {
    const storage = failingTextBoost('Could not find the function public.engram_text_match')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLexicalError = vi.fn()
    try {
      const result = await unifiedSearch({
        query: 'TypeScript strict mode',
        embedding: [0.1, 0.2, 0.3],
        strategy: LIGHT_STRATEGY,
        storage,
        sensory: new SensoryBuffer(),
        onLexicalError,
      })

      expect(result.length).toBeGreaterThan(0)
      expect(storage.vectorSearch).toHaveBeenCalled()
      expect(onLexicalError).toHaveBeenCalledTimes(1)
      expect(errSpy).toHaveBeenCalledWith(
        '[engram] lexical leg failed: Could not find the function public.engram_text_match',
      )
    } finally {
      errSpy.mockRestore()
    }
  })

  it('logs each distinct message once per process but reports every failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLexicalError = vi.fn()
    const run = (message: string) =>
      unifiedSearch({
        query: 'TypeScript strict mode',
        embedding: [0.1, 0.2, 0.3],
        strategy: LIGHT_STRATEGY,
        storage: failingTextBoost(message),
        sensory: new SensoryBuffer(),
        onLexicalError,
      })
    try {
      await run('relation "episodes" does not exist')
      await run('relation "episodes" does not exist')
      await run('connection reset by peer')

      const lines = errSpy.mock.calls.map((c) => c[0])
      expect(lines).toEqual([
        '[engram] lexical leg failed: relation "episodes" does not exist',
        '[engram] lexical leg failed: connection reset by peer',
      ])
      expect(onLexicalError).toHaveBeenCalledTimes(3)
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('unifiedSearch — lexical-only candidates', () => {
  const NOW = new Date('2026-06-01T12:00:00Z')
  const CREATED_AT = new Date(NOW.getTime() - 24 * 3_600_000)
  const QUERY_VEC = [1, 0, 0, 0]

  function ep(id: string, content: string, embedding: number[] | null): Episode {
    return {
      id,
      sessionId: `sess-${id}`,
      role: 'user',
      content,
      salience: 0.5,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding,
      entities: [],
      metadata: {},
      createdAt: CREATED_AT,
      projectId: null,
    }
  }

  /** The scoring formula for a user-role row with no access count, no
   *  priming and no failure-noise penalty. */
  function expectedScore(cosine: number, boost: number, recencyBias: number): number {
    const ageHours = (NOW.getTime() - CREATED_AT.getTime()) / 3_600_000
    return cosine + boost * 0.15 + recencyBias * Math.exp(-ageHours / 720)
  }

  const vectorHit = ep('vec-1', 'deploy pipeline for the billing worker', [0.6, 0.8, 0, 0])
  const rescueA = ep('lex-a', 'ACA-2613 renewal export columns', [0.4, 0, Math.sqrt(1 - 0.16), 0])
  const rescueB = ep('lex-b', 'ACA-2613 portfolio drilldown', [0.3, 0.3, 0.3, Math.sqrt(1 - 0.27)])
  const noEmbedding = ep('lex-null', 'ACA-2613 legacy import without vectors', null)
  const otherDims = ep('lex-dims', 'ACA-2613 row from an older embedding model', [1, 0])

  function buildStorage() {
    const vectorSearchResults: SearchResult<TypedMemory>[] = [
      { item: { type: 'episode', data: vectorHit }, similarity: 0.6 },
    ]
    const textBoostResults: Array<{ id: string; type: MemoryType; boost: number }> = [
      { id: 'vec-1', type: 'episode', boost: 0.2 },
      { id: 'lex-a', type: 'episode', boost: 1.0 },
      { id: 'lex-missing', type: 'episode', boost: 0.9 },
      { id: 'lex-b', type: 'episode', boost: 0.7 },
      { id: 'lex-null', type: 'episode', boost: 0.5 },
      { id: 'lex-dims', type: 'episode', boost: 0.4 },
    ]
    const storage = createMockStorage({ vectorSearchResults, textBoostResults })
    const byId = new Map<string, TypedMemory>(
      [vectorHit, rescueA, rescueB, noEmbedding, otherDims].map((e) => [e.id, { type: 'episode', data: e }]),
    )
    storage.getByIds = vi.fn(async (refs: Array<{ id: string; type: MemoryType }>) =>
      refs.flatMap((r) => {
        const m = byId.get(r.id)
        return m ? [m] : []
      }),
    )
    return storage
  }

  async function run(storage = buildStorage()) {
    const result = await unifiedSearch({
      query: 'ACA-2613',
      embedding: QUERY_VEC,
      strategy: LIGHT_STRATEGY,
      storage,
      sensory: new SensoryBuffer(),
    })
    return { storage, result }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches every lexical-only hit in one getByIds call and never per row', async () => {
    const { storage, result } = await run()
    expect(storage.getByIds).toHaveBeenCalledTimes(1)
    expect(storage.getByIds).toHaveBeenCalledWith([
      { id: 'lex-a', type: 'episode' },
      { id: 'lex-missing', type: 'episode' },
      { id: 'lex-b', type: 'episode' },
      { id: 'lex-null', type: 'episode' },
      { id: 'lex-dims', type: 'episode' },
    ])
    expect(storage.getById).not.toHaveBeenCalled()
    expect(result.map((r) => r.id)).not.toContain('lex-missing')
  })

  it('scores a lexical-only row on its true cosine to the query', async () => {
    const { result } = await run()
    const a = result.find((r) => r.id === 'lex-a')
    const b = result.find((r) => r.id === 'lex-b')
    expect(a?.relevance).toBeCloseTo(expectedScore(0.4, 1.0, LIGHT_STRATEGY.recencyBias), 10)
    expect(b?.relevance).toBeCloseTo(expectedScore(0.3, 0.7, LIGHT_STRATEGY.recencyBias), 10)
  })

  it('scores a row without a usable embedding with no vector term', async () => {
    const { result } = await run()
    const noVec = result.find((r) => r.id === 'lex-null')
    const dims = result.find((r) => r.id === 'lex-dims')
    expect(noVec?.relevance).toBeCloseTo(expectedScore(0, 0.5, LIGHT_STRATEGY.recencyBias), 10)
    expect(dims?.relevance).toBeCloseTo(expectedScore(0, 0.4, LIGHT_STRATEGY.recencyBias), 10)
  })

  it('skips the fetch when every lexical hit is already a vector hit', async () => {
    const storage = createMockStorage({
      vectorSearchResults: [{ item: { type: 'episode', data: vectorHit }, similarity: 0.6 }],
      textBoostResults: [{ id: 'vec-1', type: 'episode', boost: 0.2 }],
    })
    await run(storage)
    expect(storage.getByIds).not.toHaveBeenCalled()
  })
})

describe('unifiedSearch — rank priors', () => {
  const NOW = new Date('2026-06-01T12:00:00Z')
  const CREATED_AT = new Date(NOW.getTime() - 24 * 3_600_000)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function ep(id: string, content: string, accessCount: number): Episode {
    return {
      id,
      sessionId: `sess-${id}`,
      role: 'user',
      content,
      salience: 0.5,
      accessCount,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null,
      entities: [],
      metadata: {},
      createdAt: CREATED_AT,
      projectId: null,
    }
  }

  const hub = ep('hub', 'general notes about the deploy setup', 551)
  const specific = ep('specific', 'the billing worker deploy uses a blue-green switch', 0)

  function storageWith(quantile: number, vector: SearchResult<TypedMemory>[] = [
    { item: { type: 'episode', data: hub }, similarity: 0.8 },
    { item: { type: 'episode', data: specific }, similarity: 0.75 },
  ]) {
    return {
      ...createMockStorage({ vectorSearchResults: vector, textBoostResults: [] }),
      accessCountQuantile: vi.fn().mockResolvedValue(quantile),
    }
  }

  function search(storage: ReturnType<typeof storageWith>, rankPriors?: { hubDamping: boolean; semanticConfidence: boolean }) {
    return unifiedSearch({
      query: 'billing worker deploy',
      embedding: [0.1, 0.2],
      strategy: LIGHT_STRATEGY,
      storage,
      sensory: new SensoryBuffer(),
      ...(rankPriors ? { rankPriors } : {}),
    })
  }

  it('drops a 551-access hub below a specific match once hub damping is on', async () => {
    const off = await search(storageWith(163))
    expect(off.map((m) => m.id)).toEqual(['hub', 'specific'])

    const on = await search(storageWith(163), { hubDamping: true, semanticConfidence: false })

    expect(on.map((m) => m.id)).toEqual(['specific', 'hub'])
    const hubOn = on.find((m) => m.id === 'hub')!
    const hubOff = off.find((m) => m.id === 'hub')!
    expect(hubOn.rankPrior).toBeCloseTo(1 / (1 + Math.log(551 / 163)), 10)
    expect(hubOn.relevance).toBeCloseTo(hubOff.relevance * hubOn.rankPrior!, 12)
    expect(on.find((m) => m.id === 'specific')).not.toHaveProperty('rankPrior')
  })

  it('damps a hub found only through the lexical leg', async () => {
    const storage = {
      ...createMockStorage({
        vectorSearchResults: [{ item: { type: 'episode', data: specific }, similarity: 0.75 }],
        textBoostResults: [{ id: 'hub', type: 'episode', boost: 0.5 }],
      }),
      accessCountQuantile: vi.fn().mockResolvedValue(163),
    }
    vi.mocked(storage.getByIds).mockResolvedValue([{ type: 'episode', data: hub }])

    const result = await search(storage, { hubDamping: true, semanticConfidence: false })

    expect(result.find((m) => m.id === 'hub')?.rankPrior).toBeCloseTo(1 / (1 + Math.log(551 / 163)), 10)
  })

  it('leaves a digest unaffected', async () => {
    const digest: TypedMemory = {
      type: 'digest',
      data: {
        id: 'dig', sessionId: 's', summary: 'billing deploy digest', keyTopics: [], sourceEpisodeIds: [],
        sourceDigestIds: [], level: 1, embedding: null, metadata: {}, createdAt: CREATED_AT, projectId: null,
      },
    }
    const storage = storageWith(163, [{ item: digest, similarity: 0.8 }, { item: { type: 'episode', data: specific }, similarity: 0.7 }])
    const off = await search(storage)

    const on = await search(storage, { hubDamping: true, semanticConfidence: true })

    expect(on.find((m) => m.id === 'dig')).toEqual(off.find((m) => m.id === 'dig'))
  })

  it('scales a low-confidence semantic row by 0.5 + 0.5 * confidence', async () => {
    const fact: TypedMemory = {
      type: 'semantic',
      data: {
        id: 'fact', topic: 'deploy', content: 'billing deploys are blue-green', confidence: 0.05,
        sourceDigestIds: [], sourceEpisodeIds: [], accessCount: 0, lastAccessed: null, decayRate: 0.02,
        supersedes: null, supersededBy: null, embedding: null, metadata: {}, createdAt: CREATED_AT,
        updatedAt: CREATED_AT, projectId: null,
      },
    }
    const storage = storageWith(11, [{ item: fact, similarity: 0.8 }])
    const off = await search(storage)

    const on = await search(storage, { hubDamping: false, semanticConfidence: true })

    expect(on[0]!.rankPrior).toBeCloseTo(0.525, 12)
    expect(on[0]!.relevance).toBeCloseTo(off[0]!.relevance * 0.525, 12)
    expect(storage.accessCountQuantile).not.toHaveBeenCalled()
  })

  it('returns identical order and relevance on the shared fixtures with both switches off', async () => {
    const plain = createMockStorage()
    const withMethod = { ...createMockStorage(), accessCountQuantile: vi.fn().mockResolvedValue(1) }

    const baseline = await unifiedSearch({
      query: 'TypeScript strict mode', embedding: [0.1, 0.2], strategy: DEEP_STRATEGY, storage: plain, sensory: new SensoryBuffer(),
    })
    const off = await unifiedSearch({
      query: 'TypeScript strict mode', embedding: [0.1, 0.2], strategy: DEEP_STRATEGY, storage: withMethod, sensory: new SensoryBuffer(),
      rankPriors: { hubDamping: false, semanticConfidence: false },
    })

    expect(baseline.length).toBeGreaterThan(1)
    expect(off).toEqual(baseline)
    expect(withMethod.accessCountQuantile).not.toHaveBeenCalled()
  })
})

describe('unifiedSearch — no query vector', () => {
  const NOW = new Date('2026-06-01T12:00:00Z')
  const CREATED_AT = new Date(NOW.getTime() - 24 * 3_600_000)

  function ep(id: string, content: string, embedding: number[] | null): Episode {
    return {
      id,
      sessionId: `sess-${id}`,
      role: 'user',
      content,
      salience: 0.5,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding,
      entities: [],
      metadata: {},
      createdAt: CREATED_AT,
      projectId: null,
    }
  }

  /** User-role row, no access count, no priming, no failure-noise penalty. */
  function expectedScore(base: number, recencyBias: number): number {
    const ageHours = (NOW.getTime() - CREATED_AT.getTime()) / 3_600_000
    return base + recencyBias * Math.exp(-ageHours / 720)
  }

  const target = ep('lex-target', 'renewal export for the billing worker lost its tax column', [0, 1, 0, 0])
  const weaker = ep('lex-weak', 'billing worker restarted after the deploy', null)

  function buildStorage() {
    // Raw ranks on the adapter's own scale: the search normalises them.
    const textBoostResults: Array<{ id: string; type: MemoryType; boost: number }> = [
      { id: 'lex-target', type: 'episode', boost: 4.0 },
      { id: 'lex-forgotten', type: 'episode', boost: 3.0 },
      { id: 'lex-weak', type: 'episode', boost: 1.0 },
    ]
    const storage = createMockStorage({ textBoostResults })
    // getByIds skips tombstoned rows, so the forgotten hit never hydrates.
    const byId = new Map<string, TypedMemory>(
      [target, weaker].map((e) => [e.id, { type: 'episode', data: e }]),
    )
    storage.getByIds = vi.fn(async (refs: Array<{ id: string; type: MemoryType }>) =>
      refs.flatMap((r) => {
        const m = byId.get(r.id)
        return m ? [m] : []
      }),
    )
    return storage
  }

  async function run(embedding: number[], extra: { vectorUnavailable?: boolean; projectId?: string } = {}) {
    const storage = buildStorage()
    const result = await unifiedSearch({
      query: 'billing worker tax column',
      embedding,
      strategy: LIGHT_STRATEGY,
      storage,
      sensory: new SensoryBuffer(),
      sessionId: 'sess-scope',
      ...extra,
    })
    return { storage, result }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes candidates from the lexical leg and never calls the per-tier text search', async () => {
    const { storage, result } = await run([])

    expect(result.map((r) => r.id)).toEqual(['lex-target', 'lex-weak'])
    expect(storage.vectorSearch).not.toHaveBeenCalled()
    expect(storage.episodes.search).not.toHaveBeenCalled()
    expect(storage.digests.search).not.toHaveBeenCalled()
    expect(storage.semantic.search).not.toHaveBeenCalled()
  })

  it('makes the same textBoost call the vector path makes', async () => {
    const { storage } = await run([], { projectId: 'engram' })

    expect(storage.textBoost).toHaveBeenCalledTimes(1)
    expect(storage.textBoost).toHaveBeenCalledWith(['billing', 'worker', 'tax', 'column'], {
      limit: LIGHT_STRATEGY.maxResults * 5,
      sessionId: 'sess-scope',
      projectId: 'engram',
    })
  })

  it('hydrates every lexical hit in one tombstone-aware getByIds call', async () => {
    const { storage, result } = await run([])

    expect(storage.getByIds).toHaveBeenCalledTimes(1)
    expect(storage.getByIds).toHaveBeenCalledWith([
      { id: 'lex-target', type: 'episode' },
      { id: 'lex-forgotten', type: 'episode' },
      { id: 'lex-weak', type: 'episode' },
    ])
    expect(storage.getById).not.toHaveBeenCalled()
    expect(result.map((r) => r.id)).not.toContain('lex-forgotten')
  })

  it('scores each hit on its rank divided by the strongest rank, with no cosine', async () => {
    const { result } = await run([])
    const byId = new Map(result.map((r) => [r.id, r.relevance]))

    // lex-target carries an embedding; without a query vector it earns no cosine.
    expect(byId.get('lex-target')).toBeCloseTo(expectedScore(4.0 / 4.0, LIGHT_STRATEGY.recencyBias), 10)
    expect(byId.get('lex-weak')).toBeCloseTo(expectedScore(1.0 / 4.0, LIGHT_STRATEGY.recencyBias), 10)
  })

  it('treats the vector-unavailable flag like an empty embedding', async () => {
    const { storage, result } = await run([0, 1, 0, 0], { vectorUnavailable: true })

    expect(storage.vectorSearch).not.toHaveBeenCalled()
    expect(storage.episodes.search).not.toHaveBeenCalled()
    expect(result.map((r) => r.id)).toEqual(['lex-target', 'lex-weak'])
    expect(result[0]?.relevance).toBeCloseTo(expectedScore(1, LIGHT_STRATEGY.recencyBias), 10)
  })

  describe('when the lexical leg yields no candidates', () => {
    const TEXT_SEARCH_IDS = [...EPISODE_SEARCH_RESULTS, ...DIGEST_SEARCH_RESULTS, ...SEMANTIC_SEARCH_RESULTS]
      .map((hit) => hit.item.id)
      .sort()

    function runTextFallback(storage: ReturnType<typeof createMockStorage>, onLexicalError?: (err: unknown) => void) {
      return unifiedSearch({
        query: 'typescript strict mode',
        embedding: [0, 1, 0, 0],
        strategy: LIGHT_STRATEGY,
        storage,
        sensory: new SensoryBuffer(),
        projectId: 'engram',
        vectorUnavailable: true,
        ...(onLexicalError ? { onLexicalError } : {}),
      })
    }

    it('falls back to the per-tier text search when textBoost matches nothing', async () => {
      const storage = createMockStorage({ textBoostResults: [] })

      const result = await runTextFallback(storage)

      expect(storage.vectorSearch).not.toHaveBeenCalled()
      expect(storage.textBoost).toHaveBeenCalledTimes(1)
      const searchOpts = { limit: LIGHT_STRATEGY.maxResults * 2, projectId: 'engram' }
      expect(storage.episodes.search).toHaveBeenCalledWith('typescript strict mode', searchOpts)
      expect(storage.digests.search).toHaveBeenCalledWith('typescript strict mode', searchOpts)
      expect(storage.semantic.search).toHaveBeenCalledWith('typescript strict mode', searchOpts)
      expect(result.map((r) => r.id).sort()).toEqual(TEXT_SEARCH_IDS)
    })

    it('falls back to the per-tier text search when textBoost throws', async () => {
      const storage = createMockStorage()
      storage.textBoost = vi.fn().mockRejectedValue(new Error('canceling statement due to statement timeout'))
      const onLexicalError = vi.fn()
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const result = await runTextFallback(storage, onLexicalError)

        expect(onLexicalError).toHaveBeenCalledTimes(1)
        expect(storage.episodes.search).toHaveBeenCalledTimes(1)
        expect(storage.digests.search).toHaveBeenCalledTimes(1)
        expect(storage.semantic.search).toHaveBeenCalledTimes(1)
        expect(result.map((r) => r.id).sort()).toEqual(TEXT_SEARCH_IDS)
      } finally {
        errSpy.mockRestore()
      }
    })

    it('still scores lexical candidates the lexical way when textBoost returns rows', async () => {
      const { storage, result } = await run([], { projectId: 'engram' })

      expect(result.map((r) => r.id)).toEqual(['lex-target', 'lex-weak'])
      expect(storage.episodes.search).not.toHaveBeenCalled()
      expect(storage.digests.search).not.toHaveBeenCalled()
      expect(storage.semantic.search).not.toHaveBeenCalled()
    })
  })

  it('keeps the per-tier text search for storage without textBoost', async () => {
    const storage = createMockStorage()
    const withoutTextBoost = { ...storage, textBoost: undefined } as unknown as typeof storage

    const result = await unifiedSearch({
      query: 'typescript strict mode',
      embedding: [],
      strategy: LIGHT_STRATEGY,
      storage: withoutTextBoost,
      sensory: new SensoryBuffer(),
    })

    expect(storage.episodes.search).toHaveBeenCalledTimes(1)
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('unifiedSearch — fusion config', () => {
  const NOW = new Date('2026-06-01T12:00:00Z')
  const ENV = 'ENGRAM_RECALL_FUSION'
  const originalEnv = process.env[ENV]

  beforeEach(() => {
    delete process.env[ENV]
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalEnv === undefined) delete process.env[ENV]
    else process.env[ENV] = originalEnv
  })

  interface Row {
    episode: Episode
    similarity: number
    boost: number
  }

  function row(
    id: string,
    opts: { role: 'user' | 'assistant'; content: string; similarity: number; boost: number; accessCount: number; ageHours: number },
  ): Row {
    return {
      similarity: opts.similarity,
      boost: opts.boost,
      episode: {
        id,
        sessionId: `sess-${id}`,
        role: opts.role,
        content: opts.content,
        salience: 0.5,
        accessCount: opts.accessCount,
        lastAccessed: null,
        consolidatedAt: null,
        embedding: null,
        entities: [],
        metadata: {},
        createdAt: new Date(NOW.getTime() - opts.ageHours * 3_600_000),
        projectId: null,
      },
    }
  }

  // Each row exercises a different subset of the scoring terms, so every key
  // changes at least one row and leaves the rows without its term unchanged.
  const ROWS: Row[] = [
    row('lexical', { role: 'user', content: 'billing worker deploy runbook', similarity: 0.6, boost: 0.8, accessCount: 3, ageHours: 48 }),
    row('assistant', { role: 'assistant', content: 'the billing worker deploys blue-green', similarity: 0.55, boost: 0, accessCount: 25, ageHours: 400 }),
    row('noise', { role: 'assistant', content: "I can't find the billing worker notes.", similarity: 0.7, boost: 0.3, accessCount: 0, ageHours: 2000 }),
    row('plain', { role: 'user', content: 'unrelated note about lunch', similarity: 0.5, boost: 0, accessCount: 0, ageHours: 10 }),
  ]

  /** The scoring formula, restated independently of the implementation. */
  function expected(r: Row, cfg: FusionConfig, recencyBias: number): number {
    const ageHours = (NOW.getTime() - r.episode.createdAt.getTime()) / 3_600_000
    const sum = r.similarity
      + r.boost * cfg.lexicalWeight
      + recencyBias * Math.exp(-ageHours / cfg.recencyDecayHours)
      + Math.min(cfg.accessBoostCap, r.episode.accessCount * cfg.accessBoostPerAccess)
      + (r.episode.role === 'assistant' ? cfg.assistantRoleBoost : 0)
    return isRecallFailureNoise(r.episode.role, r.episode.content) ? sum * cfg.recallFailurePenalty : sum
  }

  function fixtureStorage() {
    return createMockStorage({
      vectorSearchResults: ROWS.map((r) => ({ item: { type: 'episode' as const, data: r.episode }, similarity: r.similarity })),
      textBoostResults: ROWS.filter((r) => r.boost > 0).map((r) => ({ id: r.episode.id, type: 'episode' as const, boost: r.boost })),
    })
  }

  async function search(fusion?: Partial<FusionConfig>, storage = fixtureStorage()) {
    const strategy: RecallStrategy = fusion === undefined ? LIGHT_STRATEGY : { ...LIGHT_STRATEGY, fusion }
    const result = await unifiedSearch({ query: 'billing worker deploy', embedding: [0.1, 0.2], strategy, storage, sensory: new SensoryBuffer() })
    return new Map(result.map((m) => [m.id, m.relevance]))
  }

  const SCORING_OVERRIDES: Array<[keyof FusionConfig, number]> = [
    ['lexicalWeight', 0.4],
    ['recencyDecayHours', 24],
    ['accessBoostPerAccess', 0.002],
    ['accessBoostCap', 0.3],
    ['assistantRoleBoost', 0.2],
    ['recallFailurePenalty', 0.9],
  ]

  it('scores every fixture row with the default formula when no override is set', async () => {
    const scores = await search()
    for (const r of ROWS) {
      expect(scores.get(r.episode.id)).toBeCloseTo(expected(r, DEFAULT_FUSION_CONFIG, LIGHT_STRATEGY.recencyBias), 12)
    }
  })

  for (const [key, value] of SCORING_OVERRIDES) {
    it(`${key} moves its own term and leaves the other terms at their defaults`, async () => {
      const base = await search()
      const moved = await search({ [key]: value })
      const cfg = { ...DEFAULT_FUSION_CONFIG, [key]: value }
      let changedRows = 0
      for (const r of ROWS) {
        const id = r.episode.id
        expect(moved.get(id)).toBeCloseTo(expected(r, cfg, LIGHT_STRATEGY.recencyBias), 12)
        const unchanged = expected(r, cfg, LIGHT_STRATEGY.recencyBias) === expected(r, DEFAULT_FUSION_CONFIG, LIGHT_STRATEGY.recencyBias)
        if (unchanged) expect(moved.get(id)).toBe(base.get(id))
        else changedRows++
      }
      expect(changedRows).toBeGreaterThan(0)
    })
  }

  it('lexicalCandidateFactor sets only the textBoost limit', async () => {
    const storage = fixtureStorage()
    await search({ lexicalCandidateFactor: 12 }, storage)
    expect((storage.textBoost as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({ limit: 96, sessionId: undefined })
    expect(storage.vectorSearch).toHaveBeenCalledWith([0.1, 0.2], { limit: 32, sessionId: undefined })
  })

  it('vectorCandidateFactor sets only the vectorSearch limit', async () => {
    const storage = fixtureStorage()
    await search({ vectorCandidateFactor: 7 }, storage)
    expect(storage.vectorSearch).toHaveBeenCalledWith([0.1, 0.2], { limit: 56, sessionId: undefined })
    expect((storage.textBoost as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({ limit: 40, sessionId: undefined })
  })

  it('uses ENGRAM_RECALL_FUSION when the call sets no fusion, and the call key over the env key', async () => {
    process.env[ENV] = JSON.stringify({ lexicalWeight: 0.4, assistantRoleBoost: 0.2 })
    const fromEnv = await search()
    const lexical = ROWS[0]!
    const assistant = ROWS[1]!
    const envCfg = { ...DEFAULT_FUSION_CONFIG, lexicalWeight: 0.4, assistantRoleBoost: 0.2 }
    expect(fromEnv.get('lexical')).toBeCloseTo(expected(lexical, envCfg, LIGHT_STRATEGY.recencyBias), 12)

    const mixed = await search({ lexicalWeight: 0 })
    const mixedCfg = { ...envCfg, lexicalWeight: 0 }
    expect(mixed.get('lexical')).toBeCloseTo(expected(lexical, mixedCfg, LIGHT_STRATEGY.recencyBias), 12)
    expect(mixed.get('assistant')).toBeCloseTo(expected(assistant, mixedCfg, LIGHT_STRATEGY.recencyBias), 12)
  })

  it('prefers an explicitly resolved config over strategy.fusion and the env', async () => {
    process.env[ENV] = JSON.stringify({ lexicalWeight: 0.4 })
    const result = await unifiedSearch({
      query: 'billing worker deploy',
      embedding: [0.1, 0.2],
      strategy: { ...LIGHT_STRATEGY, fusion: { lexicalWeight: 0.9 } },
      storage: fixtureStorage(),
      sensory: new SensoryBuffer(),
      fusion: DEFAULT_FUSION_CONFIG,
    })
    const lexical = result.find((m) => m.id === 'lexical')!
    expect(lexical.relevance).toBeCloseTo(expected(ROWS[0]!, DEFAULT_FUSION_CONFIG, LIGHT_STRATEGY.recencyBias), 12)
  })

  it('throws a key-naming error for an invalid per-call or env value before searching', async () => {
    const storage = fixtureStorage()
    await expect(search({ lexicalWeight: 1.5 }, storage)).rejects.toThrow(/lexicalWeight/)
    process.env[ENV] = '{"recencyDecayHours":0}'
    await expect(search(undefined, storage)).rejects.toThrow(/recencyDecayHours/)
    expect(storage.vectorSearch).not.toHaveBeenCalled()
  })

  it('returns byte-identical results on the shared fixtures with defaults however they are given', async () => {
    for (const strategy of [LIGHT_STRATEGY, DEEP_STRATEGY]) {
      const run = (s: RecallStrategy) => unifiedSearch({
        query: 'TypeScript strict mode', embedding: [0.1, 0.2], strategy: s, storage: createMockStorage(),
        sensory: new SensoryBuffer(), expandedTerms: ['tsconfig'],
      })
      delete process.env[ENV]
      const baseline = JSON.stringify(await run(strategy))
      expect(JSON.parse(baseline).length).toBeGreaterThan(1)

      expect(JSON.stringify(await run({ ...strategy, fusion: {} }))).toBe(baseline)
      expect(JSON.stringify(await run({ ...strategy, fusion: { ...DEFAULT_FUSION_CONFIG } }))).toBe(baseline)
      process.env[ENV] = '{}'
      expect(JSON.stringify(await run(strategy))).toBe(baseline)
      process.env[ENV] = JSON.stringify(DEFAULT_FUSION_CONFIG)
      expect(JSON.stringify(await run(strategy))).toBe(baseline)
    }
  })
})
