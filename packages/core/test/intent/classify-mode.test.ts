import { describe, it, expect } from 'vitest'
import { classifyMode, selectRecallMode } from '../../src/intent/intents.js'
import { createMemory } from '../../src/create-memory.js'
import type { Episode } from '../../src/types.js'
import { createMockStorage } from '../retrieval/mock-storage.js'

describe('classifyMode short queries', () => {
  it.each(['ACA-2613', 'jev', 'k8s', 'PROG-230', 'rexvps', 'sops'])(
    'classifies %s as light',
    (q) => {
      expect(classifyMode(q)).toBe('light')
    },
  )

  it.each(['ok', 'thanks', 'hi!', '👍', '', '   '])('classifies %j as skip', (q) => {
    expect(classifyMode(q)).toBe('skip')
  })

  it('still classifies a short question as deep', () => {
    expect(classifyMode('jev?')).toBe('deep')
  })
})

describe('classifyMode emoji detection', () => {
  it.each(['1933', '114', '#876', '*'])('does not treat %j as emoji-only', (q) => {
    expect(classifyMode(q)).not.toBe('skip')
  })

  it.each(['👍', '👍🏽', '❤️', '🇵🇰', '👨‍👩‍👧', '🎉 🎉'])('classifies %j as skip', (q) => {
    expect(classifyMode(q)).toBe('skip')
  })
})

describe('selectRecallMode', () => {
  it.each(['ok', 'thanks', '1933', '👍', 'continue', 'lgtm'])(
    'runs an explicit recall for %j at least light',
    (q) => {
      expect(selectRecallMode(q)).toBe('light')
    },
  )

  it('skips empty and whitespace-only text even for explicit recall', () => {
    expect(selectRecallMode('')).toBe('skip')
    expect(selectRecallMode('  \n ')).toBe('skip')
  })

  it('keeps a deep classification for explicit recall', () => {
    expect(selectRecallMode('ok?')).toBe('deep')
    expect(selectRecallMode('remind me about jev')).toBe('deep')
  })

  it.each([
    'continue', 'Continue.', 'go ahead', 'go on', 'do it', 'lgtm', 'LGTM!', 'yeah', 'yup', 'cool', 'k', 'kk',
    'yes please', 'sounds good', 'nice', 'great', 'perfect', 'proceed', 'ok', 'thanks', '👍',
  ])('skips the trivial turn %j under skipTrivial', (q) => {
    expect(selectRecallMode(q, { skipTrivial: true })).toBe('skip')
  })

  it.each(['continue the SAM migration', 'ACA-2613', 'go ahead with the rexvps deploy', '1933', 'k8s'])(
    'does not skip %j under skipTrivial',
    (q) => {
      expect(selectRecallMode(q, { skipTrivial: true })).not.toBe('skip')
    },
  )
})

function ticketEpisode(): Episode {
  return {
    id: 'ep-ticket',
    sessionId: 'sess-1',
    role: 'user',
    content: 'ACA-2613 drilldown fix merged after review for tenant 1933, ok to ship',
    salience: 0.5,
    accessCount: 0,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: null,
    entities: [],
    metadata: {},
    createdAt: new Date(),
    projectId: null,
  }
}

async function recallIds(query: string, opts: { skipTrivial?: boolean } = {}): Promise<string[]> {
  const storage = createMockStorage({
    vectorSearchResults: [{ item: { type: 'episode', data: ticketEpisode() }, similarity: 0.6 }],
    textBoostResults: [],
  })
  const memory = createMemory({ storage })
  await memory.initialize()
  const result = await memory.recall(query, { embedding: [0.1, 0.2, 0.3], ...opts })
  await memory.dispose()
  return result.memories.map((m) => m.id)
}

describe('Memory.recall with a short ticket-key query', () => {
  it('runs the search stage and returns the matching memory', async () => {
    expect(await recallIds('ACA-2613')).toContain('ep-ticket')
  })
})

describe('Memory.recall explicit vs per-turn intent', () => {
  it.each(['ok', '1933'])('an explicit recall for %j runs the search', async (q) => {
    expect(await recallIds(q)).toContain('ep-ticket')
  })

  it.each(['continue', 'lgtm', '👍'])('skipTrivial skips the trivial turn %j', async (q) => {
    expect(await recallIds(q, { skipTrivial: true })).toEqual([])
  })

  it.each(['continue the SAM migration', 'ACA-2613'])('skipTrivial still searches for %j', async (q) => {
    expect(await recallIds(q, { skipTrivial: true })).toContain('ep-ticket')
  })
})
