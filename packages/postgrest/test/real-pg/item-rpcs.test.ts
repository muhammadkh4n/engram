/**
 * The item store RPCs on real Postgres, called as service_role the way
 * PostgREST calls them:
 * - engram_insert_items is idempotent on source.event_key, returns one row
 *   per object in input order, refuses any key that is not an insert column
 *   and any value its column cannot take, and stores nothing when one object
 *   breaks a rule;
 * - engram_forget_items forgets the listed items and their lineage closure
 *   and reports what it forgot and which successors were re-pointed or
 *   restored;
 * - retire, unretire and supersede act on live items only and refuse what
 *   the store's rules forbid;
 * - engram_invariant_counts reads zero on a store that keeps every rule and
 *   exactly one for each violation seeded past the triggers.
 */
import { createHash } from 'node:crypto'
import { ITEM_INVARIANTS } from '@engram-mem/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, waitUntilLockWait, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const SUBJECT_ID = '01940000-0000-7000-8000-00000000a000'
const T0 = Date.parse('2026-03-04T05:00:00Z')
const EMBEDDING_DIMS = 1536

/** Columns engram_insert_items refuses: the database or a later write owns them. */
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
] as const

type ItemObject = Record<string, unknown> & { id: string }

interface InsertRow {
  ord: number
  id: string
  inserted: boolean
  forgotten: boolean
}

interface Effect {
  itemId: string
  effect: string
  via: string | null
}

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `01940000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`
}

let keyCounter = 0
function eventKey(): string {
  keyCounter += 1
  return `capture:tst-rpc-session:turn-${keyCounter}`
}

function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString()
}

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

/** A text literal carried as UTF-8 hex, so any character reaches Postgres byte for byte. */
function text(value: string): string {
  return `convert_from(decode('${hex(value)}', 'hex'), 'UTF8')`
}

function jsonb(value: unknown): string {
  return `${text(JSON.stringify(value))}::jsonb`
}

function uuidArray(ids: readonly string[]): string {
  return `ARRAY[${ids.map((id) => `'${id}'`).join(', ')}]::uuid[]`
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function utterance(content: string, overrides: Record<string, unknown> = {}): ItemObject {
  return {
    id: newId(),
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    trust: 0,
    content,
    search_text: content,
    occurred_at: at(0),
    source: { type: 'transcript', event_key: eventKey() },
    ...overrides,
  }
}

function statement(content: string, lineage: readonly string[], overrides: Record<string, unknown> = {}): ItemObject {
  return {
    id: newId(),
    class: 'mk_statement',
    kind: 'ruling',
    speaker: 'mk',
    trust: 0,
    subject_id: SUBJECT_ID,
    content,
    search_text: content,
    occurred_at: at(0),
    source: { type: 'extraction', event_key: `mk_statement:${eventKey()}` },
    lineage,
    standing: false,
    ...overrides,
  }
}

function observation(content: string, lineage: readonly string[], overrides: Record<string, unknown> = {}): ItemObject {
  return {
    id: newId(),
    class: 'observation',
    kind: 'fact',
    speaker: 'assistant',
    trust: 3,
    subject_id: SUBJECT_ID,
    content,
    search_text: content,
    occurred_at: at(0),
    source: { type: 'extraction' },
    lineage,
    ...overrides,
  }
}

function artifact(content: string, minutes: number, overrides: Record<string, unknown> = {}): ItemObject {
  return {
    id: newId(),
    class: 'artifact',
    kind: 'commit',
    speaker: 'artifact',
    trust: 1,
    content,
    search_text: content,
    occurred_at: at(minutes),
    source: { type: 'git' },
    ...overrides,
  }
}

describe.skipIf(!realPgImage)('item store RPCs on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(`INSERT INTO public.memory_subjects (id, label) VALUES ('${SUBJECT_ID}', 'release cadence')`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  async function asService<T>(sql: string): Promise<T> {
    return JSON.parse(await pg.psqlAs('service_role', sql)) as T
  }

  function insertQuery(objects: unknown): string {
    return `SELECT coalesce(json_agg(r ORDER BY r.ord), '[]'::json) FROM public.engram_insert_items(${jsonb(objects)}) AS r;`
  }

  async function insertItems(objects: unknown): Promise<InsertRow[]> {
    return asService<InsertRow[]>(insertQuery(objects))
  }

  function forgetQuery(ids: readonly string[], reason: string): string {
    return `SELECT coalesce(json_agg(json_build_object('itemId', r.item_id, 'effect', r.effect, 'via', r.via) ORDER BY r.k), '[]'::json)
         FROM public.engram_forget_items(${uuidArray(ids)}, ${text(reason)}) WITH ORDINALITY AS r(item_id, effect, via, k);`
  }

  async function forget(ids: readonly string[], reason: string): Promise<Effect[]> {
    return asService<Effect[]>(forgetQuery(ids, reason))
  }

  async function retire(ids: readonly string[], reason: string): Promise<string[]> {
    return asService<string[]>(
      `SELECT coalesce(json_agg(r.id ORDER BY r.id), '[]'::json) FROM public.engram_retire_items(${uuidArray(ids)}, ${text(reason)}) AS r(id);`,
    )
  }

  async function unretire(ids: readonly string[]): Promise<string[]> {
    return asService<string[]>(
      `SELECT coalesce(json_agg(r.id ORDER BY r.id), '[]'::json) FROM public.engram_unretire_items(${uuidArray(ids)}) AS r(id);`,
    )
  }

  async function supersede(oldId: string, newId_: string): Promise<boolean> {
    return asService<boolean>(`SELECT to_json(public.engram_supersede_item('${oldId}', '${newId_}'));`)
  }

  /** Runs SQL as service_role that must fail; returns the verbose error, which carries the SQLSTATE. */
  async function refusal(sql: string): Promise<string> {
    try {
      await pg.psqlAs('service_role', `\\set VERBOSITY verbose\n${sql}`)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('the call succeeded')
  }

  async function insertRefusal(objects: unknown): Promise<string> {
    return refusal(`SELECT * FROM public.engram_insert_items(${jsonb(objects)});`)
  }

  async function rowCount(ids: readonly string[]): Promise<number> {
    return Number(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE id = ANY (${uuidArray(ids)})`))
  }

  async function row<T>(id: string, columns: string): Promise<T> {
    return JSON.parse(
      await pg.psql(`SELECT row_to_json(x) FROM (SELECT ${columns} FROM public.memory_items WHERE id = '${id}') x`),
    ) as T
  }

  describe('engram_insert_items', () => {
    it('inserts an utterance and its statement, statement first, in one call, in input order', async () => {
      const u = utterance('Cut the release branch on Thursdays.')
      const s = statement('Cut the release branch on Thursdays.', [u.id])
      expect(await insertItems([s, u])).toEqual([
        { ord: 1, id: s.id, inserted: true, forgotten: false },
        { ord: 2, id: u.id, inserted: true, forgotten: false },
      ])
      expect(await row(u.id, 'content_hash')).toEqual({ content_hash: sha256Hex(u.content as string) })
      expect(await row(s.id, 'lineage')).toEqual({ lineage: [u.id] })
    }, TEST_TIMEOUT_MS)

    it('skips every object of a repeated call and returns the stored ids', async () => {
      const u = utterance('Keep the staging data for a week.')
      const s = statement('Keep the staging data for a week.', [u.id])
      await insertItems([s, u])
      expect(await insertItems([s, u])).toEqual([
        { ord: 1, id: s.id, inserted: false, forgotten: false },
        { ord: 2, id: u.id, inserted: false, forgotten: false },
      ])
      const retried = [
        { ...s, id: newId() },
        { ...u, id: newId() },
      ]
      expect(await insertItems(retried)).toEqual([
        { ord: 1, id: s.id, inserted: false, forgotten: false },
        { ord: 2, id: u.id, inserted: false, forgotten: false },
      ])
      expect(await rowCount(retried.map((o) => o.id))).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('reports an event key repeated within one call as the first object', async () => {
      const first = utterance('Rotate the deploy key.')
      const replay = { ...first, id: newId() }
      expect(await insertItems([first, replay])).toEqual([
        { ord: 1, id: first.id, inserted: true, forgotten: false },
        { ord: 2, id: first.id, inserted: false, forgotten: false },
      ])
      expect(await rowCount([replay.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('resolves a lineage naming a replayed object to the stored item, within the call', async () => {
      const u1 = utterance('Freeze merges the day before a release.')
      await insertItems([u1])
      const u2 = utterance('Freeze merges the day before a release.', { source: u1.source })
      const s = observation('Releases follow a merge freeze.', [u2.id])
      expect(await insertItems([u2, s])).toEqual([
        { ord: 1, id: u1.id, inserted: false, forgotten: false },
        { ord: 2, id: s.id, inserted: true, forgotten: false },
      ])
      expect(await row(s.id, 'lineage')).toEqual({ lineage: [u1.id] })
      expect(await rowCount([u2.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('checks a statement quote against the stored item its rewritten lineage names', async () => {
      const u1 = utterance('Rotate the deploy keys every quarter.')
      await insertItems([u1])
      const u2 = utterance('Rotate the deploy keys every quarter.', { source: u1.source })
      const s = statement('Rotate the deploy keys', [u2.id])
      expect(await insertItems([u2, s])).toEqual([
        { ord: 1, id: u1.id, inserted: false, forgotten: false },
        { ord: 2, id: s.id, inserted: true, forgotten: false },
      ])
      expect(await row(s.id, 'lineage')).toEqual({ lineage: [u1.id] })
      expect(await rowCount([u2.id])).toBe(0)

      const u3 = utterance('Rotate the deploy keys every quarter.', { source: u1.source })
      const misquoted = statement('Rotate the deploy keys monthly', [u3.id])
      const refusal = await insertRefusal([u3, misquoted])
      expect(refusal).toMatch(/ERROR:\s+23514: memory_items_lineage: the quote does not occur in an mk utterance of its lineage/)
      expect(await rowCount([u3.id, misquoted.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('resolves a lineage naming an object skipped as a repeat of an earlier one in the same call', async () => {
      const first = utterance('Archive the old dashboards.')
      const replay = { ...first, id: newId() }
      const derived = observation('The old dashboards are archived.', [replay.id, first.id])
      expect(await insertItems([first, replay, derived])).toEqual([
        { ord: 1, id: first.id, inserted: true, forgotten: false },
        { ord: 2, id: first.id, inserted: false, forgotten: false },
        { ord: 3, id: derived.id, inserted: true, forgotten: false },
      ])
      expect(await row(derived.id, 'lineage')).toEqual({ lineage: [first.id, first.id] })
      expect(await rowCount([replay.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('reports a replayed forgotten item and refuses, by position, a lineage naming it directly or through the replay', async () => {
      const u1 = utterance('Drop the nightly export.')
      await insertItems([u1])
      await forget([u1.id], 'said by mistake')
      const u2 = utterance('Drop the nightly export.', { source: u1.source })
      expect(await insertItems([u2])).toEqual([{ ord: 1, id: u1.id, inserted: false, forgotten: true }])

      const viaReplay = observation('The nightly export is gone.', [u2.id])
      const throughReplay = await insertRefusal([u2, viaReplay])
      expect(throughReplay).toMatch(/ERROR:\s+22023: engram_insert_items: object 2: lineage names a forgotten item/)
      expect(await rowCount([u2.id, viaReplay.id])).toBe(0)

      const other = utterance('Keep the weekly export.')
      const direct = observation('The nightly export was dropped.', [u1.id])
      const byStoredId = await insertRefusal([other, direct])
      expect(byStoredId).toMatch(/ERROR:\s+22023: engram_insert_items: object 2: lineage names a forgotten item/)
      expect(await rowCount([other.id, direct.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('asks for a retry when a concurrent call stores the event key of an object another object names', async () => {
      const stored = utterance('Pin the base image digest.')
      const mine = { ...stored, id: newId() }
      const derived = observation('Base images are pinned by digest.', [mine.id])
      const writer = await pg.session()
      const caller = await pg.session()
      const outcome = (run: Promise<string>) => run.then((out) => out, (error: Error) => error.message)
      try {
        for (const session of [writer, caller]) {
          await session.run('SET ROLE service_role;')
          await session.run('\\set VERBOSITY verbose')
        }
        const callerPid = await caller.run('SELECT pg_backend_pid();')
        await writer.run('BEGIN;')
        await writer.run(insertQuery([stored]))
        const calling = outcome(caller.run(insertQuery([mine, derived])))
        await waitUntilLockWait(pg, callerPid)
        expect(await outcome(writer.run('COMMIT;'))).not.toMatch(/ERROR/)
        expect(await calling).toMatch(/40001: engram_insert_items: object 1 was stored by a concurrent call, retry the call/)
        expect(await rowCount([mine.id, derived.id])).toBe(0)
        expect(JSON.parse(await caller.run(insertQuery([mine, derived])))).toEqual([
          { ord: 1, id: stored.id, inserted: false, forgotten: false },
          { ord: 2, id: derived.id, inserted: true, forgotten: false },
        ])
      } finally {
        await writer.close()
        await caller.close()
      }
    }, TEST_TIMEOUT_MS)

    it('refuses two objects that share an id, naming both positions, and stores nothing', async () => {
      const a = utterance('Tag the release after the smoke run.')
      const b = utterance('Tag it before the announcement.')
      const c = utterance('Same row id, written in capitals.', { id: b.id.toUpperCase() })
      const message = await insertRefusal([a, b, c])
      expect(message).toMatch(/ERROR:\s+22023: engram_insert_items: objects 2 and 3 share an id/)
      expect(await rowCount([a.id, b.id])).toBe(0)

      const replay = { ...a, source: { type: 'transcript', event_key: eventKey() } }
      expect(await insertRefusal([a, replay])).toMatch(/22023: engram_insert_items: objects 1 and 2 share an id/)
      expect(await rowCount([a.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('reports the stored id and inserted=false for a retried key and true for a new key in the same call', async () => {
      const stored = utterance('Run the migrations before the deploy.')
      const sameId = utterance('Run them in one transaction.')
      await insertItems([stored, sameId])
      const retriedWithNewId = { ...stored, id: newId() }
      const fresh = utterance('Then warm the cache.')
      const fresher = utterance('Then page the on-call.')

      expect(await insertItems([retriedWithNewId, fresh, sameId, fresher])).toEqual([
        { ord: 1, id: stored.id, inserted: false, forgotten: false },
        { ord: 2, id: fresh.id, inserted: true, forgotten: false },
        { ord: 3, id: sameId.id, inserted: false, forgotten: false },
        { ord: 4, id: fresher.id, inserted: true, forgotten: false },
      ])
      expect(await rowCount([retriedWithNewId.id])).toBe(0)
      expect(await rowCount([fresh.id, fresher.id])).toBe(2)
    }, TEST_TIMEOUT_MS)

    it.each([
      ['infinity', 'infinity', /object 2: occurred_at must be ISO-8601 with Z or an offset/],
      ['-infinity', '-infinity', /object 2: occurred_at must be ISO-8601 with Z or an offset/],
      ['now', 'now', /object 2: occurred_at must be ISO-8601 with Z or an offset/],
      ['an offset-less time', '2026-03-04T05:06:07', /object 2: occurred_at must be ISO-8601 with Z or an offset/],
      ['a space instead of T', '2026-03-04 05:06:07+00:00', /object 2: occurred_at must be ISO-8601 with Z or an offset/],
      ['an offset without a colon', '2026-03-04T05:06:07+0000', /object 2: occurred_at must be ISO-8601 with Z or an offset/],
      ['a US DateStyle date', '03/04/2026 05:06:07+00', /object 2: occurred_at must be ISO-8601 with Z or an offset/],
      ['a Postgres DateStyle form', 'Wed Mar 04 05:06:07 2026 UTC', /object 2: occurred_at must be ISO-8601 with Z or an offset/],
      ['a day the month does not have', '2026-02-30T05:06:07Z', /object 2: occurred_at is not a valid timestamptz/],
    ])('refuses occurred_at of infinity, now, offset-less and DateStyle forms, naming the object (%s)', async (_label, when, reason) => {
      const ok = utterance('This time is fine.')
      const bad = utterance('This time is not.', { occurred_at: when })
      const message = await insertRefusal([ok, bad])
      expect(message).toMatch(/ERROR:\s+22023: engram_insert_items: /)
      expect(message).toMatch(reason)
      expect(message).not.toContain(when)
      expect(await rowCount([ok.id, bad.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('accepts occurred_at with Z, a positive or negative offset and up to six fractional digits', async () => {
      const zulu = utterance('Zulu time.', { occurred_at: '2026-03-04T05:06:07Z' })
      const east = utterance('Half an hour east.', { occurred_at: '2026-03-04T10:36:07.5+05:30' })
      const west = utterance('Eight hours west.', { occurred_at: '2026-03-03T21:06:07.123456-08:00' })
      await insertItems([zulu, east, west])
      expect(
        await row(west.id, `occurred_at = '2026-03-04T05:06:07.123456Z'::timestamptz AS same_instant`),
      ).toEqual({ same_instant: true })
      expect(await row(east.id, `occurred_at = '2026-03-04T05:06:07.5Z'::timestamptz AS same_instant`)).toEqual({
        same_instant: true,
      })
    }, TEST_TIMEOUT_MS)

    it('refuses occurred_at more than ten minutes ahead', async () => {
      const ahead = utterance('A prompt from a fast clock.', { occurred_at: new Date(Date.now() + 11 * 60_000).toISOString() })
      expect(await insertRefusal([utterance('On time.'), ahead])).toMatch(
        /ERROR:\s+22023: engram_insert_items: object 2: occurred_at is more than 10 minutes ahead of now/,
      )
      expect(await rowCount([ahead.id])).toBe(0)

      const skewed = utterance('A prompt from a slightly fast clock.', {
        occurred_at: new Date(Date.now() + 8 * 60_000).toISOString(),
      })
      expect(await insertItems([skewed])).toEqual([{ ord: 1, id: skewed.id, inserted: true, forgotten: false }])
    }, TEST_TIMEOUT_MS)

    it('refuses by position an occurred_at in year 1 whose offset puts it in 1 BC, and a five-digit year', async () => {
      const early = utterance('A prompt from before the epoch of the calendar.', { occurred_at: '0001-01-01T00:30:00+01:00' })
      expect(await insertRefusal([utterance('On time.'), early])).toMatch(
        /ERROR:\s+22023: engram_insert_items: object 2: occurred_at is before year 1 in UTC/,
      )
      const late = utterance('A prompt from year 12000.', { occurred_at: '12000-01-01T00:00:00Z' })
      expect(await insertRefusal([late])).toMatch(
        /ERROR:\s+22023: engram_insert_items: object 1: occurred_at must be ISO-8601 with Z or an offset/,
      )
      expect(await rowCount([early.id, late.id])).toBe(0)

      const first = utterance('A prompt at the first instant of year 1.', { occurred_at: '0001-01-01T00:00:00Z' })
      expect(await insertItems([first])).toEqual([{ ord: 1, id: first.id, inserted: true, forgotten: false }])
    }, TEST_TIMEOUT_MS)

    it('refuses a source.event_key longer than 512 characters by position, without quoting it', async () => {
      const long = artifact('chore: an overlong key', 0, { source: { type: 'git', event_key: `git:${'k'.repeat(509)}` } })
      const message = await insertRefusal([utterance('A short key.'), long])
      expect(message).toMatch(/ERROR:\s+22023: engram_insert_items: object 2: source\.event_key is longer than 512 characters/)
      expect(message).not.toContain('kkkkkkkk')
      expect(await rowCount([long.id])).toBe(0)

      const longest = artifact('chore: the longest key', 0, { source: { type: 'git', event_key: `git:${'k'.repeat(508)}` } })
      expect(await insertItems([longest])).toEqual([{ ord: 1, id: longest.id, inserted: true, forgotten: false }])
    }, TEST_TIMEOUT_MS)

    it.each([
      ['a JSON null', null],
      ['a number', 42],
      ['a blank string', '  '],
    ])('refuses by position a source.event_key that is %s, storing nothing', async (_label, badKey) => {
      const first = utterance('Before the malformed key.')
      const bad = artifact('chore: a malformed key', 0, { source: { type: 'git', event_key: badKey } })
      const third = utterance('After the malformed key.')
      expect(await insertRefusal([first, bad, third])).toMatch(
        /ERROR:\s+22023: engram_insert_items: object 2: source\.event_key must be absent or a non-blank string of at most 512 characters/,
      )
      expect(await rowCount([first.id, bad.id, third.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('generates an id for an object that has none', async () => {
      const { id: _unused, ...withoutId } = utterance('Name the branch after the ticket.')
      const [result] = await insertItems([withoutId])
      expect(result!.inserted).toBe(true)
      expect(result!.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(await rowCount([result!.id])).toBe(1)
    }, TEST_TIMEOUT_MS)

    it('converts every column from its JSON form', async () => {
      const u = utterance('Ship it.')
      const v = utterance('Ship it after review.')
      const embedding = Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i === 0 ? 0.5 : i === 1 ? -0.25 : 0))
      const s = statement('Ship it', [v.id, u.id], {
        context: 'Should the hotfix wait for review?',
        embedding,
        embedding_model: 'tst-embedder',
        occurred_at: '2026-03-04T05:06:07.123Z',
        standing: true,
        register_status: 'recorded',
        register_ref: 'R-TST-7',
        session_id: 'tst-rpc-session',
        plan_slug: 'tst-plan',
      })
      await insertItems([u, v, s])
      expect(
        await row(
          s.id,
          `vector_dims(embedding) AS dims, (embedding::real[])[1:3] AS head, embedding_model, lineage,
           occurred_at = '2026-03-04T05:06:07.123Z'::timestamptz AS occurred_ok, valid_to,
           standing, register_status, register_ref, context, session_id, plan_slug, subject_id, trust, source`,
        ),
      ).toEqual({
        dims: EMBEDDING_DIMS,
        head: [0.5, -0.25, 0],
        embedding_model: 'tst-embedder',
        lineage: [v.id, u.id],
        occurred_ok: true,
        valid_to: null,
        standing: true,
        register_status: 'recorded',
        register_ref: 'R-TST-7',
        context: 'Should the hotfix wait for review?',
        session_id: 'tst-rpc-session',
        plan_slug: 'tst-plan',
        subject_id: SUBJECT_ID,
        trust: 0,
        source: s.source,
      })
    }, TEST_TIMEOUT_MS)

    it.each(NOT_INSERT_COLUMNS)('refuses the key %s by name and stores nothing', async (column) => {
      const ok = utterance('This one is fine.')
      const bad = { ...utterance('This one sends a column it does not own.'), [column]: null }
      const message = await insertRefusal([ok, bad])
      expect(message).toMatch(
        new RegExp(`ERROR:\\s+22023: engram_insert_items: object 2 has the key ${column}, which is not an insert column`),
      )
      expect(await rowCount([ok.id, bad.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('insert refuses a sent valid_to by name', async () => {
      const bounded = artifact('perf: bounded cache', 0, { valid_to: at(5) })
      expect(await insertRefusal([bounded])).toMatch(
        /ERROR:\s+22023: engram_insert_items: object 1 has the key valid_to, which is not an insert column/,
      )
      expect(await rowCount([bounded.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('refuses a call that is not an array of 1 to 500 objects', async () => {
      const many = Array.from({ length: 501 }, (_, i) => utterance(`Prompt number ${i}.`))
      expect(await insertRefusal(many)).toMatch(/ERROR:\s+22023: engram_insert_items: p_items holds 501 objects, not 1 to 500/)
      expect(await rowCount(many.map((o) => o.id))).toBe(0)
      expect(await insertRefusal([])).toMatch(/22023: engram_insert_items: p_items holds 0 objects/)
      expect(await insertRefusal({ items: [] })).toMatch(/22023: engram_insert_items: p_items must be a JSON array/)
      expect(await insertRefusal([utterance('fine'), 'not an object'])).toMatch(
        /22023: engram_insert_items: object 2 is not a JSON object/,
      )
    }, TEST_TIMEOUT_MS)

    it.each([
      ['a string trust', { trust: 'tst-zero' }, /object 1: trust must be a JSON number or null/],
      ['a fractional trust', { trust: 0.5 }, /object 1: trust is not a valid smallint/],
      ['a malformed id', { id: 'tst-not-a-uuid' }, /object 1: id is not a valid uuid/],
      ['a malformed event time', { occurred_at: 'tst-some-day' }, /object 1: occurred_at is not a valid timestamptz/],
      ['a source that is not an object', { source: 'transcript' }, /object 1: source must be a JSON object or null/],
      ['a short embedding', { embedding: [0.1, 0.2, 0.3], embedding_model: 'tst-embedder' }, /object 1: embedding must hold 1536 numbers/],
      ['a lineage of numbers', { lineage: [12] }, /object 1: lineage must hold uuid strings only/],
      ['no content', { content: null }, /object 1 has no content/],
    ])('refuses %s without quoting the value', async (_label, override, reason) => {
      const bad = { ...utterance('A prompt with one bad value.'), ...override }
      const message = await insertRefusal([bad])
      expect(message).toMatch(/ERROR:\s+22023: engram_insert_items: /)
      expect(message).toMatch(reason)
      for (const value of Object.values(override)) {
        if (typeof value === 'string') expect(message).not.toContain(value)
      }
      expect(
        Number(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE content = 'A prompt with one bad value.'`)),
      ).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('stores nothing when object 3 of 3 quotes words its utterance does not hold, at commit', async () => {
      const u = utterance('Freeze merges during the audit.')
      const v = utterance('Unfreeze them afterwards.')
      const s = statement('Freeze merges during the migration.', [u.id])
      const message = await insertRefusal([u, v, s])
      expect(message).toMatch(/ERROR:\s+23514: memory_items_lineage: the quote does not occur in an mk utterance of its lineage/)
      expect(await rowCount([u.id, v.id, s.id])).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('stores nothing when object 3 of 3 breaks a CHECK', async () => {
      const u = utterance('Pin the toolchain.')
      const v = utterance('Pin it in the lockfile.')
      const w = utterance('An mk prompt claiming assistant trust.', { trust: 3 })
      const message = await insertRefusal([u, v, w])
      expect(message).toMatch(/ERROR:\s+23514: .*violates check constraint "memory_items_trust_check"/)
      expect(await rowCount([u.id, v.id, w.id])).toBe(0)
    }, TEST_TIMEOUT_MS)
  })

  describe('engram_forget_items', () => {
    it('forgets an utterance, the statement quoting it and the observation built on that', async () => {
      const u = utterance('Archive the old dashboards.')
      const s = statement('Archive the old dashboards.', [u.id])
      const o = observation('The old dashboards are archived monthly.', [s.id])
      await insertItems([u, s, o])
      expect(await forget([u.id], 'withdrawn by the speaker')).toEqual([
        { itemId: u.id, effect: 'forgotten', via: null },
        { itemId: s.id, effect: 'forgotten', via: u.id },
        { itemId: o.id, effect: 'forgotten', via: u.id },
      ])
      expect(await row(u.id, 'forgotten_reason')).toEqual({ forgotten_reason: 'withdrawn by the speaker' })
      expect(await row(s.id, 'forgotten_reason')).toEqual({
        forgotten_reason: `lineage: ${u.id} forgotten: withdrawn by the speaker`,
      })
      expect(await row(o.id, 'forgotten_reason')).toEqual({
        forgotten_reason: `lineage: ${u.id} forgotten: withdrawn by the speaker`,
      })
    }, TEST_TIMEOUT_MS)

    it('lets a listed id win over a descendant, lists listed ids in call order, and names the first listed ancestor', async () => {
      const u = utterance('Drop the beta flag.')
      const s = statement('Drop the beta flag.', [u.id])
      const o = observation('The beta flag gates the new importer.', [s.id])
      await insertItems([u, s, o])
      expect(await forget([s.id, u.id], 'superseded by a later decision')).toEqual([
        { itemId: s.id, effect: 'forgotten', via: null },
        { itemId: u.id, effect: 'forgotten', via: null },
        { itemId: o.id, effect: 'forgotten', via: s.id },
      ])
      expect(await row(s.id, 'forgotten_reason')).toEqual({ forgotten_reason: 'superseded by a later decision' })
    }, TEST_TIMEOUT_MS)

    it('restores the item a forgotten successor superseded', async () => {
      const a = artifact('fix: first attempt', 0)
      const b = artifact('fix: second attempt', 10)
      await insertItems([a, b])
      expect(await supersede(a.id, b.id)).toBe(true)
      expect(await forget([b.id], 'reverted')).toEqual([
        { itemId: b.id, effect: 'forgotten', via: null },
        { itemId: a.id, effect: 'restored', via: b.id },
      ])
      expect(await row(a.id, 'superseded_by, valid_to')).toEqual({ superseded_by: null, valid_to: null })
    }, TEST_TIMEOUT_MS)

    it('re-points the first item of a chain past a forgotten middle', async () => {
      const a = artifact('docs: v1', 0)
      const b = artifact('docs: v2', 10)
      const c = artifact('docs: v3', 20)
      await insertItems([a, b, c])
      expect(await supersede(a.id, b.id)).toBe(true)
      expect(await supersede(b.id, c.id)).toBe(true)
      expect(await forget([b.id], 'wrong file')).toEqual([
        { itemId: b.id, effect: 'forgotten', via: null },
        { itemId: a.id, effect: 'repointed', via: b.id },
      ])
      expect(
        await row(a.id, `superseded_by, valid_to = '${c.occurred_at}'::timestamptz AS ends_at_successor`),
      ).toEqual({ superseded_by: c.id, ends_at_successor: true })
    }, TEST_TIMEOUT_MS)

    it('re-points onto a retired successor: retiring an item does not bring back the one it replaced', async () => {
      const a = artifact('ops: runbook v1', 0)
      const b = artifact('ops: runbook v2', 10)
      const c = artifact('ops: runbook v3', 20)
      await insertItems([a, b, c])
      expect(await supersede(a.id, b.id)).toBe(true)
      expect(await supersede(b.id, c.id)).toBe(true)
      expect(await retire([c.id], 'runbook moved to the wiki')).toEqual([c.id])
      expect(await forget([b.id], 'v2 was never used')).toEqual([
        { itemId: b.id, effect: 'forgotten', via: null },
        { itemId: a.id, effect: 'repointed', via: b.id },
      ])
      expect(await row(a.id, 'superseded_by')).toEqual({ superseded_by: c.id })
    }, TEST_TIMEOUT_MS)

    it('forgetting the successor re-points valid_to to the next live successor, then clears it', async () => {
      const a = artifact('docs: draft', 0)
      const b = artifact('docs: review', 10)
      const c = artifact('docs: final', 20)
      await insertItems([a, b, c])
      expect(await supersede(a.id, b.id)).toBe(true)
      expect(await supersede(b.id, c.id)).toBe(true)

      await forget([b.id], 'reviewed the wrong file')
      expect(await row(a.id, `superseded_by, valid_to = '${c.occurred_at}'::timestamptz AS ends_at_c`)).toEqual({
        superseded_by: c.id,
        ends_at_c: true,
      })

      expect(await forget([c.id], 'final was never published')).toEqual([
        { itemId: c.id, effect: 'forgotten', via: null },
        { itemId: a.id, effect: 'restored', via: c.id },
      ])
      expect(await row(a.id, 'superseded_by, valid_to')).toEqual({ superseded_by: null, valid_to: null })
    }, TEST_TIMEOUT_MS)

    it('reports a descendant committed while the call waits, under the call reason', async () => {
      const root = artifact('feat: the importer', 0)
      const child = observation('The importer reads CSV.', [root.id])
      await insertItems([root, child])
      const late = observation('The importer reads CSV with a header row.', [child.id])
      const inserter = await pg.session()
      const forgetter = await pg.session()
      try {
        await inserter.run('SET ROLE service_role;')
        await forgetter.run('SET ROLE service_role;')
        const pid = await forgetter.run('SELECT pg_backend_pid();')
        await inserter.run('BEGIN;')
        await inserter.run(`SELECT count(*) FROM public.engram_insert_items(${jsonb([late])});`)
        // Runs the deferred lineage check now: it holds the child FOR SHARE until COMMIT.
        await inserter.run('SET CONSTRAINTS ALL IMMEDIATE;')
        const forgetting = forgetter.run(forgetQuery([root.id], 'the importer was reverted'))
        await waitUntilLockWait(pg, pid)
        await inserter.run('COMMIT;')
        expect(JSON.parse(await forgetting) as Effect[]).toEqual([
          { itemId: root.id, effect: 'forgotten', via: null },
          { itemId: child.id, effect: 'forgotten', via: root.id },
          { itemId: late.id, effect: 'forgotten', via: root.id },
        ])
      } finally {
        await inserter.close()
        await forgetter.close()
      }
      expect(await row(late.id, 'forgotten_reason')).toEqual({
        forgotten_reason: `lineage: ${root.id} forgotten: the importer was reverted`,
      })
    }, TEST_TIMEOUT_MS)

    it('lets two concurrent forgets over overlapping closures both succeed', async () => {
      // Ids rise in creation order: a < b < blocker < x < y. The first call lists a and y (a child of b) and
      // the second lists b and x (a child of a), so each closure holds a root the other call locks first.
      const a = artifact('feat: the exporter', 0)
      const b = artifact('feat: the scheduler', 10)
      const blocker = observation('The exporter writes Parquet.', [a.id])
      const x = observation('The exporter runs on the scheduler.', [a.id])
      const y = observation('The scheduler triggers the exporter.', [b.id])
      await insertItems([a, b, blocker, x, y])
      const holder = await pg.session()
      const first = await pg.session()
      const second = await pg.session()
      try {
        await first.run('SET ROLE service_role;')
        await second.run('SET ROLE service_role;')
        const firstPid = await first.run('SELECT pg_backend_pid();')
        const secondPid = await second.run('SELECT pg_backend_pid();')
        // Holding the blocker stops the first call after it has locked a and y, before it reaches x.
        await holder.run('BEGIN;')
        await holder.run(`SELECT 1 FROM public.memory_items WHERE id = '${blocker.id}' FOR UPDATE;`)
        const firstForget = first.run(forgetQuery([a.id, y.id], 'the exporter was dropped'))
        await waitUntilLockWait(pg, firstPid)
        const secondForget = second.run(forgetQuery([b.id, x.id], 'the scheduler was dropped'))
        await waitUntilLockWait(pg, secondPid)
        await holder.run('COMMIT;')
        const [firstEffects, secondEffects] = await Promise.all([firstForget, secondForget])
        expect(JSON.parse(firstEffects) as Effect[]).toEqual([
          { itemId: a.id, effect: 'forgotten', via: null },
          { itemId: y.id, effect: 'forgotten', via: null },
          { itemId: blocker.id, effect: 'forgotten', via: a.id },
          { itemId: x.id, effect: 'forgotten', via: a.id },
        ])
        expect(JSON.parse(secondEffects) as Effect[]).toEqual([{ itemId: b.id, effect: 'forgotten', via: null }])
      } finally {
        await holder.close()
        await first.close()
        await second.close()
      }
      expect(await rowCount([a.id, b.id, blocker.id, x.id, y.id])).toBe(5)
      expect(
        Number(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE id = ANY (${uuidArray([a.id, b.id, blocker.id, x.id, y.id])}) AND forgotten_at IS NOT NULL`)),
      ).toBe(5)
    }, TEST_TIMEOUT_MS)

    it('makes a supersede wait for a concurrent forget instead of deadlocking with it', async () => {
      // Ids in the order blocker < derived < root: the forget locks root first and derived later, while the
      // supersede locks its two rows in id order, derived before root.
      const [blockerId, derivedId, rootId] = [newId(), newId(), newId()]
      const root = observation('The cache holds a day of results.', [], { id: rootId, occurred_at: at(0) })
      const blocker = observation('The cache is warmed at boot.', [rootId], { id: blockerId, occurred_at: at(5) })
      const derived = observation('The cache holds an hour of results.', [rootId], { id: derivedId, occurred_at: at(10) })
      await insertItems([root, blocker, derived])
      const holder = await pg.session()
      const forgetter = await pg.session()
      const superseder = await pg.session()
      try {
        await forgetter.run('SET ROLE service_role;')
        await superseder.run('SET ROLE service_role;')
        await superseder.run('\\set VERBOSITY verbose')
        const forgetterPid = await forgetter.run('SELECT pg_backend_pid();')
        const supersederPid = await superseder.run('SELECT pg_backend_pid();')
        await holder.run('BEGIN;')
        await holder.run(`SELECT 1 FROM public.memory_items WHERE id = '${blocker.id}' FOR UPDATE;`)
        const forgetting = forgetter.run(forgetQuery([root.id], 'the cache was removed'))
        await waitUntilLockWait(pg, forgetterPid)
        const superseding = superseder.run(`SELECT public.engram_supersede_item('${root.id}', '${derived.id}');`).then(
          () => 'the supersede succeeded',
          (error: Error) => error.message,
        )
        await waitUntilLockWait(pg, supersederPid)
        await holder.run('COMMIT;')
        expect(JSON.parse(await forgetting) as Effect[]).toEqual([
          { itemId: root.id, effect: 'forgotten', via: null },
          { itemId: blocker.id, effect: 'forgotten', via: root.id },
          { itemId: derived.id, effect: 'forgotten', via: root.id },
        ])
        expect(await superseding).toMatch(/ERROR:\s+23514: engram_supersede_item: a forgotten item neither supersedes nor is superseded/)
      } finally {
        await holder.close()
        await forgetter.close()
        await superseder.close()
      }
    }, TEST_TIMEOUT_MS)

    it('lets an insert with lineage and a concurrent forget over the same rows both finish, without a deadlock', async () => {
      // Ids rise in creation order: early < late. The forget locks early, then late. The insert's lineage
      // check runs at once here, so it holds late before it asks for early: the opposite order, which one
      // call checking two lineage rows at commit can also take.
      const early = artifact('feat: the importer', 0)
      const late = artifact('feat: the exporter', 10)
      await insertItems([early, late])
      const fromLate = observation('The exporter reads what the importer wrote.', [late.id])
      const fromEarly = observation('The importer feeds the exporter.', [early.id])
      const inserter = await pg.session()
      const forgetter = await pg.session()
      const outcome = (run: Promise<string>) => run.then((out) => out, (error: Error) => error.message)
      try {
        for (const session of [inserter, forgetter]) {
          await session.run('SET ROLE service_role;')
          await session.run('\\set VERBOSITY verbose')
        }
        const forgetterPid = await forgetter.run('SELECT pg_backend_pid();')
        await inserter.run('BEGIN;')
        await inserter.run('SET CONSTRAINTS public.memory_items_lineage IMMEDIATE;')
        await inserter.run(insertQuery([fromLate]))
        const forgetting = outcome(forgetter.run(forgetQuery([early.id, late.id], 'the pipeline was dropped')))
        await waitUntilLockWait(pg, forgetterPid)
        const inserting = await outcome(inserter.run(insertQuery([fromEarly])))
        const committing = await outcome(inserter.run('COMMIT;'))
        const forgot = await forgetting

        expect(inserting).not.toMatch(/40P01|deadlock/)
        expect(committing).not.toMatch(/ERROR/)
        expect(forgot).not.toMatch(/40P01|deadlock/)
        const effects = (JSON.parse(forgot) as Effect[]).sort((x, y) => x.itemId.localeCompare(y.itemId))
        expect(effects).toEqual([
          { itemId: early.id, effect: 'forgotten', via: null },
          { itemId: late.id, effect: 'forgotten', via: null },
          { itemId: fromLate.id, effect: 'forgotten', via: late.id },
          { itemId: fromEarly.id, effect: 'forgotten', via: early.id },
        ])
      } finally {
        await inserter.close()
        await forgetter.close()
      }
    }, TEST_TIMEOUT_MS)

    it('forgets 500 descendants in one call, every cascaded row passing the forget check', async () => {
      const root = artifact('feat: the event bus', 0)
      const descendants = Array.from({ length: 500 }, (_, i) => observation(`Consumer ${i} reads the event bus.`, [root.id]))
      await insertItems([root])
      await insertItems(descendants)

      const effects = await forget([root.id], 'the bus was replaced')

      expect(effects).toHaveLength(501)
      expect(await rowCount([root.id, ...descendants.map((d) => d.id)])).toBe(501)
      expect(
        Number(
          await pg.psql(
            `SELECT count(*) FROM public.memory_items WHERE id = ANY (${uuidArray([root.id, ...descendants.map((d) => d.id)])}) AND forgotten_at IS NULL`,
          ),
        ),
      ).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('returns no row for an unknown or an already forgotten id', async () => {
      const a = artifact('chore: tidy', 0)
      await insertItems([a])
      expect(await forget([newId()], 'not stored')).toEqual([])
      expect(await forget([a.id], 'first')).toHaveLength(1)
      expect(await forget([a.id], 'second')).toEqual([])
      expect(await row(a.id, 'forgotten_reason')).toEqual({ forgotten_reason: 'first' })
    }, TEST_TIMEOUT_MS)

    it('refuses 51 ids, a NULL id, and a blank or overlong reason', async () => {
      const ids = Array.from({ length: 51 }, () => newId())
      expect(await refusal(`SELECT * FROM public.engram_forget_items(${uuidArray(ids)}, 'too many');`)).toMatch(
        /ERROR:\s+22023: engram_forget_items: p_ids must hold 1 to 50 ids and no NULL/,
      )
      expect(await refusal(`SELECT * FROM public.engram_forget_items(ARRAY[NULL]::uuid[], 'null id');`)).toMatch(
        /22023: engram_forget_items: p_ids must hold 1 to 50 ids/,
      )
      expect(await refusal(`SELECT * FROM public.engram_forget_items(${uuidArray([newId()])}, '   ');`)).toMatch(
        /22023: engram_forget_items: p_reason must be non-blank and at most 2000 characters/,
      )
      expect(
        await refusal(`SELECT * FROM public.engram_forget_items(${uuidArray([newId()])}, repeat('x', 2001));`),
      ).toMatch(/22023: engram_forget_items: p_reason must be non-blank/)
    }, TEST_TIMEOUT_MS)
  })

  describe('engram_retire_items and engram_unretire_items', () => {
    it('round-trips a retirement and acts only on items in the other state', async () => {
      const a = artifact('feat: retired later', 0)
      await insertItems([a])
      expect(await retire([a.id], 'no longer relevant')).toEqual([a.id])
      expect(await row(a.id, 'retired_at IS NOT NULL AS retired, retired_reason')).toEqual({
        retired: true,
        retired_reason: 'no longer relevant',
      })
      expect(await retire([a.id], 'again')).toEqual([])
      expect(await row(a.id, 'retired_reason')).toEqual({ retired_reason: 'no longer relevant' })
      expect(await unretire([a.id])).toEqual([a.id])
      expect(await row(a.id, 'retired_at, retired_reason')).toEqual({ retired_at: null, retired_reason: null })
      expect(await unretire([a.id])).toEqual([])
    }, TEST_TIMEOUT_MS)

    it('neither retires nor unretires a forgotten item', async () => {
      const a = artifact('feat: forgotten first', 0)
      const b = artifact('feat: retired, then forgotten', 0)
      await insertItems([a, b])
      expect(await retire([b.id], 'parked')).toEqual([b.id])
      await forget([a.id, b.id], 'mistaken capture')
      expect(await retire([a.id], 'too late')).toEqual([])
      expect(await unretire([b.id])).toEqual([])
    }, TEST_TIMEOUT_MS)

    it.each(['engram_retire_items', 'engram_unretire_items'] as const)(
      'lets %s and a concurrent forget over overlapping rows both finish, without a deadlock',
      async (fn) => {
        // Ids rise in creation order: root < derived. The forget locks root, then derived; the other
        // transaction acts on derived first and root second, the reverse order.
        const root = artifact('feat: the scheduler', 0)
        const derived = observation('The scheduler runs every night.', [root.id])
        await insertItems([root, derived])
        if (fn === 'engram_unretire_items') await retire([root.id, derived.id], 'parked')
        const call = (id: string) =>
          fn === 'engram_retire_items'
            ? `SELECT * FROM public.engram_retire_items(${uuidArray([id])}, 'superseded by the queue');`
            : `SELECT * FROM public.engram_unretire_items(${uuidArray([id])});`
        const actor = await pg.session()
        const forgetter = await pg.session()
        const outcome = (run: Promise<string>) => run.then((out) => out, (error: Error) => error.message)
        try {
          for (const session of [actor, forgetter]) {
            await session.run('SET ROLE service_role;')
            await session.run('\\set VERBOSITY verbose')
          }
          const forgetterPid = await forgetter.run('SELECT pg_backend_pid();')
          await actor.run('BEGIN;')
          await actor.run(call(derived.id))
          const forgetting = outcome(forgetter.run(forgetQuery([root.id], 'the scheduler was removed')))
          await waitUntilLockWait(pg, forgetterPid)
          const acting = await outcome(actor.run(call(root.id)))
          const committing = await outcome(actor.run('COMMIT;'))
          const forgot = await forgetting

          expect(acting).not.toMatch(/40P01|deadlock/)
          expect(committing).not.toMatch(/ERROR/)
          expect(forgot).not.toMatch(/40P01|deadlock/)
          expect(JSON.parse(forgot) as Effect[]).toEqual([
            { itemId: root.id, effect: 'forgotten', via: null },
            { itemId: derived.id, effect: 'forgotten', via: root.id },
          ])
        } finally {
          await actor.close()
          await forgetter.close()
        }
      },
      TEST_TIMEOUT_MS,
    )

    it.each(['engram_retire_items', 'engram_unretire_items'] as const)(
      'lets %s of two rows and an insert whose lineage names them in the other order both finish, without a deadlock',
      async (fn) => {
        // Ids rise in creation order: first < second. The retire locks first, then second. The insert's lineage
        // check runs at once here, so it holds second before it asks for first: the order a call inserting two
        // rows whose lineage names second, then first, takes at commit.
        const first = artifact('feat: the indexer', 0)
        const second = artifact('feat: the compactor', 10)
        await insertItems([first, second])
        if (fn === 'engram_unretire_items') await retire([first.id, second.id], 'parked')
        const fromSecond = observation('The compactor rewrites what the indexer built.', [second.id])
        const fromFirst = observation('The indexer feeds the compactor.', [first.id])
        const call =
          fn === 'engram_retire_items'
            ? `SELECT coalesce(json_agg(r.id ORDER BY r.id), '[]'::json) FROM public.engram_retire_items(${uuidArray([first.id, second.id])}, 'replaced by the planner') AS r(id);`
            : `SELECT coalesce(json_agg(r.id ORDER BY r.id), '[]'::json) FROM public.engram_unretire_items(${uuidArray([first.id, second.id])}) AS r(id);`
        const inserter = await pg.session()
        const actor = await pg.session()
        const outcome = (run: Promise<string>) => run.then((out) => out, (error: Error) => error.message)
        try {
          for (const session of [inserter, actor]) {
            await session.run('SET ROLE service_role;')
            await session.run('\\set VERBOSITY verbose')
          }
          const actorPid = await actor.run('SELECT pg_backend_pid();')
          await inserter.run('BEGIN;')
          await inserter.run('SET CONSTRAINTS public.memory_items_lineage IMMEDIATE;')
          await inserter.run(insertQuery([fromSecond]))
          const acting = outcome(actor.run(call))
          await waitUntilLockWait(pg, actorPid)
          const inserting = await outcome(inserter.run(insertQuery([fromFirst])))
          const committing = await outcome(inserter.run('COMMIT;'))
          const acted = await acting

          expect(inserting).not.toMatch(/40P01|deadlock/)
          expect(committing).not.toMatch(/ERROR/)
          expect(acted).not.toMatch(/40P01|deadlock/)
          expect(JSON.parse(acted) as string[]).toEqual([first.id, second.id].sort())
          expect(await rowCount([fromSecond.id, fromFirst.id])).toBe(2)
        } finally {
          await inserter.close()
          await actor.close()
        }
      },
      TEST_TIMEOUT_MS,
    )

    it('refuses 51 ids and a blank reason', async () => {
      const ids = Array.from({ length: 51 }, () => newId())
      expect(await refusal(`SELECT * FROM public.engram_retire_items(${uuidArray(ids)}, 'too many');`)).toMatch(
        /ERROR:\s+22023: engram_retire_items: p_ids must hold 1 to 50 ids and no NULL/,
      )
      expect(await refusal(`SELECT * FROM public.engram_retire_items(${uuidArray([newId()])}, '');`)).toMatch(
        /22023: engram_retire_items: p_reason must be non-blank/,
      )
      expect(await refusal(`SELECT * FROM public.engram_unretire_items(${uuidArray(ids)});`)).toMatch(
        /22023: engram_unretire_items: p_ids must hold 1 to 50 ids and no NULL/,
      )
    }, TEST_TIMEOUT_MS)
  })

  describe('engram_supersede_item', () => {
    it('lets a supersede and an insert whose lineage names both rows in the other order both finish, without a deadlock', async () => {
      // Ids: successor < older. The supersede locks its two rows in id order, the successor first. The insert's
      // lineage check runs at once here, so it holds the older row before it asks for the successor: the order a
      // call inserting two rows whose lineage names the older row, then the successor, takes at commit.
      const successorId = newId()
      const olderId = newId()
      const older = artifact('perf: the first cache layout', 0, { id: olderId })
      const successor = artifact('perf: the second cache layout', 30, { id: successorId })
      await insertItems([older, successor])
      const fromOlder = observation('The first layout keyed entries by path.', [older.id])
      const fromSuccessor = observation('The second layout keys entries by content hash.', [successor.id])
      const inserter = await pg.session()
      const superseder = await pg.session()
      const outcome = (run: Promise<string>) => run.then((out) => out, (error: Error) => error.message)
      try {
        for (const session of [inserter, superseder]) {
          await session.run('SET ROLE service_role;')
          await session.run('\\set VERBOSITY verbose')
        }
        const supersederPid = await superseder.run('SELECT pg_backend_pid();')
        await inserter.run('BEGIN;')
        await inserter.run('SET CONSTRAINTS ALL IMMEDIATE;')
        await inserter.run(insertQuery([fromOlder]))
        const superseding = outcome(superseder.run(`SELECT to_json(public.engram_supersede_item('${older.id}', '${successor.id}'));`))
        await waitUntilLockWait(pg, supersederPid)
        const inserting = await outcome(inserter.run(insertQuery([fromSuccessor])))
        const committing = await outcome(inserter.run('COMMIT;'))
        const superseded = await superseding

        expect(inserting).not.toMatch(/40P01|deadlock/)
        expect(committing).not.toMatch(/ERROR/)
        expect(superseded).not.toMatch(/40P01|deadlock/)
        expect(superseded).toBe('true')
        expect(await rowCount([fromOlder.id, fromSuccessor.id])).toBe(2)
        expect(await row(older.id, 'superseded_by')).toEqual({ superseded_by: successor.id })
      } finally {
        await inserter.close()
        await superseder.close()
      }
    }, TEST_TIMEOUT_MS)

    it('returns true, then false on a repeat, and ends validity at the successor', async () => {
      const a = artifact('perf: cache v1', 0)
      const b = artifact('perf: cache v2', 30)
      await insertItems([a, b])
      expect(await supersede(a.id, b.id)).toBe(true)
      expect(await supersede(a.id, b.id)).toBe(false)
      expect(await row(a.id, `superseded_by, valid_to = '${b.occurred_at}'::timestamptz AS ends_at_successor`)).toEqual({
        superseded_by: b.id,
        ends_at_successor: true,
      })
    }, TEST_TIMEOUT_MS)

    it("supersede sets valid_to to the successor's occurred_at", async () => {
      const a = artifact('perf: bounded', 0)
      const b = artifact('perf: replacement', 30)
      await insertItems([a, b])
      expect(await row(a.id, 'valid_to')).toEqual({ valid_to: null })
      expect(await supersede(a.id, b.id)).toBe(true)
      expect(
        await row(a.id, `valid_to = (SELECT n.occurred_at FROM public.memory_items n WHERE n.id = '${b.id}') AS ends_at_successor`),
      ).toEqual({ ends_at_successor: true })
    }, TEST_TIMEOUT_MS)

    it("the owner's direct UPDATE of valid_to cannot diverge from superseded_by", async () => {
      const a = artifact('perf: first pool size', 0)
      const b = artifact('perf: second pool size', 10)
      const c = artifact('perf: third pool size', 20)
      await insertItems([a, b, c])
      // service_role cannot UPDATE the table; the owner can, and the triggers hold valid_to for it too.
      const asOwner = (sql: string) => pg.psql(sql)

      await asOwner(`UPDATE public.memory_items SET valid_to = '${at(5)}' WHERE id = '${a.id}';`)
      expect(await row(a.id, 'valid_to')).toEqual({ valid_to: null })

      await asOwner(`UPDATE public.memory_items SET superseded_by = '${b.id}', valid_to = '${at(40)}' WHERE id = '${a.id}';`)
      expect(await row(a.id, `valid_to = '${b.occurred_at}'::timestamptz AS ends_at_b`)).toEqual({ ends_at_b: true })

      await asOwner(`UPDATE public.memory_items SET valid_to = NULL WHERE id = '${a.id}';`)
      await asOwner(`UPDATE public.memory_items SET valid_to = '${c.occurred_at}' WHERE id = '${a.id}';`)
      expect(await row(a.id, `superseded_by, valid_to = '${b.occurred_at}'::timestamptz AS ends_at_b`)).toEqual({
        superseded_by: b.id,
        ends_at_b: true,
      })

      // b is live, so the supersession stands and valid_to keeps following b.
      await expect(asOwner(`\\set VERBOSITY verbose\nUPDATE public.memory_items SET superseded_by = NULL WHERE id = '${a.id}';`)).rejects.toThrow(
        /ERROR:\s+23514: memory_items_before_update: superseded_by is replaced or cleared only once the item it names is forgotten or retired/,
      )
      expect(await row(a.id, `superseded_by, valid_to = '${b.occurred_at}'::timestamptz AS ends_at_b`)).toEqual({
        superseded_by: b.id,
        ends_at_b: true,
      })
    }, TEST_TIMEOUT_MS)

    it.each([
      ['an item of another class', () => [artifact('ci: a', 0), observation('CI runs on every push.', [], { occurred_at: at(10) })], /23514: engram_supersede_item: the items have different classes/],
      ['an equal event time', () => [artifact('ci: b', 0), artifact('ci: b2', 0)], /23514: engram_supersede_item: p_new did not occur later than p_old/],
      ['an earlier event time', () => [artifact('ci: c', 10), artifact('ci: c2', 0)], /23514: engram_supersede_item: p_new did not occur later than p_old/],
    ])('refuses %s', async (_label, build, reason) => {
      const [a, b] = build() as [ItemObject, ItemObject]
      await insertItems([a, b])
      expect(await refusal(`SELECT public.engram_supersede_item('${a.id}', '${b.id}');`)).toMatch(reason)
      expect(await row(a.id, 'superseded_by')).toEqual({ superseded_by: null })
    }, TEST_TIMEOUT_MS)

    it('refuses a p_old already superseded by a third item', async () => {
      const a = artifact('build: one', 0)
      const b = artifact('build: two', 10)
      const c = artifact('build: three', 20)
      await insertItems([a, b, c])
      expect(await supersede(a.id, b.id)).toBe(true)
      expect(await refusal(`SELECT public.engram_supersede_item('${a.id}', '${c.id}');`)).toMatch(
        /ERROR:\s+23514: engram_supersede_item: p_old is already superseded by another item/,
      )
      expect(await row(a.id, 'superseded_by')).toEqual({ superseded_by: b.id })
    }, TEST_TIMEOUT_MS)

    it('refuses a forgotten item, the same id twice and an unknown id', async () => {
      const a = artifact('test: kept', 0)
      const b = artifact('test: forgotten', 10)
      await insertItems([a, b])
      await forget([b.id], 'bad capture')
      expect(await refusal(`SELECT public.engram_supersede_item('${a.id}', '${b.id}');`)).toMatch(
        /ERROR:\s+23514: engram_supersede_item: a forgotten item neither supersedes nor is superseded/,
      )
      expect(await refusal(`SELECT public.engram_supersede_item('${a.id}', '${a.id}');`)).toMatch(
        /ERROR:\s+22023: engram_supersede_item: an item cannot supersede itself/,
      )
      expect(await refusal(`SELECT public.engram_supersede_item('${a.id}', '${newId()}');`)).toMatch(
        /ERROR:\s+22023: engram_supersede_item: p_new names no item/,
      )
    }, TEST_TIMEOUT_MS)
  })

  describe('engram_invariant_counts', () => {
    /** Empties the item tables; subjects stay. */
    async function emptyStore(): Promise<void> {
      await pg.psql(
        'TRUNCATE public.memory_item_entities, public.memory_item_links, public.memory_session_state, public.memory_items, public.memory_extraction_runs, public.memory_capture_events, public.memory_projects;',
      )
    }

    async function counts(): Promise<Array<[string, number]>> {
      return asService<Array<[string, number]>>(
        `SELECT coalesce(json_agg(json_build_array(r.name, r.violations) ORDER BY r.k), '[]'::json)
           FROM public.engram_invariant_counts() WITH ORDINALITY AS r(name, violations, k);`,
      )
    }

    function expected(violations: Partial<Record<(typeof ITEM_INVARIANTS)[number], number>> = {}): Array<[string, number]> {
      return ITEM_INVARIANTS.map((name) => [name, violations[name] ?? 0])
    }

    async function captureEvent(occurredAt: string): Promise<string> {
      keyCounter += 1
      return pg.psql(
        `INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload)
         VALUES ('tst-rpc-session', 'evt-${keyCounter}', 'user_prompt', '${occurredAt}', '{}'::jsonb) RETURNING id;`,
      )
    }

    /** A store that keeps every rule: registered scopes, utterances matching their events, a quoted statement. */
    async function validStore(): Promise<{ utteranceId: string; eventId: string }> {
      await emptyStore()
      await pg.psql(`INSERT INTO public.memory_projects (id, kind) VALUES ('tst-ws', 'workspace');
        INSERT INTO public.memory_projects (id, kind, workspace_id) VALUES ('tst-proj', 'project', 'tst-ws');`)
      const eventId = await captureEvent(at(1))
      const u = utterance('Tag releases from main only.', {
        occurred_at: at(1),
        project_id: 'tst-proj',
        workspace_id: 'tst-ws',
        source: { type: 'transcript', event_key: eventKey(), event_id: eventId },
      })
      const s = statement('Tag releases from main only.', [u.id], { project_id: 'tst-proj' })
      const decision = artifact('Releases are tagged from main.', 2, {
        kind: 'ledger_decision',
        source: { type: 'ledger', by: 'mk', quote: 'Tag releases from main only.', quote_source: 'tst-ledger#d1' },
      })
      const gone = utterance('Something said by mistake.', { source: { type: 'history', event_id: await captureEvent(at(0)) } })
      const goneStatement = statement('Something said by mistake.', [gone.id])
      await insertItems([u, s, decision, gone, goneStatement])
      await forget([gone.id], 'captured by mistake')
      return { utteranceId: u.id, eventId }
    }

    /** Inserts as postgres with triggers disabled; the CHECKs still apply. */
    async function insertPastTriggers(item: ItemObject): Promise<void> {
      const full = {
        lineage: [],
        restated_at: [],
        embedding_attempts: 0,
        created_at: at(0),
        ...item,
        content_hash: sha256Hex(item.content as string),
      }
      await pg.psql(`SET session_replication_role = replica;
        INSERT INTO public.memory_items SELECT * FROM jsonb_populate_record(NULL::public.memory_items, ${jsonb(full)});`)
    }

    it('reads zero for every invariant, in order, on an empty store', async () => {
      await emptyStore()
      expect(await counts()).toEqual(expected())
    }, TEST_TIMEOUT_MS)

    it('reads zero on a populated store that keeps every rule', async () => {
      await validStore()
      expect(await counts()).toEqual(expected())
    }, TEST_TIMEOUT_MS)

    it('counts one statement whose quote is not in its lineage', async () => {
      const { utteranceId } = await validStore()
      await insertPastTriggers(statement('Tag releases from any branch.', [utteranceId]))
      expect(await counts()).toEqual(expected({ quote_not_in_lineage: 1 }))
    }, TEST_TIMEOUT_MS)

    it('counts one live item whose lineage holds a forgotten item', async () => {
      await validStore()
      const a = artifact('feat: the source', 0)
      const o = observation('The source commit adds the importer.', [a.id])
      await insertItems([a, o])
      await pg.psql(`SET session_replication_role = replica;
        UPDATE public.memory_items SET forgotten_at = now(), forgotten_reason = 'past the cascade' WHERE id = '${a.id}';`)
      expect(await counts()).toEqual(expected({ lineage_to_forgotten: 1 }))
    }, TEST_TIMEOUT_MS)

    it('counts one utterance whose event has another time, then those with no event', async () => {
      const { eventId } = await validStore()
      await insertItems([utterance('Said a minute later.', { occurred_at: at(2), source: { type: 'transcript', event_id: eventId } })])
      expect(await counts()).toEqual(expected({ utterance_time_mismatch: 1 }))
      await insertItems([utterance('No event behind this one.', { source: { type: 'history' } })])
      expect(await counts()).toEqual(expected({ utterance_time_mismatch: 2 }))
      await insertItems([
        utterance('An event id too large to be one.', { source: { type: 'transcript', event_id: '123456789012345678901234' } }),
      ])
      expect(await counts()).toEqual(expected({ utterance_time_mismatch: 3 }))
    }, TEST_TIMEOUT_MS)

    it('counts one item with an unregistered project, then one whose workspace is a project', async () => {
      await validStore()
      await insertItems([artifact('chore: elsewhere', 0, { project_id: 'tst-unregistered' })])
      expect(await counts()).toEqual(expected({ unregistered_project: 1 }))
      await insertItems([artifact('chore: wrong scope kind', 0, { workspace_id: 'tst-proj' })])
      expect(await counts()).toEqual(expected({ unregistered_project: 2 }))
    }, TEST_TIMEOUT_MS)

    it('has no seedable assistant-authored claim: the CHECKs refuse both kinds even past the triggers', async () => {
      const { utteranceId } = await validStore()
      await expect(
        insertPastTriggers(statement('Tag releases from main only.', [utteranceId], { speaker: 'assistant' })),
      ).rejects.toThrow(/violates check constraint "memory_items_(speaker|assistant)_check"/)
      await expect(
        insertPastTriggers(artifact('An unquoted decision.', 0, { kind: 'ledger_decision', source: { type: 'ledger', by: 'mk' } })),
      ).rejects.toThrow(/violates check constraint "memory_items_mk_decision_check"/)
      expect(await counts()).toEqual(expected())
    }, TEST_TIMEOUT_MS)
  })
})
