/**
 * Extraction end to end on real Postgres behind a real PostgREST: capture
 * events go through ingest and materialize, one extraction tick runs with a
 * model adapter that answers from recorded replies, and the stored rows are
 * read back.
 * - Each window the RPC builds renders byte-for-byte as the recorded window
 *   does, so the recorded reply answers exactly that window.
 * - A two-character dialog answer is stored as MK's statement with the
 *   question verbatim, and the lineage trigger accepts it as MK's words.
 * - An evidenced finding is stored with its sha entity.
 * - The new items wait for an embedding; the assistant turn never does.
 * - A second tick finds nothing due and makes no model call.
 */
import { readFileSync } from 'node:fs'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildWindow,
  renderUserMessage,
  runExtractionTick,
  type CompleteJsonRequest,
  type IntelligenceAdapter,
  type RawExtractionWindow,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }
const NOW = new Date('2026-10-01T09:10:00Z')

interface RecordedScenario {
  window: RawExtractionWindow
  reply: string
}

function recorded(name: string): RecordedScenario {
  const url = new URL(`../../../core/test/extraction/replies/${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as RecordedScenario
}

const DIALOG = recorded('04-dialog-two-char-answer')
const FINDING = recorded('07-evidenced-observation')

/** The finding's window with the commit the reply cites dropped from the turn's tool refs. */
function withoutCommitTool(scenario: RecordedScenario): RecordedScenario {
  const window = structuredClone(scenario.window)
  for (const turn of window.turns ?? []) {
    const tools = turn.source?.tools
    if (tools) turn.source!.tools = tools.filter((t) => t.name !== 'Bash')
  }
  return { window, reply: scenario.reply }
}

const UNBACKED_FINDING = withoutCommitTool(FINDING)

let uuidCounter = 0
function event(sessionId: string, type: string, payload: Record<string, unknown>, occurredAt: string): StoredEvent {
  uuidCounter += 1
  return {
    sessionId,
    eventUuid: `evt-e2e-${uuidCounter}`,
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

/**
 * The capture events behind a recorded window: an assistant turn, then MK's
 * utterance. A dialog answer's window carries no turn, so its turn is given.
 */
function eventsOf(
  sessionId: string,
  scenario: RecordedScenario,
  answered?: { text: string; occurredAt: string },
): StoredEvent[] {
  const { anchor, anchor_event: anchorEvent } = scenario.window
  const turn = scenario.window.turns?.[0]
  const { text, tools, occurredAt } = turn
    ? { text: turn.content, tools: turn.source?.tools ?? [], occurredAt: turn.occurred_at }
    : { text: answered!.text, tools: [], occurredAt: answered!.occurredAt }
  const turnEvent = event(sessionId, 'assistant_turn', { text, transcript_line: 2, tools }, occurredAt)
  return [turnEvent, event(sessionId, anchor.kind, anchorEvent!.payload as Record<string, unknown>, anchor.occurred_at)]
}

/** Answers the recorded window with its recorded reply, and any other window with an error. */
function recordedModel(scenario: RecordedScenario) {
  const message = renderUserMessage(buildWindow(scenario.window))
  const requests: CompleteJsonRequest[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      requests.push(req)
      if (req.user !== message) throw new Error('no recorded reply for this window')
      return { text: scenario.reply, finishReason: 'stop', model: 'tst-model' }
    },
  }
  return { intelligence, requests, message }
}

describe.skipIf(!realPgImage || !postgrestImage)('extraction end to end on real Postgres', () => {
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

  // A window lists the subjects and items already stored in its scope, so
  // each recorded window is reproduced only on tables holding nothing else.
  beforeEach(async () => {
    await pg.psql(
      'TRUNCATE public.memory_items, public.memory_capture_events, public.memory_secret_hits, ' +
        'public.memory_extraction_runs, public.memory_subjects CASCADE;',
    )
  })

  async function json<T>(sql: string): Promise<T> {
    return JSON.parse(await pg.psql(sql)) as T
  }

  /** Ingests and materializes a recorded window's events; returns [turn id, utterance id]. */
  async function seed(
    sessionId: string,
    scenario: RecordedScenario,
    answered?: { text: string; occurredAt: string },
  ): Promise<[string, string]> {
    const events = eventsOf(sessionId, scenario, answered)
    const ingested = await store.ingestEvents(events)
    expect(ingested.map((e) => e.status)).toEqual(events.map(() => 'accepted'))
    expect(await store.materialize(1000)).toMatchObject({ locked: true, failed: 0 })
    const [turnId, utteranceId] = await Promise.all(
      ingested.map((e) => pg.psql(`SELECT id FROM public.memory_items WHERE source ->> 'event_id' = '${e.eventId}';`)),
    )
    return [turnId!, utteranceId!]
  }

  function ticker(scenario: RecordedScenario) {
    const model = recordedModel(scenario)
    const logs: string[] = []
    const tick = () =>
      runExtractionTick({
        store,
        intelligence: model.intelligence,
        model: 'tst-chat-model',
        now: () => NOW,
        log: (line) => logs.push(line),
      })
    return { tick, requests: model.requests, message: model.message, logs }
  }

  it(
    'stores a two-character dialog answer as MK\'s statement, and a second tick calls no model',
    async () => {
      const [turnId, answerId] = await seed('tst-session-dialog', DIALOG, {
        text: 'The cutover to the new spool is done; the old spool directory holds no pending files.',
        occurredAt: '2026-10-01T09:00:00Z',
      })
      const { tick, requests, message, logs } = ticker(DIALOG)

      expect(await tick()).toEqual({ windows: 1, succeeded: 1, held: 0, transient: 0, full: false })
      expect(requests.map((r) => r.user)).toEqual([message])

      const statement = await json<Record<string, unknown>>(
        `SELECT row_to_json(s) FROM (
           SELECT id, kind, speaker, trust, content, context, search_text, lineage, standing, register_status,
                  source ->> 'utterance_id' AS utterance_id
             FROM public.memory_items WHERE class = 'mk_statement') s;`,
      )
      const question = 'Drop the old spool after the cutover?'
      expect(statement).toMatchObject({
        kind: 'ruling',
        speaker: 'mk',
        trust: 0,
        content: 'ok',
        context: question,
        search_text: `${question} — ok`,
        lineage: [answerId],
        standing: false,
        register_status: null,
        utterance_id: answerId,
      })
      // The deferred lineage trigger ran at the commit and found the quote in
      // MK's answer under the quote rule.
      expect(
        await pg.psql(
          `SELECT tgenabled FROM pg_catalog.pg_trigger
            WHERE tgrelid = 'public.memory_items'::regclass AND tgname = 'memory_items_lineage';`,
        ),
      ).toBe('O')
      expect(
        await pg.psql(
          `SELECT strpos(public.engram_norm_quote(u.content), public.engram_norm_quote(s.content)) > 0
             FROM public.memory_items s JOIN public.memory_items u ON u.id = s.lineage[1]
            WHERE s.class = 'mk_statement' AND u.speaker = 'mk';`,
        ),
      ).toBe('t')
      // MK's words and the question name no ticket, repo, path, sha, url or package.
      expect(await pg.psql('SELECT count(*) FROM public.memory_item_entities;')).toBe('0')
      expect(await pg.psql(`SELECT label FROM public.memory_subjects;`)).toBe('old spool')

      const waiting = (await store.pendingEmbeddings(32)).map((row) => row.id)
      expect(waiting).toContain(statement['id'])
      expect(waiting).not.toContain(turnId)

      expect(await tick()).toEqual({ windows: 0, succeeded: 0, held: 0, transient: 0, full: false })
      expect(requests).toHaveLength(1)
      expect(await pg.psql(`SELECT string_agg(status, ',') FROM public.memory_extraction_runs;`)).toBe('succeeded')
      expect(logs.join('\n')).not.toContain('Drop the old spool')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'stores a finding backed by a commit the turn ran at trust 2 with its sha entity',
    async () => {
      const [turnId] = await seed('tst-session-finding', FINDING)
      const { tick, requests, message } = ticker(FINDING)

      expect(await tick()).toEqual({ windows: 1, succeeded: 1, held: 0, transient: 0, full: false })
      expect(requests.map((r) => r.user)).toEqual([message])

      const observation = await json<Record<string, unknown>>(
        `SELECT row_to_json(o) FROM (
           SELECT id, kind, speaker, trust, lineage, source -> 'evidence' AS evidence
             FROM public.memory_items WHERE class = 'observation') o;`,
      )
      expect(observation).toMatchObject({
        kind: 'finding',
        speaker: 'assistant',
        trust: 2,
        lineage: [turnId],
        evidence: [{ type: 'commit', ref: 'c0ffee5d1e9a' }],
      })
      const entities = await pg.psql(
        `SELECT string_agg(entity_type || ':' || entity, ',' ORDER BY entity COLLATE "C")
           FROM public.memory_item_entities WHERE item_id = '${observation['id'] as string}';`,
      )
      expect(entities.split(',')).toContain('sha:c0ffee5d1e9a')

      const waiting = (await store.pendingEmbeddings(32)).map((row) => row.id)
      expect(waiting).toContain(observation['id'])
      expect(waiting).not.toContain(turnId)

      expect(await tick()).toEqual({ windows: 0, succeeded: 0, held: 0, transient: 0, full: false })
      expect(requests).toHaveLength(1)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'stores a finding whose cited commit the turn never ran at trust 3 with its evidence kept',
    async () => {
      const [turnId] = await seed('tst-session-unbacked', UNBACKED_FINDING)
      const { tick, requests, message } = ticker(UNBACKED_FINDING)

      expect(await tick()).toEqual({ windows: 1, succeeded: 1, held: 0, transient: 0, full: false })
      expect(requests.map((r) => r.user)).toEqual([message])

      const observation = await json<Record<string, unknown>>(
        `SELECT row_to_json(o) FROM (
           SELECT kind, speaker, trust, lineage, source -> 'evidence' AS evidence
             FROM public.memory_items WHERE class = 'observation') o;`,
      )
      expect(observation).toEqual({
        kind: 'finding',
        speaker: 'assistant',
        trust: 3,
        lineage: [turnId],
        evidence: [{ type: 'commit', ref: 'c0ffee5d1e9a' }],
      })
      expect(await pg.psql(`SELECT count(*) FROM public.engram_invariant_counts() WHERE violations <> 0;`)).toBe('0')
    },
    TEST_TIMEOUT_MS,
  )
})
