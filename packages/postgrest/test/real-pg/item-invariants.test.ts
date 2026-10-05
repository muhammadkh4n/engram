/**
 * The item store rules that the database enforces on every writer: the RPCs
 * and a direct PostgREST request alike. CHECK constraints hold the per-row
 * rules; triggers hold the rest:
 * - a statement attributed to MK quotes an utterance of MK's in its lineage,
 *   checked at commit, so the two may be inserted in either order;
 * - lineage names existing, unforgotten items;
 * - supersession points at a live item of the same class with a later event
 *   time;
 * - what was said never changes after insert, and forgetting is permanent;
 * - forgetting an item forgets what was derived from it and hands its
 *   supersessions to the next live successor or restores them;
 * - forgotten_at is set only by a transaction holding the forget lock
 *   exclusively, and an insert with lineage holds it shared, so forgets and
 *   lineage checks wait for each other instead of deadlocking.
 * Every refused write must leave no row behind (or the row unchanged).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, waitUntilLockWait, type PsqlSession, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const SUBJECT_ID = '01930000-0000-7000-8000-000000000000'
const T0 = Date.parse('2026-01-02T03:00:00Z')

interface QuoteCase {
  why: string
  input: string
  normalized: string
}

const QUOTE_CASES = JSON.parse(
  readFileSync(new URL('../../../core/src/items/quote.cases.json', import.meta.url), 'utf8'),
) as QuoteCase[]

interface Item {
  id: string
  class: string
  kind: string
  speaker: string
  trust: number
  content: string
  occurredAt: string
  subjectId: string | null
  source: Record<string, unknown>
  lineage: readonly string[]
  standing: boolean | null
  registerStatus?: string
  registerRef?: string
  contentHash?: string
  createdAt?: string
}

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `01930000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`
}

/** An event time `minutes` after a fixed origin. */
function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString()
}

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

/** A text literal carried as UTF-8 hex, so quotes, NBSPs and line breaks reach Postgres byte for byte. */
function text(value: string): string {
  return `convert_from(decode('${hex(value)}', 'hex'), 'UTF8')`
}

function uuidArray(ids: readonly string[]): string {
  return ids.length === 0 ? `'{}'::uuid[]` : `ARRAY[${ids.map((id) => `'${id}'`).join(', ')}]::uuid[]`
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function mkUtterance(content: string, overrides: Partial<Item> = {}): Item {
  return {
    id: newId(),
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    trust: 0,
    content,
    occurredAt: at(0),
    subjectId: null,
    source: { type: 'transcript' },
    lineage: [],
    standing: null,
    ...overrides,
  }
}

function assistantUtterance(content: string, overrides: Partial<Item> = {}): Item {
  return mkUtterance(content, { kind: 'assistant_turn', speaker: 'assistant', trust: 3, ...overrides })
}

function statement(content: string, lineage: readonly string[], overrides: Partial<Item> = {}): Item {
  return {
    id: newId(),
    class: 'mk_statement',
    kind: 'ruling',
    speaker: 'mk',
    trust: 0,
    content,
    occurredAt: at(0),
    subjectId: SUBJECT_ID,
    source: { type: 'extraction' },
    lineage,
    standing: false,
    ...overrides,
  }
}

function observation(content: string, lineage: readonly string[], overrides: Partial<Item> = {}): Item {
  return {
    id: newId(),
    class: 'observation',
    kind: 'fact',
    speaker: 'assistant',
    trust: 3,
    content,
    occurredAt: at(0),
    subjectId: SUBJECT_ID,
    source: { type: 'extraction' },
    lineage,
    standing: null,
    ...overrides,
  }
}

function artifact(content: string, overrides: Partial<Item> = {}): Item {
  return {
    id: newId(),
    class: 'artifact',
    kind: 'commit',
    speaker: 'artifact',
    trust: 1,
    content,
    occurredAt: at(0),
    subjectId: null,
    source: { type: 'git' },
    lineage: [],
    standing: null,
    ...overrides,
  }
}

/**
 * One INSERT; content_hash and created_at are sent only when the item names
 * them, and `extra` adds columns as SQL expressions.
 */
function insert(item: Item, extra: Record<string, string> = {}): string {
  const columns: Array<[string, string]> = [
    ['id', `'${item.id}'`],
    ['class', `'${item.class}'`],
    ['kind', `'${item.kind}'`],
    ['speaker', `'${item.speaker}'`],
    ['trust', String(item.trust)],
    ['subject_id', item.subjectId === null ? 'NULL' : `'${item.subjectId}'`],
    ['content', text(item.content)],
    ['search_text', text(item.content)],
    ['occurred_at', `'${item.occurredAt}'`],
    ['source', `${text(JSON.stringify(item.source))}::jsonb`],
    ['lineage', uuidArray(item.lineage)],
    ['standing', item.standing === null ? 'NULL' : String(item.standing)],
    ['register_status', item.registerStatus === undefined ? 'NULL' : `'${item.registerStatus}'`],
    ['register_ref', item.registerRef === undefined ? 'NULL' : text(item.registerRef)],
  ]
  if (item.contentHash !== undefined) columns.push(['content_hash', `'${item.contentHash}'`])
  if (item.createdAt !== undefined) columns.push(['created_at', `'${item.createdAt}'`])
  columns.push(...Object.entries(extra))
  return `INSERT INTO public.memory_items (${columns.map(([c]) => c).join(', ')})
    VALUES (${columns.map(([, v]) => v).join(', ')});`
}

function inTransaction(...statements: string[]): string {
  return ['BEGIN;', ...statements, 'COMMIT;'].join('\n')
}

/** The transaction-level advisory lock engram_forget_items holds exclusively while it forgets. */
const FORGET_LOCK_KEY = '7308892986227385959'

/** Runs `sql` in one statement that first takes the forget lock exclusively, as engram_forget_items does. */
function underForgetLock(sql: string): string {
  return `DO $forget$ BEGIN PERFORM pg_advisory_xact_lock(${FORGET_LOCK_KEY}); ${sql} END $forget$;`
}

/** A direct UPDATE that forgets one item, with nothing held. */
function bareForgetSql(id: string, reason: string, when = '2026-02-01T00:00:00Z'): string {
  return `UPDATE public.memory_items SET forgotten_at = '${when}', forgotten_reason = ${text(reason)} WHERE id = '${id}';`
}

/** A direct forget by a writer holding the forget lock, the only way forgotten_at may be set outside the RPC. */
function forgetSql(id: string, reason: string, when = '2026-02-01T00:00:00Z'): string {
  return underForgetLock(bareForgetSql(id, reason, when))
}

describe.skipIf(!realPgImage)('memory_items invariants on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(`INSERT INTO public.memory_subjects (id, label) VALUES ('${SUBJECT_ID}', 'release process')`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  async function commit(...items: Item[]): Promise<void> {
    await pg.psql(inTransaction(...items.map(insert)))
  }

  /** Runs SQL that must fail; returns the verbose error, which carries the SQLSTATE. */
  async function refusal(sql: string): Promise<string> {
    try {
      await pg.psql(`\\set VERBOSITY verbose\n${sql}`)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('the write was accepted')
  }

  async function expectCheckViolation(sql: string, reason: RegExp): Promise<string> {
    const message = await refusal(sql)
    expect(message).toMatch(/ERROR:\s+23514: /)
    expect(message).toMatch(reason)
    return message
  }

  async function rowCount(id: string): Promise<number> {
    return Number(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE id = '${id}'`))
  }

  async function column(id: string, expression: string): Promise<string> {
    return pg.psql(`SELECT ${expression} FROM public.memory_items WHERE id = '${id}'`)
  }

  async function verboseSession(): Promise<PsqlSession> {
    const session = await pg.session()
    await session.run('\\set VERBOSITY verbose')
    return session
  }

  async function failureOf(run: Promise<string>): Promise<string> {
    return run.then(
      () => {
        throw new Error('the statement succeeded')
      },
      (error: Error) => error.message,
    )
  }

  describe('refuses a write that breaks a rule, leaving no row', () => {
    it('an mk_statement spoken by the assistant', async () => {
      const u = mkUtterance('Keep the changelog short.')
      await commit(u)
      const s = statement('Keep the changelog short.', [u.id], { speaker: 'assistant' })
      await expectCheckViolation(insert(s), /violates check constraint "memory_items_(assistant|speaker)_check"/)
      expect(await rowCount(s.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('an mk_statement with an empty lineage', async () => {
      const s = statement('Nothing quoted.', [])
      await expectCheckViolation(insert(s), /violates check constraint "memory_items_statement_lineage_check"/)
      expect(await rowCount(s.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('an mk_statement with no subject', async () => {
      const u = mkUtterance('Tag every release.')
      await commit(u)
      const s = statement('Tag every release.', [u.id], { subjectId: null })
      await expectCheckViolation(insert(s), /violates check constraint "memory_items_subject_check"/)
      expect(await rowCount(s.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('an mk_statement whose quote is not in its utterance, at commit', async () => {
      const u = mkUtterance('Ship the release on Friday.')
      const s = statement('Ship the release on Monday.', [u.id])
      const session = await verboseSession()
      try {
        await session.run('BEGIN;')
        await session.run(insert(u))
        await session.run(insert(s))
        const message = await failureOf(session.run('COMMIT;'))
        expect(message).toMatch(/ERROR:\s+23514: memory_items_lineage: the quote does not occur in an mk utterance of its lineage/)
        expect(message).not.toContain('Monday')
      } finally {
        await session.close()
      }
      expect(await rowCount(u.id)).toBe(0)
      expect(await rowCount(s.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('an mk_statement quoting only an assistant utterance of its lineage', async () => {
      const mine = mkUtterance('What do you suggest?')
      const theirs = assistantUtterance('I suggest we rebase the branch before review.')
      await commit(mine, theirs)
      const s = statement('rebase the branch before review', [mine.id, theirs.id])
      await expectCheckViolation(
        inTransaction(insert(s)),
        /memory_items_lineage: the quote does not occur in an mk utterance of its lineage/,
      )
      expect(await rowCount(s.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('an artifact spoken by the assistant', async () => {
      const a = artifact('fix: a commit message', { speaker: 'assistant' })
      await expectCheckViolation(insert(a), /violates check constraint "memory_items_(assistant|speaker)_check"/)
      expect(await rowCount(a.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('an mk utterance with trust 3', async () => {
      const u = mkUtterance('Trust me on this.', { trust: 3 })
      await expectCheckViolation(insert(u), /violates check constraint "memory_items_trust_check"/)
      expect(await rowCount(u.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('an observation with trust 2 and no evidence', async () => {
      const o = observation('The build caches node_modules.', [], { trust: 2 })
      await expectCheckViolation(insert(o), /violates check constraint "memory_items_trust_check"/)
      expect(await rowCount(o.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it.each(['infinity', '-infinity'])('a direct insert of a non-finite occurred_at violates the finite check (%s)', async (when) => {
      const u = mkUtterance('An utterance with no real time.', { occurredAt: when })
      await expectCheckViolation(insert(u), /violates check constraint "memory_items_finite_check"/)
      expect(await rowCount(u.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it.each([
      ['retired_at', `retired_at = 'infinity', retired_reason = 'tst: retired forever'`],
      ['forgotten_at', `forgotten_at = '-infinity', forgotten_reason = 'tst: forgotten always'`],
      ['a restated_at element', `restated_at = ARRAY['${at(5)}', 'infinity']::timestamptz[]`],
    ])('an UPDATE that sets %s to a non-finite time violates the finite check', async (_label, assignment) => {
      const u = mkUtterance('Keep the times finite.')
      await commit(u)
      // Setting forgotten_at needs the forget lock, or the BEFORE trigger refuses it ahead of the CHECK.
      await expectCheckViolation(
        underForgetLock(`UPDATE public.memory_items SET ${assignment} WHERE id = '${u.id}';`),
        /violates check constraint "memory_items_finite_check"/,
      )
      expect(await column(u.id, `retired_at IS NULL AND forgotten_at IS NULL AND restated_at = '{}'`)).toBe('t')
    }, TEST_TIMEOUT_MS)

    it.each([
      ['ARRAY[NULL]', `ARRAY[NULL]::timestamptz[]`],
      ['a time and a NULL', `ARRAY['${at(5)}', NULL]::timestamptz[]`],
    ])('an UPDATE that sets restated_at to %s violates the finite check, so a read never meets a NULL restatement', async (_label, value) => {
      const u = mkUtterance('Restated without a time.')
      await commit(u)
      await expectCheckViolation(
        `UPDATE public.memory_items SET restated_at = ${value} WHERE id = '${u.id}';`,
        /violates check constraint "memory_items_finite_check"/,
      )
      expect(await column(u.id, `restated_at = '{}'`)).toBe('t')
    }, TEST_TIMEOUT_MS)

    it('a capture event at a non-finite occurred_at violates its finite check', async () => {
      await expectCheckViolation(
        `INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload)
           VALUES ('tst-finite-session', 'tst-finite-event', 'user_prompt', 'infinity', '{}'::jsonb);`,
        /violates check constraint "memory_capture_events_finite_check"/,
      )
      expect(
        Number(await pg.psql(`SELECT count(*) FROM public.memory_capture_events WHERE session_id = 'tst-finite-session'`)),
      ).toBe(0)
    }, TEST_TIMEOUT_MS)

    describe('superseded_by set by a direct UPDATE', () => {
      async function expectPointerRefused(old: Item, target: string, reason: RegExp): Promise<void> {
        await expectCheckViolation(
          `UPDATE public.memory_items SET superseded_by = '${target}' WHERE id = '${old.id}';`,
          reason,
        )
        expect(await column(old.id, `coalesce(superseded_by::text, 'none')`)).toBe('none')
      }

      it('to an item of another class', async () => {
        const old = mkUtterance('Use the staging bucket.', { occurredAt: at(10) })
        const other = artifact('chore: move to the staging bucket', { occurredAt: at(20) })
        await commit(old, other)
        await expectPointerRefused(old, other.id, /memory_items_before_update: superseded_by names an item of another class/)
      }, TEST_TIMEOUT_MS)

      it('to itself', async () => {
        const old = mkUtterance('Point at yourself.')
        await commit(old)
        await expectPointerRefused(old, old.id, /violates check constraint "memory_items_supersession_check"/)
      }, TEST_TIMEOUT_MS)

      it('to a forgotten item', async () => {
        const old = mkUtterance('Deploy from the laptop.', { occurredAt: at(10) })
        const gone = mkUtterance('Deploy from the server.', { occurredAt: at(20) })
        await commit(old, gone)
        await pg.psql(forgetSql(gone.id, 'tst: forgotten by hand'))
        await expectPointerRefused(old, gone.id, /memory_items_before_update: superseded_by names a forgotten item/)
      }, TEST_TIMEOUT_MS)

      it('to an item with an equal event time', async () => {
        const old = mkUtterance('Run the suite nightly.', { occurredAt: at(10) })
        const same = mkUtterance('Run the suite hourly.', { occurredAt: at(10) })
        await commit(old, same)
        await expectPointerRefused(old, same.id, /memory_items_before_update: superseded_by names an item that did not occur later/)
      }, TEST_TIMEOUT_MS)

      it('to an item with an earlier event time', async () => {
        const old = mkUtterance('Pin the toolchain.', { occurredAt: at(10) })
        const earlier = mkUtterance('Float the toolchain.', { occurredAt: at(5) })
        await commit(old, earlier)
        await expectPointerRefused(old, earlier.id, /memory_items_before_update: superseded_by names an item that did not occur later/)
      }, TEST_TIMEOUT_MS)
    })

    it('lineage naming an unknown id', async () => {
      const o = observation('Derived from nothing.', ['01930000-0000-7000-8000-999999999999'])
      await expectCheckViolation(inTransaction(insert(o)), /memory_items_lineage: lineage names an item that does not exist/)
      expect(await rowCount(o.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('lineage naming a forgotten item', async () => {
      const u = mkUtterance('Keep the old queue.')
      await commit(u)
      await pg.psql(forgetSql(u.id, 'tst: forgotten by hand'))
      const o = observation('The old queue stays.', [u.id])
      await expectCheckViolation(inTransaction(insert(o)), /memory_items_lineage: lineage contains a forgotten item/)
      expect(await rowCount(o.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('a source.event_key longer than 512 characters', async () => {
      const a = artifact('chore: an overlong key', { source: { type: 'git', event_key: `git:${'k'.repeat(509)}` } })
      await expectCheckViolation(insert(a), /violates check constraint "memory_items_source_check"/)
      expect(await rowCount(a.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    it('an entity within 2,000 characters but over 2,000 bytes, before the btree row limit', async () => {
      const a = artifact('chore: an entity in three-byte characters')
      await commit(a)
      const message = await expectCheckViolation(
        `INSERT INTO public.memory_item_entities (item_id, entity, entity_type) VALUES ('${a.id}', ${text('€'.repeat(1000))}, 'path');`,
        /violates check constraint "memory_item_entities_entity_check"/,
      )
      expect(message).not.toMatch(/54000|index row size/)
    }, TEST_TIMEOUT_MS)

    it('a project naming another project as its workspace', async () => {
      await pg.psql(`INSERT INTO public.memory_projects (id, kind) VALUES ('tst-inv-proj-a', 'project')`)
      const message = await refusal(
        `INSERT INTO public.memory_projects (id, kind, workspace_id) VALUES ('tst-inv-proj-b', 'project', 'tst-inv-proj-a');`,
      )
      expect(message).toMatch(/ERROR:\s+23503: /)
      expect(message).toMatch(/memory_projects_workspace_fkey/)
      expect(await pg.psql(`SELECT count(*) FROM public.memory_projects WHERE id = 'tst-inv-proj-b'`)).toBe('0')
    }, TEST_TIMEOUT_MS)

    it('turning a workspace that a project names into a project', async () => {
      await pg.psql(`INSERT INTO public.memory_projects (id, kind) VALUES ('tst-inv-ws', 'workspace');
        INSERT INTO public.memory_projects (id, kind, workspace_id) VALUES ('tst-inv-proj-c', 'project', 'tst-inv-ws');`)
      const message = await refusal(`UPDATE public.memory_projects SET kind = 'project' WHERE id = 'tst-inv-ws';`)
      expect(message).toMatch(/ERROR:\s+23503: /)
      expect(message).toMatch(/memory_projects_workspace_fkey/)
      expect(await pg.psql(`SELECT kind FROM public.memory_projects WHERE id = 'tst-inv-ws'`)).toBe('workspace')
    }, TEST_TIMEOUT_MS)

    it('a ledger decision by MK without its quote', async () => {
      const d = artifact('Use one item store.', {
        kind: 'ledger_decision',
        source: { type: 'ledger', by: 'mk', quote_source: 'tst-decisions.md' },
      })
      await expectCheckViolation(insert(d), /violates check constraint "memory_items_mk_decision_check"/)
      expect(await rowCount(d.id)).toBe(0)
    }, TEST_TIMEOUT_MS)

    describe('register columns', () => {
      let utteranceId: string
      const QUOTE = 'Always squash feature branches.'

      beforeAll(async () => {
        const u = mkUtterance(`OK. ${QUOTE}`)
        await commit(u)
        utteranceId = u.id
      }, TEST_TIMEOUT_MS)

      it('recorded without register_ref', async () => {
        const s = statement(QUOTE, [utteranceId], { standing: true, registerStatus: 'recorded' })
        await expectCheckViolation(insert(s), /violates check constraint "memory_items_register_check"/)
        expect(await rowCount(s.id)).toBe(0)
      }, TEST_TIMEOUT_MS)

      it('a plan register_ref whose slug is not a slug', async () => {
        const s = statement(QUOTE, [utteranceId], {
          standing: true,
          registerStatus: 'recorded',
          registerRef: 'plan:Tst Plan/x',
        })
        await expectCheckViolation(insert(s), /violates check constraint "memory_items_register_check"/)
        expect(await rowCount(s.id)).toBe(0)
      }, TEST_TIMEOUT_MS)

      it('a register_status on a statement that is not standing', async () => {
        const s = statement(QUOTE, [utteranceId], { standing: false, registerStatus: 'candidate' })
        await expectCheckViolation(insert(s), /violates check constraint "memory_items_register_check"/)
        expect(await rowCount(s.id)).toBe(0)
      }, TEST_TIMEOUT_MS)
    })

    describe('an UPDATE of what was said', () => {
      let u: Item

      beforeAll(async () => {
        u = mkUtterance('Freeze the schema on release day.', { occurredAt: at(30) })
        await commit(u)
      }, TEST_TIMEOUT_MS)

      it.each([
        ['content', `content = ${text('Thaw the schema.')}`],
        ['speaker', `speaker = 'assistant'`],
        ['occurred_at', `occurred_at = '${at(31)}'`],
      ])('of %s', async (name, assignment) => {
        await expectCheckViolation(
          `UPDATE public.memory_items SET ${assignment} WHERE id = '${u.id}';`,
          new RegExp(`memory_items_before_update: ${name} cannot change after insert`),
        )
        expect(await column(u.id, `content || '|' || speaker || '|' || (occurred_at = '${at(30)}')`)).toBe(
          'Freeze the schema on release day.|mk|true',
        )
      }, TEST_TIMEOUT_MS)
    })

    it('clearing forgotten_at, or changing it once set', async () => {
      const u = mkUtterance('Forget me for good.')
      await commit(u)
      await pg.psql(forgetSql(u.id, 'tst: forgotten by hand', '2026-02-01T00:00:00Z'))
      await expectCheckViolation(
        `UPDATE public.memory_items SET forgotten_at = NULL, forgotten_reason = NULL WHERE id = '${u.id}';`,
        /memory_items_before_update: forgotten_at cannot be cleared/,
      )
      await expectCheckViolation(
        forgetSql(u.id, 'tst: forgotten again', '2026-03-01T00:00:00Z'),
        /memory_items_before_update: forgotten_at and forgotten_reason are set once/,
      )
      expect(await column(u.id, `forgotten_at = '2026-02-01T00:00:00Z' AND forgotten_reason = 'tst: forgotten by hand'`)).toBe('t')
    }, TEST_TIMEOUT_MS)

    describe('an INSERT of a row that is not born live and unsuperseded', () => {
      it('a forgotten mk_statement whose lineage names a missing id, refused before any lineage check', async () => {
        const s = statement('Ship the hotfix tonight.', [newId()])
        await expectCheckViolation(
          insert(s, { forgotten_at: `'2026-02-01T00:00:00Z'`, forgotten_reason: `'tst: born forgotten'` }),
          /memory_items_before_insert: a new item cannot carry forgotten_at, forgotten_reason/,
        )
        expect(await rowCount(s.id)).toBe(0)
      }, TEST_TIMEOUT_MS)

      it.each([
        ['superseded_by', (successor: string) => ({ superseded_by: `'${successor}'` }), /cannot carry superseded_by$/m],
        ['retired_at and retired_reason', () => ({ retired_at: `'2026-02-01T00:00:00Z'`, retired_reason: `'tst: born retired'` }), /cannot carry retired_at, retired_reason$/m],
        ['a restatement', () => ({ restated_at: `ARRAY['${at(5)}']::timestamptz[]` }), /cannot carry restated_at$/m],
        ['forgotten_at alone', () => ({ forgotten_at: `'2026-02-01T00:00:00Z'` }), /cannot carry forgotten_at$/m],
      ])('%s', async (_label, extra, reason) => {
        const successor = artifact('chore: the later commit', { occurredAt: at(30) })
        await commit(successor)
        const a = artifact('chore: the earlier commit', { occurredAt: at(10) })
        const message = await expectCheckViolation(insert(a, extra(successor.id)), /memory_items_before_insert: a new item cannot carry /)
        expect(message).toMatch(reason)
        expect(await rowCount(a.id)).toBe(0)
      }, TEST_TIMEOUT_MS)
    })
  })

  describe('accepts', () => {
    it('a recorded statement with a register entry id, and one with a plan ledger decision', async () => {
      const quote = 'Merges need a green build.'
      const u = mkUtterance(`Rule: ${quote}`)
      const register = statement(quote, [u.id], { standing: true, registerStatus: 'recorded', registerRef: 'R-TST-1' })
      const ledger = statement(quote, [u.id], {
        standing: true,
        registerStatus: 'recorded',
        registerRef: 'plan:tst-plan/MK-1a2b3c4d',
      })
      await commit(u, register, ledger)
      expect(await column(register.id, 'register_ref')).toBe('R-TST-1')
      expect(await column(ledger.id, 'register_ref')).toBe('plan:tst-plan/MK-1a2b3c4d')
    }, TEST_TIMEOUT_MS)

    it('a quote that differs from the utterance only by curly quotes, an NBSP and a line break', async () => {
      const u = mkUtterance(`Fine: don't ship until the "beta" build is green, ok?`)
      const s = statement('don\u2019t ship until the \u201cbeta\u201d build\nis\u00a0green', [u.id])
      await commit(u, s)
      expect(await rowCount(s.id)).toBe(1)
    }, TEST_TIMEOUT_MS)

    it('a statement inserted before its utterance in one transaction', async () => {
      const u = mkUtterance('Prefer small pull requests.')
      const s = statement('Prefer small pull requests.', [u.id])
      await pg.psql(inTransaction(insert(s), insert(u)))
      expect(await rowCount(s.id)).toBe(1)
      expect(await rowCount(u.id)).toBe(1)
    }, TEST_TIMEOUT_MS)

    it('an UPDATE of the embedding with its model', async () => {
      const u = mkUtterance('Embed me later.')
      await commit(u)
      await pg.psql(`UPDATE public.memory_items
        SET embedding = ('[' || array_to_string(array_fill(0.5::real, ARRAY[1536]), ',') || ']')::public.vector,
            embedding_model = 'tst-embedder'
        WHERE id = '${u.id}'`)
      expect(await column(u.id, `embedding_model || '|' || public.vector_dims(embedding)`)).toBe('tst-embedder|1536')
    }, TEST_TIMEOUT_MS)

    it('a client content_hash and created_at, replaced by the true hash and the insert time', async () => {
      const u = mkUtterance('Hash me properly.', { contentHash: '0'.repeat(64), createdAt: '2000-01-01T00:00:00Z' })
      await commit(u)
      expect(await column(u.id, 'content_hash')).toBe(sha256Hex('Hash me properly.'))
      expect(await column(u.id, `created_at > now() - interval '1 hour'`)).toBe('t')
    }, TEST_TIMEOUT_MS)

    it('an event key of 512 four-byte characters, which the unique index holds', async () => {
      const a = artifact('chore: the longest key', { source: { type: 'git', event_key: '𝄞'.repeat(512) } })
      await commit(a)
      expect(await column(a.id, `octet_length(source ->> 'event_key')`)).toBe('2048')
    }, TEST_TIMEOUT_MS)

    it('an entity of exactly 2,000 bytes, and a project in a workspace', async () => {
      const a = artifact('chore: the longest entity')
      await commit(a)
      await pg.psql(
        `INSERT INTO public.memory_item_entities (item_id, entity, entity_type) VALUES ('${a.id}', ${text('é'.repeat(1000))}, 'path');`,
      )
      await pg.psql(`INSERT INTO public.memory_projects (id, kind) VALUES ('tst-inv-ws-ok', 'workspace');
        INSERT INTO public.memory_projects (id, kind, workspace_id) VALUES ('tst-inv-proj-ok', 'project', 'tst-inv-ws-ok');`)
      expect(await pg.psql(`SELECT workspace_id FROM public.memory_projects WHERE id = 'tst-inv-proj-ok'`)).toBe('tst-inv-ws-ok')
    }, TEST_TIMEOUT_MS)

    it('a service_role insert through engram_insert_items, whose triggers run without any EXECUTE grant on them', async () => {
      const u = mkUtterance('Written by the service role.')
      const object = {
        id: u.id, class: u.class, kind: u.kind, speaker: u.speaker, trust: u.trust,
        content: u.content, search_text: u.content, occurred_at: u.occurredAt, source: u.source,
      }
      await pg.psqlAs('service_role', `SELECT count(*) FROM public.engram_insert_items(${text(JSON.stringify([object]))}::jsonb);`)
      expect(await column(u.id, 'content_hash')).toBe(sha256Hex('Written by the service role.'))
      const executable = await pg.psql(`
        SELECT count(*) FROM pg_proc p, unnest(ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']) AS r(role)
        WHERE p.pronamespace = 'public'::regnamespace AND p.prorettype = 'trigger'::regtype
          AND p.proname LIKE 'memory_items_%'
          AND CASE WHEN r.role = 'PUBLIC'
                   THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                   ELSE has_function_privilege(r.role, p.oid, 'EXECUTE') END`)
      expect(executable).toBe('0')
      expect(
        await pg.psql(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND prorettype = 'trigger'::regtype AND proname LIKE 'memory_items_%'`),
      ).toBe('5')
    }, TEST_TIMEOUT_MS)
  })

  describe('cascades', () => {
    it('forgetting an utterance forgets the statement quoting it and the observation built on that', async () => {
      const u = mkUtterance('Drop the legacy endpoint.')
      const s = statement('Drop the legacy endpoint.', [u.id])
      const o = observation('The legacy endpoint is gone.', [s.id])
      await commit(u, s, o)

      await pg.psql(forgetSql(u.id, 'tst: forgotten by hand', '2026-02-01T00:00:00Z'))

      expect(await column(u.id, 'forgotten_reason')).toBe('tst: forgotten by hand')
      for (const below of [s, o]) {
        expect(await column(below.id, `forgotten_at = '2026-02-01T00:00:00Z'`)).toBe('t')
        expect(await column(below.id, 'forgotten_reason')).toBe(`lineage: ${u.id} forgotten`)
      }
    }, TEST_TIMEOUT_MS)

    it('commits one transaction that inserts an utterance, derives from it and forgets it, all forgotten', async () => {
      const u = mkUtterance('Freeze the schema on Friday.')
      const s = statement('Freeze the schema on Friday.', [u.id])
      const o = observation('The schema freezes on Friday.', [s.id])

      await pg.psql(inTransaction(insert(u), insert(s), insert(o), forgetSql(u.id, 'tst: forgotten before commit')))

      expect(await column(u.id, 'forgotten_reason')).toBe('tst: forgotten before commit')
      for (const below of [s, o]) {
        expect(await column(below.id, 'forgotten_reason')).toBe(`lineage: ${u.id} forgotten`)
      }
    }, TEST_TIMEOUT_MS)

    it('commits one transaction that supersedes an item and forgets either side', async () => {
      const a = mkUtterance('Deploy from the tag.', { occurredAt: at(10) })
      const b = mkUtterance('Deploy from the branch.', { occurredAt: at(20) })
      const c = mkUtterance('Pin the base image.', { occurredAt: at(10) })
      const d = mkUtterance('Pin the base image digest.', { occurredAt: at(20) })

      await pg.psql(inTransaction(
        insert(a), insert(b), insert(c), insert(d),
        `UPDATE public.memory_items SET superseded_by = '${b.id}' WHERE id = '${a.id}';`,
        `UPDATE public.memory_items SET superseded_by = '${d.id}' WHERE id = '${c.id}';`,
        forgetSql(b.id, 'tst: successor forgotten before commit'),
        forgetSql(c.id, 'tst: superseded item forgotten before commit'),
      ))

      expect(await column(a.id, `coalesce(superseded_by::text, 'none') || '|' || (forgotten_at IS NULL)`)).toBe('none|true')
      expect(await column(c.id, `superseded_by::text || '|' || (forgotten_at IS NOT NULL)`)).toBe(`${d.id}|true`)
    }, TEST_TIMEOUT_MS)

    it('forgetting the only successor restores the item it superseded', async () => {
      const a = mkUtterance('Release monthly.', { occurredAt: at(10) })
      const b = mkUtterance('Release weekly.', { occurredAt: at(20) })
      await commit(a, b)
      await pg.psql(`UPDATE public.memory_items SET superseded_by = '${b.id}', valid_to = '${b.occurredAt}' WHERE id = '${a.id}'`)
      expect(await column(a.id, 'superseded_by')).toBe(b.id)

      await pg.psql(forgetSql(b.id, 'tst: forgotten by hand'))

      expect(await column(a.id, `coalesce(superseded_by::text, 'none') || '|' || coalesce(valid_to::text, 'none')`)).toBe(
        'none|none',
      )
      expect(await column(a.id, 'forgotten_at IS NULL')).toBe('t')
    }, TEST_TIMEOUT_MS)

    it('forgetting the middle of a chain re-points the first item to the last', async () => {
      const a = mkUtterance('Use port 8080.', { occurredAt: at(10) })
      const b = mkUtterance('Use port 8081.', { occurredAt: at(20) })
      const c = mkUtterance('Use port 8082.', { occurredAt: at(30) })
      await commit(a, b, c)
      await pg.psql(inTransaction(
        `UPDATE public.memory_items SET superseded_by = '${b.id}', valid_to = '${b.occurredAt}' WHERE id = '${a.id}';`,
        `UPDATE public.memory_items SET superseded_by = '${c.id}', valid_to = '${c.occurredAt}' WHERE id = '${b.id}';`,
      ))

      await pg.psql(forgetSql(b.id, 'tst: forgotten by hand'))

      expect(await column(a.id, 'superseded_by')).toBe(c.id)
      expect(await column(a.id, `valid_to = '${c.occurredAt}'`)).toBe('t')
      expect(await column(b.id, 'superseded_by')).toBe(c.id)
    }, TEST_TIMEOUT_MS)

    it('makes a forget wait for an open insert that derives from its item, then forgets the new row too', async () => {
      const u = mkUtterance('Race me to the commit.')
      await commit(u)
      const s = statement('Race me to the commit.', [u.id])
      const first = await verboseSession()
      const second = await verboseSession()
      try {
        const secondPid = await second.run('SELECT pg_backend_pid();')
        await first.run('BEGIN;')
        await first.run(insert(s))
        const forgetting = second.run(forgetSql(u.id, 'tst: forgotten while the insert is open'))
        await waitUntilLockWait(pg, secondPid)
        await first.run('COMMIT;')
        await forgetting
      } finally {
        await first.close()
        await second.close()
      }
      expect(await column(s.id, `forgotten_reason = 'lineage: ${u.id} forgotten'`)).toBe('t')
      expect(await column(u.id, 'forgotten_at IS NOT NULL')).toBe('t')
    }, TEST_TIMEOUT_MS)

    it('makes an insert with lineage wait for a running forget of its lineage, then fails its commit', async () => {
      const u = mkUtterance('Wait for the lock.')
      await commit(u)
      const s = statement('Wait for the lock.', [u.id])
      const first = await verboseSession()
      const second = await verboseSession()
      try {
        const pid = await first.run('SELECT pg_backend_pid();')
        await second.run('BEGIN;')
        await second.run(forgetSql(u.id, 'tst: forgotten while the other insert waits'))
        await first.run('BEGIN;')
        const inserting = first.run(insert(s))
        await waitUntilLockWait(pg, pid)
        await second.run('COMMIT;')
        await inserting
        expect(await failureOf(first.run('COMMIT;'))).toMatch(
          /ERROR:\s+23514: memory_items_lineage: lineage contains a forgotten item/,
        )
      } finally {
        await first.close()
        await second.close()
      }
      expect(await rowCount(s.id)).toBe(0)
      expect(await column(u.id, 'forgotten_at IS NOT NULL')).toBe('t')
    }, TEST_TIMEOUT_MS)

    it('makes a supersession commit wait for a concurrent forget of its target, then fails it', async () => {
      const a = mkUtterance('Cache for a day.', { occurredAt: at(10) })
      const b = mkUtterance('Cache for an hour.', { occurredAt: at(20) })
      await commit(a, b)
      const first = await verboseSession()
      const second = await verboseSession()
      try {
        const pid = await first.run('SELECT pg_backend_pid();')
        await first.run('BEGIN;')
        await first.run(`UPDATE public.memory_items SET superseded_by = '${b.id}', valid_to = '${b.occurredAt}' WHERE id = '${a.id}';`)
        await second.run('BEGIN;')
        await second.run(forgetSql(b.id, 'tst: forgotten while the other commit waits'))
        const committing = failureOf(first.run('COMMIT;'))
        await waitUntilLockWait(pg, pid)
        await second.run('COMMIT;')
        expect(await committing).toMatch(/ERROR:\s+23514: memory_items_supersession: superseded_by names a forgotten item/)
      } finally {
        await first.close()
        await second.close()
      }
      expect(await column(a.id, `coalesce(superseded_by::text, 'none')`)).toBe('none')
    }, TEST_TIMEOUT_MS)
  })

  // service_role may not write the table at all; the owner can, so the triggers still hold the lifecycle.
  describe('the item lifecycle under a direct UPDATE by the owner', () => {
    const asOwner = (sql: string) => pg.psql(sql)

    async function expectOwnerRefusal(sql: string, reason: RegExp): Promise<void> {
      await expectCheckViolation(sql, reason)
    }

    function pointSql(id: string, target: string | null): string {
      return `UPDATE public.memory_items SET superseded_by = ${target === null ? 'NULL' : `'${target}'`} WHERE id = '${id}';`
    }

    const SUCCESSOR_STILL_LIVE =
      /memory_items_before_update: superseded_by is replaced or cleared only once the item it names is forgotten or retired/
    const FORGOTTEN_LIFECYCLE = /memory_items_before_update: a forgotten item keeps its superseded_by, retired_at and retired_reason/

    it('points a live item at a live, later successor of its class', async () => {
      const a = artifact('build: cache off', { occurredAt: at(10) })
      const b = artifact('build: cache on', { occurredAt: at(20) })
      await commit(a, b)
      await asOwner(pointSql(a.id, b.id))
      expect(await column(a.id, `superseded_by::text || '|' || (valid_to = '${b.occurredAt}')`)).toBe(`${b.id}|true`)
    }, TEST_TIMEOUT_MS)

    it('refuses re-pointing an item to another successor while its successor is live', async () => {
      const a = artifact('ops: one replica', { occurredAt: at(10) })
      const b = artifact('ops: two replicas', { occurredAt: at(20) })
      const c = artifact('ops: three replicas', { occurredAt: at(30) })
      await commit(a, b, c)
      await asOwner(pointSql(a.id, b.id))
      await expectOwnerRefusal(pointSql(a.id, c.id), SUCCESSOR_STILL_LIVE)
      expect(await column(a.id, 'superseded_by')).toBe(b.id)
    }, TEST_TIMEOUT_MS)

    it('refuses clearing superseded_by while the successor is live', async () => {
      const a = artifact('ops: nightly backup', { occurredAt: at(10) })
      const b = artifact('ops: hourly backup', { occurredAt: at(20) })
      await commit(a, b)
      await asOwner(pointSql(a.id, b.id))
      await expectOwnerRefusal(pointSql(a.id, null), SUCCESSOR_STILL_LIVE)
      expect(await column(a.id, `superseded_by::text || '|' || (valid_to = '${b.occurredAt}')`)).toBe(`${b.id}|true`)
    }, TEST_TIMEOUT_MS)

    it('re-points an item to a valid successor, or clears it, once its successor is retired', async () => {
      const a = artifact('ops: weekly restore drill', { occurredAt: at(10) })
      const b = artifact('ops: daily restore drill', { occurredAt: at(20) })
      const c = artifact('ops: hourly restore drill', { occurredAt: at(30) })
      const earlier = artifact('ops: monthly restore drill', { occurredAt: at(5) })
      await commit(a, b, c, earlier)
      await asOwner(pointSql(a.id, b.id))
      await asOwner(`UPDATE public.memory_items SET retired_at = '2026-02-01T00:00:00Z', retired_reason = 'tst: daily drill dropped' WHERE id = '${b.id}';`)

      await expectOwnerRefusal(pointSql(a.id, earlier.id), /memory_items_before_update: superseded_by names an item that did not occur later/)
      await asOwner(pointSql(a.id, c.id))
      expect(await column(a.id, `superseded_by::text || '|' || (valid_to = '${c.occurredAt}')`)).toBe(`${c.id}|true`)

      await expectOwnerRefusal(pointSql(a.id, null), SUCCESSOR_STILL_LIVE)
      await asOwner(`UPDATE public.memory_items SET retired_at = '2026-02-02T00:00:00Z', retired_reason = 'tst: hourly drill dropped' WHERE id = '${c.id}';`)
      await asOwner(pointSql(a.id, null))
      expect(await column(a.id, `coalesce(superseded_by::text, 'none') || '|' || coalesce(valid_to::text, 'none')`)).toBe('none|none')
    }, TEST_TIMEOUT_MS)

    it('refuses changing superseded_by on a forgotten item', async () => {
      const a = artifact('docs: old runbook', { occurredAt: at(10) })
      const b = artifact('docs: new runbook', { occurredAt: at(20) })
      const c = artifact('docs: newest runbook', { occurredAt: at(30) })
      const d = artifact('docs: lone runbook', { occurredAt: at(10) })
      await commit(a, b, c, d)
      await asOwner(pointSql(a.id, b.id))
      await asOwner(forgetSql(a.id, 'tst: forgotten while superseded'))
      await asOwner(forgetSql(d.id, 'tst: forgotten while current'))
      await expectOwnerRefusal(pointSql(a.id, c.id), FORGOTTEN_LIFECYCLE)
      await expectOwnerRefusal(pointSql(a.id, null), FORGOTTEN_LIFECYCLE)
      await expectOwnerRefusal(pointSql(d.id, c.id), FORGOTTEN_LIFECYCLE)
      expect(await column(a.id, 'superseded_by')).toBe(b.id)
      expect(await column(d.id, `coalesce(superseded_by::text, 'none')`)).toBe('none')
    }, TEST_TIMEOUT_MS)

    it('refuses changing retired_at or retired_reason on a forgotten item', async () => {
      const retired = artifact('chore: retired then forgotten', { occurredAt: at(10) })
      const live = artifact('chore: forgotten while live', { occurredAt: at(10) })
      await commit(retired, live)
      await asOwner(`UPDATE public.memory_items SET retired_at = '2026-02-01T00:00:00Z', retired_reason = 'tst: stale' WHERE id = '${retired.id}';`)
      await asOwner(forgetSql(retired.id, 'tst: forgotten after retiring'))
      await asOwner(forgetSql(live.id, 'tst: forgotten unretired'))
      await expectOwnerRefusal(
        `UPDATE public.memory_items SET retired_at = NULL, retired_reason = NULL WHERE id = '${retired.id}';`,
        FORGOTTEN_LIFECYCLE,
      )
      await expectOwnerRefusal(
        `UPDATE public.memory_items SET retired_reason = 'tst: restated' WHERE id = '${retired.id}';`,
        FORGOTTEN_LIFECYCLE,
      )
      await expectOwnerRefusal(
        `UPDATE public.memory_items SET retired_at = '2026-03-01T00:00:00Z', retired_reason = 'tst: late' WHERE id = '${live.id}';`,
        FORGOTTEN_LIFECYCLE,
      )
      expect(await column(retired.id, `retired_reason`)).toBe('tst: stale')
      expect(await column(live.id, `retired_at IS NULL`)).toBe('t')
    }, TEST_TIMEOUT_MS)

    it('refuses a direct UPDATE that forgets an item while the forget lock is not held exclusively', async () => {
      const u = artifact('ci: forgotten by hand', { occurredAt: at(10) })
      const child = observation('The runner forgotten by hand built the release.', [u.id])
      await commit(u, child)
      const NOT_UNDER_LOCK = /memory_items_before_update: forgotten_at is set only while the transaction holds the forget lock exclusively/
      await expectOwnerRefusal(bareForgetSql(u.id, 'tst: no lock'), NOT_UNDER_LOCK)
      await expectOwnerRefusal(
        `DO $shared$ BEGIN PERFORM pg_advisory_xact_lock_shared(${FORGET_LOCK_KEY}); ${bareForgetSql(u.id, 'tst: shared lock')} END $shared$;`,
        NOT_UNDER_LOCK,
      )
      expect(await column(u.id, 'forgotten_at IS NULL')).toBe('t')
      expect(await column(child.id, 'forgotten_at IS NULL')).toBe('t')
    }, TEST_TIMEOUT_MS)

    it('keeps a passed forget-lock check only while the lock that passed it is held', async () => {
      const [first, second, third, fourth] = ['one', 'two', 'three', 'four'].map((n) =>
        artifact(`ci: runner ${n} forgotten by hand`, { occurredAt: at(10) }),
      )
      await commit(first!, second!, third!, fourth!)
      const NOT_UNDER_LOCK = /memory_items_before_update: forgotten_at is set only while the transaction holds the forget lock exclusively/
      // The lock taken under the savepoint goes with it, and so does the remembered check.
      await expectOwnerRefusal(
        [
          'BEGIN;',
          'SAVEPOINT tst_held;',
          `SELECT pg_advisory_xact_lock(${FORGET_LOCK_KEY});`,
          bareForgetSql(first!.id, 'tst: under the savepoint'),
          'ROLLBACK TO SAVEPOINT tst_held;',
          bareForgetSql(second!.id, 'tst: after the rollback'),
          'COMMIT;',
        ].join('\n'),
        NOT_UNDER_LOCK,
      )
      // A value set for the whole session, or left by an earlier transaction, names another transaction.
      await expectOwnerRefusal(
        `SET engram.forget_lock_xact = '1';\n${forgetSql(third!.id, 'tst: under the lock')}\n${bareForgetSql(fourth!.id, 'tst: next transaction')}`,
        NOT_UNDER_LOCK,
      )
      expect(await column(first!.id, 'forgotten_at IS NULL')).toBe('t')
      expect(await column(second!.id, 'forgotten_at IS NULL')).toBe('t')
      expect(await column(third!.id, 'forgotten_reason')).toBe('tst: under the lock')
      expect(await column(fourth!.id, 'forgotten_at IS NULL')).toBe('t')
    }, TEST_TIMEOUT_MS)

    it('refuses setting superseded_by in the UPDATE that forgets the item', async () => {
      const a = artifact('ci: one runner', { occurredAt: at(10) })
      const b = artifact('ci: two runners', { occurredAt: at(20) })
      await commit(a, b)
      await expectOwnerRefusal(
        underForgetLock(
          `UPDATE public.memory_items SET superseded_by = '${b.id}', forgotten_at = '2026-02-01T00:00:00Z', forgotten_reason = 'tst: both at once' WHERE id = '${a.id}';`,
        ),
        /memory_items_before_update: superseded_by cannot change on an item being forgotten/,
      )
      expect(await column(a.id, `coalesce(superseded_by::text, 'none') || '|' || (forgotten_at IS NULL)`)).toBe('none|true')
    }, TEST_TIMEOUT_MS)

    it('still lets the forget cascade re-point past a forgotten successor and then restore', async () => {
      const a = artifact('deps: lockfile v1', { occurredAt: at(10) })
      const b = artifact('deps: lockfile v2', { occurredAt: at(20) })
      const c = artifact('deps: lockfile v3', { occurredAt: at(30) })
      await commit(a, b, c)
      await asOwner(pointSql(a.id, b.id))
      await asOwner(pointSql(b.id, c.id))

      await asOwner(forgetSql(b.id, 'tst: v2 was never released'))
      expect(await column(a.id, `superseded_by::text || '|' || (valid_to = '${c.occurredAt}')`)).toBe(`${c.id}|true`)

      await asOwner(forgetSql(c.id, 'tst: v3 was reverted'))
      expect(await column(a.id, `coalesce(superseded_by::text, 'none') || '|' || coalesce(valid_to::text, 'none')`)).toBe(
        'none|none',
      )
    }, TEST_TIMEOUT_MS)
  })

  describe('engram_norm_quote', () => {
    let normalized: string[] = []

    beforeAll(async () => {
      const rows = QUOTE_CASES.map((c, i) => `(${i}, '${hex(c.input)}')`).join(', ')
      // An empty search_path: the function must resolve every name it uses by itself.
      const output = await pg.psql(`SET search_path TO '';
        SELECT v.ord || '|' || encode(convert_to(public.engram_norm_quote(convert_from(decode(v.h, 'hex'), 'UTF8')), 'UTF8'), 'hex')
        FROM (VALUES ${rows}) AS v(ord, h) ORDER BY v.ord`)
      normalized = output.split('\n').map((line) => Buffer.from(line.slice(line.indexOf('|') + 1), 'hex').toString('utf8'))
    }, TEST_TIMEOUT_MS)

    it('returns one result per shared quote case', () => {
      expect(normalized).toHaveLength(QUOTE_CASES.length)
    })

    it.each(QUOTE_CASES.map((c, i) => [c.why, i] as const))('%s', (_why, i) => {
      expect(normalized[i]).toBe(QUOTE_CASES[i]!.normalized)
    })

    it('is an immutable, parallel-safe SQL function the service role may call and anon may not', async () => {
      expect(
        await pg.psql(`SELECT p.provolatile::text || p.proparallel::text || l.lanname FROM pg_proc p
          JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.engram_norm_quote(text)'::regprocedure`),
      ).toBe('issql')
      expect(await pg.psqlAs('service_role', `SELECT public.engram_norm_quote(${text(' a\u00a0b ')})`)).toBe('a b')
      await expect(pg.psqlAs('anon', `SELECT public.engram_norm_quote('a')`)).rejects.toThrow(
        /permission denied for function engram_norm_quote/,
      )
    }, TEST_TIMEOUT_MS)
  })
})
