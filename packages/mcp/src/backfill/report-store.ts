/**
 * The backfill report's reads through PostgREST, as service_role. Listings
 * page by id (keyset), so PostgREST's max-rows can never cut one short;
 * counts use exact head counts. Nothing is written.
 */
import type { PostgrestClient } from '@supabase/postgrest-js'
import { ITEM_CLASSES } from '@engram-mem/core'
import { SALVAGE_EXTRACTOR } from './salvage.js'
import type { CaptureErrorRow, ItemFacet, OldRow, OldTable, ReportStore, RunRow, SamplePopulation, SampleRow } from './report.js'

const PAGE_ROWS = 1000
/** MK utterances may be long; a smaller page keeps one response bounded. */
const TEXT_PAGE_ROWS = 200
/** Ids per `in` filter: 36 chars each keeps the request line short. */
const IDS_PER_READ = 100

const SUPERSESSION_STATES = ['linked', 'not_later', 'pending', 'skipped'] as const

interface PgError {
  message?: string
}

interface PageResult {
  data: unknown[] | null
  error: PgError | null
}

function failed(what: string, error: PgError | null): never {
  throw new Error(`backfill report: ${what} failed${error?.message ? `: ${error.message}` : ''}`)
}

/** Yields every row of a keyset-paged listing; `page(after, size)` must order by `id`. */
async function* paged<T extends { id: unknown }>(
  what: string,
  size: number,
  page: (after: string | null, size: number) => PromiseLike<PageResult>,
): AsyncIterable<T> {
  let after: string | null = null
  for (;;) {
    const { data, error } = await page(after, size)
    if (error || !data) failed(what, error)
    const rows = data as T[]
    yield* rows
    if (rows.length < size) return
    after = String(rows[rows.length - 1]!.id)
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function postgrestReportStore(client: PostgrestClient): ReportStore {
  const count = async (what: string, query: PromiseLike<{ count: number | null; error: PgError | null }>): Promise<number> => {
    const { count: n, error } = await query
    if (error || n === null) failed(what, error)
    return n
  }

  const population = (p: SamplePopulation) => {
    const live = client.from('memory_items').select('id').is('forgotten_at', null)
    switch (p) {
      case 'register_candidates':
        return live.eq('class', 'mk_statement').eq('register_status', 'candidate')
      case 'salvage_observations':
        return live.eq('class', 'observation').eq('source->>extractor', SALVAGE_EXTRACTOR)
      case 'legacy_utterances':
        return live.eq('class', 'utterance').eq('speaker', 'mk').eq('source->>type', 'legacy')
      case 'history_utterances':
        return live.eq('class', 'utterance').eq('speaker', 'mk').eq('source->>type', 'history')
    }
  }

  return {
    async *itemFacets() {
      const rows = paged<Record<string, unknown> & { id: string }>('read items', PAGE_ROWS, (after, size) => {
        const q = client
          .from('memory_items')
          .select('id, class, kind, speaker, source_type:source->>type, time_basis:source->>time_basis, project_id, forgotten_at')
          .order('id')
          .limit(size)
        return after === null ? q : q.gt('id', after)
      })
      for await (const r of rows) {
        yield {
          id: r.id,
          class: String(r.class),
          kind: String(r.kind),
          speaker: String(r.speaker),
          source_type: text(r.source_type),
          time_basis: text(r.time_basis),
          project_id: text(r.project_id),
          forgotten: r.forgotten_at !== null,
        } satisfies ItemFacet
      }
    },

    async *oldRows(table: OldTable) {
      const rows = paged<{ id: string; project_id: string | null; forgotten_at: string | null }>(`read ${table}`, PAGE_ROWS, (after, size) => {
        const q = client.from(table).select('id, project_id, forgotten_at').order('id').limit(size)
        return after === null ? q : q.gt('id', after)
      })
      for await (const r of rows) yield { id: r.id, project_id: r.project_id, forgotten: r.forgotten_at !== null } satisfies OldRow
    },

    proceduralRows: () => count('count memory_procedural', client.from('memory_procedural').select('id', { count: 'exact', head: true })),

    async maskedItemIds() {
      const ids = new Set<string>()
      const rows = paged<{ id: number; target_id: string }>('read secret hits', PAGE_ROWS, (after, size) => {
        const q = client
          .from('memory_secret_hits')
          .select('id, target_id')
          .eq('target_table', 'memory_items')
          .eq('field', 'content')
          .order('id')
          .limit(size)
        return after === null ? q : q.gt('id', after)
      })
      for await (const r of rows) ids.add(r.target_id)
      return ids
    },

    async factSupersessions() {
      const out: Record<string, number> = {}
      for (const state of SUPERSESSION_STATES) {
        out[state] = await count(
          `count fact supersessions ${state}`,
          client.rpc('engram_legacy_work', { p_step: 'fact_supersession' }, { count: 'exact', head: true }).eq('state', state),
        )
      }
      return out
    },

    async *mkUtterances() {
      const rows = paged<{ id: string; content: string }>('read MK utterances', TEXT_PAGE_ROWS, (after, size) => {
        const q = client
          .from('memory_items')
          .select('id, content')
          .eq('class', 'utterance')
          .eq('speaker', 'mk')
          .is('forgotten_at', null)
          .order('id')
          .limit(size)
        return after === null ? q : q.gt('id', after)
      })
      for await (const r of rows) yield { id: r.id, content: String(r.content ?? '') }
    },

    async invariantCounts() {
      const { data, error } = await client.rpc('engram_invariant_counts')
      if (error || !Array.isArray(data)) failed('engram_invariant_counts', error)
      return (data as Array<{ name: string; violations: number | string }>).map((r) => ({ name: r.name, violations: Number(r.violations) }))
    },

    async embeddedByClass() {
      const out: Record<string, number> = {}
      for (const cls of ITEM_CLASSES) {
        out[cls] = await count(
          `count embedded ${cls}`,
          client.from('memory_items').select('id', { count: 'exact', head: true }).eq('class', cls).not('embedding', 'is', null),
        )
      }
      return out
    },

    async *extractionRuns() {
      const rows = paged<RunRow & { id: string }>('read extraction runs', PAGE_ROWS, (after, size) => {
        const q = client.from('memory_extraction_runs').select('id, extractor_version, status, stats').order('id').limit(size)
        return after === null ? q : q.gt('id', after)
      })
      for await (const r of rows) yield { extractor_version: r.extractor_version, status: r.status, stats: r.stats }
    },

    unprocessedEvents: () =>
      count('count unprocessed events', client.from('memory_capture_events').select('id', { count: 'exact', head: true }).is('processed_at', null)),

    async *captureErrors() {
      const rows = paged<CaptureErrorRow & { id: number }>('read capture errors', PAGE_ROWS, (after, size) => {
        const q = client.from('memory_capture_events').select('id, type, error').not('error', 'is', null).order('id').limit(size)
        return after === null ? q : q.gt('id', after)
      })
      for await (const r of rows) yield { type: r.type, error: r.error }
    },

    async sampleIds(p) {
      const ids: string[] = []
      for await (const r of paged<{ id: string }>(`read ${p}`, PAGE_ROWS, (after, size) => {
        const q = population(p).order('id').limit(size)
        return after === null ? q : q.gt('id', after)
      })) {
        ids.push(r.id)
      }
      return ids
    },

    async itemsByIds(ids) {
      const out: SampleRow[] = []
      const unique = [...new Set(ids)]
      for (let i = 0; i < unique.length; i += IDS_PER_READ) {
        const { data, error } = await client
          .from('memory_items')
          .select('id, content, context, quote:source->>quote, occurred_at, project_id, lineage')
          .in('id', unique.slice(i, i + IDS_PER_READ))
        if (error || !data) failed('read sampled items', error)
        for (const r of data as Array<Record<string, unknown>>) {
          out.push({
            id: String(r.id),
            content: String(r.content ?? ''),
            context: text(r.context),
            quote: text(r.quote),
            occurred_at: String(r.occurred_at),
            project_id: text(r.project_id),
            lineage: Array.isArray(r.lineage) ? r.lineage.map(String) : [],
          })
        }
      }
      return out
    },
  }
}
