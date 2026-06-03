/**
 * Project detection from a working directory.
 *
 * The rule: walk up from cwd looking for a `.git` directory. Use the
 * basename of the directory that contains it. If no git ancestor is
 * found, fall back to the basename of cwd. Ultimate fallback: 'global'.
 *
 * This coarsens monorepo subpackages into a single project (first git
 * ancestor wins), which is the right call for project-scoped recall:
 * memories within `engram/packages/core` and `engram/packages/graph`
 * should share the same project tag because they're the same codebase.
 */

import { existsSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

export function detectProject(cwd: string = process.cwd()): string {
  const absolute = resolve(cwd)
  let current = absolute

  // Safety bound: at most 20 parent directories. Protects against
  // pathological filesystems and symlink loops.
  for (let i = 0; i < 20; i++) {
    const gitPath = `${current}/.git`
    if (existsSync(gitPath)) {
      // .git can be a directory (normal repo) or a file (git worktree /
      // submodule pointer). Either way, the containing dir is the repo.
      try {
        const name = basename(current)
        return name || 'global'
      } catch {
        return 'global'
      }
    }

    const parent = dirname(current)
    if (parent === current) {
      // Reached filesystem root
      break
    }
    current = parent
  }

  // No git ancestor found. Use basename of cwd.
  try {
    const st = statSync(absolute)
    if (st.isDirectory()) {
      const name = basename(absolute)
      return name || 'global'
    }
  } catch {
    // fall through
  }
  return 'global'
}

/**
 * Resolve the project identifier to use for an ingestion, given the
 * user's --project flag. `auto` → detectProject(cwd). `none` → the
 * global bucket. Any other string → that string verbatim (caller
 * explicitly named a project).
 */
export function resolveProject(flag: string, cwd: string = process.cwd()): string {
  if (flag === 'none') return 'global'
  if (flag === 'auto') return detectProject(cwd)
  return flag
}


/**
 * The hard-isolation project scope used for the `project_id` storage column
 * (distinct from the soft `metadata.project` tag, though resolved from the
 * same identifier). NULL means the shared bucket — visible to every project.
 */
export type ProjectScopeSource = 'env' | 'detected' | 'unscoped'

export interface ProjectScope {
  /** Canonical project id, or null for the shared bucket. */
  id: string | null
  /** Where the id came from — surfaced in the startup log. */
  source: ProjectScopeSource
}

/**
 * Identifiers that mean "no isolation — shared across all projects". These
 * map to a NULL `project_id` so they match every scoped recall (the SQL
 * filter treats NULL rows as shared).
 */
const SHARED_ALIASES = new Set(['global', 'none', 'shared'])

/**
 * Resolve the hard project scope for ingest + recall.
 *
 * Order (first match wins):
 *   1. ENGRAM_PROJECT_ID env var (explicit) — required for the remote HTTP
 *      server, which has no project cwd. A shared alias ('global'/'none'/
 *      'shared') explicitly selects the shared bucket.
 *   2. detectProject(cwd) — repo basename, drift-free across clone methods and
 *      already the convention behind the soft `metadata.project` tag.
 *   3. null — shared bucket (the safe, non-isolating default).
 *
 * Ingest and recall MUST resolve through this single function so the tag
 * written and the filter applied always agree; otherwise scoped recall
 * silently returns nothing.
 */
export function resolveProjectScope(
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): ProjectScope {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()

  const explicit = env['ENGRAM_PROJECT_ID']?.trim()
  if (explicit) {
    if (SHARED_ALIASES.has(explicit.toLowerCase())) {
      return { id: null, source: 'env' }
    }
    return { id: explicit, source: 'env' }
  }

  const detected = detectProject(cwd)
  if (detected && !SHARED_ALIASES.has(detected.toLowerCase())) {
    return { id: detected, source: 'detected' }
  }
  return { id: null, source: 'unscoped' }
}

/**
 * Human-readable one-liner for the startup log. Always emitted so scoping is
 * never silent — a silent mis-scope is the dangerous failure mode for an
 * isolation boundary.
 */
export function formatScopeLog(scope: ProjectScope): string {
  if (scope.id === null) {
    return 'project scope: <shared — all projects> (set ENGRAM_PROJECT_ID to isolate)'
  }
  const src = scope.source === 'env' ? 'ENGRAM_PROJECT_ID' : 'detected from cwd'
  return `project scope: ${scope.id} (source: ${src})`
}
