/**
 * The operator re-run RPCs through a real PostgREST in front of real Postgres:
 * - engram_extraction_sessions picks sessions by name or by MK utterance
 *   time, oldest first, and says which are live;
 * - engram_extraction_session_anchors lists a session's windows in run order
 *   with their state at one version, or with a run at any version counting
 *   as extracted (a gap fill);
 * - engram_extraction_replace retires what an older version stored for the
 *   window and the new run does not reproduce, keeps a recorded item, hands
 *   back what the retired items superseded, removes their restatement times,
 *   makes the sessions of what it retired or handed back due for a new index
 *   and commits the new run, all in one transaction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateId, itemEventKey, type ExtractionCommit, type ExtractionItem, type StoredEvent } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const SESSION = 'sess-replace'
const OTHER_SESSION = 'sess-replace-later'
const IDLE_MS = 30 * 60 * 1000
const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }
const OLD = 'replace-old'
const NEW = 'replace-new'

let eventCounter = 0
function event(session: string, type: string, payload: Record<string, unknown>, occurredAt: string): StoredEvent {
  eventCounter += 1
  return {
    sessionId: session,
    eventUuid: `replace-evt-${eventCounter}`,
    type,
    occurredAt,
    cwd: '/home/tester/tst-repo',
    project: { ...REPO },
    planDirs: [],
    client: { name: 'engram-test', version: '1.0.0' },
    payload,
    scrub: { masked: [] },
    hits: [],
  }
}

const said = (text: string, at: string, session = SESSION): StoredEvent =>
  event(session, 'user_prompt', { text, transcript_line: 1 }, at)
const answered = (text: string, at: string): StoredEvent =>
  event(SESSION, 'assistant_turn', { text, transcript_line: 2, tools: [] }, at)

interface Utterance {
  id: string
  at: string
}

interface ItemRow {
  id: string
  superseded_by: string | null
  valid_to: string | null
  restated_at: string[]
  retired_reason: string | null
}

describe.skipIf(!realPgImage || !postgrestImage)('extraction re-run RPCs through PostgREST on real Postgres', () => {
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
      })),
    )
  }

  async function subject(label: string): Promise<string> {
    return pg.psql(
      `WITH added AS (INSERT INTO public.memory_subjects (project_id, label) VALUES ('tst-repo', '${label}') RETURNING id) SELECT id FROM added;`,
    )
  }

  async function begin(anchor: Utterance, version: string): Promise<string> {
    const run = await store.extractionBegin({ anchorId: anchor.id, sessionId: SESSION, version, model: null })
    expect(run).not.toBeNull()
    return run!
  }

  function statement(from: Utterance, content: string, subjectId: string, over: Partial<ExtractionItem> = {}): ExtractionItem {
    return {
      id: generateId(),
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: SESSION,
      subjectId,
      subjectKey: null,
      content,
      searchText: content,
      context: null,
      occurredAt: new Date(from.at),
      standing: false,
      registerStatus: null,
      source: {
        type: 'extraction',
        utterance_id: from.id,
        event_key: itemEventKey('mk_statement', from.id, content),
        scope: 'project',
        applies_to: [],
      },
      lineage: [from.id],
      entities: [],
      ...over,
    }
  }

  function observation(turn: Utterance, content: string, subjectId: string): ExtractionItem {
    return {
      ...statement(turn, content, subjectId),
      class: 'observation',
      kind: 'fact',
      speaker: 'assistant',
      trust: 3,
      standing: null,
      source: { type: 'extraction', utterance_id: turn.id, event_key: itemEventKey('observation', turn.id, content), evidence: [] },
    }
  }

  async function commitOld(anchor: Utterance, items: ExtractionItem[], stats: Record<string, unknown> = {}): Promise<string[]> {
    const run = await begin(anchor, OLD)
    const payload: ExtractionCommit = { subjects: [], items, stats }
    return (await store.extractionCommit(run, payload)).itemIds
  }

  async function rows(ids: string[]): Promise<ItemRow[]> {
    const out = await pg.psql(
      `SELECT coalesce(json_agg(json_build_object(
                'id', i.id, 'superseded_by', i.superseded_by, 'valid_to', i.valid_to,
                'restated_at', (SELECT coalesce(json_agg(r ORDER BY r), '[]') FROM unnest(i.restated_at) AS r),
                'retired_reason', i.retired_reason)
              ORDER BY array_position(ARRAY[${ids.map((id) => `'${id}'::uuid`).join(', ')}], i.id)), '[]')
         FROM public.memory_items i WHERE i.id IN (${ids.map((id) => `'${id}'`).join(', ')});`,
    )
    return JSON.parse(out) as ItemRow[]
  }

  it('relies on one running or succeeded run per window and version', async () => {
    const index = await pg.psql(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_extraction_runs_anchor_version';",
    )
    expect(index).toContain('CREATE UNIQUE INDEX')
    expect(index).toContain('(anchor_item_id, extractor_version)')
    const [prompt] = await seed(said('we use sqlite for the cache', '2026-03-02T10:00:00Z'))
    await begin(prompt!, NEW)
    expect(await store.extractionBegin({ anchorId: prompt!.id, sessionId: SESSION, version: NEW, model: null })).toBeNull()
  }, TEST_TIMEOUT_MS)

  it('picks sessions by name or by MK utterance time, oldest first, and says which are live', async () => {
    await seed(said('the later session speaks first in time', '2026-03-01T09:00:00Z', OTHER_SESSION))
    await seed(said('we use sqlite for the cache', '2026-03-02T10:00:00Z'))
    const now = new Date()
    const live = await store.extractionSessions({ sessionId: null, since: new Date('2026-03-01T00:00:00Z'), idleMs: IDLE_MS, now })
    expect(live.map((s) => [s.sessionId, s.firstAt?.toISOString(), s.due])).toEqual([
      [OTHER_SESSION, '2026-03-01T09:00:00.000Z', false],
      [SESSION, '2026-03-02T10:00:00.000Z', false],
    ])
    const later = new Date(now.getTime() + 2 * IDLE_MS)
    const since = await store.extractionSessions({ sessionId: null, since: new Date('2026-03-02T00:00:00Z'), idleMs: IDLE_MS, now: later })
    expect(since.map((s) => [s.sessionId, s.due])).toEqual([[SESSION, true]])
    const named = await store.extractionSessions({ sessionId: OTHER_SESSION, since: null, idleMs: IDLE_MS, now: later })
    expect(named.map((s) => s.sessionId)).toEqual([OTHER_SESSION])
    expect(await store.extractionSessions({ sessionId: 'sess-unknown', since: null, idleMs: IDLE_MS, now })).toEqual([])
    await expect(
      store.extractionSessions({ sessionId: SESSION, since: new Date(), idleMs: IDLE_MS, now }),
    ).rejects.toThrow(/exactly one/)
  }, TEST_TIMEOUT_MS)

  it('lists the windows of a session in run order with their state at one version', async () => {
    const [p0, t0, p1] = await seed(
      said('we use sqlite for the cache', '2026-03-02T10:00:00Z'),
      answered('Noted, the cache stays on sqlite.', '2026-03-02T10:01:00Z'),
      said('switch the cache to postgres', '2026-03-02T10:05:00Z'),
    )
    const run = await begin(p0!, NEW)
    await store.extractionCommit(run, { subjects: [], items: [], stats: {} })
    const anchors = await store.extractionSessionAnchors(NEW, SESSION, 'this_version')
    expect(anchors.map((a) => [a.anchorId, a.anchorKind, a.succeeded, a.runningRunId])).toEqual([
      [p0!.id, 'user_prompt', true, null],
      [p1!.id, 'user_prompt', false, null],
    ])
    expect(t0).toBeDefined()
    const other = await store.extractionSessionAnchors(OLD, SESSION, 'this_version')
    expect(other.map((a) => a.succeeded)).toEqual([false, false])
    // A gap fill at another version leaves what any version extracted.
    const gaps = await store.extractionSessionAnchors(OLD, SESSION, 'any_version')
    expect(gaps.map((a) => [a.anchorId, a.succeeded])).toEqual([
      [p0!.id, true],
      [p1!.id, false],
    ])
  }, TEST_TIMEOUT_MS)

  it('retires what the new run does not reproduce, keeps a recorded item and hands back supersessions', async () => {
    const [p0, p1, t1, p2] = await seed(
      said('we use sqlite for the cache. tests run on node. logs go to stdout', '2026-03-02T10:00:00Z'),
      said('switch the cache to postgres, keep sqlite for tests. tests run on node. logs go to a file', '2026-03-02T10:05:00Z'),
      answered('The cache module reads POSTGRES_URL. The pool holds ten connections.', '2026-03-02T10:06:00Z'),
      said('logs go to journald', '2026-03-02T10:10:00Z'),
    )
    const cache = await subject('cache store')
    const tests = await subject('test runtime')
    const logs = await subject('log target')
    const [r, q, r2] = await commitOld(p0!, [
      statement(p0!, 'we use sqlite for the cache', cache),
      statement(p0!, 'tests run on node', tests),
      statement(p0!, 'logs go to stdout', logs),
    ])
    const a = statement(p1!, 'switch the cache to postgres', cache, { links: [{ rel: 'supersedes', target: r! }] })
    const b = statement(p1!, 'keep sqlite for tests', cache, { standing: true, registerStatus: 'candidate' })
    const restating = statement(p1!, 'tests run on node', tests, { links: [{ rel: 'restates', target: q! }] })
    const x = statement(p1!, 'logs go to a file', logs, { links: [{ rel: 'supersedes', target: r2! }] })
    const o = observation(t1!, 'The cache module reads POSTGRES_URL.', cache)
    const o2 = observation(t1!, 'The pool holds ten connections.', cache)
    const [aId, bId, qAgain, xId, oId, o2Id] = await commitOld(p1!, [a, b, restating, x, o, o2], {
      observation_sources: [t1!.id],
    })
    expect(qAgain).toBe(q)
    await pg.psql(`UPDATE public.memory_items SET register_status = 'recorded', register_ref = 'R-TST-7' WHERE id = '${bId}';`)
    const [zId] = await commitOld(p2!, [statement(p2!, 'logs go to journald', logs, { links: [{ rel: 'supersedes', target: xId! }] })])
    expect((await rows([q!]))[0]!.restated_at).toHaveLength(1)

    const run = await begin(p1!, NEW)
    const fresh = statement(p1!, 'switch the cache to postgres, keep sqlite', cache)
    const result = await store.extractionReplace(run, {
      subjects: [],
      items: [fresh, { ...o, id: generateId() }],
      stats: { observation_sources: [t1!.id] },
    })

    const reason = `replaced by extractor ${NEW} (run ${run})`
    expect(result.duplicates).toBe(1)
    expect(result.itemIds[1]).toBe(oId)
    expect([...result.retired].sort()).toEqual([aId!, xId!, o2Id!].sort())
    expect(result.keptRecorded).toEqual([bId])
    expect(result.unrestated).toBe(1)
    expect(result.restored).toEqual(
      expect.arrayContaining([
        { item: r, from: aId, to: null },
        { item: r2, from: xId, to: zId },
      ]),
    )
    expect(result.restored).toHaveLength(2)

    const after = await rows([aId!, xId!, o2Id!, bId!, oId!, r!, r2!, q!])
    expect(after.slice(0, 3).map((row) => row.retired_reason)).toEqual([reason, reason, reason])
    expect(after.slice(3, 5).map((row) => row.retired_reason)).toEqual([null, null])
    expect(after[5]).toMatchObject({ superseded_by: null, valid_to: null })
    expect(after[6]!.superseded_by).toBe(zId)
    expect(after[7]!.restated_at).toEqual([])

    const stats = JSON.parse(
      await pg.psql(`SELECT json_build_object('status', status, 'replace', stats -> 'replace') FROM public.memory_extraction_runs WHERE id = '${run}';`),
    ) as { status: string; replace: { retired: string[]; kept_recorded: string[]; unrestated: unknown[] } }
    expect(stats.status).toBe('succeeded')
    expect([...stats.replace.retired].sort()).toEqual([...result.retired].sort())
    expect(stats.replace.kept_recorded).toEqual([bId])
    expect(stats.replace.unrestated).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it('makes the sessions of the items it retires or hands back due for a new index', async () => {
    const [earlier] = await seed(said('we use sqlite for the cache', '2026-03-01T09:00:00Z', OTHER_SESSION))
    const [p1] = await seed(said('switch the cache to postgres', '2026-03-02T10:05:00Z'))
    const cache = await subject('cache store')
    const olderRun = await store.extractionBegin({ anchorId: earlier!.id, sessionId: OTHER_SESSION, version: OLD, model: null })
    const [rId] = (
      await store.extractionCommit(olderRun!, {
        subjects: [],
        items: [statement(earlier!, 'we use sqlite for the cache', cache, { sessionId: OTHER_SESSION })],
        stats: {},
      })
    ).itemIds
    const [aId] = await commitOld(p1!, [statement(p1!, 'switch the cache to postgres', cache, { links: [{ rel: 'supersedes', target: rId! }] })])
    // Both indexes are built and up to date.
    await pg.psql('UPDATE public.memory_session_state SET indexed_event_id = last_event_id;')
    const indexed = () =>
      pg.psql(
        `SELECT string_agg(session_id || '=' || (indexed_event_id = 0)::text, ',' ORDER BY session_id) FROM public.memory_session_state;`,
      )
    expect(await indexed()).toBe(`${SESSION}=false,${OTHER_SESSION}=false`)

    // The new version proposes nothing for the window, so the commit itself
    // stores and supersedes nothing.
    const run = await begin(p1!, NEW)
    const result = await store.extractionReplace(run, { subjects: [], items: [], stats: {} })

    expect(result.retired).toEqual([aId])
    expect(result.restored).toEqual([{ item: rId, from: aId, to: null }])
    expect(await indexed()).toBe(`${SESSION}=true,${OTHER_SESSION}=true`)
  }, TEST_TIMEOUT_MS)

  it('stores nothing when the commit refuses the new window', async () => {
    const [p0, p1] = await seed(
      said('we use sqlite for the cache', '2026-03-02T10:00:00Z'),
      said('switch the cache to postgres', '2026-03-02T10:05:00Z'),
    )
    const cache = await subject('cache store')
    const [oldId] = await commitOld(p1!, [statement(p1!, 'switch the cache to postgres', cache)])
    const run = await begin(p1!, NEW)
    const unquoted = statement(p1!, 'words MK never said', cache)
    await expect(store.extractionReplace(run, { subjects: [], items: [unquoted], stats: {} })).rejects.toThrow()
    expect((await rows([oldId!]))[0]!.retired_reason).toBeNull()
    expect(await pg.psql(`SELECT status FROM public.memory_extraction_runs WHERE id = '${run}';`)).toBe('running')
    expect(p0).toBeDefined()
  }, TEST_TIMEOUT_MS)
})

