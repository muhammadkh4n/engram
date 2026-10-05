/**
 * Two capture workers on one database, on real Postgres behind PostgREST:
 * each embedding pass claims the items it reads, so the two never send the
 * same item to the provider, and an item the provider refuses has its attempt
 * count raised once per pass that read it, not once per worker. Both
 * embedders hold every call until both workers have read their batch, so the
 * two passes overlap.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EmbeddingInputError } from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { startCaptureWorker, type CaptureWorker, type CaptureWorkerOptions } from '../../src/capture-events/worker.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../../postgrest/test/real-pg/harness.js'

const SETUP_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 120_000
const DIMENSIONS = 1536
const MODEL = 'sample-embed:1536:v2'
const ITEMS = 64
const REFUSED_TEXT = 'A sample prompt the provider refuses on its own.'

function jsonb(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`
}

function item(content: string): Record<string, unknown> {
  return {
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    trust: 0,
    content,
    search_text: content,
    occurred_at: '2026-01-05T09:00:00Z',
    source: { type: 'transcript', event_key: `concurrent-workers:${randomUUID()}` },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe.skipIf(!realPgImage || !postgrestImage)('two capture workers on one database', () => {
  let pg: RealPg
  let store: PostgRestCaptureStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    const endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  it(
    'never embed the same item side by side, and raise a refused item once per pass',
    async () => {
      const contents = [REFUSED_TEXT, ...Array.from({ length: ITEMS - 1 }, (_, i) => `Concurrent sample prompt ${i}.`)]
      await pg.psqlAs('service_role', `SELECT count(*) FROM public.engram_insert_items(${jsonb(contents.map(item))});`)

      const bothRead = deferred()
      const readers = new Set<string>()
      const sent: Record<string, string[][]> = { a: [], b: [] }
      const logs: string[] = []

      const options = (label: 'a' | 'b'): CaptureWorkerOptions => ({
        store: {
          materialize: (limit) => store.materialize(limit),
          pendingEmbeddings: async (limit, claimant) => {
            const rows = await store.pendingEmbeddings(limit, claimant)
            if (rows.length > 0) {
              readers.add(label)
              if (readers.size === 2) bothRead.resolve()
            }
            return rows
          },
          renewEmbeddingClaims: (ids, claimant) => store.renewEmbeddingClaims(ids, claimant),
          setEmbeddings: (rows) => store.setEmbeddings(rows),
          recordEmbeddingFailures: (rows, claimant) => store.recordEmbeddingFailures(rows, claimant),
          embeddingFailedCount: () => store.embeddingFailedCount(),
        },
        embedder: {
          dimensions: () => DIMENSIONS,
          embedBatch: async (texts) => {
            await bothRead.promise
            sent[label]!.push(texts)
            if (texts.includes(REFUSED_TEXT)) {
              throw new EmbeddingInputError(400, "400 Invalid 'input': the sample refusal")
            }
            return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.25))
          },
        },
        embeddingModel: MODEL,
        intervalMs: 20,
        log: (line) => logs.push(line),
      })

      const workers: CaptureWorker[] = [startCaptureWorker(options('a')), startCaptureWorker(options('b'))]
      await bothRead.promise
      // Each worker has its first pass in flight; stop lets it finish and schedules no other.
      await Promise.all(workers.map((w) => w.stop(30_000)))

      const textsOf = (label: string): Set<string> => new Set(sent[label]!.flat())
      const a = textsOf('a')
      const b = textsOf('b')
      expect([...a].filter((text) => b.has(text))).toEqual([])
      expect(a.size + b.size).toBe(ITEMS)

      const passesWithRefused = [...sent.a!, ...sent.b!].filter(
        (batch) => batch.length > 1 && batch.includes(REFUSED_TEXT),
      ).length
      expect(passesWithRefused).toBe(1)
      expect(
        await pg.psql(
          `SELECT embedding_attempts FROM public.memory_items WHERE content = '${REFUSED_TEXT.replace(/'/g, "''")}';`,
        ),
      ).toBe('1')
      expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE embedding IS NOT NULL;`)).toBe(String(ITEMS - 1))
      expect(logs.filter((line) => /failed:|refused/.test(line))).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
