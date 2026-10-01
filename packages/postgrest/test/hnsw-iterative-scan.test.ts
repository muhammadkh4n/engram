/**
 * A filtered HNSW index scan applies every condition outside the partial
 * index predicate to the ef_search candidate window only, so a narrow filter
 * can return far fewer rows than the LIMIT asked for. The vector RPCs
 * therefore pin an iterative scan (keeps pulling until the LIMIT is filled
 * or max_scan_tuples is reached) in strict distance order, and all of them
 * keep an ef_search floor above the largest requested match count.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function functionSetLines(name: string): string[] {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0)
  const bodyStart = schema.indexOf('AS $$', start)
  expect(bodyStart).toBeGreaterThan(start)
  return schema
    .slice(start, bodyStart)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('SET '))
}

describe('engram_vector_search HNSW settings', () => {
  const setLines = functionSetLines('engram_vector_search')

  it('keeps the ef_search floor above the largest requested match count', () => {
    expect(setLines).toContain("SET hnsw.ef_search TO '150'")
  })

  it('scans iteratively in strict distance order', () => {
    expect(setLines).toContain("SET hnsw.iterative_scan TO 'strict_order'")
  })

  it('bounds the iterative scan at 20000 visited tuples', () => {
    expect(setLines).toContain("SET hnsw.max_scan_tuples TO '20000'")
  })
})

for (const name of ['engram_recall', 'engram_hybrid_recall']) {
  describe(`${name} HNSW settings`, () => {
    const setLines = functionSetLines(name)

    it('keeps the ef_search floor above the largest requested match count', () => {
      expect(setLines).toContain("SET hnsw.ef_search TO '150'")
    })

    it('scans iteratively in strict distance order', () => {
      expect(setLines).toContain("SET hnsw.iterative_scan TO 'strict_order'")
    })

    it('bounds the iterative scan at 20000 visited tuples', () => {
      expect(setLines).toContain("SET hnsw.max_scan_tuples TO '20000'")
    })
  })
}

function functionBody(name: string): string {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0)
  const bodyStart = schema.indexOf('AS $$', start) + 'AS $$'.length
  const bodyEnd = schema.indexOf('$$;', bodyStart)
  return schema.slice(bodyStart, bodyEnd)
}

/** Text of the innermost parenthesised group that encloses `index`, or '' at top level. */
function enclosingGroup(text: string, index: number): string {
  let depth = 0
  for (let open = index - 1; open >= 0; open--) {
    if (text[open] === ')') depth++
    else if (text[open] === '(') {
      if (depth === 0) {
        let inner = 0
        for (let close = open + 1; close < text.length; close++) {
          if (text[close] === '(') inner++
          else if (text[close] === ')') {
            if (inner === 0) return text.slice(open, close + 1)
            inner--
          }
        }
        return text.slice(open)
      }
      depth--
    }
  }
  return ''
}

describe('engram_recall similarity floor', () => {
  const body = functionBody('engram_recall')
  const comparisons = [...body.matchAll(/>=\s*p_min_similarity/g)].map((m) => m.index ?? -1)

  it('applies the floor once per tier', () => {
    expect(comparisons).toHaveLength(4)
  })

  it('filters outside the ordered nearest-N subquery, never inside the index scan', () => {
    for (const index of comparisons) {
      expect(enclosingGroup(body, index)).not.toMatch(/ORDER BY\s+embedding\s*<=>/)
    }
  })
})

describe('pgvector version guard', () => {
  it('rejects pgvector older than 0.8.0 after creating the extension and before any HNSW setting', () => {
    const extension = schema.indexOf('CREATE EXTENSION IF NOT EXISTS vector')
    const guard = schema.indexOf("string_to_array(installed, '.')::int[] < '{0,8,0}'::int[]")
    const firstIterative = schema.indexOf("SET hnsw.iterative_scan")
    expect(extension).toBeGreaterThanOrEqual(0)
    expect(guard).toBeGreaterThan(extension)
    expect(firstIterative).toBeGreaterThan(guard)
    expect(schema.slice(guard, firstIterative)).toMatch(/RAISE EXCEPTION 'pgvector % is installed; engram requires pgvector >= 0\.8\.0\. Run ALTER EXTENSION vector UPDATE/)
  })
})

describe('schema.sql is plain SQL', () => {
  it('holds no psql meta-commands, so any psql client and SQL editors can run it', () => {
    const metaLines = schema
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.startsWith('\\'))
    expect(metaLines).toEqual([])
  })
})
