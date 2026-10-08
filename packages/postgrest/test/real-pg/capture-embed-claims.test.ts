/**
 * Embedding claims through a real PostgREST in front of real Postgres, with
 * the service-role JWT. The pending read claims the rows it returns for its
 * claimant, so two workers never embed the same item side by side:
 * - two concurrent reads by different claimants return disjoint items; a
 *   read waits for a read in an open transaction and then takes only what
 *   that one left;
 * - a claimant reads its own claimed items again; another claimant does not
 *   see them until the claim lapses, at most 120 seconds after it was taken;
 * - a refusal is recorded unless another claimant holds a live claim on the
 *   item, so a pass whose claim lapsed and was taken over counts nothing;
 * - a renewal extends only the claimant's own claims on pending items.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_CLAIM_LEASE_SECONDS } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import {
  postgrestImage,
  realPgImage,
  startRealPg,
  waitUntilLockWait,
  type PostgrestEndpoint,
  type RealPg,
} from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

function jsonb(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`
}

function item(content: string): Record<string, unknown> {
  return {
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    trust: 0,
    content,
    search_text: content,
    occurred_at: '2026-01-05T09:00:00Z',
    source: { type: 'transcript', event_key: `capture-claims:${randomUUID()}` },
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('embedding claims through PostgREST on real Postgres', () => {
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

  /**
   * Inserts `count` items in one call and returns their ids in pending-read
   * order: one call stamps one created_at, so the read orders them by id.
   */
  async function insertItems(prefix: string, count: number): Promise<string[]> {
    const objects = Array.from({ length: count }, (_, i) => item(`${prefix} sample prompt ${i}`))
    const out = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(json_agg(r.id ORDER BY r.ord), '[]'::json) FROM public.engram_insert_items(${jsonb(objects)}) AS r;`,
    )
    return (JSON.parse(out) as string[]).sort()
  }

  /** Leaves every claim on `ids` lapsed, as if its lease had run out. */
  async function lapse(ids: readonly string[]): Promise<void> {
    await pg.psql(
      `UPDATE public.memory_items SET embedding_claimed_until = now() - interval '1 second'
        WHERE embedding_claimed_by IS NOT NULL AND id IN (${ids.map((id) => `'${id}'`).join(', ')});`,
    )
  }

  /** Takes every earlier item out of the pending set, so each test reads only its own items. */
  async function clearBacklog(): Promise<void> {
    await pg.psql(`UPDATE public.memory_items SET embedding_attempts = 5 WHERE embedding IS NULL;`)
  }

  /** The backend of a pending read other than `exceptPid`, once it has started. */
  async function readerPid(exceptPid: string): Promise<string> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const pid = await pg.psql(
        `SELECT pid FROM pg_stat_activity
          WHERE pid <> ${exceptPid} AND query LIKE '%engram_items_pending_embedding%' AND query NOT LIKE '%pg_stat_activity%'
          LIMIT 1;`,
      )
      if (pid !== '') return pid
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('the second pending read never started')
  }

  async function attempts(id: string): Promise<number> {
    return Number(await pg.psql(`SELECT embedding_attempts FROM public.memory_items WHERE id = '${id}';`))
  }

  it(
    'returns disjoint items to two concurrent reads, and the second read takes what the first left',
    async () => {
      await clearBacklog()
      const ids = await insertItems('disjoint', 40)
      const workerA = randomUUID()
      const workerB = randomUUID()

      const [a, b] = await Promise.all([store.pendingEmbeddings(32, workerA), store.pendingEmbeddings(32, workerB)])
      const aIds = a.map((p) => p.id)
      const bIds = b.map((p) => p.id)
      expect(aIds.filter((id) => bIds.includes(id))).toEqual([])
      expect(aIds.length + bIds.length).toBe(40)
      expect(new Set([...aIds, ...bIds])).toEqual(new Set(ids))
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'makes a read wait for a read in an open transaction, then take only what that one left',
    async () => {
      await clearBacklog()
      const ids = await insertItems('serialized', 10)
      const session = await pg.session()
      try {
        const sessionPid = (await session.run('SELECT pg_backend_pid();')).trim()
        await session.run(`BEGIN; SET LOCAL ROLE service_role;`)
        const held = (await session.run(`SELECT id FROM public.engram_items_pending_embedding(5, '${randomUUID()}');`))
          .trim()
          .split('\n')
        expect(held).toEqual(ids.slice(0, 5))

        const other = store.pendingEmbeddings(32, randomUUID())
        await waitUntilLockWait(pg, await readerPid(sessionPid))
        await session.run('COMMIT;')
        expect((await other).map((p) => p.id)).toEqual(ids.slice(5))
      } finally {
        await session.close()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'gives a claimant its own claimed items again, keeps them from another until the claim lapses, and claims for at most 120 seconds',
    async () => {
      await clearBacklog()
      const ids = await insertItems('lease', 3)
      const workerA = randomUUID()
      const workerB = randomUUID()

      expect((await store.pendingEmbeddings(32, workerA)).map((p) => p.id)).toEqual(ids)
      expect(EMBEDDING_CLAIM_LEASE_SECONDS).toBe(120)
      expect(
        await pg.psql(
          `SELECT bool_and(embedding_claimed_by = '${workerA}'
                           AND embedding_claimed_until > now()
                           AND embedding_claimed_until <= now() + interval '120 seconds')
             FROM public.memory_items WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')});`,
        ),
      ).toBe('t')
      expect((await store.pendingEmbeddings(32, workerB)).map((p) => p.id)).toEqual([])
      expect((await store.pendingEmbeddings(32, workerA)).map((p) => p.id)).toEqual(ids)

      await lapse(ids)
      expect((await store.pendingEmbeddings(32, workerB)).map((p) => p.id)).toEqual(ids)
      expect((await store.pendingEmbeddings(32, workerA)).map((p) => p.id)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'records a refusal unless another claimant holds a live claim on the item',
    async () => {
      await clearBacklog()
      const [refused] = (await insertItems('refused', 1)) as [string]
      const workerA = randomUUID()
      const workerB = randomUUID()
      await store.pendingEmbeddings(32, workerA)

      await expect(store.recordEmbeddingFailures([{ id: refused, error: '400 refused' }], workerB)).resolves.toBe(0)
      await expect(store.recordEmbeddingFailures([{ id: refused, error: '400 refused' }], workerA)).resolves.toBe(1)
      expect(await attempts(refused)).toBe(1)

      // A's claim lapses mid-pass and B takes the item over: only B's refusal counts.
      await lapse([refused])
      expect((await store.pendingEmbeddings(32, workerB)).map((p) => p.id)).toEqual([refused])
      await expect(store.recordEmbeddingFailures([{ id: refused, error: '400 refused' }], workerA)).resolves.toBe(0)
      await expect(store.recordEmbeddingFailures([{ id: refused, error: '400 refused' }], workerB)).resolves.toBe(1)
      expect(await attempts(refused)).toBe(2)

      // A lapsed claim nobody took over still lets its claimant record.
      await lapse([refused])
      await expect(store.recordEmbeddingFailures([{ id: refused, error: '400 refused' }], workerB)).resolves.toBe(1)
      expect(await attempts(refused)).toBe(3)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'renews only the claimant’s own claims on items still pending',
    async () => {
      await clearBacklog()
      const [mine, theirs, done] = (await insertItems('renew', 3)) as [string, string, string]
      const workerA = randomUUID()
      const workerB = randomUUID()
      await store.pendingEmbeddings(32, workerA)
      await pg.psql(
        `UPDATE public.memory_items SET embedding_claimed_by = '${workerB}' WHERE id = '${theirs}';`,
      )
      await store.setEmbeddings([{ id: done, embedding: Array.from({ length: 1536 }, () => 0.5), model: 'sample-embed:1536:v2' }])
      await lapse([mine, theirs, done])

      await expect(store.renewEmbeddingClaims([mine, theirs, done], workerA)).resolves.toBe(1)
      expect(
        await pg.psql(
          `SELECT id = '${mine}' FROM public.memory_items
            WHERE id IN ('${mine}', '${theirs}', '${done}') AND embedding_claimed_until > now();`,
        ),
      ).toBe('t')
      expect((await store.pendingEmbeddings(32, workerB)).map((p) => p.id)).toEqual([theirs])
      await expect(
        pg.psqlAs('service_role', `SELECT public.engram_items_renew_embedding_claims('{}'::uuid[], '${workerA}');`),
      ).rejects.toThrow('p_ids holds 0 ids, not 1 to 256')
    },
    TEST_TIMEOUT_MS,
  )
})
