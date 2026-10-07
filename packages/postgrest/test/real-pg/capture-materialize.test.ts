/**
 * engram_capture_materialize through a real PostgREST in front of real
 * Postgres. Events go in through engram_capture_ingest, as the route stores
 * them; every test starts from an empty item store and event table.
 * - each event type gives exactly its item row, and the session markers and
 *   briefing events give none;
 * - a user answer renders its content, context and search text byte for byte;
 * - a history origin, a legacy origin and a missing legacy origin;
 * - live sessions run before backfill, each session in event-time order;
 * - a repeated call and a commit seen by two sessions create nothing new;
 * - ledger decisions and register entries form version chains: later
 *   supersedes earlier whatever the delivery order, equal times fail, a
 *   non-active entry is retired, an entry's supersedes list retires others;
 * - candidate_status updates a standing statement and fails on an unknown id;
 * - a failing event holds its session back until it is dead;
 * - a second caller gets {"locked": false} while the lock is held.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MaterializeResult, StoredEvent } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type PostgrestEndpoint, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const T0 = Date.parse('2026-10-01T09:00:00Z')
const SUBJECT_ID = '00000000-0000-4000-8000-0000000000c1'
const SHA = 'c0ffee'.padEnd(40, '0')
const MATERIALIZE_LOCK = `hashtextextended('engram.capture.materialize', 0)`
const DOT = ' · '

const REGISTERED = { id: 'sample-repo', workspace: 'ws-test', repo_root: '/home/tester/sample-repo', branch: 'main', worktree: null }
const UNREGISTERED = { id: null, workspace: null, repo_root: '/home/tester/other-repo', branch: 'main', worktree: null }

function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString()
}

let uuidCounter = 0
function event(sessionId: string, type: string, payload: Record<string, unknown>, overrides: Partial<StoredEvent> = {}): StoredEvent {
  uuidCounter += 1
  return {
    sessionId,
    eventUuid: `evt-${uuidCounter}`,
    type,
    occurredAt: at(0),
    cwd: '/home/tester/sample-repo',
    project: { ...UNREGISTERED },
    planDirs: [],
    client: { name: 'engram-test', version: '1.0.0' },
    payload,
    scrub: { masked: [] },
    hits: [],
    ...overrides,
  }
}

function prompt(sessionId: string, text: string, minutes: number, overrides: Partial<StoredEvent> = {}): StoredEvent {
  return event(sessionId, 'user_prompt', { text, transcript_line: 1 }, { occurredAt: at(minutes), ...overrides })
}

function decision(ruling: string, minutes: number, id = 'flag-rollout'): StoredEvent {
  return event(
    'sess-ledger',
    'ledger_decision',
    { plan: 'sample-plan', id, class: 'B', trigger: 'a new importer', ruling, by: 'session' },
    { occurredAt: at(minutes) },
  )
}

function registerEntry(id: string, status: string, minutes: number, supersedes: string[] = []): StoredEvent {
  return event(
    'sess-register',
    'register_entry',
    {
      id,
      status,
      subject: 'importer flags',
      said_at: at(minutes),
      quote: 'every importer ships behind a flag',
      question: null,
      verified: 'transcript line 12',
      applies_to: [],
      triggers: [],
      supersedes,
      restated: [],
      scope: 'global',
      file: '/notes/Sample/Rulings.md',
    },
    { occurredAt: at(minutes) },
  )
}

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

/** A JSON literal carried as UTF-8 hex, so any character reaches Postgres byte for byte. */
function jsonb(value: unknown): string {
  return `convert_from(decode('${hex(JSON.stringify(value))}', 'hex'), 'UTF8')::jsonb`
}

interface ItemRow {
  id: string
  class: string
  kind: string
  speaker: string
  trust: number
  project_id: string | null
  workspace_id: string | null
  plan_slug: string | null
  session_id: string | null
  content: string
  context: string | null
  search_text: string
  occurred_at: string
  source: Record<string, unknown>
  lineage: string[]
  superseded_by: string | null
  restated_at: string[]
  retired_reason: string | null
}

describe.skipIf(!realPgImage || !postgrestImage)('engram_capture_materialize through PostgREST on real Postgres', () => {
  let pg: RealPg
  let endpoint: PostgrestEndpoint
  let store: PostgRestCaptureStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
    await store.syncProjects([
      { id: 'ws-test', kind: 'workspace', workspaceId: null, vaultFolder: null, registerPrefix: null },
      { id: 'sample-repo', kind: 'project', workspaceId: 'ws-test', vaultFolder: null, registerPrefix: 'TST' },
    ])
    await pg.psql(`INSERT INTO public.memory_subjects (id, label) VALUES ('${SUBJECT_ID}', 'importer flags');`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  beforeEach(async () => {
    await pg.psql('TRUNCATE public.memory_items, public.memory_capture_events, public.memory_secret_hits CASCADE;')
  })

  async function ingest(events: StoredEvent[]): Promise<string[]> {
    const result = await store.ingestEvents(events)
    expect(result.map((r) => r.status)).toEqual(events.map(() => 'accepted'))
    return result.map((r) => r.eventId)
  }

  const count = (sql: string): Promise<number> => pg.psql(sql).then(Number)

  async function items(where: string): Promise<ItemRow[]> {
    const out = await pg.psql(
      `SELECT coalesce(json_agg(json_build_object(
                'id', i.id, 'class', i.class, 'kind', i.kind, 'speaker', i.speaker, 'trust', i.trust,
                'project_id', i.project_id, 'workspace_id', i.workspace_id, 'plan_slug', i.plan_slug,
                'session_id', i.session_id, 'content', i.content, 'context', i.context, 'search_text', i.search_text,
                'occurred_at', to_char(i.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'source', i.source, 'lineage', i.lineage, 'superseded_by', i.superseded_by,
                'restated_at', ARRAY(SELECT to_char(r AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM unnest(i.restated_at) AS r),
                'retired_reason', i.retired_reason) ORDER BY i.occurred_at, i.id), '[]'::json)
         FROM public.memory_items i WHERE ${where};`,
    )
    return JSON.parse(out) as ItemRow[]
  }

  async function itemOf(eventId: string): Promise<ItemRow> {
    const rows = await items(`i.source ->> 'event_id' = '${eventId}'`)
    expect(rows).toHaveLength(1)
    return rows[0]!
  }

  /** `processed|attempts|error` of one event. */
  async function state(eventId: string): Promise<string> {
    return pg.psql(
      `SELECT (processed_at IS NOT NULL) || '|' || attempts || '|' || coalesce(error, '')
         FROM public.memory_capture_events WHERE id = ${eventId};`,
    )
  }

  async function sourceBase(eventId: string): Promise<Record<string, unknown>> {
    const row = await pg.psql(
      `SELECT json_build_object('event_id', id::text, 'session_id', session_id, 'event_uuid', event_uuid)
         FROM public.memory_capture_events WHERE id = ${eventId};`,
    )
    return { ...(JSON.parse(row) as Record<string, unknown>), event_key: `capture:${eventId}` }
  }

  async function versionKey(eventId: string, versionOf: string): Promise<string> {
    const digest = await pg.psql(
      `SELECT encode(sha256(convert_to(payload::text, 'UTF8')), 'hex') FROM public.memory_capture_events WHERE id = ${eventId};`,
    )
    return `${versionOf}:${digest}`
  }

  const counts = (processed: number, failed: number, skipped: number, pending: number, dead: number): MaterializeResult => ({
    locked: true,
    processed,
    failed,
    skipped,
    pending,
    dead,
  })

  async function insertItems(objects: unknown[]): Promise<string[]> {
    const out = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(json_agg(r.id ORDER BY r.ord), '[]'::json) FROM public.engram_insert_items(${jsonb(objects)}) AS r;`,
    )
    return JSON.parse(out) as string[]
  }

  it(
    'gives each event type exactly its item row, and none for markers and briefings',
    async () => {
      const answer = {
        questions: [{ question: 'Which port?', header: 'Port', options: [{ label: '8080', description: 'default' }], multiSelect: false }],
        answers: { 'Which port?': '8080' },
        transcript_line: 13,
      }
      const ids = await ingest([
        event('sess-types', 'user_prompt', { text: 'Ship the importer behind a flag.', transcript_line: 12, truncated: true }, {
          occurredAt: at(0),
          project: { ...REGISTERED },
        }),
        event('sess-types', 'user_answer', answer, { occurredAt: at(1), project: { ...REGISTERED } }),
        event(
          'sess-types',
          'assistant_turn',
          { text: 'Flag added; tests pass.', transcript_line: 14, tools: [{ name: 'Bash', ref: 'npm test' }, { name: 'Read', ref: null }] },
          { occurredAt: at(2) },
        ),
        event(
          'sess-types',
          'git_commit',
          { repo: 'sample-repo', sha: SHA, message: 'feat: importer flag', files: ['src/a.ts', 'src/b.ts'], authored_at: at(3) },
          { occurredAt: at(3), project: { ...REGISTERED } },
        ),
        event(
          'sess-types',
          'ledger_decision',
          {
            plan: 'sample-plan',
            id: 'flag-rollout',
            class: 'A',
            trigger: 'a new importer',
            ruling: 'Importers ship behind a flag.',
            by: 'mk',
            quote: 'ship it behind a flag',
            source: 'session of 2026-10-01',
          },
          { occurredAt: at(4) },
        ),
        event(
          'sess-types',
          'ledger_ruling',
          { plan: 'sample-plan', phase: 'build', task: 'flags', ruling: 'The flag is named importer_next.', why: 'Matches the config key.' },
          { occurredAt: at(5) },
        ),
        event(
          'sess-types',
          'register_entry',
          {
            id: 'R-TST-1',
            status: 'active',
            subject: 'importer flags',
            said_at: at(6),
            quote: 'every importer ships behind a flag',
            question: 'Should importers ship dark?',
            verified: 'transcript line 12',
            applies_to: ['importers', 'flags'],
            triggers: ['new importer'],
            supersedes: [],
            restated: [],
            scope: 'project:sample-repo',
            file: '/notes/Sample/Rulings.md',
          },
          { occurredAt: at(6), project: { ...REGISTERED } },
        ),
        event('sess-types', 'briefing_shown', { item_ids: [], channel: 'prompt', prompt_event_uuid: null }, { occurredAt: at(7) }),
        event('sess-types', 'session_start', { reason: 'startup' }, { occurredAt: at(8) }),
        event('sess-types', 'session_end', {}, { occurredAt: at(9) }),
        event('sess-types', 'pre_compact', { reason: 'auto' }, { occurredAt: at(10) }),
      ])

      await expect(store.materialize(200)).resolves.toEqual(counts(11, 0, 0, 0, 0))

      const scoped = { project_id: 'sample-repo', workspace_id: 'ws-test' }
      const unscoped = { project_id: null, workspace_id: null }
      const common = { session_id: 'sess-types', lineage: [], superseded_by: null, restated_at: [], retired_reason: null }
      const [promptId, answerId, turnId, commitId, decisionId, rulingId, entryId] = ids as [string, string, string, string, string, string, string]

      expect(await itemOf(promptId)).toEqual({
        ...common,
        ...scoped,
        id: expect.any(String),
        class: 'utterance',
        kind: 'user_prompt',
        speaker: 'mk',
        trust: 0,
        plan_slug: null,
        content: 'Ship the importer behind a flag.',
        context: null,
        search_text: 'Ship the importer behind a flag.',
        occurred_at: at(0),
        source: { ...(await sourceBase(promptId)), type: 'transcript', line: 12, truncated: true },
      })
      expect(await itemOf(answerId)).toEqual({
        ...common,
        ...scoped,
        id: expect.any(String),
        class: 'utterance',
        kind: 'user_answer',
        speaker: 'mk',
        trust: 0,
        plan_slug: null,
        content: '8080',
        context: '[Port] Which port?\n- 8080: default',
        search_text: 'Q: Which port?\nA: 8080',
        occurred_at: at(1),
        source: { ...(await sourceBase(answerId)), type: 'transcript', line: 13 },
      })
      expect(await itemOf(turnId)).toEqual({
        ...common,
        ...unscoped,
        id: expect.any(String),
        class: 'utterance',
        kind: 'assistant_turn',
        speaker: 'assistant',
        trust: 3,
        plan_slug: null,
        content: 'Flag added; tests pass.',
        context: null,
        search_text: 'Flag added; tests pass.',
        occurred_at: at(2),
        source: {
          ...(await sourceBase(turnId)),
          type: 'transcript',
          line: 14,
          tools: [{ name: 'Bash', ref: 'npm test' }, { name: 'Read', ref: null }],
        },
      })
      expect(await itemOf(commitId)).toEqual({
        ...common,
        ...scoped,
        id: expect.any(String),
        class: 'artifact',
        kind: 'commit',
        speaker: 'artifact',
        trust: 1,
        plan_slug: null,
        content: 'feat: importer flag',
        context: null,
        search_text: `sample-repo ${SHA.slice(0, 12)}\nfeat: importer flag\nsrc/a.ts\nsrc/b.ts`,
        occurred_at: at(3),
        source: {
          ...(await sourceBase(commitId)),
          event_key: `git:sample-repo:${SHA}`,
          type: 'git',
          repo: 'sample-repo',
          sha: SHA,
          files: ['src/a.ts', 'src/b.ts'],
        },
      })
      expect(await itemOf(decisionId)).toEqual({
        ...common,
        ...unscoped,
        id: expect.any(String),
        class: 'artifact',
        kind: 'ledger_decision',
        speaker: 'artifact',
        trust: 1,
        plan_slug: 'sample-plan',
        content: 'Importers ship behind a flag.',
        context: 'a new importer',
        search_text: 'sample-plan flag-rollout (class A): a new importer\nImporters ship behind a flag.\nMK: "ship it behind a flag"',
        occurred_at: at(4),
        source: {
          ...(await sourceBase(decisionId)),
          event_key: await versionKey(decisionId, 'ledger-decision:sample-plan:flag-rollout'),
          type: 'ledger',
          plan: 'sample-plan',
          decision_id: 'flag-rollout',
          class: 'A',
          by: 'mk',
          quote: 'ship it behind a flag',
          quote_source: 'session of 2026-10-01',
          version_of: 'ledger-decision:sample-plan:flag-rollout',
        },
      })
      expect(await itemOf(rulingId)).toEqual({
        ...common,
        ...unscoped,
        id: expect.any(String),
        class: 'artifact',
        kind: 'ledger_ruling',
        speaker: 'artifact',
        trust: 1,
        plan_slug: 'sample-plan',
        content: 'The flag is named importer_next.',
        context: null,
        search_text: 'sample-plan build/flags: The flag is named importer_next.\nWhy: Matches the config key.',
        occurred_at: at(5),
        source: {
          ...(await sourceBase(rulingId)),
          type: 'ledger',
          plan: 'sample-plan',
          phase: 'build',
          task: 'flags',
          why: 'Matches the config key.',
        },
      })
      const entryContent =
        `R-TST-1${DOT}active${DOT}importer flags${DOT}MK, ${at(6)}: "every importer ships behind a flag"` +
        `${DOT}answering: "Should importers ship dark?"`
      expect(await itemOf(entryId)).toEqual({
        ...common,
        ...scoped,
        id: expect.any(String),
        class: 'artifact',
        kind: 'ruling_entry',
        speaker: 'artifact',
        trust: 1,
        plan_slug: null,
        content: entryContent,
        context: 'Should importers ship dark?',
        search_text: `${entryContent}\nimporters, flags\nnew importer`,
        occurred_at: at(6),
        source: {
          ...(await sourceBase(entryId)),
          event_key: await versionKey(entryId, 'register:R-TST-1'),
          type: 'register',
          id: 'R-TST-1',
          status: 'active',
          subject: 'importer flags',
          scope: 'project:sample-repo',
          file: '/notes/Sample/Rulings.md',
          said_at: at(6),
          verified: 'transcript line 12',
          applies_to: ['importers', 'flags'],
          triggers: ['new importer'],
          supersedes: [],
          restated: [],
          version_of: 'register:R-TST-1',
        },
      })

      for (const id of ids.slice(7)) {
        expect(await state(id)).toBe('true|0|')
        expect(await count(`SELECT count(*) FROM public.memory_items WHERE source ->> 'event_id' = '${id}';`)).toBe(0)
      }
      expect(await count(`SELECT count(*) FROM public.memory_items;`)).toBe(7)
      expect(
        await pg.psql(
          `SELECT string_agg(name || '=' || violations, ',' ORDER BY name) FROM public.engram_invariant_counts()
            WHERE name IN ('utterance_time_mismatch', 'unregistered_project');`,
        ),
      ).toBe('unregistered_project=0,utterance_time_mismatch=0')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'renders a user answer as MK words, the question asked and a search text, byte for byte',
    async () => {
      const [twoQuestions, replyOnly] = (await ingest([
        event(
          'sess-answers',
          'user_answer',
          {
            questions: [
              {
                question: 'Which port?',
                header: 'Port',
                options: [
                  { label: '8080', description: 'default' },
                  { label: '9090', description: '' },
                ],
                multiSelect: false,
              },
              {
                question: 'Which colours?',
                header: '',
                options: [
                  { label: 'red', description: 'warm' },
                  { label: 'blue', description: 'cool' },
                ],
                multiSelect: true,
              },
            ],
            answers: { 'Which port?': '8080', 'Which colours?': 'red, blue' },
            notes: { 'Which colours?': 'blue only on weekends' },
            transcript_line: 20,
          },
          { occurredAt: at(1) },
        ),
        event(
          'sess-answers',
          'user_answer',
          {
            questions: [{ question: 'Which port?', header: 'Port', options: [{ label: '8080', description: 'default' }], multiSelect: false }],
            answers: {},
            response: 'Neither, use 7070.',
            transcript_line: 21,
          },
          { occurredAt: at(2) },
        ),
      ])) as [string, string]

      await expect(store.materialize(200)).resolves.toEqual(counts(2, 0, 0, 0, 0))

      const first = await itemOf(twoQuestions)
      expect(first.content).toBe('8080\n\nred, blue\nblue only on weekends')
      expect(first.context).toBe('[Port] Which port?\n- 8080: default\n- 9090\n\nWhich colours?\n- red: warm\n- blue: cool\n(multi-select)')
      expect(first.search_text).toBe('Q: Which port?\nA: 8080\n\nQ: Which colours?\nA: red, blue\nNote: blue only on weekends')

      const second = await itemOf(replyOnly)
      expect(second.content).toBe('Neither, use 7070.')
      expect(second.context).toBe('[Port] Which port?\n- 8080: default')
      expect(second.search_text).toBe('Q: Which port?\n\nResponse: Neither, use 7070.')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'keeps the answer to a question named __proto__',
    async () => {
      const [eventId] = (await ingest([
        event(
          'sess-proto',
          'user_answer',
          {
            questions: [{ question: '__proto__', header: '', options: [{ label: 'keep it', description: '' }], multiSelect: false }],
            answers: JSON.parse('{"__proto__": "keep it"}') as Record<string, string>,
            notes: JSON.parse('{"__proto__": "and say why"}') as Record<string, string>,
            transcript_line: 30,
          },
          { occurredAt: at(1) },
        ),
      ])) as [string]

      await expect(store.materialize(200)).resolves.toEqual(counts(1, 0, 0, 0, 0))
      const row = await itemOf(eventId)
      expect(row.content).toBe('keep it\nand say why')
      expect(row.search_text).toBe('Q: __proto__\nA: keep it\nNote: and say why')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'records history and legacy origins, and skips a prompt whose legacy item is missing',
    async () => {
      const [legacyId] = (await insertItems([
        {
          class: 'legacy',
          kind: 'legacy_episode',
          speaker: 'mk',
          trust: 3,
          content: 'Recovered prompt, as the old store kept it.',
          search_text: 'Recovered prompt, as the old store kept it.',
          occurred_at: at(-60),
          source: { type: 'legacy', event_key: 'legacy:episode-tst-1' },
        },
      ])) as [string]
      const history = { type: 'history', timestamp_ms: Date.parse(at(1)), line: 41, paste_missing: false }
      const legacy = { type: 'legacy', table: 'memory_episodes', id: legacyId, truncated: false }
      const missing = { type: 'legacy', table: 'memory_episodes', id: randomUUID(), truncated: true }
      const backfill = { name: 'engram-backfill', version: '1.0.0' }
      const [historyEvent, legacyEvent, missingEvent] = (await ingest([
        event('sess-origins', 'user_prompt', { text: 'From the history file.', transcript_line: null, origin: history }, {
          occurredAt: at(1),
          cwd: null,
          client: backfill,
        }),
        event('sess-origins', 'user_prompt', { text: 'Recovered prompt.', transcript_line: null, origin: legacy }, {
          occurredAt: at(2),
          cwd: null,
          client: backfill,
        }),
        event('sess-origins', 'user_prompt', { text: 'Lost prompt.', transcript_line: null, origin: missing }, {
          occurredAt: at(3),
          cwd: null,
          client: backfill,
        }),
      ])) as [string, string, string]

      await expect(store.materialize(200)).resolves.toEqual(counts(3, 0, 1, 0, 0))

      const fromHistory = await itemOf(historyEvent)
      expect(fromHistory.source).toEqual({ ...(await sourceBase(historyEvent)), type: 'history', origin: history, line: 41 })
      expect(fromHistory.lineage).toEqual([])

      const fromLegacy = await itemOf(legacyEvent)
      expect(fromLegacy.source).toEqual({ ...(await sourceBase(legacyEvent)), type: 'legacy', origin: legacy })
      expect(fromLegacy.lineage).toEqual([legacyId])

      expect(await state(missingEvent)).toBe('true|0|origin_not_found')
      expect(await count(`SELECT count(*) FROM public.memory_items WHERE source ->> 'event_id' = '${missingEvent}';`)).toBe(0)
      expect(await count(`SELECT count(*) FROM public.memory_items;`)).toBe(3)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'runs live sessions before backfill, and each session in event-time order',
    async () => {
      const backfill = { name: 'engram-backfill', version: '1.0.0' }
      const history = (minutes: number) => ({ type: 'history', timestamp_ms: Date.parse(at(minutes)), line: minutes + 1, paste_missing: false })
      const [live1, live2, back1, back2, mixed1, mixed2] = (await ingest([
        prompt('sess-live', 'live one', 10),
        prompt('sess-live', 'live two', 11),
        prompt('sess-backfill', 'backfill one', 1, { client: backfill }),
        prompt('sess-backfill', 'backfill two', 2, { client: backfill }),
        event('sess-mixed', 'user_prompt', { text: 'mixed, from history', transcript_line: null, origin: history(0) }, { occurredAt: at(0) }),
        prompt('sess-mixed', 'mixed, live', 3),
      ])) as [string, string, string, string, string, string]
      const processed = async (): Promise<string[]> =>
        (await pg.psql(`SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM public.memory_capture_events WHERE processed_at IS NOT NULL;`))
          .split(',')
          .filter((id) => id !== '')

      await expect(store.materialize(2)).resolves.toEqual(counts(2, 0, 0, 4, 0))
      expect(await processed()).toEqual([live1, live2])

      // sess-mixed is backfill while its history prompt is pending, so its live
      // prompt waits behind it; once the history prompt is done the session is
      // live and runs before the remaining backfill.
      const order: string[] = []
      for (let i = 0; i < 4; i++) {
        const before = new Set(await processed())
        await expect(store.materialize(1)).resolves.toMatchObject({ locked: true, processed: 1, failed: 0 })
        order.push(...(await processed()).filter((id) => !before.has(id)))
      }
      expect(order).toEqual([mixed1, mixed2, back1, back2])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'creates nothing on a second call, and one artifact for a commit captured by two sessions',
    async () => {
      const commit = { repo: 'sample-repo', sha: SHA, message: 'feat: importer flag', files: ['src/a.ts'], authored_at: at(1) }
      const [, firstCommit, secondCommit] = (await ingest([
        prompt('sess-commit-a', 'commit the importer', 0),
        event('sess-commit-a', 'git_commit', commit, { occurredAt: at(1) }),
        event('sess-commit-b', 'git_commit', commit, { occurredAt: at(1) }),
      ])) as [string, string, string]

      await expect(store.materialize(200)).resolves.toEqual(counts(3, 0, 0, 0, 0))
      expect(await count(`SELECT count(*) FROM public.memory_items;`)).toBe(2)
      expect(await state(secondCommit)).toBe('true|0|')
      const artifact = await items(`i.source ->> 'event_key' = 'git:sample-repo:${SHA}'`)
      expect(artifact).toHaveLength(1)
      expect(artifact[0]!.source.event_id).toBe(firstCommit)

      await expect(store.materialize(200)).resolves.toEqual(counts(0, 0, 0, 0, 0))
      expect(await count(`SELECT count(*) FROM public.memory_items;`)).toBe(2)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'chains ledger decision versions by event time, whatever the delivery order, and fails equal times',
    async () => {
      const [v1] = (await ingest([decision('Version one.', 1)])) as [string]
      await expect(store.materialize(200)).resolves.toEqual(counts(1, 0, 0, 0, 0))
      const restated = [at(1.5)]
      await pg.psql(
        `UPDATE public.memory_items SET restated_at = ARRAY['${restated[0]}']::timestamptz[] WHERE source ->> 'event_id' = '${v1}';`,
      )
      const [v2] = (await ingest([decision('Version two.', 2)])) as [string]
      await expect(store.materialize(200)).resolves.toEqual(counts(1, 0, 0, 0, 0))
      const [one, two] = [await itemOf(v1), await itemOf(v2)]
      expect(one.superseded_by).toBe(two.id)
      expect(two.superseded_by).toBeNull()
      expect(two.restated_at).toEqual(restated)
      expect(two.source.version_of).toBe('ledger-decision:sample-plan:flag-rollout')

      const [later] = (await ingest([decision('Later.', 5, 'late-delivery')])) as [string]
      await expect(store.materialize(200)).resolves.toEqual(counts(1, 0, 0, 0, 0))
      const [earlier] = (await ingest([decision('Earlier.', 4, 'late-delivery')])) as [string]
      await expect(store.materialize(200)).resolves.toEqual(counts(1, 0, 0, 0, 0))
      expect((await itemOf(earlier)).superseded_by).toBe((await itemOf(later)).id)
      expect((await itemOf(later)).superseded_by).toBeNull()

      const [tie] = (await ingest([decision('Same time.', 5, 'late-delivery')])) as [string]
      await expect(store.materialize(200)).resolves.toEqual(counts(0, 1, 0, 1, 0))
      expect(await state(tie)).toBe(
        'false|1|engram_capture_materialize: another version of this item has the same event time',
      )
      expect(await count(`SELECT count(*) FROM public.memory_items WHERE source ->> 'event_id' = '${tie}';`)).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'supersedes a register entry with its next version and retires a version that is not active',
    async () => {
      const [active, retired] = (await ingest([registerEntry('R-TST-1', 'active', 1), registerEntry('R-TST-1', 'retired', 2)])) as [
        string,
        string,
      ]
      await expect(store.materialize(200)).resolves.toEqual(counts(2, 0, 0, 0, 0))
      const [first, second] = [await itemOf(active), await itemOf(retired)]
      expect(first.source.id).toBe('R-TST-1')
      expect(first.superseded_by).toBe(second.id)
      expect(first.retired_reason).toBeNull()
      expect(second.superseded_by).toBeNull()
      expect(second.retired_reason).toBe('register status: retired')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'stores the next version of a retired entry as current and leaves the retired version unsuperseded',
    async () => {
      const [active, retired, again] = (await ingest([
        registerEntry('R-TST-1', 'active', 1),
        registerEntry('R-TST-1', 'retired', 2),
        registerEntry('R-TST-1', 'active', 3),
      ])) as [string, string, string]
      await expect(store.materialize(200)).resolves.toEqual(counts(3, 0, 0, 0, 0))
      const [first, second, third] = [await itemOf(active), await itemOf(retired), await itemOf(again)]
      expect(first.superseded_by).toBe(second.id)
      expect(second.superseded_by).toBeNull()
      expect(second.retired_reason).toBe('register status: retired')
      expect(third.superseded_by).toBeNull()
      expect(third.retired_reason).toBeNull()
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'retires the current version of each entry a register entry supersedes',
    async () => {
      const [old, replacement] = (await ingest([
        registerEntry('R-TST-1', 'active', 1),
        registerEntry('R-TST-2', 'active', 2, ['R-TST-1']),
      ])) as [string, string]
      await expect(store.materialize(200)).resolves.toEqual(counts(2, 0, 0, 0, 0))
      const [first, second] = [await itemOf(old), await itemOf(replacement)]
      expect(first.retired_reason).toBe('superseded in the register by R-TST-2')
      expect(first.superseded_by).toBeNull()
      expect(second.retired_reason).toBeNull()
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'records a candidate on a standing statement, and fails a candidate_status naming no statement',
    async () => {
      const said = 'Every importer ships behind a flag, always.'
      const [utteranceId] = (await insertItems([
        {
          class: 'utterance',
          kind: 'user_prompt',
          speaker: 'mk',
          trust: 0,
          content: said,
          search_text: said,
          occurred_at: at(0),
          source: { type: 'ingest_tool', event_key: 'tst:utterance-1' },
        },
      ])) as [string]
      const [statementId] = (await insertItems([
        {
          class: 'mk_statement',
          kind: 'ruling',
          speaker: 'mk',
          trust: 0,
          subject_id: SUBJECT_ID,
          content: 'Every importer ships behind a flag',
          search_text: 'Every importer ships behind a flag',
          occurred_at: at(0),
          source: { type: 'extraction', event_key: 'tst:statement-1' },
          lineage: [utteranceId],
          standing: true,
          register_status: 'candidate',
        },
      ])) as [string]

      const [recorded, unknown] = (await ingest([
        event('sess-review', 'candidate_status', { item_id: statementId, status: 'recorded', register_id: 'R-TST-1' }, { occurredAt: at(1) }),
        event('sess-unknown', 'candidate_status', { item_id: randomUUID(), status: 'dismissed' }, { occurredAt: at(1) }),
      ])) as [string, string]
      await expect(store.materialize(200)).resolves.toEqual(counts(1, 1, 0, 1, 0))

      expect(await state(recorded)).toBe('true|0|')
      expect(
        await pg.psql(`SELECT register_status || '|' || register_ref FROM public.memory_items WHERE id = '${statementId}';`),
      ).toBe('recorded|R-TST-1')
      expect(await state(unknown)).toBe('false|1|engram_capture_materialize: candidate_status names no mk_statement')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'holds a session behind its failing event until that event is dead',
    async () => {
      const [failing, waiting] = (await ingest([
        event('sess-stuck', 'candidate_status', { item_id: randomUUID(), status: 'dismissed' }, { occurredAt: at(1) }),
        prompt('sess-stuck', 'said after the failing event', 2),
      ])) as [string, string]

      await expect(store.materialize(200)).resolves.toEqual(counts(0, 1, 0, 2, 0))
      expect(await state(waiting)).toBe('false|0|')
      await expect(store.materialize(200)).resolves.toEqual(counts(0, 1, 0, 2, 0))
      expect(await state(waiting)).toBe('false|0|')
      await expect(store.materialize(200)).resolves.toEqual(counts(1, 1, 0, 0, 1))
      expect(await state(failing)).toBe('false|3|engram_capture_materialize: candidate_status names no mk_statement')
      expect(await state(waiting)).toBe('true|0|')
      await expect(store.materialize(200)).resolves.toEqual(counts(0, 0, 0, 0, 1))
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'answers {"locked": false} and touches nothing while another transaction holds the lock',
    async () => {
      const [only] = (await ingest([prompt('sess-lock', 'wait for the lock', 1)])) as [string]
      const holder = await pg.session()
      try {
        await holder.run('BEGIN;')
        await holder.run(`SELECT pg_advisory_xact_lock(${MATERIALIZE_LOCK});`)
        await expect(store.materialize(200)).resolves.toEqual({ locked: false })
        expect(await state(only)).toBe('false|0|')
        await holder.run('COMMIT;')
      } finally {
        await holder.close()
      }
      await expect(store.materialize(200)).resolves.toEqual(counts(1, 0, 0, 0, 0))
      expect(await state(only)).toBe('true|0|')
    },
    TEST_TIMEOUT_MS,
  )

  it('refuses a limit outside 1 to 1000 as an invalid argument', async () => {
    const call = (limit: string) =>
      pg.psqlAs('service_role', `SELECT public.engram_capture_materialize(${limit});`).then(
        () => 'ran',
        (e: unknown) => String(e),
      )
    expect(await call('0')).toMatch(/p_limit must be from 1 to 1000/)
    expect(await call('1001')).toMatch(/p_limit must be from 1 to 1000/)
    expect(await call('NULL')).toMatch(/p_limit must be from 1 to 1000/)
  })
})
