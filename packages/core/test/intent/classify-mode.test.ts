import { describe, it, expect } from 'vitest'
import { classifyMode } from '../../src/intent/intents.js'
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

describe('Memory.recall with a short ticket-key query', () => {
  it('runs the search stage and returns the matching memory', async () => {
    const episode: Episode = {
      id: 'ep-ticket',
      sessionId: 'sess-1',
      role: 'user',
      content: 'ACA-2613 drilldown fix merged after review',
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
    const storage = createMockStorage({
      vectorSearchResults: [{ item: { type: 'episode', data: episode }, similarity: 0.6 }],
      textBoostResults: [],
    })
    const memory = createMemory({ storage })
    await memory.initialize()
    const result = await memory.recall('ACA-2613', { embedding: [0.1, 0.2, 0.3] })
    await memory.dispose()

    expect(result.memories.map((m) => m.id)).toContain('ep-ticket')
  })
})
