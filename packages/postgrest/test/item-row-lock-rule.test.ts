/**
 * One lock rule for memory_items, read from schema.sql as text.
 *
 * Two transactions that lock the same existing rows in different orders can
 * deadlock. Each writer orders its own row locks, but a forget walks lineage
 * in passes, a lineage check locks rows FOR SHARE in insertion order, and a
 * retire or supersede locks in id order, so no single row order serves them
 * all. The advisory key 7308892986227385959 does instead:
 * - every engram_* function that locks existing memory_items rows (a locking
 *   clause, an UPDATE or DELETE, an ON CONFLICT DO UPDATE) takes the key
 *   exclusively, at transaction level, before its first row lock;
 * - every writer that adds rows carrying lineage takes the key shared before
 *   the INSERT, so it runs beside other inserts and never beside a function
 *   that locks rows; a function that also locks rows holds the key
 *   exclusively, which covers its inserts as well;
 * - a trigger function that locks rows runs inside a statement that already
 *   holds the key, and the test checks how for each one. A trigger function
 *   the test does not know fails until its cover is decided and listed here.
 * The function list is derived from schema.sql, so a new function that locks
 * item rows without the key fails this suite.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const KEY = '7308892986227385959'
const EXCLUSIVE = `pg_advisory_xact_lock(${KEY})`
const SHARED = `pg_advisory_xact_lock_shared(${KEY})`

interface SqlFunction {
  name: string
  isTrigger: boolean
  body: string
}

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

const code = stripComments(schema)

function functions(): SqlFunction[] {
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\([^)]*\)\s+RETURNS\s+([\s\S]*?)\bAS\s+\$\$([\s\S]*?)\$\$;/gi
  return [...code.matchAll(re)].map((m) => ({
    name: m[1]!,
    isTrigger: /^trigger\b/i.test(m[2]!.trim()),
    body: squash(m[3]!),
  }))
}

/**
 * memory_items as PL/pgSQL may spell it: with or without the schema, after
 * ONLY, in any letter case, or as a quoted identifier. Every pattern below is
 * case-insensitive and built on this one, so no spelling escapes the rule.
 */
const TABLE = String.raw`(?:\bONLY\s+)?(?:(?:\bpublic|"public")\s*\.\s*)?(?:\bmemory_items|"memory_items")(?![\w$"])`
const MEMORY_ITEMS = new RegExp(TABLE, 'i')
const LOCKING_CLAUSE =
  /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b(?:\s+OF\s+[\w".]+(?:\s*,\s*[\w".]+)*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?/gi
const WRITE_STATEMENT = new RegExp(String.raw`\b(?:UPDATE|DELETE\s+FROM)\s+` + TABLE, 'gi')
const UPSERT = new RegExp(String.raw`\bINSERT\s+INTO\s+` + TABLE + String.raw`[^;]*?\bON\s+CONFLICT\b[^;]*?\bDO\s+UPDATE\b`, 'gi')
const INSERT = new RegExp(String.raw`\bINSERT\s+INTO\s+` + TABLE, 'i')
const SUPERSESSION_WRITE = new RegExp(String.raw`\bUPDATE\s+` + TABLE + String.raw`[^;]*\bSET\b[^;]*\b"?superseded_by"?\s*=`, 'i')

/** Where the statement holding a locking clause starts: after the previous statement end or the last BEGIN. */
function statementStart(body: string, at: number): number {
  const before = body.slice(0, at)
  const lastBegin = [...before.matchAll(/\bBEGIN\b/gi)].pop()?.index ?? -1
  return Math.max(before.lastIndexOf(';') + 1, lastBegin < 0 ? 0 : lastBegin + 'BEGIN'.length)
}

/** Offsets of every statement in a body that locks existing memory_items rows. */
function rowLocks(body: string): number[] {
  const clauses = [...body.matchAll(LOCKING_CLAUSE)]
    .map((m) => statementStart(body, m.index!))
    .filter((start, i, starts) => starts.indexOf(start) === i)
    .filter((start) => MEMORY_ITEMS.test(body.slice(start, body.indexOf(';', start) < 0 ? undefined : body.indexOf(';', start))))
  const writes = [...body.matchAll(WRITE_STATEMENT)].map((m) => m.index!)
  const upserts = [...body.matchAll(UPSERT)].map((m) => m.index!)
  return [...clauses, ...writes, ...upserts].sort((a, b) => a - b)
}

/** Why a body breaks the exclusive-key rule, or null when it keeps it. */
function exclusiveRuleViolation(name: string, body: string): string | null {
  const firstLock = rowLocks(body)[0]
  if (firstLock === undefined) return null
  const exclusiveAt = body.indexOf(EXCLUSIVE)
  if (exclusiveAt < 0) return `${name} never takes ${EXCLUSIVE}`
  if (exclusiveAt > firstLock) return `${name} locks a row before ${EXCLUSIVE}`
  if (body.includes(SHARED)) return `${name} also takes the key shared`
  return null
}

const all = functions()
const lockers = all.filter((f) => rowLocks(f.body).length > 0)

function fn(name: string): SqlFunction {
  const found = all.find((f) => f.name === name)
  if (!found) throw new Error(`function public.${name} not found`)
  return found
}

/** The squashed CREATE TRIGGER statement of a trigger on memory_items. */
function trigger(name: string): string {
  const m = code.match(new RegExp(`CREATE (?:CONSTRAINT )?TRIGGER ${name} [^;]*;`))
  if (!m) throw new Error(`trigger ${name} not found`)
  return squash(m[0])
}

/**
 * How each row-locking trigger function is covered by the key. Each check
 * reads the schema, so a cover that stops holding fails here.
 */
const TRIGGER_COVERS: Record<string, () => void> = {
  // Fires after an INSERT of a row with lineage; the BEFORE INSERT trigger of
  // that same row takes the key shared first, for every writer.
  memory_items_lineage: () => {
    expect(trigger('memory_items_lineage')).toMatch(/AFTER INSERT ON public\.memory_items .*WHEN \(cardinality\(NEW\.lineage\) > 0\)/)
    expect(fn('memory_items_before_insert').body).toContain(
      `IF cardinality(NEW.lineage) > 0 THEN PERFORM ${SHARED}; END IF;`,
    )
  },
  // Fires after an UPDATE of superseded_by. Every function that writes
  // superseded_by is either an engram_* function under the exclusive key or
  // the forget cascade, which runs only inside a forget.
  memory_items_supersession: () => {
    expect(trigger('memory_items_supersession')).toMatch(/AFTER UPDATE OF superseded_by ON public\.memory_items /)
    const writers = all
      .filter((f) => SUPERSESSION_WRITE.test(f.body))
      .map((f) => f.name)
    for (const writer of writers) {
      expect(writer === 'memory_items_forget_cascade' || writer.startsWith('engram_'), writer).toBe(true)
    }
  },
  // Fires when forgotten_at is set, which the BEFORE UPDATE trigger allows
  // only in a transaction marked by engram_forget_items after it took the
  // key exclusively.
  memory_items_forget_cascade: () => {
    expect(trigger('memory_items_forget_cascade')).toMatch(/AFTER UPDATE OF forgotten_at ON public\.memory_items /)
    expect(fn('memory_items_before_update').body).toMatch(
      /current_setting\('engram\.forget_lock_xact', true\) IS DISTINCT FROM pg_catalog\.txid_current\(\)::text/,
    )
    const markers = all.filter((f) => f.body.includes(`set_config('engram.forget_lock_xact'`)).map((f) => f.name)
    expect(markers).toEqual(['engram_forget_items'])
    const forget = fn('engram_forget_items').body
    expect(forget.indexOf(EXCLUSIVE)).toBeGreaterThanOrEqual(0)
    expect(forget.indexOf(EXCLUSIVE)).toBeLessThan(forget.indexOf(`set_config('engram.forget_lock_xact'`))
  },
}

describe('the forget advisory key orders every row lock on memory_items', () => {
  it('finds the row-locking functions it is meant to check', () => {
    expect(lockers.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'engram_forget_items',
        'engram_retire_items',
        'engram_unretire_items',
        'engram_supersede_item',
        'memory_items_lineage',
        'memory_items_supersession',
        'memory_items_forget_cascade',
      ]),
    )
  })

  it.each(lockers.filter((f) => !f.isTrigger).map((f) => [f.name, f] as const))(
    '%s takes the key exclusively before its first row lock',
    (_name, f) => {
      expect(exclusiveRuleViolation(f.name, f.body)).toBeNull()
    },
  )

  it.each(lockers.filter((f) => f.isTrigger).map((f) => [f.name] as const))(
    'trigger function %s runs only under the key',
    (name) => {
      const cover = TRIGGER_COVERS[name]
      expect(cover, `${name} locks memory_items rows and no cover says which key protects it`).toBeDefined()
      cover!()
    },
  )

  it('every function that inserts memory_items takes the key before the INSERT, shared or as a row locker', () => {
    const inserters = all.filter((f) => INSERT.test(f.body))
    expect(inserters.map((f) => f.name)).toContain('engram_insert_items')
    for (const f of inserters) {
      const key = lockers.includes(f) ? EXCLUSIVE : SHARED
      const keyAt = f.body.indexOf(key)
      expect(keyAt, `${f.name} never takes ${key}`).toBeGreaterThanOrEqual(0)
      expect(keyAt, `${f.name} inserts before taking ${key}`).toBeLessThan(f.body.search(INSERT))
    }
  })

  it('a row with lineage takes the key shared whoever inserts it', () => {
    TRIGGER_COVERS.memory_items_lineage!()
    expect(trigger('memory_items_before_insert')).toMatch(/BEFORE INSERT ON public\.memory_items FOR EACH ROW/)
  })
})

describe('the row-lock matcher sees every spelling of memory_items', () => {
  const locking = [
    'UPDATE memory_items SET retired_at = now() WHERE id = p_id;',
    'UPDATE ONLY public.memory_items SET retired_at = now() WHERE id = p_id;',
    'update "memory_items" set retired_at = now() where id = p_id;',
    'PERFORM 1 FROM memory_items WHERE id = p_id FOR SHARE OF memory_items;',
    'UPDATE PUBLIC.MEMORY_ITEMS SET retired_at = now() WHERE id = p_id;',
    'DELETE FROM ONLY "public"."memory_items" WHERE id = p_id;',
    'SELECT i.id INTO v_id FROM "memory_items" i WHERE i.id = p_id FOR NO KEY UPDATE OF i;',
    'INSERT INTO Memory_Items (id) VALUES (p_id) ON CONFLICT (id) DO UPDATE SET retired_at = now();',
  ]

  it.each(locking.map((stmt) => [stmt] as const))('a body without the key fails on: %s', (stmt) => {
    const body = squash(`BEGIN ${stmt} RETURN; END;`)
    expect(rowLocks(body)).toHaveLength(1)
    expect(exclusiveRuleViolation('f', body)).toBe(`f never takes ${EXCLUSIVE}`)
  })

  it.each(locking.map((stmt) => [stmt] as const))('the key taken first passes on: %s', (stmt) => {
    const body = squash(`BEGIN PERFORM ${EXCLUSIVE}; ${stmt} RETURN; END;`)
    expect(exclusiveRuleViolation('f', body)).toBeNull()
  })

  it('the key taken after the row lock fails', () => {
    const body = squash(`BEGIN update "memory_items" set retired_at = now() where id = p_id; PERFORM ${EXCLUSIVE}; END;`)
    expect(exclusiveRuleViolation('f', body)).toBe(`f locks a row before ${EXCLUSIVE}`)
  })

  it.each([
    ['insert into "memory_items" (id) values (p_id);'],
    ['INSERT INTO ONLY memory_items (id) VALUES (p_id);'],
    ['INSERT INTO Public.Memory_Items (id) VALUES (p_id);'],
  ] as const)('an insert is recognized in: %s', (stmt) => {
    expect(INSERT.test(stmt)).toBe(true)
  })

  it.each([
    ['UPDATE public.memory_items_archive SET retired_at = now() WHERE id = p_id;'],
    ['UPDATE "memory_items_archive" SET retired_at = now() WHERE id = p_id;'],
    ['PERFORM 1 FROM public.memory_subjects WHERE item_id = p_id FOR SHARE;'],
    ['DELETE FROM public.memory_item_entities WHERE item_id = p_id;'],
  ] as const)('another table is not taken for memory_items: %s', (stmt) => {
    expect(rowLocks(squash(`BEGIN ${stmt} END;`))).toEqual([])
  })

  it('a supersession write is recognized in any spelling', () => {
    expect(SUPERSESSION_WRITE.test('update ONLY "public"."memory_items" set "superseded_by" = p_new where id = p_old;')).toBe(true)
    expect(SUPERSESSION_WRITE.test('UPDATE memory_items SET retired_at = now() WHERE id = p_id;')).toBe(false)
  })
})
