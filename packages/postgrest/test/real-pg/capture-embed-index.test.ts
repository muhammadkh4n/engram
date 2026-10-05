/**
 * idx_items_pending_embedding holds only the rows engram_items_pending_embedding
 * can return. Assistant utterances and legacy rows are never embedded by the
 * worker, so with 5,000 of them and nothing eligible, the worker's idle call
 * plans on the index and reads no entry from it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type PsqlSession, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const BATCH = 500

/** One engram_insert_items call of BATCH generated items of one ineligible shape. */
function insertBatch(batch: number, shape: 'assistant' | 'legacy'): string {
  const fields =
    shape === 'assistant'
      ? `'class', 'utterance', 'kind', 'assistant_turn', 'speaker', 'assistant', 'trust', 3,
         'source', jsonb_build_object('type', 'transcript', 'event_key', 'embed-index:a:${batch}:' || g)`
      : `'class', 'legacy', 'kind', 'legacy_episode', 'speaker', 'mk', 'trust', 3,
         'source', jsonb_build_object('type', 'legacy', 'event_key', 'embed-index:l:${batch}:' || g)`
  return `SELECT count(*) FROM public.engram_insert_items((
            SELECT jsonb_agg(jsonb_build_object(${fields},
                     'content', 'Sample reply ' || g, 'search_text', 'Sample reply ' || g,
                     'occurred_at', '2026-01-05T09:00:00Z'))
              FROM generate_series(1, ${BATCH}) AS g));`
}

describe.skipIf(!realPgImage)('the pending-embedding index on real Postgres', () => {
  let pg: RealPg
  let session: PsqlSession

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    for (let batch = 0; batch < 10; batch++) {
      await pg.psqlAs('service_role', insertBatch(batch, batch < 9 ? 'assistant' : 'legacy'))
    }
    await pg.psql('ANALYZE public.memory_items;')
    session = await pg.session()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await session?.close()
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  const tuplesRead = (): Promise<number> =>
    session
      .run(`SELECT idx_tup_read FROM pg_stat_user_indexes WHERE indexrelname = 'idx_items_pending_embedding';`)
      .then((out) => Number(out.trim()))

  it(
    'reads no index entry for 5,000 ineligible rows and none eligible',
    async () => {
      expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE embedding IS NULL AND forgotten_at IS NULL;`)).toBe(
        '5000',
      )
      const plan = await pg.psql(
        `EXPLAIN SELECT i.id, i.search_text FROM public.memory_items i
          WHERE embedding IS NULL
            AND forgotten_at IS NULL
            AND embedding_attempts < 5
            AND NOT (class = 'utterance' AND speaker = 'assistant')
            AND class NOT IN ('session_index', 'legacy')
          ORDER BY i.created_at, i.id LIMIT 32;`,
      )
      expect(plan).toContain('idx_items_pending_embedding')

      const before = await tuplesRead()
      // The forced flush runs when this statement ends, so the next read sees its index reads.
      const returned = await session.run(
        `SELECT pg_stat_force_next_flush(), (SELECT count(*) FROM public.engram_items_pending_embedding(32));`,
      )
      expect(returned.trim()).toBe('|0')
      expect((await tuplesRead()) - before).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )
})
