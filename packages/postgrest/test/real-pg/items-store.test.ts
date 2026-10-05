/**
 * PostgRestItemStore through a real PostgREST in front of real Postgres, with
 * the service-role JWT:
 * - an insert gets uuid v7 ids and the database's content hash, and a repeat
 *   is skipped on its event key;
 * - a statement whose quote is not in its utterance is refused as
 *   ItemConstraintError when the deferred lineage trigger fires at commit,
 *   and nothing from the call is stored;
 * - reads hide forgotten items unless asked, and return embeddings as numbers;
 * - forget, retire, unretire, supersede and the invariant counts round-trip;
 * - the table is closed to a request without a token.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateId, isItemConstraintError, type NewItem } from '@engram-mem/core'
import { PostgRestItemStore } from '../../src/items.js'
import { postgrestImage, realPgImage, startRealPg, type PostgrestEndpoint, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const SUBJECT_ID = '01940000-0000-7000-8000-00000000d000'
const T0 = Date.parse('2026-03-04T05:00:00Z')
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-(8|9|a|b)[0-9a-f]{3}-[0-9a-f]{12}$/

/** The capture event every utterance here was materialized from; its occurred_at is at(0). */
let captureEventId = ''

let keyCounter = 0
function eventKey(): string {
  keyCounter += 1
  return `capture:tst-store-session:turn-${keyCounter}`
}

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `01940000-0000-7000-8000-0000000d${String(idCounter).padStart(4, '0')}`
}

function at(minutes: number): Date {
  return new Date(T0 + minutes * 60_000)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function utterance(content: string, overrides: Partial<NewItem> = {}): NewItem {
  return {
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    trust: 0,
    sessionId: 'tst-store-session',
    content,
    searchText: content,
    occurredAt: at(0),
    source: { type: 'transcript', event_key: eventKey(), event_id: captureEventId },
    ...overrides,
  }
}

function statement(content: string, lineage: readonly string[], overrides: Partial<NewItem> = {}): NewItem {
  return {
    class: 'mk_statement',
    kind: 'ruling',
    speaker: 'mk',
    trust: 0,
    subjectId: SUBJECT_ID,
    content,
    searchText: content,
    occurredAt: at(0),
    source: { type: 'extraction', event_key: `mk_statement:${eventKey()}` },
    lineage,
    standing: false,
    ...overrides,
  }
}

function commit(content: string, minutes: number, overrides: Partial<NewItem> = {}): NewItem {
  return {
    id: newId(),
    class: 'artifact',
    kind: 'commit',
    speaker: 'artifact',
    trust: 1,
    content,
    searchText: content,
    occurredAt: at(minutes),
    source: { type: 'git', event_key: `git:${eventKey()}` },
    ...overrides,
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('PostgRestItemStore through PostgREST on real Postgres', () => {
  let pg: RealPg
  let endpoint: PostgrestEndpoint
  let store: PostgRestItemStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    await pg.psql(`INSERT INTO public.memory_subjects (id, label) VALUES ('${SUBJECT_ID}', 'release cadence')`)
    captureEventId = (
      await pg.psql(
        `INSERT INTO public.memory_capture_events (session_id, event_uuid, type, occurred_at, payload)
         VALUES ('tst-store-session', 'tst-event-1', 'user_prompt', '${at(0).toISOString()}', '{}') RETURNING id;`,
      )
    ).trim()
    endpoint = await pg.startPostgrest()
    store = new PostgRestItemStore({ url: endpoint.url, key: endpoint.serviceJwt })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  async function storedCount(ids: readonly string[]): Promise<number> {
    const list = ids.map((id) => `'${id}'`).join(', ')
    return Number(await pg.psql(`SELECT count(*) FROM public.memory_items WHERE id IN (${list});`))
  }

  it('inserts an utterance and its statement in one call with uuid v7 ids and skips a repeat', async () => {
    // The statement's lineage needs the utterance id up front, so the caller
    // draws it; the statement leaves its id to the store.
    const said = utterance('We ship on Fridays from now on, no exceptions.', { id: generateId() })
    const quoted = statement('ship on Fridays', [said.id!])

    const result = await store.insertItems([said, quoted])

    expect(result).toEqual([
      { id: said.id, eventKey: said.source.event_key, inserted: true },
      { id: expect.stringMatching(UUID_V7), eventKey: quoted.source.event_key, inserted: true },
    ])
    expect(said.id).toMatch(UUID_V7)

    const repeat = await store.insertItems([said, quoted])
    expect(repeat).toEqual(result.map((r) => ({ ...r, inserted: false })))

    const first = result[0]!
    const second = result[1]!
    const stored = await store.getItems([second.id, first.id])
    expect(stored.map((i) => i.id)).toEqual([second.id, first.id])
    expect(stored[0]!.contentHash).toBe(sha256Hex('ship on Fridays'))
    expect(stored[1]!.contentHash).toBe(sha256Hex('We ship on Fridays from now on, no exceptions.'))
    expect(stored[0]).toMatchObject({
      class: 'mk_statement',
      speaker: 'mk',
      subjectId: SUBJECT_ID,
      lineage: [first.id],
      standing: false,
      occurredAt: at(0),
      forgottenAt: null,
      restatedAt: [],
    })
    expect(stored[0]!.createdAt).toBeInstanceOf(Date)
    expect(Number.isNaN(stored[0]!.createdAt.getTime())).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('stores a statement and its utterance sent together, statement first', async () => {
    const said = utterance('Keep the release notes short.', { id: newId() })
    const quoted = statement('Keep the release notes short', [said.id!], { id: newId() })

    const result = await store.insertItems([quoted, said])

    expect(result.map((r) => [r.id, r.inserted])).toEqual([[quoted.id, true], [said.id, true]])
  }, TEST_TIMEOUT_MS)

  it('refuses a quote that is not in its utterance and stores nothing from the call', async () => {
    const said = utterance('Deploy after the tests pass.', { id: newId() })
    const misquoted = statement('deploy on Sunday', [said.id!], { id: newId() })

    const err = await store.insertItems([said, misquoted]).then(
      () => { throw new Error('expected a refusal') },
      (e: unknown) => e,
    )

    expect(isItemConstraintError(err)).toBe(true)
    expect((err as { constraint: string }).constraint).toBe('memory_items_lineage')
    expect((err as Error).message).not.toContain('deploy on Sunday')
    expect(await storedCount([said.id!, misquoted.id!])).toBe(0)
  }, TEST_TIMEOUT_MS)

  it('reads embeddings back as numbers', async () => {
    const embedding = Array.from({ length: 1536 }, (_, i) => (i % 7) / 8 - 0.375)
    const item = commit('build: pin the toolchain', 0, { embedding, embeddingModel: 'tst-embedder' })

    await store.insertItems([item])
    const [stored] = await store.getItems([item.id!])

    expect(stored!.embedding).toEqual(embedding)
    expect(stored!.embeddingModel).toBe('tst-embedder')
  }, TEST_TIMEOUT_MS)

  it('forgets an item with its lineage, hides it from reads unless asked, and keeps counts at zero', async () => {
    const said = utterance('Use the staging bucket for previews.', { id: newId() })
    const quoted = statement('Use the staging bucket for previews', [said.id!], { id: newId() })
    await store.insertItems([said, quoted])

    const effects = await store.forgetItems([said.id!, 'not-a-uuid'], 'recorded in the wrong session')

    expect(effects).toEqual([
      { itemId: said.id, effect: 'forgotten', via: null },
      { itemId: quoted.id, effect: 'forgotten', via: said.id },
    ])
    expect(await store.getItems([said.id!, quoted.id!])).toEqual([])
    const all = await store.getItems([said.id!, quoted.id!], { includeForgotten: true })
    expect(all.map((i) => [i.id, i.forgottenReason])).toEqual([
      [said.id, 'recorded in the wrong session'],
      [quoted.id, `lineage: ${said.id} forgotten: recorded in the wrong session`],
    ])
    expect(all.every((i) => i.forgottenAt instanceof Date)).toBe(true)
    expect(await store.forgetItems([said.id!], 'again')).toEqual([])
  }, TEST_TIMEOUT_MS)

  it('retires and unretires live items', async () => {
    const item = commit('docs: describe the release steps', 0)
    await store.insertItems([item])

    expect(await store.retireItems([item.id!], 'steps changed')).toEqual([item.id])
    expect(await store.retireItems([item.id!], 'steps changed')).toEqual([])
    const [retired] = await store.getItems([item.id!])
    expect(retired).toMatchObject({ retiredReason: 'steps changed', retiredAt: expect.any(Date) })

    expect(await store.unretireItems([item.id!])).toEqual([item.id])
    const [back] = await store.getItems([item.id!])
    expect(back).toMatchObject({ retiredAt: null, retiredReason: null })
  }, TEST_TIMEOUT_MS)

  it('supersedes an item, restores it when the successor is forgotten, and refuses an earlier successor', async () => {
    const older = commit('feat: first cut of the exporter', 0)
    const newer = commit('feat: exporter streams rows', 10)
    await store.insertItems([older, newer])

    expect(await store.supersedeItem(older.id!, newer.id!)).toBe(true)
    expect(await store.supersedeItem(older.id!, newer.id!)).toBe(false)
    const [superseded] = await store.getItems([older.id!])
    expect(superseded).toMatchObject({ supersededBy: newer.id, validTo: at(10) })

    const refusal = await store.supersedeItem(newer.id!, older.id!).catch((e: unknown) => e)
    expect(isItemConstraintError(refusal)).toBe(true)
    expect((refusal as { constraint: string }).constraint).toBe('engram_supersede_item')

    expect(await store.forgetItems([newer.id!], 'pushed to the wrong branch')).toEqual([
      { itemId: newer.id, effect: 'forgotten', via: null },
      { itemId: older.id, effect: 'restored', via: newer.id },
    ])
    const [restored] = await store.getItems([older.id!])
    expect(restored).toMatchObject({ supersededBy: null, validTo: null })
  }, TEST_TIMEOUT_MS)

  it('reports an argument error as a plain failure', async () => {
    const err = (await store.supersedeItem(newId(), newId()).catch((e: unknown) => e)) as Error

    expect(isItemConstraintError(err)).toBe(false)
    expect(err.message).toMatch(/^supersedeItem failed \(22023\): engram_supersede_item: /)
  }, TEST_TIMEOUT_MS)

  it('reads every invariant count as zero on a store that keeps the rules', async () => {
    expect(await store.invariantCounts()).toEqual({
      assistant_authored_mk_claims: 0,
      quote_not_in_lineage: 0,
      lineage_to_forgotten: 0,
      utterance_time_mismatch: 0,
      unregistered_project: 0,
    })
  }, TEST_TIMEOUT_MS)

  it('refuses a request without a token', async () => {
    const res = await fetch(`${endpoint.url}/memory_items?select=id`)

    expect(res.status).toBe(401)
  }, TEST_TIMEOUT_MS)
})
