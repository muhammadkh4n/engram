/**
 * Applying schema.sql statement by statement (plain `psql -f`, each statement
 * its own transaction) over a database that stores pending and dead capture
 * events but has no counts table yet must seed counts equal to the events,
 * even when another connection stores an event while the apply runs.
 *
 * The interleaving is forced, not left to timing: an event trigger on the
 * creation of the TRUNCATE count trigger sends an insert through a second
 * connection (dblink) and returns only once that insert is waiting on the
 * events table's lock. If the triggers and the seed commit separately, the
 * insert lands between them, writes a delta row, and the seed that checks
 * for an empty counts table is skipped; the counts then miss every event
 * stored before the triggers existed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 120_000
const SCHEMA_SQL = fileURLToPath(new URL('../../schema.sql', import.meta.url))
const WRITER_EVENT_UUID = 'seed-race-writer'

const DATABASE_WITHOUT_COUNTS = `
DROP TRIGGER memory_capture_events_count ON public.memory_capture_events;
DROP TRIGGER memory_capture_events_count_truncate ON public.memory_capture_events;
DROP FUNCTION public.memory_capture_events_count();
DROP TABLE public.memory_capture_event_counts;
INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload, attempts, processed_at)
VALUES ('seed-race-a', 'stored-pending-one', 'pre_compact', '2026-09-20T08:00:00Z', '{}', 0, NULL),
       ('seed-race-a', 'stored-pending-two', 'pre_compact', '2026-09-20T08:01:00Z', '{}', 2, NULL),
       ('seed-race-b', 'stored-dead', 'pre_compact', '2026-09-20T08:02:00Z', '{}', 3, NULL),
       ('seed-race-c', 'stored-done', 'pre_compact', '2026-09-20T08:03:00Z', '{}', 0, '2026-09-20T08:04:00Z');
`

// Fires once, when the TRUNCATE count trigger is created, and holds that
// statement until the second connection's insert waits on the events lock.
const WRITER_BETWEEN_TRIGGERS_AND_SEED = `
CREATE EXTENSION IF NOT EXISTS dblink;
CREATE FUNCTION public.test_write_during_apply() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() c
                  WHERE c.object_identity LIKE 'memory_capture_events_count_truncate on %') THEN
    RETURN;
  END IF;
  IF 'seed_race_writer' = ANY (coalesce(public.dblink_get_connections(), '{}')) THEN
    RETURN;
  END IF;
  PERFORM public.dblink_connect('seed_race_writer', 'dbname=' || current_database() || ' user=postgres');
  PERFORM public.dblink_send_query('seed_race_writer',
    $sql$INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload)
         VALUES ('seed-race-d', '${WRITER_EVENT_UUID}', 'pre_compact', '2026-09-20T08:05:00Z', '{}')$sql$);
  LOOP
    EXIT WHEN EXISTS (SELECT 1 FROM pg_locks l
                       WHERE l.relation = 'public.memory_capture_events'::regclass
                         AND NOT l.granted AND l.pid <> pg_backend_pid());
    IF clock_timestamp() > v_deadline THEN
      RAISE EXCEPTION 'the second connection never waited on memory_capture_events';
    END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
END; $$;
CREATE EVENT TRIGGER test_write_during_apply ON ddl_command_end WHEN TAG IN ('CREATE TRIGGER')
  EXECUTE FUNCTION public.test_write_during_apply();
`

const EVENT_COUNTS = `
SELECT count(*) FILTER (WHERE attempts < 3) || '|' || count(*) FILTER (WHERE attempts >= 3)
  FROM public.memory_capture_events WHERE processed_at IS NULL;`

describe.skipIf(!realPgImage)('seeding the capture event counts while another connection stores an event', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(DATABASE_WITHOUT_COUNTS)
    await pg.psql(WRITER_BETWEEN_TRIGGERS_AND_SEED)
    await pg.apply(SCHEMA_SQL, { singleTransaction: false })
    const deadline = Date.now() + 10_000
    while ((await pg.psql(`SELECT count(*) FROM public.memory_capture_events WHERE event_uuid = '${WRITER_EVENT_UUID}';`)) !== '1') {
      if (Date.now() > deadline) throw new Error('the second connection never stored its event')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await pg.psql(`DROP EVENT TRIGGER test_write_during_apply; DROP FUNCTION public.test_write_during_apply();`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  it(
    'counts every stored pending and dead event, the concurrent one included',
    async () => {
      expect(await pg.psql(EVENT_COUNTS)).toBe('3|1')
      expect(await pg.psql(`SELECT sum(pending) || '|' || sum(dead) FROM public.memory_capture_event_counts;`)).toBe('3|1')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'reports the same counts from a materialize call as a count over the events',
    async () => {
      const result = JSON.parse(await pg.psql(`SELECT public.engram_capture_materialize(1);`)) as Record<string, unknown>
      const [pending, dead] = (await pg.psql(EVENT_COUNTS)).split('|').map(Number)
      expect({ pending: result.pending, dead: result.dead }).toEqual({ pending, dead })
    },
    TEST_TIMEOUT_MS,
  )
})
