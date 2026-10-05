/**
 * The embedding RPCs through a real PostgREST in front of real Postgres, with
 * the service-role JWT:
 * - an MK utterance and an artifact are pending; an assistant utterance, a
 *   forgotten item and a legacy item are not;
 * - engram_items_set_embeddings writes a row once, and a repeat writes 0;
 * - a forgotten item takes no embedding;
 * - a malformed vector is an invalid argument and writes nothing.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type PostgrestEndpoint, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const MODEL = 'sample-embed:1536:v2'

function jsonb(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`
}

function vector(fill: number, length = 1536): number[] {
  return Array.from({ length }, () => fill)
}

function item(overrides: Record<string, unknown>): Record<string, unknown> {
  const content = (overrides.content as string | undefined) ?? 'Keep the sample service on port 7070.'
  return {
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    trust: 0,
    content,
    search_text: content,
    occurred_at: '2026-01-05T09:00:00Z',
    source: { type: 'transcript', event_key: `capture-embed:${randomUUID()}` },
    ...overrides,
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('the embedding RPCs through PostgREST on real Postgres', () => {
  let pg: RealPg
  let endpoint: PostgrestEndpoint
  let store: PostgRestCaptureStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  async function insertItems(objects: unknown[]): Promise<string[]> {
    const out = await pg.psqlAs(
      'service_role',
      `SELECT coalesce(json_agg(r.id ORDER BY r.ord), '[]'::json) FROM public.engram_insert_items(${jsonb(objects)}) AS r;`,
    )
    return JSON.parse(out) as string[]
  }

  async function forget(id: string): Promise<void> {
    await pg.psqlAs('service_role', `SELECT count(*) FROM public.engram_forget_items(ARRAY['${id}']::uuid[], 'tst: forgotten fixture');`)
  }

  async function pendingIds(): Promise<string[]> {
    return (await store.pendingEmbeddings(256)).map((p) => p.id)
  }

  it(
    'lists an MK utterance and an artifact as pending, and no assistant utterance, forgotten item or legacy item',
    async () => {
      const [mk, commit, assistant, forgotten, legacy] = (await insertItems([
        item({ content: 'Keep the sample service on port 7070.' }),
        item({
          class: 'artifact',
          kind: 'commit',
          speaker: 'artifact',
          trust: 1,
          content: 'fix: sample service listens on 7070',
          search_text: 'sample-repo 0123456789ab\nfix: sample service listens on 7070',
          source: { type: 'git', event_key: `git:sample-repo:${randomUUID()}` },
        }),
        item({ kind: 'assistant_turn', speaker: 'assistant', trust: 3, content: 'I moved the service to 7070.' }),
        item({ content: 'Forget this sample prompt.' }),
        item({
          class: 'legacy',
          kind: 'legacy_episode',
          trust: 3,
          content: 'An old store row about the sample service.',
          source: { type: 'legacy', event_key: `legacy:${randomUUID()}` },
        }),
      ])) as [string, string, string, string, string]
      await forget(forgotten)

      const pending = await store.pendingEmbeddings(256)
      const ids = pending.map((p) => p.id)
      expect(ids).toEqual(expect.arrayContaining([mk, commit]))
      expect(ids).not.toContain(assistant)
      expect(ids).not.toContain(forgotten)
      expect(ids).not.toContain(legacy)
      expect(pending.find((p) => p.id === commit)?.searchText).toBe(
        'sample-repo 0123456789ab\nfix: sample service listens on 7070',
      )
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'writes an embedding once, and a repeat writes 0 and leaves the first vector',
    async () => {
      const [id] = (await insertItems([item({ content: 'Embed this sample prompt once.' })])) as [string]
      expect(await pendingIds()).toContain(id)

      await expect(store.setEmbeddings([{ id, embedding: vector(0.5), model: MODEL }])).resolves.toBe(1)
      expect(await pendingIds()).not.toContain(id)
      await expect(store.setEmbeddings([{ id, embedding: vector(0.25), model: 'other-model:1536:v2' }])).resolves.toBe(0)

      const stored = await pg.psql(
        `SELECT embedding_model || ' ' || (embedding::real[])[1]::text FROM public.memory_items WHERE id = '${id}';`,
      )
      expect(stored).toBe(`${MODEL} 0.5`)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'gives a forgotten item no embedding',
    async () => {
      const [live, gone] = (await insertItems([
        item({ content: 'A live sample prompt.' }),
        item({ content: 'A sample prompt to forget.' }),
      ])) as [string, string]
      await forget(gone)
      await expect(
        store.setEmbeddings([
          { id: live, embedding: vector(0.1), model: MODEL },
          { id: gone, embedding: vector(0.1), model: MODEL },
        ]),
      ).resolves.toBe(1)
      expect(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE id = '${gone}' AND embedding IS NULL;`)).toBe('1')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'refuses a vector of the wrong length or a repeated id as an invalid argument, writing nothing',
    async () => {
      const [id] = (await insertItems([item({ content: 'A sample prompt with a bad vector.' })])) as [string]
      await expect(store.setEmbeddings([{ id, embedding: vector(0.1, 1535), model: MODEL }])).rejects.toThrow(
        'setEmbeddings failed (22023): engram_items_set_embeddings: object 1: embedding must hold 1536 numbers in the real range',
      )
      await expect(
        store.setEmbeddings([
          { id, embedding: vector(0.1), model: MODEL },
          { id, embedding: vector(0.2), model: MODEL },
        ]),
      ).rejects.toThrow('setEmbeddings failed (22023): engram_items_set_embeddings: objects 1 and 2 share an id')
      await expect(store.pendingEmbeddings(0)).rejects.toThrow('limit must be an integer from 1 to 256')
      expect(await pendingIds()).toContain(id)
    },
    TEST_TIMEOUT_MS,
  )
})
