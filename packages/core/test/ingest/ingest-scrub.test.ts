import { describe, it, expect, vi, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createMemory } from '../../src/create-memory.js'
import { scrubMessage, describeRedactions } from '../../src/ingest/scrub-message.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { StorageAdapter } from '../../src/adapters/storage.js'

// Synthetic credential shapes: none of these is a real key.
const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop'
const SECRET_TURN = `API_KEY=${FAKE_KEY}`
const SCRUBBED_TURN = 'API_KEY=[REDACTED:API_KEY]'
const PM2_ENV_TURN = [
  'module.exports = { apps: [{ name: "engram-http", env: {',
  `  OPENAI_API_KEY: "${FAKE_KEY}",`,
  '  NEO4J_PASSWORD: "c0rrect-h0rse-battery",',
  '  PORT: 8787,',
  '} }] }',
].join('\n')

function makeGraph(): GraphPort & { ingestEpisode: ReturnType<typeof vi.fn> } {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    ingestEpisode: vi.fn().mockResolvedValue(undefined),
    lookupEntityNodes: vi.fn().mockResolvedValue([]),
    spreadActivation: vi.fn().mockResolvedValue([]),
    strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined),
  } as unknown as GraphPort & { ingestEpisode: ReturnType<typeof vi.fn> }
}

async function storedEpisodes(storage: StorageAdapter, sessionId: string) {
  return storage.episodes.getBySession(sessionId)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Memory.ingest — secret scrubbing', () => {
  it('stores the key name with a placeholder instead of the value', async () => {
    const storage = sqliteAdapter()
    const memory = createMemory({ storage })
    await memory.initialize()

    await memory.ingest({ role: 'user', sessionId: 's1', content: SECRET_TURN })

    const [episode] = await storedEpisodes(storage, 's1')
    expect(episode!.content).toBe(SCRUBBED_TURN)
    expect(JSON.stringify(episode!.metadata)).not.toContain(FAKE_KEY)
    await memory.dispose()
  })

  it('sends only scrubbed text to the embedder, the preamble model, entity extraction and the graph', async () => {
    const storage = sqliteAdapter()
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const contextualizeChunk = vi.fn().mockResolvedValue('Deploy configuration for the HTTP server.')
    const extractEntities = vi.fn().mockResolvedValue([])
    const intelligence: IntelligenceAdapter = { embed, contextualizeChunk, extractEntities }
    const graph = makeGraph()
    const memory = createMemory({ storage, intelligence, graph, contextualRetrieval: true })
    await memory.initialize()

    await memory.ingest({ role: 'assistant', sessionId: 's2', content: PM2_ENV_TURN })
    await memory.flushPendingWrites()

    const sent = [
      ...embed.mock.calls.map((c) => String(c[0])),
      ...contextualizeChunk.mock.calls.map((c) => String(c[0])),
      ...extractEntities.mock.calls.map((c) => String(c[0])),
      ...graph.ingestEpisode.mock.calls.map((c) => String((c[0] as { content: string }).content)),
    ]
    expect(embed).toHaveBeenCalledOnce()
    expect(contextualizeChunk).toHaveBeenCalledOnce()
    expect(extractEntities).toHaveBeenCalledOnce()
    expect(graph.ingestEpisode).toHaveBeenCalledOnce()
    for (const text of sent) {
      expect(text).not.toContain(FAKE_KEY)
      expect(text).not.toContain('c0rrect-h0rse-battery')
      expect(text).toContain('OPENAI_API_KEY: "[REDACTED:OPENAI_API_KEY]"')
      expect(text).toContain('NEO4J_PASSWORD: "[REDACTED:NEO4J_PASSWORD]"')
      expect(text).toContain('PORT: 8787')
    }
    await memory.dispose()
  })

  it('scrubs content blocks, tool inputs and string metadata values before storage', async () => {
    const storage = sqliteAdapter()
    const memory = createMemory({ storage })
    await memory.initialize()

    await memory.ingest({
      role: 'assistant',
      sessionId: 's3',
      content: [
        { type: 'text', text: `Connecting with psql postgresql://engram:Sup3rS3cretPw@db.internal:5432/engram now` },
        { type: 'tool_use', name: 'Bash', input: { command: `export ${SECRET_TURN} && npm run deploy`, env: { password: 'hunter2hunter2' } } },
      ],
      metadata: { source: 'hook', rawTurn: `curl -H "Authorization: Bearer ${FAKE_KEY}" https://api.example.test` },
    })

    const [episode] = await storedEpisodes(storage, 's3')
    const stored = JSON.stringify(episode)
    expect(stored).not.toContain('Sup3rS3cretPw')
    expect(stored).not.toContain(FAKE_KEY)
    expect(stored).not.toContain('hunter2hunter2')
    expect(episode!.content).toContain('postgresql://engram:[REDACTED:postgres-url]@db.internal')
    expect(episode!.metadata['source']).toBe('hook')
    expect(String(episode!.metadata['rawTurn'])).toContain('Authorization: Bearer [REDACTED:')
    await memory.dispose()
  })

  it('stores text without secrets byte-identical', async () => {
    const storage = sqliteAdapter()
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const memory = createMemory({ storage, intelligence: { embed } })
    await memory.initialize()
    const text = [
      'Merged 7cd38b1 into fix/r-branch; the password reset flow now expires the token after 15 minutes.',
      'TOKEN_LIMIT=4096 and session 3f2b8c1e-9d4a-4f6b-8e2c-1a5d7b9c0e3f stay as they are.',
    ].join('\n')

    await memory.ingest({ role: 'user', sessionId: 's4', content: text, metadata: { note: 'max_tokens: 500' } })

    const [episode] = await storedEpisodes(storage, 's4')
    expect(episode!.content).toBe(text)
    expect(episode!.metadata['note']).toBe('max_tokens: 500')
    expect(embed).toHaveBeenCalledWith(text)
    await memory.dispose()
  })

  it('logs the redaction count and kinds, never the value or the key name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = sqliteAdapter()
    const memory = createMemory({ storage })
    await memory.initialize()

    await memory.ingest({ role: 'user', sessionId: 's5', content: `${SECRET_TURN}\nghp_abcdefghijklmnopqrstuvwxyz0123456789` })

    const lines = warn.mock.calls.map((c) => c.map(String).join(' '))
    const line = lines.find((l) => l.includes('redacted'))
    expect(line).toBe('[engram] ingest: redacted 2 secret value(s): named-secret(1), github-token(1)')
    for (const l of lines) {
      expect(l).not.toContain(FAKE_KEY)
      expect(l).not.toContain('API_KEY')
    }
    await memory.dispose()
  })
})

describe('Memory.ingestBatch — secret scrubbing', () => {
  it('sends scrubbed text to the batched embedder and stores it scrubbed', async () => {
    const storage = sqliteAdapter()
    const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]))
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const memory = createMemory({ storage, intelligence: { embed, embedBatch } })
    await memory.initialize()
    const turns = [
      'Setting up the staging box for the HTTP server today.',
      `Put ${SECRET_TURN} in the .env file on staging.`,
      'Restarted pm2 and the health check is green again.',
      'Next step is wiring the reranker behind a flag.',
    ]

    await memory.ingestBatch(turns.map((content) => ({ role: 'user' as const, sessionId: 's6', content })))

    expect(embedBatch).toHaveBeenCalledOnce()
    expect(embed).not.toHaveBeenCalled()
    const batch = embedBatch.mock.calls[0]![0]
    expect(batch.join('\n')).not.toContain(FAKE_KEY)
    expect(batch.join('\n')).toContain(SCRUBBED_TURN)
    const episodes = await storedEpisodes(storage, 's6')
    expect(episodes.map((e) => e.content)).toContain(`Put ${SCRUBBED_TURN} in the .env file on staging.`)
    await memory.dispose()
  })
})

describe('scrubMessage', () => {
  it('returns the same message object when nothing is redacted', () => {
    const message = { role: 'user' as const, content: [{ type: 'text', text: 'plain words' }], metadata: { a: 1 } }
    const result = scrubMessage(message)
    expect(result.message).toBe(message)
    expect(result.redactions).toEqual([])
  })

  it('redacts a string value under a secret-named key and keeps non-secret values under such keys', () => {
    const result = scrubMessage({
      role: 'user',
      content: 'x',
      metadata: { db_password: 'hunter2hunter2', api_key: '$OPENAI_API_KEY', max_tokens: '500' },
    })
    expect(result.message.metadata).toEqual({
      db_password: '[REDACTED:db_password]',
      api_key: '$OPENAI_API_KEY',
      max_tokens: '500',
    })
    expect(result.redactions).toEqual([{ kind: 'named-secret', name: 'db_password' }])
  })

  it('is idempotent on an already scrubbed message', () => {
    const once = scrubMessage({ role: 'user', content: PM2_ENV_TURN })
    const twice = scrubMessage(once.message)
    expect(twice.message).toBe(once.message)
    expect(twice.redactions).toEqual([])
  })

  it('describes redactions by count and kind only', () => {
    expect(describeRedactions([
      { kind: 'named-secret', name: 'API_KEY' },
      { kind: 'jwt' },
      { kind: 'named-secret', name: 'DB_PASSWORD' },
    ])).toBe('redacted 3 secret value(s): named-secret(2), jwt(1)')
  })
})
