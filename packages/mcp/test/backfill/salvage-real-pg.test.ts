/**
 * The legacy salvage on real Postgres behind PostgREST, its rows copied in by
 * the legacy copy and its replies recorded (no model is called):
 * - the knowledge an assistant row states is stored as a trust-3 observation
 *   with that row as lineage and its time, in one commit with the run's stats;
 * - a re-run skips completed windows, and engram_salvage_begin returns NULL
 *   for a completed key;
 * - two unreadable replies fail the run and store nothing;
 * - a covered session, a forgotten row and an old-superseded fact are never shown;
 * - only service_role can execute engram_salvage_begin.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type CompleteJsonRequest, resetDefaultSecretRegistry } from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { PostgrestClient } from '@supabase/postgrest-js'
import { LEGACY_STEPS, postgrestLegacyCopyStore, runLegacyStep } from '../../src/backfill/legacy-copy.js'
import { type SalvageDeps, salvageSession, salvageSessions } from '../../src/backfill/salvage.js'
import { SALVAGE_VERSION } from '../../src/backfill/salvage-prompt.js'
import { postgrestSalvageStore } from '../../src/backfill/salvage-store.js'
import { parseProjectRegistry, registryRows } from '../../src/capture-events/project-registry.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../../postgrest/test/real-pg/harness.js'

const SETUP_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 120_000

const OPEN = 'tst-salvage-open'
const UNREADABLE = 'tst-salvage-unreadable'
const COVERED = 'tst-salvage-covered'
const EP_ASKED = '00000000-0000-4000-8000-000000000d01'
const EP_SAID = '00000000-0000-4000-8000-000000000d02'
const EP_FORGOTTEN = '00000000-0000-4000-8000-000000000d03'
const EP_UNREADABLE = '00000000-0000-4000-8000-000000000d04'
const EP_COVERED = '00000000-0000-4000-8000-000000000d05'
const DIGEST = '00000000-0000-4000-8000-000000000d21'
const FACT_OLD = '00000000-0000-4000-8000-000000000d31'
const FACT_NEW = '00000000-0000-4000-8000-000000000d32'
const COVERING_UTTERANCE = '00000000-0000-4000-8000-000000000d41'

const SAID_AT = '2026-03-02T09:01:30Z'
const REPLY = JSON.stringify({
  observations: [
    { claim: 'We decided to drop SQLite', kind: 'fact', subject: { new: 'Storage backend' }, evidence: [2], supersedes: [] },
    { claim: 'The store runs on Postgres only', kind: 'fact', subject: { new: 'Storage backend' }, evidence: [2], supersedes: [] },
  ],
})

const REGISTRY_DOC = {
  version: 1,
  workspaces: { 'tst-ws': { root: '/home/tester/tst-ws', vault_folder: null, register_prefix: null } },
  projects: { 'tst-app': { workspace: 'tst-ws', vault_folder: null, register_prefix: null } },
}

const VECTOR = `('[0.5' || repeat(',0', 1535) || ']')::public.vector`

function fakeModel(reply: string) {
  const requests: CompleteJsonRequest[] = []
  return {
    requests,
    intelligence: {
      completeJson: async (req: CompleteJsonRequest) => {
        requests.push(req)
        return { text: reply, finishReason: 'stop', model: 'tst-model' }
      },
    },
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('legacy salvage on real Postgres', () => {
  let pg: RealPg
  let dir: string
  let client: PostgrestClient
  let runs: PostgRestCaptureStore

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'engram-salvage-'))
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET: 'kv8-salvage-fixture-secret-4417' }))
    writeFileSync(join(dir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
    vi.stubEnv('ENGRAM_SECRET_SOURCES_FILE', join(dir, 'sources.json'))
    vi.stubEnv('XDG_CACHE_HOME', join(dir, 'cache'))
    resetDefaultSecretRegistry()

    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    const endpoint = await pg.startPostgrest()
    runs = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
    await runs.syncProjects(registryRows(parseProjectRegistry(REGISTRY_DOC)))
    client = new PostgrestClient(endpoint.url, {
      headers: { Authorization: `Bearer ${endpoint.serviceJwt}`, apikey: endpoint.serviceJwt },
    })

    // The install grants the old tables to service_role; the harness does not.
    await pg.psql(`
      GRANT SELECT ON public.memory_episodes, public.memory_digests, public.memory_semantic, public.memory_procedural
        TO service_role;
      INSERT INTO public.memory_episodes (id, session_id, role, content, embedding, metadata, created_at, project_id, forgotten_at) VALUES
        ('${EP_ASKED}', '${OPEN}', 'user', 'Asked whether the SQLite adapter should stay in tst-app.', ${VECTOR},
         '{"source": "claude-code-hook"}', '2026-03-02T09:00:00Z', 'tst-app', NULL),
        ('${EP_SAID}', '${OPEN}', 'assistant', 'Done. We decided to drop SQLite: the store runs on Postgres only.', ${VECTOR},
         '{"source": "claude-code-hook-stop"}', '${SAID_AT}', 'tst-app', NULL),
        ('${EP_FORGOTTEN}', '${OPEN}', 'assistant', 'forgotten-row-text', ${VECTOR},
         '{"source": "claude-code-hook-stop"}', '2026-03-02T09:00:30Z', 'tst-app', '2026-03-03T00:00:00Z'),
        ('${EP_UNREADABLE}', '${UNREADABLE}', 'assistant', 'The spool drains every 30 seconds.', ${VECTOR},
         '{"source": "claude-code-hook-stop"}', '2026-03-03T09:00:00Z', 'tst-app', NULL),
        ('${EP_COVERED}', '${COVERED}', 'assistant', 'covered-row-text', ${VECTOR},
         '{"source": "claude-code-hook-stop"}', '2026-03-03T10:00:00Z', 'tst-app', NULL);
      INSERT INTO public.memory_digests (id, session_id, summary, embedding, episode_ids, created_at, project_id) VALUES
        ('${DIGEST}', '${OPEN}', 'the store moved to Postgres', ${VECTOR}, ARRAY['${EP_SAID}']::uuid[], '2026-03-02T10:00:00Z', 'tst-app');
      INSERT INTO public.memory_semantic (id, topic, content, embedding, source_digest_ids, created_at, superseded_by, project_id) VALUES
        ('${FACT_NEW}', 'store', 'Store: Postgres only', ${VECTOR}, ARRAY['${DIGEST}']::uuid[], '2026-03-02T10:00:00Z', NULL, 'tst-app'),
        ('${FACT_OLD}', 'store', 'superseded-fact-text', ${VECTOR}, ARRAY['${DIGEST}']::uuid[], '2026-03-02T10:00:00Z', '${FACT_NEW}', 'tst-app');
      INSERT INTO public.memory_items
          (id, class, kind, speaker, trust, project_id, session_id, content, search_text, occurred_at, source, content_hash)
        VALUES ('${COVERING_UTTERANCE}', 'utterance', 'user_prompt', 'mk', 0, 'tst-app', '${COVERED}', 'covered words', 'covered words',
          '2026-03-03T10:00:00Z', '{"type": "transcript", "event_key": "tst-salvage-covered-1"}'::jsonb, md5('covered words'));`)

    const opts = {
      store: postgrestLegacyCopyStore(client),
      map: { 'tst-app': { project_id: 'tst-app', workspace_id: 'tst-ws' } },
      projects: [{ id: 'tst-app', kind: 'project' }],
      apply: true,
      log: () => {},
    }
    for (const step of LEGACY_STEPS) await runLegacyStep(opts, step)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
    vi.unstubAllEnvs()
    resetDefaultSecretRegistry()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TEST_TIMEOUT_MS)

  function deps(reply: string): SalvageDeps & { requests: CompleteJsonRequest[] } {
    const model = fakeModel(reply)
    return { store: postgrestSalvageStore(client), runs, intelligence: model.intelligence, model: 'tst-model', requests: model.requests }
  }

  const json = async <T>(sql: string): Promise<T> => JSON.parse(await pg.psql(sql)) as T

  it('lists the uncovered sessions oldest first', async () => {
    const sessions = await salvageSessions(postgrestSalvageStore(client))
    expect(sessions.map((s) => s.sessionId)).toEqual([OPEN, UNREADABLE])
  }, TEST_TIMEOUT_MS)

  it('stores the knowledge at trust 3 with the cited row as lineage and its time, in one commit with the run stats', async () => {
    const run = deps(REPLY)
    const result = await salvageSession(OPEN, run)

    expect(result.excluded).toEqual({ forgotten: 1, legacy_superseded: 1 })
    expect(run.requests).toHaveLength(1)
    const prompt = run.requests[0]!.user
    expect(prompt).toContain('[2] 2026-03-02 09:01 assistant: Done. We decided to drop SQLite')
    expect(prompt).not.toContain('forgotten-row-text')
    expect(prompt).not.toContain('superseded-fact-text')
    expect(prompt).toContain('fact: store: Store: Postgres only')

    const window = result.windows[0]!
    expect(window.status).toBe('stored')
    if (window.status !== 'stored') return
    const item = await json<Record<string, unknown>>(`
      SELECT to_jsonb(x) FROM (
        SELECT i.class, i.kind, i.speaker, i.trust, i.content, i.search_text, i.lineage, i.session_id, i.project_id,
               i.workspace_id, to_char(i.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
               i.source, s.label, i.extraction_run_id
          FROM public.memory_items i JOIN public.memory_subjects s ON s.id = i.subject_id
         WHERE i.id = '${window.itemIds[0]}') x`)
    expect(item).toEqual({
      class: 'observation',
      kind: 'fact',
      speaker: 'assistant',
      trust: 3,
      content: 'The store runs on Postgres only',
      search_text: 'Storage backend: The store runs on Postgres only',
      lineage: [EP_SAID],
      session_id: OPEN,
      project_id: 'tst-app',
      workspace_id: 'tst-ws',
      occurred_at: SAID_AT,
      source: {
        type: 'extraction',
        extractor: 'legacy-salvage',
        run_id: window.runId,
        window_key: window.key,
        time_basis: 'evidence',
      },
      label: 'Storage backend',
      extraction_run_id: window.runId,
    })

    const runRow = await json<Record<string, unknown>>(`
      SELECT to_jsonb(x) FROM (
        SELECT r.session_id, r.anchor_item_id, r.window_key, r.extractor_version, r.model, r.status, r.stats,
               (SELECT count(*) FROM public.memory_items i WHERE i.extraction_run_id = r.id) AS items
          FROM public.memory_extraction_runs r WHERE r.id = '${window.runId}') x`)
    expect(runRow).toMatchObject({
      session_id: OPEN,
      anchor_item_id: null,
      window_key: window.key,
      extractor_version: SALVAGE_VERSION,
      model: 'tst-model',
      status: 'succeeded',
      items: 1,
      stats: { rows_in: 4, proposed: 2, stored: 1, rejected_by_reason: { attributed: 1 }, attempts: 1, subjects_created: 1 },
    })
  }, TEST_TIMEOUT_MS)

  it('skips completed windows on a re-run, and engram_salvage_begin returns NULL for a completed key', async () => {
    const run = deps(REPLY)
    const result = await salvageSession(OPEN, run)
    expect(result).toMatchObject({ completed: 1, windows: [] })
    expect(run.requests).toHaveLength(0)
    expect((await salvageSessions(postgrestSalvageStore(client))).map((s) => s.sessionId)).toEqual([UNREADABLE])

    const key = await pg.psql(`SELECT window_key FROM public.memory_extraction_runs WHERE session_id = '${OPEN}'`)
    const begun = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(public.engram_salvage_begin('${OPEN}', '${key}', '${SALVAGE_VERSION}', NULL)::text, 'null')`,
    )
    expect(begun).toBe('null')
  }, TEST_TIMEOUT_MS)

  it('fails the run after two unreadable replies, stores nothing, and leaves the window pending', async () => {
    const run = deps('I found nothing durable here.')
    const result = await salvageSession(UNREADABLE, run)

    expect(run.requests).toHaveLength(2)
    expect(result.windows[0]).toMatchObject({ status: 'failed', fault: 'parse', attempts: 2 })
    const rows = await json<Array<Record<string, unknown>>>(`
      SELECT jsonb_agg(jsonb_build_object('status', r.status, 'stats', r.stats,
               'items', (SELECT count(*) FROM public.memory_items i WHERE i.extraction_run_id = r.id)))
        FROM public.memory_extraction_runs r WHERE r.session_id = '${UNREADABLE}'`)
    expect(rows).toEqual([
      {
        status: 'failed',
        items: 0,
        stats: { rows_in: 1, attempts: 2, fault: 'parse', failure: 'held', counted: true },
      },
    ])
    expect((await salvageSessions(postgrestSalvageStore(client))).map((s) => s.sessionId)).toEqual([UNREADABLE])
  }, TEST_TIMEOUT_MS)

  it('closes a run of the same window left open when the next one starts', async () => {
    const key = 'a'.repeat(64)
    const first = await pg.psqlAs('service_role', `SELECT public.engram_salvage_begin('${UNREADABLE}', '${key}', '${SALVAGE_VERSION}', NULL)`)
    const second = await pg.psqlAs('service_role', `SELECT public.engram_salvage_begin('${UNREADABLE}', '${key}', '${SALVAGE_VERSION}', NULL)`)
    expect(second).not.toBe(first)
    const statuses = await pg.psql(
      `SELECT string_agg(status || ':' || coalesce(stats ->> 'counted', '-'), ',' ORDER BY started_at, id)
         FROM public.memory_extraction_runs WHERE window_key = '${key}'`,
    )
    expect(statuses.split(',').sort()).toEqual(['failed:false', 'running:-'])
  }, TEST_TIMEOUT_MS)

  it('lets only service_role execute engram_salvage_begin', async () => {
    const call = `SELECT public.engram_salvage_begin('${OPEN}', '${'b'.repeat(64)}', '${SALVAGE_VERSION}', NULL)`
    await expect(pg.psqlAs('anon', call)).rejects.toThrow(/permission denied for function engram_salvage_begin/)
    await expect(pg.psqlAs('authenticated', call)).rejects.toThrow(/permission denied for function engram_salvage_begin/)
    await expect(pg.psqlAs('service_role', call)).resolves.toMatch(/^[0-9a-f-]{36}$/)
  }, TEST_TIMEOUT_MS)
})
