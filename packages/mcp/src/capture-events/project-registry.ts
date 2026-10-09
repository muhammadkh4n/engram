/**
 * The project registry: the one file that maps each repository to its
 * workspace, the notes folder holding its register (`vault_folder`), and its register id
 * prefix. The route checks every event's scope against it, and the rows it
 * yields are synced into `memory_projects` before the route accepts events.
 *
 * File shape (version 1), every key required:
 *   { "version": 1,
 *     "workspaces": { "<id>": { "root", "vault_folder", "register_prefix" } },
 *     "projects":   { "<id>": { "workspace", "vault_folder", "register_prefix" } } }
 */

import { readFileSync } from 'node:fs'
import { cutWholeChars, type CaptureStore, type ProjectRow } from '@engram-mem/core'
import type { CaptureEvent } from './contract.js'

export const PROJECT_REGISTRY_VERSION = 1
/** Same rule as `memory_projects.id`. */
export const REGISTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/** Same rule as `memory_projects.register_prefix`. */
export const REGISTER_PREFIX_PATTERN = /^[A-Z]{2,6}$/
export const VAULT_FOLDER_MAX_CHARS = 200
export const WORKSPACE_ROOT_MAX_CHARS = 4096
/** How long a failed `memory_projects` sync waits before the next attempt. */
export const PROJECT_SYNC_RETRY_MS = 30_000

export interface RegistryWorkspace {
  id: string
  /** An absolute path or one under `~/`, as written. */
  root: string
  vaultFolder: string | null
  registerPrefix: string | null
}

export interface RegistryProject {
  id: string
  workspace: string | null
  vaultFolder: string | null
  registerPrefix: string | null
}

/** Maps, not plain objects: an id like `__proto__` or `constructor` must name nothing it was not given. */
export interface ProjectRegistry {
  version: typeof PROJECT_REGISTRY_VERSION
  workspaces: ReadonlyMap<string, RegistryWorkspace>
  projects: ReadonlyMap<string, RegistryProject>
}

export class ProjectRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectRegistryError'
  }
}

const TOP_KEYS = ['version', 'workspaces', 'projects'] as const
const WORKSPACE_KEYS = ['root', 'vault_folder', 'register_prefix'] as const
const PROJECT_KEYS = ['workspace', 'vault_folder', 'register_prefix'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, rule: string): never {
  throw new ProjectRegistryError(`project registry: ${path || '(root)'}: ${rule}`)
}

/** `a.b` for a key that is a plain identifier, `a["…"]` (JSON-quoted, cut to 100 chars) otherwise. */
function child(path: string, key: string): string {
  const plain = REGISTRY_ID_PATTERN.test(key) || /^[a-z_]+$/.test(key)
  const part = plain ? key : `[${JSON.stringify(cutWholeChars(key, 100))}]`
  if (!path) return part
  return plain ? `${path}.${part}` : `${path}${part}`
}

function exactKeys(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object')
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(child(path, key), 'unknown key')
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(child(path, key), 'is required')
  }
  return value
}

function nullableFolder(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > VAULT_FOLDER_MAX_CHARS) {
    fail(path, `must be a string of 1 to ${VAULT_FOLDER_MAX_CHARS} characters or null`)
  }
  return value
}

function nullablePrefix(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !REGISTER_PREFIX_PATTERN.test(value)) {
    fail(path, 'must be 2 to 6 capital letters or null')
  }
  return value
}

function parseRoot(value: unknown, path: string): string {
  const isRootPath = typeof value === 'string' && (value.startsWith('/') || value.startsWith('~/'))
  if (!isRootPath || value.length > WORKSPACE_ROOT_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(path, `must be an absolute path or one under ~/, at most ${WORKSPACE_ROOT_MAX_CHARS} characters`)
  }
  return value
}

function ids(value: unknown, path: string): Array<[string, unknown]> {
  if (!isRecord(value)) fail(path, 'must be an object')
  const entries = Object.entries(value)
  for (const [id] of entries) {
    if (!REGISTRY_ID_PATTERN.test(id)) fail(child(path, id), 'id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
  }
  return entries
}

function parseWorkspaces(value: unknown): Map<string, RegistryWorkspace> {
  const workspaces = new Map<string, RegistryWorkspace>()
  for (const [id, raw] of ids(value, 'workspaces')) {
    const path = child('workspaces', id)
    const entry = exactKeys(raw, path, WORKSPACE_KEYS)
    workspaces.set(id, {
      id,
      root: parseRoot(entry.root, child(path, 'root')),
      vaultFolder: nullableFolder(entry.vault_folder, child(path, 'vault_folder')),
      registerPrefix: nullablePrefix(entry.register_prefix, child(path, 'register_prefix')),
    })
  }
  return workspaces
}

function parseProjects(value: unknown, workspaces: ReadonlyMap<string, RegistryWorkspace>): Map<string, RegistryProject> {
  const projects = new Map<string, RegistryProject>()
  for (const [id, raw] of ids(value, 'projects')) {
    const path = child('projects', id)
    const entry = exactKeys(raw, path, PROJECT_KEYS)
    const workspace = entry.workspace
    if (workspace !== null && (typeof workspace !== 'string' || !workspaces.has(workspace))) {
      fail(child(path, 'workspace'), 'must name a workspace of this registry or be null')
    }
    if (workspaces.has(id)) fail(path, 'id is also a workspace')
    projects.set(id, {
      id,
      workspace,
      vaultFolder: nullableFolder(entry.vault_folder, child(path, 'vault_folder')),
      registerPrefix: nullablePrefix(entry.register_prefix, child(path, 'register_prefix')),
    })
  }
  return projects
}

/** A registry entry's register: its vault folder and id prefix, each null when it has none. */
export interface EffectiveRegister {
  vaultFolder: string | null
  registerPrefix: string | null
}

/**
 * A project's register as the rulings tooling reads it: the project's own
 * folder and prefix, each inheriting its workspace's when the project's own
 * is null. A workspace's register is its own.
 */
export function effectiveRegister(registry: ProjectRegistry, project: RegistryProject): EffectiveRegister {
  const workspace = project.workspace === null ? undefined : registry.workspaces.get(project.workspace)
  return {
    vaultFolder: project.vaultFolder ?? workspace?.vaultFolder ?? null,
    registerPrefix: project.registerPrefix ?? workspace?.registerPrefix ?? null,
  }
}

/** Every entry's path and effective register, workspaces first, each kind in file order. */
function effectiveEntries(registry: ProjectRegistry): Array<[string, EffectiveRegister]> {
  return [
    ...[...registry.workspaces.values()].map((w): [string, EffectiveRegister] => [child('workspaces', w.id), w]),
    ...[...registry.projects.values()].map((p): [string, EffectiveRegister] => [
      child('projects', p.id),
      effectiveRegister(registry, p),
    ]),
  ]
}

/**
 * A register is one vault folder's rulings file with one id prefix, so every
 * repository whose rulings live in a folder carries that folder's prefix: on
 * the effective registers, a folder has one prefix and a prefix names one
 * folder. An entry with no folder or no prefix pairs with nothing.
 */
function checkPrefixFolders(registry: ProjectRegistry): void {
  const prefixOfFolder = new Map<string, [string, string]>()
  const folderOfPrefix = new Map<string, [string, string]>()
  for (const [path, { vaultFolder: folder, registerPrefix: prefix }] of effectiveEntries(registry)) {
    if (folder === null || prefix === null) continue
    const heldPrefix = prefixOfFolder.get(folder)
    if (heldPrefix && heldPrefix[0] !== prefix) {
      fail(child(path, 'register_prefix'), `vault folder ${JSON.stringify(folder)} already has prefix ${heldPrefix[0]} (${heldPrefix[1]})`)
    }
    const heldFolder = folderOfPrefix.get(prefix)
    if (heldFolder && heldFolder[0] !== folder) {
      fail(child(path, 'register_prefix'), `prefix ${prefix} already names vault folder ${JSON.stringify(heldFolder[0])} (${heldFolder[1]})`)
    }
    prefixOfFolder.set(folder, [prefix, path])
    folderOfPrefix.set(prefix, [folder, path])
  }
}

/**
 * The one scope a vault folder's register entries and notes are stored under,
 * the rule the rulings tooling writes by: the workspace whose own folder it is,
 * else the project named like the folder (lower-cased), else the first project
 * id in sort order among those whose effective folder it is. Null when no
 * entry files under the folder.
 */
export function canonicalFolderScope(
  registry: ProjectRegistry,
  folder: string,
): { projectId: string | null; workspaceId: string | null } | null {
  const workspace = [...registry.workspaces.keys()].sort().find((id) => registry.workspaces.get(id)!.vaultFolder === folder)
  if (workspace !== undefined) return { projectId: null, workspaceId: workspace }
  const members = [...registry.projects.keys()]
    .sort()
    .filter((id) => effectiveRegister(registry, registry.projects.get(id)!).vaultFolder === folder)
  const chosen = members.find((id) => id === folder.toLowerCase()) ?? members[0]
  if (chosen === undefined) return null
  return { projectId: chosen, workspaceId: registry.projects.get(chosen)!.workspace }
}

/** Parses the registry document exactly; any deviation throws a ProjectRegistryError naming the path. */
export function parseProjectRegistry(doc: unknown): ProjectRegistry {
  const top = exactKeys(doc, '', TOP_KEYS)
  if (top.version !== PROJECT_REGISTRY_VERSION) fail('version', `must be ${PROJECT_REGISTRY_VERSION}`)
  const workspaces = parseWorkspaces(top.workspaces)
  const projects = parseProjects(top.projects, workspaces)
  const registry: ProjectRegistry = { version: PROJECT_REGISTRY_VERSION, workspaces, projects }
  checkPrefixFolders(registry)
  return registry
}

/** Reads and parses the registry file; a missing, unreadable or invalid file throws. */
export function loadProjectRegistry(path: string): ProjectRegistry {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
    throw new ProjectRegistryError(`project registry: cannot read ${path} (${code})`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new ProjectRegistryError(`project registry: ${path} is not valid JSON`)
  }
  return parseProjectRegistry(doc)
}

/** The `memory_projects` rows of the registry, workspaces first. */
export function registryRows(registry: ProjectRegistry): ProjectRow[] {
  const workspaces: ProjectRow[] = [...registry.workspaces.values()].map((w) => ({
    id: w.id,
    kind: 'workspace',
    workspaceId: null,
    vaultFolder: w.vaultFolder,
    registerPrefix: w.registerPrefix,
  }))
  const projects: ProjectRow[] = [...registry.projects.values()].map((p) => ({
    id: p.id,
    kind: 'project',
    workspaceId: p.workspace,
    vaultFolder: p.vaultFolder,
    registerPrefix: p.registerPrefix,
  }))
  return [...workspaces, ...projects]
}

export interface ResolvedScope {
  projectId: string | null
  workspaceId: string | null
  /** The sent ids the registry does not know, kept for `scrub.project_rejected` / `scrub.workspace_rejected`. */
  rejected: { project?: string; workspace?: string }
}

export type ScopeResolution = ResolvedScope | { reject: string }

const REGISTER_ID_PREFIX = /^R-([A-Z]{2,6})-[0-9]+$/

function resolveRegisterScope(registry: ProjectRegistry, entryId: string, scope: string): ScopeResolution {
  const prefix = REGISTER_ID_PREFIX.exec(entryId)?.[1]
  if (prefix === undefined) return { reject: 'payload.id: must match ^R-[A-Z]{2,6}-[0-9]+$' }
  if (scope !== 'global' && !scope.startsWith('project:') && !scope.startsWith('workspace:')) {
    return { reject: 'payload.scope: must be global, project:<id> or workspace:<id>' }
  }
  const owners = effectiveEntries(registry).filter(([, e]) => e.registerPrefix === prefix)
  if (scope === 'global') {
    if (owners.length > 0) return { reject: "payload.scope: a global entry's id prefix belongs to a registry project or workspace" }
    return { projectId: null, workspaceId: null, rejected: {} }
  }
  // The pairing rule leaves at most one folder per prefix.
  const folder = owners.map(([, e]) => e.vaultFolder).find((f): f is string => f !== null)
  const canonical = folder === undefined ? null : canonicalFolderScope(registry, folder)
  if (canonical === null) return { reject: "payload.scope: no registry vault folder has the entry id's prefix" }
  const expected = canonical.projectId !== null ? `project:${canonical.projectId}` : `workspace:${canonical.workspaceId}`
  if (scope !== expected) return { reject: `payload.scope: the register with the entry id's prefix is stored under ${expected}` }
  return { ...canonical, rejected: {} }
}

/**
 * The project and workspace an event is stored under. A register entry's
 * scope must match the registry and its id prefix, or the event is rejected.
 * Any other event takes a registered project with the registry's workspace
 * (the sent workspace is ignored); without a registered project, a
 * registered workspace. An unregistered id resolves to null and is reported
 * in `rejected`.
 */
export function resolveEventScope(registry: ProjectRegistry, event: CaptureEvent): ScopeResolution {
  if (event.type === 'register_entry') return resolveRegisterScope(registry, event.payload.id, event.payload.scope)
  const rejected: ResolvedScope['rejected'] = {}
  const sentProject = event.project.id
  const project = sentProject === null ? undefined : registry.projects.get(sentProject)
  if (project) return { projectId: project.id, workspaceId: project.workspace, rejected }
  if (sentProject !== null) rejected.project = sentProject
  const sentWorkspace = event.project.workspace
  if (sentWorkspace === null) return { projectId: null, workspaceId: null, rejected }
  if (registry.workspaces.has(sentWorkspace)) return { projectId: null, workspaceId: sentWorkspace, rejected }
  rejected.workspace = sentWorkspace
  return { projectId: null, workspaceId: null, rejected }
}

export interface ProjectSync {
  /** The registry once a sync has succeeded; null before. */
  ready(): ProjectRegistry | null
  /** Cancels a pending retry; a sync in flight finishes but schedules nothing. */
  stop(): void
}

/**
 * Syncs the registry rows into `memory_projects` at once and every
 * PROJECT_SYNC_RETRY_MS after a failure, until one succeeds. The route
 * answers 503 until `ready()` returns the registry, so no event is stored
 * under a project the database does not know.
 */
export function startProjectSync(
  store: Pick<CaptureStore, 'syncProjects'>,
  registry: ProjectRegistry,
  log: (message: string) => void,
): ProjectSync {
  const rows = registryRows(registry)
  let synced = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const attempt = async (): Promise<void> => {
    timer = null
    try {
      const written = await store.syncProjects(rows)
      synced = true
      log(`project registry synced: ${rows.length} rows, ${written} written`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`project registry sync failed, retrying in ${PROJECT_SYNC_RETRY_MS / 1000} s: ${message}`)
      if (!stopped) {
        timer = setTimeout(() => void attempt(), PROJECT_SYNC_RETRY_MS)
        timer.unref?.()
      }
    }
  }
  void attempt()

  return {
    ready: () => (synced ? registry : null),
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
