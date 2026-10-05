/**
 * Re-applying schema.sql converges a database whose memory_items predates the
 * embedding attempt and claim columns, their constraints, the version_of
 * constraint, the current pending-embedding predicate and the claiming RPC
 * signatures. CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS leave
 * an existing table and index as they are, so each of these must arrive by
 * its own idempotent statement:
 * - the database is brought to the earlier shape (no embedding_attempts,
 *   embedding_error or claim columns, no memory_items_version_of_check or
 *   claim check, the index without the attempts clause, the pending read and
 *   the failure record without a claimant) and holds an item;
 * - two applies then exit 0, add the columns and the three constraints,
 *   rebuild the index with the attempts clause, drop the signatures without a
 *   claimant, keep the item pending, and the second apply changes nothing in
 *   the schema dump.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 120_000
const ITEM_KEY = 'schema-upgrade:existing'

const EARLIER_SHAPE = `
DROP INDEX public.idx_items_pending_embedding;
ALTER TABLE public.memory_items DROP CONSTRAINT memory_items_version_of_check;
ALTER TABLE public.memory_items DROP CONSTRAINT memory_items_embedding_claim_check;
ALTER TABLE public.memory_items DROP COLUMN embedding_error, DROP COLUMN embedding_attempts,
  DROP COLUMN embedding_claimed_by, DROP COLUMN embedding_claimed_until;
DROP FUNCTION public.engram_items_pending_embedding(integer, uuid);
DROP FUNCTION public.engram_items_renew_embedding_claims(uuid[], uuid);
DROP FUNCTION public.engram_items_record_embedding_failures(jsonb, uuid);
CREATE FUNCTION public.engram_items_pending_embedding(p_limit integer DEFAULT 32) RETURNS TABLE(id uuid, search_text text)
  LANGUAGE sql STABLE AS 'SELECT NULL::uuid, NULL::text WHERE false';
CREATE FUNCTION public.engram_items_record_embedding_failures(p_rows jsonb) RETURNS integer
  LANGUAGE sql AS 'SELECT 0';
CREATE INDEX idx_items_pending_embedding ON public.memory_items USING btree (created_at, id)
  WHERE (embedding IS NULL AND forgotten_at IS NULL AND NOT (class = 'utterance' AND speaker = 'assistant')
         AND class NOT IN ('session_index', 'legacy'));
`

describe.skipIf(!realPgImage)('re-applying schema.sql over an earlier memory_items', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(EARLIER_SHAPE)
    await pg.psqlAs(
      'service_role',
      `SELECT count(*) FROM public.engram_insert_items(jsonb_build_array(jsonb_build_object(
         'class', 'artifact', 'kind', 'ledger_decision', 'speaker', 'artifact', 'trust', 1,
         'content', 'Keep the sample cache at 5 minutes.', 'search_text', 'Keep the sample cache at 5 minutes.',
         'occurred_at', '2026-01-05T09:00:00Z',
         'source', jsonb_build_object('type', 'ledger', 'event_key', '${ITEM_KEY}', 'version_of', 'ledger-decision:sample-plan:cache'))));`,
    )
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  const shape = (): Promise<string> =>
    pg.psql(`
      SELECT string_agg(line, E'\\n' ORDER BY line) FROM (
        SELECT 'column ' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, 'none') AS line
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'memory_items'
           AND column_name IN ('embedding_attempts', 'embedding_error', 'embedding_claimed_by', 'embedding_claimed_until')
        UNION ALL
        SELECT 'constraint ' || conname
          FROM pg_constraint
         WHERE conrelid = 'public.memory_items'::regclass
           AND conname IN ('memory_items_version_of_check', 'memory_items_embedding_attempts_check',
                           'memory_items_embedding_claim_check')
        UNION ALL
        SELECT 'index ' || pg_get_expr(x.indpred, x.indrelid)
          FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
         WHERE c.relname = 'idx_items_pending_embedding'
        UNION ALL
        SELECT 'function ' || p.oid::regprocedure::text
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('engram_items_pending_embedding', 'engram_items_renew_embedding_claims',
                             'engram_items_record_embedding_failures')
      ) s;`)

  it(
    'starts without the columns, the constraints or the attempts clause',
    async () => {
      const before = await shape()
      expect(before).not.toContain('column ')
      expect(before).not.toContain('constraint ')
      expect(before).not.toContain('embedding_attempts')
      expect(before).toContain('function engram_items_pending_embedding(integer)')
      expect(before).toContain('function engram_items_record_embedding_failures(jsonb)')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'adds them on the first apply, changes nothing on the second, and keeps the existing item pending',
    async () => {
      await pg.applySchema()
      const once = await shape()
      expect(once.split('\n').filter((l) => !l.startsWith('index '))).toEqual([
        'column embedding_attempts smallint NO 0',
        'column embedding_claimed_by uuid YES none',
        'column embedding_claimed_until timestamp with time zone YES none',
        'column embedding_error text YES none',
        'constraint memory_items_embedding_attempts_check',
        'constraint memory_items_embedding_claim_check',
        'constraint memory_items_version_of_check',
        'function engram_items_pending_embedding(integer,uuid)',
        'function engram_items_record_embedding_failures(jsonb,uuid)',
        'function engram_items_renew_embedding_claims(uuid[],uuid)',
      ])
      expect(once).toMatch(/^index .*\(embedding_attempts < 5\)/m)
      const dumpOnce = await pg.dumpSchema()

      await pg.applySchema()
      expect(await shape()).toBe(once)
      expect(await pg.dumpSchema()).toBe(dumpOnce)

      expect(
        await pg.psql(
          `SELECT embedding_attempts FROM public.memory_items WHERE source ->> 'event_key' = '${ITEM_KEY}';`,
        ),
      ).toBe('0')
      expect(
        await pg.psqlAs(
          'service_role',
          `SELECT count(*) FROM public.engram_items_pending_embedding(256, gen_random_uuid()) p
             JOIN public.memory_items i ON i.id = p.id
            WHERE i.source ->> 'event_key' = '${ITEM_KEY}';`,
        ),
      ).toBe('1')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'refuses a version_of over 512 characters by its own constraint',
    async () => {
      const out = await pg
        .psqlAs(
          'service_role',
          `SELECT count(*) FROM public.engram_insert_items(jsonb_build_array(jsonb_build_object(
             'class', 'artifact', 'kind', 'ledger_decision', 'speaker', 'artifact', 'trust', 1,
             'content', 'A sample decision.', 'search_text', 'A sample decision.', 'occurred_at', '2026-01-05T09:00:00Z',
             'source', jsonb_build_object('type', 'ledger', 'event_key', 'schema-upgrade:long', 'version_of', repeat('v', 513)))));`,
        )
        .then(
          () => 'accepted',
          (err: unknown) => String(err),
        )
      expect(out).toContain('memory_items_version_of_check')
    },
    TEST_TIMEOUT_MS,
  )
})
