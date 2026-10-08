/**
 * What one engram_capture_materialize call costs on real Postgres as the
 * backlog grows. The worker calls it every two seconds; a call that read the
 * whole backlog would cost the square of the backlog to drain it, and once a
 * call outgrew the statement timeout it would roll back the same events on
 * every tick. With the session count fixed, ten times the pending events must
 * cost less than twice the shared buffers, and the call must still pick the
 * events the ranking defines: live sessions first, a session's rank taken
 * from its earliest candidate (dead events excluded), then event time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type PsqlSession, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 300_000
const LIMIT = 200
const SESSIONS = 100
const SMALL_SESSIONS = 7
const SMALL_SESSION_EVENTS = 20
const DEAD_EVENTS = 5

/** The candidate ranking the function is defined by, read the slow way. */
const REFERENCE_ORDER = `
  SELECT coalesce(string_agg(c.id::text, ',' ORDER BY c.backfill, c.occurred_at, c.id), '')
    FROM (SELECT ev.id, ev.occurred_at,
                 first_value((ev.payload ? 'origin') OR (ev.client ->> 'name') IS NOT DISTINCT FROM 'engram-backfill')
                   OVER (PARTITION BY ev.session_id ORDER BY ev.occurred_at, ev.id) AS backfill
            FROM public.memory_capture_events ev
           WHERE ev.processed_at IS NULL AND ev.attempts < 3
           ORDER BY backfill, ev.occurred_at, ev.id
           LIMIT ${LIMIT}) AS c;`

/** A few hundred characters per payload, the width of an ordinary prompt. */
const NOTE = `jsonb_build_object('note', repeat('one line of an ordinary prompt ', 12))`

/**
 * total pending events over SESSIONS sessions:
 * - s-00..s-02 live, 20 events each; s-00 also holds dead events from a
 *   history origin, earlier than all of its candidates;
 * - s-03, s-04 start live, then the backfill client posts the rest;
 * - s-05, s-06 start with a history origin, then live prompts;
 * - s-07..s-99 backfill, sharing the rest of the events.
 * Event times interleave across sessions, so the ranking decides the order.
 */
function seedSql(total: number): string {
  const rest = total - SMALL_SESSIONS * SMALL_SESSION_EVENTS
  const backfillSessions = SESSIONS - SMALL_SESSIONS
  return `
    TRUNCATE public.memory_items, public.memory_capture_events, public.memory_secret_hits CASCADE;
    INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, client, payload)
    SELECT format('s-%s', lpad(s::text, 2, '0')), format('e-%s-%s', s, i), 'pre_compact',
           timestamptz '2026-10-01 09:00:00+00' + make_interval(secs => i * 97 + s * 13),
           CASE WHEN s IN (3, 4) AND i > 0 THEN '{"name": "engram-backfill", "version": "1.0.0"}'::jsonb
                ELSE '{"name": "engram-test", "version": "1.0.0"}'::jsonb END,
           CASE WHEN s IN (5, 6) AND i = 0 THEN '{"origin": {"type": "history"}}'::jsonb ELSE '{}'::jsonb END || ${NOTE}
      FROM generate_series(0, ${SMALL_SESSIONS - 1}) AS s, generate_series(0, ${SMALL_SESSION_EVENTS - 1}) AS i;
    INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, client, payload)
    SELECT format('s-%s', lpad(s::text, 2, '0')), format('e-%s-%s', s, n), 'pre_compact',
           timestamptz '2026-10-01 09:00:00+00' + make_interval(secs => (n / ${backfillSessions}) * 97 + s * 13),
           '{"name": "engram-backfill", "version": "1.0.0"}'::jsonb, ${NOTE}
      FROM generate_series(0, ${rest - 1}) AS n, LATERAL (SELECT ${SMALL_SESSIONS} + n % ${backfillSessions} AS s) AS x;
    INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload, attempts, error)
    SELECT 's-00', format('dead-%s', d), 'pre_compact', timestamptz '2026-09-30 09:00:00+00' + make_interval(secs => d),
           '{"origin": {"type": "history"}}'::jsonb, 3, 'synthetic failure'
      FROM generate_series(1, ${DEAD_EVENTS}) AS d;
    ANALYZE public.memory_capture_events;`
}

interface CallCost {
  buffers: number
  expected: string[]
  picked: string[]
  counts: { pending: number; dead: number }
  trueCounts: { pending: number; dead: number }
}

describe.skipIf(!realPgImage)('engram_capture_materialize cost on real Postgres', () => {
  let pg: RealPg
  let session: PsqlSession

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    session = await pg.session()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await session?.close()
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  const processedIds = async (): Promise<Set<string>> =>
    new Set(
      (await session.run(`SELECT coalesce(string_agg(id::text, ','), '') FROM public.memory_capture_events WHERE processed_at IS NOT NULL;`))
        .split(',')
        .filter((id) => id !== ''),
    )

  const trueCounts = async (): Promise<{ pending: number; dead: number }> => {
    const [pending, dead] = (
      await session.run(
        `SELECT count(*) FILTER (WHERE attempts < 3) || '|' || count(*) FILTER (WHERE attempts >= 3)
           FROM public.memory_capture_events WHERE processed_at IS NULL;`,
      )
    ).split('|')
    return { pending: Number(pending), dead: Number(dead) }
  }

  async function measure(total: number): Promise<CallCost> {
    await session.run(seedSql(total))
    // One small call first: it plans the function's statements in this
    // connection, so the measured call reads data pages, not the catalog.
    await session.run(`SELECT public.engram_capture_materialize(1);`)

    const expected = (await session.run(REFERENCE_ORDER)).split(',').filter((id) => id !== '')
    const before = await processedIds()
    const plan = JSON.parse(
      await session.run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT public.engram_capture_materialize(${LIMIT});`),
    ) as [{ Plan: Record<string, number> }]
    const top = plan[0].Plan
    const buffers = (top['Shared Hit Blocks'] ?? 0) + (top['Shared Read Blocks'] ?? 0)
    const picked = [...(await processedIds())].filter((id) => !before.has(id))

    const result = JSON.parse(await session.run(`SELECT public.engram_capture_materialize(1);`)) as {
      pending: number
      dead: number
    }
    return {
      buffers,
      expected,
      picked: picked.sort((a, b) => Number(a) - Number(b)),
      counts: { pending: result.pending, dead: result.dead },
      trueCounts: await trueCounts(),
    }
  }

  it(
    'reads less than twice the buffers for ten times the backlog, and picks the same events',
    async () => {
      const small = await measure(10_000)
      const large = await measure(100_000)

      for (const run of [small, large]) {
        expect(run.expected).toHaveLength(LIMIT)
        expect(run.picked).toEqual([...run.expected].sort((a, b) => Number(a) - Number(b)))
        expect(run.counts).toEqual(run.trueCounts)
        expect(run.counts.dead).toBe(DEAD_EVENTS)
      }
      expect(large.counts.pending).toBe(100_000 - LIMIT - 2)
      expect(large.buffers).toBeLessThan(2 * small.buffers)
    },
    TEST_TIMEOUT_MS,
  )
})
