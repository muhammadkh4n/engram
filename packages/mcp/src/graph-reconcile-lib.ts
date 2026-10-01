/**
 * Pure planning for the SQL ↔ Neo4j memory reconcile. The SQL tables are the
 * source of truth; the graph is a derived index that drifts when a write to one
 * store succeeds and the other fails. Nothing here performs I/O.
 */

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
