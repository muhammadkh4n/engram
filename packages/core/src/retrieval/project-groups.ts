/**
 * Project tags as a ranking signal.
 *
 * A memory's project tag never removes it from recall: tags are derived from
 * the working directory at write time, so a mis-tagged memory (a worktree, a
 * sibling repo of the same product, a session started outside any repo) would
 * otherwise become invisible exactly where it is needed. Instead the current
 * project and its product group lift their candidates in the ranking; shared
 * (untagged) memories and unrelated projects keep their score.
 *
 * Product groups come from a JSON file named by ENGRAM_PROJECT_GROUPS_FILE:
 *   { "groups": { "<group>": ["<project name or glob>", ...] } }
 * Globs support `*` and `?`, match the whole project name, case-insensitively.
 * A project belongs to the first group (in file order) with a matching pattern.
 * The same-project comparison is case-insensitive too, like the globs.
 */
import { readFileSync, statSync } from 'node:fs'
import type { RetrievedMemory } from '../types.js'

export interface ProjectGroup {
  readonly name: string
  readonly patterns: readonly RegExp[]
}

export interface ProjectRanking {
  /** The project the recall runs for. */
  readonly project: string
  /** The product group of `project`, or null when it belongs to none. */
  readonly group: string | null
  readonly groups: readonly ProjectGroup[]
  readonly projectBoost: number
  readonly groupBoost: number
  /** Drop candidates tagged with another project (untagged ones stay). */
  readonly strict: boolean
}

export const DEFAULT_PROJECT_BOOST = 0.1
export const DEFAULT_PROJECT_GROUP_BOOST = 0.05

type Env = Record<string, string | undefined>

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*'
      if (ch === '?') return '.'
      return ch.replace(/[.+^${}()|[\]\\/-]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${body}$`, 'i')
}

/** Parse a groups document; throws on any shape other than the one documented above. */
export function parseProjectGroups(doc: unknown): ProjectGroup[] {
  if (typeof doc !== 'object' || doc === null) throw new Error('project groups: expected a JSON object')
  const groups = (doc as Record<string, unknown>)['groups']
  if (typeof groups !== 'object' || groups === null || Array.isArray(groups)) {
    throw new Error('project groups: expected a "groups" object')
  }
  return Object.entries(groups as Record<string, unknown>).map(([name, patterns]) => {
    if (!Array.isArray(patterns) || !patterns.every((p): p is string => typeof p === 'string')) {
      throw new Error(`project groups: group "${name}" must be an array of strings`)
    }
    return { name, patterns: patterns.map(globToRegExp) }
  })
}

export function groupOf(project: string, groups: readonly ProjectGroup[]): string | null {
  for (const group of groups) {
    if (group.patterns.some((re) => re.test(project))) return group.name
  }
  return null
}

/** How long a loaded groups file is trusted before its mtime is checked again. */
export const PROJECT_GROUPS_RECHECK_MS = 60_000

interface GroupsCacheEntry {
  readonly groups: ProjectGroup[]
  /** mtime of the file when it was last read; -1 when it did not exist. */
  readonly mtimeMs: number
  readonly checkedAt: number
  /** Message of the last read failure, or null after a clean read. */
  readonly failure: string | null
}

const loaded = new Map<string, GroupsCacheEntry>()

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

/**
 * Groups from `filePath`. The file is re-stat'ed at most once per
 * PROJECT_GROUPS_RECHECK_MS and re-read when its mtime or existence changed,
 * so edits apply to a running server without a restart. An unset path means
 * no groups. An unreadable or malformed file also means no groups: ranking
 * degrades to the same-project boost alone, which hides nothing, so recall
 * keeps working. A failed read is retried at the next check, and each distinct
 * failure is reported once on stderr rather than on every recall.
 */
export function loadProjectGroups(filePath: string | undefined, now: () => number = Date.now): ProjectGroup[] {
  if (!filePath) return []
  const cached = loaded.get(filePath)
  const t = now()
  if (cached && t - cached.checkedAt < PROJECT_GROUPS_RECHECK_MS) return cached.groups
  const mtimeMs = mtimeOf(filePath)
  if (cached && cached.failure === null && cached.mtimeMs === mtimeMs) {
    loaded.set(filePath, { ...cached, checkedAt: t })
    return cached.groups
  }
  try {
    const groups = parseProjectGroups(JSON.parse(readFileSync(filePath, 'utf8')))
    loaded.set(filePath, { groups, mtimeMs, checkedAt: t, failure: null })
    return groups
  } catch (err) {
    const failure = (err as Error).message
    if (failure !== cached?.failure) {
      console.warn(`[engram] project groups file ${filePath} ignored: ${failure}`)
    }
    loaded.set(filePath, { groups: [], mtimeMs, checkedAt: t, failure })
    return []
  }
}

/** Forget cached group files (tests, or a caller that rewrote the file). */
export function resetProjectGroupsCache(): void {
  loaded.clear()
}

function boostFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Ranking settings for one recall. Environment is read per call and the groups
 * file is reloaded when it changes, so neither needs a restart.
 */
export function projectRankingFromEnv(
  project: string,
  env: Env = process.env,
  strict = false,
): ProjectRanking {
  const groups = loadProjectGroups(env['ENGRAM_PROJECT_GROUPS_FILE'])
  return {
    project,
    group: groupOf(project, groups),
    groups,
    projectBoost: boostFromEnv(env['ENGRAM_PROJECT_BOOST'], DEFAULT_PROJECT_BOOST),
    groupBoost: boostFromEnv(env['ENGRAM_PROJECT_GROUP_BOOST'], DEFAULT_PROJECT_GROUP_BOOST),
    strict,
  }
}

/** The row's project_id column first; metadata.project for rows written before the column existed. */
export function memoryProject(m: RetrievedMemory): string | null {
  if (m.projectId) return m.projectId
  const legacy = m.metadata?.['project']
  return typeof legacy === 'string' && legacy !== '' ? legacy : null
}

export function projectBoostFor(memProject: string | null, ranking: ProjectRanking): number {
  if (memProject === null) return 0
  if (memProject.toLowerCase() === ranking.project.toLowerCase()) return ranking.projectBoost
  if (ranking.group !== null && groupOf(memProject, ranking.groups) === ranking.group) return ranking.groupBoost
  return 0
}

/**
 * Add the project/group boost to each candidate's relevance. Uncapped:
 * fused scores already exceed 1.0 (similarity plus BM25, recency and access
 * boosts), so clamping at 1.0 would lower a strong same-project candidate
 * below other projects' scores. Order is left to the caller. Strict mode drops candidates tagged with
 * another project; untagged candidates are shared and always kept.
 */
export function applyProjectRanking(memories: RetrievedMemory[], ranking: ProjectRanking): RetrievedMemory[] {
  const out: RetrievedMemory[] = []
  for (const m of memories) {
    const memProject = memoryProject(m)
    if (ranking.strict && memProject !== null && memProject !== ranking.project) continue
    const boost = projectBoostFor(memProject, ranking)
    out.push(boost > 0 ? { ...m, relevance: m.relevance + boost } : m)
  }
  return out
}
