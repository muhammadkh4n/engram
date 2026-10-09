/**
 * Accepted means materialized, on real Postgres behind PostgREST: a 500-event
 * batch of edge cases (U+0000, lone surrogates, a valid pair, characters that
 * look like space, whitespace-only optional strings, every free-text field at
 * its maximum, a dialog response at the 1,000,000-char cap on the user's words,
 * non-ASCII keys, the widest zone offsets) goes through the route with a real
 * PostgRestCaptureStore. Every event must be answered, every
 * accepted one stored and materialized, none dead, and a replay of the batch
 * reads duplicate throughout.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetDefaultSecretRegistry } from '@engram-mem/core'
import type { CaptureEventType, SecretRegistryStatus } from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { parseProjectRegistry, registryRows, type ProjectRegistry } from '../../src/capture-events/project-registry.js'
import { runCaptureEventsRequest, type CaptureEventsRouteDeps } from '../../src/capture-events/route.js'
import { CAPTURE_EVENTS_MAX, CAPTURE_FREE_TEXT_MAX_CHARS, USER_PROMPT_TEXT_MAX_CHARS } from '../../src/capture-events/contract.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../../postgrest/test/real-pg/harness.js'
import { RECEIVED_AT, envelope, validEvent, type FixtureEvent } from './fixtures.js'

const SETUP_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 300_000
const HEALTHY: SecretRegistryStatus = { configured: true, unreadable: [], values: 0 }
const R = '�'
const MAX = CAPTURE_FREE_TEXT_MAX_CHARS
const NO_ITEM: ReadonlySet<CaptureEventType> = new Set([
  'session_start', 'session_end', 'pre_compact', 'briefing_shown', 'candidate_status',
])

const REGISTRY: ProjectRegistry = parseProjectRegistry({
  version: 1,
  workspaces: { 'ws-test': { root: '~/work/ws-test', vault_folder: 'Sample Workspace', register_prefix: 'TSTW' } },
  projects: { 'sample-repo': { workspace: 'ws-test', vault_folder: 'Sample Repo', register_prefix: 'TST' } },
})

let n = 0
function edge(type: CaptureEventType, payload: Record<string, unknown>, patch: Record<string, unknown> = {}): FixtureEvent {
  n++
  const base = validEvent(type)
  const minute = String(n % 60).padStart(2, '0')
  return {
    ...base,
    session_id: 'sess-edge',
    event_uuid: `edge-${n}`,
    occurred_at: `2026-10-05T0${Math.floor(n / 60)}:${minute}:00Z`,
    payload: { ...base.payload, ...payload },
    ...patch,
  }
}

const long = (c: string, length: number): string => c.repeat(length)
const wide = (length: number): string => long('é', length)

function corpus(): FixtureEvent[] {
  n = 0
  const bigQuestion = `${long('q', MAX - 1)}?`
  const events: FixtureEvent[] = [
    edge('user_prompt', { text: 'the worker\u0000 runs' }),
    edge('user_prompt', { text: 'abc\ud83d' }),
    edge('user_prompt', { text: '\udc00 low surrogate' }),
    edge('user_prompt', { text: 'a valid pair 😀' }),
    edge('user_prompt', { text: '\u0085' }),
    edge('user_prompt', { text: '᠎' }),
    edge('user_prompt', { text: '​' }),
    edge('user_prompt', { text: `${long('p', 1_000_049)}x` }),
    edge('user_prompt', { text: 'from history', transcript_line: null }, { cwd: null }),
    edge('user_answer', {
      questions: [
        { question: 'Какой store выбрать? 日本語', header: ' ', options: [{ label: long('l', 2000), description: ' ' }], multiSelect: true },
        { question: 'Which\u0000 timer?', header: '', options: [], multiSelect: false },
        { question: bigQuestion, header: long('h', 200), options: [], multiSelect: false },
      ],
      answers: { 'Какой store выбрать? 日本語': 'Postgres', 'Which\u0000 timer?': '  ', [bigQuestion]: long('a', 300_000) },
      notes: { 'Which\u0000 timer?': '\t' },
      response: long('r', USER_PROMPT_TEXT_MAX_CHARS),
      truncated: true,
    }),
    edge('assistant_turn', {
      text: long('t', MAX),
      tools: Array.from({ length: 200 }, (_v, i) => ({ name: long('n', 128), ref: i === 0 ? 'src/\u0000x.ts' : long('r', 4096) })),
    }),
    edge('session_start', { reason: long('s', 256) }),
    edge('session_end', { reason: '   ' }),
    edge('pre_compact', {}),
    edge('git_commit', {
      repo: long('g', 100),
      sha: long('ab', 32),
      message: long('m', MAX),
      files: [long('f', 4096), ...Array.from({ length: 4999 }, (_v, i) => `src/file-${i}.ts`)],
      authored_at: '2026-10-05T13:29:00+15:59',
    }),
    edge('ledger_decision', {
      plan: long('p', 128),
      id: `${long('i', 60)} é\u0000`,
      trigger: ' \n ',
      ruling: long('d', MAX),
      by: 'mk',
      quote: long('q', MAX),
      source: long('s', 1024),
      said_as: 'choice',
      question: `${long('k', 2000)} 日本語\u0000?`,
    }),
    edge('ledger_ruling', { phase: long('9', 32), task: long('9', 32), ruling: 'Batches of 32 rows.', why: '  ' }),
    edge('briefing_shown', {
      item_ids: Array.from({ length: 100 }, (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
      prompt_event_uuid: null,
    }),
    edge('register_entry', {
      id: `R-TST-${long('7', 58)}`,
      subject: wide(200),
      question: '  ',
      said_as: 'choice',
      verified: long('v', 1024),
      applies_to: Array.from({ length: 50 }, () => long('a', 200)),
      triggers: Array.from({ length: 20 }, () => long('t', 64)),
      supersedes: Array.from({ length: 20 }, (_v, i) => `R-TST-${String(i + 1).padStart(58, '1')}`),
      restated: Array.from({ length: 100 }, () => long('r', 200)),
      file: long('f', 4096),
    }),
    edge('register_entry', { id: 'R-TST-2', status: 'superseded' }),
    edge(
      'session_start',
      {},
      {
        session_id: wide(256),
        event_uuid: long('u', 128),
        cwd: long('c', 4096),
        project: { id: 'sample-repo', workspace: null, repo_root: long('r', 4096), branch: long('b', 256), worktree: long('w', 256) },
        plan_dirs: Array.from({ length: 20 }, () => long('d', 4096)),
      },
    ),
    edge('session_start', {}, { occurred_at: '2026-10-05T15:30:00.123456789+15:59' }),
    edge('session_start', {}, { occurred_at: '2026-10-04T19:00:00-15:59' }),
  ]
  const history = events[8]!
  history.payload.origin = { type: 'history', timestamp_ms: Date.parse(history.occurred_at as string), line: 5, paste_missing: false }
  for (const e of events) {
    for (const [k, v] of Object.entries(e.payload)) if (v === undefined) delete e.payload[k]
  }
  for (let i = events.length; i < CAPTURE_EVENTS_MAX; i++) {
    events.push({
      ...validEvent('user_prompt'),
      session_id: 'sess-pad',
      event_uuid: `pad-${i}`,
      occurred_at: new Date(Date.parse('2026-10-05T08:00:00Z') + i * 1000).toISOString(),
      payload: { text: `padding prompt ${i}`, transcript_line: i + 1 },
    })
  }
  return events
}

describe.skipIf(!realPgImage || !postgrestImage)('every accepted capture event is stored and materialized', () => {
  let pg: RealPg
  let store: PostgRestCaptureStore
  const logs: string[] = []

  beforeAll(async () => {
    vi.stubEnv('ENGRAM_SECRET_SOURCES_FILE', '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetDefaultSecretRegistry()
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    const endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
    await store.syncProjects(registryRows(REGISTRY))
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    resetDefaultSecretRegistry()
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  const count = (sql: string): Promise<number> => pg.psql(sql).then(Number)

  it(
    'answers all 500, stores and materializes every accepted event with none dead, and reads a replay as duplicates',
    async () => {
      const deps: CaptureEventsRouteDeps = {
        store,
        ready: () => REGISTRY,
        status: () => HEALTHY,
        log: (line) => logs.push(line),
        now: () => RECEIVED_AT,
      }
      const events = corpus()
      const res = await runCaptureEventsRequest(deps, envelope(events))
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ accepted: CAPTURE_EVENTS_MAX, duplicates: 0, rejected: [] })

      let dead = -1
      let failed = 0
      for (let i = 0; i < 5; i++) {
        const result = await store.materialize(1000)
        if (!result.locked) throw new Error('materialize did not take its lock')
        failed += result.failed
        dead = result.dead
        if (result.pending === 0) break
      }
      expect({ failed, dead }).toEqual({ failed: 0, dead: 0 })
      expect(await count(`SELECT count(*) FROM public.memory_capture_events`)).toBe(CAPTURE_EVENTS_MAX)
      const errors = await pg.psql(
        `SELECT event_uuid || ': ' || coalesce(error, 'unprocessed') FROM public.memory_capture_events
          WHERE processed_at IS NULL OR error IS NOT NULL ORDER BY id;`,
      )
      expect(errors).toBe('')

      const itemTypes = events.filter((e) => !NO_ITEM.has(e.type as CaptureEventType)).length
      expect(await count(`SELECT count(*) FROM public.memory_items`)).toBe(itemTypes)
      expect(
        await count(
          `SELECT count(*) FROM public.memory_capture_events e
            WHERE e.type NOT IN ('session_start', 'session_end', 'pre_compact', 'briefing_shown', 'candidate_status')
              AND NOT EXISTS (SELECT 1 FROM public.memory_items i WHERE i.source ->> 'event_id' = e.id::text);`,
        ),
      ).toBe(0)
      expect(await count(`SELECT count(*) FROM public.engram_invariant_counts() WHERE violations <> 0`)).toBe(0)

      const content = (uuid: string): Promise<string> =>
        pg.psql(
          `SELECT i.content FROM public.memory_items i JOIN public.memory_capture_events e ON i.source ->> 'event_id' = e.id::text
            WHERE e.event_uuid = '${uuid}';`,
        )
      expect(await content('edge-1')).toBe(`the worker${R} runs`)
      expect(await content('edge-2')).toBe(`abc${R}`)
      expect(await content('edge-3')).toBe(`${R} low surrogate`)
      expect(await content('edge-4')).toBe('a valid pair 😀')
      expect((await content('edge-8')).length).toBe(1_000_000)
      const answer = await pg.psql(
        `SELECT length(i.content) || ' ' || (i.source -> 'truncated')::text FROM public.memory_items i
           JOIN public.memory_capture_events e ON i.source ->> 'event_id' = e.id::text WHERE e.event_uuid = 'edge-10';`,
      )
      expect(answer).toBe(`${'Postgres'.length + 2 + 300_000 + 2 + USER_PROMPT_TEXT_MAX_CHARS} true`)
      expect(await count(`SELECT count(*) FROM public.memory_items WHERE retired_at IS NOT NULL`)).toBe(1)

      const replay = await runCaptureEventsRequest(deps, envelope(corpus()))
      expect(replay.body).toEqual({ accepted: 0, duplicates: CAPTURE_EVENTS_MAX, rejected: [] })
      expect(logs).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
