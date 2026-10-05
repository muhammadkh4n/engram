/**
 * One row of `memory_projects`: a project or a workspace that items and
 * capture events may name. A workspace belongs to no workspace itself.
 */
export interface ProjectRow {
  id: string
  kind: 'project' | 'workspace'
  workspaceId: string | null
  vaultFolder: string | null
  registerPrefix: string | null
}

/** The tables the stored-secret scan reads. */
export const SCAN_TARGETS = ['memory_items', 'memory_capture_events'] as const
export type ScanTarget = (typeof SCAN_TARGETS)[number]

/**
 * One stored row as the stored-secret scan reads it: its id and every text
 * it holds that a secret could sit in. For an item: content, context,
 * search_text and the keys and string values of source. For a capture event:
 * the keys and string values of payload, cwd, the string values of project,
 * and plan_dirs.
 */
export interface ScanRow {
  id: string
  texts: string[]
}

/**
 * Server-side storage for capture: the project registry rows the route checks
 * event scope against, and the paged read of stored text the stored-secret
 * scan runs over. The database applies the table rules, so an
 * implementation forwards writes and reports a refused rule as
 * `ItemConstraintError`.
 */
export interface CaptureStore {
  /**
   * Upserts every row, workspaces before projects, and never deletes one: a
   * row missing from `rows` keeps its last values. Returns how many rows were
   * inserted or changed.
   */
  syncProjects(rows: readonly ProjectRow[]): Promise<number>

  /**
   * Up to `limit` rows of `target` with an id above `afterId` (every row when
   * null), by id ascending. Read only.
   */
  scanPage(target: ScanTarget, afterId: string | null, limit: number): Promise<ScanRow[]>
}
