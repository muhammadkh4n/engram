/**
 * Links applied in the extraction commit's transaction, through a real
 * PostgREST in front of real Postgres:
 * - a supersedes link ends the older item at the newer one's event time;
 * - every link the validator refuses is recorded with its reason and never
 *   blocks its item; a target that stops being current before the commit is
 *   recorded as not_current;
 * - the same words again (whitespace aside) on the same subject store nothing
 *   and add the restatement time once; a restates link does the same;
 * - one utterance and quote is one item whatever its subject;
 * - a link the item rules refuse rolls back the window's items and links;
 * - engram_supersede_item refuses an inverted, equal-time, cross-class,
 *   already superseded or retired pair.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  generateId,
  itemEventKey,
  validateLinks,
  type ExtractionCommit,
  type ExtractionItem,
  type LinkProposal,
  type LinkTarget,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const SESSION = 'sess-links'
const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }

let eventCounter = 0
function event(type: string, payload: Record<string, unknown>, occurredAt: string): StoredEvent {
  eventCounter += 1
  return {
    sessionId: SESSION,
    eventUuid: `link-evt-${eventCounter}`,
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

interface ItemRow {
  id: string
  superseded_by: string | null
  valid_to: string | null
  restated_at: string[]
  retired_at: string | null
}

describe.skipIf(!realPgImage || !postgrestImage)('extraction links through PostgREST on real Postgres', () => {
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

  /** Stores and materializes the events; returns each event's utterance. */
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

  async function subject(label: string): Promise<string> {
    return pg.psql(
      `WITH added AS (INSERT INTO public.memory_subjects (project_id, label) VALUES ('tst-repo', '${label}') RETURNING id) SELECT id FROM added;`,
    )
  }

  /** Opens a run on the anchor under a fresh extractor version. */
  async function begin(anchor: Utterance): Promise<string> {
    versions += 1
    const run = await store.extractionBegin({ anchorId: anchor.id, sessionId: SESSION, version: `links-${versions}`, model: null })
    expect(run).not.toBeNull()
    return run!
  }

  async function commit(anchor: Utterance, items: ExtractionItem[]) {
    const run = await begin(anchor)
    const payload: ExtractionCommit = { subjects: [], items, stats: {} }
    return { run, result: await store.extractionCommit(run, payload) }
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

  async function rows(ids: string[]): Promise<ItemRow[]> {
    const out = await pg.psql(
      `SELECT coalesce(json_agg(json_build_object(
                'id', i.id, 'superseded_by', i.superseded_by,
                'valid_to', to_char(i.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'restated_at', (SELECT coalesce(json_agg(to_char(r AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ORDER BY r), '[]')
                                  FROM unnest(i.restated_at) AS r),
                'retired_at', i.retired_at) ORDER BY array_position(ARRAY[${ids.map((id) => `'${id}'::uuid`).join(', ')}], i.id)), '[]')
         FROM public.memory_items i WHERE i.id IN (${ids.map((id) => `'${id}'`).join(', ')});`,
    )
    return JSON.parse(out) as ItemRow[]
  }

  async function row(id: string): Promise<ItemRow> {
    const [found] = await rows([id])
    expect(found, `item ${id}`).toBeDefined()
    return found!
  }

  /** What the validator knows about stored items, read as the worker would read them. */
  async function targets(ids: string[]): Promise<LinkTarget[]> {
    const out = await pg.psql(
      `SELECT coalesce(json_agg(json_build_object(
                'id', i.id, 'class', i.class, 'kind', i.kind, 'subjectId', i.subject_id, 'subjectLabel', s.label,
                'occurredAt', i.occurred_at, 'supersededBy', i.superseded_by, 'retiredAt', i.retired_at,
                'forgottenAt', i.forgotten_at)), '[]')
         FROM public.memory_items i LEFT JOIN public.memory_subjects s ON s.id = i.subject_id
        WHERE i.id IN (${ids.map((id) => `'${id}'`).join(', ')});`,
    )
    return (JSON.parse(out) as LinkTarget[]).map((t) => ({ ...t, occurredAt: new Date(t.occurredAt).toISOString() }))
  }

  /** The items with the validator's verdict on each proposal attached. */
  async function validated(items: ExtractionItem[], proposals: LinkProposal[]): Promise<ExtractionItem[]> {
    const sources = items.map((item, index) => ({
      index,
      class: item.class,
      subjectId: item.subjectId,
      subjectLabel: null,
      occurredAt: item.occurredAt.toISOString(),
    }))
    const known = await targets([...new Set(proposals.map((p) => p.target))])
    const { accepted, rejected } = validateLinks(sources, proposals, known)
    return items.map((item, index) => ({
      ...item,
      links: accepted.filter((l) => l.item === index).map((l) => ({ rel: l.rel, target: l.target })),
      linksRejected: rejected.filter((l) => l.item === index).map((l) => ({ target: l.target, reason: l.reason })),
    }))
  }

  async function runStats(run: string): Promise<Record<string, unknown>> {
    return JSON.parse(await pg.psql(`SELECT stats FROM public.memory_extraction_runs WHERE id = '${run}';`)) as Record<string, unknown>
  }

  it('ends the superseded statement at the successor\'s event time', async () => {
    const storage = await subject('storage backend')
    const [early, late] = await seed(
      said('Keep Postgres and SQLite both for now.', '2026-09-30T10:00:00Z'),
      said('Postgres only from here on.', '2026-10-04T09:00:00Z'),
    )
    const oldRule = statement(early!, 'Postgres and SQLite both', storage)
    await commit(early!, [oldRule])
    const newRule = statement(late!, 'Postgres only', storage)
    const { run, result } = await commit(late!, await validated([newRule], [{ item: 0, rel: 'supersedes', target: oldRule.id }]))

    expect(result).toMatchObject({ itemIds: [newRule.id], duplicates: 0, restatements: 0 })
    expect(await row(oldRule.id)).toMatchObject({ superseded_by: newRule.id, valid_to: '2026-10-04T09:00:00Z' })
    expect(await row(newRule.id)).toMatchObject({ superseded_by: null, valid_to: null })
    expect(await runStats(run)).toMatchObject({ links_applied: 1, links_rejected: [] })
  }, TEST_TIMEOUT_MS)

  it('stores every item and records each refused link with its reason', async () => {
    const [main, other] = [await subject('release process'), await subject('deploy window')]
    const [before, now, after] = await seed(
      said('Retired note. Sealed note. Other subject note. Conflict base. Restate base. Unlisted note.', '2026-10-01T08:00:00Z'),
      said('Same moment note. One. Two. Three. Four. Five. Six. Seven. Eight.', '2026-10-02T08:00:00Z'),
      said('Later note.', '2026-10-03T08:00:00Z'),
    )
    const stored = {
      retired: statement(before!, 'Retired note', main),
      sealed: statement(before!, 'Sealed note', main),
      otherSubject: statement(before!, 'Other subject note', other),
      later: statement(after!, 'Later note', main),
      sameMoment: statement(now!, 'Same moment note', main),
      conflictBase: statement(before!, 'Conflict base', main),
      restateBase: statement(before!, 'Restate base', main),
      unlisted: statement(before!, 'Unlisted note', main),
    }
    await commit(before!, Object.values(stored))
    await pg.psql(`SELECT count(*) FROM public.engram_retire_items(ARRAY['${stored.retired.id}'::uuid], 'withdrawn in a test');`)

    const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight']
    const fresh = words.map((w) => statement(now!, w, main))
    const unknownTarget = generateId()
    const proposals: LinkProposal[] = [
      { item: 0, rel: 'supersedes', target: stored.retired.id },
      { item: 1, rel: 'changes', target: stored.sealed.id },
      { item: 2, rel: 'supersedes', target: stored.otherSubject.id },
      { item: 3, rel: 'supersedes', target: stored.later.id },
      { item: 4, rel: 'supersedes', target: stored.sameMoment.id },
      { item: 5, rel: 'supersedes', target: stored.conflictBase.id },
      { item: 5, rel: 'restates', target: stored.restateBase.id },
      { item: 6, rel: 'supersedes', target: stored.unlisted.id, candidates: [stored.conflictBase.id] },
      { item: 7, rel: 'corrects', target: unknownTarget },
    ]
    const { run, result } = await commit(now!, await validated(fresh, proposals))

    expect(result).toMatchObject({ itemIds: fresh.map((i) => i.id), duplicates: 0, restatements: 0 })
    expect((await rows(fresh.map((i) => i.id))).map((r) => r.superseded_by)).toEqual(fresh.map(() => null))
    expect((await runStats(run))['links_rejected']).toEqual([
      { item: fresh[0]!.id, target: stored.retired.id, reason: 'not_current' },
      { item: fresh[1]!.id, target: stored.sealed.id, reason: 'class_mismatch' },
      { item: fresh[2]!.id, target: stored.otherSubject.id, reason: 'subject_mismatch' },
      { item: fresh[3]!.id, target: stored.later.id, reason: 'target_newer' },
      { item: fresh[4]!.id, target: stored.sameMoment.id, reason: 'target_same_time' },
      { item: fresh[5]!.id, target: stored.conflictBase.id, reason: 'link_conflict' },
      { item: fresh[5]!.id, target: stored.restateBase.id, reason: 'link_conflict' },
      { item: fresh[6]!.id, target: stored.unlisted.id, reason: 'not_a_candidate' },
      { item: fresh[7]!.id, target: unknownTarget, reason: 'not_in_scope' },
    ])
    // Neither the equal-time statement nor any other target was touched.
    const untouched = [stored.sameMoment, stored.later, stored.conflictBase, stored.restateBase, stored.unlisted]
    expect((await rows(untouched.map((i) => i.id))).map((r) => [r.superseded_by, r.restated_at])).toEqual(untouched.map(() => [null, []]))
  }, TEST_TIMEOUT_MS)

  it('records a target that stopped being current after validation as not_current and stores the item', async () => {
    const decisions = await subject('review cadence')
    const [first, second] = await seed(said('Weekly reviews.', '2026-10-01T08:00:00Z'), said('Daily reviews.', '2026-10-02T08:00:00Z'))
    const weekly = statement(first!, 'Weekly reviews', decisions)
    await commit(first!, [weekly])
    const daily = statement(second!, 'Daily reviews', decisions)
    const items = await validated([daily], [{ item: 0, rel: 'supersedes', target: weekly.id }])
    expect(items[0]!.links).toEqual([{ rel: 'supersedes', target: weekly.id }])
    await pg.psql(`SELECT count(*) FROM public.engram_retire_items(ARRAY['${weekly.id}'::uuid], 'withdrawn in a test');`)

    const { run, result } = await commit(second!, items)
    expect(result.itemIds).toEqual([daily.id])
    expect(await row(weekly.id)).toMatchObject({ superseded_by: null })
    expect(await runStats(run)).toMatchObject({
      links_applied: 0,
      links_rejected: [{ item: daily.id, target: weekly.id, reason: 'not_current' }],
    })
  }, TEST_TIMEOUT_MS)

  it('stores nothing for the same words again and adds the restatement time once', async () => {
    const storage = await subject('storage backend')
    const [first, again] = await seed(
      said('Postgres only.', '2026-10-04T09:00:00Z'),
      said('As I said: Postgres  only.', '2026-10-05T11:30:00Z'),
    )
    const newRule = statement(first!, 'Postgres only', storage)
    await commit(first!, [newRule])

    const repeat = statement(again!, 'Postgres  only', storage)
    const { run, result } = await commit(again!, [repeat])
    expect(result).toEqual({ itemIds: [newRule.id], subjectsCreated: 0, duplicates: 0, restatements: 1, linksApplied: 0 })
    expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE class = 'mk_statement';`)).toBe('1')
    expect(await row(newRule.id)).toMatchObject({ superseded_by: null, restated_at: ['2026-10-05T11:30:00Z'] })
    expect((await runStats(run))['restatements']).toEqual([
      { target: newRule.id, at: '2026-10-05T11:30:00.000Z', utterance: again!.id },
    ])

    // The same window run again appends nothing.
    const rerun = await commit(again!, [statement(again!, 'Postgres  only', storage)])
    expect(rerun.result).toMatchObject({ itemIds: [newRule.id], restatements: 1 })
    expect(await row(newRule.id)).toMatchObject({ restated_at: ['2026-10-05T11:30:00Z'] })
  }, TEST_TIMEOUT_MS)

  it('treats a restates link as a restatement of its target', async () => {
    const storage = await subject('storage backend')
    const [first, again] = await seed(said('Postgres only.', '2026-10-04T09:00:00Z'), said('Only Postgres, still.', '2026-10-06T07:00:00Z'))
    const newRule = statement(first!, 'Postgres only', storage)
    await commit(first!, [newRule])
    const reworded = statement(again!, 'Only Postgres, still', storage)
    const { result } = await commit(again!, await validated([reworded], [{ item: 0, rel: 'restates', target: newRule.id }]))

    expect(result).toMatchObject({ itemIds: [newRule.id], restatements: 1 })
    expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE id = '${reworded.id}';`)).toBe('0')
    expect(await row(newRule.id)).toMatchObject({ restated_at: ['2026-10-06T07:00:00Z'] })
  }, TEST_TIMEOUT_MS)

  it('stores one utterance and normalized quote once, whatever subject each write names', async () => {
    const [storage, hosting] = [await subject('storage backend'), await subject('hosting')]
    const [utterance] = await seed(said('Run it on the small box.', '2026-10-04T09:00:00Z'))
    const first = statement(utterance!, 'Run it on the small box', storage)
    await commit(utterance!, [first])
    const second = statement(utterance!, 'Run it on the  small box', hosting)
    expect(second.source.event_key).toBe(first.source.event_key)

    const { result } = await commit(utterance!, [second])
    expect(result).toMatchObject({ itemIds: [first.id], duplicates: 1, restatements: 0 })
    expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE class = 'mk_statement';`)).toBe('1')
  }, TEST_TIMEOUT_MS)

  it('rolls back the window\'s items and links when one link breaks an item rule', async () => {
    const storage = await subject('storage backend')
    const [early, turn, late] = await seed(
      said('SQLite is fine.', '2026-10-01T08:00:00Z'),
      answered('The store runs on SQLite today.', '2026-10-01T08:05:00Z'),
      said('Postgres only.', '2026-10-04T09:00:00Z'),
    )
    const older = statement(early!, 'SQLite is fine', storage)
    const claim = observation(turn!, 'The store runs on SQLite today.', storage)
    await commit(early!, [older, claim])

    // A same-class link first, then one across classes: the validator would
    // refuse the second, so it is sent as accepted to reach the database rule.
    const newer = { ...statement(late!, 'Postgres only', storage), links: [
      { rel: 'supersedes' as const, target: older.id },
      { rel: 'supersedes' as const, target: claim.id },
    ] }
    const run = await begin(late!)
    await expect(store.extractionCommit(run, { subjects: [], items: [newer], stats: {} })).rejects.toThrow(/different classes/)

    expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE id = '${newer.id}';`)).toBe('0')
    expect(await row(older.id)).toMatchObject({ superseded_by: null, valid_to: null })
    expect(await pg.psql('SELECT count(*) FROM public.memory_item_links;')).toBe('0')
    expect(await pg.psql(`SELECT status FROM public.memory_extraction_runs WHERE id = '${run}';`)).toBe('running')
  }, TEST_TIMEOUT_MS)

  it('writes corrects as a link row once, under the run that wrote it', async () => {
    const storage = await subject('storage backend')
    const [turn, reply] = await seed(
      answered('The store listens on port 3850.', '2026-10-01T08:05:00Z'),
      said('No, it listens on 3851.', '2026-10-01T08:10:00Z'),
    )
    const claim = observation(turn!, 'The store listens on port 3850.', storage)
    await commit(turn!, [claim])
    const correction = statement(reply!, 'it listens on 3851', storage, { kind: 'correction' })
    const items = await validated([correction], [{ item: 0, rel: 'corrects', target: claim.id }])
    const { run } = await commit(reply!, items)
    await commit(reply!, items)

    const links = await pg.psql(
      `SELECT json_agg(json_build_object('from', from_item, 'to', to_item, 'rel', rel, 'run', run_id)) FROM public.memory_item_links;`,
    )
    expect(JSON.parse(links)).toEqual([{ from: correction.id, to: claim.id, rel: 'corrects', run }])
    expect(await row(claim.id)).toMatchObject({ superseded_by: null, retired_at: null })
  }, TEST_TIMEOUT_MS)

  describe('engram_supersede_item', () => {
    async function refusal(oldId: string, newId: string): Promise<string> {
      return pg.psqlAs('service_role', `SELECT public.engram_supersede_item('${oldId}', '${newId}');`).then(
        () => 'accepted',
        (error: Error) => error.message,
      )
    }

    it('refuses an inverted, equal-time, cross-class, already superseded or retired pair', async () => {
      const storage = await subject('storage backend')
      const [a, b, c, turn] = await seed(
        said('First take. Same time take.', '2026-10-01T08:00:00Z'),
        said('Second take.', '2026-10-02T08:00:00Z'),
        said('Third take. Fourth take.', '2026-10-03T08:00:00Z'),
        answered('A later claim.', '2026-10-04T08:00:00Z'),
      )
      const first = statement(a!, 'First take', storage)
      const sameTime = statement(a!, 'Same time take', storage)
      const second = statement(b!, 'Second take', storage)
      const third = statement(c!, 'Third take', storage)
      const fourth = statement(c!, 'Fourth take', storage)
      const claim = observation(turn!, 'A later claim.', storage)
      await commit(a!, [first, sameTime, second, third, fourth, claim])

      expect(await refusal(second.id, first.id)).toMatch(/p_new did not occur later than p_old/)
      expect(await refusal(first.id, sameTime.id)).toMatch(/p_new did not occur later than p_old/)
      expect(await refusal(first.id, claim.id)).toMatch(/different classes/)
      expect(await refusal(first.id, second.id)).toBe('accepted')
      expect(await refusal(first.id, third.id)).toMatch(/already superseded by another item/)
      await pg.psql(`SELECT count(*) FROM public.engram_retire_items(ARRAY['${third.id}'::uuid], 'withdrawn in a test');`)
      expect(await refusal(third.id, fourth.id)).toMatch(/p_old is retired/)
      expect(await row(first.id)).toMatchObject({ superseded_by: second.id, valid_to: '2026-10-02T08:00:00Z' })
    }, TEST_TIMEOUT_MS)
  })
})
