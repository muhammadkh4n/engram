import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  EmptyClassifierReplyError,
  UnclassifiableReplyError,
  type Memory,
  type SalienceClassification,
  type StorageAdapter,
  type IntelligenceAdapter,
} from '@engram-mem/core'
import { runCapture, type CaptureDeps, type CaptureInput } from '../src/ingest/capture.js'

const TURN =
  'We moved the ingest worker to a systemd timer; the old pm2 cron entry was removed from the ecosystem file.'
const DISTILLED = 'The ingest worker runs from a systemd timer; the pm2 cron entry is gone.'
const DAY_MS = 24 * 60 * 60 * 1000

function classification(overrides: Partial<SalienceClassification> = {}): SalienceClassification {
  return {
    store: true,
    category: 'decision',
    confidence: 0.9,
    distilled: DISTILLED,
    reason: 'infra decision',
    ...overrides,
  }
}

function makeHarness() {
  const extractSalience = vi.fn(async () => classification())
  const embed = vi.fn(async () => [0.1, 0.2, 0.3])
  const search = vi.fn(async () => [] as unknown[])
  const recordAccess = vi.fn(async () => undefined)
  const getBySession = vi.fn(async () => [] as unknown[])
  const findIdByCaptureKey = vi.fn(async (): Promise<string | null> => null)
  const ingest = vi.fn(async () => undefined)
  const memory = { ingest } as unknown as Memory
  const getMemory = vi.fn(async () => memory)
  const storage = {
    episodes: { search, recordAccess, getBySession, findIdByCaptureKey },
  } as unknown as StorageAdapter
  const intelligence = { extractSalience, embed } as unknown as IntelligenceAdapter
  const deps: CaptureDeps = {
    getMemory,
    storage,
    intelligence,
    threshold: 0.7,
    captureModel: 'test-chat-model',
  }
  return { deps, extractSalience, embed, search, recordAccess, getBySession, findIdByCaptureKey, ingest, getMemory }
}

function input(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    content: TURN,
    role: 'user',
    sessionId: 'sess-capture-1',
    project: 'engram',
    source: 'claude-code-hook',
    gate: true,
    dedup: true,
    dryRun: false,
    ...overrides,
  }
}

function ingestedCall(ingest: ReturnType<typeof vi.fn>) {
  const [message, opts] = ingest.mock.calls[0] as [
    { content: string; role: string; sessionId?: string; metadata: Record<string, unknown> },
    { projectId?: string } | undefined,
  ]
  return { message, opts }
}

const savedSources = process.env['ENGRAM_SECRET_SOURCES_FILE']
const savedDedupThreshold = process.env['ENGRAM_DEDUP_THRESHOLD']

beforeEach(() => {
  // The scrubber reads this machine's secret registry when configured; the
  // pipeline tests must not depend on it.
  delete process.env['ENGRAM_SECRET_SOURCES_FILE']
  delete process.env['ENGRAM_DEDUP_THRESHOLD']
})

afterEach(() => {
  if (savedSources !== undefined) process.env['ENGRAM_SECRET_SOURCES_FILE'] = savedSources
  if (savedDedupThreshold !== undefined) process.env['ENGRAM_DEDUP_THRESHOLD'] = savedDedupThreshold
})

describe('runCapture threshold gate', () => {
  it('rejects a turn classified below the threshold and ingests nothing', async () => {
    const h = makeHarness()
    h.extractSalience.mockResolvedValue(classification({ confidence: 0.69 }))
    const onRejected = vi.fn()

    const out = await runCapture({ ...h.deps, onRejected }, input())

    expect(out).toMatchObject({ outcome: 'rejected', model: 'test-chat-model', confidence: 0.69 })
    expect(h.ingest).not.toHaveBeenCalled()
    expect(h.getMemory).not.toHaveBeenCalled()
    expect(h.search).not.toHaveBeenCalled()
    expect(onRejected).toHaveBeenCalledOnce()
    expect(onRejected.mock.calls[0]![0]).toMatchObject({ content: TURN, project: 'engram', source: 'claude-code-hook' })
  })

  it('stores a turn classified exactly at the threshold', async () => {
    const h = makeHarness()
    h.extractSalience.mockResolvedValue(classification({ confidence: 0.7 }))

    const out = await runCapture(h.deps, input())

    expect(out).toMatchObject({ outcome: 'stored', confidence: 0.7, project: 'engram' })
    expect(h.ingest).toHaveBeenCalledOnce()
  })

  it('rejects a classifier store=false even at high confidence', async () => {
    const h = makeHarness()
    h.extractSalience.mockResolvedValue(classification({ store: false, confidence: 0.95, category: 'none' }))

    const out = await runCapture(h.deps, input())

    expect(out.outcome).toBe('rejected')
    expect(h.ingest).not.toHaveBeenCalled()
  })
})

describe('runCapture classification', () => {
  it('stores the text verbatim as a fact when the gate is off', async () => {
    const h = makeHarness()

    const out = await runCapture(h.deps, input({ gate: false }))

    expect(h.extractSalience).not.toHaveBeenCalled()
    expect(out).toMatchObject({ outcome: 'stored', model: 'raw', category: 'fact', confidence: 1, reason: 'raw_mode' })
    const { message } = ingestedCall(h.ingest)
    expect(message.content).toBe(TURN)
    expect(message.metadata['salienceCategory']).toBe('fact')
    // No model saw the stored text.
    expect(message.metadata['captureModel']).toBe('raw')
  })

  it('propagates a failed classifier call once, without retrying, rejecting or storing', async () => {
    const h = makeHarness()
    const onRejected = vi.fn()
    h.extractSalience.mockRejectedValue(new Error('chat endpoint returned 502'))

    await expect(runCapture({ ...h.deps, onRejected }, input())).rejects.toThrow('returned 502')

    expect(h.extractSalience).toHaveBeenCalledOnce()
    expect(onRejected).not.toHaveBeenCalled()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('returns an unclassifiable error outcome after two unreadable replies', async () => {
    const h = makeHarness()
    const onRejected = vi.fn()
    h.extractSalience.mockRejectedValue(new UnclassifiableReplyError('classifier output is not a JSON object'))

    const out = await runCapture({ ...h.deps, onRejected }, input())

    expect(h.extractSalience).toHaveBeenCalledTimes(2)
    expect(out).toEqual({
      outcome: 'error',
      model: 'test-chat-model',
      retryable: false,
      reason: 'unclassifiable',
      message: 'classifier output is not a JSON object',
    })
    expect(onRejected).not.toHaveBeenCalled()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('retries an empty classifier reply once and stores the second verdict', async () => {
    const h = makeHarness()
    h.extractSalience.mockRejectedValueOnce(new EmptyClassifierReplyError('empty classifier reply (finish_reason=length)'))

    const out = await runCapture(h.deps, input())

    expect(h.extractSalience).toHaveBeenCalledTimes(2)
    expect(out.outcome).toBe('stored')
    expect(h.ingest).toHaveBeenCalledOnce()
  })

  it('propagates a second empty classifier reply as a failed call, not unclassifiable', async () => {
    const h = makeHarness()
    const onRejected = vi.fn()
    h.extractSalience.mockRejectedValue(new EmptyClassifierReplyError('empty classifier reply (finish_reason=stop)'))

    await expect(runCapture({ ...h.deps, onRejected }, input())).rejects.toBeInstanceOf(EmptyClassifierReplyError)

    expect(h.extractSalience).toHaveBeenCalledTimes(2)
    expect(onRejected).not.toHaveBeenCalled()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('recognises an unreadable-reply error from another copy of core by its name', async () => {
    const h = makeHarness()
    const foreign = Object.assign(new Error('no boolean store'), { name: 'UnclassifiableReplyError' })
    h.extractSalience.mockRejectedValueOnce(foreign)

    const out = await runCapture(h.deps, input())

    expect(h.extractSalience).toHaveBeenCalledTimes(2)
    expect(out.outcome).toBe('stored')
  })

  it('stores a preference shared even when the turn carries a project', async () => {
    const h = makeHarness()
    h.extractSalience.mockResolvedValue(classification({ category: 'preference', distilled: 'MK prefers pnpm over npm.' }))

    const out = await runCapture(h.deps, input({ project: 'engram' }))

    expect(out.outcome).toBe('stored')
    expect(out.project).toBeUndefined()
    const { message, opts } = ingestedCall(h.ingest)
    expect(opts).toBeUndefined()
    expect(message.metadata).not.toHaveProperty('project')
    expect(h.extractSalience).toHaveBeenCalledWith(TURN, { turnRole: 'user', project: 'engram' })
  })

  it('rejects content shorter than two characters without calling the classifier', async () => {
    const h = makeHarness()

    const out = await runCapture(h.deps, input({ content: 'k' }))

    expect(out).toMatchObject({ outcome: 'rejected', reason: 'too_short' })
    expect(h.extractSalience).not.toHaveBeenCalled()
  })
})

describe('runCapture dedup', () => {
  it('boosts a recent same-project duplicate and never builds the memory stack', async () => {
    const h = makeHarness()
    h.search.mockResolvedValue([
      {
        item: { id: 'dup-episode-1', createdAt: new Date(Date.now() - DAY_MS), metadata: { project: 'engram' } },
        similarity: 0.91,
      },
    ])

    const out = await runCapture(h.deps, input())

    expect(out).toMatchObject({ outcome: 'deduped', duplicateOf: 'dup-episode-1', similarity: 0.91 })
    expect(h.embed).toHaveBeenCalledWith(DISTILLED)
    expect(h.recordAccess).toHaveBeenCalledWith('dup-episode-1')
    expect(h.ingest).not.toHaveBeenCalled()
    expect(h.getMemory).not.toHaveBeenCalled()
  })

  it('applies a caller dedup threshold and window', async () => {
    const h = makeHarness()
    h.search.mockResolvedValue([
      {
        item: { id: 'old-episode', createdAt: new Date(Date.now() - 20 * DAY_MS), metadata: { project: 'engram' } },
        similarity: 0.65,
      },
    ])

    const out = await runCapture(h.deps, input({ dedup: { threshold: 0.62, windowDays: 30 } }))

    expect(out).toMatchObject({ outcome: 'deduped', duplicateOf: 'old-episode' })
  })

  it('skips the duplicate search when dedup is off', async () => {
    const h = makeHarness()

    const out = await runCapture(h.deps, input({ dedup: false }))

    expect(out.outcome).toBe('stored')
    expect(h.search).not.toHaveBeenCalled()
  })

  it('resolves a deferred storage only when a check needs it', async () => {
    const h = makeHarness()
    const storage = vi.fn(async () => h.deps.storage as StorageAdapter)
    h.extractSalience.mockResolvedValue(classification({ confidence: 0.2 }))

    await runCapture({ ...h.deps, storage }, input())

    expect(storage).not.toHaveBeenCalled()
  })
})

describe('runCapture dry run', () => {
  it('classifies without dedup or writes', async () => {
    const h = makeHarness()

    const out = await runCapture(h.deps, input({ dryRun: true }))

    expect(out).toMatchObject({ outcome: 'dry_run', category: 'decision', confidence: 0.9, project: 'engram' })
    expect(h.extractSalience).toHaveBeenCalledOnce()
    expect(h.search).not.toHaveBeenCalled()
    expect(h.recordAccess).not.toHaveBeenCalled()
    expect(h.getMemory).not.toHaveBeenCalled()
    expect(h.ingest).not.toHaveBeenCalled()
  })
})

describe('runCapture stored metadata', () => {
  it('carries provenance, salience, rawTurn, model, key and meta values', async () => {
    const h = makeHarness()
    const longTurn = `${TURN} ${'x'.repeat(5000)}`

    await runCapture(
      h.deps,
      input({
        content: longTurn,
        key: 'commit-4f2a9c1',
        meta: { cwd: '/home/dev/engram', trigger: 'post-commit', source: 'spoofed' },
      }),
    )

    const { message, opts } = ingestedCall(h.ingest)
    expect(opts).toEqual({ projectId: 'engram' })
    expect(message).toMatchObject({ content: DISTILLED, role: 'user', sessionId: 'sess-capture-1' })
    expect(message.metadata).toEqual({
      cwd: '/home/dev/engram',
      trigger: 'post-commit',
      source: 'claude-code-hook',
      project: 'engram',
      salienceCategory: 'decision',
      salienceConfidence: 0.9,
      salienceReason: 'infra decision',
      rawTurn: longTurn.slice(0, 4000),
      captureModel: 'test-chat-model',
      captureKey: 'commit-4f2a9c1',
    })
  })

  it('omits sessionId, captureKey and project when absent', async () => {
    const h = makeHarness()

    await runCapture(h.deps, input({ sessionId: undefined, project: null }))

    const { message, opts } = ingestedCall(h.ingest)
    expect(opts).toBeUndefined()
    expect(message).not.toHaveProperty('sessionId')
    expect(message.metadata).not.toHaveProperty('captureKey')
    expect(message.metadata).not.toHaveProperty('project')
  })
})

describe('runCapture idempotency', () => {
  it('replays a key already stored in the session without calling the classifier', async () => {
    const h = makeHarness()
    h.findIdByCaptureKey.mockResolvedValue('ep-2')

    const out = await runCapture(h.deps, input({ key: 'commit-4f2a9c1' }))

    expect(out).toEqual({ outcome: 'replayed', model: 'test-chat-model' })
    expect(h.extractSalience).not.toHaveBeenCalled()
    expect(h.ingest).not.toHaveBeenCalled()
    expect(h.findIdByCaptureKey).toHaveBeenCalledOnce()
    const [sessionId, key, opts] = h.findIdByCaptureKey.mock.calls[0] as unknown as [string, string, { since: Date }]
    expect(sessionId).toBe('sess-capture-1')
    expect(key).toBe('commit-4f2a9c1')
    const ageMs = Date.now() - opts.since.getTime()
    expect(ageMs).toBeGreaterThanOrEqual(7 * DAY_MS)
    expect(ageMs).toBeLessThan(7 * DAY_MS + 60_000)
    // The probe filters in the store; the session is never loaded.
    expect(h.getBySession).not.toHaveBeenCalled()
  })

  it('captures normally when the key has not been stored', async () => {
    const h = makeHarness()

    const out = await runCapture(h.deps, input({ key: 'commit-4f2a9c1' }))

    expect(out.outcome).toBe('stored')
    expect(h.findIdByCaptureKey).toHaveBeenCalledOnce()
  })

  it('does not look up the session without a key', async () => {
    const h = makeHarness()

    await runCapture(h.deps, input())

    expect(h.findIdByCaptureKey).not.toHaveBeenCalled()
  })
})
