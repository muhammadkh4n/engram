/**
 * Planning for the SQL ↔ Neo4j memory reconcile. The SQL tables are the
 * source of truth; the graph is a derived index that drifts when a write to one
 * store succeeds and the other fails. `planReconcile` and the formatting are
 * pure; `runReconcile` drives I/O only through the injected source and graph.
 */

import { nextCursor, type PageCursor } from './ingest/embed-backfill-lib.js'

export type SqlTier = 'episode' | 'digest' | 'semantic' | 'procedural'

export const SQL_TIERS: readonly SqlTier[] = ['episode', 'digest', 'semantic', 'procedural']

export interface SqlMemoryRow {
  id: string
  tier: SqlTier
  projectId: string | null
  /** `forgotten_at` is set, or, for semantic rows, `superseded_by` is set. */
  inactive: boolean
}

export interface GraphMemoryNode {
  id: string
  memoryType: string | null
  projectId: string | null
  /** The node carries `forgottenAt`. */
  forgotten: boolean
  /** Relationship count; 0 makes the node an orphan. */
  degree: number
}

export interface ProjectChange {
  id: string
  projectId: string
  before: string | null
}

export interface ReconcilePlan {
  /** Nodes to stamp with `forgottenAt` because their SQL row is inactive. */
  stamp: string[]
  /** Nodes whose `projectId` differs from the project SQL records for the row. */
  setProject: ProjectChange[]
  /** Nodes with no SQL row in any tier, untyped nodes included. */
  missing: string[]
  orphans: { live: number; inactive: number; missing: number }
  /** Orphans whose row is inactive or absent. A live row's node is never listed. */
  deletableOrphans: string[]
  liveWithoutNode: Record<SqlTier, number>
  /** Nodes whose `memoryType` differs from the tier of their SQL row. */
  tierMismatch: number
  totals: { rows: number; nodes: number }
}

const key = (id: string): string => id.toLowerCase()

function indexRows(rows: readonly SqlMemoryRow[]): Map<string, SqlMemoryRow> {
  const byId = new Map<string, SqlMemoryRow>()
  for (const row of rows) {
    const k = key(row.id)
    if (!byId.has(k)) byId.set(k, row)
  }
  return byId
}

export function planReconcile(
  rows: readonly SqlMemoryRow[],
  nodes: readonly GraphMemoryNode[],
): ReconcilePlan {
  const rowsById = indexRows(rows)
  const nodeIds = new Set<string>()
  const stamp: string[] = []
  const setProject: ProjectChange[] = []
  const missing: string[] = []
  const deletableOrphans: string[] = []
  const orphans = { live: 0, inactive: 0, missing: 0 }
  let tierMismatch = 0

  for (const node of nodes) {
    nodeIds.add(key(node.id))
    const row = rowsById.get(key(node.id))
    const isOrphan = node.degree === 0

    if (!row) {
      missing.push(node.id)
      if (isOrphan) {
        orphans.missing++
        deletableOrphans.push(node.id)
      }
      continue
    }

    if (row.inactive && !node.forgotten) stamp.push(node.id)
    if (row.projectId !== null && row.projectId !== node.projectId) {
      setProject.push({ id: node.id, projectId: row.projectId, before: node.projectId })
    }
    if (node.memoryType !== row.tier) tierMismatch++

    if (isOrphan) {
      if (row.inactive) {
        orphans.inactive++
        deletableOrphans.push(node.id)
      } else {
        orphans.live++
      }
    }
  }

  const liveWithoutNode: Record<SqlTier, number> = { episode: 0, digest: 0, semantic: 0, procedural: 0 }
  for (const [k, row] of rowsById) {
    if (!row.inactive && !nodeIds.has(k)) liveWithoutNode[row.tier]++
  }

  return {
    stamp,
    setProject,
    missing,
    orphans,
    deletableOrphans,
    liveWithoutNode,
    tierMismatch,
    totals: { rows: rowsById.size, nodes: nodes.length },
  }
}

export interface ReconcileArgs {
  apply: boolean
  deleteMissing: boolean
  deleteOrphans: boolean
  undoLog: string | null
  pageSize: number
  batchSize: number
  help: boolean
}

export class ReconcileArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReconcileArgsError'
  }
}

function positiveInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (raw === undefined || !Number.isInteger(n) || n <= 0) {
    throw new ReconcileArgsError(
      `--${flag} requires a positive integer, got ${raw === undefined ? '(missing value)' : `"${raw}"`}`,
    )
  }
  return n
}

function requiredValue(raw: string | undefined, flag: string): string {
  const value = raw?.trim()
  if (!value || value.startsWith('--')) throw new ReconcileArgsError(`--${flag} requires a value`)
  return value
}

export function parseReconcileArgs(argv: readonly string[]): ReconcileArgs {
  const args: ReconcileArgs = {
    apply: false,
    deleteMissing: false,
    deleteOrphans: false,
    undoLog: null,
    pageSize: 1000,
    batchSize: 1000,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--delete-missing') args.deleteMissing = true
    else if (a === '--delete-orphans') args.deleteOrphans = true
    else if (a === '--undo-log') args.undoLog = requiredValue(argv[++i], 'undo-log')
    else if (a === '--page-size') args.pageSize = positiveInt(argv[++i], 'page-size')
    else if (a === '--batch-size') args.batchSize = positiveInt(argv[++i], 'batch-size')
    else if (a === '--help' || a === '-h') args.help = true
    else throw new ReconcileArgsError(`unknown argument "${a}"`)
  }

  const writes = args.apply || args.deleteMissing || args.deleteOrphans
  if (writes && args.undoLog === null) {
    throw new ReconcileArgsError('--apply, --delete-missing and --delete-orphans require --undo-log <path>')
  }
  // A delete flag alone would otherwise read as a dry run that still deletes.
  if ((args.deleteMissing || args.deleteOrphans) && !args.apply) {
    throw new ReconcileArgsError('--delete-missing and --delete-orphans require --apply')
  }
  return args
}

/** Counts only: ids and content stay out of the output so it is safe to paste into a log or a ticket. */
export function formatReconcileReport(plan: ReconcilePlan): string {
  const lines = [
    `sql rows:              ${plan.totals.rows}`,
    `graph nodes:           ${plan.totals.nodes}`,
    `stamp forgottenAt:     ${plan.stamp.length}`,
    `set projectId:         ${plan.setProject.length}`,
    `nodes without a row:   ${plan.missing.length}`,
    `tier mismatch:         ${plan.tierMismatch}`,
    `orphans:               live ${plan.orphans.live}, inactive ${plan.orphans.inactive}, missing ${plan.orphans.missing}`,
    `deletable orphans:     ${plan.deletableOrphans.length}`,
    `live rows without node: ${SQL_TIERS.map((t) => `${t} ${plan.liveWithoutNode[t]}`).join(', ')}`,
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Orchestration over an injected SQL source and graph
// ---------------------------------------------------------------------------

/** One SQL row as read for the reconcile; tiers without a column leave it undefined. */
export interface SqlSourceRow {
  id: string
  created_at: string
  project_id: string | null
  forgotten_at?: string | null
  superseded_by?: string | null
}

export interface ReconcileSqlSource {
  /** Rows of `tier` strictly after `cursor`, ordered by (created_at, id). */
  fetchPage(tier: SqlTier, cursor: PageCursor | null, pageSize: number): Promise<SqlSourceRow[]>
  /** Every row of `tier` whose id is in `ids`, forgotten and superseded rows included. */
  fetchByIds(tier: SqlTier, ids: readonly string[]): Promise<SqlSourceRow[]>
}

export interface ReconcileGraph {
  /** Memory nodes with an id strictly after `after` (all when null), ordered by id. */
  fetchNodePage(after: string | null, limit: number): Promise<GraphMemoryNode[]>
  /** Sets `forgottenAt` on nodes that lack it. */
  forgetMemories(ids: string[]): Promise<number>
  setProjects(rows: Array<{ id: string; projectId: string }>): Promise<void>
  deleteNodes(ids: string[]): Promise<number>
}

export type UndoLine =
  | { op: 'stamp'; id: string; at: string }
  | { op: 'project'; id: string; before: string | null }
  | { op: 'delete'; id: string; memoryType: string | null; projectId: string | null }

export interface ReconcileDeps {
  sql: ReconcileSqlSource
  graph: ReconcileGraph
  /** Must persist the lines before resolving: the batch they describe runs only afterwards. */
  appendUndo(lines: readonly UndoLine[]): Promise<void>
  log(line: string): void
  now?: () => string
  nodePageSize?: number
}

export interface ReconcileOutcome {
  before: ReconcilePlan
  after: ReconcilePlan | null
  written: { stamped: number; projects: number; deleted: number; skippedChangedSinceSnapshot: number }
}

export const DEFAULT_NODE_PAGE_SIZE = 5000

export async function readSqlRows(
  sql: ReconcileSqlSource,
  pageSize: number,
): Promise<SqlMemoryRow[]> {
  const rows: SqlMemoryRow[] = []
  for (const tier of SQL_TIERS) {
    let cursor: PageCursor | null = null
    // An empty page ends the tier: a short page may only mean the server capped the response.
    for (;;) {
      const page = await sql.fetchPage(tier, cursor, pageSize)
      if (page.length === 0) break
      for (const r of page) {
        rows.push({
          id: r.id,
          tier,
          projectId: r.project_id ?? null,
          inactive: r.forgotten_at != null || r.superseded_by != null,
        })
      }
      cursor = nextCursor(page)
    }
  }
  return rows
}

/**
 * Pages by key rather than by offset: nodes written while the read runs would
 * otherwise shift the offsets, reading some nodes twice and skipping others.
 */
export async function readGraphNodes(graph: ReconcileGraph, pageSize: number): Promise<GraphMemoryNode[]> {
  const nodes: GraphMemoryNode[] = []
  let after: string | null = null
  for (;;) {
    const page = await graph.fetchNodePage(after, pageSize)
    nodes.push(...page)
    if (page.length < pageSize) break
    after = page[page.length - 1]!.id
  }
  return nodes
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Delete targets, deduplicated, with every id whose SQL row is live removed. */
function deleteTargets(plan: ReconcilePlan, args: ReconcileArgs, liveIds: ReadonlySet<string>): string[] {
  const ids = new Map<string, string>()
  if (args.deleteMissing) for (const id of plan.missing) ids.set(key(id), id)
  if (args.deleteOrphans) for (const id of plan.deletableOrphans) ids.set(key(id), id)
  for (const k of ids.keys()) {
    if (liveIds.has(k)) throw new Error('refusing to delete the graph node of a live SQL row')
  }
  return [...ids.values()]
}

/** Whether each id has a live row now: true live, false only inactive rows, absent no row at all. */
async function currentRowState(sql: ReconcileSqlSource, ids: readonly string[]): Promise<Map<string, boolean>> {
  const live = new Map<string, boolean>()
  for (const tier of SQL_TIERS) {
    for (const r of await sql.fetchByIds(tier, ids)) {
      const isLive = r.forgotten_at == null && r.superseded_by == null
      live.set(key(r.id), (live.get(key(r.id)) ?? false) || isLive)
    }
  }
  return live
}

/**
 * The snapshot is read before the graph, so a memory written meanwhile has a
 * node but no snapshot row, and a restored row still reads as inactive. A
 * candidate is deleted only if it still qualifies against SQL as it is now.
 */
function stillDeletable(snapshot: SqlMemoryRow | undefined, liveNow: boolean | undefined): boolean {
  if (snapshot === undefined) return liveNow === undefined
  return snapshot.inactive && liveNow === false
}

export async function runReconcile(deps: ReconcileDeps, args: ReconcileArgs): Promise<ReconcileOutcome> {
  const now = deps.now ?? (() => new Date().toISOString())
  const nodePageSize = deps.nodePageSize ?? DEFAULT_NODE_PAGE_SIZE

  const rows = await readSqlRows(deps.sql, args.pageSize)
  const nodes = await readGraphNodes(deps.graph, nodePageSize)
  const before = planReconcile(rows, nodes)
  deps.log(formatReconcileReport(before))

  const written = { stamped: 0, projects: 0, deleted: 0, skippedChangedSinceSnapshot: 0 }
  if (!args.apply) return { before, after: null, written }

  for (const batch of chunks(before.stamp, args.batchSize)) {
    const at = now()
    await deps.appendUndo(batch.map((id) => ({ op: 'stamp', id, at })))
    written.stamped += await deps.graph.forgetMemories(batch)
  }

  for (const batch of chunks(before.setProject, args.batchSize)) {
    await deps.appendUndo(batch.map((c) => ({ op: 'project', id: c.id, before: c.before })))
    await deps.graph.setProjects(batch.map((c) => ({ id: c.id, projectId: c.projectId })))
    written.projects += batch.length
  }

  const liveIds = new Set(rows.filter((r) => !r.inactive).map((r) => key(r.id)))
  const nodesById = new Map(nodes.map((n) => [key(n.id), n]))
  const snapshotById = indexRows(rows)
  for (const candidates of chunks(deleteTargets(before, args, liveIds), args.batchSize)) {
    const liveNow = await currentRowState(deps.sql, candidates)
    const batch = candidates.filter((id) => stillDeletable(snapshotById.get(key(id)), liveNow.get(key(id))))
    written.skippedChangedSinceSnapshot += candidates.length - batch.length
    if (batch.length === 0) continue
    await deps.appendUndo(
      batch.map((id) => {
        const n = nodesById.get(key(id))
        return { op: 'delete', id, memoryType: n?.memoryType ?? null, projectId: n?.projectId ?? null }
      }),
    )
    written.deleted += await deps.graph.deleteNodes(batch)
  }

  deps.log(
    `written: stamped ${written.stamped}, projects ${written.projects}, deleted ${written.deleted}, ` +
      `skipped (changed since snapshot) ${written.skippedChangedSinceSnapshot}`,
  )
  const after = planReconcile(rows, await readGraphNodes(deps.graph, nodePageSize))
  deps.log(formatReconcileReport(after))
  return { before, after, written }
}
