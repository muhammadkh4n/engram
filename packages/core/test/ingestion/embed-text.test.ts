import { describe, it, expect, vi } from 'vitest'
import { findPostgresUnsafeText } from '../../src/text/postgres-text.js'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createMemory } from '../../src/create-memory.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import {
  buildTextToEmbed,
  capEmbedText,
  EMBED_MAX_CHARS,
  EMBED_MAX_UTF8_BYTES,
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

describe('buildTextToEmbed — every cut keeps whole characters', () => {
  // An emoji whose surrogate pair straddles the cap: units 5999 and 6000.
  const straddling = `${'x'.repeat(EMBED_MAX_CHARS - 1)}😀tail`

  function expectWellFormed(out: string): void {
    expect(findPostgresUnsafeText(out)).toBeNull()
  }

  it('cuts a preamble and message before a pair the cap would split', () => {
    const preamble = 'A sample preamble.'
    const prefix = `${preamble}\n\n`
    const message = `${'x'.repeat(EMBED_MAX_CHARS - prefix.length - 1)}😀tail`
    const out = buildTextToEmbed({ cleanText: message, preamble })
    expect(out).toBe(`${prefix}${'x'.repeat(EMBED_MAX_CHARS - prefix.length - 1)}`)
    expectWellFormed(out)
  })

  it('starts the context after a pair its budget would split', () => {
    const message = 'a sample message long enough to take context'
    const turns = [`an earlier turn 😀${'c'.repeat(EMBED_CONTEXT_MAX_CHARS - 1)}`]
    const out = buildTextToEmbed({ cleanText: message, contextTurns: turns })
    expect(out).toBe(`${'c'.repeat(EMBED_CONTEXT_MAX_CHARS - 1)}\n${message}`)
    expectWellFormed(out)
  })

  it('cuts a message with no room for context before a pair the cap would split', () => {
    const out = buildTextToEmbed({ cleanText: straddling, contextTurns: ['an earlier turn'] })
    expect(out).toBe('x'.repeat(EMBED_MAX_CHARS - 1))
    expectWellFormed(out)
  })

  it('cuts a long isolated message before a pair the cap would split', () => {
    const out = buildTextToEmbed({ cleanText: straddling })
    expect(out).toBe('x'.repeat(EMBED_MAX_CHARS - 1))
    expectWellFormed(out)
  })

  it('cuts the raw content of a short message before a pair the cap would split', () => {
    const out = buildTextToEmbed({ cleanText: 'ok', rawContent: straddling })
    expect(out).toBe('x'.repeat(EMBED_MAX_CHARS - 1))
    expectWellFormed(out)
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

describe('capEmbedText — the UTF-8 bound under the model token limit', () => {
  const bytes = (t: string): number => new TextEncoder().encode(t).length

  it('returns ASCII and mixed text whose head fits unchanged', () => {
    const ascii = text('ascii', EMBED_MAX_CHARS)
    expect(capEmbedText(ascii)).toBe(ascii)
    const mixed = `${'é'.repeat(2000)}${'x'.repeat(4000)}`
    expect(bytes(mixed)).toBeLessThanOrEqual(EMBED_MAX_UTF8_BYTES)
    expect(capEmbedText(mixed)).toBe(mixed)
  })

  it('cuts 6,000 CJK characters (18,000 bytes) to the bound on a character boundary', () => {
    const cjk = '語'.repeat(EMBED_MAX_CHARS)
    const capped = capEmbedText(cjk)
    expect(bytes(capped)).toBeLessThanOrEqual(EMBED_MAX_UTF8_BYTES)
    expect(capped).toBe('語'.repeat(Math.floor(EMBED_MAX_UTF8_BYTES / 3)))
  })

  it('never splits a four-byte character', () => {
    const emoji = `ab${'🙂'.repeat(2999)}`
    const capped = capEmbedText(emoji)
    expect(bytes(capped)).toBeLessThanOrEqual(EMBED_MAX_UTF8_BYTES)
    expect(capped).toBe(`ab${'🙂'.repeat(Math.floor((EMBED_MAX_UTF8_BYTES - 2) / 4))}`)
    expect(capped).not.toContain('\uFFFD')
  })

  it('drops the first half of a surrogate pair the character cap would split', () => {
    const split = `${'x'.repeat(EMBED_MAX_CHARS - 1)}🙂`
    expect(capEmbedText(split)).toBe('x'.repeat(EMBED_MAX_CHARS - 1))
  })

  it('applies to every buildTextToEmbed rule', () => {
    const cjk = '語'.repeat(EMBED_MAX_CHARS)
    for (const input of [
      { cleanText: cjk },
      { cleanText: cjk, preamble: 'A preamble.' },
      { cleanText: cjk, contextTurns: ['an earlier turn'] },
    ]) {
      expect(bytes(buildTextToEmbed(input))).toBeLessThanOrEqual(EMBED_MAX_UTF8_BYTES)
    }
  })
})
