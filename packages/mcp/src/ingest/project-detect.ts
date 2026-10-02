/**
 * Project detection from a working directory.
 *
 * The rule: walk up from cwd to the nearest `.git` entry and name the
 * repository that owns it.
 *   - `.git` directory → the directory that contains it.
 *   - `.git` file pointing at a linked worktree's admin dir (it carries a
 *     `commondir` file) → the repository owning the common git dir, so every
 *     worktree of a repo shares one tag with its main checkout.
 *   - `.git` file of a submodule (no `commondir`) → the submodule's own
 *     directory; it is a separate codebase.
 * No git ancestor → null (shared). A directory name outside any repository
 * (a home dir, ~/.claude, /tmp, an org folder) says nothing about which
 * codebase a memory belongs to, and tagging it would scatter shared
 * knowledge across meaningless buckets.
 *
 * Monorepo subpackages coarsen to the repository (first git ancestor wins):
 * `engram/packages/core` and `engram/packages/graph` are one codebase.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { SalienceCategory } from '@engram-mem/core'
import { loadProjectRoots, projectForRoot } from './project-roots.js'

/** At most this many parent directories: bounds pathological trees and symlink loops. */
const MAX_ANCESTORS = 20

export function detectProject(cwd: string = process.cwd()): string | null {
  let current = resolve(cwd)

  for (let i = 0; i < MAX_ANCESTORS; i++) {
    const gitPath = `${current}/.git`
    if (existsSync(gitPath)) {
      return repositoryNameFor(current, gitPath)
    }

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return null
}

function repositoryNameFor(checkoutDir: string, gitPath: string): string | null {
  const own = basename(checkoutDir) || null
  const gitDir = readGitDirPointer(gitPath, checkoutDir)
  if (!gitDir) return own

  const commonDir = readCommonDir(gitDir)
  if (!commonDir) return own

  return repositoryNameFromCommonDir(commonDir) ?? own
}

/**
 * The admin git dir a `.git` file points at, or null when `.git` is a
 * directory or the file is not a `gitdir:` pointer. Relative pointers are
 * relative to the directory holding the `.git` file.
 */
function readGitDirPointer(gitPath: string, checkoutDir: string): string | null {
  try {
    if (!statSync(gitPath).isFile()) return null
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitPath, 'utf8'))
    if (!match?.[1]) return null
    return isAbsolute(match[1]) ? match[1] : resolve(checkoutDir, match[1])
  } catch {
    return null
  }
}

/** A linked worktree's admin dir names the shared git dir in `commondir`. */
function readCommonDir(gitDir: string): string | null {
  try {
    const raw = readFileSync(`${gitDir}/commondir`, 'utf8').trim()
    if (!raw) return null
    return isAbsolute(raw) ? raw : resolve(gitDir, raw)
  } catch {
    return null
  }
}

/**
 * `<repo>/.git` → `<repo>`; a submodule's `<super>/.git/modules/<name>` →
 * `<name>`; a bare `<name>.git` → `<name>`.
 */
function repositoryNameFromCommonDir(commonDir: string): string | null {
  const name = basename(commonDir)
  if (name === '.git') return basename(dirname(commonDir)) || null
  if (basename(dirname(commonDir)) === 'modules') return name || null
  return name.replace(/\.git$/, '') || null
}

/**
 * Identifiers that mean "no project — shared across all projects". They map
 * to a NULL `project_id`.
 */
const SHARED_ALIASES = new Set(['global', 'none', 'shared'])

function isSharedAlias(id: string): boolean {
  return SHARED_ALIASES.has(id.toLowerCase())
}

/**
 * Resolve the project for an ingestion from the `--project` flag.
 * `auto` → resolveProjectScope (ENGRAM_PROJECT_ID, the repository, then a
 * configured root);
 * `none` or any other shared alias → null (shared); anything else → that
 * name verbatim. The same resolution feeds the stored `project_id` and the
 * `metadata.project` tag so the two never disagree.
 */
export function resolveProject(
  flag: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (flag === 'auto') return resolveProjectScope({ env, cwd }).id
  return normalizeProjectId(flag) ?? null
}

/**
 * Normalise a caller-supplied project id: trimmed, and blank or shared
 * aliases become undefined (shared).
 */
export function normalizeProjectId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim()
  if (!id || isSharedAlias(id)) return undefined
  return id
}

/**
 * Salience categories that describe the user or people rather than one
 * codebase: working-style preferences, who someone is, and priority
 * signals apply in every project, so they are stored shared.
 */
const CROSS_CUTTING_CATEGORIES: ReadonlySet<SalienceCategory> = new Set<SalienceCategory>([
  'preference',
  'identity',
  'emotional_signal',
])

/**
 * True when a category (possibly read back from stored metadata, so any
 * value) names a cross-cutting kind that is stored shared.
 */
export function isCrossCuttingCategory(category: unknown): boolean {
  return (
    typeof category === 'string' &&
    CROSS_CUTTING_CATEGORIES.has(category as SalienceCategory)
  )
}

/** The project to store a classified memory under: null for cross-cutting kinds. */
export function projectForCategory(
  project: string | null,
  category: SalienceCategory,
): string | null {
  if (isCrossCuttingCategory(category)) return null
  return project
}

/**
 * The hard-isolation project scope used for the `project_id` storage column
 * (distinct from the soft `metadata.project` tag, though resolved from the
 * same identifier). NULL means the shared bucket — visible to every project.
 */
export type ProjectScopeSource = 'env' | 'detected' | 'root' | 'unscoped'

export interface ProjectScope {
  /** Canonical project id, or null for the shared bucket. */
  id: string | null
  /** Where the id came from — surfaced in the startup log. */
  source: ProjectScopeSource
}

/**
 * Resolve the hard project scope for ingest + recall.
 *
 * Order (first match wins):
 *   1. ENGRAM_PROJECT_ID env var (explicit) — required for the remote HTTP
 *      server, which has no project cwd. A shared alias ('global'/'none'/
 *      'shared') explicitly selects the shared bucket.
 *   2. detectProject(cwd) — the owning repository's name (worktrees resolve
 *      to their main repository), drift-free across clone methods.
 *   3. The longest configured root containing cwd (`roots` in
 *      ENGRAM_PROJECT_GROUPS_FILE) — names the project for a directory that
 *      is not a repository, such as a multi-repo workspace folder.
 *   4. null — shared bucket (the safe, non-isolating default).
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
    if (isSharedAlias(explicit)) {
      return { id: null, source: 'env' }
    }
    return { id: explicit, source: 'env' }
  }

  const detected = detectProject(cwd)
  if (detected && !isSharedAlias(detected)) {
    return { id: detected, source: 'detected' }
  }
  if (detected) return { id: null, source: 'unscoped' }

  const rooted = normalizeProjectId(
    projectForRoot(cwd, loadProjectRoots(env['ENGRAM_PROJECT_GROUPS_FILE'])),
  )
  if (rooted) return { id: rooted, source: 'root' }
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
  const src =
    scope.source === 'env'
      ? 'ENGRAM_PROJECT_ID'
      : scope.source === 'root'
        ? 'configured root'
        : 'detected from cwd'
  return `project scope: ${scope.id} (source: ${src})`
}
