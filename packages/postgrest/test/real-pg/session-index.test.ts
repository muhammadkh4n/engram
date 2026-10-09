/**
 * Session state and the session index on real Postgres behind a real
 * PostgREST: capture events go through ingest and materialize, and
 * runSessionIndexTick builds the index through the store.
 * - Events inserted in one statement fold into one state row.
 * - The index renders the session's rows as the golden text, right after
 *   session_end, and only once no event waits to be materialized.
 * - An idle session is built once 30 minutes pass without a received event.
 * - A resume with a prompt supersedes the index; one with only a
 *   briefing_shown stores nothing and advances indexed_event_id.
 * - Forgetting a quoted utterance forgets the index, and the next tick
 *   rebuilds it without that line.
 * - An extraction commit that stores an observation makes the index due
 *   again, and a build read before a change is refused as stale.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSessionIndexItem, runSessionIndexTick, SESSION_INDEX_IDLE_MS, type StoredEvent } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }
const PLAN_DIRS = ['/home/tester/plans/alpha-plan', '/home/tester/plans/beta-plan/']
const T = (minute: number, second = 0): string => new Date(Date.UTC(2026, 0, 12, 8, minute, second)).toISOString()
const SHA = 'c0ffee1234567890abcdef1234567890abcdef12'
const PR = 'https://github.com/tester/tst-repo/pull/17'

let uuidCounter = 0
function event(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  occurredAt: string,
  planDirs: string[] = [],
): StoredEvent {
  uuidCounter += 1
  return {
    sessionId,
    eventUuid: `evt-index-${uuidCounter}`,
    type,
    occurredAt,
    cwd: '/home/tester/tst-repo',
    project: { ...REPO },
    planDirs,
    client: { name: 'engram-test', version: '1.0.0' },
    payload,
    scrub: { masked: [] },
    hits: [],
  }
}

const prompt = (s: string, text: string, at: string, planDirs: string[] = []) =>
  event(s, 'user_prompt', { text, transcript_line: 1 }, at, planDirs)
const turn = (s: string, text: string, at: string, tools: Array<{ name: string; ref: string | null }> = []) =>
  event(s, 'assistant_turn', { text, transcript_line: 2, tools }, at)
const end = (s: string, at: string) => event(s, 'session_end', { reason: 'exit' }, at)

/** Two prompts, one answer, a turn with a sha and a PR ref, a commit and two plan dirs, then session_end. */
function goldenEvents(s: string): StoredEvent[] {
  return [
    prompt(s, 'Move the cache\n\n  to   the edge tier.', T(1), PLAN_DIRS),
    turn(s, 'Which region should go first?', T(2)),
    event(
      s,
      'user_answer',
      {
        questions: [{ question: 'Which region first?', header: 'Region', options: [{ label: 'West' }, { label: 'East' }] }],
        answers: { 'Which region first?': 'West' },
      },
      T(5),
    ),
    turn(s, 'Done, see the commit and the PR.', T(20), [
      { name: 'Bash', ref: 'beefcafe9876' },
      { name: 'Bash', ref: PR },
      { name: 'Write', ref: '/home/tester/tst-repo/notes.txt' },
    ]),
    event(s, 'git_commit', { repo: 'tst-repo', sha: SHA, message: 'Move the cache', files: ['cache.ts'], authored_at: T(19) }, T(19)),
    prompt(s, 'Ship it.', T(30)),
    end(s, T(42)),
  ]
}

describe.skipIf(!realPgImage || !postgrestImage)('session state and the session index on real Postgres', () => {
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
      'TRUNCATE public.memory_items, public.memory_capture_events, public.memory_secret_hits, ' +
        'public.memory_extraction_runs, public.memory_subjects, public.memory_session_state CASCADE;',
    )
  })

  async function ingest(events: StoredEvent[], materialize = true): Promise<number[]> {
    const ingested = await store.ingestEvents(events)
    expect(ingested.map((e) => e.status)).toEqual(events.map(() => 'accepted'))
    if (materialize) expect(await store.materialize(1000)).toMatchObject({ locked: true, failed: 0 })
    return ingested.map((e) => Number(e.eventId))
  }

  const tick = (now: Date = new Date()) => runSessionIndexTick({ store, now: () => now, log: () => {} })

  const itemId = (eventId: number): Promise<string> =>
    pg.psql(`SELECT id FROM public.memory_items WHERE source ->> 'event_id' = '${eventId}';`)

  const indexes = async (s: string) =>
    JSON.parse(
      (await pg.psql(
        `SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'content', content, 'superseded_by', superseded_by,
                  'forgotten', forgotten_at IS NOT NULL, 'lineage', lineage, 'source', source, 'trust', trust,
                  'speaker', speaker, 'search_text', search_text = content, 'embedding', embedding IS NOT NULL,
                  'occurred_at', occurred_at, 'project_id', project_id, 'workspace_id', workspace_id)
                ORDER BY created_at, occurred_at), '[]')
           FROM public.memory_items WHERE class = 'session_index' AND session_id = '${s}';`,
      )) || '[]',
    ) as Array<Record<string, unknown>>

  const state = async (s: string) =>
    JSON.parse(
      await pg.psql(`SELECT to_jsonb(st) FROM public.memory_session_state st WHERE session_id = '${s}';`),
    ) as Record<string, unknown>

  /** A statement quoting the first prompt and an observation from the first turn, stored as extraction stores them. */
  async function addExtracted(s: string, promptId: string, turnId: string): Promise<[string, string]> {
    const ids = await pg.psql(`
      WITH subj AS (
        INSERT INTO public.memory_subjects (project_id, label) VALUES ('tst-repo', 'Edge cache') RETURNING id
      ), st AS (
        INSERT INTO public.memory_items (class, kind, speaker, trust, project_id, workspace_id, session_id, subject_id,
                                         content, search_text, occurred_at, standing, source, lineage)
        SELECT 'mk_statement', 'ruling', 'mk', 0, 'tst-repo', 'tst-ws', '${s}', subj.id,
               'Move the cache', 'Move the cache', '${T(1)}', false,
               jsonb_build_object('type', 'extraction', 'event_key', 'mk_statement:${promptId}:golden'),
               ARRAY['${promptId}'::uuid]
          FROM subj RETURNING id
      ), ob AS (
        INSERT INTO public.memory_items (class, kind, speaker, trust, project_id, workspace_id, session_id, subject_id,
                                         content, search_text, occurred_at, source, lineage)
        SELECT 'observation', 'fact', 'assistant', 3, 'tst-repo', 'tst-ws', '${s}', subj.id,
               'The cache moved to the edge tier.', 'Cache tier: The cache moved to the edge tier.', '${T(20)}',
               jsonb_build_object('type', 'extraction', 'event_key', 'observation:${turnId}:golden'),
               ARRAY['${turnId}'::uuid]
          FROM subj RETURNING id
      )
      SELECT (SELECT id FROM st) || ',' || (SELECT id FROM ob);`)
    const [statement, observation] = ids.split(',')
    return [statement!, observation!]
  }

  it(
    'folds three events inserted in one statement into one state row',
    async () => {
      await pg.psql(`
        INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload, received_at)
        VALUES ('sess-fold', 'fold-1', 'user_prompt', '${T(10)}', '{"text": "b"}', '${T(11)}'),
               ('sess-fold', 'fold-2', 'session_end', '${T(20)}', '{}', '${T(21)}'),
               ('sess-fold', 'fold-3', 'user_prompt', '${T(5)}', '{"text": "a"}', '${T(12)}');`)
      const ids = (await pg.psql(`SELECT string_agg(id::text, ',' ORDER BY id) FROM public.memory_capture_events;`)).split(',')
      expect(await pg.psql(`SELECT count(*) FROM public.memory_session_state;`)).toBe('1')
      expect(await state('sess-fold')).toEqual({
        session_id: 'sess-fold',
        first_event_at: new Date(T(5)).toISOString().replace('.000Z', '+00:00'),
        last_event_at: new Date(T(20)).toISOString().replace('.000Z', '+00:00'),
        last_event_id: Number(ids[2]),
        last_received_at: new Date(T(21)).toISOString().replace('.000Z', '+00:00'),
        ended_at: new Date(T(20)).toISOString().replace('.000Z', '+00:00'),
        index_item_id: null,
        indexed_event_id: 0,
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'builds the golden index right after session_end, and not while an event waits for materialize',
    async () => {
      const s = 'sess-golden-alpha'
      const events = goldenEvents(s)
      const eventIds = await ingest(events, false)
      expect(await tick()).toMatchObject({ due: 0 })

      expect(await store.materialize(1000)).toMatchObject({ locked: true, failed: 0 })
      const [promptOne, turnOne, answer, , , promptTwo] = await Promise.all(eventIds.map(itemId))
      const [statement, observation] = await addExtracted(s, promptOne!, turnOne!)

      expect(await tick()).toMatchObject({ due: 1, written: 1, failed: 0 })
      const [index] = await indexes(s)
      expect(index!.content).toBe(
        [
          `Session ${s}`,
          'Project: tst-repo',
          'Workspace: tst-ws',
          'From 2026-01-12T08:01:00Z to 2026-01-12T08:42:00Z',
          'Plans: alpha-plan, beta-plan',
          'MK (3):',
          '2026-01-12T08:01:00Z Move the cache to the edge tier.',
          '2026-01-12T08:05:00Z Q: Which region first? A: West',
          '2026-01-12T08:30:00Z Ship it.',
          `Statements (1): ${statement}`,
          `Observations (1): ${observation}`,
          'Commits (2): tst-repo@c0ffee123456 tst-repo@beefcafe9876',
          `PRs (1): ${PR}`,
          'Ledger (0):',
        ].join('\n'),
      )
      expect(index).toMatchObject({
        trust: 1,
        speaker: 'system',
        search_text: true,
        embedding: false,
        lineage: [promptOne, answer, promptTwo],
        project_id: 'tst-repo',
        workspace_id: 'tst-ws',
        occurred_at: '2026-01-12T08:42:00+00:00',
      })
      expect(index!.source).toMatchObject({
        type: 'transcript',
        session_id: s,
        first_event_id: String(eventIds[0]),
        last_event_id: String(eventIds[6]),
      })
      expect(await state(s)).toMatchObject({ index_item_id: index!.id, indexed_event_id: eventIds[6] })
      // The new index waits for an embedding like any other item.
      const pending = await store.pendingEmbeddings(256, randomUUID())
      expect(pending.map((p) => p.id)).toContain(index!.id)

      expect(await tick()).toMatchObject({ due: 0 })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'builds an idle session only after 30 minutes without a received event',
    async () => {
      const s = 'sess-idle'
      await ingest([prompt(s, 'Check the logs.', T(1))])
      const received = new Date(await pg.psql(`SELECT max(received_at) FROM public.memory_capture_events;`))
      expect(await tick(new Date(received.getTime() + SESSION_INDEX_IDLE_MS - 60_000))).toMatchObject({ due: 0 })
      expect(await tick(new Date(received.getTime() + SESSION_INDEX_IDLE_MS + 60_000))).toMatchObject({ due: 1, written: 1 })
      expect(await indexes(s)).toHaveLength(1)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'supersedes the index on a resume with a prompt, and only advances on a resume with a briefing',
    async () => {
      const s = 'sess-resume'
      await ingest([prompt(s, 'Start the migration.', T(1)), end(s, T(2))])
      expect(await tick()).toMatchObject({ written: 1 })
      const [first] = await indexes(s)

      const [briefing] = await ingest([
        event(s, 'briefing_shown', { item_ids: [], channel: 'prompt', prompt_event_uuid: 'evt-none' }, T(3)),
      ])
      expect(await tick()).toMatchObject({ due: 0 })
      expect(await tick(new Date(Date.now() + SESSION_INDEX_IDLE_MS + 60_000))).toMatchObject({
        due: 1,
        written: 0,
        unchanged: 1,
      })
      expect(await indexes(s)).toHaveLength(1)
      expect(await state(s)).toMatchObject({ index_item_id: first!.id, indexed_event_id: briefing })

      await ingest([prompt(s, 'Resume the migration.', T(10)), end(s, T(11))])
      expect(await tick()).toMatchObject({ written: 1 })
      const [old, current] = await indexes(s)
      expect(old!.id).toBe(first!.id)
      expect(old!.superseded_by).toBe(current!.id)
      expect(current!.superseded_by).toBeNull()
      expect(current!.content).toContain('2026-01-12T08:10:00Z Resume the migration.')
      expect(await state(s)).toMatchObject({ index_item_id: current!.id })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'forgets the index with a quoted utterance and rebuilds it without that line',
    async () => {
      const s = 'sess-forget'
      const [one, , two] = await ingest([
        prompt(s, 'Keep this line.', T(1)),
        prompt(s, 'Drop this line.', T(2)),
        end(s, T(3)),
      ]).then(async (ids) => [await itemId(ids[0]!), null, await itemId(ids[1]!)])
      expect(await tick()).toMatchObject({ written: 1 })
      await pg.psqlAs('service_role', `SELECT count(*) FROM public.engram_forget_items(ARRAY['${two}'::uuid], 'test');`)
      const [forgotten] = await indexes(s)
      expect(forgotten!.forgotten).toBe(true)

      expect(await tick()).toMatchObject({ due: 1, written: 1 })
      const rebuilt = (await indexes(s)).filter((i) => !i.forgotten)
      expect(rebuilt).toHaveLength(1)
      expect(rebuilt[0]!.content).toContain('Keep this line.')
      expect(rebuilt[0]!.content).not.toContain('Drop this line.')
      expect(rebuilt[0]!.lineage).toEqual([one])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'rebuilds after an extraction commit stores an observation, and refuses a build read before a change',
    async () => {
      const s = 'sess-extracted'
      const ids = await ingest([prompt(s, 'Move the cache.', T(1)), turn(s, 'The cache moved.', T(2)), end(s, T(3))])
      const [promptId, turnId] = await Promise.all([itemId(ids[0]!), itemId(ids[1]!)])
      expect(await tick()).toMatchObject({ written: 1 })
      expect(await tick()).toMatchObject({ due: 0 })

      const runId = await store.extractionBegin({ anchorId: promptId, sessionId: s, version: 'tst-version', model: null })
      await store.extractionCommit(runId!, {
        subjects: [{ key: 'cache', projectId: 'tst-repo', label: 'Cache tier' }],
        items: [
          {
            id: '00000000-0000-4000-8000-000000000501',
            class: 'observation',
            kind: 'fact',
            speaker: 'assistant',
            trust: 3,
            projectId: 'tst-repo',
            workspaceId: 'tst-ws',
            planSlug: null,
            sessionId: s,
            subjectId: null,
            subjectKey: 'cache',
            content: 'The cache moved.',
            searchText: 'Cache tier: The cache moved.',
            context: null,
            occurredAt: new Date(T(2)),
            standing: null,
            registerStatus: null,
            source: { type: 'extraction', event_key: `observation:${turnId}:cache-moved` },
            lineage: [turnId],
            entities: [],
          },
        ],
        stats: {},
      })
      expect(await state(s)).toMatchObject({ indexed_event_id: 0 })

      // A build that read the session before the next change is refused.
      const source = await store.sessionIndexSource(s)
      expect(source.observations).toEqual(['00000000-0000-4000-8000-000000000501'])
      await addExtracted(s, promptId, turnId)
      expect(await store.sessionIndexCommit(s, buildSessionIndexItem(source), ids[2]!)).toMatchObject({
        written: false,
        stale: true,
      })

      expect(await tick()).toMatchObject({ due: 1, written: 1 })
      const current = (await indexes(s)).filter((i) => i.superseded_by === null)
      expect(current).toHaveLength(1)
      expect(current[0]!.content).toMatch(/Observations \(2\): /)
      // Same last event time: the successor is one microsecond later.
      expect(current[0]!.occurred_at).toBe('2026-01-12T08:03:00.000001+00:00')
    },
    TEST_TIMEOUT_MS,
  )
})
