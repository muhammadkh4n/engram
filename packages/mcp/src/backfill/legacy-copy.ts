/**
 * Copies the old memory tables into the item store as class `legacy`.
 *
 * `planLegacyProjects` lists every distinct raw project value of the old
 * tables with its row counts and what the project resolver makes of it; its
 * map is what the copy writes into each item's project and workspace.
 *
 * `runLegacyCopy` runs the store's five steps in their fixed order until each
 * has nothing left. A batch of a copy step is read from
 * `engram_legacy_pending`, every text is scrubbed with the same scrubber and
 * secret registry as the capture route, its entities are extracted from the
 * scrubbed text, and only then is the batch handed to `engram_legacy_copy`,
 * which writes the items, their masks and their entities in one statement.
 * No unscrubbed text is ever inserted. Masks are logged by row id, detector
 * and secret name, never by value.
 */

import { scrubSecrets, statementEntities } from '@engram-mem/core'
import type { PostgrestClient } from '@supabase/postgrest-js'
import type { ProjectResolver, ResolverRule } from './project-resolver.js'

export const LEGACY_TABLES = ['memory_episodes', 'memory_digests', 'memory_semantic'] as const
export type LegacyTable = (typeof LEGACY_TABLES)[number]

export const COPY_STEPS = ['episodes', 'digests', 'facts'] as const
export const LEGACY_STEPS = [...COPY_STEPS, 'fact_supersession', 'forgets'] as const
export type LegacyStep = (typeof LEGACY_STEPS)[number]

/** Rows per `engram_legacy_pending` / `engram_legacy_copy` round trip; the functions accept up to 1,000. */
export const COPY_BATCH_ROWS = 200
const PAGE_ROWS = 1000

export interface LegacyMask {
  detector: string
  secret_name: string | null
}

export interface LegacyEntity {
  entity: string
  entity_type: string
}

export interface LegacyCopyRow {
  id: string
  content: string
  masks: LegacyMask[]
  entities: LegacyEntity[]
}

export interface LegacyStepResult {
  step: string
  copied: number
  remaining: number
  not_later?: number
  skipped?: number
}

export type ProjectMap = Record<string, { project_id: string | null; workspace_id: string | null }>

/** A registry row; only kind `project` names a repository for the entity extractor. */
export interface LegacyProject {
  id: string
  kind: string
}

export interface LegacyCopyStore {
  /** Each distinct `project_id` of an old table (NULL included) with its row count. */
  projectValues(table: LegacyTable): Promise<Map<string | null, number>>
  proceduralRows(): Promise<number>
  /** A step's pending work without writing anything. */
  pendingCount(step: LegacyStep): Promise<number>
  pending(step: LegacyStep, limit: number): Promise<Array<{ id: string; text: string }>>
  copy(step: LegacyStep, map: ProjectMap, rows: LegacyCopyRow[] | null): Promise<LegacyStepResult>
}

// ── Plan ─────────────────────────────────────────────────────────────────

export interface LegacyPlanEntry {
  raw: string | null
  rows: Record<LegacyTable, number>
  project_id: string | null
  workspace_id: string | null
  /** The resolver's rule; `null_project` for rows with no project value, which stay unattributed. */
  rule: ResolverRule | 'null_project'
}

export interface LegacyPlan {
  command: 'legacy-copy'
  mode: 'plan'
  entries: LegacyPlanEntry[]
  map: ProjectMap
}

async function rawValueCounts(store: LegacyCopyStore): Promise<Map<string | null, Record<LegacyTable, number>>> {
  const counts = new Map<string | null, Record<LegacyTable, number>>()
  for (const table of LEGACY_TABLES) {
    for (const [raw, n] of await store.projectValues(table)) {
      const row = counts.get(raw) ?? { memory_episodes: 0, memory_digests: 0, memory_semantic: 0 }
      counts.set(raw, { ...row, [table]: n })
    }
  }
  return counts
}

export async function planLegacyProjects(store: LegacyCopyStore, resolve: ProjectResolver): Promise<LegacyPlan> {
  const entries: LegacyPlanEntry[] = []
  const map: ProjectMap = {}
  for (const [raw, rows] of await rawValueCounts(store)) {
    if (raw === null) {
      entries.push({ raw, rows, project_id: null, workspace_id: null, rule: 'null_project' })
      continue
    }
    const r = resolve(raw)
    entries.push({ raw, rows, project_id: r.project_id, workspace_id: r.workspace_id, rule: r.rule })
    map[raw] = { project_id: r.project_id, workspace_id: r.workspace_id }
  }
  entries.sort((a, b) => (a.raw ?? '').localeCompare(b.raw ?? '') || (a.raw === null ? -1 : 1))
  return { command: 'legacy-copy', mode: 'plan', entries, map: Object.fromEntries(Object.entries(map).sort()) }
}

/** Reads a project map as `--plan --map-out` writes it; a value of another shape throws. */
export function parseProjectMap(doc: unknown): ProjectMap {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the map must be a JSON object')
  const map: ProjectMap = {}
  for (const [raw, value] of Object.entries(doc)) {
    const v = value as Record<string, unknown> | null
    const ok =
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).every((k) => k === 'project_id' || k === 'workspace_id') &&
      (v.project_id === null || typeof v.project_id === 'string') &&
      (v.workspace_id === null || typeof v.workspace_id === 'string')
    if (!ok) throw new Error(`map key ${JSON.stringify(raw)} must map to {project_id, workspace_id}, each a string or null`)
    map[raw] = { project_id: v.project_id as string | null, workspace_id: v.workspace_id as string | null }
  }
  return map
}

// ── Copy ─────────────────────────────────────────────────────────────────

export interface LegacyStepSummary extends LegacyStepResult {
  /** Rows read from `engram_legacy_pending` and sent in batches. */
  sent: number
  masked: number
  entities: number
}

export interface LegacyCopySummary {
  command: 'legacy-copy'
  mode: 'copy'
  apply: boolean
  /** Raw project values the map does not name; a copy refuses to start while any is left. */
  unmapped: string[]
  steps: LegacyStepSummary[]
}

export interface LegacyCopyOptions {
  store: LegacyCopyStore
  map: ProjectMap
  projects: readonly LegacyProject[]
  apply: boolean
  log: (line: string) => void
  batchRows?: number
}

/** The row as `engram_legacy_copy` takes it: scrubbed text, its masks, and the entities of the scrubbed text. */
export async function prepareLegacyRow(
  row: { id: string; text: string },
  projects: readonly LegacyProject[],
): Promise<LegacyCopyRow> {
  const scrubbed = await scrubSecrets(row.text)
  return {
    id: row.id,
    content: scrubbed.text,
    masks: scrubbed.redactions.map((r) => ({ detector: r.kind, secret_name: r.name ?? null })),
    entities: statementEntities(scrubbed.text, null, projects),
  }
}

async function copyRows(opts: LegacyCopyOptions, step: LegacyStep): Promise<LegacyStepSummary> {
  const summary: LegacyStepSummary = { step, copied: 0, remaining: 0, sent: 0, masked: 0, entities: 0 }
  for (;;) {
    const pending = await opts.store.pending(step, opts.batchRows ?? COPY_BATCH_ROWS)
    if (pending.length === 0) return summary
    const rows: LegacyCopyRow[] = []
    for (const row of pending) rows.push(await prepareLegacyRow(row, opts.projects))
    for (const row of rows) {
      for (const m of row.masks) opts.log(`masked ${step} ${row.id}: ${m.detector} ${m.secret_name ?? '(unnamed)'}`)
    }
    const result = await opts.store.copy(step, opts.map, rows)
    if (result.copied === 0) throw new Error(`step ${step}: a batch of ${rows.length} pending rows copied nothing`)
    summary.copied += result.copied
    summary.remaining = result.remaining
    summary.sent += rows.length
    summary.masked += rows.reduce((n, r) => n + r.masks.length, 0)
    summary.entities += rows.reduce((n, r) => n + r.entities.length, 0)
  }
}

/** Runs one step to completion; a copy step goes batch by batch, the other two in one call. */
export async function runLegacyStep(opts: LegacyCopyOptions, step: LegacyStep): Promise<LegacyStepSummary> {
  if ((COPY_STEPS as readonly string[]).includes(step)) return copyRows(opts, step)
  const result = await opts.store.copy(step, opts.map, null)
  return { ...result, sent: 0, masked: 0, entities: 0 }
}

async function unmappedValues(store: LegacyCopyStore, map: ProjectMap): Promise<string[]> {
  const raws = [...(await rawValueCounts(store)).keys()]
  return raws.filter((raw): raw is string => raw !== null && !Object.hasOwn(map, raw)).sort()
}

/**
 * Copies every old row, links the supersessions and forgets what the old
 * tables had forgotten. A dry run reports each step's pending work and the
 * unmapped project values, and writes nothing. `memory_procedural` is never
 * copied, so rows in it stop the run.
 */
export async function runLegacyCopy(opts: LegacyCopyOptions): Promise<LegacyCopySummary> {
  const procedural = await opts.store.proceduralRows()
  if (procedural > 0) throw new Error(`memory_procedural has ${procedural} rows, which the legacy copy does not carry`)
  const unmapped = await unmappedValues(opts.store, opts.map)
  const summary: LegacyCopySummary = { command: 'legacy-copy', mode: 'copy', apply: opts.apply, unmapped, steps: [] }
  if (!opts.apply) {
    for (const step of LEGACY_STEPS) {
      summary.steps.push({ step, copied: 0, remaining: await opts.store.pendingCount(step), sent: 0, masked: 0, entities: 0 })
    }
    return summary
  }
  if (unmapped.length > 0) throw new Error(`the map does not name ${unmapped.length} raw project value(s): ${unmapped.join(', ')}`)
  for (const step of LEGACY_STEPS) {
    const result = await runLegacyStep(opts, step)
    summary.steps.push(result)
    if (result.remaining > 0) throw new Error(`step ${step} still has ${result.remaining} rows of work left`)
  }
  return summary
}

// ── PostgREST ────────────────────────────────────────────────────────────

function failed(what: string, error: { message: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? 'no data'}`)
}

/** The store behind PostgREST as `service_role`: reads of the old tables, and the two legacy RPCs. */
export function postgrestLegacyCopyStore(client: PostgrestClient): LegacyCopyStore {
  return {
    async projectValues(table) {
      const counts = new Map<string | null, number>()
      let after: string | null = null
      for (;;) {
        let q = client.from(table).select('id, project_id').order('id').limit(PAGE_ROWS)
        if (after !== null) q = q.gt('id', after)
        const { data, error } = await q
        if (error || !data) failed(`read ${table}`, error)
        const rows = data as Array<{ id: string; project_id: string | null }>
        for (const r of rows) counts.set(r.project_id, (counts.get(r.project_id) ?? 0) + 1)
        if (rows.length < PAGE_ROWS) return counts
        after = rows[rows.length - 1]!.id
      }
    },
    async proceduralRows() {
      const { count, error } = await client.from('memory_procedural').select('id', { count: 'exact', head: true })
      if (error || count === null) failed('count memory_procedural', error)
      return count
    },
    async pendingCount(step) {
      const { count, error } = await client
        .rpc('engram_legacy_work', { p_step: step }, { count: 'exact', head: true })
        .eq('state', 'pending')
      if (error || count === null) failed(`count pending ${step}`, error)
      return count
    },
    async pending(step, limit) {
      const { data, error } = await client.rpc('engram_legacy_pending', { p_step: step, p_limit: limit })
      if (error || !Array.isArray(data)) failed(`engram_legacy_pending ${step}`, error)
      return data as Array<{ id: string; text: string }>
    },
    async copy(step, map, rows) {
      const { data, error } = await client.rpc('engram_legacy_copy', { p_step: step, p_project_map: map, p_rows: rows })
      if (error || data === null || typeof data !== 'object') failed(`engram_legacy_copy ${step}`, error)
      return data as LegacyStepResult
    },
  }
}
