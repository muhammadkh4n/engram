/**
 * The capture route's replay probe is check-then-insert, so two deliveries of
 * one capture can both miss it. Only the store can make them collide: a
 * partial unique index on (session_id, metadata->>'captureKey'), and an
 * insert that reports that collision as a typed error after removing the
 * memories registry row it wrote first.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { DuplicateCaptureKeyError, isDuplicateCaptureKey } from '@engram-mem/core'
import { PostgRestEpisodeStorage } from '../src/episodes.js'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

describe('capture key index', () => {
  it('is unique per session and covers only rows that carry a capture key', () => {
    expect(schema).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_capture_key ON public.memory_episodes (session_id, (metadata->>'captureKey')) WHERE metadata ? 'captureKey';",
    )
  })
})

interface PgError {
  code: string
  message: string
  details: string | null
  hint: string | null
}

const CAPTURE_KEY_VIOLATION: PgError = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "idx_episodes_capture_key"',
  details: "Key (session_id, (metadata ->> 'captureKey'::text))=(sess-1, commit-4f2a9c1) already exists.",
  hint: null,
}

const PKEY_VIOLATION: PgError = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "memory_episodes_pkey"',
  details: 'Key (id)=(0b7e2f5c-3f1d-4c55-9a51-0d8b1c2e4f60) already exists.',
  hint: null,
}

function mockClient(episodeError: PgError | null, deleteError: { message: string } | null = null) {
  const registryInserts: string[] = []
  const registryDeletes: string[] = []
  const client = {
    from: vi.fn((table: string) => ({
      insert: vi.fn((row: Record<string, unknown>) => {
        if (table === 'memories') registryInserts.push(row.id as string)
        return {
          select: () => ({ single: async () => ({ data: null, error: episodeError }) }),
          then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
        }
      }),
      delete: vi.fn(() => ({
        eq: vi.fn(async (column: string, value: string) => {
          if (table === 'memories' && column === 'id') registryDeletes.push(value)
          return { error: deleteError }
        }),
      })),
    })),
  }
  return { client: client as unknown as PostgrestClient, registryInserts, registryDeletes }
}

const episode = {
  sessionId: 'sess-1', role: 'user' as const, content: 'The deploy script now runs from a systemd timer.',
  salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null, embedding: null,
  entities: [], projectId: null,
  metadata: { captureKey: 'commit-4f2a9c1', source: 'claude-code-hook' },
}

describe('episode insert on a unique violation', () => {
  it('removes the registry row and throws the typed error when the capture key collides', async () => {
    const { client, registryInserts, registryDeletes } = mockClient(CAPTURE_KEY_VIOLATION)
    const store = new PostgRestEpisodeStorage(client)

    const err = await store.insert(episode).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DuplicateCaptureKeyError)
    expect(isDuplicateCaptureKey(err)).toBe(true)
    expect(err).toMatchObject({ sessionId: 'sess-1', key: 'commit-4f2a9c1' })
    expect(registryInserts).toHaveLength(1)
    expect(registryDeletes).toEqual(registryInserts)
  })

  it('throws a plain error and still removes the registry row for any other unique violation', async () => {
    const { client, registryInserts, registryDeletes } = mockClient(PKEY_VIOLATION)
    const store = new PostgRestEpisodeStorage(client)

    const err = await store.insert(episode).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(isDuplicateCaptureKey(err)).toBe(false)
    expect((err as Error).message).toContain('Episode insert failed')
    expect(registryDeletes).toEqual(registryInserts)
  })

  it('does not treat free text naming the index as a capture-key collision without the unique-violation code', async () => {
    const { client, registryInserts, registryDeletes } = mockClient({ ...CAPTURE_KEY_VIOLATION, code: '57014' })
    const store = new PostgRestEpisodeStorage(client)

    const err = await store.insert(episode).catch((e: unknown) => e)

    expect(isDuplicateCaptureKey(err)).toBe(false)
    expect(registryDeletes).toEqual(registryInserts)
  })

  it('reports a failed registry cleanup instead of leaving the orphan unmentioned', async () => {
    const { client } = mockClient(CAPTURE_KEY_VIOLATION, { message: 'connection reset' })
    const store = new PostgRestEpisodeStorage(client)

    const err = await store.insert(episode).catch((e: unknown) => e)

    expect(isDuplicateCaptureKey(err)).toBe(false)
    expect((err as Error).message).toMatch(/idx_episodes_capture_key[\s\S]*connection reset/)
  })
})
