/**
 * Re-applying schema.sql converges a memory_capture_events that predates the
 * backfill column, the running counts and the candidates index, and already
 * holds events:
 * - the database is brought to the earlier shape (no backfill column, no
 *   counts table, triggers or counting function, the time-ordered pending
 *   index instead of the candidates index) and holds pending, dead and
 *   processed events;
 * - two applies then derive backfill for every stored event, seed the counts
 *   from the stored events exactly once, swap the indexes, and a materialize
 *   call reports counts that match the table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 120_000

const EARLIER_SHAPE = `
DROP TRIGGER memory_capture_events_count ON public.memory_capture_events;
DROP TRIGGER memory_capture_events_count_truncate ON public.memory_capture_events;
DROP FUNCTION public.memory_capture_events_count();
DROP TABLE public.memory_capture_event_counts;
DROP INDEX public.idx_capture_events_candidates;
ALTER TABLE public.memory_capture_events DROP COLUMN backfill;
CREATE INDEX idx_capture_events_pending ON public.memory_capture_events USING btree (occurred_at, id) WHERE (processed_at IS NULL);
INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, client, payload, attempts, processed_at)
VALUES ('sess-a', 'live', 'pre_compact', '2026-10-01T09:00:00Z', '{"name": "engram-test"}', '{}', 0, NULL),
       ('sess-b', 'posted-by-backfill', 'pre_compact', '2026-10-01T09:01:00Z', '{"name": "engram-backfill"}', '{}', 1, NULL),
       ('sess-c', 'history-origin', 'pre_compact', '2026-10-01T09:02:00Z', '{"name": "engram-test"}', '{"origin": {"type": "history"}}', 0, NULL),
       ('sess-d', 'dead', 'pre_compact', '2026-10-01T09:03:00Z', '{}', '{}', 3, NULL),
       ('sess-e', 'done', 'pre_compact', '2026-10-01T09:04:00Z', '{}', '{}', 0, '2026-10-01T09:05:00Z');
`

describe.skipIf(!realPgImage)('re-applying schema.sql over an earlier memory_capture_events', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(EARLIER_SHAPE)
    await pg.applySchema()
    await pg.applySchema()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  it(
    'derives backfill for the stored events',
    async () => {
      expect(
        await pg.psql(`SELECT string_agg(event_uuid || '=' || backfill, ',' ORDER BY id) FROM public.memory_capture_events;`),
      ).toBe('live=false,posted-by-backfill=true,history-origin=true,dead=false,done=false')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'seeds the counts from the stored events once, and swaps the pending index for the candidates index',
    async () => {
      expect(await pg.psql(`SELECT count(*) || '|' || sum(pending) || '|' || sum(dead) FROM public.memory_capture_event_counts;`)).toBe(
        '1|3|1',
      )
      expect(
        await pg.psql(`SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes
                        WHERE schemaname = 'public' AND indexname IN ('idx_capture_events_pending', 'idx_capture_events_candidates');`),
      ).toBe('idx_capture_events_candidates')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'reports counts that match the table after a materialize call',
    async () => {
      const result = JSON.parse(await pg.psql(`SELECT public.engram_capture_materialize(1);`)) as Record<string, unknown>
      expect(result).toEqual({ locked: true, processed: 1, failed: 0, skipped: 0, pending: 2, dead: 1 })
      expect(await pg.psql(`SELECT event_uuid FROM public.memory_capture_events WHERE processed_at IS NOT NULL AND event_uuid <> 'done';`)).toBe(
        'live',
      )
    },
    TEST_TIMEOUT_MS,
  )
})
