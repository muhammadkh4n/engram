/**
 * The item store tables in schema.sql, read as text. The vocabularies the
 * CHECK constraints enforce must be exactly the lists @engram-mem/core
 * exports, so a value the types allow is never refused by the database and
 * the reverse. Every table must be closed to the API roles except through
 * its own grants: row-level security with the service_role policy, all
 * privileges revoked, then SELECT alone for service_role, which writes
 * through the item RPCs only.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CAPTURE_EVENT_TYPES,
  ENTITY_TYPES,
  ITEM_CLASSES,
  ITEM_INVARIANTS,
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
  'memory_item_links',
  'memory_capture_events',
  'memory_secret_hits',
  'memory_item_actions',
] as const

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
      'memory_items_finite_check',
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

  it.each(ITEM_TABLES)('%s: service_role gets SELECT and nothing else', (table) => {
    const grants = [...schema.matchAll(new RegExp(`^GRANT (.+) ON TABLE public\\.${table} TO (\\w+);$`, 'gm'))]
    expect(grants.map((g) => [g[1], g[2]])).toEqual([['SELECT', 'service_role']])
  })

  it.each(ITEM_TABLES)('%s: no statement grants INSERT, UPDATE, DELETE, TRUNCATE or ALL', (table) => {
    const grants = schema
      .split(';')
      .map(squash)
      .filter((stmt) => /^GRANT\b/.test(stmt) && new RegExp(`public\\.${table}\\b`).test(stmt))
    expect(grants.length).toBeGreaterThan(0)
    for (const stmt of grants) expect(stmt).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/)
  })

  it('revokes all on the four id sequences and grants nothing back', () => {
    const section = privilegeSection()
    expect(section).toContain(
      'REVOKE ALL ON SEQUENCE public.memory_capture_events_id_seq, public.memory_secret_hits_id_seq, public.memory_item_links_id_seq, public.memory_item_actions_id_seq FROM PUBLIC, service_role;',
    )
    expect(schema).not.toMatch(/GRANT [^;]* ON SEQUENCE public\.memory_(capture_events|secret_hits|item_links|item_actions)_id_seq/)
  })
})

const TRIGGERS = [
  [
    'memory_items_before_insert',
    'CREATE TRIGGER memory_items_before_insert BEFORE INSERT ON public.memory_items FOR EACH ROW EXECUTE FUNCTION public.memory_items_before_insert();',
  ],
  [
    'memory_items_before_update',
    'CREATE TRIGGER memory_items_before_update BEFORE UPDATE ON public.memory_items FOR EACH ROW EXECUTE FUNCTION public.memory_items_before_update();',
  ],
  [
    'memory_items_lineage',
    'CREATE CONSTRAINT TRIGGER memory_items_lineage AFTER INSERT ON public.memory_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (cardinality(NEW.lineage) > 0) EXECUTE FUNCTION public.memory_items_lineage();',
  ],
  [
    'memory_items_supersession',
    'CREATE CONSTRAINT TRIGGER memory_items_supersession AFTER UPDATE OF superseded_by ON public.memory_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.superseded_by IS NOT NULL) EXECUTE FUNCTION public.memory_items_supersession();',
  ],
  [
    'memory_items_forget_cascade',
    'CREATE TRIGGER memory_items_forget_cascade AFTER UPDATE OF forgotten_at ON public.memory_items FOR EACH ROW WHEN (OLD.forgotten_at IS NULL AND NEW.forgotten_at IS NOT NULL) EXECUTE FUNCTION public.memory_items_forget_cascade();',
  ],
] as const

const TRIGGER_NAMES = TRIGGERS.map(([name]) => name)

/** The body of a function definition, from its CREATE to the closing `$$;`. */
function functionDefinition(name: string): string {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  if (start < 0) throw new Error(`function public.${name} not found`)
  const end = schema.indexOf('$$;', start)
  return schema.slice(start, end + 3)
}

describe('memory_items triggers', () => {
  it.each(TRIGGERS)('%s is dropped and created again on every apply', (name, create) => {
    expect(squash(schema)).toContain(`DROP TRIGGER IF EXISTS ${name} ON public.memory_items; ${create}`)
  })

  it('creates exactly these triggers on memory_items, each once', () => {
    const created = [...schema.matchAll(/^CREATE (?:CONSTRAINT )?TRIGGER (\w+) .*? ON public\.memory_items /gm)].map((m) => m[1])
    expect(created).toEqual(TRIGGER_NAMES)
  })

  it.each(TRIGGER_NAMES)('%s runs a SECURITY DEFINER plpgsql function with a fixed search_path', (name) => {
    expect(squash(functionDefinition(name))).toMatch(
      new RegExp(
        `^CREATE OR REPLACE FUNCTION public\\.${name}\\(\\) RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \\$\\$`,
      ),
    )
  })

  /** The triggers that refuse writes; the other two only fill or cascade. */
  const REFUSING = ['memory_items_before_update', 'memory_items_lineage', 'memory_items_supersession'] as const

  it.each(REFUSING)('%s refuses with check_violation and its own name, never row data', (name) => {
    const body = functionDefinition(name)
    const raises = [...body.matchAll(/RAISE EXCEPTION([\s\S]*?);/g)].map((m) => squash(m[1]!))
    expect(raises.length).toBeGreaterThan(0)
    for (const raise of raises) {
      // The only interpolation besides the trigger name is the list of column names.
      expect(raise).toMatch(
        /^USING ERRCODE = 'check_violation', MESSAGE = format\('%s: (?:[^%']+', TG_NAME|%s cannot change after insert', TG_NAME, array_to_string\(v_changed, ', '\))\)$/,
      )
    }
  })

  it('defers only the lineage and supersession checks', () => {
    const deferred = [...schema.matchAll(/^CREATE CONSTRAINT TRIGGER (\w+) [^;]*\bDEFERRABLE\b[^;]*;$/gm)].map((m) => m[1])
    expect(deferred).toEqual(['memory_items_lineage', 'memory_items_supersession'])
  })

  // A deferred check runs at commit, after later statements of the same
  // transaction may have forgotten the row or moved its pointer. It must judge
  // the row as it stands then: re-read it by id before anything else, return
  // when it is gone or forgotten, and read nothing else from the queued event.
  it.each(['memory_items_lineage', 'memory_items_supersession'])(
    '%s re-reads its row at commit and lets a forgotten row pass before any refusal',
    (name) => {
      const body = squash(functionDefinition(name))
      const begin = body.indexOf(' BEGIN ')
      const reread = body.slice(begin).match(
        /^ BEGIN SELECT [^;]*\bi\.forgotten_at INTO v_item FROM public\.memory_items i WHERE i\.id = NEW\.id; IF NOT FOUND OR (?:[^;]*? OR )?v_item\.forgotten_at IS NOT NULL THEN RETURN NULL; END IF;/,
      )
      expect(reread).not.toBeNull()
      expect([...body.matchAll(/\bNEW\.(\w+)/g)].map((m) => m[1])).toEqual(['id'])
    },
  )

  it('defines the trigger functions and triggers after the item store tables and before row security', () => {
    const lastTable = schema.indexOf('CREATE TABLE IF NOT EXISTS public.memory_secret_hits')
    const firstFunction = Math.min(...TRIGGER_NAMES.map((n) => schema.indexOf(`CREATE OR REPLACE FUNCTION public.${n}(`)))
    const lastTrigger = Math.max(...TRIGGER_NAMES.map((n) => schema.indexOf(`TRIGGER ${n} `)))
    const firstRowSecurity = schema.indexOf('ENABLE ROW LEVEL SECURITY;')
    expect(lastTable).toBeGreaterThan(0)
    expect(firstFunction).toBeGreaterThan(lastTable)
    expect(lastTrigger).toBeGreaterThan(firstFunction)
    expect(firstRowSecurity).toBeGreaterThan(lastTrigger)
  })

  it('grants no role EXECUTE on a trigger function', () => {
    for (const name of TRIGGER_NAMES) {
      expect(schema).toContain(`REVOKE EXECUTE ON FUNCTION public.${name}() FROM PUBLIC;`)
      expect(schema).not.toMatch(new RegExp(`GRANT [^;]*public\\.${name}\\(`))
    }
    expect(schema).not.toContain('this file defines no trigger functions')
  })
})

describe('engram_norm_quote', () => {
  const definition = squash(functionDefinition('engram_norm_quote'))

  it('is an inlinable, immutable, parallel-safe SQL function', () => {
    expect(definition).toMatch(
      /^CREATE OR REPLACE FUNCTION public\.engram_norm_quote\(p_text text\) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS \$\$/,
    )
    expect(definition).not.toMatch(/\bSET\b/)
  })

  it('calls pg_catalog functions only, each schema-qualified', () => {
    const calls = [...definition.matchAll(/([\w.]+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'public.engram_norm_quote')
    expect(calls).toEqual([
      'pg_catalog.btrim',
      'pg_catalog.regexp_replace',
      'pg_catalog.translate',
      'pg_catalog.normalize',
    ])
  })

  it('is written in ASCII, every special character as an escape', () => {
    expect(functionDefinition('engram_norm_quote')).toMatch(/^[\x09\x0a\x20-\x7e]*$/)
  })
})

describe('turbo passes the real-Postgres image variables to tests', () => {
  it('lists both image variables in the test task env', () => {
    expect(turbo.tasks.test?.env).toEqual(
      expect.arrayContaining(['ENGRAM_TEST_PG_IMAGE', 'ENGRAM_TEST_POSTGREST_IMAGE']),
    )
  })
})

const ITEM_RPCS = [
  ['engram_insert_items', '(p_items jsonb) RETURNS TABLE(ord integer, id uuid, inserted boolean) LANGUAGE plpgsql'],
  ['engram_forget_items', '(p_ids uuid[], p_reason text) RETURNS TABLE(item_id uuid, effect text, via uuid) LANGUAGE plpgsql'],
  ['engram_retire_items', '(p_ids uuid[], p_reason text) RETURNS SETOF uuid LANGUAGE plpgsql'],
  ['engram_unretire_items', '(p_ids uuid[]) RETURNS SETOF uuid LANGUAGE plpgsql'],
  ['engram_supersede_item', '(p_old uuid, p_new uuid) RETURNS boolean LANGUAGE plpgsql'],
  ['engram_invariant_counts', '() RETURNS TABLE(name text, violations bigint) LANGUAGE sql STABLE'],
  [
    'engram_forget_memories',
    '(p_ids uuid[], p_reason text, p_channel text) RETURNS TABLE(id uuid, store text, kind text, requested boolean, via uuid, effect text) LANGUAGE plpgsql',
  ],
  ['engram_retire_memories', '(p_ids uuid[], p_reason text, p_channel text) RETURNS TABLE(id uuid, outcome text, register_ref text) LANGUAGE plpgsql'],
  ['engram_unretire_memories', '(p_ids uuid[], p_reason text, p_channel text) RETURNS TABLE(id uuid, outcome text, register_ref text) LANGUAGE plpgsql'],
] as const

const ITEM_RPC_NAMES = ITEM_RPCS.map(([name]) => name)

/** Columns an insert may not set: the database or a later write owns them. */
const NOT_INSERT_COLUMNS = [
  'superseded_by',
  'valid_to',
  'restated_at',
  'retired_at',
  'retired_reason',
  'forgotten_at',
  'forgotten_reason',
  'content_hash',
  'created_at',
]

describe('item store RPCs', () => {
  it.each(ITEM_RPCS)('%s is SECURITY DEFINER with a fixed search_path', (name, signature) => {
    expect(squash(functionDefinition(name))).toContain(
      `CREATE OR REPLACE FUNCTION public.${name}${signature} SECURITY DEFINER SET search_path TO 'public' AS $$`,
    )
  })

  it('defines them after the triggers and before row security', () => {
    const lastTrigger = Math.max(...TRIGGER_NAMES.map((n) => schema.indexOf(`TRIGGER ${n} `)))
    const offsets = ITEM_RPC_NAMES.map((n) => schema.indexOf(`CREATE OR REPLACE FUNCTION public.${n}(`))
    expect(Math.min(...offsets)).toBeGreaterThan(lastTrigger)
    expect(schema.indexOf('ENABLE ROW LEVEL SECURITY;')).toBeGreaterThan(Math.max(...offsets))
  })

  // engram_insert_items may also raise internal_error, for a guard on a state
  // its own statements cannot produce; the format argument is a position.
  it.each(ITEM_RPC_NAMES)('%s raises only 22023, 23514 or its guard error, its own name first, never a value', (name) => {
    const codes = name === 'engram_insert_items' ? 'invalid_parameter_value|check_violation|internal_error' : 'invalid_parameter_value|check_violation'
    const raises = [...functionDefinition(name).matchAll(/RAISE EXCEPTION([\s\S]*?);/g)].map((m) => squash(m[1]!))
    if (name === 'engram_invariant_counts') {
      expect(raises).toEqual([])
      return
    }
    expect(raises.length).toBeGreaterThan(0)
    for (const raise of raises) {
      expect(raise).toMatch(
        new RegExp(
          `^USING ERRCODE = '(${codes})', MESSAGE = (format\\()?'${name}: [^']*'( \\|\\| v_problem|, v_(count|missing)\\))?$`,
        ),
      )
    }
  })

  it('engram_insert_items accepts exactly the insert columns of memory_items, and inserts them all', () => {
    const columns = [...tableBody('memory_items').matchAll(/^ {4}(\w+) /gm)]
      .map((m) => m[1]!)
      .filter((c) => c !== 'CONSTRAINT')
    const insertColumns = columns.filter((c) => !NOT_INSERT_COLUMNS.includes(c))
    expect(columns).toEqual(expect.arrayContaining(NOT_INSERT_COLUMNS))
    const body = functionDefinition('engram_insert_items')
    const accepted = [...body.matchAll(/\('(\w+)', '(?:string|number|boolean|array|object)', /g)].map((m) => m[1])
    expect(accepted).toEqual(insertColumns)
    const target = body.match(/INSERT INTO public\.memory_items AS m \(([^)]*)\)/)
    expect(target).not.toBeNull()
    expect(squash(target![1]!).split(', ')).toEqual(insertColumns)
    expect(squash(body)).toContain(
      "ON CONFLICT ((source ->> 'event_key')) WHERE (source ? 'event_key') DO NOTHING",
    )
  })

  it('engram_invariant_counts reports the core invariants, in order', () => {
    const names = [...functionDefinition('engram_invariant_counts').matchAll(/^ {6}\((\d), '(\w+)', \(/gm)]
    expect(names.map((m) => Number(m[1]))).toEqual(ITEM_INVARIANTS.map((_, i) => i + 1))
    expect(names.map((m) => m[2])).toEqual([...ITEM_INVARIANTS])
  })

  it('the post-apply smoke calls the read-only item RPCs on the nil uuid', () => {
    const start = schema.indexOf('DO $smoke$')
    const smoke = schema.slice(start, schema.indexOf('$smoke$;', start))
    const nil = "ARRAY['00000000-0000-0000-0000-000000000000']::uuid[]"
    expect(smoke).toContain('PERFORM * FROM public.engram_invariant_counts();')
    expect(smoke).toContain(`PERFORM * FROM public.engram_forget_items(${nil}, 'smoke');`)
    expect(smoke).toContain(`PERFORM * FROM public.engram_retire_items(${nil}, 'smoke');`)
    expect(smoke).toContain(`PERFORM * FROM public.engram_unretire_items(${nil});`)
    for (const name of ['engram_forget_memories', 'engram_retire_memories', 'engram_unretire_memories']) {
      expect(smoke).toContain(`PERFORM * FROM public.${name}(${nil}, 'smoke', 'smoke');`)
    }
  })
})

describe('valid_to is derived from superseded_by', () => {
  const DERIVE = 'NEW.valid_to := (SELECT i.occurred_at FROM public.memory_items i WHERE i.id = NEW.superseded_by);'

  it('ties valid_to to superseded_by in memory_items_supersession_check', () => {
    expect(checkExpr('memory_items', 'memory_items_supersession_check')).toContain(
      '(superseded_by IS NULL) = (valid_to IS NULL)',
    )
  })

  it('starts it NULL on every insert, and derives it on an update that touches either column', () => {
    expect(squash(functionDefinition('memory_items_before_insert'))).toContain('NEW.valid_to := NULL;')
    expect(squash(functionDefinition('memory_items_before_update'))).toContain(
      `IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by OR NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN ${DERIVE} END IF;`,
    )
  })

  it.each(['engram_insert_items', 'engram_supersede_item', 'memory_items_forget_cascade'])(
    '%s never writes valid_to',
    (name) => {
      expect(functionDefinition(name)).not.toMatch(/valid_to/)
    },
  )
})

describe('the pending-embedding index', () => {
  it('holds exactly the rows engram_items_pending_embedding selects: the predicates match word for word', () => {
    const index = schema.match(
      /CREATE INDEX IF NOT EXISTS idx_items_pending_embedding ON public\.memory_items USING btree \(created_at, id\) WHERE \((.*)\);/,
    )
    if (!index) throw new Error('idx_items_pending_embedding not found')
    const fn = schema.match(
      /FUNCTION public\.engram_items_pending_embedding\(p_limit integer DEFAULT 32\)[\s\S]*?FROM public\.memory_items i\s+WHERE ([\s\S]*?)\s+ORDER BY i\.created_at, i\.id/,
    )
    if (!fn) throw new Error('engram_items_pending_embedding WHERE not found')
    const predicate = squash(index[1]!)
    expect(squash(fn[1]!)).toBe(predicate)
    for (const clause of [
      'embedding IS NULL',
      'forgotten_at IS NULL',
      'embedding_attempts < 5',
      "NOT (class = 'utterance' AND speaker = 'assistant')",
      "class <> 'legacy'",
    ]) {
      expect(predicate).toContain(clause)
    }
  })
})
