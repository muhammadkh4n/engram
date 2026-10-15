/**
 * engram_review_candidates on real Postgres: the three pending selections
 * and the scope rule without ids, every review state by id, the target
 * statuses, the derived proposed scope, the restated count, and a total
 * counted before the limit in the same statement.
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
  subjectId?: string
  context?: string
  lineage?: string[]
  standing?: boolean
  projectId?: string
  workspaceId?: string
  planSlug?: string
  registerStatus?: string
  registerRef?: string
}

interface Row {
  id: string
  kind: string
  quote: string
  question: string | null
  project_id: string | null
  workspace_id: string | null
  subject: string | null
  proposed_scope: string | null
  status: string
  register_status: string | null
  restated_count: number
  targets: Array<{ id: string; class: string; text: string; status: string }>
  total: number
}

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `01980000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`
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

function opt(value: string | undefined): string {
  return value === undefined ? 'NULL' : lit(value)
}

function valuesRow(i: Item): string {
  return `(${[
    lit(i.id),
    lit(i.class),
    lit(i.kind),
    lit(i.speaker),
    String(i.trust),
    opt(i.subjectId),
    lit(i.content),
    lit(i.content),
    opt(i.context),
    `${lit(i.occurredAt)}::timestamptz`,
    `${lit(JSON.stringify(i.source))}::jsonb`,
    `ARRAY[${(i.lineage ?? []).map(lit).join(', ')}]::uuid[]`,
    i.standing === undefined ? 'NULL' : String(i.standing),
    opt(i.projectId),
    opt(i.workspaceId),
    opt(i.planSlug),
    opt(i.registerStatus),
    opt(i.registerRef),
  ].join(', ')})`
}

describe.skipIf(!realPgImage)('engram_review_candidates on real Postgres', () => {
  let pg: RealPg
  let subjectId: string

  beforeAll(async () => {
    pg = await startRealPg()
    await pg.applySchema()
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  beforeEach(async () => {
    await pg.psql('TRUNCATE public.memory_items, public.memory_subjects, public.memory_projects CASCADE;')
    subjectId = newId()
    await pg.psql(`INSERT INTO public.memory_subjects (id, label) VALUES (${lit(subjectId)}, 'tst subject');`)
  }, TEST_TIMEOUT_MS)

  async function insert(items: readonly Item[]): Promise<void> {
    await pg.psql(
      `INSERT INTO public.memory_items (id, class, kind, speaker, trust, subject_id, content, search_text, context,
         occurred_at, source, lineage, standing, project_id, workspace_id, plan_slug, register_status, register_ref)
       VALUES ${items.map(valuesRow).join(',\n')};`,
    )
  }

  /** The MK prompt each statement quotes from, then the statements, so every quote occurs in its lineage. */
  async function insertStatements(statements: Item[], others: Item[] = []): Promise<void> {
    const prompt: Item = {
      id: newId(),
      class: 'utterance',
      kind: 'user_prompt',
      speaker: 'mk',
      trust: 0,
      content: statements.map((s) => s.content).join(' / ') || 'tst prompt',
      occurredAt: at(-10),
      source: { type: 'transcript', session_id: 'tst-session-1', line: 1 },
    }
    await insert([prompt, ...others])
    if (statements.length > 0) await insert(statements.map((s) => ({ ...s, lineage: [prompt.id] })))
  }

  function statement(content: string, minute: number, options: Partial<Item> = {}): Item {
    return {
      id: newId(),
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      content,
      context: 'tst question that was answered',
      occurredAt: at(minute),
      source: { type: 'extraction', scope: 'project' },
      subjectId,
      standing: true,
      projectId: 'tst-repo',
      registerStatus: 'candidate',
      ...options,
    }
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
      projectId: 'tst-repo',
      ...options,
    }
  }

  function assistantTurn(content: string, minute: number, options: Partial<Item> = {}): Item {
    return {
      id: newId(),
      class: 'utterance',
      kind: 'assistant_turn',
      speaker: 'assistant',
      trust: 3,
      content,
      occurredAt: at(minute),
      source: { type: 'transcript', session_id: 'tst-session-1', line: minute },
      projectId: 'tst-repo',
      ...options,
    }
  }

  async function link(from: string, to: string, rel: 'corrects' | 'retracts' | 'changes'): Promise<void> {
    await pg.psql(`INSERT INTO public.memory_item_links (from_item, to_item, rel) VALUES (${lit(from)}, ${lit(to)}, ${lit(rel)});`)
  }

  async function retire(id: string): Promise<void> {
    await pg.psql(`SELECT count(*) FROM public.engram_retire_items(${uuidArray([id])}, 'tst retire');`)
  }

  async function forget(id: string): Promise<void> {
    await pg.psql(`SELECT count(*) FROM public.engram_forget_items(${uuidArray([id])}, 'tst forget');`)
  }

  async function supersede(oldId: string, newId_: string): Promise<void> {
    await pg.psql(`SELECT public.engram_supersede_item(${lit(oldId)}, ${lit(newId_)});`)
  }

  async function review(opts: { project?: string; workspace?: string; ids?: string[]; limit?: number } = {}): Promise<Row[]> {
    const args = [opt(opts.project), opt(opts.workspace), opts.ids ? uuidArray(opts.ids) : 'NULL', String(opts.limit ?? 8)]
    const out = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(json_agg(to_jsonb(r) ORDER BY r.k), '[]'::json)
         FROM public.engram_review_candidates(${args.join(', ')}) WITH ORDINALITY AS r(id, kind, quote, question,
              occurred_at, session_id, project_id, workspace_id, subject, proposed_scope, status, register_status,
              restated_count, targets, total, k);`,
    )
    return JSON.parse(out) as Row[]
  }

  const ids = (rows: readonly Row[]) => rows.map((r) => r.id)

  it(
    'returns a current standing candidate in scope, never a dismissed, recorded or superseded one',
    async () => {
      const pending = statement('tst keep the floor', 0)
      const dismissed = statement('tst dismissed ruling', 1, { registerStatus: 'dismissed' })
      const recorded = statement('tst recorded ruling', 2, { registerStatus: 'recorded', registerRef: 'R-TST-0' })
      const old = statement('tst old wording', 3)
      const successor = statement('tst new wording', 4, { registerStatus: 'dismissed' })
      await insertStatements([pending, dismissed, recorded, old, successor])
      await supersede(old.id, successor.id)

      const rows = await review({ project: 'tst-repo' })
      expect(ids(rows)).toEqual([pending.id])
      expect(rows[0]).toMatchObject({
        kind: 'ruling',
        quote: 'tst keep the floor',
        question: 'tst question that was answered',
        subject: 'tst subject',
        status: 'current',
        register_status: 'candidate',
        restated_count: 0,
        targets: [],
        total: 1,
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'returns a correction with a live target, listing its retired target too; not one whose only target is retired, nor a superseded one',
    async () => {
      const [live, gone, onlyGone, later] = [note('tst live claim', 0), note('tst retired claim', 1), note('tst lone claim', 2), note('tst claim three', 3)]
      const correction = statement('tst that is wrong', 10, { kind: 'correction', standing: false, registerStatus: undefined })
      const lonely = statement('tst also wrong', 11, { kind: 'correction', standing: false, registerStatus: undefined })
      const oldCorrection = statement('tst wrong again', 12, { kind: 'correction', standing: false, registerStatus: undefined })
      const newCorrection = statement('tst wrong, said better', 13, { kind: 'correction', standing: false, registerStatus: undefined })
      await insertStatements([correction, lonely, oldCorrection, newCorrection], [live, gone, onlyGone, later])
      await link(correction.id, live.id, 'corrects')
      await link(correction.id, gone.id, 'corrects')
      await link(lonely.id, onlyGone.id, 'corrects')
      await link(oldCorrection.id, later.id, 'corrects')
      await retire(gone.id)
      await retire(onlyGone.id)
      await supersede(oldCorrection.id, newCorrection.id)

      const rows = await review({ project: 'tst-repo' })
      expect(ids(rows)).toEqual([correction.id])
      expect(rows[0]!.kind).toBe('correction')
      expect(rows[0]!.register_status).toBeNull()
      expect(rows[0]!.targets).toEqual([
        { id: live.id, class: 'document_section', text: 'tst live claim', status: 'current' },
        { id: gone.id, class: 'document_section', text: 'tst retired claim', status: 'retired' },
      ])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'returns a retraction with its target, and lists the register entry a candidate would change',
    async () => {
      const claim = note('tst wrong claim', 0)
      const retraction = assistantTurn('I was wrong about that. The claim does not hold.', 5)
      const entry: Item = {
        id: newId(),
        class: 'artifact',
        kind: 'ruling_entry',
        speaker: 'artifact',
        trust: 1,
        content: 'R-TST-0 entry text',
        occurredAt: at(1),
        source: { type: 'register', id: 'R-TST-0', status: 'active' },
      }
      const change = statement('tst change the entry', 6)
      await insertStatements([change], [claim, retraction, entry])
      await link(retraction.id, claim.id, 'retracts')
      await link(change.id, entry.id, 'changes')

      const rows = await review({ project: 'tst-repo' })
      expect(ids(rows)).toEqual([change.id, retraction.id])
      expect(rows[0]!.targets).toEqual([{ id: entry.id, class: 'artifact', text: 'R-TST-0 entry text', status: 'current' }])
      expect(rows[1]).toMatchObject({
        kind: 'retraction',
        quote: 'I was wrong about that. The claim does not hold.',
        question: null,
        register_status: null,
        proposed_scope: null,
        targets: [{ id: claim.id, class: 'document_section', text: 'tst wrong claim', status: 'current' }],
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'scopes to the project, its workspace and items said outside both, newest first, every row current',
    async () => {
      const mine = statement('tst mine', 0)
      const other = statement('tst other project', 1, { projectId: 'tst-other' })
      const global = statement('tst said nowhere', 2, { projectId: undefined, source: { type: 'extraction', scope: 'global' } })
      const workspace = statement('tst workspace wide', 3, { projectId: undefined, workspaceId: 'tst-ws', source: { type: 'extraction', scope: 'workspace' } })
      const otherWorkspace = statement('tst other workspace', 4, { projectId: undefined, workspaceId: 'tst-ws-2' })
      await insertStatements([mine, other, global, workspace, otherWorkspace])

      const rows = await review({ project: 'tst-repo', workspace: 'tst-ws' })
      expect(ids(rows)).toEqual([workspace.id, global.id, mine.id])
      expect(rows.every((r) => r.status === 'current')).toBe(true)
      expect(ids(await review())).toEqual([global.id])
      await expect(review({ limit: 9 })).rejects.toThrow(/p_limit must be between 1 and 8/)
      await expect(review({ limit: 0 })).rejects.toThrow(/p_limit must be between 1 and 8/)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'counts every pending row before the limit, in the same statement',
    async () => {
      const six = Array.from({ length: 6 }, (_, k) => statement(`tst pending ${k}`, k))
      await insertStatements(six)
      const rows = await review({ project: 'tst-repo', limit: 4 })
      expect(ids(rows)).toEqual([six[5]!.id, six[4]!.id, six[3]!.id, six[2]!.id])
      expect(rows.map((r) => r.total)).toEqual([6, 6, 6, 6])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'with ids, returns those items in the order given whatever their state, and never an utterance or a forgotten one',
    async () => {
      const recorded = statement('tst recorded', 0, { registerStatus: 'recorded', registerRef: 'R-TST-0' })
      const dismissed = statement('tst dismissed', 1, { registerStatus: 'dismissed', projectId: 'tst-other' })
      const old = statement('tst first version', 2)
      const successor = statement('tst second version', 3)
      const retired = statement('tst retired', 4)
      const forgotten = statement('tst forgotten', 5)
      await insertStatements([recorded, dismissed, old, successor, retired, forgotten])
      await supersede(old.id, successor.id)
      await retire(retired.id)
      await forget(forgotten.id)
      const prompt = (JSON.parse(
        await pg.psqlAs('service_role', "SELECT json_agg(id) FROM public.memory_items WHERE class = 'utterance';"),
      ) as string[])[0]!

      const rows = await review({ ids: [retired.id, prompt, dismissed.id, forgotten.id, old.id, recorded.id], limit: 1 })
      expect(ids(rows)).toEqual([retired.id, dismissed.id, old.id, recorded.id])
      expect(rows.map((r) => [r.status, r.register_status])).toEqual([
        ['retired', 'candidate'],
        ['current', 'dismissed'],
        ['superseded', 'candidate'],
        ['current', 'recorded'],
      ])
      expect(rows.map((r) => r.total)).toEqual([4, 4, 4, 4])
      await expect(review({ ids: [] })).rejects.toThrow(/p_ids must hold 1 to 8 ids/)
      await expect(review({ ids: Array.from({ length: 9 }, () => newId()) })).rejects.toThrow(/p_ids must hold 1 to 8 ids/)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'counts restatements, and derives the proposed scope from the stored level and the item columns',
    async () => {
      const restated = statement('tst said twice more', 0)
      const levels: Array<[Partial<Item>, string | null]> = [
        [{ source: { type: 'extraction', scope: 'global' } }, 'global'],
        [{ source: { type: 'extraction', scope: 'project' } }, 'project:tst-repo'],
        [{ source: { type: 'extraction', scope: 'workspace' }, workspaceId: 'tst-ws' }, 'workspace:tst-ws'],
        [{ source: { type: 'extraction', scope: 'plan' }, planSlug: 'tst-plan' }, 'plan:tst-plan'],
        [{ source: { type: 'extraction', scope: 'session' } }, null],
        [{ source: { type: 'ingest_tool' } }, null],
        [{ source: { type: 'extraction', scope: 'project' }, projectId: undefined }, null],
      ]
      const items = levels.map(([options], k) => statement(`tst level ${k}`, 10 + k, options))
      await insertStatements([restated, ...items])
      // A new item never carries restatements; they are added to a stored one, as restating does.
      await pg.psql(`UPDATE public.memory_items SET restated_at = ARRAY[${lit(at(1))}, ${lit(at(2))}]::timestamptz[] WHERE id = ${lit(restated.id)};`)

      const rows = await review({ ids: [restated.id, ...items.map((i) => i.id)] })
      expect(rows[0]!.restated_count).toBe(2)
      expect(rows.slice(1).map((r) => r.proposed_scope)).toEqual(levels.map(([, scope]) => scope))
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'is not callable by anon',
    async () => {
      await expect(pg.psqlAs('anon', 'SELECT * FROM public.engram_review_candidates();')).rejects.toThrow(/permission denied for function/)
    },
    TEST_TIMEOUT_MS,
  )
})
