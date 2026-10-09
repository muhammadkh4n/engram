/**
 * The access path of engram_item_candidates' vector legs, read from the plans
 * engram_item_candidates_explain returns on real Postgres, over 2000 visible
 * synthetic rows:
 * - the exact branch never touches the HNSW index and sorts under its top
 *   Limit, and that Limit is costed at p_k: the USING value reached the
 *   planner as a constant, where a generic plan would cost a parameter LIMIT
 *   at a tenth of the rows;
 * - the HNSW branch scans the HNSW index inside its CTE;
 * - the threshold is read from engram_item_access_settings, and a small
 *   filtered set takes the exact path;
 * - a filtered HNSW scan applies the filter before its cap and returns every
 *   matching row;
 * - the settings the HNSW branch changes are back to the caller's values
 *   after the call;
 * - the lexical leg finds its terms through idx_items_fts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type PsqlSession, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 60_000

const DIMS = 1536
const ROWS = 2000
const BASE_TIME = '2026-02-03T04:00:00Z'
const HNSW_INDEX = 'idx_items_embedding_hnsw'
const FTS_INDEX = 'idx_items_fts'

interface PlanNode {
  'Node Type': string
  'Plan Rows': number
  'Index Name'?: string
  'Subplan Name'?: string
  Plans?: PlanNode[]
}

interface ExplainRow {
  leg: string
  path: string | null
  filteredRows: number | null
  plan: Array<{ Plan: PlanNode }>
}

interface CandidateRow {
  itemId: string
  leg: string
  path: string | null
}

/** A unit vector `angle` radians away from axis 0, toward axis 1, as SQL. */
function vec(angle: number): string {
  return `(ARRAY[cos(${angle}), sin(${angle})]::real[] || array_fill(0::real, ARRAY[${DIMS - 2}]))::public.vector`
}

/** Row n (1-based) occurred n minutes after BASE_TIME, so p_as_of at minute n keeps rows 1..n. */
function asOf(minutes: number): string {
  return `(timestamptz '${BASE_TIME}' + interval '${minutes} minutes')`
}

function rowId(n: number): string {
  return `01950000-0000-7000-8000-${String(n).padStart(12, '0')}`
}

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)]
}

function usesIndex(node: PlanNode, index: string): boolean {
  return nodes(node).some((n) => n['Index Name'] === index)
}

describe.skipIf(!realPgImage)('the access path of engram_item_candidates on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
    await pg.psql(`
      INSERT INTO public.memory_items (id, class, kind, speaker, trust, content, search_text, embedding, embedding_model,
                                       occurred_at, source)
      SELECT ('01950000-0000-7000-8000-' || lpad(g::text, 12, '0'))::uuid, 'document_section', 'note', 'artifact', 1,
             'tst access note ' || g, 'tst access note ' || g,
             (ARRAY[cos(g * 0.0007), sin(g * 0.0007)]::real[] || array_fill(0::real, ARRAY[${DIMS - 2}]))::public.vector,
             'tst-embedder', timestamptz '${BASE_TIME}' + g * interval '1 minute', '{"type": "vault"}'::jsonb
        FROM generate_series(1, ${ROWS}) AS g;
      ANALYZE public.memory_items;
    `)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  function named(args: Record<string, string>): string {
    return Object.entries(args)
      .map(([name, value]) => `${name} => ${value}`)
      .join(', ')
  }

  async function explain(args: Record<string, string>): Promise<ExplainRow[]> {
    const out = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(json_agg(json_build_object('leg', e.leg, 'path', e.path, 'filteredRows', e.filtered_rows,
                'plan', e.plan) ORDER BY e.ord), '[]'::json)
         FROM public.engram_item_candidates_explain(${named(args)}) WITH ORDINALITY AS e(leg, path, filtered_rows, plan, ord);`,
    )
    return JSON.parse(out) as ExplainRow[]
  }

  function candidatesSql(args: Record<string, string>): string {
    return `SELECT coalesce(json_agg(json_build_object('itemId', c.item_id, 'leg', c.leg, 'path', c.path) ORDER BY c.ord), '[]'::json)
              FROM public.engram_item_candidates(${named(args)}) WITH ORDINALITY AS c(item_id, leg, rank, raw_score, path, ord);`
  }

  async function candidates(args: Record<string, string>): Promise<CandidateRow[]> {
    return JSON.parse(await pg.psqlAs('service_role', candidatesSql(args))) as CandidateRow[]
  }

  function onlyPlan(rows: readonly ExplainRow[], leg: string): ExplainRow {
    const legRows = rows.filter((r) => r.leg === leg)
    expect(legRows).toHaveLength(1)
    return legRows[0]
  }

  it(
    'plans the exact branch with no HNSW node, a Sort under the top Limit, and that Limit costed at p_k',
    async () => {
      const row = onlyPlan(await explain({ p_embedding: vec(0.4), p_k: '50', p_force_path: "'exact'" }), 'vector')
      const top = row.plan[0].Plan

      expect(row.path).toBe('exact')
      expect(row.filteredRows).toBe(ROWS)
      expect(usesIndex(top, HNSW_INDEX)).toBe(false)
      expect(top['Node Type']).toBe('Limit')
      expect((top.Plans ?? []).map((n) => n['Node Type'])).toContain('Sort')
      // A parameter LIMIT in a generic plan is costed at a tenth of the input: 200 here.
      expect(top['Plan Rows']).toBe(50)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'plans the HNSW branch as an Index Scan on the HNSW index inside its CTE',
    async () => {
      const row = onlyPlan(await explain({ p_embedding: vec(0.4), p_k: '50', p_force_path: "'hnsw'" }), 'vector')
      const cte = nodes(row.plan[0].Plan).find((n) => n['Subplan Name'] === 'CTE relaxed')

      expect(row.path).toBe('hnsw')
      expect(cte).toBeDefined()
      const scans = nodes(cte as PlanNode).filter((n) => n['Index Name'] === HNSW_INDEX)
      expect(scans.map((n) => n['Node Type'])).toEqual(['Index Scan'])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'switches path one row past exact_max_rows, and takes the exact path on a small filtered set',
    async () => {
      const threshold = Number(await pg.psql('SELECT exact_max_rows FROM public.engram_item_access_settings();'))
      const paths = await pg.psql(
        `SELECT public.engram_item_access_path(${threshold}::bigint) || ',' || public.engram_item_access_path(${threshold + 1}::bigint);`,
      )
      expect(paths).toBe('exact,hnsw')

      const small = await candidates({ p_embedding: vec(0.4), p_as_of: asOf(100), p_k: '50' })
      expect(small).toHaveLength(50)
      expect(new Set(small.map((r) => r.path))).toEqual(new Set(['exact']))
      const plan = onlyPlan(await explain({ p_embedding: vec(0.4), p_as_of: asOf(100), p_k: '50' }), 'vector')
      expect(plan.filteredRows).toBe(100)
      expect(plan.path).toBe('exact')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'returns exactly the 3 rows a filter admits on the HNSW branch with p_k 10',
    async () => {
      const rows = await candidates({ p_embedding: vec(0.4), p_as_of: asOf(3), p_k: '10', p_force_path: "'hnsw'" })

      expect(rows.map((r) => r.itemId).sort()).toEqual([rowId(1), rowId(2), rowId(3)])
      expect(rows.map((r) => r.path)).toEqual(['hnsw', 'hnsw', 'hnsw'])
    },
    TEST_TIMEOUT_MS,
  )

  describe('the caller session after an HNSW call', () => {
    let session: PsqlSession

    beforeAll(async () => {
      session = await pg.session()
      // The hnsw.* settings exist once pgvector's library is loaded in the session.
      await session.run("SELECT '[1,0]'::public.vector;")
      await session.run('SET ROLE service_role;')
    }, TEST_TIMEOUT_MS)

    afterAll(async () => {
      await session?.close()
    }, TEST_TIMEOUT_MS)

    async function settings(): Promise<string> {
      return session.run("SELECT current_setting('enable_seqscan') || ',' || current_setting('hnsw.iterative_scan');")
    }

    async function hnswCall(): Promise<void> {
      const rows = JSON.parse(
        await session.run(candidatesSql({ p_embedding: vec(0.4), p_k: '10', p_force_path: "'hnsw'" })),
      ) as CandidateRow[]
      expect(rows.map((r) => r.path)).toEqual(Array(10).fill('hnsw'))
    }

    it(
      'keeps the default settings',
      async () => {
        expect(await settings()).toBe('on,off')
        await hnswCall()
        expect(await settings()).toBe('on,off')
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "keeps a value the caller set",
      async () => {
        await session.run('SET hnsw.iterative_scan = strict_order;')
        expect(await settings()).toBe('on,strict_order')
        await hnswCall()
        expect(await settings()).toBe('on,strict_order')
      },
      TEST_TIMEOUT_MS,
    )
  })

  it(
    'finds the lexical leg candidates through idx_items_fts',
    async () => {
      const row = onlyPlan(await explain({ p_terms: "ARRAY['note 1234']::text[]", p_k: '10' }), 'bm25')

      expect(usesIndex(row.plan[0].Plan, FTS_INDEX)).toBe(true)
      const hits = await candidates({ p_terms: "ARRAY['note 1234']::text[]", p_k: '10' })
      expect(hits.map((r) => r.itemId)).toEqual([rowId(1234)])
    },
    TEST_TIMEOUT_MS,
  )
})
