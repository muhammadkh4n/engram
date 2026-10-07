/**
 * Digest tombstones on real Postgres. One forgotten and one live digest share
 * their text and their embedding, so every read path matches both and must
 * return the live one only:
 * - the SQL recall functions, the pre-recall-RPC match functions and the
 *   BM25 match;
 * - the PostgREST store reads, through a real PostgREST.
 * Episodes and semantic rows get the same pair for the session, consolidation
 * and timeline reads. A second apply of schema.sql and bm25.sql rebuilds no
 * index, and an install whose idx_digests_bm25 predates the tombstone has it
 * rebuilt once with the predicate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgRestStorageAdapter } from '../../src/adapter.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const TERM = 'zephyrquill'
const SESSION = 'tst-digest-session'
const TOPIC = 'tst-digest-topic'

const LIVE_DIGEST = '01920000-0000-7000-8000-00000000d001'
const GONE_DIGEST = '01920000-0000-7000-8000-00000000d002'
const LIVE_EPISODE = '01920000-0000-7000-8000-00000000e001'
const GONE_EPISODE = '01920000-0000-7000-8000-00000000e002'
const LIVE_FACT = '01920000-0000-7000-8000-00000000f001'
const GONE_FACT = '01920000-0000-7000-8000-00000000f002'

const UNIT = `('[1' || repeat(',0', 1535) || ']')::public.vector`
const PAIR = [LIVE_DIGEST, GONE_DIGEST]

/** Ids from `output` (one per line, first column) that belong to `among`. */
function idsAmong(output: string, among: readonly string[]): string[] {
  return output
    .split('\n')
    .map((line) => line.split('|')[0]!.trim())
    .filter((id) => among.includes(id))
    .sort()
}

async function indexOids(pg: RealPg): Promise<string> {
  return pg.psql(
    `SELECT c.relname || '|' || c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'i' ORDER BY c.relname`,
  )
}

describe.skipIf(!realPgImage)('forgotten digests on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: Boolean(postgrestImage) })
    await pg.applySchema()
    await pg.psql(`
      INSERT INTO public.memories (id, type) VALUES
        ('${LIVE_DIGEST}', 'digest'), ('${GONE_DIGEST}', 'digest'),
        ('${LIVE_EPISODE}', 'episode'), ('${GONE_EPISODE}', 'episode'),
        ('${LIVE_FACT}', 'semantic'), ('${GONE_FACT}', 'semantic');
      INSERT INTO public.memory_digests (id, session_id, summary, key_topics, embedding, episode_ids, created_at) VALUES
        ('${LIVE_DIGEST}', '${SESSION}', 'The ${TERM} relay restarts nightly.', ARRAY['relay'], ${UNIT},
          ARRAY['${LIVE_EPISODE}']::uuid[], now() - interval '1 hour'),
        ('${GONE_DIGEST}', '${SESSION}', 'The ${TERM} relay restarts nightly.', ARRAY['relay'], ${UNIT},
          ARRAY['${GONE_EPISODE}']::uuid[], now() - interval '1 hour');
      INSERT INTO public.memory_episodes (id, session_id, role, content, embedding) VALUES
        ('${LIVE_EPISODE}', '${SESSION}', 'user', 'The ${TERM} relay needs a restart.', ${UNIT}),
        ('${GONE_EPISODE}', '${SESSION}', 'user', 'The ${TERM} relay needs a restart.', ${UNIT});
      INSERT INTO public.memory_semantic (id, topic, content) VALUES
        ('${LIVE_FACT}', '${TOPIC}', 'The ${TERM} relay restarts nightly.'),
        ('${GONE_FACT}', '${TOPIC}', 'The ${TERM} relay restarts nightly.');
    `)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  it('engram_mark_forgotten tombstones a digest once', async () => {
    const mark = (type: string, id: string) =>
      pg.psqlAs('service_role', `SELECT public.engram_mark_forgotten('${type}', ARRAY['${id}']::uuid[])`)

    expect(await mark('digest', GONE_DIGEST)).toBe('1')
    expect(await mark('digest', GONE_DIGEST)).toBe('0')
    expect(await mark('episode', GONE_EPISODE)).toBe('1')
    expect(await mark('semantic', GONE_FACT)).toBe('1')
    expect(await pg.psql(`SELECT id FROM public.memory_digests WHERE forgotten_at IS NOT NULL`)).toBe(GONE_DIGEST)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['engram_hybrid_recall', `SELECT id FROM public.engram_hybrid_recall('${TERM}', ${UNIT}, 10, 1.0, 1.0, 60, NULL, false, true, false, false)`],
    ['engram_recall', `SELECT id FROM public.engram_recall(${UNIT}, NULL, 10, 0.0, false, true, false, false)`],
    ['engram_text_boost', `SELECT id FROM public.engram_text_boost('${TERM}', 10)`],
    ['engram_text_match', `SELECT id FROM public.engram_text_match(ARRAY['${TERM}'], 10)`],
    ['engram_vector_search', `SELECT id FROM public.engram_vector_search(${UNIT}, 10, NULL, NULL, ARRAY['digest'])`],
    ['match_digests', `SELECT id FROM public.match_digests((${UNIT})::text, 10, 0.0)`],
    ['engram_bm25_match', `SELECT id FROM public.engram_bm25_match(ARRAY['${TERM}'], 10)`],
  ])('%s returns the live digest only', async (name, sql) => {
    // match_digests runs as its caller, and the tier tables grant service_role
    // nothing here; the SECURITY DEFINER functions run as service_role.
    const out = name === 'match_digests' ? await pg.psql(sql) : await pg.psqlAs('service_role', sql)
    expect(idsAmong(out, PAIR)).toEqual([LIVE_DIGEST])
  }, TEST_TIMEOUT_MS)

  it('match_episodes returns the live episode only', async () => {
    const out = await pg.psql(`SELECT id FROM public.match_episodes((${UNIT})::text, 10, 0.0)`)
    expect(idsAmong(out, [LIVE_EPISODE, GONE_EPISODE])).toEqual([LIVE_EPISODE])
  }, TEST_TIMEOUT_MS)

  describe.skipIf(!postgrestImage)('through PostgREST', () => {
    let adapter: PostgRestStorageAdapter

    beforeAll(async () => {
      // On Supabase the default privileges give service_role the tier tables;
      // this database starts with no default privileges, so they are granted here.
      await pg.psql(`GRANT SELECT, INSERT, UPDATE ON public.memories, public.memory_episodes, public.memory_digests,
        public.memory_semantic, public.memory_procedural TO service_role`)
      const endpoint = await pg.startPostgrest()
      adapter = new PostgRestStorageAdapter({ url: endpoint.url, key: endpoint.serviceJwt })
      await adapter.initialize()
    }, SETUP_TIMEOUT_MS)

    it('the digest store reads return the live digest only', async () => {
      const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).filter((id) => PAIR.includes(id))

      expect(ids((await adapter.digests.search(TERM, { limit: 10 })).map((r) => r.item))).toEqual([LIVE_DIGEST])
      expect(ids(await adapter.digests.getBySession(SESSION))).toEqual([LIVE_DIGEST])
      expect(ids(await adapter.digests.getRecent(1))).toEqual([LIVE_DIGEST])
      expect(ids(await adapter.digests.getPendingFactExtraction(10, 3, new Date()))).toEqual([LIVE_DIGEST])
    }, TEST_TIMEOUT_MS)

    it('id lookups drop the forgotten digest unless asked for inactive rows', async () => {
      const gone = await adapter.getById(GONE_DIGEST, 'digest')
      const goneInactive = await adapter.getById(GONE_DIGEST, 'digest', { includeInactive: true })
      const live = await adapter.getById(LIVE_DIGEST, 'digest')

      expect(gone).toBeNull()
      expect(goneInactive).toMatchObject({ type: 'digest', data: { id: GONE_DIGEST } })
      expect(live).toMatchObject({ type: 'digest', data: { id: LIVE_DIGEST, sourceEpisodeIds: [LIVE_EPISODE] } })

      const lookup = PAIR.map((id) => ({ id, type: 'digest' as const }))
      expect((await adapter.getByIds(lookup)).map((m) => m.data.id)).toEqual([LIVE_DIGEST])
      expect((await adapter.getByIds(lookup, { includeInactive: true })).map((m) => m.data.id).sort()).toEqual(
        [...PAIR].sort(),
      )
    }, TEST_TIMEOUT_MS)

    it('the recall engine feed skips the forgotten digest and lists its tombstone', async () => {
      const scanned: string[] = []
      for await (const batch of adapter.scanEmbeddings({ tier: 'digest' })) {
        for (const row of batch) scanned.push(row.id)
      }
      expect(scanned.filter((id) => PAIR.includes(id))).toEqual([LIVE_DIGEST])

      const tombstones = await adapter.listTombstonesSince!(new Date(Date.now() - 3_600_000))
      expect(tombstones).toContainEqual({ id: GONE_DIGEST, type: 'digest' })
      expect(tombstones).not.toContainEqual({ id: LIVE_DIGEST, type: 'digest' })
    }, TEST_TIMEOUT_MS)

    it('episode session reads and the topic timeline skip forgotten rows', async () => {
      const episodeIds = (rows: Array<{ id: string }>) =>
        rows.map((r) => r.id).filter((id) => id === LIVE_EPISODE || id === GONE_EPISODE)

      expect(episodeIds(await adapter.episodes.getBySession(SESSION))).toEqual([LIVE_EPISODE])
      expect(episodeIds(await adapter.episodes.getUnconsolidated(SESSION))).toEqual([LIVE_EPISODE])
      expect((await adapter.semantic.getTopicTimeline(TOPIC)).map((m) => m.id)).toEqual([LIVE_FACT])
    }, TEST_TIMEOUT_MS)

    it('digests.markForgotten tombstones through PostgREST and counts only new tombstones', async () => {
      expect(await adapter.digests.markForgotten([LIVE_DIGEST, GONE_DIGEST])).toBe(1)
      expect(await adapter.digests.markForgotten([LIVE_DIGEST])).toBe(0)
      expect(await pg.psql(`SELECT count(*) FROM public.memory_digests WHERE forgotten_at IS NULL AND id IN ('${LIVE_DIGEST}', '${GONE_DIGEST}')`)).toBe('0')
    }, TEST_TIMEOUT_MS)
  })

  it('a second apply of schema.sql and bm25.sql rebuilds no index', async () => {
    await pg.applySchema()
    const before = await indexOids(pg)
    expect(before).toContain('idx_digests_forgotten|')

    await pg.applySchema()

    expect(await indexOids(pg)).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('upgrades an install without the digest tombstone: column added, BM25 index rebuilt once', async () => {
    await pg.psql(`
      DROP INDEX public.idx_digests_bm25;
      ALTER TABLE public.memory_digests DROP COLUMN forgotten_at CASCADE;
      CREATE INDEX idx_digests_bm25 ON public.memory_digests
        USING bm25 (summary) WITH (text_config = 'english', k1 = 1.2, b = 0.4);
    `)
    const predicate = () =>
      pg.psql(`SELECT coalesce(pg_get_expr(i.indpred, i.indrelid), 'none') FROM pg_index i
               WHERE i.indexrelid = 'public.idx_digests_bm25'::regclass`)
    expect(await predicate()).toBe('none')

    await pg.applySchema()
    const upgraded = await indexOids(pg)

    expect(await predicate()).toBe('(forgotten_at IS NULL)')
    expect(await pg.psql(`SELECT count(*) FROM public.memory_digests WHERE forgotten_at IS NULL AND id IN ('${LIVE_DIGEST}', '${GONE_DIGEST}')`)).toBe('2')
    expect(upgraded).toContain('idx_digests_forgotten|')

    await pg.applySchema()

    expect(await indexOids(pg)).toBe(upgraded)
  }, TEST_TIMEOUT_MS)
})
