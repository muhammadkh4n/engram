/**
 * The recall read side on real Postgres, called as service_role the way
 * PostgREST calls it, over synthetic rows:
 * - engram_recall_items follows supersession chains as of a time: a chain
 *   ends at its last live successor, a successor that occurred later than
 *   p_as_of does not count, forgetting a successor makes its predecessor
 *   current again, and a retired successor ends the chain with no current
 *   item; forgotten ids never come back; restatements and retirement are
 *   read as of p_as_of; end_excluded applies the candidate statement's
 *   excluded-session rule to the current item;
 * - engram_active_register_tokens gives each applies_to string of the
 *   register entries in force;
 * - the store version moves when a write commits, not before, and a second
 *   writer never waits on the first;
 * - engram_recall_item_states, engram_project_workspace and
 *   engram_recall_projects read what they name; anon may call none of them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { realPgImage, startRealPg, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const BASE_TIME = Date.parse('2026-02-03T04:00:00Z')

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
  context?: string
  lineage?: string[]
  standing?: boolean
}

interface ItemRow {
  id: string
  class: string
  kind: string
  session_id: string | null
  subject_label: string | null
  content_head: string
  content_length: number
  question: string | null
  search_head: string
  superseded_by: string | null
  retired: boolean
  restated: number
  source: Record<string, unknown>
  requested: boolean
  current_id: string | null
  chain: string
  end_excluded: boolean
}

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `01960000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`
}

function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString()
}

function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function uuidArray(ids: readonly string[]): string {
  return `ARRAY[${ids.map(lit).join(', ')}]::uuid[]`
}

function note(content: string, minute: number, options: Partial<Item> = {}): Item {
  return {
    id: newId(),
    class: 'document_section',
    kind: 'note',
    speaker: 'artifact',
    trust: 1,
    content,
    occurredAt: at(minute),
    source: { type: 'vault' },
    ...options,
  }
}

function utterance(content: string, minute: number, sessionId: string): Item {
  return {
    id: newId(),
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    trust: 0,
    content,
    occurredAt: at(minute),
    source: { type: 'transcript', session_id: sessionId, line: minute },
    sessionId,
  }
}

function registerEntry(registerId: string, status: string, appliesTo: unknown, minute: number): Item {
  return {
    id: newId(),
    class: 'artifact',
    kind: 'ruling_entry',
    speaker: 'artifact',
    trust: 1,
    content: `${registerId} entry`,
    occurredAt: at(minute),
    source: { type: 'register', id: registerId, status, applies_to: appliesTo },
  }
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
    i.context ? lit(i.context) : 'NULL',
    `${lit(i.occurredAt)}::timestamptz`,
    `${lit(JSON.stringify(i.source))}::jsonb`,
    `ARRAY[${(i.lineage ?? []).map(lit).join(', ')}]::uuid[]`,
    i.standing === undefined ? 'NULL' : String(i.standing),
  ].join(', ')})`
}

describe.skipIf(!realPgImage)('the recall read side on real Postgres', () => {
  let pg: RealPg

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  beforeEach(async () => {
    await pg.psql('TRUNCATE public.memory_items, public.memory_subjects, public.memory_projects CASCADE;')
  }, TEST_TIMEOUT_MS)

  async function insert(items: readonly Item[]): Promise<void> {
    await pg.psql(
      `INSERT INTO public.memory_items (id, class, kind, speaker, trust, session_id, subject_id, content, search_text,
         context, occurred_at, source, lineage, standing)
       VALUES ${items.map(valuesRow).join(',\n')};`,
    )
  }

  async function supersede(oldId: string, newId: string): Promise<void> {
    await pg.psql(`SELECT public.engram_supersede_item(${lit(oldId)}, ${lit(newId)});`)
  }

  async function recallItems(ids: readonly string[], asOf?: string, excludeSession?: string): Promise<ItemRow[]> {
    const args = [uuidArray(ids), asOf ? `${lit(asOf)}::timestamptz` : 'NULL', excludeSession ? lit(excludeSession) : 'NULL']
    const out = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(json_agg(to_jsonb(r) ORDER BY r.k), '[]'::json)
         FROM public.engram_recall_items(${args.join(', ')}) WITH ORDINALITY AS r(id, class, kind, speaker, trust,
              project_id, workspace_id, plan_slug, session_id, subject_label, content_head, content_length, question,
              search_head, occurred_at, superseded_by, retired, restated, source, requested, current_id, chain,
              end_excluded, k);`,
    )
    return JSON.parse(out) as ItemRow[]
  }

  async function tokens(asOf?: string): Promise<Array<[string, string]>> {
    const out = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(json_agg(json_build_array(t.register_id, t.token)), '[]'::json)
         FROM public.engram_active_register_tokens(${asOf ? `${lit(asOf)}::timestamptz` : ''}) AS t;`,
    )
    return JSON.parse(out) as Array<[string, string]>
  }

  async function version(): Promise<number> {
    return Number(await pg.psqlAs('service_role', 'SELECT public.engram_store_version();'))
  }

  describe('engram_recall_items', () => {
    it(
      'resolves a chain to its last live successor and returns that end as an unrequested row',
      async () => {
        const [a, b, c] = [note('tst chain one', 0), note('tst chain two', 1), note('tst chain three', 2)]
        await insert([a, b, c])
        await supersede(a.id, b.id)
        await supersede(b.id, c.id)

        const rows = await recallItems([a.id])
        expect(rows.map((r) => [r.id, r.requested, r.chain, r.current_id])).toEqual([
          [a.id, true, 'superseded', c.id],
          [c.id, false, 'current', c.id],
        ])
        expect(rows[0]!.superseded_by).toBe(b.id)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'resolves a chain of 25 versions to the last one, as a vault section edited 24 times becomes',
      async () => {
        const versions = Array.from({ length: 25 }, (_, k) => note(`tst version ${k}`, k))
        await insert(versions)
        for (let k = 0; k < versions.length - 1; k += 1) await supersede(versions[k]!.id, versions[k + 1]!.id)

        const last = versions[24]!
        const rows = await recallItems([versions[0]!.id])
        expect(rows.map((r) => [r.id, r.chain, r.current_id])).toEqual([
          [versions[0]!.id, 'superseded', last.id],
          [last.id, 'current', last.id],
        ])
        expect(rows[1]!.superseded_by).toBeNull()
        const asOf = await recallItems([versions[0]!.id], at(22.5))
        expect(asOf.map((r) => [r.id, r.chain])).toEqual([
          [versions[0]!.id, 'superseded'],
          [versions[22]!.id, 'current'],
        ])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'resolves 500 requested ids along one 600-version chain in one call, each to the version current as of the call',
      async () => {
        const versions = Array.from({ length: 600 }, (_, k) => note(`tst long chain ${k}`, k))
        await insert(versions)
        await pg.psql(
          versions
            .slice(1)
            .map((v, k) => `SELECT public.engram_supersede_item(${lit(versions[k]!.id)}, ${lit(v.id)});`)
            .join('\n'),
        )
        const last = versions[599]!
        const requested = versions.slice(0, 500).map((v) => v.id)

        const rows = await recallItems(requested)
        expect(rows.map((r) => [r.id, r.requested, r.chain, r.current_id])).toEqual([
          ...requested.map((id) => [id, true, 'superseded', last.id]),
          [last.id, false, 'current', last.id],
        ])

        const cut = versions[299]!
        const asOf = await recallItems(requested, at(299.5))
        expect(asOf.map((r) => [r.id, r.chain, r.current_id])).toEqual(
          requested.map((id, k) => (k < 299 ? [id, 'superseded', cut.id] : [id, 'current', id])),
        )
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'fails rather than loops on a chain whose successor did not occur later, and only on a hop it takes',
      async () => {
        const [a, b, c] = [note('tst loop one', 0), note('tst loop two', 1), note('tst loop free', 2)]
        const [d, e] = [note('tst same time one', 5), note('tst same time two', 5)]
        await insert([a, b, c, d, e])
        await supersede(a.id, b.id)
        // Every write path refuses these pointers, so they are stored with triggers off; valid_to keeps the row CHECK.
        await pg.psql(`SET session_replication_role = replica;
          UPDATE public.memory_items SET superseded_by = ${lit(a.id)}, valid_to = occurred_at WHERE id = ${lit(b.id)};
          UPDATE public.memory_items SET superseded_by = ${lit(e.id)}, valid_to = occurred_at WHERE id = ${lit(d.id)};`)

        for (const ids of [[a.id], [b.id], [c.id, a.id], [d.id]]) {
          await expect(recallItems(ids)).rejects.toThrow(/a supersession chain names a successor that did not occur later/)
        }
        expect((await recallItems([c.id, e.id])).map((r) => [r.id, r.chain])).toEqual([
          [c.id, 'current'],
          [e.id, 'current'],
        ])
        expect((await recallItems([a.id], at(0.5))).map((r) => [r.id, r.chain, r.current_id])).toEqual([[a.id, 'current', a.id]])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'stops a chain at a successor that occurred after p_as_of',
      async () => {
        const [a, b, c] = [note('tst asof one', 0), note('tst asof two', 10), note('tst asof three', 20)]
        await insert([a, b, c])
        await supersede(a.id, b.id)
        await supersede(b.id, c.id)

        const rows = await recallItems([a.id], at(15))
        expect(rows.map((r) => [r.id, r.chain, r.current_id])).toEqual([
          [a.id, 'superseded', b.id],
          [b.id, 'current', b.id],
        ])
        const early = await recallItems([a.id], at(5))
        expect(early.map((r) => [r.id, r.chain, r.current_id])).toEqual([[a.id, 'current', a.id]])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'makes the predecessor current again when its successor is forgotten, and never returns a forgotten id',
      async () => {
        const [a, b, c] = [note('tst forget one', 0), note('tst forget two', 1), note('tst forget three', 2)]
        await insert([a, b, c])
        await supersede(a.id, b.id)
        await supersede(b.id, c.id)
        await pg.psql(`SELECT count(*) FROM public.engram_forget_items(${uuidArray([c.id])}, 'tst forget');`)

        const rows = await recallItems([a.id, c.id])
        expect(rows.map((r) => [r.id, r.chain, r.current_id])).toEqual([
          [a.id, 'superseded', b.id],
          [b.id, 'current', b.id],
        ])
        expect(rows.some((r) => r.id === c.id || r.current_id === c.id)).toBe(false)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'ends a chain at a retired successor with no current item, unless it was retired after p_as_of',
      async () => {
        const [a, b] = [note('tst retired one', 0), note('tst retired two', 1)]
        await insert([a, b])
        await supersede(a.id, b.id)
        await pg.psql(`SELECT count(*) FROM public.engram_retire_items(${uuidArray([b.id])}, 'tst retire');`)

        const rows = await recallItems([a.id])
        expect(rows.map((r) => [r.id, r.chain, r.current_id])).toEqual([[a.id, 'successor_retired', null]])

        // The retirement happened at the wall clock, long after the synthetic times.
        const before = await recallItems([a.id], at(5))
        expect(before.map((r) => [r.id, r.chain, r.current_id, r.retired])).toEqual([
          [a.id, 'superseded', b.id, false],
          [b.id, 'current', b.id, false],
        ])
        const retired = await recallItems([b.id])
        expect(retired.map((r) => [r.chain, r.retired])).toEqual([['current', true]])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'counts the restatements made at or before p_as_of',
      async () => {
        const a = note('tst restated', 0)
        const plain = note('tst never restated', 0)
        await insert([a, plain])
        await pg.psql(
          `UPDATE public.memory_items SET restated_at = ARRAY[${[at(1), at(2), at(30)].map((t) => `${lit(t)}::timestamptz`).join(', ')}]
            WHERE id = ${lit(a.id)};`,
        )

        expect((await recallItems([a.id], at(10)))[0]!.restated).toBe(2)
        expect((await recallItems([a.id]))[0]!.restated).toBe(3)
        expect((await recallItems([plain.id]))[0]!.restated).toBe(0)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'marks a current item of the excluded session, by its own session or a lineage item of it',
      async () => {
        const turn = utterance('Keep the tst cadence weekly.', 0, 'tst-excluded-session')
        const own = note('tst own session note', 1, { sessionId: 'tst-excluded-session' })
        const derived = note('tst derived note', 2, { sessionId: 'tst-other-session', lineage: [turn.id] })
        const other = note('tst other note', 3, { sessionId: 'tst-other-session' })
        const old = note('tst old note', 0)
        await insert([turn, own, derived, other, old])
        await supersede(old.id, own.id)

        const rows = await recallItems([own.id, derived.id, other.id, old.id], undefined, 'tst-excluded-session')
        const flag = new Map(rows.filter((r) => r.requested).map((r) => [r.id, r.end_excluded]))
        expect(flag.get(own.id)).toBe(true)
        expect(flag.get(derived.id)).toBe(true)
        expect(flag.get(other.id)).toBe(false)
        // The old note's current item is the excluded session's own note.
        expect(flag.get(old.id)).toBe(true)

        const unexcluded = await recallItems([own.id])
        expect(unexcluded[0]!.end_excluded).toBe(false)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'returns the requested rows once each, in the order asked, with heads of their texts and no embedding',
      async () => {
        const long = note(`tst ${'long '.repeat(3000)}`, 0, { context: 'tst question?' })
        const short = note('tst short', 1)
        await insert([long, short])

        const rows = await recallItems([short.id, long.id, short.id, '01960000-0000-7000-8000-ffffffffffff'])
        expect(rows.map((r) => r.id)).toEqual([short.id, long.id])
        const longRow = rows[1]!
        expect(longRow.content_head).toHaveLength(12000)
        expect(longRow.content_length).toBe(long.content.length)
        expect(longRow.search_head).toHaveLength(2000)
        expect(longRow.question).toBe('tst question?')
        expect(Object.keys(longRow)).not.toContain('embedding')
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'returns a long question as its last 2,000 characters, where it asks',
      async () => {
        const asked = note('tst answered', 0, { context: `${'background '.repeat(300)}so which one do we keep?` })
        await insert([asked])
        const [r] = await recallItems([asked.id])
        expect(r!.question).toHaveLength(2000)
        expect(r!.question!.endsWith('so which one do we keep?')).toBe(true)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'refuses a missing id list and more than 500 ids',
      async () => {
        await expect(pg.psqlAs('service_role', 'SELECT * FROM public.engram_recall_items(NULL);')).rejects.toThrow(
          /engram_recall_items: p_ids is required/,
        )
        await expect(
          pg.psqlAs(
            'service_role',
            `SELECT * FROM public.engram_recall_items(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 501)));`,
          ),
        ).rejects.toThrow(/more than 500 ids/)
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe('engram_item_associations', () => {
    const CLASSES = ['utterance', 'mk_statement', 'observation', 'artifact', 'document_section']
    const KINDS = ['user_prompt', 'user_answer', 'ruling', 'fact', 'correction', 'procedure', 'finding', 'ledger_decision',
      'ledger_ruling', 'ruling_entry', 'note', 'plan_readme', 'plan_phase', 'plan_ledger', 'audit', 'research']

    interface AssocOptions {
      excludeSession?: string
      asOf?: string
      history?: boolean
      maxTrust?: number
      perSource?: number
    }

    async function associations(seeds: readonly string[], o: AssocOptions = {}): Promise<Array<[string, string, string, number]>> {
      const args = [
        uuidArray(seeds),
        `ARRAY[${CLASSES.map(lit).join(', ')}]`,
        `ARRAY[${KINDS.map(lit).join(', ')}]`,
        o.excludeSession ? lit(o.excludeSession) : 'NULL',
        o.asOf ? `${lit(o.asOf)}::timestamptz` : 'NULL',
        o.history ? 'true' : 'false',
        o.maxTrust === undefined ? 'NULL' : `${o.maxTrust}::smallint`,
        String(o.perSource ?? 2),
      ]
      const out = await pg.psqlAs(
        'service_role',
        `SELECT coalesce(json_agg(json_build_array(a.item_id, a.source, a.seed_id, a.rank) ORDER BY a.k), '[]'::json)
           FROM public.engram_item_associations(${args.join(', ')}) WITH ORDINALITY AS a(item_id, source, seed_id, rank, k);`,
      )
      return JSON.parse(out) as Array<[string, string, string, number]>
    }

    async function subject(label: string): Promise<string> {
      const id = newId()
      await pg.psql(`INSERT INTO public.memory_subjects (id, label) VALUES (${lit(id)}, ${lit(label)});`)
      return id
    }

    async function entities(itemId: string, list: Array<[string, string]>): Promise<void> {
      await pg.psql(
        `INSERT INTO public.memory_item_entities (item_id, entity, entity_type) VALUES ${list
          .map(([entity, type]) => `(${lit(itemId)}, ${lit(entity)}, ${lit(type)})`)
          .join(', ')};`,
      )
    }

    it(
      'filters inside the source before its cap: four same-subject items of the excluded session leave room for the other',
      async () => {
        const subjectId = await subject('tst shared subject')
        const seed = note('tst seed', 0, { subjectId })
        const live = Array.from({ length: 4 }, (_, k) => ({ ...utterance(`tst live ${k}`, 10 + k, 'tst-live-session'), subjectId }))
        const viaLineage = note('tst built on the live session', 20, { subjectId, lineage: [live[0]!.id] })
        const other = note('tst other session', 1, { subjectId })
        await insert([seed, ...live, viaLineage, other])

        expect(await associations([seed.id], { excludeSession: 'tst-live-session' })).toEqual([[other.id, 'subject', seed.id, 1]])
        const unfiltered = await associations([seed.id])
        expect(unfiltered.map((r) => r[0])).toEqual([viaLineage.id, live[3]!.id])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'never returns a forgotten, superseded or later item, and a retired one only with history',
      async () => {
        const subjectId = await subject('tst states subject')
        const seed = note('tst state seed', 0, { subjectId })
        const [forgotten, retired, old, successor, later] = [
          note('tst forgotten', 1, { subjectId }),
          note('tst retired', 2, { subjectId }),
          note('tst old version', 3, { subjectId }),
          note('tst new version', 4),
          note('tst later', 40, { subjectId }),
        ]
        await insert([seed, forgotten, retired, old, successor, later])
        await supersede(old.id, successor.id)
        await pg.psql(`SELECT count(*) FROM public.engram_forget_items(${uuidArray([forgotten.id])}, 'tst forget');`)
        await pg.psql(`SELECT count(*) FROM public.engram_retire_items(${uuidArray([retired.id])}, 'tst retire');`)

        expect((await associations([seed.id], { perSource: 10 })).map((r) => r[0])).toEqual([later.id])
        expect((await associations([seed.id], { history: true, perSource: 10 })).map((r) => r[0])).toEqual([later.id, retired.id])
        // Retired now, so not yet retired as of a past time; the old version was current until its successor occurred.
        expect((await associations([seed.id], { asOf: at(3.5), perSource: 10 })).map((r) => r[0])).toEqual([old.id, retired.id])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'keeps a trust-3 observation out under a trust cap of 2, and a verified one in',
      async () => {
        const subjectId = await subject('tst observed subject')
        const seed = note('tst observed seed', 0, { subjectId })
        const unverified: Item = { ...note('tst unverified claim', 1, { subjectId }), class: 'observation', kind: 'fact', speaker: 'assistant', trust: 3 }
        const verified: Item = {
          ...note('tst verified claim', 2, { subjectId }),
          class: 'observation',
          kind: 'fact',
          speaker: 'assistant',
          trust: 2,
          source: { type: 'ingest_tool', evidence: [{ type: 'commit', ref: 'abc1234' }] },
        }
        await insert([seed, unverified, verified])

        expect((await associations([seed.id], { maxTrust: 2 })).map((r) => r[0])).toEqual([verified.id])
        expect((await associations([seed.id])).map((r) => r[0])).toEqual([verified.id, unverified.id])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'links by shared entities other than repository names, most shared first, and by lineage either way',
      async () => {
        const seed = note('tst entity seed', 0)
        const [two, one, repoOnly, parent, child] = [
          note('tst shares two', 1),
          note('tst shares one', 2),
          note('tst shares the repo', 3),
          note('tst parent', -5),
          note('tst child', 5),
        ]
        await insert([parent])
        await insert([{ ...seed, lineage: [parent.id] }, two, one, repoOnly])
        await insert([{ ...child, lineage: [seed.id] }])
        await entities(seed.id, [['src/a.ts', 'path'], ['TST-41', 'ticket'], ['tst-repo', 'repo']])
        await entities(two.id, [['SRC/A.TS', 'path'], ['tst-41', 'ticket']])
        await entities(one.id, [['src/a.ts', 'path']])
        await entities(repoOnly.id, [['tst-repo', 'repo']])

        expect(await associations([seed.id], { perSource: 5 })).toEqual([
          [two.id, 'entity', seed.id, 1],
          [one.id, 'entity', seed.id, 2],
          [child.id, 'lineage', seed.id, 1],
          [parent.id, 'lineage', seed.id, 2],
        ])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'returns rows in seed order, never a seed, and nothing for a forgotten or unknown seed',
      async () => {
        const subjectId = await subject('tst two seeds')
        const [a, b, c] = [note('tst seed a', 0, { subjectId }), note('tst seed b', 1, { subjectId }), note('tst linked', 2, { subjectId })]
        await insert([a, b, c])
        expect(await associations([b.id, a.id])).toEqual([
          [c.id, 'subject', b.id, 1],
          [c.id, 'subject', a.id, 1],
        ])
        await pg.psql(`SELECT count(*) FROM public.engram_forget_items(${uuidArray([b.id])}, 'tst forget');`)
        expect(await associations([b.id, newId()])).toEqual([])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'refuses missing or too many seeds, an empty class or kind list and a cap out of range',
      async () => {
        const call = (seeds: string, classes: string, kinds: string, per: number) =>
          pg.psqlAs('service_role', `SELECT * FROM public.engram_item_associations(${seeds}, ${classes}, ${kinds}, NULL, NULL, false, NULL, ${per});`)
        const ok = `ARRAY['note']`
        await expect(call('NULL', `ARRAY['document_section']`, ok, 2)).rejects.toThrow(/p_seed_ids must hold at most 10 ids/)
        await expect(call(uuidArray(Array.from({ length: 11 }, () => newId())), `ARRAY['document_section']`, ok, 2)).rejects.toThrow(/at most 10 ids/)
        await expect(call(uuidArray([newId()]), `ARRAY[]::text[]`, ok, 2)).rejects.toThrow(/p_classes must name at least one class/)
        await expect(call(uuidArray([newId()]), `ARRAY['document_section']`, `ARRAY[]::text[]`, 2)).rejects.toThrow(/p_kinds must name at least one kind/)
        await expect(call(uuidArray([newId()]), `ARRAY['document_section']`, ok, 0)).rejects.toThrow(/p_per_source must be between 1 and 20/)
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe('engram_items_by_legacy_ids', () => {
    it(
      'maps an old row id, in any letter case, to its live legacy copy, and nothing else',
      async () => {
        const oldA = '0aaaaaaa-0000-4000-8000-00000000000a'
        const oldB = '0bbbbbbb-0000-4000-8000-00000000000b'
        const legacyItem = (oldId: string, content: string): Item => ({
          id: newId(),
          class: 'legacy',
          kind: 'legacy_episode',
          speaker: 'system',
          trust: 3,
          content,
          occurredAt: at(0),
          source: { type: 'legacy', id: oldId, event_key: `legacy:${oldId}` },
        })
        const a = legacyItem(oldA, 'tst legacy a')
        const b = legacyItem(oldB, 'tst legacy b')
        await insert([a, b])
        await pg.psql(`SELECT count(*) FROM public.engram_forget_items(${uuidArray([b.id])}, 'tst forget');`)
        const out = await pg.psqlAs(
          'service_role',
          `SELECT coalesce(json_agg(json_build_array(m.legacy_id, m.item_id)), '[]'::json)
             FROM public.engram_items_by_legacy_ids(ARRAY[${lit(oldA.toUpperCase())}, ${lit(oldB)}, 'not-a-uuid', ${lit(newId())}]) AS m;`,
        )
        expect(JSON.parse(out)).toEqual([[oldA.toUpperCase(), a.id]])
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe('engram_active_register_tokens', () => {
    it(
      'gives each applies_to string of the entries in force as of a time',
      async () => {
        const active = registerEntry('R-TST-0', 'active', ['tst-legacy-db', 'tst/path'], 0)
        const empty = registerEntry('R-TST-2', 'active', [], 0)
        const missing = registerEntry('R-TST-3', 'active', null, 0)
        const withdrawn = registerEntry('R-TST-4', 'withdrawn', ['tst-withdrawn'], 0)
        const replaced = registerEntry('R-TST-5', 'active', ['tst-old-token'], 0)
        const replacement = registerEntry('R-TST-5', 'active', ['tst-new-token'], 20)
        await insert([active, empty, missing, withdrawn, replaced, replacement])
        await supersede(replaced.id, replacement.id)

        // R-TST-2 and R-TST-3 have no token; R-TST-4 is not active.
        expect(await tokens()).toEqual([
          ['R-TST-0', 'tst-legacy-db'],
          ['R-TST-0', 'tst/path'],
          ['R-TST-5', 'tst-new-token'],
        ])
        expect(await tokens(at(10))).toEqual([
          ['R-TST-0', 'tst-legacy-db'],
          ['R-TST-0', 'tst/path'],
          ['R-TST-5', 'tst-old-token'],
        ])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'drops an entry retired by then',
      async () => {
        const entry = registerEntry('R-TST-6', 'active', ['tst-retired-token'], 0)
        await insert([entry])
        await pg.psql(`SELECT count(*) FROM public.engram_retire_items(${uuidArray([entry.id])}, 'tst retire');`)

        expect(await tokens()).toEqual([])
        expect(await tokens(at(10))).toEqual([['R-TST-6', 'tst-retired-token']])
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe('the store version', () => {
    it(
      'moves when an insert or a retirement commits, and not before',
      async () => {
        const start = await version()
        const writer = await pg.session()
        try {
          await writer.run('BEGIN;')
          await writer.run(`INSERT INTO public.memory_items (id, class, kind, speaker, trust, content, search_text, occurred_at, source)
            VALUES (${lit(newId())}, 'document_section', 'note', 'artifact', 1, 'tst version', 'tst version',
                    ${lit(at(0))}::timestamptz, '{"type":"vault"}'::jsonb);`)
          expect(await version()).toBe(start)
          await writer.run('COMMIT;')
        } finally {
          await writer.close()
        }
        const afterInsert = await version()
        expect(afterInsert).toBeGreaterThan(start)

        const item = note('tst version retire', 0)
        await insert([item])
        const beforeRetire = await version()
        await pg.psql(`SELECT count(*) FROM public.engram_retire_items(${uuidArray([item.id])}, 'tst retire');`)
        expect(await version()).toBeGreaterThan(beforeRetire)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'lets a second writer commit while the first is still open',
      async () => {
        const [a, b] = [note('tst writer one', 0), note('tst writer two', 0)]
        await insert([a, b])
        const first = await pg.session()
        const second = await pg.session()
        try {
          await first.run('BEGIN;')
          await first.run(`UPDATE public.memory_items SET restated_at = ARRAY[now()] WHERE id = ${lit(a.id)};`)
          await second.run("SET statement_timeout = '5s';")
          await second.run('BEGIN;')
          await second.run(`UPDATE public.memory_items SET restated_at = ARRAY[now()] WHERE id = ${lit(b.id)};`)
          await second.run('COMMIT;')
          await first.run('COMMIT;')
        } finally {
          await first.close()
          await second.close()
        }
        const rows = await recallItems([a.id, b.id])
        expect(rows.map((r) => r.restated)).toEqual([1, 1])
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe('the other reads', () => {
    it(
      'reads forget and retire times, forgotten rows included, in the order asked',
      async () => {
        const [kept, forgotten, retired] = [note('tst kept', 0), note('tst forgotten', 0), note('tst retired', 0)]
        await insert([kept, forgotten, retired])
        await pg.psql(`SELECT count(*) FROM public.engram_forget_items(${uuidArray([forgotten.id])}, 'tst forget');`)
        await pg.psql(`SELECT count(*) FROM public.engram_retire_items(${uuidArray([retired.id])}, 'tst retire');`)

        const out = await pg.psqlAs(
          'service_role',
          `SELECT json_agg(json_build_array(s.id, s.forgotten_at IS NOT NULL, s.retired_at IS NOT NULL))
             FROM public.engram_recall_item_states(${uuidArray([retired.id, forgotten.id, kept.id])}) AS s;`,
        )
        expect(JSON.parse(out)).toEqual([
          [retired.id, false, true],
          [forgotten.id, true, false],
          [kept.id, false, false],
        ])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'reads a project workspace and the project registry',
      async () => {
        await pg.psql(`INSERT INTO public.memory_projects (id, kind, workspace_id) VALUES
          ('tst-workspace', 'workspace', NULL), ('tst-repo', 'project', 'tst-workspace'), ('tst-alone', 'project', NULL);`)

        expect(await pg.psqlAs('service_role', "SELECT public.engram_project_workspace('tst-repo');")).toBe('tst-workspace')
        expect(await pg.psqlAs('service_role', "SELECT coalesce(public.engram_project_workspace('tst-alone'), 'none');")).toBe('none')
        expect(await pg.psqlAs('service_role', "SELECT coalesce(public.engram_project_workspace('tst-unknown'), 'none');")).toBe('none')
        const projects = await pg.psqlAs('service_role', 'SELECT json_agg(json_build_array(p.id, p.kind)) FROM public.engram_recall_projects() AS p;')
        expect(JSON.parse(projects)).toEqual([
          ['tst-alone', 'project'],
          ['tst-repo', 'project'],
          ['tst-workspace', 'workspace'],
        ])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'lets anon call none of the read functions',
      async () => {
        for (const call of [
          `SELECT * FROM public.engram_recall_items(${uuidArray([newId()])});`,
          'SELECT * FROM public.engram_active_register_tokens();',
          'SELECT public.engram_store_version();',
          `SELECT * FROM public.engram_recall_item_states(${uuidArray([newId()])});`,
          "SELECT public.engram_project_workspace('tst-repo');",
          'SELECT * FROM public.engram_recall_projects();',
        ]) {
          await expect(pg.psqlAs('anon', call)).rejects.toThrow(/permission denied for function/)
        }
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe('the step cache', () => {
    const key = (n: number) => n.toString(16).padStart(64, '0')

    async function put(step: string, k: string, text: string | null, vector: string | null): Promise<unknown> {
      const out = await pg.psqlAs(
        'service_role',
        `SELECT json_agg(json_build_array(c.cache_key, c.version, c.text_output, c.vector_output::text))
           FROM public.engram_recall_cache_put(${lit(step)}, ${lit(k)}, 'tst-version',
                ${text === null ? 'NULL' : `${lit(text)}::jsonb`}, ${vector === null ? 'NULL' : `${lit(vector)}::public.vector`}) AS c;`,
      )
      return JSON.parse(out)
    }

    beforeEach(async () => {
      await pg.psql('TRUNCATE public.memory_recall_step_cache;')
    }, TEST_TIMEOUT_MS)

    it(
      'returns the first stored value to every later writer of the key',
      async () => {
        expect(await put('expand', key(1), '["first"]', null)).toEqual([[key(1), 'tst-version', ['first'], null]])
        expect(await put('expand', key(1), '["second"]', null)).toEqual([[key(1), 'tst-version', ['first'], null]])
        const got = await pg.psqlAs(
          'service_role',
          `SELECT json_agg(c.text_output) FROM public.engram_recall_cache_get('expand', ARRAY[${lit(key(1))}, ${lit(key(2))}]) AS c;`,
        )
        expect(JSON.parse(got)).toEqual([['first']])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'keeps a vector at single precision and keys each step apart',
      async () => {
        const vector = `[${['0.1', ...Array.from({ length: 1535 }, () => '0')].join(',')}]`
        const stored = (await put('embed_query', key(3), null, vector)) as Array<[string, string, null, string]>
        // A single prints in its shortest form; read back and rounded, it is the single sent.
        expect(Math.fround(Number(JSON.parse(stored[0]![3])[0]))).toBe(Math.fround(0.1))
        expect(await put('hyde', key(3), '"a passage"', null)).toEqual([[key(3), 'tst-version', 'a passage', null]])
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'refuses an output of the wrong kind, a malformed key and an unknown step',
      async () => {
        await expect(put('expand', key(4), '"not a list"', null)).rejects.toThrow(/memory_recall_step_cache_output_check/)
        await expect(put('embed_query', key(4), '["text"]', null)).rejects.toThrow(/memory_recall_step_cache_output_check/)
        await expect(put('expand', 'not-a-key', '["x"]', null)).rejects.toThrow(/memory_recall_step_cache_key_check/)
        await expect(put('rerank', key(4), '"x"', null)).rejects.toThrow(/memory_recall_step_cache_step_check/)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'gives service_role SELECT on the table and no write',
      async () => {
        await expect(
          pg.psqlAs('service_role', `INSERT INTO public.memory_recall_step_cache (step, cache_key, version, text_output) VALUES ('hyde', ${lit(key(5))}, 'v', '"x"');`),
        ).rejects.toThrow(/permission denied/)
        expect(await pg.psqlAs('service_role', 'SELECT count(*) FROM public.memory_recall_step_cache;')).toBe('0')
        await expect(pg.psqlAs('anon', "SELECT * FROM public.engram_recall_cache_get('hyde', ARRAY['x']);")).rejects.toThrow(
          /permission denied for function/,
        )
      },
      TEST_TIMEOUT_MS,
    )
  })
})
