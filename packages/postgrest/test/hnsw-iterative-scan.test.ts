/**
 * A filtered HNSW index scan applies every condition outside the partial
 * index predicate to the ef_search candidate window only, so a narrow filter
 * can return far fewer rows than the LIMIT asked for. The vector-search RPC
 * therefore pins an iterative scan (keeps pulling until the LIMIT is filled
 * or max_scan_tuples is reached) in strict distance order, on top of the
 * ef_search floor.
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
