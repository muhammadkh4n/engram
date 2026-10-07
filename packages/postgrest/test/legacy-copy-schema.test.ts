/**
 * The old memory tables (memory_episodes, memory_digests, memory_semantic)
 * are copied into the item store by engram_legacy_pending and
 * engram_legacy_copy, with engram_legacy_work as the one definition of what a
 * step has left. These checks hold schema.sql to:
 * - the signatures the backfill CLI calls, each created once;
 * - SECURITY DEFINER with a fixed search_path, EXECUTE revoked from PUBLIC,
 *   anon and authenticated and granted to service_role, after the definition;
 * - the five steps in their fixed order;
 * - no write to an old table, and no read of memory_procedural.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const code = sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))

const FUNCTIONS = [
  {
    name: 'engram_legacy_pending',
    params: 'p_step text, p_limit integer DEFAULT 500',
    returns: 'jsonb',
    signature: 'public.engram_legacy_pending(text, integer)',
  },
  {
    name: 'engram_legacy_copy',
    params: 'p_step text, p_project_map jsonb, p_rows jsonb',
    returns: 'jsonb',
    signature: 'public.engram_legacy_copy(text, jsonb, jsonb)',
  },
  {
    name: 'engram_legacy_work',
    params: 'p_step text',
    returns: 'TABLE',
    signature: 'public.engram_legacy_work(text)',
  },
] as const

const OLD_TABLES = ['memory_episodes', 'memory_digests', 'memory_semantic', 'memory_procedural'] as const

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createRe(name: string, flags = ''): RegExp {
  return new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([^)]*)\\) RETURNS (\\w+)`, flags)
}

function definition(name: string): { header: string; body: string; end: number } {
  const start = code.search(createRe(name))
  expect(start).toBeGreaterThanOrEqual(0)
  const open = code.indexOf('AS $$', start)
  const close = code.indexOf('$$;', open + 5)
  return { header: code.slice(start, open), body: code.slice(open + 5, close), end: close }
}

describe('schema.sql legacy copy functions', () => {
  it.each(FUNCTIONS)('creates $name once with the parameters the CLI calls', ({ name, params, returns }) => {
    const creates = [...code.matchAll(createRe(name, 'g'))]
    expect(creates).toHaveLength(1)
    expect(creates[0]![1]!.replace(/\s+/g, ' ').trim()).toBe(params)
    expect(creates[0]![2]).toBe(returns)
  })

  it.each(FUNCTIONS)('runs $name as its owner with a fixed search_path', ({ name }) => {
    const { header } = definition(name)
    expect(header).toMatch(/\bSECURITY DEFINER\b/)
    expect(header).toMatch(/SET search_path TO 'public'/)
  })

  it.each(FUNCTIONS)('grants $name to service_role only, after its definition', ({ name, signature }) => {
    const { end } = definition(name)
    const sig = escape(signature)
    const revokePublic = code.search(new RegExp(`REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC;`))
    const revokeRoles = code.search(new RegExp(`REVOKE EXECUTE ON FUNCTION ${sig} FROM %I'`))
    const grant = code.search(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`))
    for (const at of [revokePublic, revokeRoles, grant]) {
      expect(at).toBeGreaterThan(end)
    }
    expect(code).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO (PUBLIC|anon|authenticated)`))
  })

  it('names the five steps in their fixed order in both entry points', () => {
    for (const name of ['engram_legacy_pending', 'engram_legacy_copy']) {
      expect(definition(name).body).toContain(
        "ARRAY['episodes', 'digests', 'facts', 'fact_supersession', 'forgets']",
      )
    }
  })

  it.each(FUNCTIONS)('never writes an old table and never reads memory_procedural in $name', ({ name }) => {
    const { body } = definition(name)
    for (const table of OLD_TABLES) {
      expect(body).not.toMatch(new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+public\\.${table}\\b`, 'i'))
    }
    expect(body).not.toContain('memory_procedural')
  })
})
