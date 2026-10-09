/**
 * The project and workspace a backfilled event belongs to, from a stored
 * project name or from a working directory that may no longer exist.
 *
 * Live capture asks git (`resolveEventProject`), which needs the checkout on
 * disk. Old sessions name worktrees long removed, folders renamed and roots
 * that moved, so the backfill resolves names against the project registry
 * instead: a repository is a registered project, a linked worktree named
 * `<repo>-<slug>` folds into the longest registered `<repo>`, and a folder
 * that is neither names nothing. A workspace never becomes a project id.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { loadProjectRegistry, type ProjectRegistry } from '../capture-events/project-registry.js'
import { resolveTag, type ResolutionReason } from '../ingest/project-backfill-lib.js'

type Env = Record<string, string | undefined>

export type ResolverRule =
  /** `--overrides` named the value. */
  | 'override'
  /** A registered project, by its exact name. */
  | 'repository'
  /** `<repo>-<slug>` folded into the longest registered `<repo>`. */
  | 'worktree'
  /** A registered workspace id, or a path at or below a workspace root that names no project. */
  | 'workspace'
  /** A dot-folder, `tmp`, `home` and the like: never a repository. */
  | 'no-repo'
  /** Blank or a shared alias (`global`, `none`, `shared`). */
  | 'shared-alias'
  /** A name the registry does not know, or a path none of whose segments resolves. */
  | 'unregistered'

export interface ProjectResolution {
  project_id: string | null
  workspace_id: string | null
  rule: ResolverRule
  raw: string
}

/** The registry with every workspace root absolute, and the overrides (raw value → project name or null). */
export interface ResolverConfig {
  registry: ProjectRegistry
  overrides: ReadonlyMap<string, string | null>
}

export type ProjectResolver = (raw: string) => ProjectResolution

const WORKTREES_MARK = `${sep}.claude${sep}worktrees${sep}`

function expandHome(path: string, env: Env): string {
  const home = env.HOME || homedir()
  return path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path
}

/** Reads the registry file; a missing, unreadable or invalid file throws. Workspace roots come back absolute. */
export function loadResolverRegistry(path: string, env: Env): ProjectRegistry {
  const registry = loadProjectRegistry(expandHome(path, env))
  const workspaces = new Map(
    [...registry.workspaces].map(([id, w]) => [id, { ...w, root: resolve(expandHome(w.root, env)) }] as const),
  )
  return { ...registry, workspaces }
}

/**
 * Reads an overrides file: a JSON object mapping a raw value to a project
 * name or null. Anything else throws, naming the key, never a value.
 */
export function loadOverrides(path: string, env: Env): Map<string, string | null> {
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(expandHome(path, env), 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    throw new Error(`overrides file ${path} ${code ? `cannot be read (${code})` : 'is not valid JSON'}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`overrides file ${path} must hold a JSON object`)
  }
  const overrides = new Map<string, string | null>()
  for (const [key, value] of Object.entries(doc)) {
    if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error(`overrides file ${path}: "${key}" must map to a project name or null`)
    }
    overrides.set(key, value === null ? null : value.trim())
  }
  return overrides
}

function isPath(raw: string): boolean {
  return raw.startsWith('/') || raw === '~' || raw.startsWith('~/')
}

function contains(root: string, dir: string): boolean {
  if (root === sep) return true
  return dir === root || dir.startsWith(root + sep)
}

/** The workspace whose root is the longest one containing `dir`. */
function workspaceRootOf(dir: string, registry: ProjectRegistry): { id: string; root: string } | null {
  let best: { id: string; root: string } | null = null
  for (const w of registry.workspaces.values()) {
    if (contains(w.root, dir) && (best === null || w.root.length > best.root.length)) best = { id: w.id, root: w.root }
  }
  return best
}

const REASON_RULES: Partial<Record<ResolutionReason, ResolverRule>> = {
  'no-repo': 'no-repo',
  'shared-alias': 'shared-alias',
}

/** Builds the resolver for one registry and one overrides map. */
export function createProjectResolver(config: ResolverConfig, env: Env = process.env): ProjectResolver {
  const { registry, overrides } = config
  const knownRepos: ReadonlySet<string> = new Set(registry.projects.keys())
  const workspaceOf = (project: string): string | null => registry.projects.get(project)?.workspace ?? null

  const resolveName = (raw: string): ProjectResolution => {
    if (overrides.has(raw)) {
      const project = overrides.get(raw) ?? null
      return { project_id: project, workspace_id: project ? workspaceOf(project) : null, rule: 'override', raw }
    }
    const tag = resolveTag(raw, null, knownRepos)
    const fixed = REASON_RULES[tag.reason]
    if (fixed) return { project_id: null, workspace_id: null, rule: fixed, raw }
    if (tag.target !== null && knownRepos.has(tag.target)) {
      const rule: ResolverRule = tag.reason === 'worktree' ? 'worktree' : 'repository'
      return { project_id: tag.target, workspace_id: workspaceOf(tag.target), rule, raw }
    }
    const name = raw.trim()
    if (registry.workspaces.has(name)) return { project_id: null, workspace_id: name, rule: 'workspace', raw }
    return { project_id: null, workspace_id: null, rule: 'unregistered', raw }
  }

  const resolvePath = (raw: string): ProjectResolution => {
    let dir = resolve(expandHome(raw, env))
    const mark = `${dir}${sep}`.indexOf(WORKTREES_MARK)
    if (mark >= 0) dir = dir.slice(0, mark) || sep
    const segments = dir.split(sep).filter((s) => s.length > 0)
    const at = workspaceRootOf(dir, registry)
    if (at !== null) {
      if (dir === at.root) return { project_id: null, workspace_id: at.id, rule: 'workspace', raw }
      const below = dir.slice(at.root === sep ? 1 : at.root.length + 1).split(sep)[0]
      const named = resolveName(below)
      if (named.project_id !== null) return { ...named, workspace_id: named.workspace_id ?? at.id, raw }
      if (named.workspace_id !== null) return { ...named, raw }
      return { project_id: null, workspace_id: at.id, rule: 'workspace', raw }
    }
    for (let i = segments.length - 1; i >= 0; i--) {
      const named = resolveName(segments[i])
      if (named.project_id !== null || named.workspace_id !== null) return { ...named, raw }
    }
    return { project_id: null, workspace_id: null, rule: 'unregistered', raw }
  }

  return (raw) => (isPath(raw) ? resolvePath(raw) : resolveName(raw))
}
