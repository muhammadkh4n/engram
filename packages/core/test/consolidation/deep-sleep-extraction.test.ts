import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { deepSleep, DEFAULT_MAX_DIGESTS } from '../../src/consolidation/deep-sleep.js'
import { factExtractionBackoffMs } from '../../src/consolidation/extraction-run.js'
import { extractDigestFacts } from '../../src/consolidation/fact-candidates.js'
import { EmptyFactReplyError, FactExtractionError, classifyExtractionError } from '../../src/adapters/intelligence.js'
import type { ExtractFactsInput, ExtractedFact, IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type { Episode } from '../../src/types.js'
import { CircuitOpenError } from '../../src/resilience/circuit-breaker.js'
import { TimeoutError } from '../../src/resilience/timeout.js'
import { makeDigest, makeEpisode, makeMockStorage, resetIdCounter } from './mock-storage.js'

const at = (iso: string) => new Date(iso)

/** The clock every test starts at; only Date is faked, timers stay real. */
const T0 = new Date('2026-10-03T12:00:00.000Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms)
}

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

type MockStorage = ReturnType<typeof storageWith>

/** One digest per content, a day apart, oldest first; `summaries[i]` replaces digest i's summary. */
function digestsOver(contents: string[], summaries: string[] = []) {
  const eps = contents.map(content => makeEpisode({ content }))
  const digests = eps.map((e, i) => digestOver([e], {
    createdAt: at(`2026-09-0${i + 1}T00:00:00Z`),
    ...(summaries[i] ? { summary: summaries[i] } : {}),
  }))
  return { eps, digests, storage: storageWith(eps, digests) }
}

/** Rejects with `failures[content]()` for any call whose episodes include `content`. */
function rejectingOn(failures: Record<string, () => unknown>) {
  return extractor(async (input) => {
    for (const e of input.episodes) {
      const failure = failures[e.content]
      if (failure) throw failure()
    }
    return factPerEpisode(input)
  })
}

function rejectingAll(failure: () => unknown) {
  return extractor(async () => {
    throw failure()
  })
}

/** Ids of the digests due at `when` (default now) under the default cap. */
async function pendingIds(storage: MockStorage, when: Date = new Date()): Promise<string[]> {
  return (await storage.digests.getPendingFactExtraction(10, 3, when)).map(d => d.id)
}

async function digestState(storage: MockStorage, id: string) {
  return (await storage.digests.getRecent(3650)).find(d => d.id === id)!
}

function markedIds(storage: MockStorage): string[] {
  return vi.mocked(storage.digests.markFactsExtracted).mock.calls.map(c => c[0])
}

/** Each recorded failure as [digest id, counted], in call order. */
function failureCalls(storage: MockStorage): Array<[string, boolean]> {
  return vi.mocked(storage.digests.recordFactExtractionFailure).mock.calls.map(c => [c[0], c[1].counted])
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
    expect(await pendingIds(storage, new Date(Date.now() + DAY))).toEqual([])
  })

  it('backs off a digest whose extraction throws, counts it, moves on, and retries it once it is due', async () => {
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
    expect(await pendingIds(storage)).toEqual([])
    expect(await pendingIds(storage, new Date(Date.now() + MINUTE))).toEqual([failing!.id])
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toContain(failing!.id)

    advance(MINUTE)
    const retry = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(retry).toEqual(expect.objectContaining({ promoted: 1, extractionFailed: 0 }))
    expect(intelligence.extractFacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ episodes: [expect.objectContaining({ id: eps[0]!.id })] }),
    )
    expect(await pendingIds(storage, new Date(Date.now() + DAY))).toEqual([])
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

    expect(storage.digests.getPendingFactExtraction).toHaveBeenLastCalledWith(2, 3, T0)
    expect(ran.promoted).toBe(2)
    const extracted = intelligence.extractFacts.mock.calls.map(c => (c[0] as ExtractFactsInput).episodes[0]!.content)
    expect(extracted).toEqual(['turn 4', 'turn 3'])
  })

  it('takes 50 pending digests per run by default', async () => {
    const storage = makeMockStorage()
    await deepSleep(storage, extractor(), { minDigests: 0 })
    expect(DEFAULT_MAX_DIGESTS).toBe(50)
    expect(storage.digests.getPendingFactExtraction).toHaveBeenCalledWith(50, 3, T0)
  })
})

describe('a counted failure caps a digest, a transient one never does', () => {
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

  it('honours a configured attempt cap', async () => {
    const { digests, storage } = digestsOver(['always fails', 'works'])
    const intelligence = rejectingOn({ 'always fails': () => new FactExtractionError('length', 'reply cut off at max_tokens') })

    const first = await deepSleep(storage, intelligence, { minDigests: 1, maxExtractionAttempts: 1 })
    advance(DAY)
    const second = await deepSleep(storage, intelligence, { minDigests: 0, maxExtractionAttempts: 1 })

    expect(first).toEqual(expect.objectContaining({ promoted: 1, extractionFailed: 1, extractionExhausted: 1 }))
    expect(second).toEqual(expect.objectContaining({ extractionFailed: 0, extractionExhausted: 0, promoted: 0 }))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(2)
    expect(storage.digests.getPendingFactExtraction).toHaveBeenLastCalledWith(DEFAULT_MAX_DIGESTS, 1, new Date(Date.now()))
    expect((await digestState(storage, digests[0]!.id)).factsExtractedAt ?? null).toBeNull()
  })

  it('an open circuit backs its digest off uncounted and ends the run at it', async () => {
    const { digests, storage } = digestsOver(['first', 'second', 'third'])
    const intelligence = rejectingOn({ second: () => new CircuitOpenError('Circuit breaker is open') })

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({
      promoted: 1, extractionFailed: 0, extractionExhausted: 0, extractionDeferred: 2, extractionBackedOff: 1,
    }))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(2)
    expect(failureCalls(storage)).toEqual([[digests[1]!.id, false]])
    expect(markedIds(storage)).toEqual([digests[0]!.id])
    expect(await pendingIds(storage)).toEqual([digests[2]!.id])
    expect(await pendingIds(storage, new Date(Date.now() + MINUTE))).toEqual([digests[1]!.id, digests[2]!.id])
  })

  it('recognises an open circuit thrown by another copy of the error class', async () => {
    const { storage } = digestsOver(['only'])
    const foreign = Object.assign(new Error('Circuit breaker is open'), { name: 'CircuitOpenError' })

    const result = await deepSleep(storage, rejectingOn({ only: () => foreign }), { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionDeferred: 1 }))
    expect(failureCalls(storage).map(([, counted]) => counted)).toEqual([false])
  })

  it('a 503 ends the run at its digest, backs only that digest off and counts nothing', async () => {
    const { digests, storage } = digestsOver(['first', 'second', 'third'])
    const intelligence = extractor()
    intelligence.extractFacts.mockRejectedValueOnce(serviceUnavailable())

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({
      promoted: 0, extractionFailed: 0, extractionExhausted: 0, extractionDeferred: 3, extractionBackedOff: 1,
    }))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(1)
    expect(storage.digests.markFactsExtracted).not.toHaveBeenCalled()
    expect((await digestState(storage, digests[0]!.id)).factExtractionAttempts ?? 0).toBe(0)
    expect(await pendingIds(storage)).toEqual([digests[1]!.id, digests[2]!.id])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('InternalServerError: 503 upstream connect error')
  })

  it('counts a FactExtractionError when other digests extract, and the run moves on', async () => {
    const { digests, storage } = digestsOver(['first', 'second', 'third'])
    const intelligence = extractor()
    intelligence.extractFacts.mockRejectedValueOnce(new FactExtractionError('length', 'reply cut off at max_tokens'))

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ promoted: 2, extractionFailed: 1, extractionDeferred: 0 }))
    expect(storage.digests.recordFactExtractionFailure).toHaveBeenCalledWith(
      digests[0]!.id, { counted: true, nextAttemptAt: new Date(T0.getTime() + MINUTE) },
    )
    expect(await pendingIds(storage, new Date(Date.now() + MINUTE))).toEqual([digests[0]!.id])
  })

  it('counts a FactExtractionError thrown by another copy of the class', async () => {
    const { digests, storage } = digestsOver(['first', 'second', 'third'])
    const foreign = Object.assign(new Error('reply cut off at max_tokens'), { name: 'FactExtractionError', kind: 'length' })
    const intelligence = extractor()
    intelligence.extractFacts.mockRejectedValueOnce(foreign)

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 1, extractionDeferred: 0 }))
    expect((await digestState(storage, digests[0]!.id)).factExtractionAttempts).toBe(1)
  })

  it('three due runs that hit a 503 never exhaust a digest, and it is extracted once the API is back', async () => {
    const { digests, storage } = digestsOver(['first', 'second', 'third'])
    const intelligence = extractor()
    for (let i = 0; i < 3; i++) intelligence.extractFacts.mockRejectedValueOnce(serviceUnavailable())

    const runs = []
    for (const wait of [0, MINUTE, 2 * MINUTE]) {
      advance(wait)
      runs.push(await deepSleep(storage, intelligence, { minDigests: 1 }))
    }

    expect(runs.map(r => r.extractionExhausted)).toEqual([0, 0, 0])
    expect(runs.map(r => r.extractionDeferred)).toEqual([3, 3, 3])
    expect(failureCalls(storage)).toEqual(Array.from({ length: 3 }, () => [digests[0]!.id, false]))

    advance(4 * MINUTE)
    const recovered = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(recovered).toEqual(expect.objectContaining({ promoted: 3, extractionDeferred: 0 }))
    expect(await pendingIds(storage, new Date(Date.now() + DAY))).toEqual([])
  })

  it('an episode read that fails for every digest counts nothing and backs each one off', async () => {
    const { storage } = digestsOver(['first', 'second', 'third'])
    vi.mocked(storage.episodes.getByIds).mockRejectedValue(new Error('Episode getByIds failed: fetch failed'))

    const result = await deepSleep(storage, extractor(), { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionBackedOff: 3, extractionDeferred: 0 }))
    expect(failureCalls(storage).every(([, counted]) => !counted)).toBe(true)
  })
})

describe('retrying a digest after a partial promote', () => {
  beforeEach(() => {
    resetIdCounter()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
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

    const failed = await deepSleep(storage, extractor(), { minDigests: 1 })
    expect(failed).toEqual(expect.objectContaining({ extractionFailed: 0, extractionBackedOff: 1 }))
    expect(storage.semantic._memories.map(m => m.content)).toEqual(['Stated: alpha'])
    expect(await pendingIds(storage, new Date(Date.now() + MINUTE))).toEqual([digest.id])

    advance(MINUTE)
    const retry = await deepSleep(storage, extractor(), { minDigests: 1 })

    expect(retry).toEqual(expect.objectContaining({ promoted: 1, deduplicated: 0 }))
    expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
    expect(storage.semantic._memories.map(m => m.content)).toEqual(['Stated: alpha', 'Stated: beta'])
    expect(await pendingIds(storage, new Date(Date.now() + DAY))).toEqual([])
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

/** Shaped like an openai SDK APIError: the status is a number field and the
 *  name stays 'Error', since the SDK does not set it. */
function apiError(status: number, message = `${status} provider error`): Error {
  return Object.assign(new Error(message), { status })
}

/** The openai SDK's connection failures keep `name` 'Error'; only the class
 *  name tells them apart. */
class APIConnectionError extends Error {}
class APIConnectionTimeoutError extends APIConnectionError {}

describe('classifyExtractionError', () => {
  it.each([400, 413, 422])('status %i is held', (status) => {
    expect(classifyExtractionError(apiError(status))).toBe('held')
  })

  it.each([401, 402, 403, 404, 408, 409, 429, 500, 502, 503, 504, 529])('status %i is transient', (status) => {
    expect(classifyExtractionError(apiError(status))).toBe('transient')
  })

  it.each([405, 410, 418, 451])('unlisted status %i is held', (status) => {
    expect(classifyExtractionError(apiError(status))).toBe('held')
  })

  it.each<[string, unknown, string]>([
    ['FactExtractionError length', new FactExtractionError('length', 'cut off'), 'held'],
    ['FactExtractionError parse', new FactExtractionError('parse', 'no object'), 'held'],
    ['FactExtractionError length from another copy', Object.assign(new Error('x'), { name: 'FactExtractionError', kind: 'length' }), 'held'],
    ['FactExtractionError parse from another copy', Object.assign(new Error('x'), { name: 'FactExtractionError', kind: 'parse' }), 'held'],
    ['EmptyFactReplyError', new EmptyFactReplyError('empty reply'), 'transient'],
    ['EmptyFactReplyError from another copy', Object.assign(new Error('x'), { name: 'EmptyFactReplyError' }), 'transient'],
    ['CircuitOpenError', new CircuitOpenError('Circuit breaker is open'), 'transient'],
    ['CircuitOpenError from another copy', Object.assign(new Error('x'), { name: 'CircuitOpenError' }), 'transient'],
    ['ECONNRESET', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'transient'],
    ['ETIMEDOUT', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), 'transient'],
    ['ENOTFOUND', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'transient'],
    ['fetch failed', new TypeError('fetch failed'), 'transient'],
    ['a connection error wrapping fetch failed', new APIConnectionError('Connection error.', {
      cause: new TypeError('fetch failed', { cause: Object.assign(new Error('read'), { code: 'ECONNRESET' }) }),
    }), 'transient'],
    ['a connection timeout', new APIConnectionTimeoutError('Request timed out.'), 'transient'],
    ['AbortError', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'transient'],
    ['TimeoutError', new TimeoutError(30_000), 'transient'],
    ['a plain Error', new Error('something broke'), 'held'],
    ['a status only in the message', new Error('503 Service Unavailable'), 'held'],
    ['a string status', Object.assign(new Error('503'), { status: '503' }), 'held'],
    ['a TypeError that is not fetch failed', new TypeError('x is not a function'), 'held'],
    ['a thrown string', 'boom', 'held'],
    ['undefined', undefined, 'held'],
  ])('%s', (_label, err, expected) => {
    expect(classifyExtractionError(err)).toBe(expected)
  })

  it('stops following a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(classifyExtractionError(a)).toBe('held')
  })
})

describe('a failing digest backs off, so no failure holds the head of the queue', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetIdCounter()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('backs off two adjacent digests that fail on their own, extracts the rest in the same run and counts both; three due runs exhaust them', async () => {
    const contents = ['too long A', 'too long B', 'third', 'fourth', 'fifth', 'sixth']
    const eps = contents.map(content => makeEpisode({ content }))
    const digests = eps.map((e, i) => digestOver([e], { createdAt: at(`2026-09-0${i + 1}T00:00:00Z`) }))
    const storage = storageWith(eps, digests.slice(0, 4))
    const tooLong = () => apiError(400, '400 context length exceeded')
    const intelligence = rejectingOn({ 'too long A': tooLong, 'too long B': tooLong })

    const first = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(first).toEqual(expect.objectContaining({
      promoted: 2, extractionFailed: 2, extractionBackedOff: 2, extractionExhausted: 0, extractionDeferred: 0,
    }))
    expect(markedIds(storage)).toEqual([digests[2]!.id, digests[3]!.id])
    expect(await pendingIds(storage)).toEqual([])
    expect(await pendingIds(storage, new Date(Date.now() + MINUTE))).toEqual([digests[0]!.id, digests[1]!.id])
    expect(String(warn.mock.calls[0]![0])).toBe(
      `[deep-sleep] fact extraction failed for digest ${digests[0]!.id} at extract (held; another digest got through extract this run; ` +
        'attempt 1 of 3; retried after 2026-10-03T12:01:00.000Z): Error: 400 context length exceeded',
    )

    const later = []
    for (const [next, wait] of [[4, MINUTE], [5, 2 * MINUTE]] as const) {
      advance(wait)
      await storage.digests.insert(digests[next]!)
      later.push(await deepSleep(storage, intelligence, { minDigests: 1 }))
    }

    expect(later.map(r => r.extractionFailed)).toEqual([2, 2])
    expect(later.map(r => r.extractionExhausted)).toEqual([0, 2])
    expect(later.map(r => r.promoted)).toEqual([1, 1])
    expect((await digestState(storage, digests[0]!.id)).factExtractionAttempts).toBe(3)
    expect((await digestState(storage, digests[1]!.id)).factExtractionAttempts).toBe(3)
    expect(await pendingIds(storage, new Date(Date.now() + DAY))).toEqual([])
  })

  it('a 404 on every call counts nothing over eleven runs, and the backoff doubles until it stops at 6 h', async () => {
    const { digests, storage } = digestsOver(['only'])
    const intelligence = rejectingAll(() => apiError(404, '404 model not found'))

    const waits: number[] = []
    for (let run = 0; run < 11; run++) {
      const result = await deepSleep(storage, intelligence, { minDigests: 1 })
      expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionBackedOff: 1, extractionDeferred: 1 }))
      const next = (await digestState(storage, digests[0]!.id)).factsNextAttemptAt!
      waits.push((next.getTime() - Date.now()) / 1000)
      vi.setSystemTime(next)
    }

    expect(waits).toEqual([60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, 21600, 21600])
    const state = await digestState(storage, digests[0]!.id)
    expect(state.factExtractionAttempts ?? 0).toBe(0)
    expect(state.factExtractionFailures).toBe(11)
    expect(failureCalls(storage).every(([, counted]) => !counted)).toBe(true)
  })

  it('an empty reply cut off at max_tokens on every call counts nothing, and each run backs off the next digest in line', async () => {
    const { digests, storage } = digestsOver(['first', 'second', 'third'])
    const intelligence = rejectingAll(() => new EmptyFactReplyError('extractFacts: empty reply (finish_reason=length, 1 episodes)'))

    const runs = []
    for (let run = 0; run < 3; run++) runs.push(await deepSleep(storage, intelligence, { minDigests: 1 }))

    expect(runs.map(r => r.extractionFailed)).toEqual([0, 0, 0])
    expect(runs.map(r => r.extractionDeferred)).toEqual([3, 2, 1])
    expect(failureCalls(storage)).toEqual(digests.map(d => [d.id, false]))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(3)
  })

  it('a promote that throws for every digest with facts counts nothing when the digests that went through wrote no row', async () => {
    const { digests, storage } = digestsOver(['fact one', 'quiet', 'fact two', 'quiet too'])
    vi.mocked(storage.semantic.insert).mockRejectedValue(new Error('semantic insert failed: permission denied'))
    const intelligence = extractor(async (input) =>
      input.episodes[0]!.content.startsWith('quiet') ? [] : factPerEpisode(input),
    )

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({
      promoted: 0, extractionFailed: 0, extractionBackedOff: 2, extractionDeferred: 0,
    }))
    expect(markedIds(storage)).toEqual([digests[1]!.id, digests[3]!.id])
    expect(failureCalls(storage)).toEqual([[digests[0]!.id, false], [digests[2]!.id, false]])
    expect(String(warn.mock.calls[0]![0])).toContain('at promote (held; no digest got through promote this run; not counted;')
  })

  it('a promote that throws for one digest only counts that digest, and the run goes on', async () => {
    const { digests, storage } = digestsOver(['poison', 'second', 'third'])
    const insert = vi.mocked(storage.semantic.insert)
    const realInsert = insert.getMockImplementation()!
    insert.mockImplementation(async (data) => {
      if (data.content === 'Stated: poison') throw new Error('semantic insert failed: value too long for column')
      return realInsert(data)
    })

    const result = await deepSleep(storage, extractor(), { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({
      promoted: 2, extractionFailed: 1, extractionBackedOff: 1, extractionDeferred: 0,
    }))
    expect(failureCalls(storage)).toEqual([[digests[0]!.id, true]])
    expect(markedIds(storage)).toEqual([digests[1]!.id, digests[2]!.id])
    expect(await pendingIds(storage, new Date(Date.now() + MINUTE))).toEqual([digests[0]!.id])
  })

  it('a 400 on every call counts nothing and backs every digest off', async () => {
    const { digests, storage } = digestsOver(['first', 'second', 'third'])
    const intelligence = rejectingAll(() => apiError(400, '400 unsupported parameter'))

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionBackedOff: 3, extractionDeferred: 0 }))
    expect(failureCalls(storage)).toEqual(digests.map(d => [d.id, false]))
    expect(await pendingIds(storage)).toEqual([])
    expect(await pendingIds(storage, new Date(Date.now() + MINUTE))).toEqual(digests.map(d => d.id))
  })

  it('an unparseable reply on one digest only is counted, and on every call is not', async () => {
    const one = digestsOver(['garbled', 'second', 'third'])
    const garbled = () => new FactExtractionError('parse', 'reply holds no facts object')

    const counted = await deepSleep(one.storage, rejectingOn({ garbled }), { minDigests: 1 })

    expect(counted).toEqual(expect.objectContaining({ promoted: 2, extractionFailed: 1, extractionBackedOff: 1 }))
    expect((await digestState(one.storage, one.digests[0]!.id)).factExtractionAttempts).toBe(1)

    const every = digestsOver(['first', 'second', 'third'])
    const uncounted = await deepSleep(every.storage, rejectingAll(garbled), { minDigests: 1 })

    expect(uncounted).toEqual(expect.objectContaining({ promoted: 0, extractionFailed: 0, extractionBackedOff: 3 }))
    expect(failureCalls(every.storage).every(([, isCounted]) => !isCounted)).toBe(true)
  })

  it('a failure no other unit could test is not counted: a lone digest beside one with no live episode', async () => {
    const eps = [makeEpisode({ content: 'odd' })]
    const digests = [
      digestOver(eps, { createdAt: at('2026-09-01T00:00:00Z') }),
      makeDigest({ sourceEpisodeIds: [], createdAt: at('2026-09-02T00:00:00Z') }),
    ]
    const storage = storageWith(eps, digests)

    const result = await deepSleep(storage, rejectingOn({ odd: () => new Error('unexpected reply shape') }), { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ noEpisodes: 1, extractionFailed: 0, extractionBackedOff: 1 }))
    expect(markedIds(storage)).toEqual([digests[1]!.id])
    expect(String(warn.mock.calls[0]![0])).toContain('at extract (held; no digest got through extract this run; not counted;')
  })

  it('settles held failures when a transient failure ends the run, counting only steps a unit before the stop proved', async () => {
    const { digests, storage } = digestsOver(['rejected', 'second', 'outage', 'fourth'])
    const intelligence = rejectingOn({ rejected: () => apiError(422, '422 unprocessable'), outage: () => apiError(503) })

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({
      promoted: 1, extractionFailed: 1, extractionBackedOff: 2, extractionDeferred: 2,
    }))
    expect(failureCalls(storage)).toEqual([[digests[2]!.id, false], [digests[0]!.id, true]])
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(3)
    expect(await pendingIds(storage)).toEqual([digests[3]!.id])
  })

  it('an empty reply backs its digest off uncounted and ends the run', async () => {
    const { digests, storage } = digestsOver(['first', 'second'])
    const intelligence = rejectingOn({ first: () => new EmptyFactReplyError('extractFacts: empty reply') })

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionBackedOff: 1, extractionDeferred: 2 }))
    expect(failureCalls(storage)).toEqual([[digests[0]!.id, false]])
    expect(await pendingIds(storage)).toEqual([digests[1]!.id])
  })

  it.each([
    ['503', () => apiError(503)],
    ['429', () => apiError(429, '429 rate limited')],
  ])('a %s backs its digest off uncounted for a minute and ends the run', async (_label, failure) => {
    const { digests, storage } = digestsOver(['first', 'second'])
    const intelligence = rejectingOn({ first: failure })

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionBackedOff: 1, extractionDeferred: 2 }))
    expect(intelligence.extractFacts).toHaveBeenCalledTimes(1)
    expect(storage.digests.recordFactExtractionFailure).toHaveBeenCalledWith(
      digests[0]!.id, { counted: false, nextAttemptAt: new Date(T0.getTime() + MINUTE) },
    )
  })

  it('a key or billing rejection backs off uncounted and logs at error level', async () => {
    const { digests, storage } = digestsOver(['first', 'second'])
    const intelligence = rejectingOn({ first: () => apiError(402, '402 insufficient credits') })

    const result = await deepSleep(storage, intelligence, { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ extractionFailed: 0, extractionDeferred: 2 }))
    expect(failureCalls(storage)).toEqual([[digests[0]!.id, false]])
    expect(warn).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]![0])).toContain(`digest ${digests[0]!.id} at extract (transient; not counted;`)
  })

  it('a stamp that fails alone is not counted, and the re-extraction does not re-boost its procedures', async () => {
    const { digests, storage } = digestsOver(['plain turn'], ['My workflow is tests before code.'])
    vi.mocked(storage.procedural.search).mockImplementation(async () =>
      storage.procedural._memories.map(item => ({ item, similarity: 1 })),
    )
    vi.mocked(storage.digests.markFactsExtracted).mockRejectedValueOnce(new Error('digest update failed: connection reset'))

    const failed = await deepSleep(storage, extractor(async () => []), { minDigests: 1 })

    expect(failed).toEqual(expect.objectContaining({ procedural: 1, extractionFailed: 0, extractionBackedOff: 1 }))
    expect(failureCalls(storage)).toEqual([[digests[0]!.id, false]])

    advance(MINUTE)
    const retry = await deepSleep(storage, extractor(async () => []), { minDigests: 1 })

    expect(retry).toEqual(expect.objectContaining({ procedural: 0, extractionBackedOff: 0 }))
    expect(storage.procedural.insert).toHaveBeenCalledTimes(1)
    expect(storage.procedural.incrementObservation).not.toHaveBeenCalled()
    expect(storage.procedural._memories[0]!.metadata).toEqual({ sourceDigestIds: [digests[0]!.id] })
    expect(await pendingIds(storage)).toEqual([])
  })

  it('a procedure read again from a different digest still counts as observed again', async () => {
    const { storage } = digestsOver(
      ['one', 'two'],
      ['My workflow is tests before code.', 'My workflow is tests before code.'],
    )
    vi.mocked(storage.procedural.search).mockImplementation(async () =>
      storage.procedural._memories.map(item => ({ item, similarity: 1 })),
    )

    const result = await deepSleep(storage, extractor(async () => []), { minDigests: 1 })

    expect(result).toEqual(expect.objectContaining({ procedural: 1 }))
    expect(storage.procedural.incrementObservation).toHaveBeenCalledTimes(1)
  })
})

describe('factExtractionBackoffMs', () => {
  it.each([
    [0, 60],
    [1, 60],
    [2, 120],
    [3, 240],
    [5, 960],
    [8, 7_680],
    [9, 15_360],
    [10, 21_600],
    [11, 21_600],
    [100, 21_600],
    [5_000, 21_600],
  ])('after failure %i waits %i s', (failures, seconds) => {
    expect(factExtractionBackoffMs(failures)).toBe(seconds * 1000)
  })
})
