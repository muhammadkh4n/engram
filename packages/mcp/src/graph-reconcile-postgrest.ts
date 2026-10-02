/**
 * PostgREST side of the graph reconcile: pages the SQL memory tables in
 * (created_at, id) order, looks rows up by id at delete time, and reads the
 * text of semantic and digest rows by id for the context-link check.
 */
import type { PostgrestClient } from '@supabase/postgrest-js'
import { buildKeysetFilter } from './ingest/embed-backfill-lib.js'
import type { MemoryText, TextTier } from './graph-reconcile-context.js'
import type { ReconcileSqlSource, SqlSourceRow, SqlTier } from './graph-reconcile-lib.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ID_LOOKUP_SLICE = 200

const TABLES: Record<SqlTier, { table: string; columns: string }> = {
  episode: { table: 'memory_episodes', columns: 'id, project_id, created_at, forgotten_at' },
  digest: { table: 'memory_digests', columns: 'id, project_id, created_at' },
  semantic: { table: 'memory_semantic', columns: 'id, project_id, created_at, forgotten_at, superseded_by' },
  procedural: { table: 'memory_procedural', columns: 'id, project_id, created_at, forgotten_at' },
}

interface TextRow {
  id: string
  topic?: string | null
  content?: string | null
  summary?: string | null
  forgotten_at?: string | null
  superseded_by?: string | null
}

const TEXT_TABLES: Record<TextTier, { table: string; columns: string; text(row: TextRow): string }> = {
  // The same text deep sleep matches a fact's entities against.
  semantic: {
    table: 'memory_semantic',
    columns: 'id, topic, content, forgotten_at, superseded_by',
    text: (row) => `${row.topic ?? ''} ${row.content ?? ''}`,
  },
  // Digests have no forgotten_at and are never superseded.
  digest: { table: 'memory_digests', columns: 'id, summary', text: (row) => row.summary ?? '' },
}

/**
 * Rows of `table` whose id is in `ids`. The ids are uuid columns: a non-uuid
 * id has no row, and would make Postgres reject the filter. Sliced so the id
 * list stays inside a request URL's length limit.
 */
async function selectByIds<T>(
  client: PostgrestClient,
  table: string,
  columns: string,
  ids: readonly string[],
): Promise<T[]> {
  const uuids = ids.filter((id) => UUID_RE.test(id))
  const rows: T[] = []
  for (let i = 0; i < uuids.length; i += ID_LOOKUP_SLICE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .in('id', uuids.slice(i, i + ID_LOOKUP_SLICE))
    if (error) throw new Error(`${table} id lookup failed: ${error.message}`)
    rows.push(...((data ?? []) as unknown as T[]))
  }
  return rows
}

export function postgrestSource(client: PostgrestClient): ReconcileSqlSource {
  return {
    async fetchPage(tier, cursor, pageSize) {
      const { table, columns } = TABLES[tier]
      let q = client
        .from(table)
        .select(columns)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(pageSize)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
      if (error) throw new Error(`${table} fetch failed: ${error.message}`)
      return (data ?? []) as unknown as Awaited<ReturnType<ReconcileSqlSource['fetchPage']>>
    },
    async fetchByIds(tier, ids) {
      const { table, columns } = TABLES[tier]
      return selectByIds<SqlSourceRow>(client, table, columns, ids)
    },
    async fetchTexts(tier, ids) {
      const { table, columns, text } = TEXT_TABLES[tier]
      const rows = await selectByIds<TextRow>(client, table, columns, ids)
      return rows.map(
        (row): MemoryText => ({
          id: row.id,
          tier,
          text: text(row),
          inactive: row.forgotten_at != null || row.superseded_by != null,
        }),
      )
    },
  }
}
