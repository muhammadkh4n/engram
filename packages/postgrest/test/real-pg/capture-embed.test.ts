/**
 * The embedding RPCs through a real PostgREST in front of real Postgres, with
 * the service-role JWT:
 * - an MK utterance, an artifact and a legacy item with no vector (one whose
 *   masked text could not keep the old vector) are pending; an assistant
 *   utterance and a forgotten item are not, nor a legacy item once it has one;
 * - the pending read returns the head of each search text, never more than
 *   the embed text builder keeps;
 * - engram_items_set_embeddings writes a row once, and a repeat writes 0;
 * - a forgotten item takes no embedding;
 * - a malformed vector is an invalid argument and writes nothing;
 * - each recorded failure raises an item's attempt count and keeps the error
 *   cut to 500 characters; at 5 the item leaves the pending set and is
 *   counted; a forgotten or embedded item is not raised;
 * - engram_items_reset_embedding_failures clears the attempts and the error
 *   of the given ids, or of every item at 5 attempts when given none, and the
 *   items are pending again.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBED_MAX_CHARS, buildTextToEmbed } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type PostgrestEndpoint, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const MODEL = 'sample-embed:1536:v2'
/** One claimant for every read and refusal here, so each read sees the items earlier reads claimed. */
const CLAIMANT = randomUUID()

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
    return (await store.pendingEmbeddings(256, CLAIMANT)).map((p) => p.id)
  }

  it(
    'lists an MK utterance, an artifact and a vectorless legacy item as pending, and no assistant utterance or forgotten item',
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

      const pending = await store.pendingEmbeddings(256, CLAIMANT)
      const ids = pending.map((p) => p.id)
      expect(ids).toEqual(expect.arrayContaining([mk, commit, legacy]))
      expect(ids).not.toContain(assistant)
      expect(ids).not.toContain(forgotten)
      expect(pending.find((p) => p.id === commit)?.searchText).toBe(
        'sample-repo 0123456789ab\nfix: sample service listens on 7070',
      )

      await expect(store.setEmbeddings([{ id: legacy, embedding: vector(0.5), model: MODEL }])).resolves.toBe(1)
      expect((await store.pendingEmbeddings(256)).map((p) => p.id)).not.toContain(legacy)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'returns only the head of a long search text, and the head embeds to the same text as the whole',
    async () => {
      const ascii = `Sample head. ${'x'.repeat(EMBED_MAX_CHARS * 2)}`
      const emoji = '🙂'.repeat(EMBED_MAX_CHARS + 500)
      const [asciiId, emojiId] = (await insertItems([
        item({ content: 'A long sample prompt.', search_text: ascii }),
        item({ content: 'A long sample prompt of emoji.', search_text: emoji }),
      ])) as [string, string]

      const pending = await store.pendingEmbeddings(256, CLAIMANT)
      const asciiHead = pending.find((p) => p.id === asciiId)!.searchText
      const emojiHead = pending.find((p) => p.id === emojiId)!.searchText
      expect(asciiHead).toBe(ascii.slice(0, EMBED_MAX_CHARS))
      // PostgreSQL counts characters, so an all-astral head is twice as long in UTF-16 units.
      expect(emojiHead).toBe('🙂'.repeat(EMBED_MAX_CHARS))
      expect(buildTextToEmbed({ cleanText: asciiHead })).toBe(buildTextToEmbed({ cleanText: ascii }))
      expect(buildTextToEmbed({ cleanText: emojiHead })).toBe(buildTextToEmbed({ cleanText: emoji }))
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
      await expect(store.pendingEmbeddings(0, CLAIMANT)).rejects.toThrow('limit must be an integer from 1 to 256')
      expect(await pendingIds()).toContain(id)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'raises the attempt count per failure, keeps the error cut to 500 characters, and drops the item at 5',
    async () => {
      const [id, other] = (await insertItems([
        item({ content: 'A sample prompt the model refuses.' }),
        item({ content: 'A sample prompt the model takes.' }),
      ])) as [string, string]
      const before = await store.embeddingFailedCount()
      const longError = `400 Invalid 'input': ${'x'.repeat(600)}`

      for (let attempt = 1; attempt <= 4; attempt++) {
        await expect(store.recordEmbeddingFailures([{ id, error: longError }], CLAIMANT)).resolves.toBe(1)
        expect(await pendingIds()).toContain(id)
      }
      await expect(store.embeddingFailedCount()).resolves.toBe(before)
      await expect(store.recordEmbeddingFailures([{ id, error: '400 Invalid input: the fifth refusal' }], CLAIMANT)).resolves.toBe(1)
      const ids = await pendingIds()
      expect(ids).not.toContain(id)
      expect(ids).toContain(other)
      await expect(store.embeddingFailedCount()).resolves.toBe(before + 1)
      await expect(store.recordEmbeddingFailures([{ id, error: 'a sixth refusal' }], CLAIMANT)).resolves.toBe(0)

      expect(
        await pg.psql(`SELECT embedding_attempts || ' ' || embedding_error FROM public.memory_items WHERE id = '${id}';`),
      ).toBe('5 400 Invalid input: the fifth refusal')
      const [cut] = (await insertItems([item({ content: 'A sample prompt with a long refusal.' })])) as [string]
      await store.recordEmbeddingFailures([{ id: cut, error: longError }], CLAIMANT)
      expect(
        await pg.psql(`SELECT char_length(embedding_error) FROM public.memory_items WHERE id = '${cut}';`),
      ).toBe('500')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'raises no forgotten or embedded item, and refuses a malformed failure or a repeated id',
    async () => {
      const [gone, done] = (await insertItems([
        item({ content: 'A refused sample prompt to forget.' }),
        item({ content: 'A refused sample prompt already embedded.' }),
      ])) as [string, string]
      await forget(gone)
      await store.setEmbeddings([{ id: done, embedding: vector(0.3), model: MODEL }])
      await expect(
        store.recordEmbeddingFailures([
          { id: gone, error: '400 refused' },
          { id: done, error: '400 refused' },
        ], CLAIMANT),
      ).resolves.toBe(0)
      expect(
        await pg.psql(`SELECT sum(embedding_attempts) FROM public.memory_items WHERE id IN ('${gone}', '${done}');`),
      ).toBe('0')

      await expect(store.recordEmbeddingFailures([{ id: 'not-a-uuid', error: '400 refused' }], CLAIMANT)).rejects.toThrow(
        'recordEmbeddingFailures failed (22023): engram_items_record_embedding_failures: object 1: id must be a uuid string',
      )
      await expect(store.recordEmbeddingFailures([{ id: done, error: ' \n' }], CLAIMANT)).rejects.toThrow(
        'engram_items_record_embedding_failures: object 1: error must be a string that is not blank in its first 500 characters',
      )
      await expect(
        store.recordEmbeddingFailures([
          { id: done, error: '400 refused' },
          { id: done, error: '400 refused' },
        ], CLAIMANT),
      ).rejects.toThrow('engram_items_record_embedding_failures: objects 1 and 2 share an id')
    },
    TEST_TIMEOUT_MS,
  )
  it(
    'returns failed items to the pending set: the given ids, or every item at 5 attempts when given none',
    async () => {
      const [one, two, tried] = (await insertItems([
        item({ content: 'A sample prompt refused five times, reset by id.' }),
        item({ content: 'A sample prompt refused five times, reset with the rest.' }),
        item({ content: 'A sample prompt refused once.' }),
      ])) as [string, string, string]
      for (let attempt = 1; attempt <= 5; attempt++) {
        await store.recordEmbeddingFailures([
          { id: one, error: '400 refused' },
          { id: two, error: '400 refused' },
        ], CLAIMANT)
      }
      await store.recordEmbeddingFailures([{ id: tried, error: '400 refused once' }], CLAIMANT)
      expect(await pendingIds()).not.toContain(one)
      const failed = await store.embeddingFailedCount()

      await expect(store.resetEmbeddingFailures([one])).resolves.toBe(1)
      expect(await pendingIds()).toContain(one)
      expect(await pendingIds()).not.toContain(two)
      expect(
        await pg.psql(`SELECT embedding_attempts || ' ' || coalesce(embedding_error, 'none') FROM public.memory_items WHERE id = '${one}';`),
      ).toBe('0 none')
      await expect(store.embeddingFailedCount()).resolves.toBe(failed - 1)

      await expect(store.resetEmbeddingFailures()).resolves.toBe(failed - 1)
      expect(await pendingIds()).toEqual(expect.arrayContaining([one, two, tried]))
      await expect(store.embeddingFailedCount()).resolves.toBe(0)
      expect(
        await pg.psql(`SELECT embedding_attempts || ' ' || embedding_error FROM public.memory_items WHERE id = '${tried}';`),
      ).toBe('1 400 refused once')
      await expect(store.resetEmbeddingFailures()).resolves.toBe(0)

      await expect(store.resetEmbeddingFailures([tried])).resolves.toBe(1)
      expect(
        await pg.psql(`SELECT embedding_attempts || ' ' || coalesce(embedding_error, 'none') FROM public.memory_items WHERE id = '${tried}';`),
      ).toBe('0 none')
      await expect(store.resetEmbeddingFailures([tried])).resolves.toBe(0)
      await expect(store.resetEmbeddingFailures(['not-a-uuid'])).rejects.toThrow(
        'resetEmbeddingFailures failed (22P02)',
      )
      await expect(
        pg.psqlAs('service_role', `SELECT public.engram_items_reset_embedding_failures('{}'::uuid[]);`),
      ).rejects.toThrow('p_ids holds 0 ids, not 1 to 256; pass NULL to reset every failed item')
    },
    TEST_TIMEOUT_MS,
  )
})
