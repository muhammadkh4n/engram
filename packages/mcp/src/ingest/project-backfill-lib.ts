/**
 * Restores `project_id` on episodes that were stored without one while the
 * ingest `metadata.project` tag was still written.
 *
 * The stored tag is a bare directory name, not a path, so the repository
 * rules of project-detect.ts are applied to names only:
 *   - blank or a shared alias ('global' / 'none' / 'shared') → shared;
 *   - a cross-cutting salience category (preferences, identity, priority
 *     signals) → shared, the same rule ingest applies today;
 *   - an explicit `from=to` mapping wins over the heuristics below;
 *   - a name that cannot be a repository (a dot-directory such as
 *     `.claude`, a temp or home folder, or a caller-listed org folder) →
 *     shared;
 *   - a linked worktree named `<repo>-<slug>` → `<repo>`, when `<repo>` is
 *     itself a tag in the data (or listed by the caller). The longest such
 *     prefix wins; names listed as `keep` are never remapped;
 *   - anything else keeps its tag.
 *
 * A project tag only ranks memories, it never hides one, so a wrong mapping
 * costs ranking, not recall. The dry run prints every rename so the mapping
 * can be corrected before `--apply`.
 *
 * `metadata` is left untouched: it keeps the tag as captured at ingest time,
 * so the mapping can be recomputed later from the original evidence.
 */

import { isCrossCuttingCategory, normalizeProjectId } from './project-detect.js'
import { chunk, nextCursor, type PageCursor } from './embed-backfill-lib.js'

export interface BackfillRow {
  id: string
  created_at: string
  /** `metadata->>'project'` */
  project: string | null
  /** `metadata->>'salienceCategory'` */
  category: string | null
}

/** Storage seam: the CLI binds it to PostgREST, tests to an in-memory stub. */
export interface ProjectBackfillStore {
  /**
   * Episodes with a NULL `project_id` and a `metadata.project` tag, ordered
   * by (created_at, id), strictly after `cursor`.
   */
  fetchPage(cursor: PageCursor | null, pageSize: number): Promise<BackfillRow[]>
  /**
   * Sets `project_id` on the given ids that still have a NULL one; returns
   * how many rows changed.
   */
  assignProject(ids: readonly string[], project: string): Promise<number>
}

export interface BackfillRules {
  /** Exact tag → target; a shared alias as target means shared. */
  aliases: ReadonlyMap<string, string>
  /** Extra names (case-insensitive) that are folders, not repositories. */
  sharedNames: ReadonlySet<string>
  /** Names never remapped as a worktree of another repository. */
  keep: ReadonlySet<string>
  /** Repository names known in addition to the tags found in the data. */
  repos: ReadonlySet<string>
}

export const EMPTY_RULES: BackfillRules = {
  aliases: new Map(),
  sharedNames: new Set(),
  keep: new Set(),
  repos: new Set(),
}

export type ResolutionReason =
  | 'tag'
  | 'worktree'
  | 'alias'
  | 'shared-alias'
  | 'cross-cutting'
  | 'no-repo'

export interface Resolution {
  target: string | null
  reason: ResolutionReason
}

/** Folder names that the old no-repository fallback produced. */
const NO_REPO_NAMES: ReadonlySet<string> = new Set(['tmp', 'temp', 'home', 'root', 'users'])

function isNoRepoName(name: string, rules: BackfillRules): boolean {
  const lower = name.toLowerCase()
  if (name.startsWith('.')) return true
  if (NO_REPO_NAMES.has(lower)) return true
  for (const s of rules.sharedNames) if (s.toLowerCase() === lower) return true
  return false
}

/** Longest known repository `R` with `name` = `R-<slug>`, or null. */
function owningRepository(name: string, knownRepos: ReadonlySet<string>): string | null {
  let best: string | null = null
  for (const repo of knownRepos) {
    if (repo === name || !name.startsWith(`${repo}-`)) continue
    if (!best || repo.length > best.length) best = repo
  }
  return best
}

/** Repository candidates: every tag in the data that could name one, plus the caller's list. */
export function knownRepositories(
  tags: Iterable<string>,
  rules: BackfillRules,
): Set<string> {
  const known = new Set<string>()
  for (const raw of [...tags, ...rules.repos]) {
    const tag = normalizeProjectId(raw)
    if (tag && !isNoRepoName(tag, rules)) known.add(tag)
  }
  return known
}

export function resolveTag(
  rawTag: string | null,
  category: string | null,
  knownRepos: ReadonlySet<string>,
  rules: BackfillRules = EMPTY_RULES,
): Resolution {
  const tag = normalizeProjectId(rawTag)
  if (!tag) return { target: null, reason: 'shared-alias' }
  if (isCrossCuttingCategory(category)) return { target: null, reason: 'cross-cutting' }

  const alias = rules.aliases.get(tag)
  if (alias !== undefined) return { target: normalizeProjectId(alias) ?? null, reason: 'alias' }

  if (isNoRepoName(tag, rules)) return { target: null, reason: 'no-repo' }

  if (!rules.keep.has(tag)) {
    const repo = owningRepository(tag, knownRepos)
    if (repo) return { target: repo, reason: 'worktree' }
  }
  return { target: tag, reason: 'tag' }
}

export interface BackfillPlan {
  /** target project → episode ids */
  assignments: Map<string, string[]>
  /** episodes that stay shared, by reason */
  shared: Map<ResolutionReason, number>
  /** `from → to` renames (worktree or alias), with row counts */
  renames: Map<string, number>
  scanned: number
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export function planBackfill(rows: readonly BackfillRow[], rules: BackfillRules = EMPTY_RULES): BackfillPlan {
  const knownRepos = knownRepositories(
    rows.flatMap((r) => (r.project ? [r.project] : [])),
    rules,
  )
  const plan: BackfillPlan = {
    assignments: new Map(),
    shared: new Map(),
    renames: new Map(),
    scanned: rows.length,
  }

  for (const row of rows) {
    const { target, reason } = resolveTag(row.project, row.category, knownRepos, rules)
    if (target === null) {
      increment(plan.shared, reason)
      continue
    }
    const ids = plan.assignments.get(target)
    if (ids) ids.push(row.id)
    else plan.assignments.set(target, [row.id])
    const from = normalizeProjectId(row.project)
    if (from !== target) increment(plan.renames, `${from} -> ${target}`)
  }
  return plan
}

export interface BackfillRunOptions {
  apply: boolean
  pageSize: number
  batchSize: number
}

export interface BackfillReport {
  plan: BackfillPlan
  /** target project → rows actually updated (all zero on a dry run) */
  updated: Map<string, number>
}

/**
 * Scans every candidate before writing anything, so updates cannot shift
 * the keyset pages under the scan; then, with `apply`, writes each target
 * project in batches.
 */
export async function runProjectBackfill(
  store: ProjectBackfillStore,
  rules: BackfillRules,
  opts: BackfillRunOptions,
): Promise<BackfillReport> {
  const rows: BackfillRow[] = []
  let cursor: PageCursor | null = null
  for (;;) {
    const page = await store.fetchPage(cursor, opts.pageSize)
    if (page.length === 0) break
    rows.push(...page)
    cursor = nextCursor(page)
    if (page.length < opts.pageSize) break
  }

  const plan = planBackfill(rows, rules)
  const updated = new Map<string, number>()
  for (const [project, ids] of plan.assignments) {
    let count = 0
    if (opts.apply) {
      for (const batch of chunk(ids, opts.batchSize)) {
        count += await store.assignProject(batch, project)
      }
    }
    updated.set(project, count)
  }
  return { plan, updated }
}

function sortedByCount<K>(map: ReadonlyMap<K, number>): Array<[K, number]> {
  return [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

/** Counts and project names only: no episode content or ids. */
export function formatReport(report: BackfillReport, apply: boolean): string {
  const { plan, updated } = report
  const lines: string[] = [`scanned=${plan.scanned} (project_id NULL, metadata.project present)`]

  lines.push(apply ? 'target project: planned / updated' : 'target project: would update')
  const perTarget = new Map([...plan.assignments].map(([p, ids]) => [p, ids.length] as const))
  for (const [project, n] of sortedByCount(perTarget)) {
    lines.push(apply ? `  ${project}: ${n} / ${updated.get(project) ?? 0}` : `  ${project}: ${n}`)
  }

  const sharedTotal = [...plan.shared.values()].reduce((a, b) => a + b, 0)
  lines.push(`stays shared: ${sharedTotal}`)
  for (const [reason, n] of sortedByCount(plan.shared)) lines.push(`  ${reason}: ${n}`)

  lines.push(`renames: ${plan.renames.size}`)
  for (const [rename, n] of sortedByCount(plan.renames)) lines.push(`  ${rename}: ${n}`)
  return lines.join('\n')
}
