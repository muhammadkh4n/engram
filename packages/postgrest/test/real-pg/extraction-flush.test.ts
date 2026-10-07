/**
 * Every session is extracted, however short, on real Postgres behind a real
 * PostgREST: one MK utterance is a window on the next tick, the assistant
 * turns after a session's last MK utterance are flushed once it ends or goes
 * idle, a flushed turn is only context to a later window, and a tick with a
 * smaller budget than the backlog serves the most recently received sessions
 * first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  runExtractionTick,
  type CompleteJsonRequest,
  type IntelligenceAdapter,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }
const BASE_MS = Date.parse('2026-10-01T09:00:00Z')
const EMPTY_REPLY = '{"statements":[],"observations":[]}'
const OBSERVATION_REPLY = JSON.stringify({
  statements: [],
  observations: [
    {
      assistant_utterance_id: 'turn-1',
      claim: 'The tst-repo importer skips rows that have no id column.',
      kind: 'fact',
      subject: { new: 'tst-repo importer' },
      evidence: [],
      valid_at: null,
      supersedes: [],
    },
  ],
})

let uuidCounter = 0
function event(sessionId: string, type: string, payload: Record<string, unknown>, minutes: number): StoredEvent {
  uuidCounter += 1
  return {
    sessionId,
    eventUuid: `evt-flush-${uuidCounter}`,
    type,
    occurredAt: new Date(BASE_MS + minutes * 60_000).toISOString(),
    cwd: '/home/tester/tst-repo',
    project: { ...REPO },
    planDirs: [],
    client: { name: 'engram-test', version: '1.0.0' },
    payload,
    scrub: { masked: [] },
    hits: [],
  }
}

const prompt = (sessionId: string, text: string, minutes: number): StoredEvent =>
  event(sessionId, 'user_prompt', { text, transcript_line: 1 }, minutes)
const turn = (sessionId: string, text: string, minutes: number): StoredEvent =>
  event(sessionId, 'assistant_turn', { text, transcript_line: 2, tools: [] }, minutes)
const sessionEnd = (sessionId: string, minutes: number): StoredEvent => event(sessionId, 'session_end', {}, minutes)

/**
 * Proposes the importer finding for every window whose assistant turn is new
 * to extraction, and nothing otherwise.
 */
function scriptedModel() {
  const requests: CompleteJsonRequest[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      requests.push(req)
      const freshTurn = /^turn-1 \(ASSISTANT, [^)]*\):$/m.test(req.user)
      return { text: freshTurn ? OBSERVATION_REPLY : EMPTY_REPLY, finishReason: 'stop', model: 'tst-model' }
    },
  }
  return { intelligence, requests }
}

describe.skipIf(!realPgImage || !postgrestImage)('extraction of short sessions and trailing turns', () => {
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

  /** Ingests and materializes the events; returns the item id of each, '' when it stores none. */
  async function seed(events: StoredEvent[]): Promise<string[]> {
    const ingested = await store.ingestEvents(events)
    expect(ingested.map((e) => e.status)).toEqual(events.map(() => 'accepted'))
    expect(await store.materialize(1000)).toMatchObject({ locked: true, failed: 0 })
    return Promise.all(
      ingested.map((e) => pg.psql(`SELECT id FROM public.memory_items WHERE source ->> 'event_id' = '${e.eventId}';`)),
    )
  }

  /** Sets when the session's latest event was received, `minutesAgo` before now. */
  async function receivedAgo(sessionId: string, minutesAgo: number): Promise<void> {
    await pg.psql(
      `UPDATE public.memory_session_state SET last_received_at = now() - make_interval(secs => ${minutesAgo * 60})
        WHERE session_id = '${sessionId}';`,
    )
  }

  function ticker(windowsPerTick?: number) {
    const model = scriptedModel()
    const tick = () =>
      runExtractionTick({
        store,
        intelligence: model.intelligence,
        model: 'tst-chat-model',
        ...(windowsPerTick === undefined ? {} : { windowsPerTick }),
        log: () => {},
      })
    return { tick, requests: model.requests }
  }

  const count = (sql: string): Promise<number> => pg.psql(sql).then(Number)
  const observations = (): Promise<number> =>
    count(`SELECT count(*) FROM public.memory_items WHERE class = 'observation';`)

  async function succeededAnchors(): Promise<string[]> {
    const out = await pg.psql(
      `SELECT coalesce(string_agg(anchor_item_id::text, ',' ORDER BY finished_at, id), '')
         FROM public.memory_extraction_runs WHERE status = 'succeeded';`,
    )
    return out === '' ? [] : out.split(',')
  }

  it(
    'extracts a session whose only MK utterance is "ok" on the next tick',
    async () => {
      const [ok] = await seed([prompt('tst-sess-ok', 'ok', 0)])
      const { tick, requests } = ticker()

      expect(await tick()).toEqual({ windows: 1, succeeded: 1, held: 0, transient: 0, full: false })
      expect(requests).toHaveLength(1)
      expect(requests[0]!.user).toContain('utt-1 (MK, 2026-10-01T09:00:00.000Z):\nok')
      expect(await succeededAnchors()).toEqual([ok])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'runs the two most recently received of three sessions first under a budget of 2',
    async () => {
      const [a] = await seed([prompt('tst-sess-a', 'Look at the importer.', 0)])
      const [b] = await seed([prompt('tst-sess-b', 'Look at the exporter.', 1)])
      const [c] = await seed([prompt('tst-sess-c', 'Look at the scheduler.', 2)])
      await receivedAgo('tst-sess-a', 5)
      await receivedAgo('tst-sess-b', 50)
      await receivedAgo('tst-sess-c', 1)
      const { tick } = ticker(2)

      expect(await tick()).toEqual({ windows: 2, succeeded: 2, held: 0, transient: 0, full: true })
      expect(await succeededAnchors()).toEqual([c, a])
      expect(await tick()).toEqual({ windows: 1, succeeded: 1, held: 0, transient: 0, full: false })
      expect(await succeededAnchors()).toEqual([c, a, b])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'flushes the trailing turn once at session_end; after a resume the new utterance gets it as context only',
    async () => {
      const [p1, t1] = await seed([
        prompt('tst-sess-end', 'Check the importer.', 0),
        turn('tst-sess-end', 'The importer skips rows that have no id column.', 1),
      ])
      const { tick, requests } = ticker()

      // The session is live: the prompt is extracted, the trailing turn waits.
      expect(await tick()).toMatchObject({ windows: 1, succeeded: 1 })
      expect(await succeededAnchors()).toEqual([p1])
      expect(await observations()).toBe(0)

      await seed([sessionEnd('tst-sess-end', 2)])
      expect(await tick()).toMatchObject({ windows: 1, succeeded: 1 })
      expect(await succeededAnchors()).toEqual([p1, t1])
      expect(await observations()).toBe(1)
      expect(
        await pg.psql(
          `SELECT stats -> 'observation_sources' FROM public.memory_extraction_runs WHERE anchor_item_id = '${t1}';`,
        ),
      ).toBe(`["${t1}"]`)
      expect(await tick()).toMatchObject({ windows: 0 })

      // MK resumes: the new prompt's window shows the flushed turn as already
      // observed, so it yields no second observation.
      const [p2] = await seed([prompt('tst-sess-end', 'Thanks, carry on.', 30)])
      expect(await tick()).toMatchObject({ windows: 1, succeeded: 1 })
      expect(await succeededAnchors()).toEqual([p1, t1, p2])
      expect(requests.at(-1)!.user).toContain('(already observed)')
      expect(await observations()).toBe(1)
      expect(
        await pg.psql(
          `SELECT stats -> 'observation_sources' FROM public.memory_extraction_runs WHERE anchor_item_id = '${p2}';`,
        ),
      ).toBe('[]')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'extracts the observations of a session with assistant turns only once it is idle',
    async () => {
      const [t1] = await seed([turn('tst-sess-quiet', 'The importer skips rows that have no id column.', 0)])
      const { tick } = ticker()

      expect(await tick()).toMatchObject({ windows: 0 })
      expect(await observations()).toBe(0)

      await receivedAgo('tst-sess-quiet', 31)
      expect(await tick()).toMatchObject({ windows: 1, succeeded: 1 })
      expect(await succeededAnchors()).toEqual([t1])
      expect(await observations()).toBe(1)
      expect(await tick()).toMatchObject({ windows: 0 })
    },
    TEST_TIMEOUT_MS,
  )
})
