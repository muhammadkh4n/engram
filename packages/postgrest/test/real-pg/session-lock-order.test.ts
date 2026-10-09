/**
 * Writers of memory_session_state on real Postgres, run concurrently from
 * separate connections. Each test lets a third connection hold one session
 * row until both writers wait on a lock, then releases it, so the writers
 * reach the two rows in the order they ask for them:
 * - two ingests, one with events of sessions A then B and the other B then
 *   A, both succeed;
 * - an ingest and an extraction commit that touches the rows of both
 *   sessions (it stores an item in one and supersedes an item in the other)
 *   both succeed, whichever session the ingest names first.
 * A writer that took the rows in the order its input names them would
 * deadlock here, and Postgres would abort one of them with 40P01.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, waitUntilLockWait, type PsqlSession, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const SESSION_A = 'sess-lock-alpha'
const SESSION_B = 'sess-lock-bravo'
const T = (minute: number): string => new Date(Date.UTC(2026, 1, 3, 9, minute)).toISOString()

let uuidCounter = 0
function event(sessionId: string, type: 'user_prompt' | 'assistant_turn', text: string, at: string) {
  uuidCounter += 1
  return {
    session_id: sessionId,
    event_uuid: `evt-lock-${uuidCounter}`,
    type,
    occurred_at: at,
    cwd: null,
    project: { id: null, workspace: null, repo_root: null, branch: null, worktree: null },
    plan_dirs: [],
    client: { name: 'engram-test', version: '1.0.0' },
    payload: type === 'user_prompt' ? { text, transcript_line: 1 } : { text, transcript_line: 2, tools: [] },
    scrub: { masked: [] },
    hits: [],
  }
}

const literal = (value: unknown): string => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`

const ingestSql = (events: unknown[]): string =>
  `SELECT string_agg(status, ',' ORDER BY ord) FROM public.engram_capture_ingest(${literal(events)});`

describe.skipIf(!realPgImage)('session rows under concurrent writers on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  beforeEach(async () => {
    await pg.psql(
      'TRUNCATE public.memory_item_links, public.memory_items, public.memory_capture_events, public.memory_secret_hits, ' +
        'public.memory_extraction_runs, public.memory_subjects, public.memory_session_state CASCADE;',
    )
  })

  /** Ingests and materializes a prompt and a turn per session; returns each one's utterance id. */
  async function seed(): Promise<Record<string, { prompt: string; turn: string }>> {
    const events = [SESSION_B, SESSION_A].flatMap((s, i) => [
      event(s, 'user_prompt', `Plan the cache for ${s}.`, T(i * 10)),
      event(s, 'assistant_turn', `The cache for ${s} is planned.`, T(i * 10 + 1)),
    ])
    expect(await pg.psql(ingestSql(events))).toBe(events.map(() => 'accepted').join(','))
    expect(JSON.parse(await pg.psql('SELECT public.engram_capture_materialize(1000);'))).toMatchObject({ failed: 0 })
    const utterance = (uuid: string) =>
      pg.psql(
        `SELECT i.id FROM public.memory_items i JOIN public.memory_capture_events c ON c.id = (i.source ->> 'event_id')::bigint
          WHERE c.event_uuid = '${uuid}';`,
      )
    const ids: Record<string, { prompt: string; turn: string }> = {}
    for (const [i, s] of [SESSION_B, SESSION_A].entries()) {
      ids[s] = { prompt: await utterance(events[i * 2]!.event_uuid), turn: await utterance(events[i * 2 + 1]!.event_uuid) }
    }
    return ids
  }

  async function sessions(count: number): Promise<Array<{ conn: PsqlSession; pid: string }>> {
    const opened: Array<{ conn: PsqlSession; pid: string }> = []
    for (let i = 0; i < count; i += 1) {
      const conn = await pg.session()
      opened.push({ conn, pid: await conn.run('SELECT pg_backend_pid();') })
    }
    return opened
  }

  const holdRow = async (conn: PsqlSession, sessionId: string): Promise<void> => {
    await conn.run('BEGIN;')
    await conn.run(`SELECT 1 FROM public.memory_session_state WHERE session_id = '${sessionId}' FOR UPDATE;`)
  }

  it(
    'lets two ingests naming two sessions in opposite orders both succeed',
    async () => {
      await seed()
      const [holder, first, second] = await sessions(3)
      try {
        await holdRow(holder!.conn, SESSION_A)
        const firstBatch = [event(SESSION_A, 'user_prompt', 'Next step one.', T(30)), event(SESSION_B, 'user_prompt', 'Next step two.', T(31))]
        const secondBatch = [event(SESSION_B, 'user_prompt', 'Other step one.', T(32)), event(SESSION_A, 'user_prompt', 'Other step two.', T(33))]
        const firstIngest = first!.conn.run(ingestSql(firstBatch))
        await waitUntilLockWait(pg, first!.pid)
        const secondIngest = second!.conn.run(ingestSql(secondBatch))
        await waitUntilLockWait(pg, second!.pid)
        await holder!.conn.run('COMMIT;')
        expect(await Promise.all([firstIngest, secondIngest])).toEqual(['accepted,accepted', 'accepted,accepted'])
      } finally {
        for (const s of [holder, first, second]) await s!.conn.close()
      }
      expect(
        await pg.psql(
          `SELECT string_agg(session_id || ':' || (last_event_id = (SELECT max(id) FROM public.memory_capture_events c
                                                                     WHERE c.session_id = st.session_id)), ',' ORDER BY session_id)
             FROM public.memory_session_state st;`,
        ),
      ).toBe(`${SESSION_A}:true,${SESSION_B}:true`)
    },
    TEST_TIMEOUT_MS,
  )

  it.each([
    ['A then B', [SESSION_A, SESSION_B]],
    ['B then A', [SESSION_B, SESSION_A]],
  ])(
    'lets an ingest naming %s and an extraction commit over both sessions both succeed',
    async (_label, order) => {
      const ids = await seed()
      const subject = await pg.psql(
        `WITH added AS (INSERT INTO public.memory_subjects (project_id, label) VALUES (NULL, 'Cache plan') RETURNING id) SELECT id FROM added;`,
      )
      const older = await pg.psql(
        `WITH added AS (
           INSERT INTO public.memory_items (class, kind, speaker, trust, session_id, subject_id, content, search_text,
                                            occurred_at, source, lineage)
           VALUES ('observation', 'fact', 'assistant', 3, '${SESSION_B}', '${subject}', 'The cache is planned.',
                   'Cache plan: The cache is planned.', '${T(1)}',
                   jsonb_build_object('type', 'extraction', 'event_key', 'observation:${ids[SESSION_B]!.turn}:planned'),
                   ARRAY['${ids[SESSION_B]!.turn}'::uuid])
           RETURNING id)
         SELECT id FROM added;`,
      )
      await pg.psql('UPDATE public.memory_session_state SET indexed_event_id = last_event_id;')
      const run = await pg.psql(
        `SELECT public.engram_extraction_begin('${ids[SESSION_A]!.prompt}', '${SESSION_A}', 'lock-order', NULL);`,
      )
      const payload = {
        subjects: [],
        items: [
          {
            id: '00000000-0000-4000-8000-0000000000c1',
            class: 'observation',
            kind: 'fact',
            speaker: 'assistant',
            trust: 3,
            project_id: null,
            workspace_id: null,
            plan_slug: null,
            session_id: SESSION_A,
            content: 'The cache moved to the edge.',
            search_text: 'Cache plan: The cache moved to the edge.',
            context: null,
            occurred_at: T(11),
            standing: null,
            register_status: null,
            source: { type: 'extraction', event_key: `observation:${ids[SESSION_A]!.turn}:moved` },
            lineage: [ids[SESSION_A]!.turn],
            entities: [],
            subject_id: subject,
            links: [{ rel: 'supersedes', target: older }],
          },
        ],
        stats: {},
      }

      const [holder, ingester, committer] = await sessions(3)
      try {
        await holdRow(holder!.conn, order[0]!)
        const batch = order.map((s, i) => event(s, 'user_prompt', `Resume step ${i}.`, T(40 + i)))
        const ingest = ingester!.conn.run(ingestSql(batch))
        await waitUntilLockWait(pg, ingester!.pid)
        const commit = committer!.conn.run(
          `SELECT (public.engram_extraction_commit('${run}', ${literal(payload)}) ->> 'links_applied');`,
        )
        await waitUntilLockWait(pg, committer!.pid)
        await holder!.conn.run('COMMIT;')
        expect(await Promise.all([ingest, commit])).toEqual(['accepted,accepted', '1'])
      } finally {
        for (const s of [holder, ingester, committer]) await s!.conn.close()
      }
      expect(await pg.psql(`SELECT superseded_by FROM public.memory_items WHERE id = '${older}';`)).toBe(
        '00000000-0000-4000-8000-0000000000c1',
      )
      expect(
        await pg.psql(
          `SELECT string_agg(session_id || ':' || indexed_event_id, ',' ORDER BY session_id) FROM public.memory_session_state;`,
        ),
      ).toBe(`${SESSION_A}:0,${SESSION_B}:0`)
    },
    TEST_TIMEOUT_MS,
  )
})
