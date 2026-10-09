/**
 * Every session is extracted, however short, on real Postgres behind a real
 * PostgREST: one MK utterance is a window on the next tick, a prompt's window
 * shows every turn before it that no run has extracted, turns beyond the
 * window's character budget get an observation-only window that runs first,
 * the assistant turns after a session's last MK prompt are flushed together
 * once it ends or goes idle, a flushed turn is only context to a later window,
 * a tick with a smaller budget than the backlog serves the most recently
 * received sessions first, and after an extractor version bump a tick takes
 * only what no version extracted.
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
const TURN_HEADER = /^(turn-\d+) \(ASSISTANT, [^)]*\):( \(already observed\))?\n(.*)$/gm

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
 * Proposes one observation per turn the window shows that is new to
 * extraction: the turn's first line, from that turn's alias. Every new item
 * weighed against stored ones is independent of them.
 */
function scriptedModel() {
  const requests: CompleteJsonRequest[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      if (req.label === 'extraction-decisions') {
        const decisions = [...req.user.matchAll(/^NEW ITEM (\d+):/gm)].map((m) => ({
          item: Number(m[1]),
          relation: 'independent',
          targets: [],
          corrects: [],
        }))
        return { text: JSON.stringify({ decisions }), finishReason: 'stop', model: 'tst-model' }
      }
      requests.push(req)
      const observations = [...req.user.matchAll(TURN_HEADER)]
        .filter((m) => m[2] === undefined)
        .map((m) => ({
          assistant_utterance_id: m[1],
          claim: m[3],
          kind: 'fact',
          subject: { new: 'tst-repo importer' },
          evidence: [],
          valid_at: null,
          supersedes: [],
        }))
      return { text: JSON.stringify({ statements: [], observations }), finishReason: 'stop', model: 'tst-model' }
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

  const sourcesOf = (anchorId: string): Promise<string> =>
    pg.psql(
      `SELECT stats -> 'observation_sources' FROM public.memory_extraction_runs
        WHERE anchor_item_id = '${anchorId}' AND status = 'succeeded';`,
    )

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

  it(
    'shows a prompt every turn before it that no run extracted, and extracts nothing on the next tick',
    async () => {
      const [p1, t1, t2, p2] = await seed([
        prompt('tst-sess-many', 'Check the importer.', 0),
        turn('tst-sess-many', 'The importer reads rows in batches of 500.', 1),
        turn('tst-sess-many', 'The importer skips rows that have no id column.', 2),
        prompt('tst-sess-many', 'Good, go on.', 3),
      ])
      const { tick, requests } = ticker()

      expect(await tick()).toEqual({ windows: 2, succeeded: 2, held: 0, transient: 0, full: false })
      expect(await succeededAnchors()).toEqual([p1, p2])
      expect(requests[0]!.user).toContain('TURNS:\nnone')
      expect(requests[1]!.user).toContain('turn-1 (ASSISTANT, 2026-10-01T09:01:00.000Z):\nThe importer reads rows')
      expect(requests[1]!.user).toContain('turn-2 (ASSISTANT, 2026-10-01T09:02:00.000Z):\nThe importer skips rows')
      expect(await sourcesOf(p2!)).toBe(`["${t1}", "${t2}"]`)
      expect(await observations()).toBe(2)
      expect(
        await pg.psql(
          `SELECT string_agg(lineage[1]::text, ',' ORDER BY occurred_at) FROM public.memory_items WHERE class = 'observation';`,
        ),
      ).toBe(`${t1},${t2}`)

      expect(await tick()).toMatchObject({ windows: 0 })
      expect(requests).toHaveLength(2)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'splits turns over the budget into an observation-only window that runs before the prompt',
    async () => {
      const filler = `\n${'x'.repeat(15_000)}`
      const [t1, t2, p1] = await seed([
        turn('tst-sess-big', `The importer reads rows in batches of 500.${filler}`, 0),
        turn('tst-sess-big', `The importer skips rows that have no id column.${filler}`, 1),
        prompt('tst-sess-big', 'Summarize.', 2),
      ])
      const { tick, requests } = ticker()

      expect(await tick()).toEqual({ windows: 2, succeeded: 2, held: 0, transient: 0, full: false })
      expect(await succeededAnchors()).toEqual([t1, p1])
      expect(requests[0]!.user).toContain('turn-1 (ASSISTANT, 2026-10-01T09:00:00.000Z):\nThe importer reads rows')
      expect(requests[0]!.user).not.toContain('The importer skips rows')
      expect(requests[0]!.user).toContain('utt-1:\nnone')
      expect(requests[1]!.user).toContain('turn-1 (ASSISTANT, 2026-10-01T09:01:00.000Z):\nThe importer skips rows')
      expect(requests[1]!.user).not.toContain('(ASSISTANT, 2026-10-01T09:00:00.000Z)')
      expect(requests[1]!.user).not.toContain('turn-2 (ASSISTANT')
      expect(await sourcesOf(t1!)).toBe(`["${t1}"]`)
      expect(await sourcesOf(p1!)).toBe(`["${t2}"]`)
      expect(await observations()).toBe(2)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'after a version bump, extracts a new window and leaves one an earlier version extracted alone',
    async () => {
      const [p1, t1, t2, p2] = await seed([
        prompt('tst-sess-bump', 'Check the importer.', 0),
        turn('tst-sess-bump', 'The importer reads rows in batches of 500.', 1),
        turn('tst-sess-bump', 'The importer skips rows that have no id column.', 2),
        prompt('tst-sess-bump', 'Now look at the exporter.', 3),
      ])
      // An earlier extractor version ran the prompt and observed the first turn.
      for (const [anchor, sources] of [[p1!, []], [t1!, [t1!]]] as const) {
        const run = await store.extractionBegin({ anchorId: anchor, sessionId: 'tst-sess-bump', version: 'tst-extractor-old', model: null })
        expect(run).not.toBeNull()
        await store.extractionCommit(run!, { subjects: [], items: [], stats: { observation_sources: [...sources] } })
      }
      const { tick, requests } = ticker()

      expect(await tick()).toEqual({ windows: 1, succeeded: 1, held: 0, transient: 0, full: false })
      expect(requests).toHaveLength(1)
      expect(requests[0]!.user).toContain('Now look at the exporter.')
      expect(requests[0]!.user).toContain('The importer skips rows')
      expect(requests[0]!.user).not.toContain('The importer reads rows')
      expect(await sourcesOf(p2!)).toBe(`["${t2}"]`)
      expect(
        await pg.psql(
          `SELECT string_agg(anchor_item_id::text, ',') FROM public.memory_extraction_runs
            WHERE status = 'succeeded' AND extractor_version <> 'tst-extractor-old';`,
        ),
      ).toBe(p2)
      expect(await observations()).toBe(1)
      expect(await tick()).toMatchObject({ windows: 0 })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'flushes three trailing turns as one run with three observation sources',
    async () => {
      const [p1, t1, t2, t3] = await seed([
        prompt('tst-sess-three', 'Check the importer.', 0),
        turn('tst-sess-three', 'The importer reads rows in batches of 500.', 1),
        turn('tst-sess-three', 'The importer skips rows that have no id column.', 2),
        turn('tst-sess-three', 'The importer logs every skipped row.', 3),
        sessionEnd('tst-sess-three', 4),
      ])
      const { tick } = ticker()

      expect(await tick()).toEqual({ windows: 2, succeeded: 2, held: 0, transient: 0, full: false })
      expect(await succeededAnchors()).toEqual([p1, t1])
      expect(await sourcesOf(t1!)).toBe(`["${t1}", "${t2}", "${t3}"]`)
      expect(await observations()).toBe(3)
      expect(await tick()).toMatchObject({ windows: 0 })
    },
    TEST_TIMEOUT_MS,
  )
})
