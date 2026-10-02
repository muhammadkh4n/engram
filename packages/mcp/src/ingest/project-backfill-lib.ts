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
 *
 * Captures stored with no tag at all are resolved from other evidence
 * (runEvidenceBackfill): their Claude session's project, else a configured
 * root containing their recorded cwd. Rows already tagged with a worktree's
 * name move to the repository with runRetag. Every apply records each batch
 * in a rollback CSV before writing it; runRollback restores it.
 */

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { basename } from 'node:path'
import { isCrossCuttingCategory, normalizeProjectId } from './project-detect.js'
import { chunk, nextCursor, type PageCursor } from './embed-backfill-lib.js'
import { parseProjectRoots, projectForRoot, type ProjectRoot } from './project-roots.js'

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
  /** required for apply: receives every batch before it is written */
  rollback?: RollbackSink
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
  if (opts.apply && !opts.rollback) throw new Error('apply requires a rollback sink')
  const rows = await scanAll((cursor) => store.fetchPage(cursor, opts.pageSize))

  const plan = planBackfill(rows, rules)
  const updated = new Map<string, number>()
  for (const [project, ids] of plan.assignments) {
    let count = 0
    if (opts.apply) {
      for (const batch of chunk(ids, opts.batchSize)) {
        opts.rollback!.write(
          batch.map((id) => ({ table: 'memory_episodes', id, old: null, new: project }) as const),
        )
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

/**
 * Every row a keyset-paged fetch returns. Only an empty page ends the walk:
 * PostgREST truncates a response at its max-rows setting without saying so,
 * so a page shorter than the requested size may just be that cap.
 */
async function scanAll<T extends { id: string; created_at: string }>(
  fetchPage: (cursor: PageCursor | null) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  let cursor: PageCursor | null = null
  for (;;) {
    const page = await fetchPage(cursor)
    if (page.length === 0) return rows
    rows.push(...page)
    cursor = nextCursor(page)
  }
}

// ---------------------------------------------------------------------------
// Rollback record: every write is recorded before it is made, so an apply
// that stops half-way can still be undone exactly.
// ---------------------------------------------------------------------------

/** Tables whose `project_id` this tool writes. */
export type ProjectTable = 'memory_episodes' | 'memory_digests'
export const PROJECT_TABLES: readonly ProjectTable[] = ['memory_episodes', 'memory_digests']

/** One `project_id` write: `old` and `new` are null for the shared bucket. */
export interface ProjectChange {
  table: ProjectTable
  id: string
  old: string | null
  new: string | null
}

/** Receives each batch before the store is asked to write it. */
export interface RollbackSink {
  write(changes: readonly ProjectChange[]): void
}

export const ROLLBACK_CSV_HEADER = 'table,id,old,new'

function csvField(value: string | null): string {
  const v = value ?? ''
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * The rollback CSV at `path`: created exclusively (0600), so an earlier
 * run's record is never overwritten, then appended before each batch. A row
 * may be listed that the store did not change (it was retagged concurrently);
 * the rollback's `project_id = new` guard leaves such rows alone unless they
 * hold exactly the value this run would have written.
 */
export function openRollbackCsv(path: string): RollbackSink & { close(): void } {
  const fd = openSync(path, 'wx', 0o600)
  writeSync(fd, `${ROLLBACK_CSV_HEADER}\n`)
  return {
    write(changes) {
      if (changes.length === 0) return
      const lines = changes.map((c) => [c.table, c.id, c.old, c.new].map(csvField).join(','))
      writeSync(fd, lines.join('\n') + '\n')
    },
    close() {
      closeSync(fd)
    },
  }
}

/** Fields of one CSV line; quoted fields may hold commas and doubled quotes. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',') {
      fields.push(field)
      field = ''
    } else field += ch
  }
  if (quoted) throw new Error('unterminated quoted field')
  fields.push(field)
  return fields
}

function isProjectTable(value: string): value is ProjectTable {
  return (PROJECT_TABLES as readonly string[]).includes(value)
}

/** Parses a rollback CSV; any malformed line fails the whole file. */
export function parseRollbackCsv(text: string): ProjectChange[] {
  const lines = text.split(/\r?\n/).filter((l) => l !== '')
  if (lines[0] !== ROLLBACK_CSV_HEADER) {
    throw new Error(`rollback CSV must start with "${ROLLBACK_CSV_HEADER}"`)
  }
  return lines.slice(1).map((line, i) => {
    const fields = splitCsvLine(line)
    const [table, id, old, next] = fields
    if (fields.length !== 4 || !table || !id || !isProjectTable(table)) {
      throw new Error(`rollback CSV line ${i + 2} is not table,id,old,new over ${PROJECT_TABLES.join('/')}`)
    }
    return { table, id, old: old || null, new: next || null }
  })
}

export function readRollbackCsv(path: string): ProjectChange[] {
  return parseRollbackCsv(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------------------
// Storage seam for the evidence, retag and rollback modes.
// ---------------------------------------------------------------------------

/** An episode with a NULL `project_id` and the evidence that can name its project. */
export interface UntaggedEpisode {
  id: string
  created_at: string
  session_id: string | null
  /** `metadata->>'transcriptPath'` (session summaries) */
  transcript_path: string | null
  /** `metadata->>'cwd'` */
  cwd: string | null
  /** `metadata->>'salienceCategory'` */
  category: string | null
}

export interface TaggedRow {
  id: string
  created_at: string
  project_id: string
}

export interface ProjectRetagStore {
  /** Episodes with a NULL `project_id`, created at or after `since`, keyset-paged. */
  fetchUntaggedEpisodes(since: string | null, cursor: PageCursor | null, pageSize: number): Promise<UntaggedEpisode[]>
  /** Rows of `table` whose `project_id` is `project` (any non-null value when null), keyset-paged. */
  fetchTagged(
    table: ProjectTable,
    project: string | null,
    cursor: PageCursor | null,
    pageSize: number,
  ): Promise<TaggedRow[]>
  /**
   * Sets `project_id = to` on the given ids whose `project_id` is still
   * `from` (NULL when null); returns the ids actually changed.
   */
  setProject(table: ProjectTable, ids: readonly string[], from: string | null, to: string | null): Promise<string[]>
}

export interface WriteOptions {
  apply: boolean
  pageSize: number
  batchSize: number
  /** required for apply */
  rollback?: RollbackSink
}

function requireRollback(opts: WriteOptions): void {
  if (opts.apply && !opts.rollback) throw new Error('apply requires a rollback sink')
}

/** Records then writes `from → to` on `ids` in batches; returns rows changed. */
async function writeChanges(
  store: ProjectRetagStore,
  opts: WriteOptions,
  table: ProjectTable,
  ids: readonly string[],
  from: string | null,
  to: string | null,
): Promise<number> {
  let changed = 0
  for (const batch of chunk(ids, opts.batchSize)) {
    opts.rollback!.write(batch.map((id) => ({ table, id, old: from, new: to })))
    changed += (await store.setProject(table, batch, from, to)).length
  }
  return changed
}

function pushId<K>(map: Map<K, string[]>, key: K, id: string): void {
  const ids = map.get(key)
  if (ids) ids.push(id)
  else map.set(key, [id])
}

// ---------------------------------------------------------------------------
// Evidence mode: a session → project map and configured roots.
// ---------------------------------------------------------------------------

/**
 * The session map document written by `engram-session-projects`
 * (`{ "<sid>": { "project": ... }, "errors": [...] }`) as session id →
 * project. Sessions resolved to the shared bucket are left out.
 */
export function parseSessionMap(doc: unknown): Map<string, string> {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('session map must be a JSON object')
  }
  const sessions = new Map<string, string>()
  for (const [sid, entry] of Object.entries(doc as Record<string, unknown>)) {
    if (sid === 'errors') continue
    if (typeof entry !== 'object' || entry === null) throw new Error(`session ${sid}: entry must be an object`)
    const project = normalizeProjectId((entry as { project?: unknown }).project)
    if (project) sessions.set(sid, project)
  }
  return sessions
}

/** Roots from a project-groups document; a file without usable roots is an error. */
export function parseRootsFile(doc: unknown, origin: string): ProjectRoot[] {
  const roots = parseProjectRoots(doc, origin)
  if (roots.length === 0) throw new Error(`${origin} holds no usable "roots"`)
  return roots
}

/** `<sid>` from a transcript path `.../<sid>.jsonl`, or null. */
export function sessionIdFromTranscriptPath(path: string | null): string | null {
  if (!path?.endsWith('.jsonl')) return null
  const sid = basename(path, '.jsonl')
  return sid || null
}

export interface EvidenceSources {
  sessions?: ReadonlyMap<string, string>
  roots?: readonly ProjectRoot[]
}

export type EvidenceSource = 'session' | 'transcript' | 'root'
export type NoEvidenceReason = 'cross-cutting' | 'no-evidence'

export type EpisodeResolution =
  | { target: string; source: EvidenceSource }
  | { target: null; reason: NoEvidenceReason }

function evidenceFor(
  row: UntaggedEpisode,
  sources: EvidenceSources,
): { target: string; source: EvidenceSource } | null {
  if (sources.sessions) {
    const bySession = row.session_id ? sources.sessions.get(row.session_id) : undefined
    if (bySession) return { target: bySession, source: 'session' }
    const sid = sessionIdFromTranscriptPath(row.transcript_path)
    const byTranscript = sid ? sources.sessions.get(sid) : undefined
    if (byTranscript) return { target: byTranscript, source: 'transcript' }
  }
  if (sources.roots && row.cwd) {
    // Root only: the machine running the backfill has none of the captured
    // checkouts, so no git lookup can be made for a stored cwd.
    const rooted = normalizeProjectId(projectForRoot(row.cwd, sources.roots))
    if (rooted) return { target: rooted, source: 'root' }
  }
  return null
}

/**
 * The episode's own session id, then the session parsed from a summary's
 * transcript path, then the longest root containing its cwd. A category
 * stored shared at ingest stays shared whatever the evidence says.
 */
export function resolveEpisodeProject(row: UntaggedEpisode, sources: EvidenceSources): EpisodeResolution {
  const found = evidenceFor(row, sources)
  if (!found) return { target: null, reason: 'no-evidence' }
  if (isCrossCuttingCategory(row.category)) return { target: null, reason: 'cross-cutting' }
  return found
}

export interface EvidenceBackfillReport {
  scanned: number
  /** target project → episode ids */
  assignments: Map<string, string[]>
  /** source → target project → rows */
  bySource: Map<EvidenceSource, Map<string, number>>
  /** rows that stay NULL, by reason */
  unresolved: Map<NoEvidenceReason, number>
  /** target project → rows actually updated (all zero on a dry run) */
  updated: Map<string, number>
}

/** Scans every untagged episode first, then, with `apply`, writes each project. */
export async function runEvidenceBackfill(
  store: ProjectRetagStore,
  sources: EvidenceSources,
  opts: WriteOptions & { since: string | null },
): Promise<EvidenceBackfillReport> {
  requireRollback(opts)
  const rows = await scanAll((cursor) => store.fetchUntaggedEpisodes(opts.since, cursor, opts.pageSize))
  const report: EvidenceBackfillReport = {
    scanned: rows.length,
    assignments: new Map(),
    bySource: new Map(),
    unresolved: new Map(),
    updated: new Map(),
  }
  for (const row of rows) {
    const r = resolveEpisodeProject(row, sources)
    if (r.target === null) {
      increment(report.unresolved, r.reason)
      continue
    }
    pushId(report.assignments, r.target, row.id)
    const perProject = report.bySource.get(r.source) ?? new Map<string, number>()
    increment(perProject, r.target)
    report.bySource.set(r.source, perProject)
  }
  for (const [project, ids] of report.assignments) {
    const n = opts.apply ? await writeChanges(store, opts, 'memory_episodes', ids, null, project) : 0
    report.updated.set(project, n)
  }
  return report
}

export function formatEvidenceReport(report: EvidenceBackfillReport, apply: boolean): string {
  const lines = [`scanned=${report.scanned} (episodes, project_id NULL)`]
  lines.push(apply ? 'target project: planned / updated' : 'target project: would update')
  const perTarget = new Map([...report.assignments].map(([p, ids]) => [p, ids.length] as const))
  for (const [project, n] of sortedByCount(perTarget)) {
    lines.push(apply ? `  ${project}: ${n} / ${report.updated.get(project) ?? 0}` : `  ${project}: ${n}`)
  }
  lines.push('by source:')
  for (const source of ['session', 'transcript', 'root'] as const) {
    const perProject = report.bySource.get(source)
    const total = perProject ? [...perProject.values()].reduce((a, b) => a + b, 0) : 0
    lines.push(`  ${source}: ${total}`)
    for (const [project, n] of sortedByCount(perProject ?? new Map<string, number>())) {
      lines.push(`    ${project}: ${n}`)
    }
  }
  const unresolvedTotal = [...report.unresolved.values()].reduce((a, b) => a + b, 0)
  lines.push(`stays NULL: ${unresolvedTotal}`)
  for (const [reason, n] of sortedByCount(report.unresolved)) lines.push(`  ${reason}: ${n}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Retag mode: move a non-null project (a worktree's name) to another.
// ---------------------------------------------------------------------------

export interface RetagPair {
  from: string
  to: string
}

/** `FROM=TO`; TO must name a project (retagging into the shared bucket is not a rename). */
export function parseRetagPair(spec: string): RetagPair {
  const eq = spec.indexOf('=')
  const from = spec.slice(0, eq).trim()
  const to = normalizeProjectId(spec.slice(eq + 1))
  if (eq <= 0 || !from || !to) throw new Error(`--retag expects FROM=TO with a project as TO, got "${spec}"`)
  if (from === to) throw new Error(`--retag ${spec} renames a project to itself`)
  return { from, to }
}

/**
 * Pairs must be independent: a repeated FROM, or a TO that is another
 * pair's FROM, would make the result depend on order and the dry run differ
 * from the apply.
 */
export function validateRetagPairs(pairs: readonly RetagPair[]): void {
  const froms = new Set<string>()
  for (const { from } of pairs) {
    if (froms.has(from)) throw new Error(`--retag lists ${from} twice`)
    froms.add(from)
  }
  for (const { from, to } of pairs) {
    if (froms.has(to)) throw new Error(`--retag ${from}=${to} chains into another pair's FROM`)
  }
}

export interface RetagReport {
  /** `from -> to` → table → planned / updated */
  pairs: Array<{ pair: RetagPair; tables: Map<ProjectTable, { planned: number; updated: number }> }>
}

export async function runRetag(
  store: ProjectRetagStore,
  pairs: readonly RetagPair[],
  opts: WriteOptions,
): Promise<RetagReport> {
  requireRollback(opts)
  validateRetagPairs(pairs)
  const report: RetagReport = { pairs: [] }
  for (const pair of pairs) {
    const tables = new Map<ProjectTable, { planned: number; updated: number }>()
    for (const table of PROJECT_TABLES) {
      const rows = await scanAll((cursor) => store.fetchTagged(table, pair.from, cursor, opts.pageSize))
      const ids = rows.map((r) => r.id)
      const updated = opts.apply ? await writeChanges(store, opts, table, ids, pair.from, pair.to) : 0
      tables.set(table, { planned: ids.length, updated })
    }
    report.pairs.push({ pair, tables })
  }
  return report
}

export function formatRetagReport(report: RetagReport, apply: boolean): string {
  const lines = [apply ? 'retag: planned / updated' : 'retag: would update']
  for (const { pair, tables } of report.pairs) {
    lines.push(`  ${pair.from} -> ${pair.to}`)
    for (const [table, { planned, updated }] of tables) {
      lines.push(apply ? `    ${table}: ${planned} / ${updated}` : `    ${table}: ${planned}`)
    }
  }
  return lines.join('\n')
}

/** Rows per non-null project across episodes and digests. */
export async function collectProjectCounts(store: ProjectRetagStore, pageSize: number): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const table of PROJECT_TABLES) {
    const rows = await scanAll((cursor) => store.fetchTagged(table, null, cursor, pageSize))
    for (const row of rows) increment(counts, row.project_id)
  }
  return counts
}

export interface RetagProposal extends RetagPair {
  rows: number
}

/**
 * `FROM=TO` pairs the worktree folding (and explicit `--map` aliases)
 * proposes for project ids already stored. Names that would fold into the
 * shared bucket are not proposed: a retag only renames.
 */
export function proposeWorktreeRetags(
  counts: ReadonlyMap<string, number>,
  rules: BackfillRules = EMPTY_RULES,
): RetagProposal[] {
  const known = knownRepositories(counts.keys(), rules)
  const proposals: RetagProposal[] = []
  for (const [tag, rows] of counts) {
    const { target, reason } = resolveTag(tag, null, known, rules)
    if (target === null || target === tag || (reason !== 'worktree' && reason !== 'alias')) continue
    proposals.push({ from: tag, to: target, rows })
  }
  return proposals.sort((a, b) => a.from.localeCompare(b.from))
}

export function formatRetagProposals(proposals: readonly RetagProposal[]): string {
  const lines = [`proposed retags: ${proposals.length} (not applied; pass each as --retag)`]
  for (const p of proposals) lines.push(`  --retag ${p.from}=${p.to}   # ${p.rows} rows`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Rollback mode.
// ---------------------------------------------------------------------------

export interface RollbackReport {
  /** table → rows listed / rows restored (zero on a dry run) */
  tables: Map<ProjectTable, { listed: number; restored: number }>
}

/**
 * Restores `old` on each listed row that still holds `new`, so a row changed
 * again since the apply is left as it is.
 */
export async function runRollback(
  store: ProjectRetagStore,
  changes: readonly ProjectChange[],
  opts: { apply: boolean; batchSize: number },
): Promise<RollbackReport> {
  const groups = new Map<string, { table: ProjectTable; old: string | null; new: string | null; ids: string[] }>()
  for (const c of changes) {
    const key = JSON.stringify([c.table, c.old, c.new])
    const group = groups.get(key) ?? { table: c.table, old: c.old, new: c.new, ids: [] }
    group.ids.push(c.id)
    groups.set(key, group)
  }
  const tables = new Map<ProjectTable, { listed: number; restored: number }>()
  for (const group of groups.values()) {
    const ids = [...new Set(group.ids)]
    let restored = 0
    if (opts.apply) {
      for (const batch of chunk(ids, opts.batchSize)) {
        restored += (await store.setProject(group.table, batch, group.new, group.old)).length
      }
    }
    const t = tables.get(group.table) ?? { listed: 0, restored: 0 }
    tables.set(group.table, { listed: t.listed + ids.length, restored: t.restored + restored })
  }
  return { tables }
}

export function formatRollbackReport(report: RollbackReport, apply: boolean): string {
  const lines = [apply ? 'rollback: listed / restored' : 'rollback: would restore']
  for (const [table, { listed, restored }] of report.tables) {
    lines.push(apply ? `  ${table}: ${listed} / ${restored}` : `  ${table}: ${listed}`)
  }
  return lines.join('\n')
}
