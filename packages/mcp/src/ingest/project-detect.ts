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
