/**
 * engram_item_candidates on real Postgres, called as service_role the way
 * PostgREST calls it, over synthetic rows:
 * - every visibility rule applies inside each leg before its cap: an
 *   excluded session takes its own rows and every item derived from its
 *   turns out of every leg, and the vector leg still fills p_k rows from what
 *   is left;
 * - p_as_of reads the store as it stood then: later rows are absent and an
 *   item retired after that time counts as live; forgotten rows never show;
 * - legacy rows only when p_classes names legacy, history kinds only with
 *   p_include_history, and the observation trust cap applies to every leg;
 * - the lexical leg matches a term as a phrase, so an identifier's parts
 *   alone do not match;
 * - the subject leg puts current items before superseded ones and, with
 *   p_project_id, that project's subjects first;
 * - the entity leg matches entities ignoring case, ranks items matching more
 *   of them first and applies visibility like every other leg;
 * - ties break on the id and the same call returns the same rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const DIMS = 1536
const BASE_TIME = Date.parse('2026-02-03T04:00:00Z')
const LEG_ORDER = ['vector', 'hyde', 'bm25', 'subject', 'entity'] as const

type Leg = (typeof LEG_ORDER)[number]

interface CandidateRow {
  itemId: string
  leg: Leg
  rank: number
  rawScore: number
  path: string | null
}

interface Item {
  id: string
  class: string
  kind: string
  speaker: string
  trust: number
  content: string
  occurredAt: string
  source: Record<string, unknown>
  sessionId?: string
  subjectId?: string
  embedding?: string
  lineage?: string[]
  standing?: boolean
}

type ItemOptions = Partial<Omit<Item, 'id' | 'class' | 'kind' | 'speaker' | 'content'>>

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `01950000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`
}

function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString()
}

function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function textArray(values: readonly string[]): string {
  return `ARRAY[${values.map(lit).join(', ')}]::text[]`
}

/** A unit vector `angle` radians away from axis 0, toward axis 1, as SQL. */
function vec(angle: number): string {
  return `(ARRAY[cos(${angle}), sin(${angle})]::real[] || array_fill(0::real, ARRAY[${DIMS - 2}]))::public.vector`
}

function item(cls: string, kind: string, speaker: string, trust: number, content: string, options: ItemOptions): Item {
  return {
    id: newId(),
    class: cls,
    kind,
    speaker,
    trust,
    content,
    occurredAt: at(0),
    source: { type: 'extraction' },
    ...options,
  }
}

function note(content: string, options: ItemOptions = {}): Item {
  return item('document_section', 'note', 'artifact', 1, content, { source: { type: 'vault' }, ...options })
}

function utterance(content: string, options: ItemOptions = {}): Item {
  return item('utterance', 'user_prompt', 'mk', 0, content, { source: { type: 'transcript' }, ...options })
}

function assistantTurn(content: string, options: ItemOptions = {}): Item {
  return item('utterance', 'assistant_turn', 'assistant', 3, content, { source: { type: 'transcript' }, ...options })
}

function commit(content: string, options: ItemOptions = {}): Item {
  return item('artifact', 'commit', 'artifact', 1, content, { source: { type: 'git' }, ...options })
}

function legacy(content: string, options: ItemOptions = {}): Item {
  const source = { type: 'legacy', table: 'memory_semantic', id: '01950000-0000-7000-8000-ffffffffffff' }
  return item('legacy', 'legacy_fact', 'system', 3, content, { source, ...options })
}

function statement(content: string, lineage: string[], options: ItemOptions = {}): Item {
  return item('mk_statement', 'ruling', 'mk', 0, content, { lineage, standing: false, ...options })
}

function observation(content: string, options: ItemOptions = {}): Item {
  return item('observation', 'fact', 'assistant', 3, content, options)
}

function valuesRow(i: Item): string {
  return `(${[
    lit(i.id),
    lit(i.class),
    lit(i.kind),
    lit(i.speaker),
    String(i.trust),
    i.sessionId ? lit(i.sessionId) : 'NULL',
    i.subjectId ? lit(i.subjectId) : 'NULL',
    lit(i.content),
    lit(i.content),
    i.embedding ?? 'NULL',
    i.embedding ? lit('tst-embedder') : 'NULL',
    `${lit(i.occurredAt)}::timestamptz`,
    `${lit(JSON.stringify(i.source))}::jsonb`,
    `ARRAY[${(i.lineage ?? []).map(lit).join(', ')}]::uuid[]`,
    i.standing === undefined ? 'NULL' : String(i.standing),
  ].join(', ')})`
}

function idsOf(rows: readonly CandidateRow[], leg: Leg): string[] {
  return rows.filter((r) => r.leg === leg).map((r) => r.itemId)
}

function legsHolding(rows: readonly CandidateRow[], id: string): Leg[] {
  return LEG_ORDER.filter((leg) => rows.some((r) => r.leg === leg && r.itemId === id))
}

describe.skipIf(!realPgImage)('engram_item_candidates on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  beforeEach(async () => {
    await pg.psql('TRUNCATE public.memory_items, public.memory_subjects CASCADE;')
  }, TEST_TIMEOUT_MS)

  async function insert(items: readonly Item[]): Promise<void> {
    await pg.psql(
      `INSERT INTO public.memory_items (id, class, kind, speaker, trust, session_id, subject_id, content, search_text,
         embedding, embedding_model, occurred_at, source, lineage, standing)
       VALUES ${items.map(valuesRow).join(',\n')};`,
    )
  }

  async function tagEntities(itemId: string, entities: ReadonlyArray<[entity: string, type: string]>): Promise<void> {
    await pg.psql(
      `INSERT INTO public.memory_item_entities (item_id, entity, entity_type)
       VALUES ${entities.map(([entity, type]) => `(${lit(itemId)}, ${lit(entity)}, ${lit(type)})`).join(', ')};`,
    )
  }

  async function subject(label: string, projectId?: string): Promise<string> {
    const id = newId()
    await pg.psql(
      `INSERT INTO public.memory_subjects (id, project_id, label) VALUES (${lit(id)}, ${projectId ? lit(projectId) : 'NULL'}, ${lit(label)});`,
    )
    return id
  }

  async function candidates(args: Record<string, string>): Promise<CandidateRow[]> {
    const named = Object.entries(args)
      .map(([name, value]) => `${name} => ${value}`)
      .join(', ')
    const out = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(json_agg(json_build_object('itemId', c.item_id, 'leg', c.leg, 'rank', c.rank,
                'rawScore', c.raw_score, 'path', c.path) ORDER BY c.ord), '[]'::json)
         FROM public.engram_item_candidates(${named}) WITH ORDINALITY AS c(item_id, leg, rank, raw_score, path, ord);`,
    )
    return JSON.parse(out) as CandidateRow[]
  }

  /** Runs a call that must fail and returns the verbose error, which carries the SQLSTATE. */
  async function refusal(args: string): Promise<string> {
    try {
      await pg.psqlAs('service_role', `\\set VERBOSITY verbose\nSELECT * FROM public.engram_item_candidates(${args});`)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('the call succeeded')
  }

  it(
    'drops an excluded session and every item derived from its turns from every leg, before each cap',
    async () => {
      const subjectId = await subject('quokka cadence')
      const visible = Array.from({ length: 60 }, (_, k) =>
        note(`quokka cadence note ${k}`, { embedding: vec(0.3 + 0.01 * k) }),
      )
      const nearer = Array.from({ length: 100 }, (_, k) =>
        note(`quokka cadence nearer note ${k}`, { sessionId: 'tst-drop-session', embedding: vec(0.001 + 0.002 * k) }),
      )
      const turn = utterance('Keep the quokka cadence weekly.', { sessionId: 'tst-drop-session' })
      const derived = statement('Keep the quokka cadence weekly.', [turn.id], {
        subjectId,
        sessionId: 'tst-keep-session',
        embedding: vec(0),
      })
      await insert([...visible, ...nearer, turn, derived])
      const args = { p_embedding: vec(0), p_terms: textArray(['weekly']), p_query: lit('what is the quokka cadence') }

      const everything = await candidates(args)
      expect(legsHolding(everything, derived.id)).toEqual(['vector', 'bm25', 'subject'])
      expect(legsHolding(everything, turn.id)).toEqual(['bm25'])
      expect(idsOf(everything, 'vector')).toEqual([derived.id, ...nearer.slice(0, 49).map((i) => i.id)])

      const excluded = await candidates({ ...args, p_exclude_session: lit('tst-drop-session') })
      expect(idsOf(excluded, 'vector')).toEqual(visible.slice(0, 50).map((i) => i.id))
      expect(legsHolding(excluded, derived.id)).toEqual([])
      const dropped = new Set([...nearer.map((i) => i.id), turn.id])
      expect(excluded.filter((r) => dropped.has(r.itemId))).toEqual([])
      expect(excluded.filter((r) => r.leg !== 'vector')).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'reads the store as of p_as_of: later rows absent, an item retired after it live, forgotten rows never',
    async () => {
      const before = note('larch before', { embedding: vec(0.1), occurredAt: at(0) })
      const later = note('larch after', { embedding: vec(0.11), occurredAt: at(10) })
      const retiredLate = note('larch retired late', { embedding: vec(0.12), occurredAt: at(0) })
      const retiredEarly = note('larch retired early', { embedding: vec(0.13), occurredAt: at(0) })
      const forgotten = note('larch forgotten', { embedding: vec(0.14), occurredAt: at(0) })
      await insert([before, later, retiredLate, retiredEarly, forgotten])
      await pg.psql(
        `UPDATE public.memory_items SET retired_at = ${lit(at(8))}::timestamptz, retired_reason = 'tst' WHERE id = ${lit(retiredLate.id)};
         UPDATE public.memory_items SET retired_at = ${lit(at(2))}::timestamptz, retired_reason = 'tst' WHERE id = ${lit(retiredEarly.id)};`,
      )
      await pg.psqlAs(
        'service_role',
        `SELECT count(*) FROM public.engram_forget_items(ARRAY[${lit(forgotten.id)}]::uuid[], 'tst');`,
      )
      const base = { p_embedding: vec(0), p_terms: textArray(['larch']) }
      const asOf = `${lit(at(5))}::timestamptz`

      const cases: Array<[Record<string, string>, Item[]]> = [
        [base, [before, later]],
        [{ ...base, p_as_of: asOf }, [before, retiredLate]],
        [{ ...base, p_as_of: asOf, p_include_history: 'true' }, [before, retiredLate, retiredEarly]],
        [{ ...base, p_include_history: 'true' }, [before, later, retiredLate, retiredEarly]],
      ]
      for (const [args, expected] of cases) {
        const rows = await candidates(args)
        expect(idsOf(rows, 'vector')).toEqual(expected.map((i) => i.id))
        expect(idsOf(rows, 'bm25').sort()).toEqual(expected.map((i) => i.id).sort())
        expect(rows.some((r) => r.itemId === forgotten.id)).toBe(false)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'shows legacy rows only when p_classes names legacy and history kinds only with p_include_history',
    async () => {
      const legacyRow = legacy('heron legacy fact', { embedding: vec(0.1) })
      const reply = assistantTurn('heron assistant reply', { embedding: vec(0.11) })
      const change = commit('heron commit message', { embedding: vec(0.12) })
      const plain = note('heron plain note', { embedding: vec(0.13) })
      await insert([legacyRow, reply, change, plain])

      expect(idsOf(await candidates({ p_embedding: vec(0) }), 'vector')).toEqual([plain.id])
      expect(idsOf(await candidates({ p_embedding: vec(0), p_classes: textArray(['legacy']) }), 'vector')).toEqual([
        legacyRow.id,
      ])
      expect(idsOf(await candidates({ p_embedding: vec(0), p_include_history: 'true' }), 'vector')).toEqual([
        reply.id,
        change.id,
        plain.id,
      ])
      const error = await refusal(`p_embedding => ${vec(0)}, p_classes => ${textArray(['session_index'])}`)
      expect(error).toContain('22023')
      expect(error).toContain('p_classes')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'leaves an observation above p_max_observation_trust out of every leg',
    async () => {
      const subjectId = await subject('heron policy')
      const evidenced = observation('heron policy holds weekly', {
        trust: 2,
        subjectId,
        embedding: vec(0.1),
        source: { type: 'extraction', evidence: [{ type: 'commit', ref: 'abc1234' }] },
      })
      const unevidenced = observation('heron policy holds daily', { subjectId, embedding: vec(0.11) })
      await insert([evidenced, unevidenced])
      const args = { p_embedding: vec(0), p_terms: textArray(['heron']), p_query: lit('the heron policy') }

      const uncapped = await candidates(args)
      expect(legsHolding(uncapped, evidenced.id)).toEqual(['vector', 'bm25', 'subject'])
      expect(legsHolding(uncapped, unevidenced.id)).toEqual(['vector', 'bm25', 'subject'])

      const capped = await candidates({ ...args, p_max_observation_trust: '2::smallint' })
      expect(legsHolding(capped, evidenced.id)).toEqual(['vector', 'bm25', 'subject'])
      expect(legsHolding(capped, unevidenced.id)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'matches a lexical term as a phrase, so a row holding only part of an identifier does not match',
    async () => {
      const first = note('the rollout of tst-1234 finished today')
      const second = note('tst-1234 waits on review')
      const partial = note('a tst work item was opened')
      const split = note('tst and 1234 appear apart here')
      await insert([first, second, partial, split])

      const rows = (await candidates({ p_terms: textArray(['tst-1234']) })).filter((r) => r.leg === 'bm25')
      expect(rows.map((r) => r.itemId).sort()).toEqual([first.id, second.id].sort())
      expect(rows.map((r) => r.rank)).toEqual([1, 2])
      for (const row of rows) {
        expect(row.rawScore).toBeGreaterThan(0)
        expect(row.path).toBeNull()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "returns a subject's current items before its superseded ones, newer first",
    async () => {
      const subjectId = await subject('release cadence')
      const olderCurrent = observation('release cadence is weekly for docs', { subjectId, occurredAt: at(1) })
      const replaced = observation('release cadence is biweekly', { subjectId, occurredAt: at(5) })
      const successor = observation('release cadence is monthly', { subjectId, occurredAt: at(6) })
      await insert([olderCurrent, replaced, successor])
      await pg.psqlAs(
        'service_role',
        `SELECT public.engram_supersede_item(${lit(replaced.id)}, ${lit(successor.id)});`,
      )

      const rows = (await candidates({ p_query: lit('what is our release cadence now') })).filter(
        (r) => r.leg === 'subject',
      )
      expect(rows.map((r) => r.itemId)).toEqual([successor.id, olderCurrent.id, replaced.id])
      expect(rows.map((r) => r.rawScore)).toEqual([2, 2, 2])
      expect(rows.map((r) => r.rank)).toEqual([1, 2, 3])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "puts p_project_id's subjects first, then subjects whose labels hold more lexemes",
    async () => {
      const wide = await subject('deploy window policy', 'tst-alpha')
      const narrow = await subject('deploy window', 'tst-beta')
      const wideItem = observation('deploys wait for the window policy', { subjectId: wide })
      const narrowItem = observation('deploys wait for the window', { subjectId: narrow })
      await insert([wideItem, narrowItem])
      const query = lit('the deploy window policy for staging')

      const plain = (await candidates({ p_query: query })).filter((r) => r.leg === 'subject')
      expect(plain.map((r) => r.itemId)).toEqual([wideItem.id, narrowItem.id])
      expect(plain.map((r) => r.rawScore)).toEqual([3, 2])

      const scoped = (await candidates({ p_query: query, p_project_id: lit('tst-beta') })).filter(
        (r) => r.leg === 'subject',
      )
      expect(scoped.map((r) => r.itemId)).toEqual([narrowItem.id, wideItem.id])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'ranks rows with the same embedding by id and returns identical rows on a repeated call',
    async () => {
      const subjectId = await subject('twin rows')
      const lower = observation('twin rows share one text', { subjectId, embedding: vec(0.2) })
      const higher = observation('twin rows share one text', { subjectId, embedding: vec(0.2) })
      await insert([higher, lower])
      const args = {
        p_embedding: vec(0),
        p_hyde_embedding: vec(0.05),
        p_terms: textArray(['twin']),
        p_query: lit('twin rows'),
      }

      const first = await candidates(args)
      for (const leg of LEG_ORDER.slice(0, 4)) expect(idsOf(first, leg)).toEqual([lower.id, higher.id])
      expect(first.map((r) => r.leg)).toEqual(['vector', 'vector', 'hyde', 'hyde', 'bm25', 'bm25', 'subject', 'subject'])
      expect(first.filter((r) => r.leg === 'vector' || r.leg === 'hyde').map((r) => r.path)).toEqual([
        'exact',
        'exact',
        'exact',
        'exact',
      ])
      expect(first.find((r) => r.leg === 'vector')!.rawScore).toBeCloseTo(Math.cos(0.2), 5)
      expect(await candidates(args)).toEqual(first)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'returns items by entity, ignoring case, more matched entities first, with visibility applied',
    async () => {
      const path = 'packages/tst/src/osprey.ts'
      const both = note('osprey ticket and path', { occurredAt: at(1) })
      const pathOnly = note('osprey path only', { occurredAt: at(5) })
      const longerKey = note('osprey longer ticket key', { occurredAt: at(6) })
      const oldRow = legacy('osprey legacy ticket', { occurredAt: at(7) })
      await insert([both, pathOnly, longerKey, oldRow])
      await tagEntities(both.id, [['TST-42', 'ticket'], [path, 'path']])
      await tagEntities(pathOnly.id, [[path, 'path']])
      await tagEntities(longerKey.id, [['TST-421', 'ticket']])
      await tagEntities(oldRow.id, [['TST-42', 'ticket']])

      const ticket = await candidates({ p_entities: textArray(['tst-42']) })
      expect(ticket).toEqual([{ itemId: both.id, leg: 'entity', rank: 1, rawScore: 1, path: null }])

      const two = await candidates({ p_entities: textArray(['tst-42', path.toUpperCase()]) })
      expect(idsOf(two, 'entity')).toEqual([both.id, pathOnly.id])
      expect(two.map((r) => r.rawScore)).toEqual([2, 1])

      const withLegacy = await candidates({ p_entities: textArray(['TST-42']), p_classes: textArray(['document_section', 'legacy']) })
      expect(idsOf(withLegacy, 'entity')).toEqual([oldRow.id, both.id])

      const none = await candidates({ p_entities: "'{}'::text[]", p_query: lit('nothing to match here') })
      expect(none).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  it.each([
    ['p_k', 'p_k => 0'],
    ['p_k', 'p_k => 201'],
    ['p_classes', "p_classes => '{}'::text[]"],
    ['p_classes', "p_classes => ARRAY['nonsense']"],
    ['p_kinds', "p_kinds => ARRAY['nonsense']"],
    ['p_kinds', "p_kinds => ARRAY['commit']"],
    ['p_kinds', "p_kinds => ARRAY['plan_ledger_log']"],
    ['p_kinds', "p_kinds => ARRAY['legacy_fact']"],
    ['p_force_path', "p_force_path => 'seq'"],
    ['p_query', "p_query => repeat('a', 4001)"],
    ['p_max_observation_trust', 'p_max_observation_trust => 4::smallint'],
    ['p_embedding', "p_embedding => '[1,0,0]'::public.vector"],
    ['p_hyde_embedding', "p_hyde_embedding => '[1,0,0]'::public.vector"],
    ['p_entities', 'p_entities => ARRAY[NULL]::text[]'],
  ])(
    'refuses %s (%s) as an invalid parameter, naming it',
    async (name, args) => {
      const error = await refusal(args)
      expect(error).toContain('22023')
      expect(error).toContain(name)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'accepts history kinds with p_include_history and legacy kinds with the legacy class',
    async () => {
      const change = commit('osprey commit message', { embedding: vec(0.1) })
      const legacyRow = legacy('osprey legacy fact', { embedding: vec(0.11) })
      await insert([change, legacyRow])
      const history = await candidates({
        p_embedding: vec(0),
        p_kinds: textArray(['commit']),
        p_include_history: 'true',
      })
      expect(idsOf(history, 'vector')).toEqual([change.id])
      const old = await candidates({
        p_embedding: vec(0),
        p_classes: textArray(['legacy']),
        p_kinds: textArray(['legacy_fact']),
      })
      expect(idsOf(old, 'vector')).toEqual([legacyRow.id])
    },
    TEST_TIMEOUT_MS,
  )
})
