/**
 * The item store tables in schema.sql, read as text. The vocabularies the
 * CHECK constraints enforce must be exactly the lists @engram-mem/core
 * exports, so a value the types allow is never refused by the database and
 * the reverse. Every table must be closed to the API roles except through
 * its own grants: row-level security with the service_role policy, all
 * privileges revoked, then a grant that never includes DELETE or TRUNCATE.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CAPTURE_EVENT_TYPES,
  ENTITY_TYPES,
  ITEM_CLASSES,
  ITEM_KINDS,
  REGISTER_STATUSES,
  SOURCE_TYPES,
  SPEAKERS,
} from '@engram-mem/core'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const turbo = JSON.parse(readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8')) as {
  tasks: Record<string, { env?: string[] }>
}

const ITEM_TABLES = [
  'memory_subjects',
  'memory_extraction_runs',
  'memory_projects',
  'memory_items',
  'memory_item_entities',
  'memory_capture_events',
  'memory_secret_hits',
] as const

/** Tables written once and never updated through the API. */
const APPEND_ONLY = new Set<string>(['memory_item_entities', 'memory_secret_hits'])

function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ')
}

function tableBody(table: string): string {
  const m = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`))
  if (!m) throw new Error(`CREATE TABLE public.${table} not found`)
  return m[1]!
}

/** The expression of a named CHECK, squashed, found by balancing parentheses. */
function checkExpr(table: string, name: string): string {
  const body = tableBody(table)
  const head = `CONSTRAINT ${name} CHECK (`
  const start = body.indexOf(head)
  if (start < 0) throw new Error(`${name} not found in ${table}`)
  let depth = 1
  let quoted = false
  for (let i = start + head.length; i < body.length; i++) {
    const ch = body[i]
    if (ch === "'") quoted = !quoted
    if (quoted) continue
    if (ch === '(') depth++
    if (ch === ')' && --depth === 0) return squash(body.slice(start + head.length, i))
  }
  throw new Error(`${name} has unbalanced parentheses`)
}

/** The table-privilege section: from its heading to the post-apply smoke block. */
function privilegeSection(): string {
  const start = schema.indexOf('-- Item store table privileges')
  const end = schema.indexOf('-- Post-apply smoke')
  if (start < 0 || end < 0 || end < start) throw new Error('item store privilege section not found')
  return schema.slice(start, end)
}

describe('memory_items CHECKs match the core vocabularies', () => {
  it('lists the kinds of each class, in order, in one CASE', () => {
    expect(Object.keys(ITEM_KINDS)).toEqual([...ITEM_CLASSES])
    const branches = ITEM_CLASSES.map((c) => `WHEN '${c}' THEN kind IN (${sqlList(ITEM_KINDS[c])})`)
    expect(checkExpr('memory_items', 'memory_items_kind_check')).toBe(
      `CASE class ${branches.join(' ')} ELSE false END`,
    )
  })

  it('lists exactly the item classes', () => {
    expect(checkExpr('memory_items', 'memory_items_class_check')).toBe(`class IN (${sqlList(ITEM_CLASSES)})`)
  })

  it('lists exactly the source types', () => {
    expect(checkExpr('memory_items', 'memory_items_source_check')).toContain(
      `(source ->> 'type') IN (${sqlList(SOURCE_TYPES)})`,
    )
  })

  it('lets a legacy item carry any of the speakers', () => {
    expect(checkExpr('memory_items', 'memory_items_speaker_check')).toContain(
      `WHEN 'legacy' THEN speaker IN (${sqlList(SPEAKERS)})`,
    )
  })

  it('lists exactly the register statuses', () => {
    expect(checkExpr('memory_items', 'memory_items_register_check')).toContain(
      `register_status IN (${sqlList(REGISTER_STATUSES)})`,
    )
  })

  it('declares every named rule inline in CREATE TABLE', () => {
    const names = [...tableBody('memory_items').matchAll(/CONSTRAINT (\w+) CHECK/g)].map((m) => m[1])
    expect(names).toEqual([
      'memory_items_class_check',
      'memory_items_kind_check',
      'memory_items_speaker_check',
      'memory_items_trust_check',
      'memory_items_assistant_check',
      'memory_items_subject_check',
      'memory_items_statement_lineage_check',
      'memory_items_lineage_self_check',
      'memory_items_supersession_check',
      'memory_items_retired_check',
      'memory_items_forgotten_check',
      'memory_items_embedding_check',
      'memory_items_source_check',
      'memory_items_text_check',
      'memory_items_ids_check',
      'memory_items_content_hash_check',
      'memory_items_register_check',
      'memory_items_mk_decision_check',
    ])
  })
})

describe('satellite CHECKs match the core vocabularies', () => {
  it('lists exactly the capture event types', () => {
    expect(checkExpr('memory_capture_events', 'memory_capture_events_type_check')).toBe(
      `type IN (${sqlList(CAPTURE_EVENT_TYPES)})`,
    )
  })

  it('lists exactly the entity types', () => {
    expect(checkExpr('memory_item_entities', 'memory_item_entities_entity_type_check')).toBe(
      `entity_type IN (${sqlList(ENTITY_TYPES)})`,
    )
  })
})

describe('item store tables are reachable only through their own grants', () => {
  it.each(ITEM_TABLES)('%s has row-level security and the service_role policy', (table) => {
    expect(schema).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`)
    expect(schema).toContain(
      `DROP POLICY IF EXISTS service_role_all ON public.${table};\n` +
        `CREATE POLICY service_role_all ON public.${table} TO service_role USING (true) WITH CHECK (true);`,
    )
  })

  it('places the privilege section after the last item store policy', () => {
    const lastPolicy = Math.max(
      ...ITEM_TABLES.map((t) => schema.indexOf(`CREATE POLICY service_role_all ON public.${t} `)),
    )
    expect(lastPolicy).toBeGreaterThan(0)
    expect(schema.indexOf('-- Item store table privileges')).toBeGreaterThan(lastPolicy)
  })

  it.each(ITEM_TABLES)('%s: all privileges revoked from PUBLIC, service_role, anon and authenticated', (table) => {
    const section = squash(privilegeSection())
    const revokes = [...section.matchAll(/REVOKE ALL ON TABLE ([^;']+?) FROM ([^;']+?)[;']/g)]
    const revokedFrom = new Set<string>()
    for (const [, tables, roles] of revokes) {
      if (tables!.split(',').map((t) => t.trim()).includes(`public.${table}`)) {
        for (const role of roles!.split(',')) revokedFrom.add(role.trim())
      }
    }
    expect([...revokedFrom].sort()).toEqual(['%I', 'PUBLIC', 'service_role'])
    expect(section).toContain("FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::name[]")
  })

  it.each(ITEM_TABLES)('%s: service_role gets exactly its grant', (table) => {
    const grants = [...schema.matchAll(new RegExp(`^GRANT (.+) ON TABLE public\\.${table} TO (\\w+);$`, 'gm'))]
    expect(grants.map((g) => [g[1], g[2]])).toEqual([
      [APPEND_ONLY.has(table) ? 'SELECT, INSERT' : 'SELECT, INSERT, UPDATE', 'service_role'],
    ])
  })

  it.each(ITEM_TABLES)('%s: no statement grants DELETE, TRUNCATE or ALL', (table) => {
    const grants = schema
      .split(';')
      .map(squash)
      .filter((stmt) => /^GRANT\b/.test(stmt) && new RegExp(`public\\.${table}\\b`).test(stmt))
    expect(grants.length).toBeGreaterThan(0)
    for (const stmt of grants) expect(stmt).not.toMatch(/\b(DELETE|TRUNCATE|ALL)\b/)
  })

  it('grants service_role USAGE and SELECT on the two id sequences, after revoking all', () => {
    const section = privilegeSection()
    expect(section).toContain(
      'REVOKE ALL ON SEQUENCE public.memory_capture_events_id_seq, public.memory_secret_hits_id_seq FROM PUBLIC, service_role;',
    )
    expect(section).toContain('GRANT USAGE, SELECT ON SEQUENCE public.memory_capture_events_id_seq TO service_role;')
    expect(section).toContain('GRANT USAGE, SELECT ON SEQUENCE public.memory_secret_hits_id_seq TO service_role;')
  })
})

describe('turbo passes the real-Postgres image variables to tests', () => {
  it('lists both image variables in the test task env', () => {
    expect(turbo.tasks.test?.env).toEqual(
      expect.arrayContaining(['ENGRAM_TEST_PG_IMAGE', 'ENGRAM_TEST_POSTGREST_IMAGE']),
    )
  })
})
