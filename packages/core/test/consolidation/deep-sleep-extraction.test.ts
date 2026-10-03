import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { deepSleep, DEFAULT_MAX_DIGESTS } from '../../src/consolidation/deep-sleep.js'
import { extractDigestFacts } from '../../src/consolidation/fact-candidates.js'
import { FactExtractionError } from '../../src/adapters/intelligence.js'
import type { ExtractFactsInput, ExtractedFact, IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type { Episode } from '../../src/types.js'
import { CircuitOpenError } from '../../src/resilience/circuit-breaker.js'
import { makeDigest, makeEpisode, makeMockStorage, resetIdCounter } from './mock-storage.js'

const at = (iso: string) => new Date(iso)

type ExtractFacts = (input: ExtractFactsInput) => Promise<ExtractedFact[]>

/** One fact per episode, stating its content and citing it. */
const factPerEpisode: ExtractFacts = async ({ episodes }) =>
  episodes.map(e => ({ topic: 'note', statement: `Stated: ${e.content}`, confidence: 0.8, episodeIds: [e.id] }))

function extractor(impl: ExtractFacts = factPerEpisode): IntelligenceAdapter & { extractFacts: ReturnType<typeof vi.fn> } {
  return { extractFacts: vi.fn(impl) }
}

/** A digest over the given turns, all in one session. */
function digestOver(episodes: Episode[], overrides: Parameters<typeof makeDigest>[0] = {}) {
  return makeDigest({ sourceEpisodeIds: episodes.map(e => e.id), ...overrides })
}

function storageWith(episodes: Episode[], digests: ReturnType<typeof makeDigest>[]) {
  return makeMockStorage({ initialDigests: digests, episodesPerSession: new Map([['session-1', episodes]]) })
}

describe('deep sleep reads each digest once, from its episodes', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('two runs over the same digests extract each digest once and stamp it', async () => {
    const eps = [makeEpisode({ content: 'one' }), makeEpisode({ content: 'two' }), makeEpisode({ content: 'three' })]
    const digests = eps.map((e, i) => digestOver([e], { createdAt: at(`2026-09-0${i + 1}T00:00:00Z`) }))
    const storage = storageWith(eps, digests)
    const intelligence = extractor()

    const first = await deepSleep(storage, intelligence, { minDigests: 1 })
    const second = await deepSleep(storage, intelligence, { minDigests: 0 })

    expect(intelligence.extractFacts).toHaveBeenCalledTimes(3)
    expect(first.promoted).toBe(3)
    expect(second).toEqual(expect.objectContaining({ promoted: 0, deduplicated: 0, extractionFailed: 0, noEpisodes: 0 }))
    expect(storage.semantic.insert).toHaveBeenCalledTimes(3)
    expect(vi.mocked(storage.digests.markFactsExtracted).mock.calls.map(c => c[0])).toEqual(digests.map(d => d.id))
    expect(await storage.digests.getPendingFactExtraction(10, 3)).toEqual([])
  })

  it('leaves a digest whose extraction throws pending, counts it, moves on, and retries it on the next run', async () => {
    const eps = [makeEpisode({ content: 'fails first' }), makeEpisode({ content: 'works' })]
    const [failing, working] = eps.map((e, i) => digestOver([e], { createdAt: at(`2026-09-0${i + 1}T00:00:00Z`) }))
    const storage = storageWith(eps, [failing!, working!])
    const intelligence = extractor()
    intelligence.extractFacts.mockRejectedValueOnce(new FactExtractionError('length', 'reply cut off at max_tokens'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const first = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(first).toEqual(expect.objectContaining({ promoted: 1, extractionFailed: 1, noEpisodes: 0 }))
    expect(storage.digests.markFactsExtracted).toHaveBeenCalledTimes(1)
    expect(storage.digests.markFactsExtracted).toHaveBeenCalledWith(working!.id, expect.any(Date))
    expect((await storage.digests.getPendingFactExtraction(10, 3)).map(d => d.id)).toEqual([failing!.id])
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toContain(failing!.id)

    const retry = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(retry).toEqual(expect.objectContaining({ promoted: 1, extractionFailed: 0 }))
    expect(intelligence.extractFacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ episodes: [expect.objectContaining({ id: eps[0]!.id })] }),
    )
    expect(await storage.digests.getPendingFactExtraction(10, 3)).toEqual([])
  })

  it('never hands a forgotten episode to the extractor, and stamps a digest with no live episode without reading it', async () => {
    const live = makeEpisode({ content: 'still here', createdAt: at('2026-09-01T10:00:00Z') })
    const forgotten = makeEpisode({ content: 'forget me', createdAt: at('2026-09-01T11:00:00Z') })
    const allGone = makeEpisode({ content: 'I always deploy on Fridays', createdAt: at('2026-09-02T10:00:00Z') })
    const mixed = digestOver([live, forgotten], { createdAt: at('2026-09-01T12:00:00Z') })
    const empty = digestOver([allGone], { summary: 'I always deploy on Fridays.', createdAt: at('2026-09-02T12:00:00Z') })
    const storage = storageWith([live, forgotten, allGone], [mixed, empty])
    const tombstoned = new Set([forgotten.id, allGone.id])
    const episodes = [live, forgotten, allGone]
    vi.mocked(storage.episodes.getByIds).mockImplementation(async (ids, opts) =>
      episodes.filter(e => ids.includes(e.id) && (opts?.includeInactive || !tombstoned.has(e.id))),
    )
    const intelligence = extractor()

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(intelligence.extractFacts).toHaveBeenCalledTimes(1)
    const input = intelligence.extractFacts.mock.calls[0]![0] as ExtractFactsInput
    expect(input.episodes.map(e => e.id)).toEqual([live.id])
    expect(JSON.stringify(intelligence.extractFacts.mock.calls)).not.toContain('forget me')
    expect(result).toEqual(expect.objectContaining({ promoted: 1, procedural: 0, noEpisodes: 1, extractionFailed: 0 }))
    expect(storage.procedural.insert).not.toHaveBeenCalled()
    expect(storage.digests.markFactsExtracted).toHaveBeenCalledWith(empty.id, expect.any(Date))
  })

  it('hands the episodes over oldest first with their dates, roles and the digest project', async () => {
    const later = makeEpisode({ role: 'assistant', content: 'answer', createdAt: at('2026-09-01T10:05:00Z') })
    const earlier = makeEpisode({ role: 'user', content: 'question', createdAt: at('2026-09-01T10:00:00Z') })
    const digest = makeDigest({ sourceEpisodeIds: [later.id, earlier.id], projectId: 'engram' })
    const storage = storageWith([later, earlier], [digest])
    const intelligence = extractor()

    await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(intelligence.extractFacts).toHaveBeenCalledWith({
      episodes: [
        { id: earlier.id, role: 'user', createdAt: earlier.createdAt, content: 'question' },
        { id: later.id, role: 'assistant', createdAt: later.createdAt, content: 'answer' },
      ],
      projectId: 'engram',
    })
  })

  it('stores each fact with its statement, its cited episodes, its digest and the digest project', async () => {
    const a = makeEpisode({ content: 'a' })
    const b = makeEpisode({ content: 'b' })
    const digest = digestOver([a, b], { projectId: 'engram' })
    const storage = storageWith([a, b], [digest])
    const intelligence = extractor(async () => [
      { topic: 'engram', statement: 'Engram stores facts per digest once.', confidence: 0.7, episodeIds: [b.id] },
      { topic: 'ghost', statement: 'Cites an episode outside the batch.', confidence: 0.9, episodeIds: ['ep-unknown'] },
    ])

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result.promoted).toBe(1)
    expect(storage.semantic.insert).toHaveBeenCalledTimes(1)
    expect(storage.semantic.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'engram',
      content: 'Engram stores facts per digest once.',
      confidence: 0.7,
      sourceEpisodeIds: [b.id],
      sourceDigestIds: [digest.id],
      projectId: 'engram',
    }))
  })

  it('without extractFacts, reads first-person patterns from user turns only, never from the summary', async () => {
    const user = makeEpisode({ role: 'user', content: 'I prefer tabs.' })
    const assistant = makeEpisode({ role: 'assistant', content: 'I prefer spaces.' })
    const digest = digestOver([user, assistant], { summary: 'I like vim. My workflow is lint first.' })
    const storage = storageWith([user, assistant], [digest])

    const result = await deepSleep(storage, undefined, { minDigests: 1 })

    const semantic = vi.mocked(storage.semantic.insert).mock.calls.map(([row]) => row)
    expect(semantic.map(r => r.content)).toEqual(['tabs'])
    expect(semantic[0]).toEqual(expect.objectContaining({ sourceEpisodeIds: [user.id], sourceDigestIds: [digest.id] }))
    expect(result).toEqual(expect.objectContaining({ promoted: 1, procedural: 1 }))
    expect(vi.mocked(storage.procedural.insert).mock.calls[0]![0].procedure).toBe('lint first.')
  })

  it('still reads procedures from the summary when the model extracts the facts', async () => {
    const ep = makeEpisode({ content: 'plain turn' })
    const digest = digestOver([ep], { summary: 'My workflow is tests before code.' })
    const storage = storageWith([ep], [digest])

    const result = await deepSleep(storage, extractor(async () => []), { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ promoted: 0, procedural: 1 }))
  })

  it('applies minDigests to the pending count and takes at most maxDigests, oldest first', async () => {
    const eps = [1, 2, 3, 4].map(i => makeEpisode({ content: `turn ${i}` }))
    const digests = eps.map((e, i) => digestOver([e], { createdAt: at(`2026-09-0${4 - i}T00:00:00Z`) }))
    digests[0] = { ...digests[0]!, factsExtractedAt: at('2026-09-05T00:00:00Z') }
    const storage = storageWith(eps, digests)
    const intelligence = extractor()

    const skipped = await deepSleep(storage, intelligence, { minDigests: 4 })
    expect(skipped).toEqual(expect.objectContaining({ promoted: 0, extractionFailed: 0, noEpisodes: 0 }))
    expect(intelligence.extractFacts).not.toHaveBeenCalled()

    const ran = await deepSleep(storage, intelligence, { minDigests: 2, maxDigests: 2 })

    expect(storage.digests.getPendingFactExtraction).toHaveBeenLastCalledWith(2, 3)
    expect(ran.promoted).toBe(2)
    const extracted = intelligence.extractFacts.mock.calls.map(c => (c[0] as ExtractFactsInput).episodes[0]!.content)
    expect(extracted).toEqual(['turn 4', 'turn 3'])
  })

  it('takes 50 pending digests per run by default', async () => {
    const storage = makeMockStorage()
    await deepSleep(storage, extractor(), { minDigests: 0 })
    expect(DEFAULT_MAX_DIGESTS).toBe(50)
    expect(storage.digests.getPendingFactExtraction).toHaveBeenCalledWith(50, 3)
  })
})

describe('a digest that keeps failing cannot jam the pending queue', () => {
  beforeEach(() => {
    resetIdCounter()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Rejects for any call whose episodes include `content`, extracts the rest. */
  function failingOn(content: string, error: () => Error = () => new FactExtractionError('length', 'reply cut off at max_tokens')) {
    return extractor(async (input) => {
      if (input.episodes.some(e => e.content === content)) throw error()
      return factPerEpisode(input)
    })
  }

  it('counts each failure on the digest, stops retrying it after three, and extracts newer digests', async () => {
    const eps = [makeEpisode({ content: 'always fails' }), makeEpisode({ content: 'newer one' })]
    const [stuck, newer] = eps.map((e, i) => digestOver([e], { createdAt: at(`2026-09-0${i + 1}T00:00:00Z`) }))
    const storage = storageWith(eps, [stuck!])
    const intelligence = failingOn('always fails')

    const runs = []
    for (let i = 0; i < 3; i++) runs.push(await deepSleep(storage, intelligence, { minDigests: 1 }))

    expect(runs.map(r => r.extractionFailed)).toEqual([1, 1, 1])
    expect(runs.map(r => r.extractionExhausted)).toEqual([0, 0, 1])
    expect(storage.digests.recordFactExtractionFailure).toHaveBeenCalledTimes(3)
    expect(storage.digests.markFactsExtracted).not.toHaveBeenCalled()
    expect(await storage.digests.getPendingFactExtraction(10, 3)).toEqual([])
    const stored = (await storage.digests.getRecent(3650)).find(d => d.id === stuck!.id)!
    expect(stored.factExtractionAttempts).toBe(3)
    expect(stored.factsExtractedAt ?? null).toBeNull()

    await storage.digests.insert(newer!)
    intelligence.extractFacts.mockClear()
    const fourth = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(fourth).toEqual(expect.objectContaining({ promoted: 1, extractionFailed: 0, extractionExhausted: 0 }))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(1)
    expect(intelligence.extractFacts).toHaveBeenCalledWith(
      expect.objectContaining({ episodes: [expect.objectContaining({ content: 'newer one' })] }),
    )
  })

  it('honours a configured attempt cap', async () => {
    const eps = [makeEpisode({ content: 'always fails' })]
    const storage = storageWith(eps, [digestOver(eps)])
    const intelligence = failingOn('always fails')

    const first = await deepSleep(storage, intelligence, { minDigests: 1, maxExtractionAttempts: 1 })
    const second = await deepSleep(storage, intelligence, { minDigests: 1, maxExtractionAttempts: 1 })

    expect(first).toEqual(expect.objectContaining({ extractionFailed: 1, extractionExhausted: 1 }))
    expect(second).toEqual(expect.objectContaining({ extractionFailed: 0, extractionExhausted: 0, promoted: 0 }))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(1)
    expect(storage.digests.getPendingFactExtraction).toHaveBeenLastCalledWith(DEFAULT_MAX_DIGESTS, 1)
  })

  it('does not count an open circuit against the digest and ends the run at it', async () => {
    const eps = [makeEpisode({ content: 'first' }), makeEpisode({ content: 'second' }), makeEpisode({ content: 'third' })]
    const digests = eps.map((e, i) => digestOver([e], { createdAt: at(`2026-09-0${i + 1}T00:00:00Z`) }))
    const storage = storageWith(eps, digests)
    const intelligence = failingOn('second', () => new CircuitOpenError('Circuit breaker is open'))

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({
      promoted: 1, extractionFailed: 0, extractionExhausted: 0, extractionDeferred: 2,
    }))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(2)
    expect(storage.digests.recordFactExtractionFailure).not.toHaveBeenCalled()
    expect(vi.mocked(storage.digests.markFactsExtracted).mock.calls.map(c => c[0])).toEqual([digests[0]!.id])
    expect((await storage.digests.getPendingFactExtraction(10, 3)).map(d => d.id)).toEqual([digests[1]!.id, digests[2]!.id])
  })

  it('recognises an open circuit thrown by another copy of the error class', async () => {
    const eps = [makeEpisode({ content: 'only' })]
    const storage = storageWith(eps, [digestOver(eps)])
    const foreign = Object.assign(new Error('Circuit breaker is open'), { name: 'CircuitOpenError' })
    const intelligence = failingOn('only', () => foreign)

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionDeferred: 1 }))
    expect(storage.digests.recordFactExtractionFailure).not.toHaveBeenCalled()
  })
})

describe('only an unusable reply counts against a digest', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetIdCounter()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Shaped like the openai SDK's APIError for a 503 from the provider. */
  function serviceUnavailable(): Error {
    return Object.assign(new Error('503 upstream connect error'), { name: 'InternalServerError', status: 503 })
  }

  function threeDigests() {
    const eps = [makeEpisode({ content: 'first' }), makeEpisode({ content: 'second' }), makeEpisode({ content: 'third' })]
    const digests = eps.map((e, i) => digestOver([e], { createdAt: at(`2026-09-0${i + 1}T00:00:00Z`) }))
    return { eps, digests, storage: storageWith(eps, digests) }
  }

  async function attemptsOf(storage: ReturnType<typeof storageWith>, id: string): Promise<number | undefined> {
    return (await storage.digests.getRecent(3650)).find(d => d.id === id)?.factExtractionAttempts
  }

  it('an API error ends the run at its digest, counts no attempt and leaves it and the rest pending', async () => {
    const { digests, storage } = threeDigests()
    const intelligence = extractor()
    intelligence.extractFacts.mockRejectedValueOnce(serviceUnavailable())

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({
      promoted: 0, extractionFailed: 0, extractionExhausted: 0, extractionDeferred: 3,
    }))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(1)
    expect(storage.digests.recordFactExtractionFailure).not.toHaveBeenCalled()
    expect(storage.digests.markFactsExtracted).not.toHaveBeenCalled()
    expect(await attemptsOf(storage, digests[0]!.id) ?? 0).toBe(0)
    expect((await storage.digests.getPendingFactExtraction(10, 3)).map(d => d.id)).toEqual(digests.map(d => d.id))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('InternalServerError: 503 upstream connect error')
  })

  it('a FactExtractionError counts an attempt and the run moves on to the next digest', async () => {
    const { digests, storage } = threeDigests()
    const intelligence = extractor()
    intelligence.extractFacts.mockRejectedValueOnce(new FactExtractionError('parse', 'reply holds no facts object'))

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ promoted: 2, extractionFailed: 1, extractionDeferred: 0 }))
    expect(storage.digests.recordFactExtractionFailure).toHaveBeenCalledWith(digests[0]!.id)
    expect(await attemptsOf(storage, digests[0]!.id)).toBe(1)
    expect((await storage.digests.getPendingFactExtraction(10, 3)).map(d => d.id)).toEqual([digests[0]!.id])
  })

  it('counts a FactExtractionError thrown by another copy of the class', async () => {
    const { digests, storage } = threeDigests()
    const foreign = Object.assign(new Error('reply cut off at max_tokens'), { name: 'FactExtractionError', kind: 'length' })
    const intelligence = extractor()
    intelligence.extractFacts.mockRejectedValueOnce(foreign)

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 1, extractionDeferred: 0 }))
    expect(await attemptsOf(storage, digests[0]!.id)).toBe(1)
  })

  it('three runs that hit an API error never exhaust a digest, and it is extracted once the API is back', async () => {
    const { digests, storage } = threeDigests()
    const intelligence = extractor()
    for (let i = 0; i < 3; i++) intelligence.extractFacts.mockRejectedValueOnce(serviceUnavailable())

    const runs = []
    for (let i = 0; i < 3; i++) runs.push(await deepSleep(storage, intelligence, { minDigests: 1 }))

    expect(runs.map(r => r.extractionExhausted)).toEqual([0, 0, 0])
    expect(runs.map(r => r.extractionDeferred)).toEqual([3, 3, 3])
    expect(storage.digests.recordFactExtractionFailure).not.toHaveBeenCalled()
    expect(await attemptsOf(storage, digests[0]!.id) ?? 0).toBe(0)

    const recovered = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(recovered).toEqual(expect.objectContaining({ promoted: 3, extractionDeferred: 0 }))
    expect(await storage.digests.getPendingFactExtraction(10, 3)).toEqual([])
  })

  it('a failed episode read defers the run without counting an attempt', async () => {
    const { storage } = threeDigests()
    vi.mocked(storage.episodes.getByIds).mockRejectedValueOnce(new Error('Episode getByIds failed: fetch failed'))

    const result = await deepSleep(storage, extractor(), { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionDeferred: 3 }))
    expect(storage.digests.recordFactExtractionFailure).not.toHaveBeenCalled()
  })
})

describe('retrying a digest after a partial promote', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Search returns every stored fact, so an equal statement is found as a duplicate. */
  function searchStored(storage: ReturnType<typeof storageWith>): void {
    vi.mocked(storage.semantic.search).mockImplementation(async () =>
      storage.semantic._memories.map(item => ({ item, similarity: 1 })),
    )
  }

  it('neither inserts nor boosts the facts the failed run already stored, and stores the rest', async () => {
    const eps = [makeEpisode({ content: 'alpha' }), makeEpisode({ content: 'beta' })]
    const digest = digestOver(eps)
    const storage = storageWith(eps, [digest])
    searchStored(storage)
    const insert = vi.mocked(storage.semantic.insert)
    const realInsert = insert.getMockImplementation()!
    insert.mockImplementationOnce(realInsert).mockImplementationOnce(async () => {
      throw new Error('semantic insert failed: connection reset')
    })

    await expect(deepSleep(storage, extractor(), { minDigests: 1 })).rejects.toThrow('connection reset')
    expect(storage.semantic._memories.map(m => m.content)).toEqual(['Stated: alpha'])
    expect((await storage.digests.getPendingFactExtraction(10, 3)).map(d => d.id)).toEqual([digest.id])

    const retry = await deepSleep(storage, extractor(), { minDigests: 1 })

    expect(retry).toEqual(expect.objectContaining({ promoted: 1, deduplicated: 0 }))
    expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
    expect(storage.semantic._memories.map(m => m.content)).toEqual(['Stated: alpha', 'Stated: beta'])
    expect(await storage.digests.getPendingFactExtraction(10, 3)).toEqual([])
  })

  it('still boosts a duplicate stored from a different digest', async () => {
    const first = [makeEpisode({ content: 'alpha' })]
    const second = [makeEpisode({ content: 'alpha' })]
    const digests = [
      digestOver(first, { createdAt: at('2026-09-01T00:00:00Z') }),
      digestOver(second, { createdAt: at('2026-09-02T00:00:00Z') }),
    ]
    const storage = storageWith([...first, ...second], digests)
    searchStored(storage)

    const result = await deepSleep(storage, extractor(), { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ promoted: 1, deduplicated: 1 }))
    expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledTimes(1)
  })
})

describe('extractDigestFacts', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  it('returns candidates dated by their latest cited episode, and writes nothing', async () => {
    const first = makeEpisode({ content: 'x', createdAt: at('2026-09-01T10:00:00Z') })
    const second = makeEpisode({ content: 'y', createdAt: at('2026-09-03T10:00:00Z') })
    const third = makeEpisode({ content: 'z', createdAt: at('2026-09-05T10:00:00Z') })
    const digest = digestOver([first, second, third], { projectId: 'engram' })
    const storage = storageWith([first, second, third], [digest])
    const intelligence = extractor(async () => [
      { topic: 't', statement: 'Rests on the first two turns.', confidence: 0.6, episodeIds: [second.id, first.id] },
    ])

    const out = await extractDigestFacts(storage, intelligence, digest)

    expect(out).toEqual({
      status: 'extracted',
      candidates: [expect.objectContaining({
        kind: 'semantic',
        content: 'Rests on the first two turns.',
        sourceEpisodeIds: [second.id, first.id],
        sourceDigestIds: [digest.id],
        projectId: 'engram',
        statedAt: second.createdAt.getTime(),
      })],
    })
    expect(storage.semantic.insert).not.toHaveBeenCalled()
    expect(storage.digests.markFactsExtracted).not.toHaveBeenCalled()
  })

  it('reports a digest with no source episodes without calling the extractor', async () => {
    const digest = makeDigest({ sourceEpisodeIds: [] })
    const intelligence = extractor()

    const out = await extractDigestFacts(makeMockStorage({ initialDigests: [digest] }), intelligence, digest)

    expect(out).toEqual({ status: 'no-episodes' })
    expect(intelligence.extractFacts).not.toHaveBeenCalled()
  })
})
