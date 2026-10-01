/**
 * PostgREST serves schema public and runs a request without a JWT as the
 * anon role, and Postgres grants EXECUTE on every new function to PUBLIC.
 * The engram_* functions are SECURITY DEFINER, so any of them left with the
 * default grant is an unauthenticated /rpc endpoint that reads memory content
 * or writes memory state. These checks hold schema.sql and bm25.sql to:
 * - every function the file creates has EXECUTE revoked from PUBLIC, and
 *   from anon and authenticated inside a block guarded on pg_roles;
 * - every RPC function (anything but a trigger function) is granted to
 *   service_role explicitly, since a database without default privileges
 *   would otherwise leave the service unable to call it;
 * - the privilege statements follow the function's definition, so a
 *   function that the file drops and re-creates gets them back on re-apply.
 * The function list is derived from the CREATE FUNCTION statements, so a new
 * function added without its privilege statements fails here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

interface CreatedFunction {
  signature: string
  isTrigger: boolean
  offset: number
}

const FILES = ['schema.sql', 'bm25.sql'] as const

function read(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

function normalize(signature: string): string {
  return signature.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ', ').trim()
}

/** `p_ids uuid[]` / `p_x text DEFAULT NULL::text` -> the argument type. */
function argType(param: string): string {
  const withoutDefault = param.replace(/\s+DEFAULT\s+[\s\S]*$/i, '').trim()
  const [, ...type] = withoutDefault.split(/\s+/)
  return type.join(' ')
}

function createdFunctions(sql: string): CreatedFunction[] {
  const code = stripComments(sql)
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(public\.\w+)\s*\(([^)]*)\)\s+RETURNS\s+(\w+)/gi
  return [...code.matchAll(re)].map((m) => {
    const params = m[2]!.trim() === '' ? [] : m[2]!.split(',').map(argType)
    return {
      signature: normalize(`${m[1]}(${params.join(', ')})`),
      isTrigger: m[3]!.toLowerCase() === 'trigger',
      offset: m.index!,
    }
  })
}

function statementOffsets(sql: string, re: RegExp): Map<string, number> {
  const code = stripComments(sql)
  const found = new Map<string, number>()
  for (const m of code.matchAll(re)) found.set(normalize(m[1]!), m.index!)
  return found
}

const revokedFromPublic = (sql: string) =>
  statementOffsets(sql, /^REVOKE EXECUTE ON FUNCTION (public\.\w+\([^)]*\)) FROM PUBLIC;$/gm)

const grantedToServiceRole = (sql: string) =>
  statementOffsets(sql, /^GRANT EXECUTE ON FUNCTION (public\.\w+\([^)]*\)) TO service_role;$/gm)

/** Signatures revoked from anon/authenticated inside a pg_roles-guarded DO block. */
function revokedFromApiRoles(sql: string): Map<string, number> {
  const code = stripComments(sql)
  const found = new Map<string, number>()
  const blocks = /DO \$\$([\s\S]*?)\$\$;/g
  for (const block of code.matchAll(blocks)) {
    const body = block[1]!
    if (!/ARRAY\['anon', 'authenticated'\]::name\[\]/.test(body)) continue
    if (!/IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = role_name\) THEN/.test(body)) continue
    const stmt = /EXECUTE format\('REVOKE EXECUTE ON FUNCTION (public\.\w+\([^)]*\)) FROM %I', role_name\);/g
    for (const m of body.matchAll(stmt)) found.set(normalize(m[1]!), block.index!)
  }
  return found
}

describe.each(FILES)('%s function privileges', (file) => {
  const sql = read(file)
  const functions = createdFunctions(sql)

  it('parses every CREATE FUNCTION statement in the file', () => {
    const statements = stripComments(sql).match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi) ?? []
    expect(functions.length).toBeGreaterThan(0)
    expect(functions).toHaveLength(statements.length)
  })

  it('revokes EXECUTE from PUBLIC on every function it creates, after its definition', () => {
    const revoked = revokedFromPublic(sql)
    for (const fn of functions) {
      expect(revoked.has(fn.signature), `${fn.signature} has no REVOKE ... FROM PUBLIC`).toBe(true)
      expect(revoked.get(fn.signature)!).toBeGreaterThan(fn.offset)
    }
  })

  it('revokes EXECUTE from anon and authenticated where those roles exist', () => {
    const revoked = revokedFromApiRoles(sql)
    for (const fn of functions) {
      expect(revoked.has(fn.signature), `${fn.signature} is not revoked from anon/authenticated`).toBe(true)
      expect(revoked.get(fn.signature)!).toBeGreaterThan(fn.offset)
    }
  })

  it('grants EXECUTE to service_role on every RPC function, after its definition', () => {
    const granted = grantedToServiceRole(sql)
    for (const fn of functions.filter((f) => !f.isTrigger)) {
      expect(granted.has(fn.signature), `${fn.signature} has no GRANT ... TO service_role`).toBe(true)
      expect(granted.get(fn.signature)!).toBeGreaterThan(fn.offset)
    }
  })

  it('names only functions the file creates in its privilege statements', () => {
    const created = new Set(functions.map((f) => f.signature))
    const named = [
      ...revokedFromPublic(sql).keys(),
      ...grantedToServiceRole(sql).keys(),
      ...revokedFromApiRoles(sql).keys(),
    ]
    for (const signature of named) expect(created, signature).toContain(signature)
  })

  it('grants EXECUTE to no role but service_role', () => {
    const grants = stripComments(sql).match(/GRANT\s+EXECUTE[^;]*;/gi) ?? []
    for (const grant of grants) expect(grant).toMatch(/ TO service_role;$/)
  })
})

describe('schema.sql privilege section placement', () => {
  it('follows the last function definition', () => {
    const sql = read('schema.sql')
    const lastCreate = Math.max(...createdFunctions(sql).map((f) => f.offset))
    const firstRevoke = Math.min(...revokedFromPublic(sql).values())
    expect(firstRevoke).toBeGreaterThan(lastCreate)
  })
})
