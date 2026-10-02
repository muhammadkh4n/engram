/**
 * engram_association_walk takes an optional list of edge types to skip.
 * Adding a defaulted parameter with CREATE OR REPLACE would leave the old
 * four-argument function in place, and a call naming only the first four
 * arguments would then match both (an ambiguous overload). These checks hold
 * schema.sql to dropping the old signature first, without CASCADE, and to
 * filtering the recursive step on the list.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const code = sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))

const OLD_DROP = 'DROP FUNCTION IF EXISTS public.engram_association_walk(uuid[], integer, double precision, integer);'
const CREATE_RE = /CREATE OR REPLACE FUNCTION public\.engram_association_walk\(([^)]*)\)/

function walkBody(): string {
  const start = code.search(CREATE_RE)
  const open = code.indexOf('AS $$', start)
  const close = code.indexOf('$$;', open + 5)
  return code.slice(open + 5, close)
}

describe('schema.sql engram_association_walk', () => {
  it('is created once, with p_exclude_types text[] DEFAULT NULL as the last parameter', () => {
    const creates = [...code.matchAll(new RegExp(CREATE_RE.source, 'g'))]
    expect(creates).toHaveLength(1)
    const params = creates[0]![1]!.split(',').map((p) => p.trim())
    expect(params).toHaveLength(5)
    expect(params[4]).toBe('p_exclude_types text[] DEFAULT NULL::text[]')
  })

  it('drops the four-argument signature before creating the new one, without CASCADE', () => {
    const drop = code.indexOf(OLD_DROP)
    expect(drop).toBeGreaterThanOrEqual(0)
    expect(drop).toBeLessThan(code.search(CREATE_RE))
    expect(code).not.toMatch(/DROP FUNCTION[^;]*engram_association_walk[^;]*CASCADE/i)
  })

  it('skips edges whose type is in p_exclude_types on every hop', () => {
    const body = walkBody()
    const recursive = body.slice(body.indexOf('UNION ALL'))
    expect(recursive).toMatch(
      /AND \(p_exclude_types IS NULL OR NOT \(a\.edge_type = ANY\(p_exclude_types\)\)\)/,
    )
  })
})
