/**
 * The extraction RPCs through a real PostgREST in front of real Postgres, on
 * utterances materialized from capture events the way the worker stores them.
 * Every test starts from empty item, event, subject and run tables.
 * - pending: one anchor per session, oldest first; a later anchor waits behind
 *   a pending earlier one, due or not; a held failure backs off and counts, a
 *   transient one does neither; an exhausted anchor no longer blocks;
 * - assistant turns no MK prompt follows are pending, as a window of turns,
 *   after session_end or after the idle time, and not before; a later MK
 *   prompt makes them that prompt's turns;
 * - begin opens one run per anchor and version while one runs or succeeded;
 * - the window: anchor, event, turns and whether an earlier run extracted
 *   each, and the subjects, statements and observations of the anchor's scope;
 * - commit stores statements, observations, new subjects and entities
 *   together; a quote MK never said raises and writes nothing; a repeated
 *   event key is a duplicate;
 * - schema.sql applied twice in a row changes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildWindow,
  isItemConstraintError,
  renderUserMessage,
  sqlstateOf,
  type ExtractionCommit,
  type ExtractionItem,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const BASE_MS = Date.parse('2026-09-14T09:00:00Z')
const VERSION = 'extract-test'
const OTHER_VERSION = 'extract-other-test'
const IDLE_MS = 30 * 60_000
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000009'

const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }
const ROOT = { id: null, workspace: 'tst-ws', repo_root: null, branch: null, worktree: null }

function at(minutes: number): string {
  return new Date(BASE_MS + minutes * 60_000).toISOString()
}

function atDate(minutes: number): Date {
  return new Date(BASE_MS + minutes * 60_000)
}

let uuidCounter = 0
function event(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  minutes: number,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  uuidCounter += 1
  return {
    sessionId,
    eventUuid: `evt-${uuidCounter}`,
    type,
    occurredAt: at(minutes),
    cwd: '/home/tester/tst-repo',
    project: { ...REPO },
    planDirs: [],
    client: { name: 'engram-test', version: '1.0.0' },
    payload,
    scrub: { masked: [] },
    hits: [],
    ...overrides,
  }
}

function prompt(sessionId: string, text: string, minutes: number, overrides: Partial<StoredEvent> = {}): StoredEvent {
  return event(sessionId, 'user_prompt', { text, transcript_line: 1 }, minutes, overrides)
}

function turn(
  sessionId: string,
  text: string,
  minutes: number,
  tools: Array<{ name: string; ref: string | null }> = [],
): StoredEvent {
  return event(sessionId, 'assistant_turn', { text, transcript_line: 2, tools }, minutes)
}

function sessionEnd(sessionId: string, minutes: number): StoredEvent {
  return event(sessionId, 'session_end', {}, minutes)
}

describe.skipIf(!realPgImage || !postgrestImage)('extraction RPCs through PostgREST on real Postgres', () => {
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
      'TRUNCATE public.memory_items, public.memory_capture_events, public.memory_secret_hits, ' +
        'public.memory_extraction_runs, public.memory_subjects CASCADE;',
    )
  })

  /** Stores and materializes the events; returns each event's item id, '' for none. */
  async function seed(events: StoredEvent[]): Promise<string[]> {
    const ingested = await store.ingestEvents(events)
    expect(ingested.map((e) => e.status)).toEqual(events.map(() => 'accepted'))
    const result = await store.materialize(1000)
    expect(result).toMatchObject({ locked: true, failed: 0 })
    return Promise.all(
      ingested.map((e) =>
        pg.psql(`SELECT coalesce(max(id::text), '') FROM public.memory_items WHERE source ->> 'event_id' = '${e.eventId}';`),
      ),
    )
  }

  const count = (sql: string): Promise<number> => pg.psql(sql).then(Number)

  /** Sets when the session's latest event was received, as minutes past the base time. */
  async function received(sessionId: string, minutes: number): Promise<void> {
    await pg.psql(
      `UPDATE public.memory_session_state SET last_received_at = '${at(minutes)}' WHERE session_id = '${sessionId}';`,
    )
  }

  function pending(now: Date, limit = 20) {
    return store.extractionPending({ version: VERSION, limit, idleMs: IDLE_MS, now })
  }

  async function begin(anchorId: string, sessionId: string, version = VERSION): Promise<string> {
    const run = await store.extractionBegin({ anchorId, sessionId, version, model: 'test-model' })
    expect(run).not.toBeNull()
    return run!
  }

  async function heldFailure(anchorId: string, sessionId: string): Promise<void> {
    const run = await begin(anchorId, sessionId)
    expect(await store.extractionFail(run, { error: 'unparseable reply', failure: 'held', counted: true, stats: {} })).toBe(true)
  }

  async function transientFailure(anchorId: string, sessionId: string, counted = true): Promise<void> {
    const run = await begin(anchorId, sessionId)
    expect(await store.extractionFail(run, { error: 'provider unavailable', failure: 'transient', counted, stats: {} })).toBe(true)
  }

  async function succeed(
    anchorId: string,
    sessionId: string,
    observationSources: string[] = [],
    version = VERSION,
  ): Promise<void> {
    const run = await begin(anchorId, sessionId, version)
    await store.extractionCommit(run, { subjects: [], items: [], stats: { observation_sources: observationSources } })
  }

  /** The latest failure's end, in ms with microseconds kept. */
  async function lastFailureMs(anchorId: string): Promise<number> {
    return Number(
      await pg.psql(
        `SELECT extract(epoch FROM max(finished_at)) * 1000 FROM public.memory_extraction_runs
          WHERE anchor_item_id = '${anchorId}' AND status = 'failed';`,
      ),
    )
  }

  async function runRow(runId: string): Promise<{ status: string; finished: boolean; error: string | null; stats: Record<string, unknown> }> {
    const out = await pg.psql(
      `SELECT json_build_object('status', status, 'finished', finished_at IS NOT NULL, 'error', error, 'stats', stats)
         FROM public.memory_extraction_runs WHERE id = '${runId}';`,
    )
    return JSON.parse(out) as { status: string; finished: boolean; error: string | null; stats: Record<string, unknown> }
  }

  function statement(id: string, overrides: Partial<ExtractionItem>): ExtractionItem {
    return {
      id,
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: null,
      subjectId: null,
      subjectKey: 'subj-a',
      content: '',
      searchText: '',
      context: null,
      occurredAt: atDate(0),
      standing: false,
      registerStatus: null,
      source: { type: 'extraction', event_key: `x:${id}`, scope: 'project', applies_to: [] },
      lineage: [],
      entities: [],
      ...overrides,
    }
  }

  function observation(id: string, overrides: Partial<ExtractionItem>): ExtractionItem {
    return {
      ...statement(id, {}),
      class: 'observation',
      kind: 'finding',
      speaker: 'assistant',
      trust: 3,
      standing: null,
      source: { type: 'extraction', event_key: `x:${id}`, evidence: [] },
      ...overrides,
    }
  }

  it('returns each session\'s due anchors in order, the most recently received session first, backing off every failure', async () => {
    const [a1, a2, b1] = await seed([
      prompt('sess-a', 'First request in session a.', 0),
      prompt('sess-a', 'Second request in session a.', 2),
      prompt('sess-b', 'First request in session b.', 1),
    ])
    await received('sess-a', 2)
    await received('sess-b', 3)
    const now = new Date()

    const first = await pending(now)
    expect(first.map((p) => [p.anchorId, p.sessionId, p.anchorKind, p.failures])).toEqual([
      [b1, 'sess-b', 'user_prompt', 0],
      [a1, 'sess-a', 'user_prompt', 0],
      [a2, 'sess-a', 'user_prompt', 0],
    ])
    expect(first[1]!.occurredAt.toISOString()).toBe(at(0))
    expect(first[1]!.runningRunId).toBeNull()
    expect((await pending(now, 1)).map((p) => p.anchorId)).toEqual([b1])

    const open = await begin(a1!, 'sess-a')
    const running = (await pending(now))[1]!
    expect(running.anchorId).toBe(a1)
    expect(running.runningRunId).toBe(open)
    expect(running.runningStartedAt).toBeInstanceOf(Date)

    // A held failure backs the anchor off for 60 seconds, and the anchor
    // after it in the session waits even while it is not due.
    expect(await store.extractionFail(open, { error: 'unparseable reply', failure: 'held', counted: true, stats: {} })).toBe(true)
    const failedAt = await lastFailureMs(a1!)
    expect((await pending(new Date(Math.floor(failedAt) + 59_000))).map((p) => p.anchorId)).toEqual([b1])
    const due = await pending(new Date(Math.ceil(failedAt) + 60_000))
    expect(due.map((p) => [p.anchorId, p.failures])).toEqual([
      [b1, 0],
      [a1, 1],
      [a2, 0],
    ])

    // A transient failure backs its anchor off too, and counts apart from
    // the held ones.
    await transientFailure(b1!, 'sess-b')
    const flakyAt = await lastFailureMs(b1!)
    expect((await pending(new Date(Math.floor(flakyAt) + 59_000))).map((p) => p.anchorId)).not.toContain(b1)
    const both = await pending(new Date(Math.ceil(flakyAt) + 60_000))
    expect(both.map((p) => [p.anchorId, p.failures, p.heldFailures, p.transientFailures])).toEqual([
      [b1, 1, 0, 1],
      [a1, 1, 1, 0],
      [a2, 0, 0, 0],
    ])

    // The backoff follows the count of both classes: a held failure after a
    // transient one waits 120 seconds.
    await heldFailure(b1!, 'sess-b')
    const mixedAt = await lastFailureMs(b1!)
    expect((await pending(new Date(Math.floor(mixedAt) + 119_000))).map((p) => p.anchorId)).not.toContain(b1)
    expect(
      (await pending(new Date(Math.ceil(mixedAt) + 120_000))).map((p) => [p.anchorId, p.failures, p.heldFailures, p.transientFailures]),
    ).toEqual([
      [b1, 2, 1, 1],
      [a1, 1, 1, 0],
      [a2, 0, 0, 0],
    ])

    // The third held failure exhausts the earlier anchor, and the later one
    // of its session runs.
    await heldFailure(a1!, 'sess-a')
    await heldFailure(a1!, 'sess-a')
    const later = new Date(Date.now() + 24 * 60 * 60_000)
    expect((await pending(later)).map((p) => [p.anchorId, p.failures])).toEqual([
      [b1, 2],
      [a2, 0],
    ])

    // Five transient failures leave an anchor pending; the sixth exhausts it.
    for (let i = 0; i < 4; i++) await transientFailure(b1!, 'sess-b')
    expect((await pending(later)).map((p) => [p.anchorId, p.failures, p.heldFailures, p.transientFailures])).toEqual([
      [b1, 6, 1, 5],
      [a2, 0, 0, 0],
    ])
    await transientFailure(b1!, 'sess-b')
    expect((await pending(later)).map((p) => [p.anchorId, p.failures])).toEqual([[a2, 0]])

    // A succeeded anchor leaves its session too.
    await succeed(a2!, 'sess-a')
    expect(await pending(later, 20)).toEqual([])
  }, TEST_TIMEOUT_MS)

  it('backs an anchor off for an uncounted failure but never exhausts it on one', async () => {
    const [a1, a2] = await seed([
      prompt('sess-o', 'First request in the outage session.', 0),
      prompt('sess-o', 'Second request in the outage session.', 1),
    ])
    const later = new Date(Date.now() + 24 * 60 * 60_000)

    // Ten failures the provider never answered: each backs off, none counts.
    for (let i = 0; i < 10; i++) await transientFailure(a1!, 'sess-o', false)
    const lastAt = await lastFailureMs(a1!)
    const sixHours = 6 * 60 * 60_000
    expect((await pending(new Date(Math.floor(lastAt) + sixHours - 1000))).map((p) => p.anchorId)).toEqual([])
    expect(
      (await pending(new Date(Math.ceil(lastAt) + sixHours))).map((p) => [p.anchorId, p.failures, p.heldFailures, p.transientFailures]),
    ).toEqual([
      [a1, 10, 0, 0],
      [a2, 0, 0, 0],
    ])

    // Counted failures still exhaust it at six, whatever came uncounted before.
    for (let i = 0; i < 5; i++) await transientFailure(a1!, 'sess-o')
    expect((await pending(later)).map((p) => [p.anchorId, p.failures, p.transientFailures])).toEqual([
      [a1, 15, 5],
      [a2, 0, 0],
    ])
    await transientFailure(a1!, 'sess-o')
    expect((await pending(later)).map((p) => p.anchorId)).toEqual([a2])
    expect(
      await count(`SELECT count(*) FROM public.memory_extraction_runs WHERE anchor_item_id = '${a1}' AND stats @> '{"counted": false}';`),
    ).toBe(10)
  }, TEST_TIMEOUT_MS)

  it('makes a trailing turn pending after session_end or the idle time, and not before', async () => {
    const [p1, t1, q1, u1] = await seed([
      prompt('sess-t', 'Run the importer once.', 0),
      turn('sess-t', 'The importer ran once and stored 12 rows.', 1),
      prompt('sess-e', 'Count the rows.', 0.5),
      turn('sess-e', 'There are 12 rows.', 1.5),
    ])
    await succeed(p1!, 'sess-t')
    await succeed(q1!, 'sess-e')
    await received('sess-t', 1)
    await received('sess-e', 1.5)

    expect(await pending(atDate(5))).toEqual([])
    await seed([sessionEnd('sess-e', 2)])
    await received('sess-e', 2)
    expect((await pending(atDate(5))).map((p) => [p.anchorId, p.anchorKind])).toEqual([[u1, 'turns']])

    // Idleness is judged by received time: sess-t was last received at
    // minute 1, so it is idle once minute 31 has passed.
    expect((await pending(atDate(31))).map((p) => p.anchorId)).toEqual([u1])
    expect((await pending(atDate(31.1))).map((p) => [p.anchorId, p.anchorKind])).toEqual([
      [u1, 'turns'],
      [t1, 'turns'],
    ])

    // A backlog whose events are old but were received just now is not idle.
    await received('sess-t', 30.5)
    expect((await pending(atDate(31.1))).map((p) => p.anchorId)).toEqual([u1])

    // MK coming back to the session makes the turn an ordinary one again.
    const [p2] = await seed([prompt('sess-t', 'And once more.', 40)])
    await received('sess-t', 40)
    expect((await pending(atDate(80))).map((p) => [p.anchorId, p.anchorKind])).toEqual([
      [p2, 'user_prompt'],
      [u1, 'turns'],
    ])
  }, TEST_TIMEOUT_MS)

  it('opens one run per anchor and version while one is running or has succeeded', async () => {
    const [p1, end] = await seed([prompt('sess-r', 'Start the export.', 0), sessionEnd('sess-r', 1)])
    expect(end).toBe('')

    const first = await begin(p1!, 'sess-r')
    expect(await store.extractionBegin({ anchorId: p1!, sessionId: 'sess-r', version: VERSION, model: null })).toBeNull()
    expect(await begin(p1!, 'sess-r', 'extract-other')).not.toBe(first)

    const long = 'x'.repeat(700)
    expect(await store.extractionFail(first, { error: long, failure: 'held', counted: true, stats: { reply_chars: 0 } })).toBe(true)
    expect(await runRow(first)).toEqual({
      status: 'failed',
      finished: true,
      error: 'x'.repeat(500),
      stats: { reply_chars: 0, failure: 'held', counted: true },
    })
    expect(await store.extractionFail(first, { error: 'again', failure: 'transient', counted: false, stats: {} })).toBe(false)

    const second = await begin(p1!, 'sess-r')
    expect(second).not.toBe(first)
    await store.extractionCommit(second, { subjects: [], items: [], stats: { statements: { proposed: 0 } } })
    expect(await runRow(second)).toEqual({
      status: 'succeeded',
      finished: true,
      error: null,
      stats: {
        statements: { proposed: 0 },
        subjects_created: 0,
        entities: 0,
        duplicates: 0,
        links_applied: 0,
        links_rejected: [],
        restatements: [],
        link_race: [],
      },
    })
    expect(await store.extractionBegin({ anchorId: p1!, sessionId: 'sess-r', version: VERSION, model: null })).toBeNull()

    const wrongSession = await store
      .extractionBegin({ anchorId: p1!, sessionId: 'sess-x', version: VERSION, model: null })
      .catch((e: unknown) => e)
    expect(sqlstateOf(wrongSession)).toBe('22023')
    const noAnchor = await store
      .extractionBegin({ anchorId: UNKNOWN_ID, sessionId: 'sess-r', version: VERSION, model: null })
      .catch((e: unknown) => e)
    expect(sqlstateOf(noAnchor)).toBe('22023')
  }, TEST_TIMEOUT_MS)

  it('builds the window: the anchor, its event and turns, and whether an earlier run extracted each turn', async () => {
    const tools = [
      { name: 'Read', ref: 'src/importer.ts' },
      { name: 'Bash', ref: 'npm test' },
    ]
    const answer = {
      questions: [{ question: 'Which flag name?', header: 'Flag', options: [{ label: 'importer-v2', description: 'new' }], multiSelect: false }],
      answers: { 'Which flag name?': 'importer-v2' },
      transcript_line: 9,
    }
    const plan = { planDirs: ['Active/tst-plan/'] }
    const [p1, t1, p2, p3, a1] = await seed([
      prompt('sess-w', 'Look at the importer.', 0, plan),
      turn('sess-w', 'The importer skips rows without an id.', 1, tools),
      prompt('sess-w', 'Ship the importer behind a flag for TST-77.', 2, plan),
      prompt('sess-w', 'Also log every skipped row.', 3, plan),
      event('sess-w', 'user_answer', answer, 4, plan),
    ])

    const w2 = await store.extractionWindow(p2!, 500, 40, VERSION)
    expect(w2).toMatchObject({
      anchor: {
        id: p2,
        kind: 'user_prompt',
        session_id: 'sess-w',
        project_id: 'tst-repo',
        workspace_id: 'tst-ws',
        content: 'Ship the importer behind a flag for TST-77.',
        context: null,
        occurred_at: '2026-09-14T09:02:00.000000Z',
      },
      anchor_event: { plan_dirs: ['Active/tst-plan/'], payload: { text: 'Ship the importer behind a flag for TST-77.' } },
      turns: [{ id: t1, kind: 'assistant_turn', content: 'The importer skips rows without an id.', source: { tools }, observed: false }],
      subjects: [],
      statements: [],
      observations: [],
      projects: [
        { id: 'tst-other', kind: 'project' },
        { id: 'tst-repo', kind: 'project' },
        { id: 'tst-ws', kind: 'workspace' },
      ],
    })
    const built = buildWindow(w2!)
    expect(built.planSlug).toBe('tst-plan')
    expect(built.turns.map((t) => t.tools)).toEqual([tools])
    expect(renderUserMessage(built)).toContain('turn-1 (ASSISTANT, 2026-09-14T09:01:00.000Z):\nThe importer skips')

    // p3 follows p2 with no turn between them. The turn is p2's to extract,
    // so p3 shows it only once p2's run at this version has extracted it,
    // and then as context.
    expect(await store.extractionWindow(p3!, 500, 40, VERSION)).toMatchObject({ turns: [] })
    await succeed(p2!, 'sess-w', [t1!], OTHER_VERSION)
    expect(await store.extractionWindow(p3!, 500, 40, VERSION)).toMatchObject({ turns: [] })
    await succeed(p2!, 'sess-w', [t1!])
    expect(await store.extractionWindow(p3!, 500, 40, VERSION)).toMatchObject({ turns: [{ id: t1, observed: true }] })
    expect(await store.extractionWindow(p1!, 500, 40, VERSION)).toMatchObject({ turns: [] })
    expect(await store.extractionWindow(a1!, 500, 40, VERSION)).toMatchObject({
      anchor: { kind: 'user_answer' },
      anchor_event: { payload: answer },
      turns: [],
    })
    expect(await store.extractionWindow(UNKNOWN_ID, 500, 40, VERSION)).toBeNull()
    expect(await store.extractionWindow('not-a-uuid', 500, 40, VERSION)).toBeNull()

    // A turn a flush extracted is context to the prompt that later resumed
    // its session, and its own window shows nothing more.
    const [x1, t9] = await seed([
      prompt('sess-x', 'Rebuild the index.', 0),
      turn('sess-x', 'The index was rebuilt.', 1),
      sessionEnd('sess-x', 2),
    ])
    await succeed(x1!, 'sess-x')
    expect((await pending(atDate(3))).map((p) => p.anchorId)).toContain(t9)
    await succeed(t9!, 'sess-x', [t9!])
    const [p9] = await seed([prompt('sess-x', 'Check it again.', 60)])
    expect(await store.extractionWindow(p9!, 500, 40, VERSION)).toMatchObject({ turns: [{ id: t9, observed: true }] })
    expect(await store.extractionWindow(t9!, 500, 40, VERSION)).toMatchObject({ anchor: { kind: 'assistant_turn' }, turns: [] })
  }, TEST_TIMEOUT_MS)

  it('passes the turns of an exhausted prompt to the next prompt, and shows a dialog answer none', async () => {
    const answer = {
      questions: [{ question: 'Which flag name?', header: 'Flag', options: [{ label: 'v2', description: 'new' }], multiSelect: false }],
      answers: { 'Which flag name?': 'v2' },
      transcript_line: 9,
    }
    const [t1, p1, t2, a1, p2] = await seed([
      turn('sess-g', 'The importer reads rows in batches.', 0),
      prompt('sess-g', 'Go on.', 1),
      turn('sess-g', 'The importer skips rows without an id.', 2),
      event('sess-g', 'user_answer', answer, 3),
      prompt('sess-g', 'Ship it.', 4),
    ])
    const turnsOf = async (anchor: string) =>
      ((await store.extractionWindow(anchor, 500, 40, VERSION))!.turns ?? []).map((t) => [t.id, t.observed])

    expect(await turnsOf(p1!)).toEqual([[t1, false]])
    expect(await turnsOf(a1!)).toEqual([])
    expect(await turnsOf(p2!)).toEqual([[t2, false]])

    for (let i = 0; i < 3; i++) await heldFailure(p1!, 'sess-g')
    expect(await turnsOf(p2!)).toEqual([
      [t1, false],
      [t2, false],
    ])
    expect((await pending(atDate(5))).map((p) => p.anchorId)).toEqual([a1, p2])
  }, TEST_TIMEOUT_MS)

  it('lists the subjects, statements and observations of the anchor\'s scope only', async () => {
    const words = 'alpha bravo charlie delta echo foxtrot golf india'
    const plan = { planDirs: ['Active/tst-plan'] }
    const [u0, t0, p1, o1, r1] = await seed([
      prompt('sess-s', words, 0, plan),
      turn('sess-s', 'Stored the words.', 1),
      prompt('sess-s', 'What next?', 10, plan),
      prompt('sess-o', 'kilo lima', 0),
      prompt('sess-r', 'From the workspace root.', 10, { project: { ...ROOT }, cwd: '/home/tester' }),
    ])
    const run = await begin(u0!, 'sess-s')
    const minute = (s: number): Date => new Date(BASE_MS + s * 1000)
    const said = (id: string, content: string, s: number, extra: Partial<ExtractionItem>): ExtractionItem =>
      statement(id, { content, searchText: content, sessionId: 'sess-s', subjectKey: 'subj-repo', lineage: [u0!], occurredAt: minute(s), ...extra })
    const ids = Array.from({ length: 13 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`)
    const scoped = (scope: string) => ({ type: 'extraction' as const, scope, applies_to: [] })
    await store.extractionCommit(run, {
      subjects: [
        { key: 'subj-repo', label: 'importer flags', projectId: 'tst-repo' },
        { key: 'subj-global', label: 'house rules', projectId: null },
        { key: 'subj-other', label: 'other things', projectId: 'tst-other' },
      ],
      items: [
        said(ids[0]!, 'alpha', 1, { projectId: null, workspaceId: null, subjectKey: 'subj-global', source: { ...scoped('global'), event_key: 'x:a' } }),
        said(ids[1]!, 'bravo', 2, { projectId: null, source: { ...scoped('workspace'), event_key: 'x:b' } }),
        said(ids[2]!, 'charlie', 3, { subjectKey: 'subj-repo', source: { ...scoped('project'), event_key: 'x:c' } }),
        said(ids[3]!, 'delta', 4, { planSlug: 'tst-plan', source: { ...scoped('plan'), event_key: 'x:d' } }),
        said(ids[4]!, 'echo', 5, { planSlug: 'other-plan', source: { ...scoped('plan'), event_key: 'x:e' } }),
        said(ids[5]!, 'foxtrot', 6, { planSlug: 'tst-plan', source: { ...scoped('session'), event_key: 'x:f' } }),
        said(ids[6]!, 'golf', 7, { projectId: 'tst-other', subjectKey: 'subj-other', source: { ...scoped('project'), event_key: 'x:g' } }),
        said(ids[7]!, 'india', 8, { source: { ...scoped('project'), event_key: 'x:i' } }),
        statement(ids[8]!, {
          subjectKey: 'subj-repo',
          content: 'kilo',
          searchText: 'kilo',
          sessionId: 'sess-o',
          lineage: [o1!],
          occurredAt: minute(9),
          source: { ...scoped('session'), event_key: 'x:k' },
        }),
        observation(ids[9]!, { subjectKey: 'subj-repo', content: 'The importer lives in src/importer.ts.', searchText: 'x', lineage: [t0!], occurredAt: minute(10) }),
        observation(ids[10]!, { subjectKey: 'subj-repo', content: 'The other repository has no importer.', searchText: 'x', projectId: 'tst-other', lineage: [t0!], occurredAt: minute(11) }),
        observation(ids[11]!, { content: 'The workspace keeps one importer.', searchText: 'x', projectId: null, subjectKey: 'subj-global', lineage: [t0!], occurredAt: minute(12) }),
      ],
      stats: {},
    })
    await pg.psql(`SELECT public.engram_retire_items(ARRAY['${ids[7]}']::uuid[], 'replaced');`)

    const inProject = await store.extractionWindow(p1!, 500, 40, VERSION)
    expect(inProject!.statements!.map((s) => s.content)).toEqual(['foxtrot', 'delta', 'charlie', 'bravo', 'alpha'])
    expect(inProject!.statements![2]).toEqual({
      id: ids[2],
      kind: 'ruling',
      subject_id: expect.any(String),
      subject_label: 'importer flags',
      project_id: 'tst-repo',
      workspace_id: 'tst-ws',
      content: 'charlie',
      occurred_at: '2026-09-14T09:00:03.000000Z',
    })
    expect(inProject!.observations!.map((o) => o.content)).toEqual([
      'The workspace keeps one importer.',
      'The importer lives in src/importer.ts.',
    ])
    // A retired statement no longer counts as a use of its subject, and a
    // subject of another project is not listed.
    expect(inProject!.subjects!.map((s) => [s.label, s.project_id, s.last_used_at])).toEqual([
      ['house rules', null, '2026-09-14T09:00:12.000000Z'],
      ['importer flags', 'tst-repo', '2026-09-14T09:00:11.000000Z'],
    ])

    const atRoot = await store.extractionWindow(r1!, 500, 40, VERSION)
    expect(atRoot!.anchor.project_id).toBeNull()
    expect(atRoot!.statements!.map((s) => s.content)).toEqual(['bravo', 'alpha'])
    expect(atRoot!.observations!.map((o) => o.content)).toEqual(['The workspace keeps one importer.'])
    expect(atRoot!.subjects!.map((s) => s.label)).toEqual(['house rules'])

    const cut = await store.extractionWindow(p1!, 1, 2, VERSION)
    expect(cut!.statements!.map((s) => s.content)).toEqual(['foxtrot', 'delta'])
    expect(cut!.subjects!.map((s) => s.label)).toEqual(['house rules'])
  }, TEST_TIMEOUT_MS)

  async function exchange(): Promise<{ turnId: string; promptId: string; run: string }> {
    const [, turnId, promptId] = await seed([
      prompt('sess-c', 'Check the importer.', 0),
      turn('sess-c', 'The importer in tst-repo skips rows without an id.', 1, [
        { name: 'Read', ref: '/home/tester/tst-repo/src/importer.ts' },
      ]),
      prompt('sess-c', 'Ship the importer behind a flag for TST-77, every time.', 2),
    ])
    return { turnId: turnId!, promptId: promptId!, run: await begin(promptId!, 'sess-c') }
  }

  function commitFor(promptId: string, turnId: string, run: string, quote: string): ExtractionCommit {
    return {
      subjects: [{ key: 'subj-a', label: 'Importer flags', projectId: 'tst-repo' }],
      items: [
        statement('00000000-0000-4000-8000-000000000201', {
          content: quote,
          searchText: quote,
          sessionId: 'sess-c',
          occurredAt: atDate(2),
          standing: true,
          registerStatus: 'candidate',
          lineage: [promptId],
          source: { type: 'extraction', utterance_id: promptId, run_id: run, event_key: 'x:stmt-1', scope: 'project', applies_to: ['importer'] },
          entities: [{ entity: 'TST-77', entityType: 'ticket' }],
        }),
        observation('00000000-0000-4000-8000-000000000202', {
          trust: 2,
          content: 'The importer in tst-repo skips rows without an id.',
          searchText: 'Importer flags: The importer in tst-repo skips rows without an id.',
          sessionId: 'sess-c',
          occurredAt: atDate(1),
          lineage: [turnId],
          source: {
            type: 'extraction',
            utterance_id: turnId,
            run_id: run,
            event_key: 'x:obs-1',
            evidence: [{ type: 'file', ref: 'src/importer.ts' }],
          },
          entities: [
            { entity: 'tst-repo', entityType: 'repo' },
            { entity: 'src/importer.ts', entityType: 'path' },
          ],
        }),
      ],
      stats: { statements: { proposed: 1, stored: 1, rejected: 0 }, observations: { proposed: 1, stored: 1, rejected: 0, trust2: 1, trust3: 0 } },
    }
  }

  it('commits a statement, an observation, a new subject and their entities together', async () => {
    const { promptId, turnId, run } = await exchange()
    const result = await store.extractionCommit(run, commitFor(promptId, turnId, run, 'Ship the importer behind a flag for TST-77'))
    expect(result).toEqual({
      itemIds: ['00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202'],
      subjectsCreated: 1,
      duplicates: 0,
      restatements: 0,
    })

    const rows = JSON.parse(
      await pg.psql(
        `SELECT json_agg(json_build_object('class', i.class, 'trust', i.trust, 'run', i.extraction_run_id, 'subject', s.label,
                                           'subject_project', s.project_id, 'register', i.register_status) ORDER BY i.id)
           FROM public.memory_items i JOIN public.memory_subjects s ON s.id = i.subject_id
          WHERE i.class IN ('mk_statement', 'observation');`,
      ),
    )
    expect(rows).toEqual([
      { class: 'mk_statement', trust: 0, run, subject: 'Importer flags', subject_project: 'tst-repo', register: 'candidate' },
      { class: 'observation', trust: 2, run, subject: 'Importer flags', subject_project: 'tst-repo', register: null },
    ])
    expect(await pg.psql(`SELECT string_agg(entity_type || ':' || entity, ',' ORDER BY entity COLLATE "C") FROM public.memory_item_entities;`)).toBe(
      'ticket:TST-77,path:src/importer.ts,repo:tst-repo',
    )
    expect(await runRow(run)).toEqual({
      status: 'succeeded',
      finished: true,
      error: null,
      stats: {
        statements: { proposed: 1, stored: 1, rejected: 0 },
        observations: { proposed: 1, stored: 1, rejected: 0, trust2: 1, trust3: 0 },
        subjects_created: 1,
        entities: 3,
        duplicates: 0,
        links_applied: 0,
        links_rejected: [],
        link_race: [],
        restatements: [],
      },
    })

    // The committed items and their subject are what the next window lists.
    const [later] = await seed([prompt('sess-c', 'Next step?', 5)])
    const next = await store.extractionWindow(later!, 500, 40, VERSION)
    expect(next!.subjects!.map((s) => s.label)).toEqual(['Importer flags'])
    expect(next!.statements!.map((s) => s.id)).toEqual(['00000000-0000-4000-8000-000000000201'])
    expect(next!.observations!.map((s) => s.id)).toEqual(['00000000-0000-4000-8000-000000000202'])
  }, TEST_TIMEOUT_MS)

  it('raises on a quote MK never said, writes nothing and leaves the run running', async () => {
    const { promptId, turnId, run } = await exchange()
    const err = await store
      .extractionCommit(run, commitFor(promptId, turnId, run, 'Ship the importer without a flag'))
      .catch((e: unknown) => e)
    expect(isItemConstraintError(err)).toBe(true)
    expect((err as { constraint: string }).constraint).toBe('memory_items_lineage')

    expect(await count(`SELECT count(*) FROM public.memory_items WHERE class IN ('mk_statement', 'observation');`)).toBe(0)
    expect(await count('SELECT count(*) FROM public.memory_subjects;')).toBe(0)
    expect(await count('SELECT count(*) FROM public.memory_item_entities;')).toBe(0)
    expect(await runRow(run)).toMatchObject({ status: 'running', finished: false })

    expect(await store.extractionFail(run, { error: 'commit refused', failure: 'held', counted: true, stats: {} })).toBe(true)
    const closed = await store.extractionCommit(run, { subjects: [], items: [], stats: {} }).catch((e: unknown) => e)
    expect(sqlstateOf(closed)).toBe('55000')

    const both = await begin(promptId, 'sess-c', 'extract-other')
    const twoSubjects = await store
      .extractionCommit(both, {
        subjects: [{ key: 'subj-a', label: 'x', projectId: null }],
        items: [statement('00000000-0000-4000-8000-000000000203', { subjectId: UNKNOWN_ID, subjectKey: 'subj-a' })],
        stats: {},
      })
      .catch((e: unknown) => e)
    expect(sqlstateOf(twoSubjects)).toBe('22023')
    expect((twoSubjects as Error).message).toContain('item 1 must give exactly one of subject_id and subject_key')
  }, TEST_TIMEOUT_MS)

  it('counts a repeated event key as a duplicate and reuses a subject whatever its case', async () => {
    const { promptId, turnId, run } = await exchange()
    const quote = 'Ship the importer behind a flag for TST-77'
    await store.extractionCommit(run, commitFor(promptId, turnId, run, quote))

    const again = await begin(promptId, 'sess-c', 'extract-other')
    const repeat = commitFor(promptId, turnId, again, quote)
    const result = await store.extractionCommit(again, {
      subjects: [{ key: 'subj-a', label: 'importer FLAGS', projectId: 'tst-repo' }],
      items: [{ ...repeat.items[0]!, id: '00000000-0000-4000-8000-000000000204' }],
      stats: {},
    })
    expect(result).toEqual({ itemIds: ['00000000-0000-4000-8000-000000000201'], subjectsCreated: 0, duplicates: 1, restatements: 0 })
    expect(await count(`SELECT count(*) FROM public.memory_items WHERE class = 'mk_statement';`)).toBe(1)
    expect(await count('SELECT count(*) FROM public.memory_subjects;')).toBe(1)
    expect(await count('SELECT count(*) FROM public.memory_item_entities;')).toBe(3)
    expect(await runRow(again)).toMatchObject({ status: 'succeeded', stats: { subjects_created: 0, entities: 0, duplicates: 1 } })
  }, TEST_TIMEOUT_MS)

  it('changes nothing when schema.sql is applied twice in a row', async () => {
    await pg.applySchema()
    const before = await pg.dumpSchema()
    await pg.applySchema()
    expect(await pg.dumpSchema()).toBe(before)
    expect(before).toContain('CREATE UNIQUE INDEX idx_extraction_runs_anchor_version')
  }, TEST_TIMEOUT_MS)
})
