/**
 * One session end to end on real Postgres behind PostgREST: its capture
 * events go through the route, and the capture worker alone materializes,
 * extracts with a scripted model and builds the session index, as the server
 * runs it. The events arrive in the order a live session sends them:
 * - a ruling, then a dialog answer, then a prompt that changes the ruling,
 *   which the decision pass weighs against the ruling the prompt did not
 *   name, so the change supersedes it;
 * - a briefing shows the current ruling, the assistant repeats it, and MK
 *   corrects it: a correction statement with a corrects link, nothing retired;
 * - the assistant's last turn before session_end is flushed into an
 *   observation, and session_end builds the index;
 * - the session resumes with a prompt that restates the dialog answer, which
 *   adds a restatement time and stores nothing, and the new session_end
 *   rebuilds the index, superseding the first.
 * Every item invariant reads zero at the end.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DECISION_LABEL, resetDefaultSecretRegistry } from '@engram-mem/core'
import type { CompleteJsonRequest, IntelligenceAdapter, SecretRegistryStatus } from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { parseProjectRegistry, registryRows, type ProjectRegistry } from '../../src/capture-events/project-registry.js'
import { runCaptureEventsRequest, type CaptureEventsRouteDeps } from '../../src/capture-events/route.js'
import { startCaptureWorker, type CaptureWorker } from '../../src/capture-events/worker.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../../postgrest/test/real-pg/harness.js'
import { envelope, type FixtureEvent } from './fixtures.js'

const SETUP_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 180_000
const STAGE_TIMEOUT_MS = 30_000
const POLL_MS = 100
const DIMENSIONS = 1536
const HEALTHY: SecretRegistryStatus = { configured: true, unreadable: [], values: 0 }
const SESSION = 'sess-spool-walk'
const SHA = 'f00dfeed4321abcd9876f00dfeed4321abcd9876'
const EMPTY_REPLY = '{"statements":[],"observations":[]}'
const NO_DECISIONS = '{"decisions":[]}'
const QUESTION = 'Which store should the importer write to?'

const REGISTRY: ProjectRegistry = parseProjectRegistry({
  version: 1,
  workspaces: { 'tst-ws': { root: '~/work/tst-ws', vault_folder: null, register_prefix: null } },
  projects: { 'tst-repo': { workspace: 'tst-ws', vault_folder: null, register_prefix: null } },
})

const T = (minute: number): string => new Date(Date.UTC(2026, 0, 14, 9, minute)).toISOString()
const at = (minute: number): string => T(minute).replace('.000Z', 'Z')

let uuidCounter = 0
function event(type: string, payload: Record<string, unknown>, minute: number): FixtureEvent {
  uuidCounter += 1
  return {
    session_id: SESSION,
    event_uuid: `walk-evt-${uuidCounter}`,
    type,
    occurred_at: T(minute),
    cwd: '/home/tester/tst-repo',
    project: { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null },
    plan_dirs: [],
    payload,
  }
}

const said = (text: string, minute: number) => event('user_prompt', { text, transcript_line: minute }, minute)
const answeredBy = (text: string, minute: number, tools: Array<{ name: string; ref: string | null }> = []) =>
  event('assistant_turn', { text, transcript_line: minute, tools }, minute)
const started = (reason: string, minute: number) => event('session_start', { reason }, minute)
const ended = (minute: number) => event('session_end', { reason: 'exit' }, minute)

function statement(fields: {
  quote: string
  subject: Record<string, string>
  kind?: string
  question?: string
  restates?: string[]
  corrects?: string[]
}): string {
  return JSON.stringify({
    statements: [
      {
        utterance_id: 'utt-1',
        quote: fields.quote,
        question: fields.question ?? null,
        kind: fields.kind ?? 'ruling',
        standing: false,
        scope: 'project',
        subject: fields.subject,
        applies_to: [],
        supersedes: [],
        restates: fields.restates ?? [],
        corrects: fields.corrects ?? [],
      },
    ],
    observations: [],
  })
}

/** The alias a window gives the line matching `pattern`; the first capture group is the alias. */
function aliasIn(user: string, pattern: RegExp): string {
  const hit = pattern.exec(user)
  if (hit === null) throw new Error(`the window lists nothing matching ${pattern}:\n${user}`)
  return hit[1]!
}

/**
 * The model's replies, chosen by the MK utterance a window is built on (or,
 * for a window of assistant turns only, by its turn), with the aliases the
 * window gave the subjects and items it names. Pass 1 never names the ruling
 * the second prompt changes, so only the decision pass can retire it.
 */
function reply(user: string): string {
  const utterance = /^utt-1 \(MK, [^)]+\):\n(.+)$/m.exec(user)?.[1] ?? ''
  const flush = subject('spool flush interval')
  if (utterance.startsWith('Keep the spool flush')) {
    return statement({ quote: 'Keep the spool flush interval at five seconds', subject: { new: 'spool flush interval' } })
  }
  if (utterance === `QUESTION q-1: ${QUESTION}`) {
    return statement({ quote: 'Postgres', question: QUESTION, subject: { new: 'importer store' } })
  }
  if (utterance.startsWith('Make the spool flush')) {
    return statement({ quote: 'Make the spool flush interval two seconds instead', subject: { id: flush(user) } })
  }
  if (utterance.startsWith("no, that's stale")) {
    return statement({
      quote: 'the spool flushes every three seconds now',
      kind: 'correction',
      subject: { id: flush(user) },
      corrects: [aliasIn(user, /^(shown-\d+) .*two seconds/m)],
    })
  }
  if (utterance.startsWith('Keep the importer on Postgres')) {
    return statement({
      quote: 'Keep the importer on Postgres',
      subject: { id: subject('importer store')(user) },
      restates: [aliasIn(user, /^(stmt-\d+) \[ruling, importer store, [0-9-]+\] Postgres$/m)],
    })
  }
  if (utterance === '' && user.includes('):\nCommitted: the spool')) {
    return JSON.stringify({
      statements: [],
      observations: [
        {
          assistant_utterance_id: aliasIn(user, /^(turn-\d+) \(ASSISTANT, [^)]+\):\nCommitted: the spool/m),
          claim: 'The spool in tst-repo flushes every three seconds.',
          kind: 'finding',
          subject: { id: flush(user) },
          evidence: [{ type: 'commit', ref: SHA.slice(0, 12) }],
          valid_at: null,
          supersedes: [],
        },
      ],
    })
  }
  return EMPTY_REPLY
}

function subject(label: string): (user: string) => string {
  return (user) => aliasIn(user, new RegExp(`^(subj-\\d+) ${label}$`, 'm'))
}

function scriptedModel() {
  const windows: CompleteJsonRequest[] = []
  const decisions: CompleteJsonRequest[] = []
  const unanswered: string[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      if (req.label === DECISION_LABEL) {
        decisions.push(req)
        const text = req.user.includes('Make the spool flush interval two seconds instead')
          ? '{"decisions":[{"item":0,"relation":"supersedes","targets":["c-1"],"corrects":[]}]}'
          : NO_DECISIONS
        return { text, finishReason: 'stop', model: 'tst-model' }
      }
      windows.push(req)
      try {
        return { text: reply(req.user), finishReason: 'stop', model: 'tst-model' }
      } catch (err) {
        unanswered.push(String(err))
        throw err
      }
    },
  }
  return { intelligence, windows, decisions, unanswered }
}

describe.skipIf(!realPgImage || !postgrestImage)('one session through the capture worker on real Postgres', () => {
  let pg: RealPg
  let store: PostgRestCaptureStore

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

  async function json<T>(sql: string): Promise<T> {
    return JSON.parse(await pg.psql(sql)) as T
  }

  /** The item an event materialized into. */
  const itemOf = (e: FixtureEvent): Promise<string> =>
    pg.psql(
      `SELECT i.id FROM public.memory_items i JOIN public.memory_capture_events e ON i.source ->> 'event_id' = e.id::text
        WHERE e.event_uuid = '${e.event_uuid as string}';`,
    )

  it(
    'stores the items, links and supersessions of the session and keeps one current index across a resume',
    async () => {
      const logs: string[] = []
      const deps: CaptureEventsRouteDeps = {
        store,
        ready: () => REGISTRY,
        status: () => HEALTHY,
        log: (line) => logs.push(line),
        now: () => new Date(),
      }
      const send = async (...events: FixtureEvent[]): Promise<void> => {
        const res = await runCaptureEventsRequest(deps, envelope(events))
        expect(res.body).toEqual({ accepted: events.length, duplicates: 0, rejected: [] })
      }
      const waitFor = async (stage: string, sql: string): Promise<void> => {
        const deadline = Date.now() + STAGE_TIMEOUT_MS
        while ((await pg.psql(sql)) !== 't') {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${stage}; worker log:\n${[...logs, ...model.unanswered].join('\n')}`)
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        }
      }
      const extracted = async (stage: string, anchor: FixtureEvent): Promise<void> =>
        waitFor(
          stage,
          `SELECT EXISTS (SELECT 1 FROM public.memory_extraction_runs r JOIN public.memory_items i ON i.id = r.anchor_item_id
                           JOIN public.memory_capture_events e ON i.source ->> 'event_id' = e.id::text
                          WHERE e.event_uuid = '${anchor.event_uuid as string}' AND r.status = 'succeeded');`,
        )
      const settled = (stage: string): Promise<void> =>
        waitFor(
          stage,
          `SELECT st.indexed_event_id = st.last_event_id AND st.index_item_id IS NOT NULL
             FROM public.memory_session_state st WHERE st.session_id = '${SESSION}';`,
        )

      const model = scriptedModel()
      const worker: CaptureWorker = startCaptureWorker({
        store,
        embedder: {
          embedBatch: async (texts) => texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.01)),
          dimensions: () => DIMENSIONS,
        },
        embeddingModel: `tst-embed:${DIMENSIONS}:v1`,
        extraction: { store, intelligence: model.intelligence, model: 'tst-chat-model' },
        sessionIndex: { store },
        intervalMs: 50,
        log: (line) => logs.push(line),
      })

      const ruling = said('Keep the spool flush interval at five seconds.', 1)
      const question = answeredBy(QUESTION, 2)
      const answer = event(
        'user_answer',
        {
          questions: [
            {
              question: QUESTION,
              header: 'Store',
              options: [
                { label: 'Postgres', description: 'the item store' },
                { label: 'Files', description: '' },
              ],
              multiSelect: false,
            },
          ],
          answers: { [QUESTION]: 'Postgres' },
          transcript_line: 3,
        },
        3,
      )
      const change = said('Make the spool flush interval two seconds instead.', 5)
      const correction = said("no, that's stale — the spool flushes every three seconds now", 9)
      const commitTurn = answeredBy('Committed: the spool now flushes every three seconds.', 11, [{ name: 'Bash', ref: SHA }])
      const restatement = said('Keep the importer on Postgres, as I said.', 31)
      try {
        await send(started('startup', 0), ruling)
        await extracted('the first ruling', ruling)

        await send(question, answer, answeredBy('The importer writes to Postgres now.', 4), change)
        await extracted('the dialog answer', answer)
        await extracted('the changed ruling', change)
        const changed = await pg.psql(
          `SELECT id FROM public.memory_items WHERE class = 'mk_statement' AND content LIKE 'Make the spool%';`,
        )

        await send(
          event('briefing_shown', { item_ids: [changed], channel: 'prompt', prompt_event_uuid: null }, 7),
          answeredBy('The spool flushes every two seconds.', 8),
          correction,
        )
        await extracted('the correction', correction)

        await send(commitTurn, ended(12))
        await settled('the first index')
        const firstIndex = await pg.psql(`SELECT index_item_id FROM public.memory_session_state WHERE session_id = '${SESSION}';`)

        await send(started('resume', 30), restatement, answeredBy('Noted, the importer stays on Postgres.', 32), ended(33))
        await extracted('the restatement', restatement)
        await settled('the rebuilt index')

        const [p1, answerItem, p2, p3, correctionUtterance, commitItem] = await Promise.all(
          [ruling, answer, change, restatement, correction, commitTurn].map(itemOf),
        )

        // Items: four statements and one observation, each quoting its source.
        const items = await json<Array<Record<string, unknown>>>(
          `SELECT json_agg(json_build_object('class', class, 'kind', kind, 'content', content, 'lineage', lineage,
                    'superseded_by', superseded_by, 'valid_to', valid_to IS NOT NULL, 'retired', retired_at IS NOT NULL,
                    'restated', cardinality(restated_at), 'id', id) ORDER BY occurred_at)
             FROM public.memory_items WHERE class IN ('mk_statement', 'observation');`,
        )
        expect(items.map(({ id: _id, superseded_by: _s, ...rest }) => rest)).toEqual([
          { class: 'mk_statement', kind: 'ruling', content: 'Keep the spool flush interval at five seconds', lineage: [p1], valid_to: true, retired: false, restated: 0 },
          { class: 'mk_statement', kind: 'ruling', content: 'Postgres', lineage: [answerItem], valid_to: false, retired: false, restated: 1 },
          { class: 'mk_statement', kind: 'ruling', content: 'Make the spool flush interval two seconds instead', lineage: [p2], valid_to: false, retired: false, restated: 0 },
          { class: 'mk_statement', kind: 'correction', content: 'the spool flushes every three seconds now', lineage: [correctionUtterance], valid_to: false, retired: false, restated: 0 },
          { class: 'observation', kind: 'finding', content: 'The spool in tst-repo flushes every three seconds.', lineage: [commitItem], valid_to: false, retired: false, restated: 0 },
        ])
        const [fiveSeconds, postgres, twoSeconds, threeSeconds, finding] = items.map((i) => i['id'] as string)

        // Supersessions: the changed ruling retires the old one; nothing else is superseded.
        expect(items.map((i) => i['superseded_by'])).toEqual([twoSeconds, null, null, null, null])
        expect(model.decisions).toHaveLength(1)
        expect(model.decisions[0]!.user).toMatch(/^c-1 \[.*\] Keep the spool flush interval at five seconds$/m)

        // Links: the correction names the item the briefing showed, and nothing is linked otherwise.
        expect(
          await json<unknown[]>(
            `SELECT coalesce(json_agg(json_build_object('from', from_item, 'to', to_item, 'rel', rel)), '[]') FROM public.memory_item_links;`,
          ),
        ).toEqual([{ from: threeSeconds, to: twoSeconds, rel: 'corrects' }])

        // The restatement stored nothing and dated the answer it repeats.
        expect(
          await pg.psql(
            `SELECT restated_at[1] = '${T(31)}'::timestamptz FROM public.memory_items WHERE id = '${postgres}';`,
          ),
        ).toBe('t')
        expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE lineage @> ARRAY['${p3}'::uuid] AND class <> 'session_index';`)).toBe('0')

        // One current index, superseding the one session_end built before the resume.
        const indexes = await json<Array<Record<string, unknown>>>(
          `SELECT json_agg(json_build_object('id', id, 'superseded_by', superseded_by, 'content', content) ORDER BY occurred_at)
             FROM public.memory_items WHERE class = 'session_index' AND session_id = '${SESSION}';`,
        )
        const current = indexes.filter((i) => i['superseded_by'] === null)
        expect(indexes).toHaveLength(2)
        expect(current).toHaveLength(1)
        expect(indexes[0]!['id']).toBe(firstIndex)
        expect(indexes[0]!['superseded_by']).not.toBeNull()
        expect(indexes.at(-1)).toBe(current[0])
        // The index quotes MK, lists the current statements (the superseded ruling is gone) and the commit.
        expect(current[0]!['content']).toBe(
          [
            `Session ${SESSION}`,
            'Project: tst-repo',
            'Workspace: tst-ws',
            `From ${at(0)} to ${at(33)}`,
            'Plans: none',
            'MK (5):',
            `${at(1)} Keep the spool flush interval at five seconds.`,
            `${at(3)} Q: ${QUESTION} A: Postgres`,
            `${at(5)} Make the spool flush interval two seconds instead.`,
            `${at(9)} no, that's stale — the spool flushes every three seconds now`,
            `${at(31)} Keep the importer on Postgres, as I said.`,
            `Statements (3): ${postgres} ${twoSeconds} ${threeSeconds}`,
            `Observations (1): ${finding}`,
            `Commits (1): tst-repo@${SHA.slice(0, 12)}`,
            'PRs (0):',
            'Ledger (0):',
          ].join('\n'),
        )
        expect(current[0]!['content']).not.toContain(fiveSeconds)

        // Every item invariant holds.
        expect(
          await pg.psql(`SELECT coalesce(sum(violations), -1) FROM public.engram_invariant_counts();`),
        ).toBe('0')
        expect(await pg.psql(`SELECT count(*) FROM public.engram_invariant_counts();`)).not.toBe('0')
        expect(await pg.psql(`SELECT count(*) FROM public.memory_capture_events WHERE processed_at IS NULL;`)).toBe('0')
        expect(logs.join('\n')).not.toMatch(/failed=[1-9]|status=(held|failed)|failed:/)
        expect(model.unanswered).toEqual([])
      } finally {
        await worker.stop(5_000)
      }
    },
    TEST_TIMEOUT_MS,
  )
})
