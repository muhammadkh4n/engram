import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Memory, SalienceClassification, StorageAdapter, IntelligenceAdapter } from '@engram-mem/core'
import type { CaptureDeps } from '../src/ingest/capture.js'
import { OpenAISummarizer } from '@engram-mem/openai'
import { runCaptureRequest, CAPTURE_CONTENT_MAX_CHARS, type CaptureRouteDeps } from '../src/capture-route.js'

const TURN =
  'We moved the ingest worker to a systemd timer; the old pm2 cron entry was removed from the ecosystem file.'
const DISTILLED = 'The ingest worker runs from a systemd timer; the pm2 cron entry is gone.'
const EXCERPT = [
  'User: the stop hook keeps timing out on large transcripts',
  'Assistant: moved the transcript read to a streaming parser and capped it at 3000 chars per turn',
].join('\n')
const DIGEST = '- The stop hook streams the transcript and caps each turn at 3000 chars.'
const DAY_MS = 24 * 60 * 60 * 1000

function classification(overrides: Partial<SalienceClassification> = {}): SalienceClassification {
  return { store: true, category: 'decision', confidence: 0.9, distilled: DISTILLED, reason: 'infra decision', ...overrides }
}

function makeHarness() {
  const extractSalience = vi.fn(async () => classification())
  const digestTranscript = vi.fn(async () => ({ memory: DIGEST, context: 'Working on stop-hook timeouts.' }))
  const embed = vi.fn(async () => [0.1, 0.2, 0.3])
  const search = vi.fn(async () => [] as unknown[])
  const recordAccess = vi.fn(async () => undefined)
  const getBySession = vi.fn(async () => [] as unknown[])
  const findIdByCaptureKey = vi.fn(async (): Promise<string | null> => null)
  const ingest = vi.fn(async () => undefined)
  const getMemory = vi.fn(async () => ({ ingest }) as unknown as Memory)
  const captureDeps: CaptureDeps = {
    getMemory,
    storage: { episodes: { search, recordAccess, getBySession, findIdByCaptureKey } } as unknown as StorageAdapter,
    intelligence: { extractSalience, digestTranscript, embed } as unknown as IntelligenceAdapter,
    threshold: 0.7,
    captureModel: 'test-chat-model',
  }
  const resolveDeps = vi.fn(async () => captureDeps)
  const deps: CaptureRouteDeps = { captureModel: 'test-chat-model', captureDeps: resolveDeps }
  return {
    deps,
    captureDeps,
    resolveDeps,
    extractSalience,
    digestTranscript,
    search,
    getBySession,
    findIdByCaptureKey,
    ingest,
    getMemory,
  }
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: TURN,
    role: 'user',
    session_id: 'sess-route-1',
    project_id: 'engram',
    source: 'claude-code',
    ...overrides,
  }
}

function ingestedMetadata(ingest: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [message] = ingest.mock.calls[0] as [{ metadata: Record<string, unknown> }]
  return message.metadata
}

const savedSources = process.env['ENGRAM_SECRET_SOURCES_FILE']

beforeEach(() => {
  // The scrubber reads this machine's secret registry when configured.
  delete process.env['ENGRAM_SECRET_SOURCES_FILE']
})

afterEach(() => {
  if (savedSources !== undefined) process.env['ENGRAM_SECRET_SOURCES_FILE'] = savedSources
})

describe('runCaptureRequest validation', () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['a missing source', { source: undefined }],
    ['a source outside the pattern', { source: 'Claude Code' }],
    ['a non-boolean gate', { gate: 'yes' }],
    ['an unknown derive kind', { derive: 'weekly-digest' }],
    ['meta with 9 keys', { meta: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])) }],
    ['a meta value that is not a string', { meta: { cwd: 42 } }],
    ['content over the cap', { content: 'x'.repeat(CAPTURE_CONTENT_MAX_CHARS + 1) }],
    ['empty content', { content: '   ' }],
    ['a key over 128 chars', { key: 'k'.repeat(129) }],
    ['a missing role on a turn', { role: undefined }],
    ['an unknown field', { dryRun: true }],
    ['a numeric project_id', { project_id: 123 }],
    ['a meta key name over 128 chars', { meta: { ['m'.repeat(129)]: 'v' } }],
  ]

  it.each(invalid)('refuses %s with a permanent error and never opens the stores', async (_label, overrides) => {
    const h = makeHarness()
    const payload = body(overrides)
    for (const [k, v] of Object.entries(payload)) if (v === undefined) delete payload[k]

    const res = await runCaptureRequest(h.deps, payload)

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ outcome: 'error', retryable: false, model: 'test-chat-model' })
    expect(typeof res.body.message).toBe('string')
    expect(h.resolveDeps).not.toHaveBeenCalled()
  })

  it('refuses a body that is not an object', async () => {
    const h = makeHarness()
    const res = await runCaptureRequest(h.deps, ['content'])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ outcome: 'error', retryable: false })
  })

  it('accepts content exactly at the cap', async () => {
    const h = makeHarness()
    const res = await runCaptureRequest(h.deps, body({ content: 'y'.repeat(CAPTURE_CONTENT_MAX_CHARS) }))
    expect(res.status).toBe(200)
  })
})

describe('runCaptureRequest turns', () => {
  it('reports anything thrown after validation as a retryable error', async () => {
    const h = makeHarness()
    h.extractSalience.mockRejectedValueOnce(new Error('chat endpoint returned 502'))

    const res = await runCaptureRequest(h.deps, body())

    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      outcome: 'error',
      model: 'test-chat-model',
      retryable: true,
      message: 'chat endpoint returned 502',
    })
  })

  it('reports a failing chat model as a retryable error, not a rejection', async () => {
    const h = makeHarness()
    // The real summarizer on a stubbed chat client: its handling of an API
    // error decides whether the capture is retried or silently dropped.
    const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
    const create = vi.fn(async () => {
      throw new Error('429 rate limited')
    })
    ;(summarizer as unknown as { client: unknown }).client = { chat: { completions: { create } } }
    const onRejected = vi.fn()
    h.resolveDeps.mockResolvedValueOnce({
      ...h.captureDeps,
      intelligence: {
        extractSalience: (content: string, opts: Parameters<OpenAISummarizer['extractSalience']>[1]) =>
          summarizer.extractSalience(content, opts),
        embed: vi.fn(async () => [0.1]),
      } as unknown as IntelligenceAdapter,
      onRejected,
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const res = await runCaptureRequest(h.deps, body())

    expect(create).toHaveBeenCalledOnce()
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ outcome: 'error', retryable: true, message: '429 rate limited' })
    expect(onRejected).not.toHaveBeenCalled()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('reports a failure to open the stores as retryable', async () => {
    const h = makeHarness()
    h.resolveDeps.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    const res = await runCaptureRequest(h.deps, body())
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ outcome: 'error', retryable: true })
  })

  it('returns a gated rejection with its category and confidence', async () => {
    const h = makeHarness()
    h.extractSalience.mockResolvedValueOnce(classification({ category: 'context', confidence: 0.4, reason: 'chit-chat' }))

    const res = await runCaptureRequest(h.deps, body())

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ outcome: 'rejected', category: 'context', confidence: 0.4, reason: 'chit-chat' })
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('stores a gated turn with the caller provenance', async () => {
    const h = makeHarness()
    const res = await runCaptureRequest(h.deps, body({ meta: { cwd: '/repo', trigger: 'stop' }, key: 'turn-9' }))

    expect(res.body).toMatchObject({ outcome: 'stored', model: 'test-chat-model', project: 'engram' })
    expect(ingestedMetadata(h.ingest)).toMatchObject({
      source: 'claude-code',
      captureKey: 'turn-9',
      cwd: '/repo',
      trigger: 'stop',
      captureModel: 'test-chat-model',
    })
  })

  it('writes nothing on dry_run', async () => {
    const h = makeHarness()
    const res = await runCaptureRequest(h.deps, body({ dry_run: true }))

    expect(res.body).toMatchObject({ outcome: 'dry_run', category: 'decision' })
    expect(h.ingest).not.toHaveBeenCalled()
    expect(h.getMemory).not.toHaveBeenCalled()
    expect(h.search).not.toHaveBeenCalled()
  })

  it('does not ingest a replayed key twice', async () => {
    const h = makeHarness()
    const storedKeys = new Set<string>()
    h.findIdByCaptureKey.mockImplementation(async (_session: string, key: string) =>
      storedKeys.has(key) ? 'ep-1' : null,
    )
    h.ingest.mockImplementation(async (message: unknown) => {
      const key = (message as { metadata: Record<string, unknown> }).metadata['captureKey']
      if (typeof key === 'string') storedKeys.add(key)
    })

    const first = await runCaptureRequest(h.deps, body({ key: 'commit-abc123' }))
    const second = await runCaptureRequest(h.deps, body({ key: 'commit-abc123' }))

    expect(first.body.outcome).toBe('stored')
    expect(second.body).toEqual({ outcome: 'replayed', model: 'test-chat-model' })
    expect(h.ingest).toHaveBeenCalledTimes(1)
    expect(h.extractSalience).toHaveBeenCalledTimes(1)
  })
})

describe('runCaptureRequest derive', () => {
  it('digests a pre-compact excerpt, returns the context and dedups at 0.62 over 30 days', async () => {
    const h = makeHarness()
    h.digestTranscript.mockResolvedValueOnce({ memory: DIGEST, context: 'Working on stop-hook timeouts.' })
    h.search.mockResolvedValueOnce([
      { item: { id: 'summary-1', createdAt: new Date(Date.now() - 20 * DAY_MS), metadata: {} }, similarity: 0.65 },
    ])

    const res = await runCaptureRequest(h.deps, body({ content: EXCERPT, derive: 'pre-compact', role: undefined }))

    expect(h.digestTranscript).toHaveBeenCalledWith(EXCERPT, { kind: 'pre-compact' })
    expect(res.body).toMatchObject({
      outcome: 'deduped',
      duplicateOf: 'summary-1',
      similarity: 0.65,
      context: 'Working on stop-hook timeouts.',
    })
    expect(h.extractSalience).not.toHaveBeenCalled()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('stores a pre-compact digest as a system turn with its type and extraction time', async () => {
    const h = makeHarness()
    const res = await runCaptureRequest(
      h.deps,
      body({ content: EXCERPT, derive: 'pre-compact', meta: { type: 'spoofed', trigger: 'auto' } }),
    )

    expect(res.body).toMatchObject({ outcome: 'stored', context: 'Working on stop-hook timeouts.' })
    const [message] = h.ingest.mock.calls[0] as [{ content: string; role: string }]
    expect(message).toMatchObject({ content: DIGEST, role: 'system' })
    const metadata = ingestedMetadata(h.ingest)
    expect(metadata).toMatchObject({ type: 'pre-compact-summary', trigger: 'auto', source: 'claude-code' })
    expect(Number.isNaN(Date.parse(metadata['extractedAt'] as string))).toBe(false)
  })

  it('never dedups a session summary and stores its summary time', async () => {
    const h = makeHarness()
    const res = await runCaptureRequest(h.deps, body({ content: EXCERPT, derive: 'session-summary', dedup: true }))

    expect(h.digestTranscript).toHaveBeenCalledWith(EXCERPT, { kind: 'session-summary' })
    expect(res.body.outcome).toBe('stored')
    expect(res.body.context).toBeUndefined()
    expect(h.search).not.toHaveBeenCalled()
    const metadata = ingestedMetadata(h.ingest)
    expect(metadata['type']).toBe('session-summary')
    expect(Number.isNaN(Date.parse(metadata['summarizedAt'] as string))).toBe(false)
  })

  it('rejects an empty digest and stores nothing', async () => {
    const h = makeHarness()
    h.digestTranscript.mockResolvedValueOnce({ memory: '  \n', context: '' })

    const res = await runCaptureRequest(h.deps, body({ content: EXCERPT, derive: 'session-summary' }))

    expect(res.body).toEqual({ outcome: 'rejected', model: 'test-chat-model', reason: 'empty_digest' })
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('answers a replayed derive key before paying for a digest', async () => {
    const h = makeHarness()
    h.findIdByCaptureKey.mockResolvedValueOnce('ep-7')

    const res = await runCaptureRequest(h.deps, body({ content: EXCERPT, derive: 'pre-compact', key: 'compact-7' }))

    expect(res.body).toEqual({ outcome: 'replayed', model: 'test-chat-model' })
    expect(h.digestTranscript).not.toHaveBeenCalled()
  })

  it('probes a new derive key once and stores it under the capture model', async () => {
    const h = makeHarness()

    const res = await runCaptureRequest(h.deps, body({ content: EXCERPT, derive: 'session-summary', key: 'summary-9' }))

    expect(res.body.outcome).toBe('stored')
    expect(h.findIdByCaptureKey).toHaveBeenCalledOnce()
    expect(h.findIdByCaptureKey.mock.calls[0]!.slice(0, 2)).toEqual(['sess-route-1', 'summary-9'])
    expect(h.getBySession).not.toHaveBeenCalled()
    expect(ingestedMetadata(h.ingest)).toMatchObject({ captureKey: 'summary-9', captureModel: 'test-chat-model' })
  })
})
