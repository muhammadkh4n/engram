/**
 * The legacy salvage's reads through PostgREST, as service_role. Every read is
 * paged or bounded: PostgREST may cap a response at its max-rows, and a cut
 * listing would make a covered session look uncovered or drop a session's
 * rows. Writes go through the run RPCs on the capture store only.
 */
import type { PostgrestClient } from '@supabase/postgrest-js'
import type {
  LegacyRow,
  ProjectValue,
  SalvageObservationRow,
  SalvageProject,
  SalvageStore,
  SalvageSubjectRow,
} from './salvage.js'
import { SALVAGE_EXTRACTOR } from './salvage.js'
import { SALVAGE_VERSION } from './salvage-prompt.js'

const PAGE_ROWS = 1000
/** Window keys per read: 64 hex chars each keeps the request line short. */
const KEYS_PER_READ = 100

const LEGACY_COLUMNS = 'id, kind, session_id, project_id, workspace_id, content, occurred_at, forgotten_at, retired_at, source'

interface PgError {
  message?: string
  code?: string
}

function failed(what: string, error: PgError | null): never {
  const err = new Error(`legacy salvage: ${what} failed${error?.message ? `: ${error.message}` : ''}`)
  if (error?.code) Object.assign(err, { code: error.code })
  throw err
}

/** A PostgREST `or` filter for a column holding one of the project values, null included. */
function projectFilter(column: string, projects: readonly ProjectValue[]): string {
  const ids = projects.filter((p): p is string => p !== null)
  const parts: string[] = []
  if (ids.length > 0) parts.push(`${column}.in.(${ids.map((id) => JSON.stringify(id)).join(',')})`)
  if (projects.includes(null)) parts.push(`${column}.is.null`)
  return parts.join(',')
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toLegacyRow(row: Record<string, unknown>): LegacyRow {
  const source = (row.source ?? {}) as Record<string, unknown>
  return {
    id: String(row.id),
    kind: String(row.kind),
    session_id: String(row.session_id),
    project_id: text(row.project_id),
    workspace_id: text(row.workspace_id),
    content: String(row.content ?? ''),
    occurred_at: String(row.occurred_at),
    forgotten_at: text(row.forgotten_at),
    retired_at: text(row.retired_at),
    role: text(source.role),
    producer: text(source.producer),
    legacy_superseded_by: text(source.legacy_superseded_by),
  }
}

export function postgrestSalvageStore(client: PostgrestClient): SalvageStore {
  return {
    async legacySessions() {
      const sessions = new Set<string>()
      let after: string | null = null
      for (;;) {
        let q = client
          .from('memory_items')
          .select('id, session_id')
          .eq('class', 'legacy')
          .is('forgotten_at', null)
          .not('session_id', 'is', null)
          .order('id')
          .limit(PAGE_ROWS)
        if (after !== null) q = q.gt('id', after)
        const { data, error } = await q
        if (error || !data) failed('read legacy sessions', error)
        const rows = data as Array<{ id: string; session_id: string }>
        for (const r of rows) sessions.add(r.session_id)
        if (rows.length < PAGE_ROWS) return [...sessions]
        after = rows[rows.length - 1]!.id
      }
    },

    async transcriptSessions(sessionIds) {
      const covered = new Set<string>()
      for (const sessionId of new Set(sessionIds)) {
        const { data, error } = await client
          .from('memory_items')
          .select('id')
          .eq('class', 'utterance')
          .eq('session_id', sessionId)
          .eq('source->>type', 'transcript')
          .limit(1)
        if (error || !data) failed('read transcript coverage', error)
        if (data.length > 0) covered.add(sessionId)
      }
      return covered
    },

    async sessionRows(sessionId) {
      const rows: LegacyRow[] = []
      for (let from = 0; ; from += PAGE_ROWS) {
        const { data, error } = await client
          .from('memory_items')
          .select(LEGACY_COLUMNS)
          .eq('class', 'legacy')
          .eq('session_id', sessionId)
          .order('occurred_at')
          .order('id')
          .range(from, from + PAGE_ROWS - 1)
        if (error || !data) failed('read session rows', error)
        const page = data as unknown as Array<Record<string, unknown>>
        rows.push(...page.map(toLegacyRow))
        if (page.length < PAGE_ROWS) return rows
      }
    },

    async activeSubjects(projects) {
      if (projects.length === 0) return []
      const subjects: SalvageSubjectRow[] = []
      for (let from = 0; ; from += PAGE_ROWS) {
        // The inner embed keeps a subject only when a current item files it,
        // and its newest such item dates the subject's last use.
        const { data, error } = await client
          .from('memory_subjects')
          .select('id, label, project_id, memory_items!inner(occurred_at)')
          .or(projectFilter('project_id', projects))
          .is('memory_items.superseded_by', null)
          .is('memory_items.retired_at', null)
          .is('memory_items.forgotten_at', null)
          .order('occurred_at', { referencedTable: 'memory_items', ascending: false })
          .limit(1, { referencedTable: 'memory_items' })
          .order('id')
          .range(from, from + PAGE_ROWS - 1)
        if (error || !data) failed('read subjects', error)
        const page = data as unknown as Array<{
          id: string
          label: string
          project_id: string | null
          memory_items: Array<{ occurred_at: string }>
        }>
        for (const s of page) {
          subjects.push({ id: s.id, label: s.label, project_id: s.project_id, last_used_at: s.memory_items[0]?.occurred_at ?? null })
        }
        if (page.length < PAGE_ROWS) return subjects
      }
    },

    async salvageObservations(projects, limit) {
      if (projects.length === 0 || limit < 1) return []
      const { data, error } = await client
        .from('memory_items')
        .select('id, kind, subject_id, project_id, workspace_id, content, occurred_at, memory_subjects(label)')
        .eq('class', 'observation')
        .eq('source->>extractor', SALVAGE_EXTRACTOR)
        .is('superseded_by', null)
        .is('retired_at', null)
        .is('forgotten_at', null)
        .or(projectFilter('project_id', projects))
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)
      if (error || !data) failed('read salvage observations', error)
      const rows = data as unknown as Array<Record<string, unknown> & { memory_subjects: { label: string } | null }>
      return rows.map(
        (r): SalvageObservationRow => ({
          id: String(r.id),
          kind: String(r.kind),
          subject_id: text(r.subject_id),
          subject_label: r.memory_subjects?.label ?? null,
          project_id: text(r.project_id),
          workspace_id: text(r.workspace_id),
          content: String(r.content ?? ''),
          occurred_at: String(r.occurred_at),
        }),
      )
    },

    async completedWindowKeys(keys) {
      const done = new Set<string>()
      const unique = [...new Set(keys)]
      for (let i = 0; i < unique.length; i += KEYS_PER_READ) {
        const { data, error } = await client
          .from('memory_extraction_runs')
          .select('window_key')
          .eq('extractor_version', SALVAGE_VERSION)
          .eq('status', 'succeeded')
          .in('window_key', unique.slice(i, i + KEYS_PER_READ))
        if (error || !data) failed('read completed windows', error)
        for (const r of data as Array<{ window_key: string }>) done.add(r.window_key)
      }
      return done
    },

    async projects() {
      const { data, error } = await client.from('memory_projects').select('id, kind').order('id')
      if (error || !data) failed('read projects', error)
      return (data as SalvageProject[]).map((p) => ({ id: p.id, kind: p.kind }))
    },
  }
}
