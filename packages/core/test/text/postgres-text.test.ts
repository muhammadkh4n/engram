import { describe, expect, it } from 'vitest'
import { PostgresTextKeyCollision, findPostgresUnsafeText, toPostgresText } from '../../src/text/postgres-text.js'

const R = '�'

describe('toPostgresText', () => {
  it('replaces U+0000 and unpaired surrogates in strings and keeps a valid pair', () => {
    expect(toPostgresText('a\u0000b')).toBe(`a${R}b`)
    expect(toPostgresText('abc\ud83d')).toBe(`abc${R}`)
    expect(toPostgresText('\udc00x')).toBe(`${R}x`)
    expect(toPostgresText('\ud83d😀')).toBe(`${R}😀`)
    expect(toPostgresText('😀')).toBe('😀')
    expect(toPostgresText('plain text')).toBe('plain text')
  })

  it('copies arrays and objects, replacing in every string and key, and leaves the input unchanged', () => {
    const input = { text: 'x\u0000', list: ['\ud800', 2, null, true], nested: { 'k\udfff': { deep: 'ok' } } }
    const copy = toPostgresText(input)
    expect(copy).toEqual({ text: `x${R}`, list: [R, 2, null, true], nested: { [`k${R}`]: { deep: 'ok' } } })
    expect(input.text).toBe('x\u0000')
    expect(Object.keys(input.nested)).toEqual(['k\udfff'])
  })

  it('keeps a __proto__ key an own property', () => {
    const input = JSON.parse('{"__proto__": "a\\u0000"}') as Record<string, unknown>
    const copy = toPostgresText(input)
    expect(Object.hasOwn(copy, '__proto__')).toBe(true)
    expect(copy['__proto__']).toBe(`a${R}`)
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
  })

  it('throws a collision naming the object when two keys become equal', () => {
    const input = { payload: { answers: { 'zebra\u0000': 'a', [`zebra${R}`]: 'b' } } }
    let thrown: unknown
    try {
      toPostgresText(input)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PostgresTextKeyCollision)
    expect((thrown as PostgresTextKeyCollision).path).toBe('payload.answers')
    expect((thrown as Error).message).not.toContain('zebra')
  })
})

describe('findPostgresUnsafeText', () => {
  it('returns null for safe values, valid pairs included', () => {
    expect(findPostgresUnsafeText({ a: ['😀', 1, null], b: { c: 'text' } })).toBeNull()
    expect(findPostgresUnsafeText(42)).toBeNull()
  })

  it('names the path of the first unsafe string or key, never its text', () => {
    expect(findPostgresUnsafeText({ content: 'a\u0000' })).toBe('content')
    expect(findPostgresUnsafeText({ source: { tools: [{ ref: 'ok' }, { ref: '\ud83d' }] } })).toBe('source.tools[1].ref')
    expect(findPostgresUnsafeText({ source: { 'secret words': 'x\u0000' } })).toBe('source[#0]')
    expect(findPostgresUnsafeText({ source: { ok: 1, 'k\u0000': 'v' } })).toBe('source[#1] key')
    expect(findPostgresUnsafeText('\udc00')).toBe('')
  })
})
