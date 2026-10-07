/**
 * The decision pass through PostgREST on real Postgres:
 * - engram_extraction_candidates reads every current item on a new item's
 *   subject in the anchor's scope that occurred no later, newest first, cut
 *   to the limit with the total kept; a stored or repeated item needs none;
 * - one extraction tick with recorded replies weighs a new statement against
 *   both current statements on its subject and applies the recorded
 *   supersedes, and turns a recorded correction of a current observation
 *   into one corrects link that retires nothing;
 * - an item that becomes current on the subject between the read and the
 *   commit is recorded as a link race, and both stay current.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  DECISION_LABEL,
  EXTRACTOR_VERSION,
  generateId,
  itemEventKey,
  runExtractionTick,
  type CompleteJsonRequest,
  type ExtractionCandidateQuery,
  type ExtractionItem,
  type IntelligenceAdapter,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const SESSION = 'sess-decide'
const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }
const EMPTY_REPLY = '{"statements":[],"observations":[]}'

let eventCounter = 0
function event(type: string, payload: Record<string, unknown>, occurredAt: string): StoredEvent {
  eventCounter += 1
  return {
    sessionId: SESSION,
    eventUuid: `decide-evt-${eventCounter}`,
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

interface Utterance {
  id: string
  at: string
}

interface ItemState {
  id: string
  superseded_by: string | null
  retired_at: string | null
}

/** The reply set for the window whose MK utterance starts with its marker; an empty reply for every other window. */
function scripted(windowReplies: Record<string, string>, decisionReply: string) {
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

function statementReply(quote: string, kind = 'ruling'): string {
  return JSON.stringify({
    statements: [
      {
        utterance_id: 'utt-1',
        quote,
        question: null,
        kind,
        standing: false,
        scope: 'project',
        subject: { id: 'subj-1' },
        applies_to: [],
        supersedes: [],
        restates: [],
        corrects: [],
      },
    ],
    observations: [],
  })
}

describe.skipIf(!realPgImage || !postgrestImage)('the decision pass through PostgREST on real Postgres', () => {
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
      { id: 'tst-repo', kind: 'project', workspaceId: 'tst-ws', vaultFolder: null, registerPrefix: null },
      { id: 'tst-other', kind: 'project', workspaceId: 'tst-ws', vaultFolder: null, registerPrefix: null },
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
        id: await pg.psql(`SELECT id FROM public.memory_items WHERE source ->> 'event_id' = '${e.eventId}';`),
        at: events[i]!.occurredAt,
      })),
    )
  }

  async function subject(label: string, projectId: string | null = 'tst-repo'): Promise<string> {
    const project = projectId === null ? 'NULL' : `'${projectId}'`
    return pg.psql(
      `WITH added AS (INSERT INTO public.memory_subjects (project_id, label) VALUES (${project}, '${label}') RETURNING id) SELECT id FROM added;`,
    )
  }

  /** Stores items under a run of a seeding version, so the extractor version still finds the anchor pending. */
  async function storeItems(anchor: Utterance, items: ExtractionItem[]): Promise<string> {
    versions += 1
    const run = await store.extractionBegin({ anchorId: anchor.id, sessionId: SESSION, version: `seed-${versions}`, model: null })
    expect(run).not.toBeNull()
    await store.extractionCommit(run!, { subjects: [], items, stats: {} })
    return run!
  }

  function statement(from: Utterance, content: string, subjectId: string, over: Partial<ExtractionItem> = {}): ExtractionItem {
    return {
      id: generateId(),
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: SESSION,
      subjectId,
      subjectKey: null,
      content,
      searchText: content,
      context: null,
      occurredAt: new Date(from.at),
      standing: false,
      registerStatus: null,
      source: {
        type: 'extraction',
        utterance_id: from.id,
        event_key: itemEventKey('mk_statement', from.id, content),
        scope: 'project',
        applies_to: [],
      },
      lineage: [from.id],
      entities: [],
      ...over,
    }
  }

  function observation(turn: Utterance, content: string, subjectId: string): ExtractionItem {
    return {
      ...statement(turn, content, subjectId),
      class: 'observation',
      kind: 'fact',
      speaker: 'assistant',
      trust: 3,
      standing: null,
      source: { type: 'extraction', utterance_id: turn.id, event_key: itemEventKey('observation', turn.id, content), evidence: [] },
    }
  }

  function query(item: ExtractionItem, exclude: string[] = []): ExtractionCandidateQuery {
    return {
      subjectId: item.subjectId!,
      class: item.class,
      standing: item.standing === true,
      occurredAt: item.occurredAt,
      content: item.content,
      eventKey: String(item.source.event_key),
      exclude,
    }
  }

  async function states(ids: string[]): Promise<ItemState[]> {
    const out = await pg.psql(
      `SELECT coalesce(json_agg(json_build_object('id', i.id, 'superseded_by', i.superseded_by, 'retired_at', i.retired_at)
                       ORDER BY array_position(ARRAY[${ids.map((id) => `'${id}'::uuid`).join(', ')}], i.id)), '[]')
         FROM public.memory_items i WHERE i.id IN (${ids.map((id) => `'${id}'`).join(', ')});`,
    )
    return JSON.parse(out) as ItemState[]
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

  it('reads the newest 20 of 25 current statements with the total, all ids, and nothing later or excluded', async () => {
    const storage = await subject('storage backend')
    const days = Array.from({ length: 27 }, (_, n) => new Date(Date.UTC(2026, 8, n + 1, 10)).toISOString())
    const utterances = await seed(...days.map((at, n) => said(`Storage rule number ${n}.`, at)))
    const stored = utterances.map((u, n) => statement(u, `Storage rule number ${n}`, storage))
    for (const [n, item] of stored.entries()) await storeItems(utterances[n]!, [item])
    // The newest two: one excluded as a pass-1 target, one later than the new item.
    const [newItem] = await seed(said('Storage rule fresh.', '2026-09-26T12:00:00Z'))
    const fresh = statement(newItem!, 'Storage rule fresh', storage)

    const [read] = (await store.extractionCandidates(newItem!.id, [query(fresh, [stored[25]!.id])], 20))!

    // 26 statements occurred no later than the new item; one is excluded.
    expect(read).toMatchObject({ stored: null, repeatOf: null, total: 25 })
    expect(read!.read).toHaveLength(25)
    expect(read!.read).not.toContain(stored[25]!.id)
    expect(read!.read).not.toContain(stored[26]!.id)
    expect(read!.candidates.map((c) => c.content)).toEqual(
      Array.from({ length: 20 }, (_, n) => `Storage rule number ${24 - n}`),
    )
    expect(read!.candidates[0]).toMatchObject({ class: 'mk_statement', kind: 'ruling', subjectLabel: 'storage backend' })
  }, TEST_TIMEOUT_MS)

  it('reads statements and observations for a statement, observations only for an observation, and only in scope', async () => {
    const shared = await subject('server port', null)
    const [turn, prompt] = await seed(
      answered('The server listens on port 3850.', '2026-10-01T12:00:00Z'),
      said('Keep the port stable.', '2026-10-01T12:05:00Z'),
    )
    const portFact = observation(turn!, 'The engram MCP server listens on port 3850.', shared)
    const portRule = statement(prompt!, 'Keep the port stable', shared)
    const elsewhere = statement(prompt!, 'the port', shared, {
      projectId: 'tst-other',
      source: { type: 'extraction', utterance_id: prompt!.id, event_key: itemEventKey('mk_statement', prompt!.id, 'the port'), scope: 'project', applies_to: [] },
    })
    await storeItems(turn!, [portFact])
    await storeItems(prompt!, [portRule, elsewhere])
    const [now] = await seed(said('It listens on 3851 now.', '2026-10-06T14:00:00Z'))

    const reads = (await store.extractionCandidates(now!.id, [
      query(statement(now!, 'It listens on 3851 now', shared)),
      query(observation(now!, 'The server listens on 3851.', shared)),
    ], 20))!

    expect(reads[0]!.candidates.map((c) => c.id).sort()).toEqual([portFact.id, portRule.id].sort())
    expect(reads[1]!.candidates.map((c) => c.id)).toEqual([portFact.id])
  }, TEST_TIMEOUT_MS)

  it('needs no read for an item whose event key is stored or whose words repeat a current item', async () => {
    const storage = await subject('storage backend')
    const [first, second] = await seed(
      said('Postgres only.', '2026-10-01T10:00:00Z'),
      said('Again: Postgres  only.', '2026-10-02T10:00:00Z'),
    )
    const rule = statement(first!, 'Postgres only', storage)
    await storeItems(first!, [rule])

    const reads = (await store.extractionCandidates(second!.id, [
      query(rule),
      query(statement(second!, 'Postgres  only', storage)),
    ], 20))!

    expect(reads).toEqual([
      { stored: rule.id, repeatOf: null, total: 0, read: [], candidates: [] },
      { stored: null, repeatOf: rule.id, total: 0, read: [], candidates: [] },
    ])
  }, TEST_TIMEOUT_MS)

  it('weighs a new statement against both current statements on its subject and applies the recorded supersedes', async () => {
    const storage = await subject('storage backend')
    const [early, later, now] = await seed(
      said('Keep Postgres and SQLite both.', '2026-09-10T10:00:00Z'),
      said('The embeddings live in pgvector.', '2026-09-20T10:00:00Z'),
      said('Drop SQLite. Postgres only from here on.', '2026-10-04T09:00:00Z'),
    )
    const older = statement(early!, 'Postgres and SQLite both', storage)
    const newer = statement(later!, 'The embeddings live in pgvector', storage)
    await storeItems(early!, [older])
    await storeItems(later!, [newer])
    const { intelligence, requests } = scripted(
      { 'Drop SQLite.': statementReply('Postgres only from here on') },
      '{"decisions":[{"item":0,"relation":"supersedes","targets":["c-2"],"corrects":[]}]}',
    )

    await runExtractionTick({ store, intelligence, model: 'tst-model', log: () => {} })

    const decisionCalls = requests.filter((r) => r.label === DECISION_LABEL)
    expect(decisionCalls).toHaveLength(1)
    expect(decisionCalls[0]!.user).toMatch(/c-1 \[statement, ruling, 2026-09-20\] The embeddings live in pgvector/)
    expect(decisionCalls[0]!.user).toMatch(/c-2 \[statement, ruling, 2026-09-10\] Postgres and SQLite both/)
    const run = await latestRun(now!)
    expect(run).toMatchObject({ status: 'succeeded', stats: { model_calls: 2, decision_calls: 1, link_race: [] } })
    const created = await pg.psql(`SELECT id FROM public.memory_items WHERE extraction_run_id = '${run.id}';`)
    expect(await states([older.id, newer.id])).toEqual([
      { id: older.id, superseded_by: created, retired_at: null },
      { id: newer.id, superseded_by: null, retired_at: null },
    ])
  }, TEST_TIMEOUT_MS)

  it('turns a recorded correction of a current observation into one corrects link and retires nothing', async () => {
    const port = await subject('server port')
    const [turn, now] = await seed(
      answered('The engram MCP server listens on port 3850.', '2026-10-01T12:00:00Z'),
      said('no, the server listens on 3851', '2026-10-06T14:00:00Z'),
    )
    const fact = observation(turn!, 'The engram MCP server listens on port 3850.', port)
    await storeItems(turn!, [fact])
    const { intelligence } = scripted(
      { 'no, the server': statementReply('the server listens on 3851', 'correction') },
      '{"decisions":[{"item":0,"relation":"independent","targets":[],"corrects":["c-1"]}]}',
    )

    await runExtractionTick({ store, intelligence, model: 'tst-model', log: () => {} })

    const run = await latestRun(now!)
    expect(run).toMatchObject({ status: 'succeeded', stats: { decision_calls: 1, links_applied: 1 } })
    const links = JSON.parse(
      await pg.psql(
        `SELECT coalesce(json_agg(json_build_object('to', l.to_item, 'rel', l.rel, 'kind', i.kind)), '[]')
           FROM public.memory_item_links l JOIN public.memory_items i ON i.id = l.from_item WHERE l.run_id = '${run.id}';`,
      ),
    )
    expect(links).toEqual([{ to: fact.id, rel: 'corrects', kind: 'correction' }])
    expect(await states([fact.id])).toEqual([{ id: fact.id, superseded_by: null, retired_at: null }])
  }, TEST_TIMEOUT_MS)

  it('records an item that became current after the read as a link race and keeps both current', async () => {
    const storage = await subject('storage backend')
    const [early, racing, now] = await seed(
      said('Postgres and SQLite both.', '2026-09-10T10:00:00Z'),
      said('SQLite for the laptop build.', '2026-09-15T10:00:00Z'),
      said('Postgres only.', '2026-10-04T09:00:00Z'),
    )
    const older = statement(early!, 'Postgres and SQLite both', storage)
    await storeItems(early!, [older])
    const fresh = statement(now!, 'Postgres only', storage)
    const [read] = (await store.extractionCandidates(now!.id, [query(fresh)], 20))!
    expect(read!.read).toEqual([older.id])
    const appeared = statement(racing!, 'SQLite for the laptop build', storage)
    await storeItems(racing!, [appeared])

    const run = await store.extractionBegin({ anchorId: now!.id, sessionId: SESSION, version: 'race-1', model: null })
    await store.extractionCommit(run!, {
      subjects: [],
      items: [{ ...fresh, links: [{ rel: 'supersedes', target: older.id }], candidatesRead: read!.read }],
      stats: {},
    })

    const stats = JSON.parse(await pg.psql(`SELECT stats FROM public.memory_extraction_runs WHERE id = '${run}';`))
    expect(stats.link_race).toEqual([{ item: fresh.id, appeared: appeared.id }])
    expect(await states([older.id, appeared.id, fresh.id])).toEqual([
      { id: older.id, superseded_by: fresh.id, retired_at: null },
      { id: appeared.id, superseded_by: null, retired_at: null },
      { id: fresh.id, superseded_by: null, retired_at: null },
    ])
  }, TEST_TIMEOUT_MS)

  it('refuses candidates_read on an item that names no stored subject', async () => {
    const [now] = await seed(said('Postgres only.', '2026-10-04T09:00:00Z'))
    const run = await store.extractionBegin({ anchorId: now!.id, sessionId: SESSION, version: 'race-2', model: null })
    const item = { ...statement(now!, 'Postgres only', generateId()), subjectId: null, subjectKey: 'new-1', candidatesRead: [] }

    await expect(
      store.extractionCommit(run!, { subjects: [{ key: 'new-1', projectId: 'tst-repo', label: 'storage' }], items: [item], stats: {} }),
    ).rejects.toThrow(/candidates_read needs a subject_id/)
  }, TEST_TIMEOUT_MS)
})
