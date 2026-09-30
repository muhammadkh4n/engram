import { describe, it, expect, vi } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createMemory } from '../../src/create-memory.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import {
  buildTextToEmbed,
  EMBED_MAX_CHARS,
  EMBED_CONTEXT_MAX_CHARS,
  EMBED_TEXT_VERSION,
} from '../../src/ingestion/embed-text.js'

// Deterministic filler whose every position is distinguishable, so a head or
// tail cut shows up as a missing substring rather than an identical repeat.
function text(label: string, length: number): string {
  let out = ''
  let i = 0
  while (out.length < length) {
    out += `${label}-${i} `
    i++
  }
  return out.slice(0, length)
}

// The tail-keeping construction that preceded the head-keeping rules. Used as
// an oracle: every input it did not cut must still produce the same text.
function tailKeepingRule(cleanText: string, preamble: string, contextTurns: readonly string[]): string {
  if (preamble) {
    return `${preamble.trim()}\n\n${cleanText}`.slice(-1500)
  }
  if (cleanText.length > 20) {
    if (contextTurns.length > 0) {
      const context = contextTurns.join('\n').slice(-500)
      return `${context}\n${cleanText}`.slice(-1000)
    }
    return cleanText
  }
  return cleanText
}

describe('buildTextToEmbed — preamble', () => {
  it('keeps the preamble and the message head for a 5,000-char message', () => {
    const preamble = text('pre', 200)
    const message = text('msg', 5000)
    const out = buildTextToEmbed({ cleanText: message, preamble })
    expect(out.startsWith(preamble.trim())).toBe(true)
    expect(out).toContain(message.slice(0, 200))
  })

  it('embeds a 300-char preamble with a 1,400-char message whole', () => {
    const preamble = text('pre', 300)
    const message = text('msg', 1400)
    const out = buildTextToEmbed({ cleanText: message, preamble })
    expect(out).toBe(`${preamble.trim()}\n\n${message}`)
  })

  it('caps a 7,000-char message at the limit and starts with the preamble', () => {
    const preamble = text('pre', 200)
    const message = text('msg', 7000)
    const out = buildTextToEmbed({ cleanText: message, preamble })
    expect(out).toHaveLength(EMBED_MAX_CHARS)
    expect(EMBED_MAX_CHARS).toBe(6000)
    expect(out.startsWith(preamble.trim())).toBe(true)
  })
})

describe('buildTextToEmbed — neighbour context', () => {
  it('keeps the head of a 3,000-char message and at most 500 chars of context', () => {
    const message = text('msg', 3000)
    const turns = [text('prev1', 800), text('prev2', 800)]
    const out = buildTextToEmbed({ cleanText: message, contextTurns: turns })
    expect(out.endsWith(`\n${message}`)).toBe(true)
    expect(out).toContain(message.slice(0, 200))
    const context = out.slice(0, out.length - message.length - 1)
    expect(context.length).toBeLessThanOrEqual(EMBED_CONTEXT_MAX_CHARS)
    expect(context).toBe(turns.join('\n').slice(-EMBED_CONTEXT_MAX_CHARS))
  })

  it('shrinks the context so the total stays within the cap', () => {
    const message = text('msg', EMBED_MAX_CHARS - 101)
    const out = buildTextToEmbed({ cleanText: message, contextTurns: [text('prev', 800)] })
    expect(out).toHaveLength(EMBED_MAX_CHARS)
    expect(out.endsWith(`\n${message}`)).toBe(true)
  })

  it('drops the context and keeps the message head when the message fills the cap', () => {
    const message = text('msg', 8000)
    const out = buildTextToEmbed({ cleanText: message, contextTurns: [text('prev', 300)] })
    expect(out).toBe(message.slice(0, EMBED_MAX_CHARS))
  })
})

describe('buildTextToEmbed — isolated and short messages', () => {
  it('keeps the head of a long isolated message', () => {
    const message = text('msg', 9000)
    expect(buildTextToEmbed({ cleanText: message })).toBe(message.slice(0, EMBED_MAX_CHARS))
  })

  it('embeds a short message from its raw string content', () => {
    expect(buildTextToEmbed({ cleanText: 'ok', rawContent: '[10:02] ok' })).toBe('[10:02] ok')
  })

  it('falls back to the clean text for a short message without raw string content', () => {
    expect(buildTextToEmbed({ cleanText: 'ok' })).toBe('ok')
  })
})

describe('buildTextToEmbed — unchanged for inputs the tail rule did not cut', () => {
  const contextCases: Array<[string, string[]]> = [
    [text('a', 21), [text('p', 40)]],
    [text('b', 120), [text('p', 300), text('q', 300)]],
    [text('c', 250), [text('p', 700)]],
    [text('d', 400), [text('p', 100), text('q', 100)]],
    [text('e', 480), [text('p', 520)]],
    [text('f', 499), [text('p', 450), text('q', 50)]],
    [text('g', 60), ['']],
    [text('h', 300), [text('p', 20)]],
    [text('i', 199), [text('p', 1200), text('q', 1200)]],
    [text('j', 450), [text('p', 49)]],
  ]

  const preambleCases: Array<[string, string]> = [
    [text('a', 10), text('pre', 50)],
    [text('b', 1000), text('pre', 300)],
    [text('c', 1300), text('pre', 198)],
    [text('d', 500), `  ${text('pre', 400)}  `],
    [text('e', 1), text('pre', 120)],
    [text('f', 900), text('pre', 500)],
    [text('g', 1200), text('pre', 250)],
    [text('h', 700), text('pre', 700)],
    [text('i', 200), text('pre', 1000)],
    [text('j', 1450), text('pre', 48)],
  ]

  it.each(contextCases)('context pair %#', (message, turns) => {
    const old = tailKeepingRule(message, '', turns)
    expect(old.length).toBeLessThanOrEqual(1000)
    expect(buildTextToEmbed({ cleanText: message, contextTurns: turns })).toBe(old)
  })

  it.each(preambleCases)('preamble pair %#', (message, preamble) => {
    const old = tailKeepingRule(message, preamble, [])
    expect(old.length).toBeLessThanOrEqual(1500)
    expect(buildTextToEmbed({ cleanText: message, preamble })).toBe(old)
  })
})

describe('Memory.ingest — embed-text version marker', () => {
  it('stores embedTextVersion with the vector', async () => {
    const storage = sqliteAdapter()
    const intelligence: IntelligenceAdapter = { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) }
    const memory = createMemory({ storage, intelligence })
    await memory.initialize()

    await memory.ingest({ role: 'user', content: 'Deploy notes for the staging cluster rollout' })

    const hits = await storage.episodes.search('staging', { limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.item.embedding).not.toBeNull()
    expect(hits[0]!.item.metadata['embedTextVersion']).toBe(EMBED_TEXT_VERSION)
    expect(EMBED_TEXT_VERSION).toBe(2)

    await memory.dispose()
  })

  it('omits the marker when the embedder throws', async () => {
    const storage = sqliteAdapter()
    const intelligence: IntelligenceAdapter = { embed: vi.fn().mockRejectedValue(new Error('embedder down')) }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const memory = createMemory({ storage, intelligence })
    await memory.initialize()

    await memory.ingest({ role: 'user', content: 'Deploy notes for the staging cluster rollout' })

    const hits = await storage.episodes.search('staging', { limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.item.embedding).toBeNull()
    expect(hits[0]!.item.metadata).not.toHaveProperty('embedTextVersion')

    errorSpy.mockRestore()
    await memory.dispose()
  })
})
