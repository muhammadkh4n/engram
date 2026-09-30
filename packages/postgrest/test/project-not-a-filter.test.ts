/**
 * The recall functions must not exclude rows by project: a project tag only
 * ranks (in the client). p_project_id stays in every signature so existing
 * callers and PostgREST's function lookup keep working, and project_id stays
 * in the returned rows so the client can rank on it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function definition(name: string): { signature: string; body: string } {
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\(([\\s\\S]*?)AS \\$\\$([\\s\\S]*?)\\$\\$;`,
  )
  const m = schema.match(re)
  if (!m) throw new Error(`function ${name} not found in schema.sql`)
  return { signature: m[1]!, body: m[2]! }
}

const RECALL_FUNCTIONS = ['engram_hybrid_recall', 'engram_recall', 'engram_text_boost', 'engram_vector_search']

describe('schema.sql recall functions treat project as a ranking signal', () => {
  it.each(RECALL_FUNCTIONS)('%s never filters on p_project_id', (name) => {
    const { body } = definition(name)
    expect(body).not.toMatch(/p_project_id/)
  })

  it.each(RECALL_FUNCTIONS)('%s keeps p_project_id in its signature', (name) => {
    expect(definition(name).signature).toContain('p_project_id text DEFAULT NULL::text')
  })

  it.each(['engram_hybrid_recall', 'engram_recall', 'engram_vector_search'])(
    '%s still returns project_id',
    (name) => {
      expect(definition(name).signature).toMatch(/RETURNS TABLE\([^)]*\bproject_id text/)
    },
  )
})
