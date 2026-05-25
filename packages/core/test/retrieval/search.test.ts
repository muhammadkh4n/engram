import { describe, it, expect, vi } from 'vitest'
import { unifiedSearch, isRecallFailureNoise } from '../../src/retrieval/search.js'
import { createMockStorage } from './mock-storage.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import type { RecallStrategy } from '../../src/types.js'

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
