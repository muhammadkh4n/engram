/**
 * Tests for the episode re-embed selection, text rebuild and apply loop.
 * The PostgREST client is an in-memory stub that evaluates the filters the
 * store builds, and the embedder is a stub: no network, no model.
 */
import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { buildTextToEmbed, EMBED_TEXT_VERSION } from '@engram-mem/core'
import {
  classifyEpisode,
  buildReembedText,
  buildReembedPatch,
  neighboursInWindow,
  createPostgrestReembedStore,
  runEpisodeReembed,
  ReembedBatchError,
  type EpisodeCandidate,
  type NeighbourEpisode,
  type ReembedEmbedder,
  type ReembedOptions,
} from '../src/ingest/episode-reembed-lib.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-03-27T10:00:00.000Z')
const MIN = 60 * 1000

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString()
}

/** Synthetic message text shaped like a hook-captured turn. */
function message(length: number, head = 'Deploying the ingest worker to the staging cluster. '): string {
  const filler = 'The retry loop logs each attempt and backs off exponentially. '
  let text = head
  while (text.length < length) text += filler
  return text.slice(0, length)
}

function candidate(overrides: Partial<EpisodeCandidate> = {}): EpisodeCandidate {
  return {
    id: 'ep-1',
    session_id: 'sess-1',
    content: message(1200),
    metadata: { role: 'user' },
    created_at: at(0),
    hasEmbedding: true,
    ...overrides,
  }
}

function neighbour(id: string, offsetMs: number, content = `neighbour turn ${id} about the staging deploy`): NeighbourEpisode {
  return { id, content, created_at: at(offsetMs) }
}

// ---------------------------------------------------------------------------
// Stub PostgREST client: records every call and evaluates the filters the
// store uses against in-memory rows.
// ---------------------------------------------------------------------------

interface StoredRow {
  id: string
  session_id: string | null
  content: string
  metadata: Record<string, unknown> | null
  created_at: string
  embedding: number[] | null
  forgotten_at: string | null
}

type Predicate = (row: StoredRow) => boolean

interface Recorded {
  selects: string[]
  updates: Array<{ id: string; body: Record<string, unknown> }>
}

function parseKeyset(filter: string): Predicate {
  const m = /^created_at\.gt\.(.+),and\(created_at\.eq\.(.+),id\.gt\.(.+)\)$/.exec(filter)
  if (!m) throw new Error(`stub cannot parse or() filter: ${filter}`)
  const t = Date.parse(m[1]!)
  const id = m[3]!
  return (r) => Date.parse(r.created_at) > t || (Date.parse(r.created_at) === t && r.id > id)
}

function stubClient(rows: StoredRow[]): { client: PostgrestClient; recorded: Recorded } {
  const recorded: Recorded = { selects: [], updates: [] }

  function query(): Record<string, unknown> {
    const preds: Predicate[] = []
    const orders: string[] = []
    let columns = '*'
    let max = Infinity
    let updateBody: Record<string, unknown> | null = null
    const builder: Record<string, unknown> = {
      select(cols: string) {
        columns = cols
        recorded.selects.push(cols)
        return builder
      },
      update(body: Record<string, unknown>) {
        updateBody = body
        return builder
      },
      is(col: keyof StoredRow, value: null) {
        preds.push((r) => r[col] === value)
        return builder
      },
      not(col: keyof StoredRow, op: string, value: null) {
        if (op !== 'is') throw new Error(`stub: unsupported not(${op})`)
        preds.push((r) => r[col] !== value)
        return builder
      },
      eq(col: keyof StoredRow, value: unknown) {
        preds.push((r) => r[col] === value)
        return builder
      },
      gte(col: 'created_at', value: string) {
        preds.push((r) => Date.parse(r[col]) >= Date.parse(value))
        return builder
      },
      lt(col: 'created_at', value: string) {
        preds.push((r) => Date.parse(r[col]) < Date.parse(value))
        return builder
      },
      or(filter: string) {
        preds.push(parseKeyset(filter))
        return builder
      },
      order(col: string) {
        orders.push(col)
        return builder
      },
      limit(n: number) {
        max = n
        return builder
      },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        try {
          const matched = rows.filter((r) => preds.every((p) => p(r)))
          if (updateBody) {
            for (const r of matched) {
              Object.assign(r, updateBody)
              recorded.updates.push({ id: r.id, body: updateBody })
            }
            return Promise.resolve({ data: null, error: null }).then(resolve, reject)
          }
          const sorted = [...matched].sort(
            (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id),
          )
          const cols = columns.split(',').map((c) => c.trim())
          const data = sorted.slice(0, max).map((r) =>
            Object.fromEntries(cols.map((c) => [c, r[c as keyof StoredRow]])),
          )
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        } catch (err) {
          return Promise.reject(err).then(resolve, reject)
        }
      },
    }
    return builder
  }

  const client = { from: () => query() } as unknown as PostgrestClient
  return { client, recorded }
}

function stored(overrides: Partial<StoredRow> & { id: string }): StoredRow {
  return {
    session_id: 'sess-1',
    content: 'short turn',
    metadata: { role: 'user' },
    created_at: at(0),
    embedding: [0.5],
    forgotten_at: null,
    ...overrides,
  }
}

interface StubEmbedder extends ReembedEmbedder {
  batchCalls: string[][]
  oneCalls: string[]
}

function stubEmbedder(failOn: (text: string) => boolean = () => false): StubEmbedder {
  const e: StubEmbedder = {
    batchCalls: [],
    oneCalls: [],
    async embedBatch(texts) {
      e.batchCalls.push(texts)
      if (texts.some(failOn)) throw new Error('batch rejected')
      return texts.map((t) => [t.length])
    },
    async embed(text) {
      e.oneCalls.push(text)
      if (failOn(text)) throw new Error('row rejected')
      return [text.length]
    },
  }
  return e
}

const DEFAULTS: ReembedOptions = {
  apply: false,
  reasons: ['preamble-cut', 'head-cut', 'missing'],
  limit: null,
  batchSize: 64,
  pageSize: 200,
}

/** Six rows: one per reason, one embedded whole, one marked, one forgotten. */
function mixedTable(): StoredRow[] {
  return [
    stored({ id: 'a-prev', created_at: at(-5 * MIN), content: 'earlier turn about the deploy' }),
    stored({
      id: 'b-preamble',
      created_at: at(1 * MIN),
      content: message(1480),
      metadata: { role: 'assistant', contextualPreamble: 'Discussing the staging deploy of the ingest worker.', project: 'engram' },
    }),
    stored({ id: 'c-head', created_at: at(2 * MIN), content: message(1500) }),
    stored({ id: 'd-whole', session_id: 'sess-2', created_at: at(3 * MIN), content: message(1500) }),
    stored({ id: 'e-missing', created_at: at(4 * MIN), content: 'turn that never got a vector', embedding: null }),
    stored({
      id: 'f-marked',
      created_at: at(6 * MIN),
      content: message(3000),
      metadata: { role: 'user', embedTextVersion: EMBED_TEXT_VERSION },
    }),
    stored({ id: 'g-forgotten', created_at: at(7 * MIN), content: 'forgotten', embedding: null, forgotten_at: at(8 * MIN) }),
  ]
}

// ---------------------------------------------------------------------------
// Selection boundaries
// ---------------------------------------------------------------------------

describe('classifyEpisode', () => {
  const preamble = 'p'.repeat(98)

  it('does not select a preamble row whose old embed text was exactly 1,500 chars', () => {
    const row = candidate({ content: message(1500 - 98 - 2), metadata: { contextualPreamble: preamble } })
    expect(classifyEpisode(row, [])).toBeNull()
  })

  it('selects a preamble row whose old embed text was 1,501 chars', () => {
    const row = candidate({ content: message(1501 - 98 - 2), metadata: { contextualPreamble: preamble } })
    expect(classifyEpisode(row, [])).toBe('preamble-cut')
  })

  it('measures the preamble trimmed', () => {
    const row = candidate({ content: message(1400), metadata: { contextualPreamble: `  ${preamble}\n` } })
    expect(classifyEpisode(row, [])).toBeNull()
  })

  it('does not select a 1,000-char message even with a neighbour', () => {
    const row = candidate({ content: message(1000) })
    expect(classifyEpisode(row, [neighbour('n1', -1 * MIN)])).toBeNull()
  })

  it('selects a 1,001-char message with a neighbour in the window', () => {
    const row = candidate({ content: message(1001) })
    expect(classifyEpisode(row, [neighbour('n1', -1 * MIN)])).toBe('head-cut')
  })

  it('does not select a 1,001-char message without a neighbour', () => {
    const row = candidate({ content: message(1001) })
    expect(classifyEpisode(row, [])).toBeNull()
  })

  it('does not count a neighbour 31 minutes older', () => {
    const row = candidate({ content: message(1001) })
    expect(classifyEpisode(row, [neighbour('n1', -31 * MIN)])).toBeNull()
  })

  it('counts a neighbour exactly 30 minutes older and none at or after the row', () => {
    const row = candidate({ content: message(1001) })
    expect(classifyEpisode(row, [neighbour('n1', -30 * MIN)])).toBe('head-cut')
    expect(classifyEpisode(row, [neighbour('n2', 0), neighbour('n3', 1 * MIN)])).toBeNull()
  })

  it('selects a row without a vector as missing, unless its content is blank', () => {
    expect(classifyEpisode(candidate({ hasEmbedding: false, content: 'hi' }), [])).toBe('missing')
    expect(classifyEpisode(candidate({ hasEmbedding: false, content: '   ' }), [])).toBeNull()
  })

  it('skips a row that already carries the marker', () => {
    const marked = { embedTextVersion: EMBED_TEXT_VERSION, contextualPreamble: preamble }
    expect(classifyEpisode(candidate({ content: message(3000), metadata: marked }), [])).toBeNull()
    expect(classifyEpisode(candidate({ hasEmbedding: false, metadata: marked }), [])).toBeNull()
  })
})

describe('neighboursInWindow', () => {
  it('keeps same-window episodes oldest first and drops the row itself', () => {
    const row = candidate()
    const got = neighboursInWindow(row, [
      neighbour('late', -1 * MIN),
      neighbour('ep-1', -2 * MIN),
      neighbour('early', -20 * MIN),
      neighbour('stale', -45 * MIN),
    ])
    expect(got.map((n) => n.id)).toEqual(['early', 'late'])
  })
})

// ---------------------------------------------------------------------------
// Text rebuild and patch body
// ---------------------------------------------------------------------------

describe('buildReembedText', () => {
  it('equals the core helper output for the stored preamble', () => {
    const p = ' Discussing the staging deploy of the ingest worker. '
    const row = candidate({ content: message(5000), metadata: { contextualPreamble: p } })
    expect(buildReembedText(row, [])).toBe(buildTextToEmbed({ cleanText: row.content, preamble: p }))
  })

  it('equals the core helper output for the two latest neighbours, ascending', () => {
    const row = candidate({ content: message(3000) })
    const ns = [neighbour('n3', -1 * MIN), neighbour('n1', -10 * MIN), neighbour('n2', -5 * MIN)]
    const expected = buildTextToEmbed({
      cleanText: row.content,
      contextTurns: [ns[2]!.content, ns[0]!.content],
    })
    expect(buildReembedText(row, ns)).toBe(expected)
    expect(buildReembedText(row, ns).includes(row.content.slice(0, 200))).toBe(true)
  })

  it('equals the core helper output for the content alone', () => {
    const row = candidate({ hasEmbedding: false, content: 'turn that never got a vector' })
    expect(buildReembedText(row, [])).toBe(buildTextToEmbed({ cleanText: row.content }))
  })
})

describe('buildReembedPatch', () => {
  it('keeps every stored metadata key and adds the marker', () => {
    const metadata = { role: 'user', project: 'engram', contextualPreamble: 'p', parts: [{ type: 'text' }] }
    const patch = buildReembedPatch({ metadata }, [0.1, 0.2])
    expect(patch).toEqual({ embedding: [0.1, 0.2], metadata: { ...metadata, embedTextVersion: EMBED_TEXT_VERSION } })
    expect(metadata).not.toHaveProperty('embedTextVersion')
  })
})

// ---------------------------------------------------------------------------
// Run loop against the stub client
// ---------------------------------------------------------------------------

describe('runEpisodeReembed', () => {
  it('dry run counts each reason and makes no PATCH and no embed call', async () => {
    const { client, recorded } = stubClient(mixedTable())
    const embedder = stubEmbedder()
    const summary = await runEpisodeReembed(createPostgrestReembedStore(client), embedder, DEFAULTS)

    expect(summary.counts).toEqual({ 'preamble-cut': 1, 'head-cut': 1, missing: 1 })
    expect(summary.samples).toEqual({ 'preamble-cut': ['b-preamble'], 'head-cut': ['c-head'], missing: ['e-missing'] })
    expect(summary.alreadyReembedded).toBe(1)
    expect(summary.written).toBe(0)
    expect(summary.totalChars).toBeGreaterThan(0)
    expect(recorded.updates).toEqual([])
    expect(embedder.batchCalls).toEqual([])
    expect(embedder.oneCalls).toEqual([])
  })

  it('never selects the embedding column', async () => {
    const { client, recorded } = stubClient(mixedTable())
    await runEpisodeReembed(createPostgrestReembedStore(client), null, DEFAULTS)
    expect(recorded.selects.length).toBeGreaterThan(0)
    for (const cols of recorded.selects) expect(cols).not.toMatch(/embedding/)
  })

  it('apply writes the vector and the stored metadata plus the marker, nothing else', async () => {
    const rows = mixedTable()
    const { client, recorded } = stubClient(rows)
    const embedder = stubEmbedder()
    const summary = await runEpisodeReembed(createPostgrestReembedStore(client), embedder, { ...DEFAULTS, apply: true })

    expect(summary.written).toBe(3)
    expect(recorded.updates.map((u) => u.id)).toEqual(['b-preamble', 'c-head', 'e-missing'])
    const preambleUpdate = recorded.updates[0]!
    expect(Object.keys(preambleUpdate.body).sort()).toEqual(['embedding', 'metadata'])
    expect(preambleUpdate.body['metadata']).toEqual({
      role: 'assistant',
      contextualPreamble: 'Discussing the staging deploy of the ingest worker.',
      project: 'engram',
      embedTextVersion: EMBED_TEXT_VERSION,
    })
    expect(rows.find((r) => r.id === 'd-whole')!.metadata).toEqual({ role: 'user' })
    expect(rows.find((r) => r.id === 'g-forgotten')!.embedding).toBeNull()
  })

  it('a re-run after apply selects nothing', async () => {
    const { client } = stubClient(mixedTable())
    const store = createPostgrestReembedStore(client)
    await runEpisodeReembed(store, stubEmbedder(), { ...DEFAULTS, apply: true })
    const again = await runEpisodeReembed(store, null, DEFAULTS)
    expect(again.counts).toEqual({ 'preamble-cut': 0, 'head-cut': 0, missing: 0 })
    expect(again.alreadyReembedded).toBe(4)
  })

  it('--limit 2 applies exactly 2 rows, across pages', async () => {
    const { client, recorded } = stubClient(mixedTable())
    const summary = await runEpisodeReembed(createPostgrestReembedStore(client), stubEmbedder(), {
      ...DEFAULTS,
      apply: true,
      limit: 2,
      pageSize: 1,
      batchSize: 64,
    })
    expect(summary.written).toBe(2)
    expect(recorded.updates.map((u) => u.id)).toEqual(['b-preamble', 'c-head'])
  })

  it('--reason restricts the selection to that reason', async () => {
    const { client, recorded } = stubClient(mixedTable())
    const summary = await runEpisodeReembed(createPostgrestReembedStore(client), stubEmbedder(), {
      ...DEFAULTS,
      apply: true,
      reasons: ['missing'],
    })
    expect(summary.counts).toEqual({ 'preamble-cut': 0, 'head-cut': 0, missing: 1 })
    expect(recorded.updates.map((u) => u.id)).toEqual(['e-missing'])
  })

  it('embeds in batches of the given size', async () => {
    const { client } = stubClient(mixedTable())
    const embedder = stubEmbedder()
    await runEpisodeReembed(createPostgrestReembedStore(client), embedder, { ...DEFAULTS, apply: true, batchSize: 2 })
    expect(embedder.batchCalls.map((b) => b.length)).toEqual([2, 1])
  })

  it('stops on a batch that still fails after the per-row fallback and reports the last written row', async () => {
    const { client, recorded } = stubClient(mixedTable())
    const embedder = stubEmbedder((text) => text.includes('turn that never'))
    const run = runEpisodeReembed(createPostgrestReembedStore(client), embedder, { ...DEFAULTS, apply: true, batchSize: 2 })
    await expect(run).rejects.toBeInstanceOf(ReembedBatchError)
    const err = (await run.catch((e: unknown) => e)) as ReembedBatchError
    expect(err.cursor).toEqual({ pass: 'embedded', createdAt: at(2 * MIN), id: 'c-head' })
    expect(recorded.updates.map((u) => u.id)).toEqual(['b-preamble', 'c-head'])
  })
})
