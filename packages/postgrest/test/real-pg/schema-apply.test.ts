/**
 * schema.sql and bm25.sql against a real, empty PostgreSQL 17 with pgvector
 * and pg_textsearch. The schema's smoke block calls the recall RPCs at apply
 * time and aborts the transaction on any failure, so a clean exit means the
 * functions run, not only that they parse. Re-applying both files must leave
 * the catalog unchanged: every statement in them is written to be idempotent.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const UTTERANCE_ID = '01920000-0000-7000-8000-000000000001'
const UTTERANCE_TEXT = 'Keep the fixture rows across a re-apply.'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** An mk utterance with every required column, as a VALUES row for memory_items. */
function utteranceInsert(id: string, content: string, eventKey: string): string {
  return `INSERT INTO public.memory_items
      (id, class, kind, speaker, trust, project_id, session_id, content, search_text, occurred_at, source, content_hash)
    VALUES ('${id}', 'utterance', 'user_prompt', 'mk', 0, 'tst-project', 'tst-session', '${content}', '${content}',
      '2026-01-02T03:04:05Z', '{"type": "transcript", "event_key": "${eventKey}"}'::jsonb, '${sha256Hex(content)}')`
}

describe.skipIf(!realPgImage)('schema.sql and bm25.sql on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: Boolean(postgrestImage) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  it('starts on an empty database with the production roles and no default privileges', async () => {
    expect(await pg.psql("SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace")).toBe('0')
    expect(
      await pg.psql(
        `SELECT rolname, rolcanlogin, rolbypassrls, rolinherit FROM pg_roles
         WHERE rolname IN ('anon', 'authenticated', 'service_role', 'engram_authenticator') ORDER BY rolname`,
      ),
    ).toBe(
      [
        'anon|f|f|t',
        'authenticated|f|f|t',
        'engram_authenticator|t|f|f',
        'service_role|f|t|t',
      ].join('\n'),
    )
    expect(
      await pg.psql(
        `SELECT r.rolname FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles u ON u.oid = m.member
         WHERE u.rolname = 'engram_authenticator' ORDER BY r.rolname`,
      ),
    ).toBe('anon\nauthenticated\nservice_role')
    expect(await pg.psql('SELECT count(*) FROM pg_default_acl')).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('applies schema.sql then bm25.sql to the empty database', async () => {
    await pg.applySchema()

    expect(await pg.psql("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_textsearch') ORDER BY 1"))
      .toBe('pg_textsearch\nvector')
    expect(await pg.psql("SELECT to_regprocedure('public.engram_bm25_match(text[], integer, text, text, text[], text)') IS NOT NULL"))
      .toBe('t')
  }, TEST_TIMEOUT_MS)

  it('re-applies both files without changing the schema dump or the item store rows', async () => {
    await pg.psql(`
      INSERT INTO public.memory_projects (id, kind) VALUES ('tst-project', 'project');
      ${utteranceInsert(UTTERANCE_ID, UTTERANCE_TEXT, 'capture:tst-session:1')};
      INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload)
        VALUES ('tst-session', 'tst-event-1', 'user_prompt', '2026-01-02T03:04:05Z', '{"text": "hello"}'::jsonb);
    `)

    const before = await pg.dumpSchema()
    await pg.applySchema()
    const after = await pg.dumpSchema()

    expect(before).not.toMatch(/^\\(un)?restrict/m)
    expect(before).toContain('CREATE TABLE public.memory_episodes')
    expect(before).toContain('CREATE TABLE public.memory_items')
    expect(after).toBe(before)

    expect(await pg.psql("SELECT id || '|' || kind FROM public.memory_projects")).toBe('tst-project|project')
    expect(await pg.psql('SELECT id, content, content_hash FROM public.memory_items')).toBe(
      `${UTTERANCE_ID}|${UTTERANCE_TEXT}|${sha256Hex(UTTERANCE_TEXT)}`,
    )
    expect(await pg.psql('SELECT session_id, event_uuid, type FROM public.memory_capture_events')).toBe(
      'tst-session|tst-event-1|user_prompt',
    )
  }, TEST_TIMEOUT_MS)

  it('lets service_role read items and write them through an RPC, and refuses anon', async () => {
    const id = '01920000-0000-7000-8000-000000000002'
    const object = {
      id, class: 'utterance', kind: 'user_prompt', speaker: 'mk', trust: 0, project_id: 'tst-project',
      session_id: 'tst-session', content: 'Inserted by the service role.', search_text: 'Inserted by the service role.',
      occurred_at: '2026-01-02T03:04:05Z', source: { type: 'transcript', event_key: 'capture:tst-session:2' },
    }
    expect(
      await pg.psqlAs('service_role', `SELECT inserted FROM public.engram_insert_items('${JSON.stringify([object])}'::jsonb)`),
    ).toBe('t')
    expect(await pg.psqlAs('service_role', `SELECT content FROM public.memory_items WHERE id = '${id}'`)).toBe(
      'Inserted by the service role.',
    )
    await expect(pg.psqlAs('anon', 'SELECT count(*) FROM public.memory_items')).rejects.toThrow(
      /permission denied for table memory_items/,
    )
    expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE id = '${id}'`)).toBe('1')
  }, TEST_TIMEOUT_MS)

  it.each([
    ['memory_subjects', 'label'],
    ['memory_extraction_runs', 'status'],
    ['memory_projects', 'kind'],
    ['memory_items', 'content'],
    ['memory_item_entities', 'entity'],
    ['memory_capture_events', 'attempts'],
    ['memory_secret_hits', 'field'],
  ])('refuses service_role INSERT, UPDATE, DELETE and TRUNCATE on %s, and lets it SELECT', async (table, column) => {
    const denied = new RegExp(`permission denied for table ${table}`)
    for (const sql of [
      `INSERT INTO public.${table} DEFAULT VALUES`,
      `UPDATE public.${table} SET ${column} = ${column}`,
      `DELETE FROM public.${table}`,
      `TRUNCATE public.${table}`,
    ]) {
      await expect(pg.psqlAs('service_role', sql), sql).rejects.toThrow(denied)
    }
    expect(Number(await pg.psqlAs('service_role', `SELECT count(*) FROM public.${table}`))).toBeGreaterThanOrEqual(0)
    expect(
      await pg.psql(`SELECT concat_ws(',', has_table_privilege('service_role', 'public.${table}', 'SELECT'),
        has_table_privilege('service_role', 'public.${table}', 'INSERT'), has_table_privilege('service_role', 'public.${table}', 'UPDATE'),
        has_table_privilege('service_role', 'public.${table}', 'DELETE'), has_table_privilege('service_role', 'public.${table}', 'TRUNCATE'))`),
    ).toBe('t,f,f,f,f')
  }, TEST_TIMEOUT_MS)

  it('gives service_role nothing on the two id sequences', async () => {
    for (const sequence of ['memory_capture_events_id_seq', 'memory_secret_hits_id_seq']) {
      await expect(pg.psqlAs('service_role', `SELECT nextval('public.${sequence}')`)).rejects.toThrow(
        new RegExp(`permission denied for sequence ${sequence}`),
      )
      expect(
        await pg.psql(`SELECT has_sequence_privilege('service_role', 'public.${sequence}', 'USAGE, SELECT, UPDATE')`),
      ).toBe('f')
    }
  }, TEST_TIMEOUT_MS)

  it('ends with the same trigger function privileges after a re-apply over a service_role grant', async () => {
    const triggerAcls = () =>
      pg.psql(`SELECT p.proname || '|' || coalesce(p.proacl::text, 'default') FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace AND p.prorettype = 'trigger'::regtype
                 AND p.proname LIKE 'memory\\_items\\_%' ORDER BY p.proname`)
    const fresh = await triggerAcls()
    expect(fresh.split('\n')).toHaveLength(5)
    // A database whose default privileges give service_role EXECUTE on new functions holds this grant.
    await pg.psql(`GRANT EXECUTE ON FUNCTION public.memory_items_before_insert(), public.memory_items_before_update(),
      public.memory_items_lineage(), public.memory_items_supersession(), public.memory_items_forget_cascade() TO service_role`)
    expect(await pg.psql("SELECT has_function_privilege('service_role', 'public.memory_items_before_update()', 'EXECUTE')")).toBe('t')

    await pg.applySchema()

    expect(await triggerAcls()).toBe(fresh)
    expect(await pg.psql("SELECT has_function_privilege('service_role', 'public.memory_items_before_update()', 'EXECUTE')")).toBe('f')
  }, TEST_TIMEOUT_MS)

  it('replaces an insert function that returns an earlier result shape', async () => {
    const resultShape = () =>
      pg.psql("SELECT pg_get_function_result('public.engram_insert_items(jsonb)'::regprocedure)")
    const grants = () =>
      pg.psql(`SELECT r || '|' || has_function_privilege(r, 'public.engram_insert_items(jsonb)', 'EXECUTE')
               FROM unnest(ARRAY['service_role', 'anon', 'authenticated']) AS r ORDER BY r`)
    const fresh = { shape: await resultShape(), grants: await grants() }
    expect(fresh.shape).toContain('forgotten boolean')
    await pg.psql(`DROP FUNCTION public.engram_insert_items(jsonb);
      CREATE FUNCTION public.engram_insert_items(p_items jsonb) RETURNS TABLE(ord integer, id uuid, inserted boolean)
        LANGUAGE sql AS $$ SELECT 1, NULL::uuid, false $$`)
    expect(await resultShape()).not.toContain('forgotten')

    await pg.applySchema()

    expect(await resultShape()).toBe(fresh.shape)
    expect(await grants()).toBe(fresh.grants)
    expect(fresh.grants).toContain('service_role|t')
  }, TEST_TIMEOUT_MS)

  it('stores the storage parameters on memory_items', async () => {
    const options = (await pg.psql("SELECT unnest(reloptions) FROM pg_class WHERE oid = 'public.memory_items'::regclass"))
      .split('\n')
      .sort()
    expect(options).toEqual([
      'autovacuum_analyze_scale_factor=0.02',
      'autovacuum_vacuum_scale_factor=0.01',
      'autovacuum_vacuum_threshold=100',
      'fillfactor=90',
    ])
  }, TEST_TIMEOUT_MS)

  it('refuses an extraction run whose anchor names no item', async () => {
    await expect(
      pg.psql(`INSERT INTO public.memory_extraction_runs (anchor_item_id, extractor_version, status)
        VALUES ('01920000-0000-7000-8000-0000000000ff', 'tst-extractor-1', 'running')`),
    ).rejects.toThrow(/violates foreign key constraint "memory_extraction_runs_anchor_item_id_fkey"/)
    expect(await pg.psql('SELECT count(*) FROM public.memory_extraction_runs')).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('bounds an extraction run session_id to 1..256 characters, refused by name', async () => {
    const insertRun = (length: number) => `INSERT INTO public.memory_extraction_runs (session_id, extractor_version, status)
        VALUES (repeat('s', ${length}), 'tst-extractor-1', 'running');`
    for (const length of [0, 257]) {
      await expect(pg.psql(insertRun(length))).rejects.toThrow(
        /violates check constraint "memory_extraction_runs_session_id_check"/,
      )
    }
    expect(await pg.psql('SELECT count(*) FROM public.memory_extraction_runs')).toBe('0')
    expect(
      await pg.psql(`BEGIN; ${insertRun(256)} SELECT count(*) FROM public.memory_extraction_runs; ROLLBACK;`),
    ).toBe('1')
  }, TEST_TIMEOUT_MS)

  it('runs SQL under a role and refuses what that role may not do', async () => {
    const call = `SELECT public.engram_episode_kind('{"source": "git-commit"}'::jsonb, 'session-a')`
    expect(await pg.psqlAs('service_role', call)).toBe('commit')
    await expect(pg.psqlAs('anon', call)).rejects.toThrow(/permission denied for function engram_episode_kind/)
    await expect(pg.psqlAs('anon; DROP TABLE x', 'SELECT 1')).rejects.toThrow(/Not a plain role name/)
  }, TEST_TIMEOUT_MS)

  it('keeps transaction state in a session across runs and reports an error without closing it', async () => {
    const session = await pg.session()
    try {
      await session.run('BEGIN; CREATE TEMP TABLE harness_probe (n int) ON COMMIT DROP; INSERT INTO harness_probe VALUES (1), (2);')
      expect(await session.run('SELECT sum(n) FROM harness_probe;')).toBe('3')
      await expect(session.run('SELECT 1 / 0;')).rejects.toThrow(/division by zero/)
      await session.run('ROLLBACK;')
      expect(await session.run("SELECT 'still open';")).toBe('still open')
    } finally {
      await session.close()
    }
  }, TEST_TIMEOUT_MS)

  it.skipIf(!postgrestImage)('serves the RPCs through PostgREST to the service role only', async () => {
    const { url, serviceJwt } = await pg.startPostgrest()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const request = (headers: Record<string, string>) =>
      fetch(`${url}/rpc/engram_episode_kind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ p_metadata: { source: 'git-commit' }, p_session_id: 'session-a' }),
      })

    const asService = await request({ Authorization: `Bearer ${serviceJwt}` })
    expect(asService.status).toBe(200)
    expect(await asService.json()).toBe('commit')

    const asAnon = await request({})
    expect(asAnon.status).toBe(401)
    expect((await asAnon.json()).code).toBe('42501')
  }, TEST_TIMEOUT_MS)
})
