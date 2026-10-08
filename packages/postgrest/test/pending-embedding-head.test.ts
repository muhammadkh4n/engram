/**
 * engram_items_pending_embedding returns the head of each search text, cut
 * in SQL to EMBED_MAX_CHARS characters: the embed text builder never keeps
 * more than that many UTF-16 units, and a PostgreSQL character is at least
 * one unit, so the head always holds everything that is embedded. The SQL
 * literal cannot import the constant; this test keeps the two equal.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EMBED_MAX_CHARS } from '@engram-mem/core'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function functionBody(name: string): string {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = schema.indexOf('END; $$;', start)
  expect(end).toBeGreaterThan(start)
  return schema.slice(start, end)
}

describe('the pending embedding read', () => {
  const body = functionBody('engram_items_pending_embedding')

  it('cuts search_text to EMBED_MAX_CHARS characters', () => {
    const cuts = [...body.matchAll(/left\(m\.search_text,\s*(\d+)\)/g)].map((m) => Number(m[1]))
    expect(cuts).toEqual([EMBED_MAX_CHARS])
  })

  it('returns no uncut search_text', () => {
    expect(body.replace(/left\(m\.search_text,\s*\d+\)/g, '')).not.toMatch(/\bm\.search_text\b/)
  })
})
