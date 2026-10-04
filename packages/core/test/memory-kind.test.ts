import { describe, it, expect, expectTypeOf } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MEMORY_KINDS,
  memoryKind,
  isMemoryKind,
  assertMemoryKinds,
  type MemoryKind,
} from '../src/memory-kind.js'
import * as core from '../src/index.js'
import type { MemoryType, SearchOptions } from '../src/types.js'
import type { StorageAdapter } from '../src/adapters/storage.js'

interface KindCase {
  why: string
  tier: MemoryType
  metadata: Record<string, unknown>
  sessionId: string | null
  kind: MemoryKind
}

const casesPath = fileURLToPath(new URL('../src/memory-kind.cases.json', import.meta.url))
const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as KindCase[]

describe('memoryKind', () => {
  it.each(cases.map((c) => [c.why, c] as const))('%s', (_why, c) => {
    expect(memoryKind(c.tier, { metadata: c.metadata, sessionId: c.sessionId })).toBe(c.kind)
  })

  it('has a case for every kind', () => {
    const covered = new Set(cases.map((c) => c.kind))
    expect([...covered].sort()).toEqual([...MEMORY_KINDS].sort())
  })

  it('only names known kinds in the case file', () => {
    for (const c of cases) expect(isMemoryKind(c.kind)).toBe(true)
  })

  it('treats an unknown category as a turn', () => {
    expect(
      memoryKind('episode', {
        metadata: { source: 'hook-capture', salienceCategory: 'not-a-category' },
        sessionId: '0193a1b2-0000-7000-8000-000000000001',
      }),
    ).toBe('turn')
  })

  it('treats missing metadata and session like a tool-ingested row', () => {
    expect(memoryKind('episode', {})).toBe('note')
    expect(memoryKind('episode', { metadata: null, sessionId: 'default' })).toBe('note')
  })
})

describe('MEMORY_KINDS', () => {
  it('lists twelve distinct kinds in rule order', () => {
    expect(MEMORY_KINDS).toEqual([
      'digest', 'fact', 'procedure', 'summary', 'commit', 'ruling',
      'proposal', 'knowledge', 'decision', 'progress', 'note', 'turn',
    ])
    expect(new Set(MEMORY_KINDS).size).toBe(MEMORY_KINDS.length)
  })

  it('agrees with the MemoryKind type', () => {
    expectTypeOf<(typeof MEMORY_KINDS)[number]>().toEqualTypeOf<MemoryKind>()
    expectTypeOf(memoryKind).returns.toEqualTypeOf<MemoryKind>()
  })

  it('is exported from the package entry point', () => {
    expect(core.MEMORY_KINDS).toBe(MEMORY_KINDS)
    expect(core.memoryKind).toBe(memoryKind)
    expect(core.assertMemoryKinds).toBe(assertMemoryKinds)
  })
})

describe('assertMemoryKinds', () => {
  it('accepts a non-empty list of known kinds', () => {
    expect(() => assertMemoryKinds(['decision', 'knowledge'])).not.toThrow()
  })

  it('rejects an empty list instead of treating it as no filter', () => {
    expect(() => assertMemoryKinds([])).toThrow(RangeError)
  })

  it('rejects an unknown kind and names it', () => {
    expect(() => assertMemoryKinds(['decision', 'gossip'])).toThrow(/"gossip"/)
  })
})

describe('search options', () => {
  it('offers the kind filter and session exclusion on vectorSearch and textBoost', () => {
    type VectorOpts = NonNullable<Parameters<StorageAdapter['vectorSearch']>[1]>
    type TextOpts = NonNullable<Parameters<StorageAdapter['textBoost']>[1]>
    const both: VectorOpts & TextOpts = { kinds: ['decision'], excludeSessionId: 'session-under-test' }
    expect(both.kinds).toEqual(['decision'])
    expectTypeOf<VectorOpts['kinds']>().toEqualTypeOf<MemoryKind[] | undefined>()
    expectTypeOf<TextOpts['kinds']>().toEqualTypeOf<MemoryKind[] | undefined>()
    expectTypeOf<VectorOpts['excludeSessionId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<TextOpts['excludeSessionId']>().toEqualTypeOf<string | undefined>()
  })

  it('per-tier search options do not offer filters the tier searches do not apply', () => {
    expectTypeOf<SearchOptions>().not.toHaveProperty('kinds')
    expectTypeOf<SearchOptions>().not.toHaveProperty('excludeSessionId')
  })
})
