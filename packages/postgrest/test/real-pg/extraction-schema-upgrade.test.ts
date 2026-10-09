/**
 * Re-applying schema.sql converges a database that holds an earlier shape of
 * the extraction functions. CREATE OR REPLACE FUNCTION cannot change a
 * function's result columns, and a changed argument list creates a second
 * overload instead of replacing the first, so each earlier shape must be
 * dropped by schema.sql itself:
 * - engram_extraction_pending returning (…, failures, running_run_id, …) or
 *   (…, failures, held_failures, running_run_id, …);
 * - engram_extraction_fail(uuid, text, text, jsonb), before p_counted.
 * Each shape is built here with SQL; two applies then exit 0, leave only the
 * current functions with service_role's grant, and produce the same schema
 * dump as a fresh apply.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 120_000

const DROP_CURRENT = `
DROP FUNCTION public.engram_extraction_pending(text, integer, integer, timestamp with time zone);
DROP FUNCTION public.engram_extraction_fail(uuid, text, text, boolean, jsonb);
`

const EARLIER_FAIL = `
CREATE FUNCTION public.engram_extraction_fail(p_run uuid, p_error text, p_failure text, p_stats jsonb) RETURNS boolean
  LANGUAGE sql AS $$ SELECT false $$;
`

const PENDING_WITHOUT_HELD = `
CREATE FUNCTION public.engram_extraction_pending(p_version text, p_limit integer, p_idle_seconds integer, p_now timestamp with time zone)
  RETURNS TABLE(anchor_item_id uuid, session_id text, anchor_kind text, occurred_at timestamp with time zone, failures integer,
                running_run_id uuid, running_started_at timestamp with time zone)
  LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, 0, NULL::uuid, NULL::timestamptz WHERE false $$;
`

const PENDING_WITH_HELD = `
CREATE FUNCTION public.engram_extraction_pending(p_version text, p_limit integer, p_idle_seconds integer, p_now timestamp with time zone)
  RETURNS TABLE(anchor_item_id uuid, session_id text, anchor_kind text, occurred_at timestamp with time zone, failures integer,
                held_failures integer, running_run_id uuid, running_started_at timestamp with time zone)
  LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, 0, 0, NULL::uuid, NULL::timestamptz WHERE false $$;
`

const CURRENT_FUNCTIONS = [
  'engram_extraction_fail(p_run uuid, p_error text, p_failure text, p_counted boolean, p_stats jsonb) -> boolean granted',
  'engram_extraction_pending(p_version text, p_limit integer, p_idle_seconds integer, p_now timestamp with time zone) -> ' +
    'TABLE(anchor_item_id uuid, session_id text, anchor_kind text, occurred_at timestamp with time zone, failures integer, ' +
    'held_failures integer, transient_failures integer, running_run_id uuid, running_started_at timestamp with time zone) granted',
]

describe.skipIf(!realPgImage)('re-applying schema.sql over earlier extraction function shapes', () => {
  let pg: RealPg
  let freshDump: string

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    freshDump = await pg.dumpSchema()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  const functions = async (): Promise<string[]> => {
    const out = await pg.psql(`
      SELECT p.proname || '(' || pg_get_function_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid) ||
             CASE WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN ' granted' ELSE ' not granted' END
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('engram_extraction_pending', 'engram_extraction_fail')
       ORDER BY 1;`)
    return out.split('\n').filter((line) => line !== '')
  }

  it.each([
    ['pending without held_failures', PENDING_WITHOUT_HELD],
    ['pending with held_failures', PENDING_WITH_HELD],
  ])(
    'converges from %s and the four-argument fail on the first apply, and changes nothing on the second',
    async (_name, earlierPending) => {
      await pg.psql(DROP_CURRENT + EARLIER_FAIL + earlierPending)
      const before = await functions()
      expect(before).toHaveLength(2)
      expect(before.join('\n')).not.toContain('transient_failures')
      expect(before.join('\n')).not.toContain('p_counted')

      await pg.applySchema()
      expect(await functions()).toEqual(CURRENT_FUNCTIONS)
      const dumpOnce = await pg.dumpSchema()
      expect(dumpOnce).toBe(freshDump)

      await pg.applySchema()
      expect(await functions()).toEqual(CURRENT_FUNCTIONS)
      expect(await pg.dumpSchema()).toBe(dumpOnce)
    },
    TEST_TIMEOUT_MS,
  )
})
