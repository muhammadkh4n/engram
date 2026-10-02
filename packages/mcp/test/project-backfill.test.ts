import { describe, it, expect } from 'vitest'
import type { PageCursor } from '../src/ingest/embed-backfill-lib.js'
import {
  EMPTY_RULES,
  formatReport,
  knownRepositories,
  planBackfill,
  resolveTag,
  runProjectBackfill,
  type BackfillRow,
  type BackfillRules,
  type ProjectBackfillStore,
  type ProjectChange,
} from '../src/ingest/project-backfill-lib.js'

interface StoredEpisode extends BackfillRow {
  project_id: string | null
  content: string
}

/** In-memory stand-in for memory_episodes with the same filter and keyset semantics as the PostgREST store. */
class StubStore implements ProjectBackfillStore {
  readonly updateCalls: Array<{ ids: string[]; project: string }> = []
  constructor(readonly episodes: StoredEpisode[]) {}

  async fetchPage(cursor: PageCursor | null, pageSize: number): Promise<BackfillRow[]> {
    return this.episodes
      .filter((e) => e.project_id === null && e.project !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .filter(
        (e) =>
          !cursor ||
          e.created_at > cursor.createdAt ||
          (e.created_at === cursor.createdAt && e.id > cursor.id),
      )
      .slice(0, pageSize)
      .map(({ id, created_at, project, category }) => ({ id, created_at, project, category }))
  }

  async assignProject(ids: readonly string[], project: string): Promise<number> {
    this.updateCalls.push({ ids: [...ids], project })
    let changed = 0
    for (const e of this.episodes) {
      if (ids.includes(e.id) && e.project_id === null) {
        e.project_id = project
        changed++
      }
    }
    return changed
  }
}

let seq = 0
function episode(
  project: string | null,
  opts: { category?: string | null; projectId?: string | null } = {},
): StoredEpisode {
  seq++
  const n = String(seq).padStart(4, '0')
  return {
    id: `00000000-0000-0000-0000-00000000${n}`,
    created_at: `2026-08-01T00:00:${String(seq % 60).padStart(2, '0')}.${n}Z`,
    project,
    category: opts.category === undefined ? 'fact' : opts.category,
    project_id: opts.projectId ?? null,
    content: `SECRET-CONTENT-${n} user asked about the deploy script`,
  }
}

function rules(partial: Partial<BackfillRules>): BackfillRules {
  return { ...EMPTY_RULES, ...partial }
}

describe('resolveTag', () => {
  const known = knownRepositories(['engram', 'aithentic-node-stress', 'aithentic-sam-mfe'], EMPTY_RULES)

  it('keeps a repository tag', () => {
    expect(resolveTag('engram', 'fact', known)).toEqual({ target: 'engram', reason: 'tag' })
  })

  it('folds a worktree named <repo>-<slug> into its repository, longest prefix first', () => {
    expect(resolveTag('engram-project-scoping', 'fact', known)).toEqual({ target: 'engram', reason: 'worktree' })
    expect(resolveTag('aithentic-node-stress-graph-core-allowlist', 'lesson', known)).toEqual({
      target: 'aithentic-node-stress',
      reason: 'worktree',
    })
  })

  it('does not fold a name that merely shares a prefix without the separator', () => {
    expect(resolveTag('engramx', 'fact', known).target).toBe('engramx')
  })

  it('never folds a kept name', () => {
    const r = rules({ keep: new Set(['engram-project-scoping']) })
    expect(resolveTag('engram-project-scoping', 'fact', known, r).target).toBe('engram-project-scoping')
  })

  it('stores shared aliases, blanks, dot-folders and temp folders as shared', () => {
    expect(resolveTag('global', 'fact', known)).toEqual({ target: null, reason: 'shared-alias' })
    expect(resolveTag('  ', 'fact', known)).toEqual({ target: null, reason: 'shared-alias' })
    expect(resolveTag(null, 'fact', known)).toEqual({ target: null, reason: 'shared-alias' })
    expect(resolveTag('.claude', 'fact', known)).toEqual({ target: null, reason: 'no-repo' })
    expect(resolveTag('tmp', 'fact', known)).toEqual({ target: null, reason: 'no-repo' })
  })

  it('stores a caller-listed folder name as shared, case-insensitively', () => {
    const r = rules({ sharedNames: new Set(['someuser']) })
    expect(resolveTag('SomeUser', 'decision', known, r)).toEqual({ target: null, reason: 'no-repo' })
  })

  it('stores cross-cutting categories as shared whatever the tag', () => {
    expect(resolveTag('engram', 'preference', known)).toEqual({ target: null, reason: 'cross-cutting' })
    expect(resolveTag('engram', 'identity', known)).toEqual({ target: null, reason: 'cross-cutting' })
  })

  it('applies explicit mappings before the heuristics; none means shared', () => {
    const r = rules({ aliases: new Map([['sam-mfe', 'aithentic-sam-mfe'], ['tmp', 'engram'], ['scratch', 'none']]) })
    expect(resolveTag('sam-mfe', 'fact', known, r)).toEqual({ target: 'aithentic-sam-mfe', reason: 'alias' })
    expect(resolveTag('tmp', 'fact', known, r)).toEqual({ target: 'engram', reason: 'alias' })
    expect(resolveTag('scratch', 'fact', known, r)).toEqual({ target: null, reason: 'alias' })
  })
})

describe('knownRepositories', () => {
  it('excludes folder names and adds caller-listed repositories', () => {
    const known = knownRepositories(['.claude', 'tmp', 'engram', 'global'], rules({ repos: new Set(['mission-control']) }))
    expect([...known].sort()).toEqual(['engram', 'mission-control'])
  })
})

describe('planBackfill', () => {
  it('learns repositories from the data and records renames', () => {
    const rows = [episode('engram'), episode('engram-project-scoping'), episode('engram-project-scoping')]
    const plan = planBackfill(rows)
    expect(plan.assignments.get('engram')).toHaveLength(3)
    expect([...plan.renames]).toEqual([['engram-project-scoping -> engram', 2]])
  })

  it('leaves a worktree tag alone when its repository never appears', () => {
    const plan = planBackfill([episode('engram-project-scoping')])
    expect([...plan.assignments.keys()]).toEqual(['engram-project-scoping'])
  })
})

describe('runProjectBackfill against a stubbed store', () => {
  function fixture(): StubStore {
    return new StubStore([
      episode('engram'),
      episode('engram-project-scoping'),
      episode('aithentic-sam-mfe'),
      episode('aithentic-sam-mfe', { category: 'preference' }),
      episode('.claude'),
      episode('someuser'),
      episode('global'),
      episode(null),
      episode('engram', { projectId: 'engram' }),
    ])
  }
  const r = rules({ sharedNames: new Set(['someuser']) })

  it('dry run reads every page and writes nothing', async () => {
    const store = fixture()
    const report = await runProjectBackfill(store, r, { apply: false, pageSize: 2, batchSize: 10 })
    expect(store.updateCalls).toEqual([])
    expect(store.episodes.filter((e) => e.project_id !== null)).toHaveLength(1)
    expect(report.plan.scanned).toBe(7)
    expect(Object.fromEntries([...report.plan.assignments].map(([p, ids]) => [p, ids.length]))).toEqual({
      engram: 2,
      'aithentic-sam-mfe': 1,
    })
    expect(Object.fromEntries(report.plan.shared)).toEqual({ 'cross-cutting': 1, 'no-repo': 2, 'shared-alias': 1 })
  })

  function sink(): { changes: ProjectChange[]; write(c: readonly ProjectChange[]): void } {
    const changes: ProjectChange[] = []
    return { changes, write: (c) => void changes.push(...c) }
  }

  it('refuses to apply without a rollback record', async () => {
    await expect(runProjectBackfill(fixture(), r, { apply: true, pageSize: 3, batchSize: 1 })).rejects.toThrow(
      /rollback/,
    )
  })

  it('apply writes in batches, only NULL rows, records each batch, and a second run is a no-op', async () => {
    const store = fixture()
    const rollback = sink()
    const report = await runProjectBackfill(store, r, { apply: true, pageSize: 3, batchSize: 1, rollback })
    expect(rollback.changes).toHaveLength(3)
    expect(rollback.changes.every((c) => c.table === 'memory_episodes' && c.old === null)).toBe(true)
    expect(store.updateCalls).toHaveLength(3)
    expect(report.updated.get('engram')).toBe(2)
    expect(report.updated.get('aithentic-sam-mfe')).toBe(1)
    const tagged = store.episodes.filter((e) => e.project_id !== null).map((e) => [e.project, e.project_id])
    expect(tagged).toEqual([
      ['engram', 'engram'],
      ['engram-project-scoping', 'engram'],
      ['aithentic-sam-mfe', 'aithentic-sam-mfe'],
      ['engram', 'engram'],
    ])

    const again = await runProjectBackfill(store, r, { apply: true, pageSize: 3, batchSize: 1, rollback })
    expect(again.plan.assignments.size).toBe(0)
    expect(store.updateCalls).toHaveLength(3)
  })

  it('reports counts and project names, never content or ids', async () => {
    const store = fixture()
    const report = await runProjectBackfill(store, r, { apply: true, pageSize: 50, batchSize: 50, rollback: sink() })
    const text = formatReport(report, true)
    expect(text).toContain('engram: 2 / 2')
    expect(text).toContain('engram-project-scoping -> engram: 1')
    expect(text).toContain('stays shared: 4')
    expect(text).not.toMatch(/SECRET-CONTENT|00000000-0000/)
  })
})
