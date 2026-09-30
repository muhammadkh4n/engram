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
 */
import { readFileSync } from 'node:fs'
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

const loaded = new Map<string, ProjectGroup[]>()

/**
 * Groups from `filePath`, read once per path per process. An unset path means
 * no groups. An unreadable or malformed file also means no groups: ranking
 * degrades to the same-project boost alone, which hides nothing, so recall
 * keeps working and the problem is reported once on stderr.
 */
export function loadProjectGroups(filePath: string | undefined): ProjectGroup[] {
  if (!filePath) return []
  const cached = loaded.get(filePath)
  if (cached) return cached
  let groups: ProjectGroup[] = []
  try {
    groups = parseProjectGroups(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch (err) {
    console.warn(`[engram] project groups file ${filePath} ignored: ${(err as Error).message}`)
  }
  loaded.set(filePath, groups)
  return groups
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

/** Ranking settings for one recall. Environment is read per call so a flag flip needs no restart. */
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
  if (memProject === ranking.project) return ranking.projectBoost
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
