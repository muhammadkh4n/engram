/**
 * engram_forget_memories, engram_retire_memories and engram_unretire_memories
 * on real Postgres, called as service_role the way PostgREST calls them:
 * - a forget reaches item lineage, the old tables' derived rows and the
 *   legacy copies between them, in one transaction with one audit row;
 * - retire and unretire act on items only and report every id they were
 *   given, an id of the old tables as old_row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const SUBJECT_ID = '01950000-0000-7000-8000-00000000b000'
const T0 = Date.parse('2026-04-02T09:00:00Z')

interface ForgetRow {
  id: string
  store: string
  kind: string
  requested: boolean
  via: string | null
  effect: string
}

interface OutcomeRow {
  id: string
  outcome: string
  registerRef: string | null
}

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `01950000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`
}

let keyCounter = 0
function eventKey(): string {
  keyCounter += 1
  return `capture:tst-forget-session:turn-${keyCounter}`
}

function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString()
}

function text(value: string): string {
  return `convert_from(decode('${Buffer.from(value, 'utf8').toString('hex')}', 'hex'), 'UTF8')`
}

function jsonb(value: unknown): string {
  return `${text(JSON.stringify(value))}::jsonb`
}

function uuidArray(ids: readonly string[]): string {
  return `ARRAY[${ids.map((id) => `'${id}'`).join(', ')}]::uuid[]`
}

type ItemObject = Record<string, unknown> & { id: string }

function utterance(content: string): ItemObject {
  return {
    id: newId(),
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    trust: 0,
    session_id: 'tst-forget-session',
    content,
    search_text: content,
    occurred_at: at(0),
    source: { type: 'transcript', event_key: eventKey() },
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
    occurred_at: at(1),
    source: { type: 'extraction', event_key: `mk_statement:${eventKey()}` },
    lineage,
    standing: false,
    ...overrides,
  }
}

function sessionIndex(content: string, lineage: readonly string[]): ItemObject {
  return {
    id: newId(),
    class: 'session_index',
    kind: 'session',
    speaker: 'system',
    trust: 1,
    session_id: 'tst-forget-session',
    content,
    search_text: content,
    occurred_at: at(2),
    source: { type: 'transcript', event_key: `session_index:tst-forget-session:${keyCounter++}` },
    lineage,
  }
}

function legacy(kind: 'legacy_episode' | 'legacy_digest' | 'legacy_fact', oldId: string, content: string): ItemObject {
  return {
    id: newId(),
    class: 'legacy',
    kind,
    speaker: 'system',
    trust: 3,
    content,
    search_text: content,
    occurred_at: at(0),
    source: { type: 'legacy', id: oldId, event_key: `legacy:${oldId}` },
  }
}

function observation(content: string, lineage: readonly string[]): ItemObject {
  return {
    id: newId(),
    class: 'observation',
    kind: 'fact',
    speaker: 'assistant',
    trust: 3,
    subject_id: SUBJECT_ID,
    content,
    search_text: content,
    occurred_at: at(3),
    source: { type: 'legacy' },
    lineage,
  }
}

describe.skipIf(!realPgImage)('forget, retire and unretire by id on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(`INSERT INTO public.memory_subjects (id, label) VALUES ('${SUBJECT_ID}', 'build pipeline')`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  async function asService<T>(sql: string): Promise<T> {
    return JSON.parse(await pg.psqlAs('service_role', sql)) as T
  }

  async function insertItems(objects: readonly ItemObject[]): Promise<void> {
    await asService(`SELECT coalesce(json_agg(r.id), '[]'::json) FROM public.engram_insert_items(${jsonb(objects)}) AS r;`)
  }

  async function forget(ids: readonly string[], reason: string, channel = 'mcp'): Promise<ForgetRow[]> {
    return asService<ForgetRow[]>(
      `SELECT coalesce(json_agg(json_build_object('id', r.id, 'store', r.store, 'kind', r.kind, 'requested', r.requested,
                 'via', r.via, 'effect', r.effect) ORDER BY r.k), '[]'::json)
         FROM public.engram_forget_memories(${uuidArray(ids)}, ${text(reason)}, ${text(channel)})
              WITH ORDINALITY AS r(id, store, kind, requested, via, effect, k);`,
    )
  }

  async function outcomes(fn: 'engram_retire_memories' | 'engram_unretire_memories', ids: readonly string[], reason: string): Promise<OutcomeRow[]> {
    return asService<OutcomeRow[]>(
      `SELECT coalesce(json_agg(json_build_object('id', r.id, 'outcome', r.outcome, 'registerRef', r.register_ref) ORDER BY r.k), '[]'::json)
         FROM public.${fn}(${uuidArray(ids)}, ${text(reason)}, 'mcp') WITH ORDINALITY AS r(id, outcome, register_ref, k);`,
    )
  }

  async function refusal(sql: string): Promise<string> {
    try {
      await pg.psqlAs('service_role', `\\set VERBOSITY verbose\n${sql}`)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('the call succeeded')
  }

  async function forgottenAt(table: string, id: string): Promise<boolean> {
    return (await pg.psql(`SELECT forgotten_at IS NOT NULL FROM public.${table} WHERE id = '${id}'`)) === 't'
  }

  async function actionCount(): Promise<number> {
    return Number(await pg.psql('SELECT count(*) FROM public.memory_item_actions'))
  }

  async function episode(id: string): Promise<void> {
    await pg.psql(`INSERT INTO public.memory_episodes (id, session_id, role, content) VALUES ('${id}', 'tst-old', 'user', 'old turn ${id}')`)
  }

  it('forgetting an utterance forgets the statement and the session index built on it, each listed with via', async () => {
    const u = utterance('Run the nightly build at two.')
    const s = statement('Run the nightly build at two.', [u.id])
    const x = sessionIndex('Session about the nightly build.', [u.id])
    await insertItems([u, s, x])

    const rows = await forget([u.id], 'said in the wrong session')
    expect(rows).toEqual([
      { id: u.id, store: 'memory_items', kind: 'utterance/user_prompt', requested: true, via: null, effect: 'forgotten' },
      { id: s.id, store: 'memory_items', kind: 'mk_statement/ruling', requested: false, via: u.id, effect: 'forgotten' },
      { id: x.id, store: 'memory_items', kind: 'session_index/session', requested: false, via: u.id, effect: 'forgotten' },
    ])
  }, TEST_TIMEOUT_MS)

  it('forgetting an old episode reaches its digest, the facts and procedure built from both, their legacy items and a salvage observation', async () => {
    const [e, other, d, f, g, p] = [newId(), newId(), newId(), newId(), newId(), newId()]
    await episode(e)
    await episode(other)
    await pg.psql(`
      INSERT INTO public.memory_digests (id, session_id, summary, episode_ids) VALUES ('${d}', 'tst-old', 'digest of two turns', ${uuidArray([e, other])});
      INSERT INTO public.memory_semantic (id, topic, content, source_episode_ids) VALUES ('${f}', 'build', 'fact from the turn', ${uuidArray([e])});
      INSERT INTO public.memory_semantic (id, topic, content, source_digest_ids) VALUES ('${g}', 'build', 'fact from the digest', ${uuidArray([d])});
      INSERT INTO public.memory_procedural (id, category, trigger_text, procedure, metadata)
        VALUES ('${p}', 'workflow', 'when the build fails', 'rerun it once', ${jsonb({ sourceDigestIds: [d] })});`)
    const le = legacy('legacy_episode', e, 'old turn copied')
    const ld = legacy('legacy_digest', d, 'old digest copied')
    const lo = legacy('legacy_episode', other, 'the other old turn copied')
    await insertItems([le, ld, lo])
    const salvage = observation('The build reruns once on failure.', [ld.id])
    await insertItems([salvage])

    const rows = await forget([e], 'imported from the wrong machine')
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(rows[0]).toEqual({ id: e, store: 'memory_episodes', kind: 'episode', requested: true, via: null, effect: 'forgotten' })
    expect(byId.get(d)).toMatchObject({ store: 'memory_digests', kind: 'digest', requested: false, via: e })
    expect(byId.get(f)).toMatchObject({ store: 'memory_semantic', kind: 'semantic', via: e })
    expect(byId.get(g)).toMatchObject({ store: 'memory_semantic', via: d })
    expect(byId.get(p)).toMatchObject({ store: 'memory_procedural', kind: 'procedural', via: d })
    expect(byId.get(le.id)).toMatchObject({ store: 'memory_items', kind: 'legacy/legacy_episode', via: e })
    expect(byId.get(ld.id)).toMatchObject({ store: 'memory_items', kind: 'legacy/legacy_digest', via: d })
    expect(byId.get(salvage.id)).toMatchObject({ store: 'memory_items', kind: 'observation/fact', via: ld.id })
    expect(rows).toHaveLength(8)
    expect(rows.every((r) => r.effect === 'forgotten')).toBe(true)

    for (const [table, id] of [['memory_episodes', e], ['memory_digests', d], ['memory_semantic', f], ['memory_semantic', g], ['memory_procedural', p]] as const) {
      expect(await forgottenAt(table, id), `${table} ${id}`).toBe(true)
    }
    expect(await forgottenAt('memory_episodes', other)).toBe(false)
    expect(await forgottenAt('memory_items', lo.id)).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('forgetting a legacy_fact item tombstones its old semantic row', async () => {
    const sf = newId()
    await pg.psql(`INSERT INTO public.memory_semantic (id, topic, content) VALUES ('${sf}', 'build', 'a fact kept as legacy')`)
    const lf = legacy('legacy_fact', sf.toUpperCase(), 'a fact kept as legacy')
    await insertItems([lf])

    expect(await forget([lf.id], 'wrong fact')).toEqual([
      { id: lf.id, store: 'memory_items', kind: 'legacy/legacy_fact', requested: true, via: null, effect: 'forgotten' },
      { id: sf, store: 'memory_semantic', kind: 'semantic', requested: false, via: lf.id, effect: 'forgotten' },
    ])
    expect(await forgottenAt('memory_semantic', sf)).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('refuses 51 distinct ids, a blank reason, a 2,001-character reason and a bad channel', async () => {
    const ids = Array.from({ length: 51 }, () => newId())
    const call = (list: readonly string[], reason: string, channel = 'mcp') =>
      `SELECT * FROM public.engram_forget_memories(${uuidArray(list)}, ${text(reason)}, ${text(channel)});`
    expect(await refusal(call(ids, 'too many'))).toMatch(/22023.*engram_forget_memories: p_ids must hold 1 to 50 distinct ids/s)
    expect(await refusal(call([ids[0]!], '   '))).toMatch(/22023.*engram_forget_memories: p_reason must be non-blank/s)
    expect(await refusal(call([ids[0]!], 'x'.repeat(2001)))).toMatch(/22023.*p_reason must be non-blank and at most 2000/s)
    expect(await refusal(call([ids[0]!], 'fine', 'MCP channel'))).toMatch(/22023.*p_channel must be a lowercase name/s)
    for (const fn of ['engram_retire_memories', 'engram_unretire_memories']) {
      expect(await refusal(`SELECT * FROM public.${fn}(${uuidArray(ids)}, 'r', 'mcp');`)).toMatch(new RegExp(`22023.*${fn}: p_ids`, 's'))
      expect(await refusal(`SELECT * FROM public.${fn}(${uuidArray([ids[0]!])}, ' ', 'mcp');`)).toMatch(new RegExp(`22023.*${fn}: p_reason`, 's'))
    }
    // 50 distinct ids written twice are 50 ids.
    expect(await forget([...ids.slice(0, 50), ...ids.slice(0, 50)], 'duplicates')).toEqual([])
  }, TEST_TIMEOUT_MS)

  it('reports a re-forgotten id again, and re-forgetting an episode forgotten before digests had a tombstone takes its live digest', async () => {
    const u = utterance('Pin the toolchain version.')
    await insertItems([u])
    await forget([u.id], 'first')
    expect(await forget([u.id], 'again')).toEqual([
      { id: u.id, store: 'memory_items', kind: 'utterance/user_prompt', requested: true, via: null, effect: 'forgotten' },
    ])

    const [e, d] = [newId(), newId()]
    await episode(e)
    await pg.psql(`UPDATE public.memory_episodes SET forgotten_at = now() - interval '30 days' WHERE id = '${e}';
      INSERT INTO public.memory_digests (id, session_id, summary, episode_ids) VALUES ('${d}', 'tst-old', 'digest still served', ${uuidArray([e])});`)
    expect(await forget([e], 'again, with the digest')).toEqual([
      { id: e, store: 'memory_episodes', kind: 'episode', requested: true, via: null, effect: 'forgotten' },
      { id: d, store: 'memory_digests', kind: 'digest', requested: false, via: e, effect: 'forgotten' },
    ])
  }, TEST_TIMEOUT_MS)

  it('leaves an unknown id out of the result and writes one audit row per call that found anything', async () => {
    const u = utterance('Cache the dependency tarballs.')
    await insertItems([u])
    const unknown = newId()
    const before = await actionCount()

    expect(await forget([unknown], 'nothing there')).toEqual([])
    expect(await actionCount()).toBe(before)

    const rows = await forget([unknown, u.id], 'cached by mistake', 'openclaw')
    expect(rows.map((r) => r.id)).toEqual([u.id])
    expect(await actionCount()).toBe(before + 1)
    const audit = JSON.parse(
      await pg.psql(`SELECT row_to_json(a) FROM (SELECT action, requested, affected, reason, channel
                       FROM public.memory_item_actions ORDER BY id DESC LIMIT 1) a`),
    ) as { action: string; requested: string[]; affected: ForgetRow[]; reason: string; channel: string }
    expect(audit).toEqual({ action: 'forget', requested: [unknown, u.id], affected: rows, reason: 'cached by mistake', channel: 'openclaw' })
  }, TEST_TIMEOUT_MS)

  it('retire stores the reason, unretire clears it, and an old-table id or an unknown id is reported as such', async () => {
    const u = utterance('Ship the beta on Fridays.')
    const s = statement('Ship the beta on Fridays.', [u.id], {
      standing: true,
      register_status: 'recorded',
      register_ref: 'R-TST-7',
    })
    const plain = statement('Ship the beta on Fridays.', [u.id], { kind: 'fact', source: { type: 'extraction', event_key: `mk_statement:${eventKey()}` } })
    await insertItems([u, s, plain])
    const old = newId()
    await episode(old)
    const unknown = newId()
    const before = await actionCount()

    expect(await outcomes('engram_retire_memories', [s.id, plain.id, old, unknown], 'release day moved')).toEqual([
      { id: s.id, outcome: 'retired', registerRef: 'R-TST-7' },
      { id: plain.id, outcome: 'retired', registerRef: null },
      { id: old, outcome: 'old_row', registerRef: null },
      { id: unknown, outcome: 'not_found', registerRef: null },
    ])
    expect(JSON.parse(await pg.psql(`SELECT json_build_object('at', retired_at IS NOT NULL, 'reason', retired_reason) FROM public.memory_items WHERE id = '${s.id}'`))).toEqual({
      at: true,
      reason: 'release day moved',
    })
    expect(await outcomes('engram_retire_memories', [s.id], 'again')).toEqual([{ id: s.id, outcome: 'unchanged', registerRef: null }])

    expect(await outcomes('engram_unretire_memories', [s.id, old], 'moved back')).toEqual([
      { id: s.id, outcome: 'unretired', registerRef: null },
      { id: old, outcome: 'old_row', registerRef: null },
    ])
    expect(JSON.parse(await pg.psql(`SELECT json_build_object('at', retired_at, 'reason', retired_reason) FROM public.memory_items WHERE id = '${s.id}'`))).toEqual({
      at: null,
      reason: null,
    })
    expect(await outcomes('engram_unretire_memories', [s.id], 'not retired')).toEqual([{ id: s.id, outcome: 'unchanged', registerRef: null }])
    expect(await outcomes('engram_retire_memories', [old, unknown], 'old only')).toEqual([
      { id: old, outcome: 'old_row', registerRef: null },
      { id: unknown, outcome: 'not_found', registerRef: null },
    ])
    expect(await actionCount()).toBe(before + 4)
    expect(await pg.psql(`SELECT string_agg(action || ':' || reason, ',' ORDER BY id) FROM public.memory_item_actions WHERE id > (SELECT max(id) - 4 FROM public.memory_item_actions)`)).toBe(
      'retire:release day moved,retire:again,unretire:moved back,unretire:not retired',
    )
  }, TEST_TIMEOUT_MS)

  it('grants EXECUTE on the three functions to service_role only, and SELECT alone on the audit table', async () => {
    for (const fn of ['engram_forget_memories', 'engram_retire_memories', 'engram_unretire_memories']) {
      const signature = `public.${fn}(uuid[], text, text)`
      expect(await pg.psql(`SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')`)).toBe('t')
      expect(await pg.psql(`SELECT has_function_privilege('public', '${signature}', 'EXECUTE')`)).toBe('f')
    }
    expect(await pg.psql(`SELECT has_table_privilege('service_role', 'public.memory_item_actions', 'SELECT')`)).toBe('t')
    expect(await pg.psql(`SELECT has_table_privilege('service_role', 'public.memory_item_actions', 'INSERT')`)).toBe('f')
  }, TEST_TIMEOUT_MS)
})
