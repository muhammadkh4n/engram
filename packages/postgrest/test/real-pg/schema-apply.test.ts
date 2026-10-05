/**
 * schema.sql and bm25.sql against a real, empty PostgreSQL 17 with pgvector
 * and pg_textsearch. The schema's smoke block calls the recall RPCs at apply
 * time and aborts the transaction on any failure, so a clean exit means the
 * functions run, not only that they parse. Re-applying both files must leave
 * the catalog unchanged: every statement in them is written to be idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

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

  it('re-applies both files without changing the schema dump', async () => {
    const before = await pg.dumpSchema()
    await pg.applySchema()
    const after = await pg.dumpSchema()

    expect(before).not.toMatch(/^\\(un)?restrict/m)
    expect(before).toContain('CREATE TABLE public.memory_episodes')
    expect(after).toBe(before)
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
