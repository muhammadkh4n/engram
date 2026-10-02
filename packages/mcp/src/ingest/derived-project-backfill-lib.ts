/**
 * Restores `project_id` on derived memories — digests and semantic facts —
 * from the memories they were derived from.
 *
 * Consolidation records derivation as `derives_from` association edges:
 * episode → digest (light sleep) and digest → semantic (deep sleep). A
 * derived row stored without a project gets one only when the evidence is
 * unanimous:
 *   - every tagged source holds the same project → that project;
 *   - tagged sources disagree → stays NULL (`mixed`);
 *   - no source is tagged, or no source edge exists → stays NULL
 *     (`no-source-tag`).
 * Untagged sources carry no evidence either way and are ignored.
 *
 * Semantic facts are resolved after digests in the same run, over the
 * digests' projects as they will be after the digest pass, so a dry run
 * reports the same result an apply would produce.
 *
 * Only rows whose `project_id` is NULL are read or written, so a repeat run
 * touches nothing already tagged. A project tag only ranks memories, it
 * never hides one, so a wrong tag costs ranking, not recall. An apply
 * records every row it tagged, so it can be undone exactly.
 */

import { closeSync, openSync, writeSync } from 'node:fs'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { buildKeysetFilter, chunk, nextCursor, type PageCursor } from './embed-backfill-lib.js'

export type DerivedKind = 'digest' | 'semantic'
export type SourceKind = 'episode' | 'digest'

/** The memory kind each derived kind is built from. */
export const SOURCE_KIND: Readonly<Record<DerivedKind, SourceKind>> = {
  digest: 'episode',
  semantic: 'digest',
}

export interface DerivedRow {
  id: string
  created_at: string
}

export interface DerivationEdge {
  source_id: string
  target_id: string
}

export interface SourceProject {
  id: string
  project_id: string | null
}

/** Storage seam: the CLI binds it to PostgREST, tests to an in-memory stub. */
export interface DerivedProjectStore {
  /**
   * Rows of `kind` with a NULL `project_id`, ordered by (created_at, id),
   * strictly after `cursor`.
   */
  fetchUntagged(kind: DerivedKind, cursor: PageCursor | null, pageSize: number): Promise<DerivedRow[]>
  /** Every `derives_from` edge from a `sourceKind` row into one of `targetIds`. */
  fetchDerivationEdges(
    sourceKind: SourceKind,
    targetKind: DerivedKind,
    targetIds: readonly string[],
  ): Promise<DerivationEdge[]>
  /** `project_id` of the given source rows (missing rows are simply absent). */
  fetchProjects(kind: SourceKind, ids: readonly string[]): Promise<SourceProject[]>
  /**
   * Sets `project_id` on the given ids that still have a NULL one; returns
   * the ids actually changed.
   */
  assignProject(kind: DerivedKind, ids: readonly string[], project: string): Promise<string[]>
}

/** One row an apply tagged. */
export interface AppliedEntry {
  tier: DerivedKind
  id: string
  project_id: string
}

/** Receives each written batch as soon as the store confirms it. */
export interface AppliedSink {
  write(entries: readonly AppliedEntry[]): void
}

export type UnresolvedReason = 'mixed' | 'no-source-tag'

export type DerivedResolution =
  | { target: string; reason: 'unanimous' }
  | { target: null; reason: UnresolvedReason }

function tagOf(project: string | null | undefined): string | null {
  const trimmed = project?.trim()
  return trimmed ? trimmed : null
}

/** The unanimity rule over the projects of one row's sources. */
export function resolveDerivedProject(sourceProjects: Iterable<string | null>): DerivedResolution {
  const tags = new Set<string>()
  for (const p of sourceProjects) {
    const tag = tagOf(p)
    if (tag) tags.add(tag)
  }
  if (tags.size === 0) return { target: null, reason: 'no-source-tag' }
  if (tags.size > 1) return { target: null, reason: 'mixed' }
  return { target: [...tags][0]!, reason: 'unanimous' }
}

export interface PassReport {
  kind: DerivedKind
  scanned: number
  /** target project → row ids */
  assignments: Map<string, string[]>
  /** rows that stay NULL, by reason → row ids */
  unresolved: Map<UnresolvedReason, string[]>
  /** target project → rows actually updated (all zero on a dry run) */
  updated: Map<string, number>
}

export interface DerivedBackfillReport {
  digest: PassReport
  semantic: PassReport
}

export interface DerivedBackfillOptions {
  apply: boolean
  pageSize: number
  /** ids per lookup and per update */
  batchSize: number
  /** required for apply: every row written, for an exact undo */
  applied?: AppliedSink
}

function push<K>(map: Map<K, string[]>, key: K, id: string): void {
  const ids = map.get(key)
  if (ids) ids.push(id)
  else map.set(key, [id])
}

/**
 * Every untagged row of `kind`. Only an empty page ends the walk: PostgREST
 * truncates a response at its max-rows setting without saying so, so a page
 * shorter than `pageSize` may just be that cap.
 */
async function scanUntagged(
  store: DerivedProjectStore,
  kind: DerivedKind,
  pageSize: number,
): Promise<DerivedRow[]> {
  const rows: DerivedRow[] = []
  let cursor: PageCursor | null = null
  for (;;) {
    const page = await store.fetchUntagged(kind, cursor, pageSize)
    if (page.length === 0) return rows
    rows.push(...page)
    cursor = nextCursor(page)
  }
}

/** Source ids per target id, deduplicated (an edge may be recorded twice). */
async function sourcesByTarget(
  store: DerivedProjectStore,
  kind: DerivedKind,
  targetIds: readonly string[],
  batchSize: number,
): Promise<Map<string, Set<string>>> {
  const sources = new Map<string, Set<string>>()
  for (const batch of chunk(targetIds, batchSize)) {
    const edges = await store.fetchDerivationEdges(SOURCE_KIND[kind], kind, batch)
    for (const { source_id, target_id } of edges) {
      const set = sources.get(target_id)
      if (set) set.add(source_id)
      else sources.set(target_id, new Set([source_id]))
    }
  }
  return sources
}

async function projectsOf(
  store: DerivedProjectStore,
  kind: SourceKind,
  ids: readonly string[],
  batchSize: number,
): Promise<Map<string, string | null>> {
  const projects = new Map<string, string | null>()
  for (const batch of chunk(ids, batchSize)) {
    for (const row of await store.fetchProjects(kind, batch)) projects.set(row.id, row.project_id)
  }
  return projects
}

/**
 * Plans one derived kind and, with `apply`, writes it. `pending` holds
 * source projects decided earlier in the run but possibly not yet written
 * (a dry run); it wins over the stored NULL.
 */
async function runPass(
  store: DerivedProjectStore,
  kind: DerivedKind,
  pending: ReadonlyMap<string, string>,
  opts: DerivedBackfillOptions,
): Promise<PassReport> {
  const rows = await scanUntagged(store, kind, opts.pageSize)
  const rowIds = rows.map((r) => r.id)
  const sources = await sourcesByTarget(store, kind, rowIds, opts.batchSize)
  const allSourceIds = [...new Set([...sources.values()].flatMap((s) => [...s]))]
  const stored = await projectsOf(store, SOURCE_KIND[kind], allSourceIds, opts.batchSize)

  const report: PassReport = {
    kind,
    scanned: rows.length,
    assignments: new Map(),
    unresolved: new Map(),
    updated: new Map(),
  }
  for (const id of rowIds) {
    const sourceIds = [...(sources.get(id) ?? [])]
    const resolution = resolveDerivedProject(
      sourceIds.map((s) => pending.get(s) ?? stored.get(s) ?? null),
    )
    if (resolution.target === null) push(report.unresolved, resolution.reason, id)
    else push(report.assignments, resolution.target, id)
  }

  for (const [project, ids] of report.assignments) {
    let count = 0
    if (opts.apply) {
      for (const batch of chunk(ids, opts.batchSize)) {
        const changed = await store.assignProject(kind, batch, project)
        opts.applied!.write(changed.map((id) => ({ tier: kind, id, project_id: project })))
        count += changed.length
      }
    }
    report.updated.set(project, count)
  }
  return report
}

/**
 * Digests first, then semantic facts over the digests' resulting projects.
 * Each pass scans all of its candidates before writing, so updates cannot
 * shift the keyset pages under the scan.
 */
export async function runDerivedProjectBackfill(
  store: DerivedProjectStore,
  opts: DerivedBackfillOptions,
): Promise<DerivedBackfillReport> {
  if (opts.apply && !opts.applied) throw new Error('apply requires an applied-rows sink')
  const digest = await runPass(store, 'digest', new Map(), opts)
  const digestProjects = new Map<string, string>()
  for (const [project, ids] of digest.assignments) for (const id of ids) digestProjects.set(id, project)
  const semantic = await runPass(store, 'semantic', digestProjects, opts)
  return { digest, semantic }
}

export const SAMPLE_SIZE = 10

function byCountDesc<K>(map: ReadonlyMap<K, string[]>): Array<[K, string[]]> {
  return [...map].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])))
}

function sample(ids: readonly string[]): string {
  return [...ids].sort().slice(0, SAMPLE_SIZE).join(', ')
}

function formatPass(pass: PassReport, apply: boolean): string[] {
  const lines = [`${pass.kind}: scanned=${pass.scanned} (project_id NULL)`]
  lines.push(apply ? '  target project: planned / updated' : '  target project: would update')
  for (const [project, ids] of byCountDesc(pass.assignments)) {
    lines.push(
      apply
        ? `    ${project}: ${ids.length} / ${pass.updated.get(project) ?? 0}`
        : `    ${project}: ${ids.length}`,
    )
    lines.push(`      sample: ${sample(ids)}`)
  }
  const unresolvedTotal = [...pass.unresolved.values()].reduce((n, ids) => n + ids.length, 0)
  lines.push(`  stays NULL: ${unresolvedTotal}`)
  for (const [reason, ids] of byCountDesc(pass.unresolved)) {
    lines.push(`    ${reason}: ${ids.length}`)
    lines.push(`      sample: ${sample(ids)}`)
  }
  return lines
}

/** Counts, project names and up to ten sample ids per bucket: never content. */
export function formatDerivedReport(report: DerivedBackfillReport, apply: boolean): string {
  return [...formatPass(report.digest, apply), ...formatPass(report.semantic, apply)].join('\n')
}

export const APPLIED_CSV_HEADER = 'tier,id,project_id'

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The applied-rows CSV at `path`: created exclusively (0600) before any
 * write, so an earlier run's file is never overwritten, and appended per
 * batch with the rows the store confirmed. Undo a row with
 * `UPDATE memory_<tier> SET project_id = NULL WHERE id = <id> AND project_id = <project_id>`.
 */
export function openAppliedCsv(path: string): AppliedSink & { close(): void } {
  const fd = openSync(path, 'wx', 0o600)
  writeSync(fd, `${APPLIED_CSV_HEADER}\n`)
  return {
    write(entries) {
      if (entries.length === 0) return
      writeSync(fd, entries.map((e) => [e.tier, e.id, e.project_id].map(csvField).join(',')).join('\n') + '\n')
    },
    close() {
      closeSync(fd)
    },
  }
}

const TABLE: Readonly<Record<DerivedKind | SourceKind, string>> = {
  episode: 'memory_episodes',
  digest: 'memory_digests',
  semantic: 'memory_semantic',
}

/**
 * The store over PostgREST. Every paged read walks a key and ends only on an
 * empty page, because the server's max-rows cap can cut any page short
 * without signalling it.
 */
export function postgrestDerivedProjectStore(client: PostgrestClient, pageSize: number): DerivedProjectStore {
  return {
    async fetchUntagged(kind, cursor, limit) {
      let q = client
        .from(TABLE[kind])
        .select('id, created_at')
        .is('project_id', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
      if (error) throw new Error(`fetchUntagged(${kind}) failed: ${error.message}`)
      return (data ?? []) as DerivedRow[]
    },
    async fetchDerivationEdges(sourceKind, targetKind, targetIds) {
      const edges: DerivationEdge[] = []
      let after: string | null = null
      for (;;) {
        let q = client
          .from('memory_associations')
          .select('id, source_id, target_id')
          .eq('edge_type', 'derives_from')
          .eq('source_type', sourceKind)
          .eq('target_type', targetKind)
          .in('target_id', [...targetIds])
        if (after !== null) q = q.gt('id', after)
        const { data, error } = await q.order('id', { ascending: true }).limit(pageSize)
        if (error) throw new Error(`fetchDerivationEdges(${targetKind}) failed: ${error.message}`)
        const page = (data ?? []) as Array<DerivationEdge & { id: string }>
        if (page.length === 0) return edges
        for (const { source_id, target_id } of page) edges.push({ source_id, target_id })
        after = page[page.length - 1]!.id
      }
    },
    async fetchProjects(kind, ids) {
      const { data, error } = await client.from(TABLE[kind]).select('id, project_id').in('id', [...ids])
      if (error) throw new Error(`fetchProjects(${kind}) failed: ${error.message}`)
      return (data ?? []) as SourceProject[]
    },
    async assignProject(kind, ids, project) {
      const { data, error } = await client
        .from(TABLE[kind])
        .update({ project_id: project })
        .in('id', [...ids])
        .is('project_id', null)
        .select('id')
      if (error) throw new Error(`update ${kind} to ${project} failed: ${error.message}`)
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
    },
  }
}
