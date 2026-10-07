/**
 * Corrections, retractions and register candidates through PostgREST on real
 * Postgres, one extraction tick each with recorded replies:
 * - MK correcting an item a briefing showed the assistant before its reply
 *   gives a correction statement and a corrects link, and retires nothing;
 * - an assistant turn that says an item it names by id was wrong gives one
 *   retracts link from the turn; a negated phrase gives none; a retraction
 *   naming an id that resolves to no item is counted as unresolved;
 * - a standing statement that restates an active register entry stores
 *   nothing and adds a restatement time to the entry; one that changes it is
 *   stored as a candidate with a changes link, also when its subject is new;
 *   a statement that is not standing has no register status.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  DECISION_LABEL,
  EXTRACTOR_VERSION,
  generateId,
  itemEventKey,
  runExtractionTick,
  type CompleteJsonRequest,
  type ExtractionItem,
  type IntelligenceAdapter,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const SESSION = 'sess-contest'
const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }
const EMPTY_REPLY = '{"statements":[],"observations":[]}'
const NO_DECISIONS = '{"decisions":[]}'
const ENTRY_ID = 'R-TST-3'
const ENTRY_SUBJECT = 'importer flags'

let eventCounter = 0
function event(type: string, payload: Record<string, unknown>, occurredAt: string): StoredEvent {
  eventCounter += 1
  return {
    sessionId: SESSION,
    eventUuid: `contest-evt-${eventCounter}`,
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

const said = (text: string, occurredAt: string): StoredEvent => event('user_prompt', { text, transcript_line: 1 }, occurredAt)
const answered = (text: string, occurredAt: string): StoredEvent =>
  event('assistant_turn', { text, transcript_line: 2, tools: [] }, occurredAt)
const briefed = (itemIds: string[], occurredAt: string): StoredEvent =>
  event('briefing_shown', { item_ids: itemIds, channel: 'prompt', prompt_event_uuid: null }, occurredAt)
const registered = (occurredAt: string): StoredEvent =>
  event(
    'register_entry',
    {
      id: ENTRY_ID,
      status: 'active',
      subject: ENTRY_SUBJECT,
      said_at: occurredAt,
      quote: 'every importer ships behind a flag',
      question: 'Should importers ship dark?',
      verified: 'transcript line 12',
      applies_to: ['importers'],
      triggers: ['new importer'],
      supersedes: [],
      restated: [],
      scope: 'project:tst-repo',
      file: '/notes/Tst/Rulings.md',
    },
    occurredAt,
  )

interface Utterance {
  id: string
  at: string
}

interface StatementReply {
  quote: string
  kind?: string
  standing?: boolean
  subject?: Record<string, string>
  corrects?: string[]
}

/** The reply set for the window whose MK utterance starts with its marker; an empty reply for every other window. */
function scripted(windowReplies: Record<string, string>, decisionReply = NO_DECISIONS) {
  const requests: CompleteJsonRequest[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      requests.push(req)
      if (req.label === DECISION_LABEL) return { text: decisionReply, finishReason: 'stop', model: 'tst-model' }
      const hit = Object.keys(windowReplies).find((marker) => req.user.includes(`):\n${marker}`))
      return { text: hit === undefined ? EMPTY_REPLY : windowReplies[hit]!, finishReason: 'stop', model: 'tst-model' }
    },
  }
  return { intelligence, requests }
}

function statementReply(s: StatementReply): string {
  return JSON.stringify({
    statements: [
      {
        utterance_id: 'utt-1',
        quote: s.quote,
        question: null,
        kind: s.kind ?? 'ruling',
        standing: s.standing ?? false,
        scope: 'project',
        subject: s.subject ?? { new: 'server port' },
        applies_to: [],
        supersedes: [],
        restates: [],
        corrects: s.corrects ?? [],
      },
    ],
    observations: [],
  })
}

describe.skipIf(!realPgImage || !postgrestImage)('corrections, retractions and register candidates on real Postgres', () => {
  let pg: RealPg
  let store: PostgRestCaptureStore
  let versions = 0

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    const endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
    await store.syncProjects([
      { id: 'tst-ws', kind: 'workspace', workspaceId: null, vaultFolder: null, registerPrefix: null },
      { id: 'tst-repo', kind: 'project', workspaceId: 'tst-ws', vaultFolder: null, registerPrefix: 'TST' },
    ])
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  beforeEach(async () => {
    await pg.psql(
      'TRUNCATE public.memory_item_links, public.memory_items, public.memory_capture_events, ' +
        'public.memory_extraction_runs, public.memory_subjects CASCADE;',
    )
  })

  async function seed(...events: StoredEvent[]): Promise<Utterance[]> {
    const ingested = await store.ingestEvents(events)
    expect(ingested.map((e) => e.status)).toEqual(events.map(() => 'accepted'))
    expect(await store.materialize(1000)).toMatchObject({ locked: true, failed: 0 })
    return Promise.all(
      ingested.map(async (e, i) => ({
        id: await pg.psql(`SELECT coalesce((SELECT id::text FROM public.memory_items WHERE source ->> 'event_id' = '${e.eventId}'), '');`),
        at: events[i]!.occurredAt,
      })),
    )
  }

  async function subject(label: string): Promise<string> {
    return pg.psql(
      `WITH added AS (INSERT INTO public.memory_subjects (project_id, label) VALUES ('tst-repo', '${label}') RETURNING id) SELECT id FROM added;`,
    )
  }

  /** Stores an observation under a run of a seeding version, so the extractor version still finds the turn pending. */
  async function storeObservation(turn: Utterance, content: string, subjectId: string): Promise<string> {
    versions += 1
    const item: ExtractionItem = {
      id: generateId(),
      class: 'observation',
      kind: 'fact',
      speaker: 'assistant',
      trust: 3,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: SESSION,
      subjectId,
      subjectKey: null,
      content,
      searchText: content,
      context: null,
      occurredAt: new Date(turn.at),
      standing: null,
      registerStatus: null,
      source: { type: 'extraction', utterance_id: turn.id, event_key: itemEventKey('observation', turn.id, content), evidence: [] },
      lineage: [turn.id],
      entities: [],
    }
    const run = await store.extractionBegin({ anchorId: turn.id, sessionId: SESSION, version: `seed-${versions}`, model: null })
    expect(run).not.toBeNull()
    await store.extractionCommit(run!, { subjects: [], items: [item], stats: {} })
    return item.id
  }

  async function latestRun(anchor: Utterance): Promise<{ id: string; status: string; stats: Record<string, unknown> }> {
    return JSON.parse(
      await pg.psql(
        `SELECT json_build_object('id', r.id, 'status', r.status, 'stats', r.stats) FROM public.memory_extraction_runs r
          WHERE r.anchor_item_id = '${anchor.id}' AND r.extractor_version = '${EXTRACTOR_VERSION}'
          ORDER BY r.started_at DESC LIMIT 1;`,
      ),
    ) as { id: string; status: string; stats: Record<string, unknown> }
  }

  async function linksOf(runId: string): Promise<{ from: string; to: string; rel: string }[]> {
    return JSON.parse(
      await pg.psql(
        `SELECT coalesce(json_agg(json_build_object('from', l.from_item, 'to', l.to_item, 'rel', l.rel) ORDER BY l.rel, l.to_item), '[]')
           FROM public.memory_item_links l WHERE l.run_id = '${runId}';`,
      ),
    ) as { from: string; to: string; rel: string }[]
  }

  async function created(runId: string): Promise<{ id: string; kind: string; register_status: string | null }[]> {
    return JSON.parse(
      await pg.psql(
        `SELECT coalesce(json_agg(json_build_object('id', i.id, 'kind', i.kind, 'register_status', i.register_status)), '[]')
           FROM public.memory_items i WHERE i.extraction_run_id = '${runId}';`,
      ),
    ) as { id: string; kind: string; register_status: string | null }[]
  }

  async function entryItem(): Promise<{ id: string; restated: string[]; current: boolean }> {
    return JSON.parse(
      await pg.psql(
        `SELECT json_build_object('id', i.id, 'restated', to_json(i.restated_at),
                                  'current', i.superseded_by IS NULL AND i.retired_at IS NULL)
           FROM public.memory_items i WHERE i.kind = 'ruling_entry' AND i.source ->> 'id' = '${ENTRY_ID}';`,
      ),
    ) as { id: string; restated: string[]; current: boolean }
  }

  it('turns MK correcting an item a briefing showed into a correction statement with a corrects link', async () => {
    const port = await subject('server port')
    const [earlier] = await seed(answered('The engram MCP server listens on port 3850.', '2026-10-05T09:00:00Z'))
    const portFact = await storeObservation(earlier!, 'The engram MCP server listens on port 3850.', port)
    const [, , , now] = await seed(
      said('Which port does the server use?', '2026-10-06T14:00:00Z'),
      briefed([portFact], '2026-10-06T14:00:01Z'),
      answered('The server listens on port 3850.', '2026-10-06T14:01:00Z'),
      said("no, that's stale — it runs on 3851 now", '2026-10-06T14:05:00Z'),
    )
    const { intelligence, requests } = scripted({
      "no, that's stale": statementReply({ quote: 'it runs on 3851 now', kind: 'correction', corrects: ['shown-1'] }),
    })

    await runExtractionTick({ store, intelligence, model: 'tst-model', log: () => {} })

    const window = requests.find((r) => r.label !== DECISION_LABEL && r.user.includes("no, that's stale"))!
    expect(window.user).toContain('SHOWN TO THE ASSISTANT BEFORE turn-1:')
    const run = await latestRun(now!)
    expect(run).toMatchObject({ status: 'succeeded', stats: { links_applied: 1, links_rejected: [] } })
    const [correction] = await created(run.id)
    expect(correction).toMatchObject({ kind: 'correction', register_status: null })
    expect(await linksOf(run.id)).toEqual([{ from: correction!.id, to: portFact, rel: 'corrects' }])
    expect(await pg.psql(`SELECT superseded_by IS NULL AND retired_at IS NULL FROM public.memory_items WHERE id = '${portFact}';`)).toBe('t')
  }, TEST_TIMEOUT_MS)

  it('links an assistant turn that says an item it names was wrong to that item, once', async () => {
    const cap = await subject('rate cap')
    const [earlier] = await seed(answered('The rate cap is 40 requests.', '2026-10-05T09:00:00Z'))
    const capFact = await storeObservation(earlier!, 'The rate cap is 40 requests.', cap)
    const [turn, now] = await seed(
      answered(`My earlier claim in ${capFact} was wrong: the cap is 50.`, '2026-10-06T14:01:00Z'),
      said('ok, thanks', '2026-10-06T14:05:00Z'),
    )

    await runExtractionTick({ store, intelligence: scripted({}).intelligence, model: 'tst-model', log: () => {} })

    const run = await latestRun(now!)
    expect(run).toMatchObject({ status: 'succeeded', stats: { retractions_unresolved: 0, links_applied: 1 } })
    expect(await linksOf(run.id)).toEqual([{ from: turn!.id, to: capFact, rel: 'retracts' }])
  }, TEST_TIMEOUT_MS)

  it('makes no link for a negated phrase and counts a retraction of an unknown id as unresolved', async () => {
    const cap = await subject('rate cap')
    const [earlier] = await seed(answered('The rate cap is 40 requests.', '2026-10-05T09:00:00Z'))
    const capFact = await storeObservation(earlier!, 'The rate cap is 40 requests.', cap)
    const [, negatedPrompt, , unknownPrompt] = await seed(
      answered(`Item ${capFact} is not stale.`, '2026-10-06T14:01:00Z'),
      said('good', '2026-10-06T14:05:00Z'),
      answered(`The note ${generateId()} is out of date.`, '2026-10-06T14:10:00Z'),
      said('noted', '2026-10-06T14:15:00Z'),
    )

    await runExtractionTick({ store, intelligence: scripted({}).intelligence, model: 'tst-model', log: () => {} })

    const negated = await latestRun(negatedPrompt!)
    const unknown = await latestRun(unknownPrompt!)
    expect(negated).toMatchObject({ status: 'succeeded', stats: { retractions_unresolved: 0, links_applied: 0 } })
    expect(unknown).toMatchObject({ status: 'succeeded', stats: { retractions_unresolved: 1, links_applied: 0 } })
    expect(await pg.psql(`SELECT count(*) FROM public.memory_item_links WHERE rel = 'retracts';`)).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('stores nothing for a standing statement that restates an active entry and adds the time to the entry', async () => {
    // An observation filed under the subject lists it in the window, so the statement names a stored subject.
    const flags = await subject(ENTRY_SUBJECT)
    const [earlier] = await seed(answered('Importers ship dark by default.', '2026-08-20T10:00:00Z'))
    await storeObservation(earlier!, 'Importers ship dark by default.', flags)
    await seed(registered('2026-09-01T10:00:00Z'))
    const before = await entryItem()
    const [now] = await seed(said('Importers ship behind a flag, always.', '2026-10-06T14:00:00Z'))
    const { intelligence, requests } = scripted(
      { 'Importers ship': statementReply({ quote: 'Importers ship behind a flag, always', standing: true, subject: { id: 'subj-1' } }) },
      '{"decisions":[{"item":0,"relation":"restates","targets":["c-1"],"corrects":[]}]}',
    )

    await runExtractionTick({ store, intelligence, model: 'tst-model', log: () => {} })

    const decision = requests.find((r) => r.label === DECISION_LABEL)!
    expect(decision.user).toMatch(/c-1 \[register entry, ruling_entry, 2026-09-01\]/)
    const run = await latestRun(now!)
    expect(run.status).toBe('succeeded')
    expect(await created(run.id)).toEqual([])
    const after = await entryItem()
    expect(before.restated).toEqual([])
    expect(after).toMatchObject({ id: before.id, current: true })
    expect(after.restated.map((t) => Date.parse(t))).toEqual([Date.parse(now!.at)])
    expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE class = 'mk_statement';`)).toBe('0')
  }, TEST_TIMEOUT_MS)

  it('stores a standing statement on a new subject that changes an active entry as a candidate with a changes link', async () => {
    await seed(registered('2026-09-01T10:00:00Z'))
    const entry = await entryItem()
    const [now] = await seed(said('Importers no longer need a flag.', '2026-10-06T14:00:00Z'))
    const { intelligence } = scripted(
      { 'Importers no longer': statementReply({ quote: 'Importers no longer need a flag', standing: true, subject: { new: 'Importer  Flags' } }) },
      '{"decisions":[{"item":0,"relation":"supersedes","targets":["c-1"],"corrects":[]}]}',
    )

    await runExtractionTick({ store, intelligence, model: 'tst-model', log: () => {} })

    const run = await latestRun(now!)
    expect(run).toMatchObject({ status: 'succeeded', stats: { decision_calls: 1, link_race: [] } })
    const [candidate] = await created(run.id)
    expect(candidate).toMatchObject({ kind: 'ruling', register_status: 'candidate' })
    expect(await linksOf(run.id)).toEqual([{ from: candidate!.id, to: entry.id, rel: 'changes' }])
    expect(await entryItem()).toMatchObject({ current: true, restated: [] })
  }, TEST_TIMEOUT_MS)

  it('gives a statement that is not standing no register status and weighs it against no register entry', async () => {
    await seed(registered('2026-09-01T10:00:00Z'))
    const [now] = await seed(said('Use a flag for this importer only.', '2026-10-06T14:00:00Z'))
    const { intelligence, requests } = scripted({
      'Use a flag': statementReply({ quote: 'Use a flag for this importer only', kind: 'ruling', subject: { new: ENTRY_SUBJECT } }),
    })

    await runExtractionTick({ store, intelligence, model: 'tst-model', log: () => {} })

    expect(requests.filter((r) => r.label === DECISION_LABEL)).toEqual([])
    const run = await latestRun(now!)
    expect(await created(run.id)).toEqual([expect.objectContaining({ register_status: null })])
  }, TEST_TIMEOUT_MS)
})
