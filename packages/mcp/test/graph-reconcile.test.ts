import { describe, it, expect } from 'vitest'
import {
  formatReconcileReport,
  readGraphNodes,
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
import {
  undoContextLinks,
  type ContextLinkNode,
  type ContextLinkRef,
  type ContextUndoLine,
} from '../src/graph-reconcile-context.js'

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
    expect(plan.setTier).toEqual([
      { id: 'a', memoryType: 'episode', before: 'semantic' },
      { id: 'b', memoryType: 'digest', before: null },
    ])
  })

  it('never plans a tier for a node without a SQL row', () => {
    const plan = planReconcile([row('a')], [node('a'), node('ghost', { memoryType: null })])
    expect(plan.setTier).toEqual([])
    expect(plan.missing).toEqual(['ghost'])
  })
})

describe('parseReconcileArgs', () => {
  it('defaults to a dry run with 1000-row pages and batches', () => {
    expect(parseReconcileArgs([])).toEqual({
      apply: false,
      deleteMissing: false,
      deleteOrphans: false,
      pruneContextLinks: false,
      undoLog: null,
      undo: null,
      pageSize: 1000,
      batchSize: 1000,
      help: false,
    })
  })

  it('accepts --undo on its own and rejects it with a write flag or an undo log', () => {
    expect(parseReconcileArgs(['--undo', 'u.jsonl', '--batch-size', '10'])).toMatchObject({ undo: 'u.jsonl', batchSize: 10 })
    expect(() => parseReconcileArgs(['--undo', 'u.jsonl', '--apply', '--undo-log', 'v.jsonl'])).toThrow(/--undo/)
    expect(() => parseReconcileArgs(['--undo', 'u.jsonl', '--undo-log', 'v.jsonl'])).toThrow(/--undo/)
    expect(() => parseReconcileArgs(['--undo'])).toThrow(ReconcileArgsError)
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

  it('accepts --prune-context-links only with --apply and an undo log, and never with --undo', () => {
    expect(parseReconcileArgs(['--apply', '--prune-context-links', '--undo-log', 'u.jsonl'])).toMatchObject({
      apply: true,
      pruneContextLinks: true,
    })
    expect(parseReconcileArgs(['--apply', '--undo-log', 'u.jsonl']).pruneContextLinks).toBe(false)
    expect(() => parseReconcileArgs(['--prune-context-links', '--undo-log', 'u.jsonl'])).toThrow(/require --apply/)
    expect(() => parseReconcileArgs(['--apply', '--prune-context-links'])).toThrow(/--undo-log/)
    expect(() => parseReconcileArgs(['--prune-context-links'])).toThrow(ReconcileArgsError)
    expect(() => parseReconcileArgs(['--undo', 'u.jsonl', '--prune-context-links'])).toThrow(/--undo/)
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

type Event =
  | { kind: 'undo'; lines: UndoLine[] }
  | { kind: 'stamp' | 'project' | 'tier' | 'delete'; ids: string[] }
  | { kind: 'ctx'; links: ContextLinkRef[] }

/** A graph relationship between a Memory node and a Person/Entity/Topic node. */
interface FakeLink {
  memoryId: string
  ctxId: string
  name: string | null
  type: 'CONTEXTUAL' | 'SPOKE'
  props: Record<string, unknown>
}

function fakeSql(
  tables: Partial<Record<SqlTier, SqlSourceRow[]>>,
  serverCap = Infinity,
  texts: Record<string, string> = {},
): ReconcileSqlSource {
  return {
    async fetchTexts(tier, ids) {
      const wanted = new Set(ids.map((id) => id.toLowerCase()))
      return (tables[tier] ?? [])
        .filter((r) => wanted.has(r.id.toLowerCase()))
        .map((r) => ({
          id: r.id,
          tier,
          text: texts[r.id] ?? '',
          inactive: r.forgotten_at != null || r.superseded_by != null,
        }))
    },
    async fetchByIds(tier, ids) {
      const wanted = new Set(ids.map((id) => id.toLowerCase()))
      return (tables[tier] ?? []).filter((r) => wanted.has(r.id.toLowerCase())).map((r) => ({ ...r }))
    },
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

function fakeGraph(
  initial: GraphMemoryNode[],
  events: Event[],
  initialLinks: FakeLink[] = [],
): ReconcileGraph & { nodes: GraphMemoryNode[]; links: FakeLink[] } {
  const ctxNames = new Map(initialLinks.map((l) => [l.ctxId, l.name]))
  const state = {
    /** Context nodes by id; the fake uses one id as both element id and `id` property. */
    ctxNodes: new Set(initialLinks.map((l) => l.ctxId)),
    nodes: initial.map((n) => ({ ...n })),
    links: initialLinks.map((l) => ({ ...l, props: { ...l.props } })),
    async fetchContextPage(after: string | null, limit: number): Promise<ContextLinkNode[]> {
      return [...state.nodes]
        .filter((n) => n.memoryType === 'semantic' || n.memoryType === 'digest')
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((n) => after === null || n.id > after)
        .slice(0, limit)
        .map((n) => ({
          id: n.id,
          forgotten: n.forgotten,
          edges: state.links
            .filter((l) => l.memoryId === n.id && l.type === 'CONTEXTUAL')
            .map((l) => ({
              ctxId: l.ctxId,
              ctxLabel: 'Entity' as const,
              ctxNodeId: l.ctxId,
              name: l.name,
              props: { ...l.props },
            })),
        }))
    },
    async remainingLiveLinks(rows: ReadonlyArray<{ ctxId: string; prunedMemoryIds: string[] }>) {
      return rows.map((row) => {
        const live = new Set(
          state.links
            .filter((l) => l.ctxId === row.ctxId)
            .filter((l) => state.nodes.some((n) => n.id === l.memoryId && !n.forgotten))
            .filter((l) => !(l.type === 'CONTEXTUAL' && row.prunedMemoryIds.includes(l.memoryId)))
            .map((l) => l.memoryId),
        )
        const name = ctxNames.get(row.ctxId) ?? null
        return { ctxId: row.ctxId, name, remaining: live.size }
      })
    },
    async deleteContextLinks(links: readonly ContextLinkRef[]) {
      events.push({ kind: 'ctx', links: [...links] })
      const before = state.links.length
      state.links = state.links.filter(
        (l) => !(l.type === 'CONTEXTUAL' && links.some((d) => d.memoryId === l.memoryId && d.ctxId === l.ctxId)),
      )
      return before - state.links.length
    },
    async restoreContextLinks(lines: readonly ContextUndoLine[]) {
      let n = 0
      for (const line of lines) {
        if (!state.nodes.some((node) => node.id === line.memoryId)) continue
        if (!state.ctxNodes.has(line.ctxNodeId)) continue
        const ctxId = line.ctxNodeId
        const name = ctxNames.get(ctxId) ?? null
        state.links = state.links.filter(
          (l) => !(l.type === 'CONTEXTUAL' && l.memoryId === line.memoryId && l.ctxId === ctxId),
        )
        state.links.push({ memoryId: line.memoryId, ctxId, name, type: 'CONTEXTUAL', props: { ...line.props } })
        n++
      }
      return n
    },
    async fetchNodePage(after: string | null, limit: number) {
      return [...state.nodes]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((n) => after === null || n.id > after)
        .slice(0, limit)
        .map((n) => ({ ...n }))
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
    async setTiers(rows: Array<{ id: string; memoryType: SqlTier }>) {
      events.push({ kind: 'tier', ids: rows.map((r) => r.id) })
      const byId = new Map(rows.map((r) => [r.id, r.memoryType]))
      state.nodes = state.nodes.map((node) =>
        byId.has(node.id) ? { ...node, memoryType: byId.get(node.id)! } : node,
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

function harness(
  argv: string[],
  nodes: GraphMemoryNode[],
  tables: Partial<Record<SqlTier, SqlSourceRow[]>>,
  links: FakeLink[] = [],
  texts: Record<string, string> = {},
) {
  const events: Event[] = []
  const graph = fakeGraph(nodes, events, links)
  const logs: string[] = []
  const run = () =>
    runReconcile(
      {
        sql: fakeSql(tables, 2, texts),
        graph,
        appendUndo: async (lines) => {
          events.push({ kind: 'undo', lines: [...lines] })
        },
        log: (line) => logs.push(line),
        now: () => '2026-10-01T00:00:00.000Z',
        nodePageSize: 2,
        contextPageSize: 2,
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
    expect(outcome.written).toEqual({ stamped: 0, projects: 0, tiers: 0, deleted: 0, skippedChangedSinceSnapshot: 0 })
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

    expect(outcome.written).toEqual({ stamped: 2, projects: 3, tiers: 0, deleted: 0, skippedChangedSinceSnapshot: 0 })
    expect(outcome.after?.stamp).toEqual([])
    expect(outcome.after?.setProject).toEqual([])
    expect(graph.nodes).toHaveLength(9)
  })

  it('repairs memoryType from the SQL tier: counted on a dry run, written on --apply after its undo lines', async () => {
    const nodes = DRIFT_NODES.map((n) =>
      n.id === 'e-1' ? { ...n, memoryType: 'semantic' } : n.id === 'd-1' ? { ...n, memoryType: null } : n,
    )
    const dry = harness([], nodes, DRIFT_TABLES)
    const dryOutcome = await dry.run()
    expect(dry.events).toEqual([])
    expect(dry.logs[0]).toContain('tier mismatch:         2')
    expect(dryOutcome.written.tiers).toBe(0)

    const { events, graph, logs, run } = harness(['--apply', '--undo-log', 'u.jsonl'], nodes, DRIFT_TABLES)
    const outcome = await run()

    const tierAt = events.findIndex((e) => e.kind === 'tier')
    const tierWrite = events[tierAt]
    expect(tierWrite?.kind === 'tier' && [...tierWrite.ids].sort()).toEqual(['d-1', 'e-1'])
    const undo = events[tierAt - 1]
    expect(undo?.kind === 'undo' && undo.lines).toEqual([
      { op: 'tier', id: 'd-1', before: null },
      { op: 'tier', id: 'e-1', before: 'semantic' },
    ])
    expect(outcome.written.tiers).toBe(2)
    expect(graph.nodes.find((n) => n.id === 'e-1')?.memoryType).toBe('episode')
    expect(graph.nodes.find((n) => n.id === 'd-1')?.memoryType).toBe('digest')
    // A node with no SQL row keeps its type: there is no tier to take it from.
    expect(graph.nodes.find((n) => n.id === 'ghost-orphan')?.memoryType).toBeNull()
    expect(outcome.after?.tierMismatch).toBe(0)
    expect(logs).toContainEqual(expect.stringContaining('tiers 2'))
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

  it('keeps the node of a row inserted after the SQL snapshot and counts it as skipped', async () => {
    const tables = { ...DRIFT_TABLES, semantic: [...(DRIFT_TABLES.semantic ?? [])] }
    const run = harness(
      ['--apply', '--delete-missing', '--undo-log', 'u'],
      [...DRIFT_NODES, node('fresh', { degree: 0 })],
      tables,
    )
    // The row lands while the graph is being read, after the SQL snapshot was taken.
    const read = run.graph.fetchNodePage
    run.graph.fetchNodePage = async (after, limit) => {
      if (!tables.semantic.some((r) => r.id === 'fresh')) tables.semantic.push(sqlRow('fresh'))
      return read(after, limit)
    }

    const outcome = await run.run()

    expect(outcome.before.missing).toContain('fresh')
    const deleted = run.events.flatMap((e) => (e.kind === 'delete' ? e.ids : []))
    expect(deleted.sort()).toEqual(['ghost-linked', 'ghost-orphan'])
    expect(run.graph.nodes.map((n) => n.id)).toContain('fresh')
    expect(outcome.written.skippedChangedSinceSnapshot).toBe(1)
    const undo = run.events.flatMap((e) => (e.kind === 'undo' ? e.lines : []))
    expect(undo.map((l) => l.id)).not.toContain('fresh')
    expect(run.logs.join('\n')).toContain('skipped (changed since snapshot) 1')
  })

  it('does not delete an inactive orphan whose row was restored after the snapshot', async () => {
    const tables = { ...DRIFT_TABLES, semantic: [...(DRIFT_TABLES.semantic ?? [])] }
    const run = harness(['--apply', '--delete-orphans', '--undo-log', 'u'], DRIFT_NODES, tables)
    const read = run.graph.fetchNodePage
    run.graph.fetchNodePage = async (after, limit) => {
      tables.semantic = tables.semantic.map((r) => (r.id === 's-dead' ? { ...r, forgotten_at: null } : r))
      return read(after, limit)
    }

    const outcome = await run.run()

    expect(outcome.before.deletableOrphans).toContain('s-dead')
    const deleted = run.events.flatMap((e) => (e.kind === 'delete' ? e.ids : []))
    expect(deleted).toEqual(['ghost-orphan'])
    expect(run.graph.nodes.map((n) => n.id)).toContain('s-dead')
    expect(outcome.written.skippedChangedSinceSnapshot).toBe(1)
  })
})

describe('readGraphNodes', () => {
  it('pages by key, reading every node once when nodes are added between pages', async () => {
    const graph = fakeGraph(['a', 'c', 'e', 'g', 'i'].map((id) => node(id)), [])
    const read = graph.fetchNodePage
    let calls = 0
    graph.fetchNodePage = async (after, limit) => {
      const page = await read(after, limit)
      if (++calls === 1) graph.nodes = [...graph.nodes, node('b'), node('h')]
      return page
    }

    const ids = (await readGraphNodes(graph, 2)).map((n) => n.id)

    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['a', 'c', 'e', 'g', 'i', 'h']) expect(ids).toContain(id)
  })
})

const ctxLink = (
  memoryId: string,
  ctxId: string,
  name: string,
  props: Record<string, unknown> = {},
  type: FakeLink['type'] = 'CONTEXTUAL',
): FakeLink => ({ memoryId, ctxId, name, type, props })

const EDGE_PROPS = { weight: 0.42, createdAt: '2026-09-01T00:00:00Z', traversalCount: { $int: '3' } }

const CTX_TABLES: Partial<Record<SqlTier, SqlSourceRow[]>> = {
  semantic: [
    sqlRow('s-1'),
    sqlRow('s-2', { created_at: '2026-01-02T00:00:00Z' }),
    sqlRow('s-old', { forgotten_at: '2026-02-01T00:00:00Z', created_at: '2026-01-03T00:00:00Z' }),
  ],
  digest: [sqlRow('d-1')],
  episode: [sqlRow('e-1')],
}

const CTX_TEXTS: Record<string, string> = {
  's-1': "Kam's review of the PostgREST change",
  's-2': 'nothing in this fact names a context node',
  's-old': 'Kam',
  'd-1': 'Session about Jira triage',
}

const CTX_NODES: GraphMemoryNode[] = [
  node('s-1'),
  node('s-2'),
  node('s-old', { forgotten: true }),
  node('s-ghost'),
  node('d-1', { memoryType: 'digest' }),
  node('e-1', { memoryType: 'episode' }),
]

const CTX_LINKS: FakeLink[] = [
  ctxLink('s-1', 'ctx-kam', 'Kam', EDGE_PROPS),
  ctxLink('s-1', 'ctx-pg', 'PostgREST', { weight: 0.3 }),
  ctxLink('s-1', 'ctx-jira', 'Jira', { weight: 0.21, createdAt: '2026-09-02T00:00:00Z' }),
  ctxLink('s-2', 'ctx-solo', 'Orphanly', EDGE_PROPS),
  ctxLink('s-2', 'ctx-atlas', 'Atlas', { weight: 0.1 }),
  ctxLink('s-old', 'ctx-kam', 'Kam', { weight: 0.5 }),
  ctxLink('s-old', 'ctx-pg', 'PostgREST', { weight: 0.5 }),
  ctxLink('s-ghost', 'ctx-kam', 'Kam', { weight: 0.9 }),
  ctxLink('d-1', 'ctx-kam', 'Kam', { weight: 0.6 }),
  ctxLink('d-1', 'ctx-jira', 'Jira', { weight: 0.6 }),
  // An episode keeps Atlas linked from a live memory once the fact's edge goes.
  ctxLink('e-1', 'ctx-atlas', 'Atlas', {}, 'SPOKE'),
]

const PRUNED = [
  { memoryId: 's-1', ctxId: 'ctx-jira' },
  { memoryId: 's-2', ctxId: 'ctx-solo' },
  { memoryId: 's-2', ctxId: 'ctx-atlas' },
  { memoryId: 's-old', ctxId: 'ctx-pg' },
  { memoryId: 'd-1', ctxId: 'ctx-kam' },
]

const PRUNE_ARGS = ['--apply', '--prune-context-links', '--undo-log', 'u.jsonl']

const pairKey = (l: { memoryId: string; ctxId: string }): string => `${l.memoryId}->${l.ctxId}`
const contextPairs = (links: readonly FakeLink[]): string[] =>
  links.filter((l) => l.type === 'CONTEXTUAL').map(pairKey).sort()

describe('context links', () => {
  it('a dry run reports per tier and liveness, skips nodes without a row, and writes nothing', async () => {
    const { events, logs, run } = harness([], CTX_NODES, CTX_TABLES, CTX_LINKS, CTX_TEXTS)

    const outcome = await run()

    expect(events).toEqual([])
    const report = outcome.contextLinks.before
    expect(report.tiers.semantic.live).toEqual({ nodes: 2, edges: 5, kept: 2, pruned: 3, zeroLinks: 1 })
    expect(report.tiers.semantic.retired).toEqual({ nodes: 1, edges: 2, kept: 1, pruned: 1, zeroLinks: 0 })
    expect(report.tiers.digest.live).toEqual({ nodes: 1, edges: 2, kept: 1, pruned: 1, zeroLinks: 0 })
    expect(report.tiers.digest.retired).toEqual({ nodes: 0, edges: 0, kept: 0, pruned: 0, zeroLinks: 0 })
    expect(report.skippedNoRow).toBe(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('semantic live      nodes 2, edges 5, kept 2, pruned 3, left with 0 links 1')
    expect(logs[0]).toContain('nodes without a SQL row (skipped): 1')
    expect(logs[0]).toContain('context link prune not requested')
    for (const leak of ['s-1', 's-ghost', 'd-1', CTX_TEXTS['s-1']!]) expect(logs[0]).not.toContain(leak)
  })

  it('reports an entity whose only live link is a pruned edge, and no entity another live memory still links', async () => {
    const { logs, run } = harness([], CTX_NODES, CTX_TABLES, CTX_LINKS, CTX_TEXTS)

    const outcome = await run()

    expect(outcome.contextLinks.before.orphanedEntities).toEqual([{ name: 'Orphanly' }])
    expect(logs[0]).toContain('entities losing their last live link: 1\n    - "Orphanly"')
  })

  it('--apply prunes exactly the unnamed edges, each batch after its undo lines, and nothing else when other checks are clean', async () => {
    const { events, graph, logs, run } = harness(
      ['--apply', '--prune-context-links', '--undo-log', 'u.jsonl', '--batch-size', '2'],
      CTX_NODES,
      CTX_TABLES,
      CTX_LINKS,
      CTX_TEXTS,
    )

    const outcome = await run()

    expect(events.every((e) => e.kind === 'undo' || e.kind === 'ctx')).toBe(true)
    const deleted = events.flatMap((e) => (e.kind === 'ctx' ? e.links : []))
    expect(deleted.map(pairKey).sort()).toEqual(PRUNED.map(pairKey).sort())
    events.forEach((e, i) => {
      if (e.kind !== 'ctx') return
      expect(e.links.length).toBeLessThanOrEqual(2)
      const prev = events[i - 1]
      expect(prev?.kind === 'undo' && prev.lines.map((l) => (l.op === 'ctx' ? pairKey(l) : null))).toEqual(
        e.links.map(pairKey),
      )
    })
    const undo = events.flatMap((e) => (e.kind === 'undo' ? e.lines : []))
    expect(undo).toContainEqual({
      op: 'ctx',
      memoryId: 's-2',
      ctxId: 'ctx-solo',
      ctxLabel: 'Entity',
      ctxNodeId: 'ctx-solo',
      props: EDGE_PROPS,
    })

    expect(outcome.contextLinks.pruned).toBe(5)
    expect(outcome.written).toEqual({ stamped: 0, projects: 0, tiers: 0, deleted: 0, skippedChangedSinceSnapshot: 0 })
    expect(contextPairs(graph.links)).toEqual(
      ['s-1->ctx-kam', 's-1->ctx-pg', 's-old->ctx-kam', 's-ghost->ctx-kam', 'd-1->ctx-jira'].sort(),
    )
    expect(outcome.contextLinks.after?.tiers.semantic.live.pruned).toBe(0)
    expect(outcome.contextLinks.after?.orphanedEntities).toEqual([])
    expect(logs).toContainEqual(expect.stringContaining('context links pruned 5'))
  })

  it('undo re-creates every pruned edge with its properties and leaves other undo lines alone', async () => {
    const applied = harness(PRUNE_ARGS, CTX_NODES, CTX_TABLES, CTX_LINKS, CTX_TEXTS)
    await applied.run()
    const lines = applied.events.flatMap((e) => (e.kind === 'undo' ? e.lines : []))
    const undoText =
      [{ op: 'stamp', id: 's-1', at: '2026-10-01T00:00:00.000Z' }, ...lines].map((l) => JSON.stringify(l)).join('\n') +
      '\n'
    const logs: string[] = []

    const result = await undoContextLinks(applied.graph, (l) => logs.push(l), undoText, 2)

    expect(result).toEqual({ restored: 5, requested: 5, unmatched: 0, other: 1 })
    const byPair = (links: readonly FakeLink[]) =>
      Object.fromEntries(links.filter((l) => l.type === 'CONTEXTUAL').map((l) => [pairKey(l), l.props]))
    expect(byPair(applied.graph.links)).toEqual(byPair(CTX_LINKS))
    expect(logs[0]).toContain('context links restored: 5 of 5')
    expect(logs[0]).toContain('unmatched (memory or context node not found): 0')
    expect(logs[0]).toContain('other undo lines left as they are: 1')
  })

  it('undo counts a line whose context node no longer exists as unmatched', async () => {
    const applied = harness(PRUNE_ARGS, CTX_NODES, CTX_TABLES, CTX_LINKS, CTX_TEXTS)
    await applied.run()
    const lines = applied.events.flatMap((e) => (e.kind === 'undo' ? e.lines : []))
    applied.graph.ctxNodes.delete('ctx-solo')
    const logs: string[] = []

    const result = await undoContextLinks(
      applied.graph,
      (l) => logs.push(l),
      lines.map((l) => JSON.stringify(l)).join('\n'),
      10,
    )

    expect(result).toEqual({ restored: 4, requested: 5, unmatched: 1, other: 0 })
    expect(contextPairs(applied.graph.links)).not.toContain('s-2->ctx-solo')
    expect(logs[0]).toContain('unmatched (memory or context node not found): 1')
  })

  it('undo refuses a ctx line whose label is not a context label', async () => {
    const line = { op: 'ctx', memoryId: 's-1', ctxId: 'x', ctxLabel: 'Memory`) DETACH DELETE (n', ctxNodeId: 'x', props: {} }
    const graph = fakeGraph(CTX_NODES, [], CTX_LINKS)

    await expect(undoContextLinks(graph, () => {}, JSON.stringify(line), 10)).rejects.toThrow(/unknown context label/)
    await expect(
      undoContextLinks(graph, () => {}, JSON.stringify({ ...line, ctxLabel: 'Entity', ctxNodeId: undefined }), 10),
    ).rejects.toThrow(/malformed ctx line/)
  })

  it('--apply without --prune-context-links deletes no context link but still reports the planned prune', async () => {
    const { events, graph, logs, run } = harness(['--apply', '--undo-log', 'u.jsonl'], CTX_NODES, CTX_TABLES, CTX_LINKS, CTX_TEXTS)

    const outcome = await run()

    expect(events.filter((e) => e.kind === 'ctx')).toEqual([])
    expect(events.flatMap((e) => (e.kind === 'undo' ? e.lines : [])).filter((l) => l.op === 'ctx')).toEqual([])
    expect(contextPairs(graph.links)).toEqual(contextPairs(CTX_LINKS))
    expect(outcome.contextLinks.pruned).toBe(0)
    expect(outcome.contextLinks.before.tiers.semantic.live.pruned).toBe(3)
    expect(outcome.contextLinks.after?.tiers.semantic.live.pruned).toBe(3)
    expect(logs[0]).toContain('context link prune not requested')
    expect(logs).toContainEqual(expect.stringContaining('context links pruned 0 (not requested)'))
  })

  it('a node without a SQL row keeps every link', async () => {
    const { graph, run } = harness(PRUNE_ARGS, CTX_NODES, CTX_TABLES, CTX_LINKS, CTX_TEXTS)

    await run()

    expect(contextPairs(graph.links.filter((l) => l.memoryId === 's-ghost'))).toEqual(['s-ghost->ctx-kam'])
  })
})
