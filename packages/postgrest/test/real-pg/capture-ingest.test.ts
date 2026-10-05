/**
 * engram_capture_ingest through a real PostgREST in front of real Postgres,
 * with the service-role JWT:
 * - a batch ingested twice reads accepted, then duplicate, with the same ids;
 * - secret hits are written only for events this call inserted;
 * - two events with one key in one call store one row, the second reading
 *   duplicate with the first one's id;
 * - malformed batches are invalid arguments and store nothing;
 * - the function is closed to a request without a token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StoredEvent } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type PostgrestEndpoint, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

function event(sessionId: string, eventUuid: string, overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    sessionId,
    eventUuid,
    type: 'user_prompt',
    occurredAt: '2026-10-05T11:30:00+05:00',
    cwd: '/home/tester/sample-repo',
    project: { id: null, workspace: null, repo_root: '/home/tester/sample-repo', branch: 'main', worktree: null },
    planDirs: ['/home/tester/plans/sample-plan'],
    client: { name: 'engram-test', version: '1.0.0' },
    payload: { text: `prompt ${eventUuid}`, transcript_line: 3 },
    scrub: { masked: [] },
    hits: [],
    ...overrides,
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('engram_capture_ingest through PostgREST on real Postgres', () => {
  let pg: RealPg
  let endpoint: PostgrestEndpoint
  let store: PostgRestCaptureStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  const count = (sql: string): Promise<number> => pg.psql(sql).then(Number)

  it(
    'reads accepted, then duplicate with the same ids, and writes hits only for new events',
    async () => {
      const masked = { field: 'payload.text', detector: 'known', secret_name: 'SAMPLE_TOKEN' }
      const batch = [
        event('sess-ingest-1', 'evt-1', {
          payload: { text: 'use [REDACTED:SAMPLE_TOKEN] here', transcript_line: 1 },
          scrub: { masked: [masked], project_rejected: 'sample-repo-feature' },
          hits: [{ field: 'payload.text', detector: 'known', secretName: 'SAMPLE_TOKEN' }],
        }),
        event('sess-ingest-1', 'evt-2'),
        event('sess-ingest-1', 'evt-3', {
          hits: [
            { field: 'cwd', detector: 'aws-key', secretName: null },
            { field: 'plan_dirs[0]', detector: 'known', secretName: 'SAMPLE_TOKEN' },
          ],
        }),
      ]
      const first = await store.ingestEvents(batch)
      expect(first.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted'])
      expect(new Set(first.map((r) => r.eventId)).size).toBe(3)

      const hits = await pg.psql(
        `SELECT h.target_id || '|' || h.field || '|' || h.detector || '|' || coalesce(h.secret_name, '-')
           FROM public.memory_secret_hits h ORDER BY h.id;`,
      )
      expect(hits.split('\n')).toEqual([
        `${first[0]!.eventId}|payload.text|known|SAMPLE_TOKEN`,
        `${first[2]!.eventId}|cwd|aws-key|-`,
        `${first[2]!.eventId}|plan_dirs[0]|known|SAMPLE_TOKEN`,
      ])
      expect(
        await count(`SELECT count(*) FROM public.memory_secret_hits WHERE target_table <> 'memory_capture_events';`),
      ).toBe(0)

      const stored = await pg.psql(
        `SELECT occurred_at::text || '|' || cwd || '|' || plan_dirs::text || '|' || (scrub ->> 'project_rejected') || '|' ||
                (client ->> 'name') || '|' || (payload ->> 'text') || '|' || attempts || '|' || (processed_at IS NULL)
           FROM public.memory_capture_events WHERE id = ${first[0]!.eventId};`,
      )
      expect(stored).toBe(
        '2026-10-05 06:30:00+00|/home/tester/sample-repo|{/home/tester/plans/sample-plan}|sample-repo-feature|' +
          'engram-test|use [REDACTED:SAMPLE_TOKEN] here|0|true',
      )

      const second = await store.ingestEvents(batch)
      expect(second).toEqual(first.map((r) => ({ eventId: r.eventId, status: 'duplicate' })))
      expect(await count(`SELECT count(*) FROM public.memory_capture_events WHERE session_id = 'sess-ingest-1';`)).toBe(3)
      expect(await count(`SELECT count(*) FROM public.memory_secret_hits;`)).toBe(3)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'stores one row for two events with one key in one call',
    async () => {
      const hitsBefore = await count(`SELECT count(*) FROM public.memory_secret_hits;`)
      const result = await store.ingestEvents([
        event('sess-ingest-2', 'evt-same', { hits: [{ field: 'cwd', detector: 'known', secretName: 'SAMPLE_TOKEN' }] }),
        event('sess-ingest-2', 'evt-other'),
        event('sess-ingest-2', 'evt-same', {
          payload: { text: 'a second delivery', transcript_line: 9 },
          hits: [{ field: 'payload.text', detector: 'known', secretName: 'SAMPLE_TOKEN' }],
        }),
      ])
      expect(result.map((r) => r.status)).toEqual(['accepted', 'accepted', 'duplicate'])
      expect(result[2]!.eventId).toBe(result[0]!.eventId)
      expect(
        await pg.psql(
          `SELECT payload ->> 'text' FROM public.memory_capture_events
            WHERE session_id = 'sess-ingest-2' AND event_uuid = 'evt-same';`,
        ),
      ).toBe('prompt evt-same')
      expect(await count(`SELECT count(*) FROM public.memory_secret_hits;`)).toBe(hitsBefore + 1)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'refuses malformed batches as invalid arguments, storing nothing from the call',
    async () => {
      const before = await count(`SELECT count(*) FROM public.memory_capture_events;`)
      const raw = (e: StoredEvent): Record<string, unknown> => ({
        session_id: e.sessionId,
        event_uuid: e.eventUuid,
        type: e.type,
        occurred_at: e.occurredAt,
        cwd: e.cwd,
        project: e.project,
        plan_dirs: e.planDirs,
        client: e.client,
        payload: e.payload,
        scrub: e.scrub,
        hits: [],
      })
      const call = (pEvents: unknown) =>
        pg
          .psqlAs('service_role', `SELECT count(*) FROM public.engram_capture_ingest('${JSON.stringify(pEvents)}'::jsonb);`)
          .then(
            () => 'accepted',
            (e: unknown) => String(e),
          )
      const good = raw(event('sess-ingest-3', 'evt-ok'))
      expect(await call([])).toMatch(/p_events must be a JSON array of 1 to 500 events/)
      expect(await call(Array.from({ length: 501 }, (_, i) => raw(event('sess-ingest-3', `evt-${i}`))))).toMatch(
        /p_events must be a JSON array of 1 to 500 events/,
      )
      expect(await call([good, { ...good, event_uuid: 'evt-extra', extra: 1 }])).toMatch(/every event must be an object/)
      const { hits: _hits, ...noHits } = good
      expect(await call([noHits])).toMatch(/every event must be an object/)
      expect(await call([{ ...good, hits: [{ field: 'cwd', detector: 'known', name: 'x' }] }])).toMatch(
        /every event must be an object/,
      )
      expect(await call([{ ...good, plan_dirs: [1] }])).toMatch(/every event must be an object/)
      expect(await call([good, { ...good, event_uuid: 'evt-bad-time', occurred_at: 'yesterday' }])).toMatch(
        /event 2 has an occurred_at that is not a timestamp/,
      )
      expect(await call([{ ...good, occurred_at: '2026-10-05T11:30:00' }])).toMatch(/event 1 has an occurred_at/)
      expect(await call([{ ...good, occurred_at: '2026-13-40T11:30:00Z' }])).toMatch(/event 1 has an occurred_at/)
      expect(await call([good, { ...good, event_uuid: 'evt-bad-type', type: 'note' }])).toMatch(
        /memory_capture_events_type_check/,
      )
      expect(await count(`SELECT count(*) FROM public.memory_capture_events;`)).toBe(before)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'is closed to a request without a token',
    async () => {
      const response = await fetch(`${endpoint.url}/rpc/engram_capture_ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_events: [] }),
      })
      expect(response.status).toBeGreaterThanOrEqual(401)
      expect(response.status).toBeLessThan(500)
    },
    TEST_TIMEOUT_MS,
  )
})
