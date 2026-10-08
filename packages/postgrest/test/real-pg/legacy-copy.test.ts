/**
 * engram_legacy_pending and engram_legacy_copy on real Postgres, called as
 * service_role the way the backfill CLI calls them through PostgREST:
 * - old episodes, digests and facts become legacy items under their old ids,
 *   dated by their own time, their latest input episode or their digest;
 * - each copied item gets the entities its batch row lists, in the same call;
 * - a supersession is linked only to a strictly later fact;
 * - what the old tables had forgotten is forgotten last, with everything
 *   built on it;
 * - a second run copies nothing, and no old table is written;
 * - a masked item, which has no vector, is listed for the embedding pass and
 *   one that kept its old vector is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const EP_FORGOTTEN = '00000000-0000-4000-8000-000000000101'
const EP_ASSISTANT = '00000000-0000-4000-8000-000000000102'
const EP_SUMMARY = '00000000-0000-4000-8000-000000000103'
const EP_MASKED = '00000000-0000-4000-8000-000000000104'
const EP_MISSING = '00000000-0000-4000-8000-000000000199'
const DIGEST_EARLY = '00000000-0000-4000-8000-000000000201'
const DIGEST_LATE = '00000000-0000-4000-8000-000000000202'
const FACT_OLD = '00000000-0000-4000-8000-000000000301'
const FACT_SAME_DIGEST = '00000000-0000-4000-8000-000000000302'
const FACT_LATER_DIGEST = '00000000-0000-4000-8000-000000000303'
const SUMMARY_SESSION = '00000000-0000-4000-8000-000000000777'
const NOT_AN_OLD_ROW = '00000000-0000-4000-8000-000000000999'

const OLD_SESSION = 'tst-old-session'
const MASKED_OLD_TEXT = 'deploy with the token tst-not-a-real-token'
const MASKED_TEXT = 'deploy with the token [masked]'
const MASK = { detector: 'tst-known-value', secret_name: 'TST_DEPLOY_TOKEN' }
const ASSISTANT_ENTITIES = [
  { entity: 'tst-release-repo', entity_type: 'repo' },
  { entity: 'docs/tst-release.md', entity_type: 'path' },
]

const PROJECT_MAP = {
  'tst-app-raw': { project_id: 'tst-app', workspace_id: 'tst-ws' },
  'tst-ws-raw': { project_id: null, workspace_id: 'tst-ws' },
}

const OLD_TABLES = ['memory_episodes', 'memory_digests', 'memory_semantic', 'memory_procedural'] as const

interface PendingRow {
  id: string
  text?: string
  superseded_by?: string
}

interface CopyRow {
  id: string
  content: string
  masks: Array<{ detector: string; secret_name: string | null }>
  entities?: Array<{ entity: string; entity_type: string }>
}

interface CopyResult {
  step: string
  copied: number
  remaining: number
  not_later?: number
  skipped?: number
}

interface ItemRow {
  class: string
  kind: string
  speaker: string
  trust: number
  project_id: string | null
  workspace_id: string | null
  session_id: string | null
  content: string
  search_text: string
  embedding_model: string | null
  embedding_copied: boolean
  occurred_at: string
  lineage: string[]
  source: Record<string, unknown>
  superseded_by: string | null
  forgotten: boolean
}

function text(value: string): string {
  return `convert_from(decode('${Buffer.from(value, 'utf8').toString('hex')}', 'hex'), 'UTF8')`
}

function jsonb(value: unknown): string {
  return `${text(JSON.stringify(value))}::jsonb`
}

const VECTOR = `('[0.5' || repeat(',0', 1535) || ']')::public.vector`

function toCopyRows(rows: readonly PendingRow[]): CopyRow[] {
  return rows.map((r) => {
    if (r.id === EP_MASKED) return { id: r.id, content: MASKED_TEXT, masks: [MASK] }
    if (r.id === EP_ASSISTANT) return { id: r.id, content: r.text!, masks: [], entities: ASSISTANT_ENTITIES }
    return { id: r.id, content: r.text!, masks: [] }
  })
}

describe.skipIf(!realPgImage)('the legacy copy on real Postgres', () => {
  let pg: RealPg
  let oldTablesBefore: string[]

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(`
      INSERT INTO public.memory_projects (id, kind) VALUES ('tst-ws', 'workspace');
      INSERT INTO public.memory_projects (id, kind, workspace_id) VALUES ('tst-app', 'project', 'tst-ws');
      INSERT INTO public.memory_episodes (id, session_id, role, content, embedding, metadata, created_at, project_id, forgotten_at) VALUES
        ('${EP_MASKED}', '${OLD_SESSION}', 'system', ${text(MASKED_OLD_TEXT)}, ${VECTOR}, '{}', '2026-03-01T09:00:00Z', 'tst-app-raw', NULL),
        ('${EP_FORGOTTEN}', '${OLD_SESSION}', 'user', 'the release goes out on fridays', ${VECTOR}, '{}', '2026-03-01T10:00:00Z', 'tst-app-raw', '2026-03-02T08:00:00Z'),
        ('${EP_ASSISTANT}', '${OLD_SESSION}', 'assistant', 'the release moved to thursdays', ${VECTOR},
         '{"source": "hook-stop", "type": "turn", "embedTextVersion": 2}', '2026-03-01T11:00:00Z', 'tst-ws-raw', NULL),
        ('${EP_SUMMARY}', 'claude-code-summaries', 'system', 'session summary: release planning', ${VECTOR},
         ${jsonb({ source: 'claude-code', type: 'session-summary', transcriptPath: `/home/tst/.claude/projects/tst/${SUMMARY_SESSION}.jsonl` })},
         '2026-03-01T12:00:00Z', NULL, NULL);
      INSERT INTO public.memory_digests (id, session_id, summary, embedding, episode_ids, created_at, project_id) VALUES
        ('${DIGEST_EARLY}', '${OLD_SESSION}', 'releases ship on fridays', ${VECTOR}, ARRAY['${EP_FORGOTTEN}', '${EP_MISSING}']::uuid[], '2026-03-01T13:00:00Z', 'tst-app-raw'),
        ('${DIGEST_LATE}', '${OLD_SESSION}', 'releases moved to thursdays', ${VECTOR}, ARRAY['${EP_ASSISTANT}']::uuid[], '2026-03-01T14:00:00Z', 'tst-app-raw');
      INSERT INTO public.memory_semantic (id, topic, content, embedding, source_digest_ids, created_at, project_id) VALUES
        ('${FACT_OLD}', 'release day', 'friday', ${VECTOR}, ARRAY['${DIGEST_EARLY}']::uuid[], '2026-03-01T13:05:00Z', 'tst-app-raw'),
        ('${FACT_SAME_DIGEST}', 'release day', 'friday afternoon', ${VECTOR}, ARRAY['${DIGEST_EARLY}']::uuid[], '2026-03-01T13:06:00Z', 'tst-app-raw'),
        ('${FACT_LATER_DIGEST}', 'release day', 'thursday', ${VECTOR}, ARRAY['${DIGEST_LATE}']::uuid[], '2026-03-01T14:05:00Z', 'tst-app-raw');
      UPDATE public.memory_semantic SET superseded_by = '${FACT_SAME_DIGEST}' WHERE id = '${FACT_OLD}';
      UPDATE public.memory_semantic SET superseded_by = '${FACT_LATER_DIGEST}' WHERE id = '${FACT_SAME_DIGEST}';`)
    oldTablesBefore = await oldTableDigests()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  async function asService<T>(sql: string): Promise<T> {
    return JSON.parse(await pg.psqlAs('service_role', sql)) as T
  }

  function pending(step: string, limit = 500): Promise<PendingRow[]> {
    return asService<PendingRow[]>(`SELECT public.engram_legacy_pending(${text(step)}, ${limit});`)
  }

  function copySql(step: string, rows: readonly CopyRow[] | null, map: unknown = PROJECT_MAP): string {
    return `SELECT public.engram_legacy_copy(${text(step)}, ${jsonb(map)}, ${rows === null ? 'NULL' : jsonb(rows)});`
  }

  function copy(step: string, rows: readonly CopyRow[] | null, map: unknown = PROJECT_MAP): Promise<CopyResult> {
    return asService<CopyResult>(copySql(step, rows, map))
  }

  async function refusal(sql: string): Promise<string> {
    try {
      await pg.psqlAs('service_role', sql)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('the call succeeded')
  }

  async function item(id: string): Promise<ItemRow> {
    return JSON.parse(
      await pg.psql(`
        SELECT json_build_object('class', i.class, 'kind', i.kind, 'speaker', i.speaker, 'trust', i.trust,
                 'project_id', i.project_id, 'workspace_id', i.workspace_id, 'session_id', i.session_id,
                 'content', i.content, 'search_text', i.search_text, 'embedding_model', i.embedding_model,
                 'embedding_copied', i.embedding IS NOT NULL AND i.embedding = ${VECTOR},
                 'occurred_at', to_char(i.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                 'lineage', i.lineage, 'source', i.source, 'superseded_by', i.superseded_by,
                 'forgotten', i.forgotten_at IS NOT NULL)
          FROM public.memory_items i WHERE i.id = '${id}'`),
    ) as ItemRow
  }

  async function entities(id: string): Promise<string> {
    return pg.psql(`SELECT coalesce(string_agg(entity_type || ':' || entity, ',' ORDER BY entity), '')
                      FROM public.memory_item_entities WHERE item_id = '${id}'`)
  }

  async function count(sql: string): Promise<number> {
    return Number(await pg.psql(sql))
  }

  async function oldTableDigests(): Promise<string[]> {
    const digests: string[] = []
    for (const table of OLD_TABLES) {
      digests.push(await pg.psql(`SELECT md5(coalesce(string_agg(t::text, '' ORDER BY t.id), '')) FROM public.${table} t`))
    }
    return digests
  }

  it('refuses a step while an earlier step has rows left, and an unknown step', async () => {
    expect(await refusal(`SELECT public.engram_legacy_pending('digests', 10);`)).toMatch(
      /engram_legacy_pending: step digests waits for step episodes, which has work left/,
    )
    expect(await refusal(copySql('forgets', null))).toMatch(
      /engram_legacy_copy: step forgets waits for step episodes, which has work left/,
    )
    expect(await refusal(copySql('procedures', []))).toMatch(/engram_legacy_copy: p_step must be one of/)
  }, TEST_TIMEOUT_MS)

  it('lists old episodes without an item oldest first, as id and text, up to p_limit', async () => {
    expect(await pending('episodes', 2)).toEqual([
      { id: EP_MASKED, text: MASKED_OLD_TEXT },
      { id: EP_FORGOTTEN, text: 'the release goes out on fridays' },
    ])
    expect((await pending('episodes')).map((r) => r.id)).toEqual([EP_MASKED, EP_FORGOTTEN, EP_ASSISTANT, EP_SUMMARY])
  }, TEST_TIMEOUT_MS)

  it('refuses a batch with an unmapped project, an unregistered one, an unknown id or an unreported text change', async () => {
    const rows = toCopyRows(await pending('episodes'))
    expect(await refusal(copySql('episodes', rows, { 'tst-ws-raw': PROJECT_MAP['tst-ws-raw'] }))).toMatch(
      /engram_legacy_copy: row 1: unmapped project value/,
    )
    expect(
      await refusal(copySql('episodes', rows, { ...PROJECT_MAP, 'tst-other-raw': { project_id: 'tst-nowhere', workspace_id: null } })),
    ).toMatch(/engram_legacy_copy: p_project_map key 'tst-other-raw' names a project that is not registered/)
    expect(await refusal(copySql('episodes', [{ id: NOT_AN_OLD_ROW, content: 'x', masks: [] }]))).toMatch(
      /engram_legacy_copy: row 1: id names no row of memory_episodes/,
    )
    expect(await refusal(copySql('episodes', [{ id: EP_MASKED, content: MASKED_TEXT, masks: [] }]))).toMatch(
      /engram_legacy_copy: row 1: content differs from the old text but lists no mask/,
    )
    const assistantRow = rows.find((r) => r.id === EP_ASSISTANT)!
    expect(
      await refusal(copySql('episodes', [{ ...assistantRow, entities: [{ entity: 'tst-release-repo' }] as never }])),
    ).toMatch(/engram_legacy_copy: row 1 has an entity other than \{entity, entity_type\} with string values/)
    expect(
      await refusal(copySql('episodes', [{ ...assistantRow, entities: [{ entity: 'tst-release-repo', entity_type: 'person' }] }])),
    ).toMatch(/memory_item_entities_entity_type_check/)
    expect(await count('SELECT count(*) FROM public.memory_items')).toBe(0)
    expect(await count('SELECT count(*) FROM public.memory_item_entities')).toBe(0)
    expect(await count('SELECT count(*) FROM public.memory_secret_hits')).toBe(0)
  }, TEST_TIMEOUT_MS)

  it('copies episodes as live legacy items under their old ids, a masked one without its vector', async () => {
    expect(await copy('episodes', toCopyRows(await pending('episodes')))).toEqual({ step: 'episodes', copied: 4, remaining: 0 })

    const forgotten = await item(EP_FORGOTTEN)
    expect(forgotten).toMatchObject({
      class: 'legacy', kind: 'legacy_episode', speaker: 'system', trust: 3, project_id: 'tst-app', workspace_id: 'tst-ws',
      session_id: OLD_SESSION, content: 'the release goes out on fridays', search_text: 'the release goes out on fridays',
      embedding_model: 'text-embedding-3-small', embedding_copied: true, occurred_at: '2026-03-01T10:00:00Z',
      lineage: [], forgotten: false,
    })
    expect(forgotten.source).toMatchObject({ producer: 'none', legacy_type: null, legacy_forgotten_at: '2026-03-02T08:00:00+00:00' })

    const assistant = await item(EP_ASSISTANT)
    expect(assistant).toMatchObject({ speaker: 'assistant', project_id: null, workspace_id: 'tst-ws' })
    expect(await entities(EP_ASSISTANT)).toBe('path:docs/tst-release.md,repo:tst-release-repo')
    expect(await entities(EP_FORGOTTEN)).toBe('')
    expect(assistant.source).toEqual({
      type: 'legacy', table: 'memory_episodes', id: EP_ASSISTANT, role: 'assistant', producer: 'hook-stop',
      legacy_type: 'turn', legacy_project: 'tst-ws-raw', legacy_session_id: OLD_SESSION, embed_text_version: 2,
      dangling_lineage: 0, time_basis: 'created_at', legacy_forgotten_at: null, legacy_superseded_by: null,
    })

    const summary = await item(EP_SUMMARY)
    expect(summary).toMatchObject({ speaker: 'system', session_id: SUMMARY_SESSION, project_id: null, workspace_id: null })
    expect(summary.source).toMatchObject({ legacy_session_id: 'claude-code-summaries', producer: 'claude-code', legacy_type: 'session-summary' })

    expect(await item(EP_MASKED)).toMatchObject({
      content: MASKED_TEXT, search_text: MASKED_TEXT, embedding_model: null, embedding_copied: false,
    })
    expect(
      await pg.psql(`SELECT target_table || '|' || target_id || '|' || field || '|' || detector || '|' || secret_name FROM public.memory_secret_hits`),
    ).toBe(`memory_items|${EP_MASKED}|content|${MASK.detector}|${MASK.secret_name}`)
  }, TEST_TIMEOUT_MS)

  it("copies digests with their episodes' items as lineage, dated at their latest input episode", async () => {
    const rows = await pending('digests')
    expect(rows.map((r) => r.id)).toEqual([DIGEST_EARLY, DIGEST_LATE])
    expect(await copy('digests', toCopyRows(rows))).toEqual({ step: 'digests', copied: 2, remaining: 0 })

    const early = await item(DIGEST_EARLY)
    expect(early).toMatchObject({
      class: 'legacy', kind: 'legacy_digest', speaker: 'system', trust: 3, session_id: OLD_SESSION,
      content: 'releases ship on fridays', occurred_at: '2026-03-01T10:00:00Z', lineage: [EP_FORGOTTEN],
      embedding_copied: true, forgotten: false,
    })
    expect(early.source).toMatchObject({ table: 'memory_digests', role: null, dangling_lineage: 1, time_basis: 'input_episodes' })
    expect(await item(DIGEST_LATE)).toMatchObject({ occurred_at: '2026-03-01T11:00:00Z', lineage: [EP_ASSISTANT] })
  }, TEST_TIMEOUT_MS)

  it("copies facts as topic and content, in their digest's session and at its time", async () => {
    const rows = await pending('facts')
    expect(rows).toEqual([
      { id: FACT_OLD, text: 'release day: friday' },
      { id: FACT_SAME_DIGEST, text: 'release day: friday afternoon' },
      { id: FACT_LATER_DIGEST, text: 'release day: thursday' },
    ])
    expect(await copy('facts', toCopyRows(rows))).toEqual({ step: 'facts', copied: 3, remaining: 0 })

    const old = await item(FACT_OLD)
    expect(old).toMatchObject({
      class: 'legacy', kind: 'legacy_fact', speaker: 'system', trust: 3, session_id: OLD_SESSION,
      project_id: 'tst-app', content: 'release day: friday', occurred_at: '2026-03-01T10:00:00Z',
      lineage: [DIGEST_EARLY], embedding_copied: true, superseded_by: null,
    })
    expect(old.source).toMatchObject({
      table: 'memory_semantic', legacy_session_id: null, time_basis: 'digest', dangling_lineage: 0,
      legacy_superseded_by: FACT_SAME_DIGEST,
    })
    expect(await item(FACT_SAME_DIGEST)).toMatchObject({ occurred_at: '2026-03-01T10:00:00Z' })
    expect(await item(FACT_LATER_DIGEST)).toMatchObject({ occurred_at: '2026-03-01T11:00:00Z', lineage: [DIGEST_LATE] })
  }, TEST_TIMEOUT_MS)

  it('links a supersession only to a strictly later fact and counts the same-digest pair as not_later', async () => {
    expect(await pending('fact_supersession')).toEqual([{ id: FACT_SAME_DIGEST, superseded_by: FACT_LATER_DIGEST }])
    expect(await copy('fact_supersession', null)).toEqual({
      step: 'fact_supersession', copied: 1, remaining: 0, not_later: 1, skipped: 0,
    })
    expect((await item(FACT_SAME_DIGEST)).superseded_by).toBe(FACT_LATER_DIGEST)
    expect((await item(FACT_OLD)).superseded_by).toBeNull()
  }, TEST_TIMEOUT_MS)

  it('forgets last what the old tables had forgotten, with the digest and facts built on it', async () => {
    expect(await pending('forgets')).toEqual([{ id: EP_FORGOTTEN }])
    expect(await copy('forgets', null)).toEqual({ step: 'forgets', copied: 1, remaining: 0 })

    for (const id of [EP_FORGOTTEN, DIGEST_EARLY, FACT_OLD, FACT_SAME_DIGEST]) {
      expect((await item(id)).forgotten).toBe(true)
    }
    for (const id of [EP_ASSISTANT, EP_SUMMARY, EP_MASKED, DIGEST_LATE, FACT_LATER_DIGEST]) {
      expect((await item(id)).forgotten).toBe(false)
    }
    expect(await pg.psql('SELECT sum(violations) FROM public.engram_invariant_counts()')).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('copies nothing on a second run', async () => {
    for (const step of ['episodes', 'digests', 'facts', 'fact_supersession', 'forgets']) {
      expect(await pending(step)).toEqual([])
    }
    for (const step of ['episodes', 'digests', 'facts']) {
      expect(await copy(step, [])).toEqual({ step, copied: 0, remaining: 0 })
    }
    expect(await copy('episodes', [{ id: EP_MASKED, content: MASKED_TEXT, masks: [MASK] }])).toEqual({
      step: 'episodes', copied: 0, remaining: 0,
    })
    expect(
      await copy('episodes', [{
        id: EP_ASSISTANT, content: 'the release moved to thursdays', masks: [],
        entities: [...ASSISTANT_ENTITIES, { entity: 'tst-other-repo', entity_type: 'repo' }],
      }]),
    ).toEqual({ step: 'episodes', copied: 0, remaining: 0 })
    expect(await count('SELECT count(*) FROM public.memory_item_entities')).toBe(2)
    expect(await copy('fact_supersession', null)).toEqual({
      step: 'fact_supersession', copied: 0, remaining: 0, not_later: 1, skipped: 0,
    })
    expect(await copy('forgets', null)).toEqual({ step: 'forgets', copied: 0, remaining: 0 })
    expect(await count('SELECT count(*) FROM public.memory_items')).toBe(9)
    expect(await count('SELECT count(*) FROM public.memory_secret_hits')).toBe(1)
  }, TEST_TIMEOUT_MS)

  it('lists the masked item for the embedding pass, never one that kept its vector, also after a second schema apply', async () => {
    const pendingEmbedding = (): Promise<string> =>
      pg.psqlAs('service_role', `SELECT coalesce(string_agg(id::text || '|' || search_text, ',' ORDER BY id), '')
                                   FROM public.engram_items_pending_embedding(256, '00000000-0000-4000-8000-00000000babe'::uuid);`)
    const indexDef = `SELECT c.oid::text || '|' || pg_catalog.pg_get_indexdef(c.oid) FROM pg_catalog.pg_class c
                       WHERE c.relname = 'idx_items_pending_embedding' AND c.relnamespace = 'public'::regnamespace`
    expect(await count("SELECT count(*) FROM public.memory_items WHERE class = 'legacy' AND embedding IS NOT NULL AND forgotten_at IS NULL")).toBe(4)
    expect(await pendingEmbedding()).toBe(`${EP_MASKED}|${MASKED_TEXT}`)

    const index = await pg.psql(indexDef)
    expect(index).not.toContain('legacy')
    await pg.applySchema()
    expect(await pg.psql(indexDef)).toBe(index)
    expect(await pendingEmbedding()).toBe(`${EP_MASKED}|${MASKED_TEXT}`)

    await pg.psqlAs('service_role', `SELECT public.engram_items_set_embeddings(jsonb_build_array(jsonb_build_object(
        'id', '${EP_MASKED}', 'model', 'text-embedding-3-small',
        'embedding', (SELECT jsonb_agg(0.25) FROM generate_series(1, 1536)))));`)
    expect(await pendingEmbedding()).toBe('')
  }, TEST_TIMEOUT_MS)

  it('leaves every old table unchanged and the items unchanged by a second schema apply', async () => {
    expect(await oldTableDigests()).toEqual(oldTablesBefore)
    const itemsDigest = "SELECT md5(string_agg(t::text, '' ORDER BY t.id)) FROM public.memory_items t"
    const before = await pg.psql(itemsDigest)
    await pg.applySchema()
    expect(await pg.psql(itemsDigest)).toBe(before)
    expect(await oldTableDigests()).toEqual(oldTablesBefore)
    expect(await pending('episodes')).toEqual([])
  }, TEST_TIMEOUT_MS)
})
