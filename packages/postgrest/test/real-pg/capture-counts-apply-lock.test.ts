/**
 * Applying schema.sql statement by statement (plain `psql -f`) while a
 * materialize pass sits between its read of the capture events and its
 * update of them must not deadlock.
 *
 * A pass reads memory_capture_events (ACCESS SHARE) and then updates the rows
 * it read (ROW EXCLUSIVE). The block that recreates the count triggers drops
 * them, which needs ACCESS EXCLUSIVE. Had it first taken a weaker lock that
 * still conflicts with ROW EXCLUSIVE and then upgraded, the apply would wait
 * on the pass's read while holding a lock the pass's update waits on.
 *
 * The interleaving is forced, not left to timing. Earlier statements of the
 * apply (ALTER TABLE on the events) take ACCESS EXCLUSIVE themselves, so the
 * pass must read after them: an event trigger on the creation of the count
 * trigger function, the statement right before the block, holds the apply on
 * an advisory lock the pass owns. The pass reads, releases that lock, waits
 * until the apply is seen waiting on the events table, then updates and
 * commits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { realPgImage, startRealPg, type PsqlSession, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 120_000
const WAIT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 50
const SCHEMA_SQL = fileURLToPath(new URL('../../schema.sql', import.meta.url))
const HOLD_KEY = 7_120_021

const STORED_EVENTS = `
INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload, attempts, processed_at)
VALUES ('apply-lock-a', 'apply-lock-pending-one', 'pre_compact', '2026-09-20T08:00:00Z', '{}', 0, NULL),
       ('apply-lock-a', 'apply-lock-pending-two', 'pre_compact', '2026-09-20T08:01:00Z', '{}', 1, NULL),
       ('apply-lock-b', 'apply-lock-pending-three', 'pre_compact', '2026-09-20T08:02:00Z', '{}', 0, NULL),
       ('apply-lock-b', 'apply-lock-dead', 'pre_compact', '2026-09-20T08:03:00Z', '{}', 3, NULL);
`

// Fires after the count trigger function is created and waits there until
// the pass releases HOLD_KEY.
const HOLD_APPLY_BEFORE_COUNTS_BLOCK = `
CREATE FUNCTION public.test_hold_apply() RETURNS event_trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() c
              WHERE c.object_identity = 'public.memory_capture_events_count()') THEN
    PERFORM pg_advisory_xact_lock(${HOLD_KEY});
  END IF;
END; $$;
CREATE EVENT TRIGGER test_hold_apply ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION')
  EXECUTE FUNCTION public.test_hold_apply();
`

const PASS_READ = `
BEGIN;
SELECT count(*) FROM public.memory_capture_events c WHERE c.processed_at IS NULL AND c.attempts < 3;`

const PASS_UPDATE = `
UPDATE public.memory_capture_events c SET processed_at = now()
 WHERE c.event_uuid = 'apply-lock-pending-one';
COMMIT;`

const EVENT_COUNTS = `
SELECT count(*) FILTER (WHERE attempts < 3) || '|' || count(*) FILTER (WHERE attempts >= 3)
  FROM public.memory_capture_events WHERE processed_at IS NULL;`

async function waitUntil(pg: RealPg, sql: string, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while ((await pg.psql(sql)) === '0') {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

describe.skipIf(!realPgImage)('applying schema.sql while a materialize pass holds its read of the events', () => {
  let pg: RealPg
  let pass: PsqlSession
  let applyError: unknown
  let passError: unknown

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(STORED_EVENTS)
    await pg.psql(HOLD_APPLY_BEFORE_COUNTS_BLOCK)
    pass = await pg.session()
    const passPid = Number(await pass.run(`SELECT pg_backend_pid() FROM pg_advisory_lock(${HOLD_KEY});`))

    const applied = pg.apply(SCHEMA_SQL, { singleTransaction: false }).then(
      () => undefined,
      (error: unknown) => {
        applyError = error
      },
    )
    await waitUntil(
      pg,
      `SELECT count(*) FROM pg_locks l WHERE l.locktype = 'advisory' AND l.objid = ${HOLD_KEY} AND NOT l.granted;`,
      'the apply reached the count trigger function',
    )
    await pass.run(PASS_READ)
    await pass.run(`SELECT pg_advisory_unlock(${HOLD_KEY});`)
    await waitUntil(
      pg,
      `SELECT count(*) FROM pg_locks l
        WHERE l.relation = 'public.memory_capture_events'::regclass AND NOT l.granted AND l.pid <> ${passPid};`,
      'the apply waited on memory_capture_events',
    )
    await pass.run(PASS_UPDATE).catch(async (error: unknown) => {
      passError = error
      await pass.run('ROLLBACK;')
    })
    await applied
    await pg.psql(`DROP EVENT TRIGGER test_hold_apply; DROP FUNCTION public.test_hold_apply();`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pass?.close()
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  it(
    'lets the pass update and commit and the apply complete, with no deadlock on either side',
    async () => {
      expect(passError).toBeUndefined()
      expect(applyError).toBeUndefined()
      expect(
        await pg.psql(
          `SELECT processed_at IS NOT NULL FROM public.memory_capture_events WHERE event_uuid = 'apply-lock-pending-one';`,
        ),
      ).toBe('t')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'keeps the counts equal to a count over the events',
    async () => {
      expect(await pg.psql(EVENT_COUNTS)).toBe('2|1')
      expect(await pg.psql(`SELECT sum(pending) || '|' || sum(dead) FROM public.memory_capture_event_counts;`)).toBe(
        '2|1',
      )
      const result = JSON.parse(await pg.psql(`SELECT public.engram_capture_materialize(1);`)) as Record<string, unknown>
      const [pending, dead] = (await pg.psql(EVENT_COUNTS)).split('|').map(Number)
      expect({ pending: result.pending, dead: result.dead }).toEqual({ pending, dead })
    },
    TEST_TIMEOUT_MS,
  )
})
