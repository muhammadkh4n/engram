/**
 * engram_sync_document_note through PostgRestItemStore.syncDocumentNote, with
 * a real PostgREST in front of real Postgres. One note per call, one
 * transaction:
 * - a note's version and deleted state decide unchanged; seen_at alone orders
 *   versions, so an older device mtime still applies and an older seen_at is
 *   stale;
 * - each heading section is one item per version, keyed by (path,
 *   heading_path, ordinal): a changed text supersedes, a removed section is
 *   retired and comes back restored, a retirement for another reason and a
 *   forgotten text both hold;
 * - new items carry the note's scope and secret hits, and wait for the
 *   embedding pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DocumentNoteSyncResult, DocumentNoteWrite, DocumentSectionWrite } from '@engram-mem/core'
import { PostgRestItemStore } from '../../src/items.js'
import { postgrestImage, realPgImage, startRealPg, type PostgrestEndpoint, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const T0 = Date.parse('2026-05-11T08:00:00Z')
const PROJECT = 'tst-docs-repo'
const WORKSPACE = 'tst-docs-ws'

interface StoredSection {
  id: string
  kind: string
  content: string
  search_text: string
  project_id: string | null
  workspace_id: string | null
  plan_slug: string | null
  occurred_at: string
  valid_to: string | null
  superseded_by: string | null
  retired_reason: string | null
  forgotten: boolean
  source: Record<string, unknown>
}

function at(minutes: number): Date {
  return new Date(T0 + minutes * 60_000)
}

function hex(value: string): string {
  return `convert_from(decode('${Buffer.from(value, 'utf8').toString('hex')}', 'hex'), 'UTF8')`
}

function section(headingPath: string[], text: string, index: number, ordinal = 0): DocumentSectionWrite {
  const head = headingPath.length === 0 ? '' : ` > ${headingPath.join(' > ')}`
  return { headingPath, ordinal, index, text, kind: 'plan_readme', searchText: `note${head}: ${text}`, hits: [] }
}

function note(
  path: string,
  version: string,
  seenMinute: number,
  mtimeMinute: number,
  sections: DocumentSectionWrite[],
  overrides: Partial<DocumentNoteWrite> = {},
): DocumentNoteWrite {
  return {
    path,
    noteVersion: version,
    seenAt: at(seenMinute),
    mtime: at(mtimeMinute),
    deleted: false,
    frontmatter: { title: 'tst note' },
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    planSlug: 'tst-docs-plan',
    sections,
    ...overrides,
  }
}

function deletion(path: string, version: string, seenMinute: number, mtimeMinute: number): DocumentNoteWrite {
  return note(path, version, seenMinute, mtimeMinute, [], { deleted: true, frontmatter: null })
}

function counts(partial: Partial<NonNullable<DocumentNoteSyncResult['sections']>>): NonNullable<DocumentNoteSyncResult['sections']> {
  return {
    created: 0,
    superseded: 0,
    unchanged: 0,
    retired: 0,
    restored: 0,
    keptForgotten: 0,
    keptRetired: 0,
    skippedEmpty: 0,
    ...partial,
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('documents sync, one transaction per note, on real Postgres', () => {
  let pg: RealPg
  let endpoint: PostgrestEndpoint
  let store: PostgRestItemStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    await pg.psqlAs(
      'service_role',
      `SELECT public.engram_sync_projects('${JSON.stringify([
        { id: WORKSPACE, kind: 'workspace', workspace_id: null, vault_folder: 'Tstdocs', register_prefix: null },
        { id: PROJECT, kind: 'project', workspace_id: WORKSPACE, vault_folder: 'Tstdocs', register_prefix: null },
      ])}'::jsonb);`,
    )
    endpoint = await pg.startPostgrest()
    store = new PostgRestItemStore({ url: endpoint.url, key: endpoint.serviceJwt })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  /** Every version of the note's sections, oldest first. */
  async function sections(path: string): Promise<StoredSection[]> {
    return JSON.parse(
      await pg.psql(`
        SELECT coalesce(json_agg(json_build_object(
                 'id', i.id, 'kind', i.kind, 'content', i.content, 'search_text', i.search_text,
                 'project_id', i.project_id, 'workspace_id', i.workspace_id, 'plan_slug', i.plan_slug,
                 'occurred_at', to_char(i.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 'valid_to', to_char(i.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 'superseded_by', i.superseded_by, 'retired_reason', i.retired_reason,
                 'forgotten', i.forgotten_at IS NOT NULL, 'source', i.source)
               ORDER BY i.created_at, i.occurred_at, i.id), '[]'::json)
          FROM public.memory_items i
         WHERE i.class = 'document_section' AND i.source ->> 'path' = ${hex(path)}`),
    ) as StoredSection[]
  }

  /** Heads by section text: the versions neither superseded nor forgotten. */
  async function heads(path: string): Promise<StoredSection[]> {
    return (await sections(path)).filter((s) => s.superseded_by === null && !s.forgotten)
  }

  /** xmin of every row the note owns: unchanged xmins mean nothing was written. */
  async function rowVersions(path: string): Promise<string> {
    return pg.psql(`
      SELECT string_agg(x, ',' ORDER BY x) FROM (
        SELECT i.id::text || ':' || i.xmin::text AS x FROM public.memory_items i WHERE i.source ->> 'path' = ${hex(path)}
        UNION ALL
        SELECT d.path || ':' || d.xmin::text FROM public.memory_document_notes d WHERE d.path = ${hex(path)}
        UNION ALL
        SELECT 'hits:' || count(*)::text FROM public.memory_secret_hits) v`)
  }

  function iso(minutes: number): string {
    return at(minutes).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')
  }

  it('a new note creates one item per section, with kind, search text, scope and plan, waiting for the embedding pass', async () => {
    const path = 'Tstdocs/Plans/Active/tst-docs-plan/README.md'
    const result = await store.syncDocumentNote(
      note(path, 'v1', 0, -5, [section([], 'Preamble before any heading.', 0), section(['Goal'], 'Ship the sync.', 1)]),
    )
    expect(result.status).toBe('applied')
    expect(result.sections).toEqual(counts({ created: 2 }))
    expect(result.itemIds).toHaveLength(2)

    const stored = await sections(path)
    expect(stored.map((s) => s.id)).toEqual(expect.arrayContaining(result.itemIds))
    const goal = stored.find((s) => s.content === 'Ship the sync.')!
    expect(goal).toMatchObject({
      kind: 'plan_readme',
      search_text: 'note > Goal: Ship the sync.',
      project_id: PROJECT,
      workspace_id: WORKSPACE,
      plan_slug: 'tst-docs-plan',
      occurred_at: iso(-5),
      retired_reason: null,
    })
    expect(goal.source).toMatchObject({ type: 'vault', path, heading_path: ['Goal'], ordinal: 0, index: 1, note_version: 'v1' })
    expect(goal.source.event_key).toMatch(/^vault:[0-9a-f]{64}:[0-9a-f]{64}:0:[0-9a-f]{64}$/)

    const pending = await pg.psqlAs(
      'service_role',
      `SELECT count(*) FROM public.engram_items_pending_embedding(256) p WHERE p.id = ANY ('{${result.itemIds.join(',')}}'::uuid[])`,
    )
    expect(pending).toBe('2')
    const row = await pg.psql(`SELECT json_build_object('v', note_version, 'deleted', deleted_at IS NOT NULL, 'fm', frontmatter)
                                 FROM public.memory_document_notes WHERE path = ${hex(path)}`)
    expect(JSON.parse(row)).toEqual({ v: 'v1', deleted: false, fm: { title: 'tst note' } })
  }, TEST_TIMEOUT_MS)

  it('the same note again is unchanged and writes nothing', async () => {
    const path = 'Tstdocs/Notes/tst-same.md'
    const body = [section(['Context'], 'Nothing changes here.', 0)]
    await store.syncDocumentNote(note(path, 'v1', 0, 0, body))
    const before = await rowVersions(path)

    const again = await store.syncDocumentNote(note(path, 'v1', 3, 3, body))
    expect(again).toEqual({ status: 'unchanged', sections: null, itemIds: [] })
    expect(await rowVersions(path)).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('a changed section gets a new item that supersedes the old one, valid until the new mtime', async () => {
    const path = 'Tstdocs/Notes/tst-changed.md'
    await store.syncDocumentNote(note(path, 'v1', 0, 0, [section(['Steps'], 'Run it once.', 0), section(['Done'], 'Kept.', 1)]))
    const result = await store.syncDocumentNote(
      note(path, 'v2', 10, 10, [section(['Steps'], 'Run it twice.', 0), section(['Done'], 'Kept.', 1)]),
    )
    expect(result.sections).toEqual(counts({ superseded: 1, unchanged: 1 }))

    const stored = await sections(path)
    const old = stored.find((s) => s.content === 'Run it once.')!
    const next = stored.find((s) => s.content === 'Run it twice.')!
    expect(result.itemIds).toEqual([next.id])
    expect(old.superseded_by).toBe(next.id)
    expect(old.valid_to).toBe(iso(10))
    expect(next.occurred_at).toBe(iso(10))
  }, TEST_TIMEOUT_MS)

  it('a removed section is retired, and the same text back is restored', async () => {
    const path = 'Tstdocs/Notes/tst-removed.md'
    await store.syncDocumentNote(note(path, 'v1', 0, 0, [section(['Keep'], 'Stays.', 0), section(['Drop'], 'Goes away.', 1)]))
    const removed = await store.syncDocumentNote(note(path, 'v2', 5, 5, [section(['Keep'], 'Stays.', 0)]))
    expect(removed.sections).toEqual(counts({ unchanged: 1, retired: 1 }))
    expect((await heads(path)).find((s) => s.content === 'Goes away.')!.retired_reason).toBe('removed from note')

    const back = await store.syncDocumentNote(
      note(path, 'v3', 9, 9, [section(['Keep'], 'Stays.', 0), section(['Drop'], 'Goes away.', 1)]),
    )
    expect(back.sections).toEqual(counts({ unchanged: 1, restored: 1 }))
    expect(back.itemIds).toEqual([])
    expect((await heads(path)).every((s) => s.retired_reason === null)).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('a section MK retired for another reason stays retired when the note sends the same text', async () => {
    const path = 'Tstdocs/Notes/tst-mk-retired.md'
    const created = await store.syncDocumentNote(note(path, 'v1', 0, 0, [section(['Rule'], 'Old rule.', 0)]))
    await pg.psqlAs('service_role', `SELECT * FROM public.engram_retire_items('{${created.itemIds[0]}}'::uuid[], 'no longer true')`)

    const result = await store.syncDocumentNote(
      note(path, 'v2', 5, 5, [section(['Rule'], 'Old rule.', 0), section(['Other'], 'New text.', 1)]),
    )
    expect(result.sections).toEqual(counts({ keptRetired: 1, created: 1 }))
    expect((await heads(path)).find((s) => s.content === 'Old rule.')!.retired_reason).toBe('no longer true')
  }, TEST_TIMEOUT_MS)

  it('a retired section whose text changes is superseded in place and keeps its retirement', async () => {
    const path = 'Tstdocs/Notes/tst-retired-changed.md'
    const created = await store.syncDocumentNote(note(path, 'v1', 0, 0, [section(['Rule'], 'First wording.', 0)]))
    await pg.psqlAs('service_role', `SELECT * FROM public.engram_retire_items('{${created.itemIds[0]}}'::uuid[], 'no longer true')`)

    const result = await store.syncDocumentNote(note(path, 'v2', 5, 5, [section(['Rule'], 'Second wording.', 0)]))
    expect(result.sections).toEqual(counts({ superseded: 1 }))
    const [first] = (await sections(path)).filter((s) => s.content === 'First wording.')
    expect(first).toMatchObject({ superseded_by: result.itemIds[0], retired_reason: 'no longer true' })
  }, TEST_TIMEOUT_MS)

  it('deleted: true retires every head', async () => {
    const path = 'Tstdocs/Notes/tst-deleted.md'
    await store.syncDocumentNote(note(path, 'v1', 0, 0, [section(['A'], 'One.', 0), section(['B'], 'Two.', 1)]))
    const result = await store.syncDocumentNote(deletion(path, 'v2', 5, 5))
    expect(result.sections).toEqual(counts({ retired: 2 }))
    expect((await heads(path)).map((s) => s.retired_reason)).toEqual(['removed from note', 'removed from note'])
    expect(await pg.psql(`SELECT deleted_at IS NOT NULL FROM public.memory_document_notes WHERE path = ${hex(path)}`)).toBe('t')
  }, TEST_TIMEOUT_MS)

  it('an older seen_at is stale and changes nothing', async () => {
    const path = 'Tstdocs/Notes/tst-stale.md'
    await store.syncDocumentNote(note(path, 'v2', 10, 10, [section(['A'], 'Newer.', 0)]))
    const before = await rowVersions(path)

    const result = await store.syncDocumentNote(note(path, 'v1', 5, 20, [section(['A'], 'Older.', 0)]))
    expect(result).toEqual({ status: 'stale', sections: null, itemIds: [] })
    expect(await rowVersions(path)).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('an older mtime with a later seen_at applies, its new version dated just after the head', async () => {
    const path = 'Tstdocs/Notes/tst-slow-clock.md'
    await store.syncDocumentNote(note(path, 'v1', 0, 30, [section(['A'], 'From the laptop.', 0)]))
    const result = await store.syncDocumentNote(note(path, 'v2', 5, 2, [section(['A'], 'From the phone.', 0)]))
    expect(result.status).toBe('applied')
    expect(result.sections).toEqual(counts({ superseded: 1 }))
    const next = (await sections(path)).find((s) => s.content === 'From the phone.')!
    expect(next.occurred_at).toBe(at(30).toISOString().replace(/\.(\d{3})Z$/, '.$1001Z'))
  }, TEST_TIMEOUT_MS)

  it('a deleted note sent back with its original, older mtime and a later seen_at is applied and its sections restored', async () => {
    const path = 'Tstdocs/Notes/tst-undeleted.md'
    const body = [section(['A'], 'Back again.', 0)]
    await store.syncDocumentNote(note(path, 'v1', 0, 0, body))
    await store.syncDocumentNote(deletion(path, 'v2', 5, 5))

    const result = await store.syncDocumentNote(note(path, 'v1', 9, 0, body))
    expect(result.status).toBe('applied')
    expect(result.sections).toEqual(counts({ restored: 1 }))
    expect(await pg.psql(`SELECT deleted_at IS NULL FROM public.memory_document_notes WHERE path = ${hex(path)}`)).toBe('t')
  }, TEST_TIMEOUT_MS)

  it("a note sent back with its delete's note_version is applied, not unchanged", async () => {
    const path = 'Tstdocs/Notes/tst-same-version.md'
    const body = [section(['A'], 'Same version string.', 0)]
    await store.syncDocumentNote(note(path, 'v1', 0, 0, body))
    await store.syncDocumentNote(deletion(path, 'v2', 5, 5))

    const result = await store.syncDocumentNote(note(path, 'v2', 9, 9, body))
    expect(result.status).toBe('applied')
    expect(result.sections).toEqual(counts({ restored: 1 }))
  }, TEST_TIMEOUT_MS)

  it('a delete with an older mtime and a later seen_at is applied and retires every head', async () => {
    const path = 'Tstdocs/Notes/tst-old-delete.md'
    await store.syncDocumentNote(note(path, 'v1', 0, 20, [section(['A'], 'One.', 0), section(['B'], 'Two.', 1)]))
    const result = await store.syncDocumentNote(deletion(path, 'v2', 5, 1))
    expect(result.status).toBe('applied')
    expect(result.sections).toEqual(counts({ retired: 2 }))
  }, TEST_TIMEOUT_MS)

  it('a delete with an older seen_at is stale and keeps every head', async () => {
    const path = 'Tstdocs/Notes/tst-stale-delete.md'
    await store.syncDocumentNote(note(path, 'v2', 10, 10, [section(['A'], 'Still here.', 0)]))
    const result = await store.syncDocumentNote(deletion(path, 'v3', 5, 30))
    expect(result.status).toBe('stale')
    expect((await heads(path)).map((s) => s.retired_reason)).toEqual([null])
  }, TEST_TIMEOUT_MS)

  it('a forgotten section sent again unchanged is kept forgotten, and stays out after another edit', async () => {
    const path = 'Tstdocs/Notes/tst-forgotten.md'
    const created = await store.syncDocumentNote(note(path, 'v1', 0, 0, [section(['A'], 'Forget these words.', 0)]))
    await pg.psqlAs('service_role', `SELECT * FROM public.engram_forget_items('{${created.itemIds[0]}}'::uuid[], 'wrong note')`)

    const again = await store.syncDocumentNote(note(path, 'v2', 5, 5, [section(['A'], 'Forget these words.', 0)]))
    expect(again.sections).toEqual(counts({ keptForgotten: 1 }))
    expect(again.itemIds).toEqual([])

    await store.syncDocumentNote(note(path, 'v3', 9, 9, [section(['A'], 'Different words.', 0)]))
    const back = await store.syncDocumentNote(note(path, 'v4', 12, 12, [section(['A'], 'Forget these words.', 0)]))
    expect(back.sections).toEqual(counts({ keptForgotten: 1 }))
    expect((await heads(path)).map((s) => s.content)).toEqual(['Different words.'])
  }, TEST_TIMEOUT_MS)

  it('two "## Notes" headings get ordinals 0 and 1 and keep independent versions', async () => {
    const path = 'Tstdocs/Notes/tst-twin-headings.md'
    await store.syncDocumentNote(
      note(path, 'v1', 0, 0, [section(['Notes'], 'First notes.', 0, 0), section(['Notes'], 'Second notes.', 1, 1)]),
    )
    const result = await store.syncDocumentNote(
      note(path, 'v2', 5, 5, [section(['Notes'], 'First notes.', 0, 0), section(['Notes'], 'Second notes, edited.', 1, 1)]),
    )
    expect(result.sections).toEqual(counts({ unchanged: 1, superseded: 1 }))
    const current = await heads(path)
    expect(current.map((s) => [s.source.ordinal, s.content]).sort()).toEqual([
      [0, 'First notes.'],
      [1, 'Second notes, edited.'],
    ])
  }, TEST_TIMEOUT_MS)

  it('a text that returns to an earlier version is a new head with its own event key', async () => {
    const path = 'Tstdocs/Notes/tst-revert.md'
    await store.syncDocumentNote(note(path, 'v1', 0, 0, [section(['A'], 'Original.', 0)]))
    await store.syncDocumentNote(note(path, 'v2', 5, 5, [section(['A'], 'Edited.', 0)]))
    const result = await store.syncDocumentNote(note(path, 'v3', 9, 9, [section(['A'], 'Original.', 0)]))
    expect(result.sections).toEqual(counts({ superseded: 1 }))

    const stored = await sections(path)
    expect(stored.map((s) => s.content)).toEqual(['Original.', 'Edited.', 'Original.'])
    const [first, edited, reverted] = stored
    expect(reverted!.source.event_key).toBe(`${first!.source.event_key as string}:${edited!.id}`)
    expect((await heads(path)).map((s) => s.id)).toEqual([reverted!.id])
  }, TEST_TIMEOUT_MS)

  it('a blank section is skipped and its earlier version retired', async () => {
    const path = 'Tstdocs/Notes/tst-blank.md'
    await store.syncDocumentNote(note(path, 'v1', 0, 0, [section(['A'], 'Has text.', 0)]))
    const result = await store.syncDocumentNote(note(path, 'v2', 5, 5, [section(['A'], '  \n ', 0)]))
    expect(result.sections).toEqual(counts({ skippedEmpty: 1, retired: 1 }))
  }, TEST_TIMEOUT_MS)

  it('a secret-hit name in the note writes a memory_secret_hits row for the new item', async () => {
    const path = 'Tstdocs/Notes/tst-secret.md'
    const masked = { ...section(['Env'], 'token is [REDACTED:tst-token]', 0), hits: [{ field: 'content', detector: 'registered', secretName: 'TST_DOCS_TOKEN' }] }
    const result = await store.syncDocumentNote(note(path, 'v1', 0, 0, [masked]))
    const hits = await pg.psql(`
      SELECT json_agg(json_build_object('table', target_table, 'field', field, 'detector', detector, 'name', secret_name))
        FROM public.memory_secret_hits WHERE target_id = '${result.itemIds[0]}'`)
    expect(JSON.parse(hits)).toEqual([{ table: 'memory_items', field: 'content', detector: 'registered', name: 'TST_DOCS_TOKEN' }])
  }, TEST_TIMEOUT_MS)

  it('refuses a malformed note before writing, naming the field', async () => {
    const path = 'Tstdocs/Notes/tst-malformed.md'
    const twin = note(path, 'v1', 0, 0, [section(['A'], 'One.', 0), section(['A'], 'Two.', 1)])
    await expect(store.syncDocumentNote(twin)).rejects.toThrow(/22023.*same heading_path and ordinal/)
    await expect(store.syncDocumentNote(note(path, 'v1', 0, 0, [], { projectId: 'tst-unknown-repo' }))).rejects.toThrow(
      /project_id names no registered project/,
    )
    expect(await sections(path)).toEqual([])
    expect(await pg.psql(`SELECT count(*) FROM public.memory_document_notes WHERE path = ${hex(path)}`)).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('lets service_role read the notes table and nothing more', async () => {
    const grants = await pg.psql(`
      SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants
       WHERE grantee = 'service_role' AND table_name = 'memory_document_notes'`)
    expect(grants).toBe('SELECT')
    const execute = await pg.psql(`
      SELECT string_agg(r.rolname, ',' ORDER BY r.rolname) FROM pg_roles r
       WHERE has_function_privilege(r.oid, 'public.engram_sync_document_note(jsonb)', 'EXECUTE')
         AND r.rolname IN ('service_role', 'anon', 'authenticated')`)
    expect(execute).toBe('service_role')
  }, TEST_TIMEOUT_MS)
})
