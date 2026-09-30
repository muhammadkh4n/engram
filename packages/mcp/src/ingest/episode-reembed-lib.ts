/**
 * Selection, text rebuild and apply loop for the episode re-embed CLI
 * (engram-episode-reembed-cli.ts).
 *
 * Episode vectors written before the head-preserving embed-text rules were
 * built from a tail-kept text:
 *   - with a contextual preamble: `${preamble}\n\n${content}` cut to its last
 *     1,500 chars, so a long message lost the preamble and its own head;
 *   - with neighbour turns: `${context}\n${content}` cut to its last 1,000
 *     chars, so a long message lost its head (which names its topic).
 * A row is selected only when that old rule actually cut its text, or when it
 * has no vector at all. A row embedded whole already has a vector that covers
 * the message, and re-embedding it would only spend tokens.
 *
 * Rows re-embedded here carry `metadata.embedTextVersion`, so a re-run skips
 * them and resumes where an interrupted run stopped.
 *
 * Network access goes through the injected ReembedStore and ReembedEmbedder,
 * so the loop is testable with a stub PostgREST client and a stub embedder.
 */
import type { PostgrestClient } from '@supabase/postgrest-js'
import { buildTextToEmbed, EMBED_TEXT_VERSION } from '@engram-mem/core'
import {
  buildKeysetFilter,
  embedBatchWithFallback,
  type PageCursor,
} from './embed-backfill-lib.js'

export type ReembedReason = 'preamble-cut' | 'head-cut' | 'missing'

export const ALL_REEMBED_REASONS: readonly ReembedReason[] = ['preamble-cut', 'head-cut', 'missing']

/** Tail length the old rule kept when a contextual preamble was present. */
export const LEGACY_PREAMBLE_MAX_CHARS = 1500
/** Tail length the old rule kept when neighbour turns were prefixed. */
export const LEGACY_CONTEXT_MAX_CHARS = 1000
/** How far back Memory.ingest looks for same-session neighbour turns. */
export const NEIGHBOUR_WINDOW_MS = 30 * 60 * 1000
/** Neighbour turns Memory.ingest prefixes to a message. */
export const NEIGHBOUR_TURNS = 2
/** Samples printed per reason. */
export const SAMPLE_IDS_PER_REASON = 5

const EPISODES_TABLE = 'memory_episodes'
/** The embedding column is never read: the pass filter says whether it is set. */
const EPISODE_COLUMNS = 'id, session_id, content, metadata, created_at'
const NEIGHBOUR_COLUMNS = 'id, content, created_at'

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface EpisodeCandidate {
  readonly id: string
  readonly session_id: string | null
  readonly content: string
  readonly metadata: Record<string, unknown> | null
  readonly created_at: string
  /** True when the row was read from the pass whose rows have a vector. */
  readonly hasEmbedding: boolean
}

export interface NeighbourEpisode {
  readonly id: string
  readonly content: string
  readonly created_at: string
}

// ---------------------------------------------------------------------------
// Pure selection
// ---------------------------------------------------------------------------

export function isReembedded(metadata: Record<string, unknown> | null): boolean {
  const version = metadata?.['embedTextVersion']
  return typeof version === 'number' && version >= EMBED_TEXT_VERSION
}

/** The stored preamble, or '' when there is none. */
export function storedPreamble(metadata: Record<string, unknown> | null): string {
  const preamble = metadata?.['contextualPreamble']
  return typeof preamble === 'string' ? preamble : ''
}

/** Bounds of the neighbour window `[created_at − 30 min, created_at)`. */
export function neighbourWindow(createdAt: string): { from: string; before: string } {
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) throw new Error(`unparseable created_at: ${createdAt}`)
  return { from: new Date(t - NEIGHBOUR_WINDOW_MS).toISOString(), before: createdAt }
}

/**
 * Same-session episodes inside the window Memory.ingest used, oldest first.
 * Forgotten episodes count: the ingest-time lookup did not filter them.
 */
export function neighboursInWindow(
  row: Pick<EpisodeCandidate, 'id' | 'created_at'>,
  episodes: readonly NeighbourEpisode[],
): NeighbourEpisode[] {
  const t = Date.parse(row.created_at)
  const from = t - NEIGHBOUR_WINDOW_MS
  return episodes
    .filter((e) => {
      if (e.id === row.id) return false
      const at = Date.parse(e.created_at)
      return at >= from && at < t
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
}

/**
 * Whether classification of this row depends on its neighbours. Only a
 * vector-less row or a long, preamble-less row can use neighbour turns.
 */
export function needsNeighbours(row: EpisodeCandidate): boolean {
  if (isReembedded(row.metadata) || storedPreamble(row.metadata)) return false
  return !row.hasEmbedding || row.content.length > LEGACY_CONTEXT_MAX_CHARS
}

/**
 * The one reason a row is selected for, or null when its stored vector
 * already reflects the whole message.
 */
export function classifyEpisode(
  row: EpisodeCandidate,
  neighbours: readonly NeighbourEpisode[],
): ReembedReason | null {
  if (isReembedded(row.metadata)) return null
  if (!row.hasEmbedding) return row.content.trim().length > 0 ? 'missing' : null

  const preamble = storedPreamble(row.metadata)
  if (preamble) {
    const oldLength = preamble.trim().length + 2 + row.content.length
    return oldLength > LEGACY_PREAMBLE_MAX_CHARS ? 'preamble-cut' : null
  }

  if (row.content.length <= LEGACY_CONTEXT_MAX_CHARS) return null
  return neighboursInWindow(row, neighbours).length > 0 ? 'head-cut' : null
}

/**
 * Rebuilds the embed text with the same helper and inputs Memory.ingest uses
 * today: the stored preamble, else the latest neighbour turns, else the
 * content alone.
 */
export function buildReembedText(row: EpisodeCandidate, neighbours: readonly NeighbourEpisode[]): string {
  const turns = neighboursInWindow(row, neighbours).slice(-NEIGHBOUR_TURNS)
  return buildTextToEmbed({
    cleanText: row.content,
    preamble: storedPreamble(row.metadata),
    contextTurns: turns.map((t) => t.content),
  })
}

/** The PATCH body: a new vector and the stored metadata plus the marker. */
export function buildReembedPatch(
  row: Pick<EpisodeCandidate, 'metadata'>,
  embedding: number[],
): { embedding: number[]; metadata: Record<string, unknown> } {
  return { embedding, metadata: { ...(row.metadata ?? {}), embedTextVersion: EMBED_TEXT_VERSION } }
}

// ---------------------------------------------------------------------------
// Storage (PostgREST)
// ---------------------------------------------------------------------------

export type EpisodePass = 'embedded' | 'missing'

export interface ReembedStore {
  fetchPage(pass: EpisodePass, cursor: PageCursor | null, pageSize: number): Promise<EpisodeCandidate[]>
  fetchNeighbours(row: EpisodeCandidate): Promise<NeighbourEpisode[]>
  patchEpisode(id: string, patch: { embedding: number[]; metadata: Record<string, unknown> }): Promise<void>
}

type RawEpisodeRow = Omit<EpisodeCandidate, 'hasEmbedding'>

export function createPostgrestReembedStore(client: PostgrestClient): ReembedStore {
  return {
    async fetchPage(pass, cursor, pageSize) {
      const base = client.from(EPISODES_TABLE).select(EPISODE_COLUMNS).is('forgotten_at', null)
      const byVector = pass === 'embedded' ? base.not('embedding', 'is', null) : base.is('embedding', null)
      let q = byVector
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(pageSize)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
      if (error) throw new Error(`fetch ${pass} episodes failed: ${error.message}`)
      return ((data ?? []) as unknown as RawEpisodeRow[]).map((r) => ({
        ...r,
        content: r.content ?? '',
        hasEmbedding: pass === 'embedded',
      }))
    },

    async fetchNeighbours(row) {
      if (!row.session_id) return []
      const { from, before } = neighbourWindow(row.created_at)
      const { data, error } = await client
        .from(EPISODES_TABLE)
        .select(NEIGHBOUR_COLUMNS)
        .eq('session_id', row.session_id)
        .gte('created_at', from)
        .lt('created_at', before)
        .order('created_at', { ascending: true })
      if (error) throw new Error(`fetch neighbours of ${row.id} failed: ${error.message}`)
      return (data ?? []) as unknown as NeighbourEpisode[]
    },

    async patchEpisode(id, patch) {
      const { error } = await client.from(EPISODES_TABLE).update(patch).eq('id', id)
      if (error) throw new Error(`PATCH ${EPISODES_TABLE} id=${id} failed: ${error.message}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

export interface ReembedEmbedder {
  embedBatch(texts: string[]): Promise<number[][]>
  embed(text: string): Promise<number[]>
}

export interface ReembedOptions {
  readonly apply: boolean
  readonly reasons: readonly ReembedReason[]
  /** Cap on selected rows (the rows an apply writes). */
  readonly limit: number | null
  readonly batchSize: number
  readonly pageSize: number
}

export interface ReembedSummary {
  counts: Record<ReembedReason, number>
  samples: Record<ReembedReason, string[]>
  /** Characters of rebuilt text across selected rows. */
  totalChars: number
  /** Rows skipped because they already carry the current marker. */
  alreadyReembedded: number
  /** Rows re-embedded and written (0 in a dry run). */
  written: number
}

export interface ReembedCursor {
  pass: EpisodePass
  createdAt: string
  id: string
}

/** A batch failed after the per-row fallback; `cursor` is the last row written. */
export class ReembedBatchError extends Error {
  constructor(
    message: string,
    readonly cursor: ReembedCursor | null,
    readonly summary: ReembedSummary,
  ) {
    super(message)
    this.name = 'ReembedBatchError'
  }
}

interface Selected {
  row: EpisodeCandidate
  text: string
}

function emptySummary(): ReembedSummary {
  return {
    counts: { 'preamble-cut': 0, 'head-cut': 0, missing: 0 },
    samples: { 'preamble-cut': [], 'head-cut': [], missing: [] },
    totalChars: 0,
    alreadyReembedded: 0,
    written: 0,
  }
}

function passesFor(reasons: readonly ReembedReason[]): EpisodePass[] {
  const passes: EpisodePass[] = []
  if (reasons.includes('preamble-cut') || reasons.includes('head-cut')) passes.push('embedded')
  if (reasons.includes('missing')) passes.push('missing')
  return passes
}

async function selectRow(
  store: ReembedStore,
  row: EpisodeCandidate,
  wanted: ReadonlySet<ReembedReason>,
): Promise<Selected & { reason: ReembedReason } | null> {
  const potential: ReembedReason = row.hasEmbedding ? 'head-cut' : 'missing'
  const neighbours = needsNeighbours(row) && wanted.has(potential) ? await store.fetchNeighbours(row) : []
  const reason = classifyEpisode(row, neighbours)
  if (!reason || !wanted.has(reason)) return null
  return { row, reason, text: buildReembedText(row, neighbours) }
}

async function writeBatch(
  store: ReembedStore,
  embedder: ReembedEmbedder,
  batch: readonly Selected[],
): Promise<{ written: number; lastWritten: EpisodeCandidate | null; failures: string[] }> {
  const { succeeded, failed } = await embedBatchWithFallback(
    batch,
    (texts) => embedder.embedBatch(texts),
    (text) => embedder.embed(text),
  )
  const failures = failed.map((f) => `embed id=${f.row.row.id}: ${String(f.error)}`)
  let written = 0
  let lastWritten: EpisodeCandidate | null = null
  for (const { row: selected, embedding } of succeeded) {
    try {
      await store.patchEpisode(selected.row.id, buildReembedPatch(selected.row, embedding))
      written++
      lastWritten = selected.row
    } catch (err) {
      failures.push(String(err instanceof Error ? err.message : err))
    }
  }
  return { written, lastWritten, failures }
}

/**
 * Pages live episodes by keyset (created_at, id) in two passes — rows with a
 * vector, then rows without — selects rows per reason, and in apply mode
 * re-embeds them in batches. A dry run never calls the embedder or PATCHes.
 * Throws ReembedBatchError on the first batch that still has failures after
 * the per-row fallback; rows already written keep their marker, so a re-run
 * resumes.
 */
export async function runEpisodeReembed(
  store: ReembedStore,
  embedder: ReembedEmbedder | null,
  opts: ReembedOptions,
): Promise<ReembedSummary> {
  if (opts.apply && !embedder) throw new Error('apply mode needs an embedder')
  const summary = emptySummary()
  const wanted = new Set(opts.reasons)
  let selectedTotal = 0
  let lastCursor: ReembedCursor | null = null
  const limitReached = (): boolean => opts.limit !== null && selectedTotal >= opts.limit

  for (const pass of passesFor(opts.reasons)) {
    let cursor: PageCursor | null = null
    let pending: Selected[] = []

    const flush = async (): Promise<void> => {
      const batch = pending
      pending = []
      if (!opts.apply || batch.length === 0) return
      const result = await writeBatch(store, embedder!, batch)
      summary.written += result.written
      if (result.lastWritten) {
        lastCursor = { pass, createdAt: result.lastWritten.created_at, id: result.lastWritten.id }
      }
      if (result.failures.length > 0) {
        throw new ReembedBatchError(
          `batch of ${batch.length} failed for ${result.failures.length} row(s): ${result.failures.join('; ')}`,
          lastCursor,
          summary,
        )
      }
    }

    while (!limitReached()) {
      const rows = await store.fetchPage(pass, cursor, opts.pageSize)
      if (rows.length === 0) break
      const last = rows[rows.length - 1]!
      cursor = { createdAt: last.created_at, id: last.id }

      for (const row of rows) {
        if (limitReached()) break
        if (isReembedded(row.metadata)) {
          summary.alreadyReembedded++
          continue
        }
        const selected = await selectRow(store, row, wanted)
        if (!selected) continue
        selectedTotal++
        summary.counts[selected.reason]++
        summary.totalChars += selected.text.length
        const samples = summary.samples[selected.reason]
        if (samples.length < SAMPLE_IDS_PER_REASON) samples.push(row.id)
        pending.push({ row: selected.row, text: selected.text })
        if (pending.length >= opts.batchSize) await flush()
      }
      if (rows.length < opts.pageSize) break
    }
    await flush()
  }

  return summary
}
