/**
 * legacy-copy and legacy-utterances end to end on real Postgres behind
 * PostgREST, with the capture route itself behind a local HTTP server:
 * - the plan lists every raw project value with the resolver's rule;
 * - a secret in an old row is masked before insert, logged by name, and its
 *   item has no copied vector; entities come from the scrubbed text;
 * - nothing is sent while a copy step, the forgets included, has work left;
 * - a forgotten row is never sent, a covered session is skipped, the cut flag
 *   follows the raw turn's length, and a second run gets duplicates only;
 * - the report's counts match the tables, and one seed reproduces it.
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetDefaultSecretRegistry, type SecretRegistryStatus } from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { PostgrestClient } from '@supabase/postgrest-js'
import { runBackfillCli } from '../../src/backfill/engram-backfill-cli.js'
import { LEGACY_STEPS, postgrestLegacyCopyStore, runLegacyStep } from '../../src/backfill/legacy-copy.js'
import { parseProjectRegistry, registryRows } from '../../src/capture-events/project-registry.js'
import { runCaptureEventsRequest } from '../../src/capture-events/route.js'
import { eventUuidFromParts } from '../../src/capture/event-uuid.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../../postgrest/test/real-pg/harness.js'

const SETUP_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 120_000
const HEALTHY: SecretRegistryStatus = { configured: true, unreadable: [], values: 1 }
const FIXTURE_SECRET = 'kv8-legacy-fixture-secret-7731'

const OPEN = 'tst-legacy-open'
const COVERED = 'tst-legacy-covered'
const EP_SAID = '00000000-0000-4000-8000-000000000b01'
const EP_NOTIFICATION = '00000000-0000-4000-8000-000000000b02'
const EP_LONG = '00000000-0000-4000-8000-000000000b03'
const EP_COVERED = '00000000-0000-4000-8000-000000000b04'
const EP_FORGOTTEN = '00000000-0000-4000-8000-000000000b05'
const EP_SECRET = '00000000-0000-4000-8000-000000000b06'
const EP_GONE_REPO = '00000000-0000-4000-8000-000000000b07'
const DIGEST = '00000000-0000-4000-8000-000000000b21'
const COVERING_UTTERANCE = '00000000-0000-4000-8000-000000000b31'

const LONG_TURN = `keep every word of this long prompt ${'and more '.repeat(500)}`.slice(0, 4000)
const SECRET_TEXT = `deploy tst-app/src/release.ts with the token ${FIXTURE_SECRET}`

const REGISTRY_DOC = {
  version: 1,
  workspaces: { 'tst-ws': { root: '/home/tester/tst-ws', vault_folder: null, register_prefix: null } },
  projects: { 'tst-app': { workspace: 'tst-ws', vault_folder: null, register_prefix: null } },
}
const REGISTRY = parseProjectRegistry(REGISTRY_DOC)

function text(value: string): string {
  return `convert_from(decode('${Buffer.from(value, 'utf8').toString('hex')}', 'hex'), 'UTF8')`
}

function hook(rawTurn: string): string {
  return `${text(JSON.stringify({ source: 'claude-code-hook', rawTurn }))}::jsonb`
}

const VECTOR = `('[0.5' || repeat(',0', 1535) || ']')::public.vector`

describe.skipIf(!realPgImage || !postgrestImage)('legacy copy and legacy utterances on real Postgres', () => {
  let pg: RealPg
  let route: Server
  let routeUrl: string
  let env: Record<string, string>
  let dir: string
  let client: PostgrestClient
  const copyLog: string[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'engram-legacy-'))
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET }))
    writeFileSync(join(dir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
    writeFileSync(join(dir, 'registry.json'), JSON.stringify(REGISTRY_DOC))
    writeFileSync(join(dir, 'capture-token'), 'tst-capture-token\n')
    vi.stubEnv('ENGRAM_SECRET_SOURCES_FILE', join(dir, 'sources.json'))
    vi.stubEnv('XDG_CACHE_HOME', join(dir, 'cache'))
    resetDefaultSecretRegistry()

    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    const endpoint = await pg.startPostgrest()
    const store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
    await store.syncProjects(registryRows(REGISTRY))
    client = new PostgrestClient(endpoint.url, {
      headers: { Authorization: `Bearer ${endpoint.serviceJwt}`, apikey: endpoint.serviceJwt },
    })
    env = {
      HOME: dir,
      SUPABASE_URL: endpoint.url,
      SUPABASE_KEY: endpoint.serviceJwt,
      ENGRAM_PROJECT_REGISTRY_FILE: join(dir, 'registry.json'),
    }

    route = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      req.on('end', () => {
        const deps = { store, ready: () => REGISTRY, status: () => HEALTHY, log: () => {} }
        runCaptureEventsRequest(deps, JSON.parse(body)).then(
          (reply) => {
            res.writeHead(reply.status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(reply.body))
          },
          () => {
            res.writeHead(500)
            res.end('{}')
          },
        )
      })
    })
    await new Promise<void>((resolve) => route.listen(0, '127.0.0.1', resolve))
    const address = route.address()
    routeUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

    // The server and the existing maintenance CLIs read the old tables as
    // service_role; schema.sql gives them RLS policies but leaves the table
    // grants to the install, and the harness grants nothing by default.
    await pg.psql(`
      GRANT SELECT ON public.memory_episodes, public.memory_digests, public.memory_semantic, public.memory_procedural
        TO service_role;
      INSERT INTO public.memory_episodes (id, session_id, role, content, embedding, metadata, created_at, project_id, forgotten_at) VALUES
        ('${EP_SAID}', '${OPEN}', 'user', 'User approved the release plan', ${VECTOR}, ${hook('ok go ahead with the release')},
         '2026-03-01T09:00:00Z', 'tst-app', NULL),
        ('${EP_NOTIFICATION}', '${OPEN}', 'user', 'A background task finished', ${VECTOR},
         ${hook('<task-notification>\n<task-id>tst-1</task-id>\n</task-notification>')}, '2026-03-01T09:01:00Z', 'tst-app', NULL),
        ('${EP_LONG}', '${OPEN}', 'user', 'User wrote a long prompt', ${VECTOR}, ${hook(LONG_TURN)}, '2026-03-01T09:02:00Z', 'tst-app', NULL),
        ('${EP_COVERED}', '${COVERED}', 'user', 'User asked again', ${VECTOR}, ${hook('covered words')}, '2026-03-01T09:03:00Z', 'tst-app', NULL),
        ('${EP_FORGOTTEN}', '${OPEN}', 'user', 'User said something forgotten', ${VECTOR}, ${hook('forget these words')},
         '2026-03-01T09:04:00Z', 'tst-app', '2026-03-02T00:00:00Z'),
        ('${EP_SECRET}', '${OPEN}', 'assistant', ${text(SECRET_TEXT)}, ${VECTOR}, '{"source": "hook-stop"}', '2026-03-01T09:05:00Z', 'tst-app', NULL),
        ('${EP_GONE_REPO}', '${OPEN}', 'assistant', 'an old note', ${VECTOR}, '{}', '2026-03-01T09:06:00Z', 'tst-gone-repo', NULL);
      INSERT INTO public.memory_digests (id, session_id, summary, embedding, episode_ids, created_at, project_id) VALUES
        ('${DIGEST}', '${OPEN}', 'the release was approved', ${VECTOR}, ARRAY['${EP_SAID}', '${EP_SECRET}']::uuid[], '2026-03-01T10:00:00Z', NULL);
      INSERT INTO public.memory_items
          (id, class, kind, speaker, trust, project_id, session_id, content, search_text, occurred_at, source, content_hash)
        VALUES ('${COVERING_UTTERANCE}', 'utterance', 'user_prompt', 'mk', 0, 'tst-app', '${COVERED}', 'covered words', 'covered words',
          '2026-03-01T09:03:00Z', '{"type": "transcript", "event_key": "tst-covered-1"}'::jsonb, md5('covered words'));`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await new Promise<void>((resolve) => (route ? route.close(() => resolve()) : resolve()))
    await pg?.stop()
    vi.unstubAllEnvs()
    resetDefaultSecretRegistry()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TEST_TIMEOUT_MS)

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = ''
    let err = ''
    const code = await runBackfillCli(argv, env, { out: (t) => (out += t), err: (t) => (err += t) })
    return { code, out, err }
  }

  const utterances = (): Promise<{ code: number; out: string; err: string }> =>
    cli('legacy-utterances', '--target', routeUrl, '--token-file', join(dir, 'capture-token'),
      '--state-dir', join(dir, 'state'), '--apply', '--json')

  const capturedEvents = async (): Promise<number> => Number(await pg.psql('SELECT count(*) FROM public.memory_capture_events'))

  it('plans the project map with each raw value and its rule', async () => {
    const run = await cli('legacy-copy', '--plan', '--map-out', join(dir, 'map.json'), '--json')
    expect(run.code, run.err).toBe(0)
    const plan = JSON.parse(run.out) as { entries: Array<Record<string, unknown>> }
    expect(plan.entries).toEqual([
      { raw: null, rows: { memory_episodes: 0, memory_digests: 1, memory_semantic: 0 }, project_id: null, workspace_id: null, rule: 'null_project' },
      { raw: 'tst-app', rows: { memory_episodes: 6, memory_digests: 0, memory_semantic: 0 }, project_id: 'tst-app', workspace_id: 'tst-ws', rule: 'repository' },
      { raw: 'tst-gone-repo', rows: { memory_episodes: 1, memory_digests: 0, memory_semantic: 0 }, project_id: null, workspace_id: null, rule: 'unregistered' },
    ])
    expect(JSON.parse(readFileSync(join(dir, 'map.json'), 'utf8'))).toEqual({
      'tst-app': { project_id: 'tst-app', workspace_id: 'tst-ws' },
      'tst-gone-repo': { project_id: null, workspace_id: null },
    })
  }, TEST_TIMEOUT_MS)

  it('sends nothing while the copy has work left, the forgets included', async () => {
    const before = await utterances()
    expect(before.code).toBe(1)
    expect(before.err).toMatch(/refused: the legacy copy step episodes has work left/)

    const map = JSON.parse(readFileSync(join(dir, 'map.json'), 'utf8')) as Record<string, never>
    const opts = { store: postgrestLegacyCopyStore(client), map, projects: [{ id: 'tst-app', kind: 'project' }], apply: true, log: (line: string) => copyLog.push(line) }
    for (const step of LEGACY_STEPS.slice(0, 4)) await runLegacyStep(opts, step)

    const beforeForgets = await utterances()
    expect(beforeForgets.code).toBe(1)
    expect(beforeForgets.err).toMatch(/refused: the legacy copy step forgets has work left/)
    expect(await capturedEvents()).toBe(0)
  }, TEST_TIMEOUT_MS)

  it('masks a seeded secret before insert, logs it by name, and keeps no vector for it', async () => {
    const run = await cli('legacy-copy', '--map', join(dir, 'map.json'), '--apply', '--json')
    expect(run.code, run.err).toBe(0)
    const summary = JSON.parse(run.out) as { steps: Array<{ step: string; remaining: number }> }
    expect(summary.steps.map((s) => [s.step, s.remaining])).toEqual(LEGACY_STEPS.map((s) => [s, 0]))
    expect(run.err).not.toContain(FIXTURE_SECRET)
    expect(copyLog.join('\n')).not.toContain(FIXTURE_SECRET)
    expect(copyLog).toContainEqual(expect.stringMatching(new RegExp(`^masked episodes ${EP_SECRET}: \\S+ FIXTURE_SECRET$`)))

    expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE content LIKE '%${FIXTURE_SECRET}%'`)).toBe('0')
    expect(await pg.psql(`SELECT (embedding IS NULL)::text || '|' || (forgotten_at IS NOT NULL)::text FROM public.memory_items WHERE id = '${EP_FORGOTTEN}'`)).toBe('false|true')
    expect(
      await pg.psql(`SELECT (embedding IS NULL)::text || '|' || coalesce(embedding_model, '-') FROM public.memory_items WHERE id = '${EP_SECRET}'`),
    ).toBe('true|-')
    expect(await pg.psql(`SELECT secret_name FROM public.memory_secret_hits WHERE target_id = '${EP_SECRET}'`)).toBe('FIXTURE_SECRET')
    expect(
      await pg.psql(`SELECT string_agg(entity_type || ':' || entity, ',' ORDER BY entity) FROM public.memory_item_entities WHERE item_id = '${EP_SECRET}'`),
    ).toBe('repo:tst-app,path:tst-app/src/release.ts')
  }, TEST_TIMEOUT_MS)

  it("sends MK's words from uncovered sessions only, never a forgotten row, and flags a cut turn", async () => {
    const run = await utterances()
    expect(run.code, run.err).toBe(0)
    expect(JSON.parse(run.out)).toMatchObject({
      candidates: 4, covered: 1, excluded: { empty: 1 }, sent: 2, accepted: 2, duplicates: 0, rejected: {}, stopped: null,
    })
    const events = JSON.parse(
      await pg.psql(`SELECT json_agg(json_build_object('session', session_id, 'uuid', event_uuid, 'payload', payload) ORDER BY occurred_at)
                       FROM public.memory_capture_events`),
    ) as Array<{ session: string; uuid: string; payload: { text: string; origin: Record<string, unknown> } }>
    expect(events.map((e) => [e.session, e.uuid, e.payload.origin])).toEqual([
      [OPEN, eventUuidFromParts('legacy', EP_SAID), { type: 'legacy', table: 'memory_episodes', id: EP_SAID, truncated: false }],
      [OPEN, eventUuidFromParts('legacy', EP_LONG), { type: 'legacy', table: 'memory_episodes', id: EP_LONG, truncated: true }],
    ])
    expect(events[0]!.payload.text).toBe('ok go ahead with the release')
    expect(events[1]!.payload.text).toBe(LONG_TURN)
  }, TEST_TIMEOUT_MS)

  it('gets duplicates only on a second run', async () => {
    await pg.psql('UPDATE public.memory_capture_events SET processed_at = now()')
    const run = await utterances()
    expect(run.code, run.err).toBe(0)
    expect(JSON.parse(run.out)).toMatchObject({ sent: 2, accepted: 0, duplicates: 2, stopped: null })
    expect(await capturedEvents()).toBe(2)
  }, TEST_TIMEOUT_MS)

  it('writes a report whose counts match the tables and that the same seed reproduces', async () => {
    const out = join(dir, 'report.md')
    const run = await cli('report', '--out', out, '--sample-seed', '11', '--json')
    expect(run.code, run.err).toBe(0)
    // The covering utterance is inserted without its capture event, so the
    // time invariant counts it; the report must show the store's own counts.
    const invariants = (await pg.psql(`SELECT string_agg(name || ' | ' || violations, E'\\n' ORDER BY name)
        FROM public.engram_invariant_counts()`)).split('\n')
    const violated = Number(await pg.psql('SELECT count(*) FROM public.engram_invariant_counts() WHERE violations <> 0'))
    expect(JSON.parse(run.out)).toMatchObject({ out, seed: 11, invariants_violated: violated, mk_words_excluded: 0, unprocessed_events: 0 })
    expect(statSync(out).mode & 0o777).toBe(0o600)
    const md = readFileSync(out, 'utf8')
    const episodes = await pg.psql(`SELECT concat_ws(' | ', 'memory_episodes', 'legacy_episode',
        (SELECT count(*) FROM public.memory_episodes),
        (SELECT count(*) FROM public.memory_episodes WHERE forgotten_at IS NOT NULL),
        (SELECT count(*) FROM public.memory_items WHERE class = 'legacy' AND kind = 'legacy_episode'),
        (SELECT count(*) FROM public.memory_items WHERE class = 'legacy' AND kind = 'legacy_episode' AND forgotten_at IS NOT NULL),
        (SELECT count(*) FROM public.memory_episodes o WHERE NOT EXISTS (SELECT 1 FROM public.memory_items i WHERE i.id = o.id)),
        (SELECT count(DISTINCT h.target_id) FROM public.memory_secret_hits h JOIN public.memory_items i ON i.id::text = h.target_id
          WHERE h.target_table = 'memory_items' AND h.field = 'content' AND i.kind = 'legacy_episode'))`)
    expect(md).toContain(`| ${episodes} |`)
    expect(md).toMatch(/\| memory_episodes \| legacy_episode \| \d+ \| \d+ \| \d+ \| \d+ \| 0 \| [1-9]\d* \|/)
    const mk = await pg.psql("SELECT count(*) FROM public.memory_items WHERE class = 'utterance' AND speaker = 'mk' AND forgotten_at IS NULL")
    expect(md).toContain(`0 of ${mk} MK utterances (must be 0).`)
    for (const line of invariants) expect(md).toContain(`| ${line} |`)
    expect(md).toContain(violated === 0 ? 'Every invariant holds.' : `${violated} invariant(s) violated.`)
    expect(md).toContain('| tst-app |')

    const again = await cli('report', '--out', join(dir, 'report-again.md'), '--sample-seed', '11')
    expect(again.code, again.err).toBe(0)
    const body = (text: string): string => text.replace(/^Generated .*$/m, '')
    expect(body(readFileSync(join(dir, 'report-again.md'), 'utf8'))).toBe(body(md))
  }, TEST_TIMEOUT_MS)
})
