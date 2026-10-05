/**
 * The project block every capture event carries: `{id, workspace, repo_root,
 * branch, worktree}`. The id is the owning repository, resolved through the
 * git dir so a linked worktree names its main repository. The workspace comes
 * from the project registry. A folder name outside a repository never becomes
 * an id: a multi-repo workspace root or a home dir says nothing about which
 * codebase an event belongs to. The route decides which ids count and stores
 * an unregistered one as NULL, so the client sends what it detected.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  CAPTURE_PROJECT_BRANCH_MAX_CHARS,
  CAPTURE_PROJECT_ID_MAX_CHARS,
  CAPTURE_PROJECT_REPO_ROOT_MAX_CHARS,
  CAPTURE_PROJECT_WORKSPACE_MAX_CHARS,
  CAPTURE_PROJECT_WORKTREE_MAX_CHARS,
} from '../capture-events/contract.js'
import {
  parseProjectRegistry,
  PROJECT_REGISTRY_VERSION,
  type ProjectRegistry,
  type RegistryWorkspace,
} from '../capture-events/project-registry.js'
import { detectCheckout } from '../ingest/project-detect.js'
import type { EventProject } from './events.js'
import { appendCaptureLog, captureLogPath } from './log.js'

type Env = Record<string, string | undefined>

export const PROJECT_REGISTRY_FILE_ENV = 'ENGRAM_PROJECT_REGISTRY_FILE'

/** The project registry with every workspace root absolute (`~/` expanded, no trailing separator). */
export type CaptureRegistry = ProjectRegistry

const EMPTY_REGISTRY: CaptureRegistry = {
  version: PROJECT_REGISTRY_VERSION,
  workspaces: new Map(),
  projects: new Map(),
}

function homeOf(env: Env): string {
  return env.HOME || homedir()
}

function expandHome(path: string, env: Env): string {
  return path === '~' || path.startsWith('~/') ? join(homeOf(env), path.slice(1)) : path
}

function withAbsoluteRoots(registry: ProjectRegistry, env: Env): CaptureRegistry {
  const workspaces = new Map<string, RegistryWorkspace>()
  for (const [id, w] of registry.workspaces) workspaces.set(id, { ...w, root: resolve(expandHome(w.root, env)) })
  return { ...registry, workspaces }
}

/**
 * The registry condition line last written to each capture log. Capture runs
 * on every Stop, so a condition that holds for the whole process (an unset
 * variable, a missing file) would otherwise repeat on every call and bury the
 * drain and refusal lines; it is written again only when the condition
 * changes, including after the registry loaded cleanly in between.
 */
const lastConditionByLog = new Map<string, string>()

function reportRegistryCondition(env: Env, line: string | null): void {
  const log = captureLogPath(env)
  if (line === null) {
    lastConditionByLog.delete(log)
    return
  }
  if (lastConditionByLog.get(log) === line) return
  lastConditionByLog.set(log, line)
  appendCaptureLog(env, line)
}

/**
 * Reads the file `ENGRAM_PROJECT_REGISTRY_FILE` names. An unset variable or a
 * missing, unreadable or invalid file gives the empty registry and a
 * capture-log line, so a health check can tell why events carry no workspace;
 * the line is written once per process for as long as the condition holds.
 * Never throws: capture must not fail because of the registry.
 */
export function loadCaptureRegistry(env: Env): CaptureRegistry {
  const configured = env[PROJECT_REGISTRY_FILE_ENV]?.trim()
  if (!configured) {
    reportRegistryCondition(env, `project registry not configured (${PROJECT_REGISTRY_FILE_ENV} unset); events carry no workspace`)
    return EMPTY_REGISTRY
  }
  const path = expandHome(configured, env)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
    reportRegistryCondition(env, `project registry unreadable (${code}); events carry no workspace`)
    return EMPTY_REGISTRY
  }
  try {
    const registry = withAbsoluteRoots(parseProjectRegistry(JSON.parse(text)), env)
    reportRegistryCondition(env, null)
    return registry
  } catch (err) {
    // A parse error names a key path and a rule, never a value.
    const reason = err instanceof SyntaxError ? 'not valid JSON' : err instanceof Error ? err.message : 'invalid'
    reportRegistryCondition(env, `project registry invalid (${reason.slice(0, 300)}); events carry no workspace`)
    return EMPTY_REGISTRY
  }
}

function contains(root: string, dir: string): boolean {
  if (root === sep) return true
  return dir === root || dir.startsWith(root + sep)
}

/** The workspace with the longest root containing `dir`, or null. */
function workspaceContaining(dir: string, registry: CaptureRegistry): string | null {
  let best: RegistryWorkspace | null = null
  for (const w of registry.workspaces.values()) {
    if (contains(w.root, dir) && (best === null || w.root.length > best.root.length)) best = w
  }
  return best?.id ?? null
}

/** A value the route would refuse as too long is sent as null, so the event itself is never refused. */
function within(value: string | null, max: number): string | null {
  return value !== null && value.length > 0 && value.length <= max ? value : null
}

const NO_PROJECT: EventProject = { id: null, workspace: null, repo_root: null, branch: null, worktree: null }

/**
 * Inside a repository: `id` is the repository, `workspace` its registry
 * workspace when listed, else the longest registry root containing cwd, and
 * `branch` the entry's git branch. Outside any repository: only `workspace`,
 * from the longest registry root containing cwd.
 */
export function resolveEventProject(
  cwd: string | null,
  gitBranch: string | null,
  registry: CaptureRegistry,
): EventProject {
  if (!cwd) return NO_PROJECT
  const dir = resolve(cwd)
  const checkout = detectCheckout(dir)
  if (!checkout) {
    return { ...NO_PROJECT, workspace: within(workspaceContaining(dir, registry), CAPTURE_PROJECT_WORKSPACE_MAX_CHARS) }
  }
  const listed = registry.projects.get(checkout.repo)
  const workspace = listed ? listed.workspace : workspaceContaining(dir, registry)
  return {
    id: within(checkout.repo, CAPTURE_PROJECT_ID_MAX_CHARS),
    workspace: within(workspace, CAPTURE_PROJECT_WORKSPACE_MAX_CHARS),
    repo_root: within(checkout.repoRoot, CAPTURE_PROJECT_REPO_ROOT_MAX_CHARS),
    branch: within(gitBranch, CAPTURE_PROJECT_BRANCH_MAX_CHARS),
    worktree: within(checkout.worktree, CAPTURE_PROJECT_WORKTREE_MAX_CHARS),
  }
}
