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

/**
 * Server-side storage for capture: the project registry rows the route checks
 * event scope against. The database applies the table rules, so an
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
}
