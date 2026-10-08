/**
 * A capture worker on real Postgres behind PostgREST records a provider
 * refusal whose message a 500-character cut would split inside a surrogate
 * pair: the stored error ends on a whole character, so the attempt count
 * rises and the item can leave the queue.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EmbeddingInputError } from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { startCaptureWorker, type CaptureWorkerOptions } from '../../src/capture-events/worker.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../../postgrest/test/real-pg/harness.js'

const SETUP_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 60_000
const DIMENSIONS = 1536
const MODEL = 'sample-embed:1536:v2'
const REFUSED_TEXT = 'A sample prompt the provider refuses with a long message.'
const PREFIX = "400 Invalid 'input': "
const MESSAGE = `${PREFIX}${'x'.repeat(499 - PREFIX.length)}😀 and the rest of the message`

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
    source: { type: 'transcript', event_key: `refusal-text:${randomUUID()}` },
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('a refusal message cut on real Postgres', () => {
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
    'records the refusal with the error cut before the split pair',
    async () => {
      expect(MESSAGE.charCodeAt(499)).toBe(0xd83d)
      const contents = [REFUSED_TEXT, 'A sample prompt that embeds.']
      await pg.psqlAs('service_role', `SELECT count(*) FROM public.engram_insert_items(${jsonb(contents.map(item))});`)
      const logs: string[] = []
      const options: CaptureWorkerOptions = {
        store,
        embedder: {
          dimensions: () => DIMENSIONS,
          embedBatch: async (texts) => {
            if (texts.includes(REFUSED_TEXT)) throw new EmbeddingInputError(400, MESSAGE)
            return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.25))
          },
        },
        embeddingModel: MODEL,
        intervalMs: 60_000,
        log: (line) => logs.push(line),
      }
      const worker = startCaptureWorker(options)
      const deadline = Date.now() + 30_000
      while (logs.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      await worker.stop(30_000)

      const refused = REFUSED_TEXT.replace(/'/g, "''")
      expect(await pg.psql(`SELECT embedding_attempts FROM public.memory_items WHERE content = '${refused}';`)).toBe('1')
      expect(await pg.psql(`SELECT char_length(embedding_error) FROM public.memory_items WHERE content = '${refused}';`)).toBe(
        '499',
      )
      expect(logs.filter((line) => /failed:/.test(line))).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
