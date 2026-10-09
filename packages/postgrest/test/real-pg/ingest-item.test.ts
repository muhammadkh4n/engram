/**
 * engram_ingest_item, through a real PostgREST in front of real Postgres: one
 * item written outside extraction goes through the extraction commit's apply
 * with no run.
 * - An MK statement is stored with no extraction run and its utterance's
 *   lineage; the session's index is made due for a rebuild.
 * - The same event key again answers the stored item as a duplicate.
 * - The same words on the same subject from a later utterance are a
 *   restatement of the current item; the same words in another project are
 *   a statement of their own.
 * - A corrects link is written with no run id.
 * - A link whose target is no longer current refuses the whole write.
 * - The payload is refused unless it holds one ingest_tool item with no run,
 *   and a statement's lineage starts with a stored utterance.
 * - Every write leaves the item invariants at zero, and no run row exists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  generateId,
  isItemConstraintError,
  itemEventKey,
  type ExtractionItem,
  type IngestItemWrite,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const SESSION = 'sess-ingest'
const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }
const OTHER = { id: 'tst-other', workspace: 'tst-ws', repo_root: '/home/tester/tst-other', branch: 'main', worktree: null }

let eventCounter = 0
function said(text: string, occurredAt: string, project = REPO): StoredEvent {
  eventCounter += 1
  return {
    sessionId: SESSION,
    eventUuid: `ingest-evt-${eventCounter}`,
    type: 'user_prompt',
    occurredAt,
    cwd: project.repo_root,
    project: { ...project },
    planDirs: [],
    client: { name: 'engram-test', version: '1.0.0' },
    payload: { text, transcript_line: eventCounter },
    scrub: { masked: [] },
    hits: [],
  }
}

interface Utterance {
  id: string
  at: string
  project: string
}

describe.skipIf(!realPgImage || !postgrestImage)('engram_ingest_item through PostgREST on real Postgres', () => {
  let pg: RealPg
  let store: PostgRestCaptureStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    const endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
    await store.syncProjects([
      { id: 'tst-ws', kind: 'workspace', workspaceId: null, vaultFolder: null, registerPrefix: null },
      { id: 'tst-repo', kind: 'project', workspaceId: 'tst-ws', vaultFolder: null, registerPrefix: null },
      { id: 'tst-other', kind: 'project', workspaceId: 'tst-ws', vaultFolder: null, registerPrefix: null },
    ])
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  beforeEach(async () => {
    await pg.psql(
      'TRUNCATE public.memory_item_links, public.memory_items, public.memory_capture_events, ' +
        'public.memory_extraction_runs, public.memory_subjects, public.memory_session_state CASCADE;',
    )
  })

  async function seed(...events: StoredEvent[]): Promise<Utterance[]> {
    const ingested = await store.ingestEvents(events)
    expect(ingested.map((e) => e.status)).toEqual(events.map(() => 'accepted'))
    expect(await store.materialize(1000)).toMatchObject({ locked: true, failed: 0 })
    return Promise.all(
      ingested.map(async (e, i) => ({
        id: await pg.psql(`SELECT id FROM public.memory_items WHERE source ->> 'event_id' = '${e.eventId}';`),
        at: events[i]!.occurredAt,
        project: events[i]!.project!.id,
      })),
    )
  }

  function statement(u: Utterance, quote: string, over: Partial<ExtractionItem> = {}): ExtractionItem {
    return {
      id: generateId(),
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      projectId: u.project,
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: SESSION,
      subjectId: null,
      subjectKey: 'storage',
      content: quote,
      searchText: quote,
      context: null,
      occurredAt: new Date(u.at),
      standing: false,
      registerStatus: null,
      source: { type: 'ingest_tool', utterance_id: u.id, event_key: itemEventKey('mk_statement', u.id, quote) },
      lineage: [u.id],
      entities: [],
      ...over,
    }
  }

  function observation(content: string, at: string, over: Partial<ExtractionItem> = {}): ExtractionItem {
    return {
      id: generateId(),
      class: 'observation',
      kind: 'finding',
      speaker: 'assistant',
      trust: 3,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: null,
      subjectId: null,
      subjectKey: 'storage',
      content,
      searchText: `Storage engine: ${content}`,
      context: null,
      occurredAt: new Date(at),
      standing: null,
      registerStatus: null,
      source: { type: 'ingest_tool', session_id: null, evidence: [], event_key: `observation:ingest:none:${content}` },
      lineage: [],
      entities: [],
      ...over,
    }
  }

  function write(item: ExtractionItem, project = item.projectId): IngestItemWrite {
    return { subjects: [{ key: 'storage', label: 'Storage engine', projectId: project }], item }
  }

  async function violations(): Promise<string> {
    return pg.psql('SELECT coalesce(sum(violations), 0) FROM public.engram_invariant_counts();')
  }

  it('stores an MK statement with no run and makes its session due for an index rebuild', async () => {
    const [u] = await seed(said('we use  Postgres only now', '2026-03-02T10:00:00Z'))
    await pg.psql(`UPDATE public.memory_session_state SET indexed_event_id = 7 WHERE session_id = '${SESSION}';`)

    const result = await store.ingestItem(write(statement(u!, 'Postgres only')))

    expect(result).toMatchObject({ subjectsCreated: 1, duplicates: 0, restatements: 0 })
    const row = await pg.psql(
      `SELECT class || '|' || trust || '|' || coalesce(extraction_run_id::text, 'none') || '|' || lineage[1] || '|' || project_id
         FROM public.memory_items WHERE id = '${result.itemIds[0]}';`,
    )
    expect(row).toBe(`mk_statement|0|none|${u!.id}|tst-repo`)
    expect(await pg.psql(`SELECT indexed_event_id FROM public.memory_session_state WHERE session_id = '${SESSION}';`)).toBe('0')
    expect(await pg.psql('SELECT count(*) FROM public.memory_extraction_runs;')).toBe('0')
    expect(await violations()).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('answers the stored item for the same event key, and a restatement for the same words from a later turn', async () => {
    const [first, later] = await seed(
      said('Postgres only, please', '2026-03-02T10:00:00Z'),
      said('again: Postgres only', '2026-03-02T11:00:00Z'),
    )
    const stored = await store.ingestItem(write(statement(first!, 'Postgres only')))
    const again = await store.ingestItem(write(statement(first!, 'Postgres only')))
    const restated = await store.ingestItem(write(statement(later!, 'Postgres  only')))

    expect(again).toMatchObject({ itemIds: stored.itemIds, duplicates: 1, restatements: 0 })
    expect(restated).toMatchObject({ itemIds: stored.itemIds, duplicates: 0, restatements: 1 })
    expect(
      await pg.psql(`SELECT cardinality(restated_at) FROM public.memory_items WHERE id = '${stored.itemIds[0]}';`),
    ).toBe('1')
    expect(await pg.psql("SELECT count(*) FROM public.memory_items WHERE class = 'mk_statement';")).toBe('1')
    expect(await violations()).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('stores the same words in another project as a statement of their own', async () => {
    const [here, there] = await seed(
      said('Postgres only', '2026-03-02T10:00:00Z'),
      said('Postgres only', '2026-03-02T11:00:00Z', OTHER),
    )
    const a = await store.ingestItem(write(statement(here!, 'Postgres only')))
    const b = await store.ingestItem(write(statement(there!, 'Postgres only')))

    expect(b.restatements).toBe(0)
    expect(b.itemIds[0]).not.toBe(a.itemIds[0])
  }, TEST_TIMEOUT_MS)

  it('writes a corrects link with no run id', async () => {
    const [u] = await seed(said('no, the importer reads CSV', '2026-03-02T10:00:00Z'))
    const obs = await store.ingestItem(write(observation('The importer reads XML', '2026-03-01T09:00:00Z')))
    const subjectId = await pg.psql(`SELECT subject_id FROM public.memory_items WHERE id = '${obs.itemIds[0]}';`)

    const fix = await store.ingestItem({
      subjects: [],
      item: statement(u!, 'the importer reads CSV', {
        kind: 'correction',
        subjectId,
        subjectKey: null,
        links: [{ rel: 'corrects', target: obs.itemIds[0]! }],
      }),
    })

    expect(fix.linksApplied).toBe(1)
    expect(await pg.psql('SELECT from_item || \'|\' || to_item || \'|\' || coalesce(run_id::text, \'none\') FROM public.memory_item_links;')).toBe(
      `${fix.itemIds[0]}|${obs.itemIds[0]}|none`,
    )
    expect(await violations()).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('refuses the whole write when a link target is no longer current', async () => {
    const old = await store.ingestItem(write(observation('The importer reads XML', '2026-03-01T09:00:00Z')))
    await pg.psql(`SELECT public.engram_retire_items(ARRAY['${old.itemIds[0]}']::uuid[], 'stale');`)
    const subjectId = await pg.psql(`SELECT subject_id FROM public.memory_items WHERE id = '${old.itemIds[0]}';`)

    const refused = await store
      .ingestItem({
        subjects: [],
        item: observation('The importer reads CSV', '2026-03-02T09:00:00Z', {
          subjectId,
          subjectKey: null,
          links: [{ rel: 'supersedes', target: old.itemIds[0]! }],
        }),
      })
      .catch((err: unknown) => err)

    expect(isItemConstraintError(refused)).toBe(true)
    expect((refused as Error).message).toContain('not_current')
    expect(await pg.psql("SELECT count(*) FROM public.memory_items WHERE content = 'The importer reads CSV';")).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('refuses a payload that is not one ingest_tool item with no run, or a statement not from a stored utterance', async () => {
    const [u] = await seed(said('Postgres only', '2026-03-02T10:00:00Z'))
    const fromExtraction = statement(u!, 'Postgres only', {
      source: { type: 'extraction', utterance_id: u!.id, event_key: itemEventKey('mk_statement', u!.id, 'Postgres only') },
    })
    const noUtterance = statement(u!, 'Postgres only', { lineage: [generateId()] })
    const call = (payload: unknown): Promise<string> =>
      pg.psql(`SELECT public.engram_ingest_item('${JSON.stringify(payload).replace(/'/g, "''")}'::jsonb);`).catch(
        (err: unknown) => (err as Error).message,
      )

    await expect(store.ingestItem(write(fromExtraction))).rejects.toThrow(/source\.type must be ingest_tool/)
    await expect(store.ingestItem(write(noUtterance))).rejects.toThrow(/lineage must start with a stored utterance/)
    expect(await call({ items: [] })).toMatch(/items must be an array of exactly one item/)
    expect(await call({ items: [{}], stats: {} })).toMatch(/not subjects or items/)
    expect(await pg.psql("SELECT count(*) FROM public.memory_items WHERE class = 'mk_statement';")).toBe('0')
  }, TEST_TIMEOUT_MS)
})
