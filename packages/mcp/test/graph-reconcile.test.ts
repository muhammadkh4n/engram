import { describe, it, expect } from 'vitest'
import {
  formatReconcileReport,
  runReconcile,
  type ReconcileGraph,
  type ReconcileSqlSource,
  type SqlSourceRow,
  type SqlTier,
  type UndoLine,
  parseReconcileArgs,
  planReconcile,
  ReconcileArgsError,
  type GraphMemoryNode,
  type SqlMemoryRow,
} from '../src/graph-reconcile-lib.js'

const row = (id: string, over: Partial<SqlMemoryRow> = {}): SqlMemoryRow => ({
  id,
  tier: 'semantic',
  projectId: null,
  inactive: false,
  ...over,
})

const node = (id: string, over: Partial<GraphMemoryNode> = {}): GraphMemoryNode => ({
  id,
  memoryType: 'semantic',
  projectId: null,
  forgotten: false,
  degree: 3,
  ...over,
})

describe('planReconcile', () => {
  it('stamps nodes of inactive rows that lack forgottenAt, and skips already-stamped ones', () => {
    const plan = planReconcile(
      [row('a', { inactive: true }), row('b', { inactive: true }), row('c')],
      [node('a'), node('b', { forgotten: true }), node('c')],
    )
    expect(plan.stamp).toEqual(['a'])
  })

  it('matches ids case-insensitively', () => {
    const plan = planReconcile([row('ABC-1', { inactive: true })], [node('abc-1')])
    expect(plan.stamp).toEqual(['abc-1'])
    expect(plan.missing).toEqual([])
    expect(plan.liveWithoutNode.semantic).toBe(0)
  })

  it('sets the project where SQL has one that differs from the node, never clears one', () => {
    const plan = planReconcile(
      [row('a', { projectId: 'engram' }), row('b', { projectId: 'engram' }), row('c'), row('d', { projectId: 'ouija' })],
      [
        node('a'),
        node('b', { projectId: 'engram' }),
        node('c', { projectId: 'engram' }),
        node('d', { projectId: 'engram' }),
      ],
    )
    expect(plan.setProject).toEqual([
      { id: 'a', projectId: 'engram', before: null },
      { id: 'd', projectId: 'ouija', before: 'engram' },
    ])
  })

  it('lists nodes with no SQL row as missing, untyped nodes included', () => {
    const plan = planReconcile([row('a')], [node('a'), node('ghost'), node('untyped', { memoryType: null })])
    expect(plan.missing).toEqual(['ghost', 'untyped'])
  })

  it('buckets orphans by row state and lists only inactive or missing ones as deletable', () => {
    const plan = planReconcile(
      [row('live'), row('dead', { inactive: true }), row('linked', { inactive: true })],
      [
        node('live', { degree: 0 }),
        node('dead', { degree: 0 }),
        node('gone', { degree: 0 }),
        node('linked', { degree: 2 }),
      ],
    )
    expect(plan.orphans).toEqual({ live: 1, inactive: 1, missing: 1 })
    expect(plan.deletableOrphans).toEqual(['dead', 'gone'])
  })

  it('never lists the node of a live row in any delete list', () => {
    const plan = planReconcile(
      [row('live-1'), row('live-2', { tier: 'episode', projectId: 'engram' })],
      [node('live-1', { degree: 0 }), node('live-2', { degree: 0, memoryType: 'episode' })],
    )
    expect(plan.deletableOrphans).toEqual([])
    expect(plan.missing).toEqual([])
    expect(plan.orphans.live).toBe(2)
  })

  it('counts live rows without a node per tier, ignoring inactive rows', () => {
    const plan = planReconcile(
      [
        row('e1', { tier: 'episode' }),
        row('e2', { tier: 'episode' }),
        row('d1', { tier: 'digest' }),
        row('s1'),
        row('s2', { inactive: true }),
        row('p1', { tier: 'procedural' }),
        row('s3'),
      ],
      [node('s3')],
    )
    expect(plan.liveWithoutNode).toEqual({ episode: 2, digest: 1, semantic: 1, procedural: 1 })
  })

  it('counts tier mismatches, an untyped node with a row among them', () => {
    const plan = planReconcile(
      [row('a', { tier: 'episode' }), row('b', { tier: 'digest' }), row('c')],
      [node('a', { memoryType: 'semantic' }), node('b', { memoryType: null }), node('c')],
    )
    expect(plan.tierMismatch).toBe(2)
  })
})

describe('parseReconcileArgs', () => {
  it('defaults to a dry run with 1000-row pages and batches', () => {
    expect(parseReconcileArgs([])).toEqual({
      apply: false,
      deleteMissing: false,
      deleteOrphans: false,
      undoLog: null,
      pageSize: 1000,
      batchSize: 1000,
      help: false,
    })
  })

  it('accepts every write flag with an undo log', () => {
    const args = parseReconcileArgs([
      '--apply',
      '--delete-missing',
      '--delete-orphans',
      '--undo-log',
      '/tmp/undo.jsonl',
      '--page-size',
      '500',
      '--batch-size',
      '50',
    ])
    expect(args).toMatchObject({
      apply: true,
      deleteMissing: true,
      deleteOrphans: true,
      undoLog: '/tmp/undo.jsonl',
      pageSize: 500,
      batchSize: 50,
    })
  })

  it.each([['--apply'], ['--delete-missing'], ['--delete-orphans']])('rejects %s without --undo-log', (flag) => {
    expect(() => parseReconcileArgs([flag])).toThrow(/--undo-log/)
  })

  it('rejects a delete flag without --apply', () => {
    expect(() => parseReconcileArgs(['--delete-orphans', '--undo-log', 'u.jsonl'])).toThrow(/require --apply/)
  })

  it.each([
    [['--page-size', '0']],
    [['--page-size', 'abc']],
    [['--batch-size', '-3']],
    [['--batch-size']],
    [['--undo-log']],
    [['--undo-log', '--apply']],
    [['--bogus']],
  ])('rejects %j', (argv) => {
    expect(() => parseReconcileArgs(argv)).toThrow(ReconcileArgsError)
  })
})

describe('formatReconcileReport', () => {
  it('prints counts and never an id or project', () => {
    const plan = planReconcile(
      [row('row-secret-id', { inactive: true, projectId: 'private-repo' }), row('live-row-id', { tier: 'episode' })],
      [node('row-secret-id', { degree: 0 }), node('ghost-node-id', { memoryType: null })],
    )
    const report = formatReconcileReport(plan)
    for (const leak of ['row-secret-id', 'ghost-node-id', 'live-row-id', 'private-repo']) {
      expect(report).not.toContain(leak)
    }
    expect(report).toContain('stamp forgottenAt:     1')
    expect(report).toContain('set projectId:         1')
    expect(report).toContain('nodes without a row:   1')
    expect(report).toContain('orphans:               live 0, inactive 1, missing 0')
    expect(report).toContain('deletable orphans:     1')
    expect(report).toContain('episode 1')
  })
})

type Event = { kind: 'undo'; lines: UndoLine[] } | { kind: 'stamp' | 'project' | 'delete'; ids: string[] }

function fakeSql(tables: Partial<Record<SqlTier, SqlSourceRow[]>>, serverCap = Infinity): ReconcileSqlSource {
  return {
    async fetchPage(tier, cursor, pageSize) {
      const rows = [...(tables[tier] ?? [])].sort((a, b) =>
        a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at),
      )
      const after = cursor
        ? rows.filter(
            (r) => r.created_at > cursor.createdAt || (r.created_at === cursor.createdAt && r.id > cursor.id),
          )
        : rows
      return after.slice(0, Math.min(pageSize, serverCap))
    },
  }
}

function fakeGraph(initial: GraphMemoryNode[], events: Event[]): ReconcileGraph & { nodes: GraphMemoryNode[] } {
  const state = {
    nodes: initial.map((n) => ({ ...n })),
    async fetchNodePage(skip: number, limit: number) {
      return [...state.nodes].sort((a, b) => a.id.localeCompare(b.id)).slice(skip, skip + limit).map((n) => ({ ...n }))
    },
    async forgetMemories(ids: string[]) {
      events.push({ kind: 'stamp', ids })
      let n = 0
      state.nodes = state.nodes.map((node) => {
        if (!ids.includes(node.id) || node.forgotten) return node
        n++
        return { ...node, forgotten: true }
      })
      return n
    },
    async setProjects(rows: Array<{ id: string; projectId: string }>) {
      events.push({ kind: 'project', ids: rows.map((r) => r.id) })
      const byId = new Map(rows.map((r) => [r.id, r.projectId]))
      state.nodes = state.nodes.map((node) =>
        byId.has(node.id) ? { ...node, projectId: byId.get(node.id)! } : node,
      )
    },
    async deleteNodes(ids: string[]) {
      events.push({ kind: 'delete', ids })
      const before = state.nodes.length
      state.nodes = state.nodes.filter((node) => !ids.includes(node.id))
      return before - state.nodes.length
    },
  }
  return state
}

const sqlRow = (id: string, over: Partial<SqlSourceRow> = {}): SqlSourceRow => ({
  id,
  created_at: '2026-01-01T00:00:00Z',
  project_id: null,
  ...over,
})

function harness(argv: string[], nodes: GraphMemoryNode[], tables: Partial<Record<SqlTier, SqlSourceRow[]>>) {
  const events: Event[] = []
  const graph = fakeGraph(nodes, events)
  const logs: string[] = []
  const run = () =>
    runReconcile(
      {
        sql: fakeSql(tables, 2),
        graph,
        appendUndo: async (lines) => {
          events.push({ kind: 'undo', lines: [...lines] })
        },
        log: (line) => logs.push(line),
        now: () => '2026-10-01T00:00:00.000Z',
        nodePageSize: 2,
      },
      parseReconcileArgs(argv),
    )
  return { events, graph, logs, run }
}

const DRIFT_TABLES: Partial<Record<SqlTier, SqlSourceRow[]>> = {
  semantic: [
    sqlRow('s-dead', { forgotten_at: '2026-02-01T00:00:00Z' }),
    sqlRow('s-sup', { superseded_by: 's-live', created_at: '2026-01-02T00:00:00Z' }),
    sqlRow('s-live', { project_id: 'engram', created_at: '2026-01-03T00:00:00Z' }),
    sqlRow('s-live-orphan', { created_at: '2026-01-04T00:00:00Z' }),
  ],
  episode: [sqlRow('e-1', { project_id: 'ouija' }), sqlRow('e-2', { project_id: 'ouija' })],
  digest: [sqlRow('d-1')],
}

const DRIFT_NODES: GraphMemoryNode[] = [
  node('s-dead', { degree: 0 }),
  node('s-sup'),
  node('s-live'),
  node('s-live-orphan', { degree: 0 }),
  node('e-1', { memoryType: 'episode' }),
  node('e-2', { memoryType: 'episode' }),
  node('d-1', { memoryType: 'digest' }),
  node('ghost-linked'),
  node('ghost-orphan', { degree: 0, memoryType: null }),
]

describe('runReconcile', () => {
  it('pages every table past a server row cap and every node page', async () => {
    const { run } = harness([], DRIFT_NODES, DRIFT_TABLES)
    const { before } = await run()
    expect(before.totals).toEqual({ rows: 7, nodes: 9 })
    expect([...before.stamp].sort()).toEqual(['s-dead', 's-sup'])
  })

  it('a dry run issues no write and prints one count-only report', async () => {
    const { events, logs, run } = harness([], DRIFT_NODES, DRIFT_TABLES)
    const outcome = await run()
    expect(events).toEqual([])
    expect(outcome.after).toBeNull()
    expect(outcome.written).toEqual({ stamped: 0, projects: 0, deleted: 0 })
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('ghost')
  })

  it('--apply stamps and sets projects in batches, each preceded by its undo lines', async () => {
    const { events, graph, run } = harness(
      ['--apply', '--undo-log', 'u.jsonl', '--batch-size', '1'],
      DRIFT_NODES,
      DRIFT_TABLES,
    )
    const outcome = await run()

    const writes = events.filter((e) => e.kind !== 'undo')
    expect(writes.map((e) => e.kind)).toEqual(['stamp', 'stamp', 'project', 'project', 'project'])
    expect(writes.every((e) => e.kind !== 'undo' && e.ids.length === 1)).toBe(true)
    events.forEach((e, i) => {
      if (e.kind === 'undo') return
      const prev = events[i - 1]
      expect(prev?.kind).toBe('undo')
      expect(prev?.kind === 'undo' && prev.lines.map((l) => l.id)).toEqual(e.ids)
    })
    const undo = events.flatMap((e) => (e.kind === 'undo' ? e.lines : []))
    expect(undo).toContainEqual({ op: 'stamp', id: 's-dead', at: '2026-10-01T00:00:00.000Z' })
    expect(undo).toContainEqual({ op: 'project', id: 'e-1', before: null })

    expect(outcome.written).toEqual({ stamped: 2, projects: 3, deleted: 0 })
    expect(outcome.after?.stamp).toEqual([])
    expect(outcome.after?.setProject).toEqual([])
    expect(graph.nodes).toHaveLength(9)
  })

  it('deletes nothing without a delete flag, missing nodes with --delete-missing, dead orphans with --delete-orphans', async () => {
    const applyOnly = harness(['--apply', '--undo-log', 'u'], DRIFT_NODES, DRIFT_TABLES)
    await applyOnly.run()
    expect(applyOnly.events.some((e) => e.kind === 'delete')).toBe(false)

    const missing = harness(['--apply', '--delete-missing', '--undo-log', 'u'], DRIFT_NODES, DRIFT_TABLES)
    await missing.run()
    expect(missing.events.filter((e) => e.kind === 'delete').flatMap((e) => (e.kind === 'delete' ? e.ids : [])).sort()).toEqual([
      'ghost-linked',
      'ghost-orphan',
    ])

    const orphans = harness(['--apply', '--delete-orphans', '--undo-log', 'u'], DRIFT_NODES, DRIFT_TABLES)
    const outcome = await orphans.run()
    expect(orphans.events.filter((e) => e.kind === 'delete').flatMap((e) => (e.kind === 'delete' ? e.ids : [])).sort()).toEqual([
      'ghost-orphan',
      's-dead',
    ])
    const undo = orphans.events.flatMap((e) => (e.kind === 'undo' ? e.lines : []))
    expect(undo).toContainEqual({ op: 'delete', id: 'ghost-orphan', memoryType: null, projectId: null })
    expect(outcome.after?.orphans).toEqual({ live: 1, inactive: 0, missing: 0 })
  })

  it("never deletes a live row's node, with every delete flag set", async () => {
    const both = harness(
      ['--apply', '--delete-missing', '--delete-orphans', '--undo-log', 'u'],
      DRIFT_NODES,
      DRIFT_TABLES,
    )
    await both.run()
    const deleted = both.events.flatMap((e) => (e.kind === 'delete' ? e.ids : []))
    expect(deleted.sort()).toEqual(['ghost-linked', 'ghost-orphan', 's-dead'])
    for (const live of ['s-live', 's-live-orphan', 'e-1', 'e-2', 'd-1']) {
      expect(both.graph.nodes.map((n) => n.id)).toContain(live)
    }
  })
})
