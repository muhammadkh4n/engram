import { describe, it, expect } from 'vitest'

import type { CompleteJsonRequest, CompleteJsonResult, IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type {
  ExtractionBegin,
  ExtractionCommit,
  ExtractionCommitResult,
  ExtractionFailure,
  ExtractionPendingQuery,
  PendingAnchor,
} from '../../src/items/capture-store.js'
import { EXTRACTOR_VERSION } from '../../src/extraction/prompt.js'
import {
  EXTRACTION_STALE_RUN_MS,
  EXTRACTION_WINDOWS_PER_TICK,
  runExtractionTick,
  SESSION_IDLE_MS,
  type ExtractionStore,
  type ExtractionTickResult,
} from '../../src/extraction/run.js'
import type { RawExtractionWindow } from '../../src/extraction/window.js'
import { factExtractionBackoffMs } from '../../src/utils/backoff.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T0 = Date.parse('2026-10-01T09:00:00Z')
const PRIVATE_TEXT = 'Use TST-77 for the capture route work.'
const MAX_HELD = 3

interface FakeAnchor {
  id: string
  sessionId: string
  occurredAt: Date
  content: string
}

interface FakeRun {
  id: string
  anchorId: string
  version: string
  model: string | null
  status: 'running' | 'succeeded' | 'failed'
  startedAt: Date
  finishedAt: Date | null
  failure: 'transient' | 'held' | null
  error: string | null
  stats: Record<string, unknown>
}

/**
 * Holds anchors and runs and hands out pending anchors by the window RPC's
 * rules: per session the earliest anchor with no succeeded run and fewer than
 * three held failures at the version, only once the backoff after its last
 * held failure has passed; sessions oldest first.
 */
class FakeStore implements ExtractionStore {
  readonly anchors: FakeAnchor[] = []
  readonly runs: FakeRun[] = []
  readonly commits: Array<{ anchorId: string; commit: ExtractionCommit }> = []
  readonly calls: string[] = []
  commitError: Error | null = null
  private nextRun = 1

  constructor(private readonly clock: { now: number }) {}

  addAnchor(sessionId: string, occurredAt: number, content = PRIVATE_TEXT): FakeAnchor {
    const anchor = { id: uuid(100 + this.anchors.length), sessionId, occurredAt: new Date(occurredAt), content }
    this.anchors.push(anchor)
    return anchor
  }

  addRun(anchorId: string, over: Partial<FakeRun>): FakeRun {
    const run: FakeRun = {
      id: uuid(500 + this.nextRun++),
      anchorId,
      version: EXTRACTOR_VERSION,
      model: null,
      status: 'running',
      startedAt: new Date(this.clock.now),
      finishedAt: null,
      failure: null,
      error: null,
      stats: {},
      ...over,
    }
    this.runs.push(run)
    return run
  }

  runsOf(anchorId: string): FakeRun[] {
    return this.runs.filter((r) => r.anchorId === anchorId)
  }

  heldFailures(anchorId: string, version: string): FakeRun[] {
    return this.runs.filter(
      (r) => r.anchorId === anchorId && r.version === version && r.status === 'failed' && r.failure === 'held',
    )
  }

  async extractionPending(query: ExtractionPendingQuery): Promise<PendingAnchor[]> {
    this.calls.push('pending')
    expect(query.version).toBe(EXTRACTOR_VERSION)
    expect(query.idleMs).toBe(SESSION_IDLE_MS)
    const open = this.anchors
      .filter((a) => {
        const runs = this.runsOf(a.id).filter((r) => r.version === query.version)
        return !runs.some((r) => r.status === 'succeeded') && this.heldFailures(a.id, query.version).length < MAX_HELD
      })
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
    const firstPerSession = new Map<string, FakeAnchor>()
    for (const anchor of open) if (!firstPerSession.has(anchor.sessionId)) firstPerSession.set(anchor.sessionId, anchor)
    const due = [...firstPerSession.values()].filter((a) => {
      const held = this.heldFailures(a.id, query.version)
      if (held.length === 0) return true
      const last = Math.max(...held.map((r) => (r.finishedAt ?? r.startedAt).getTime()))
      return query.now.getTime() >= last + factExtractionBackoffMs(held.length)
    })
    return due
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, query.limit)
      .map((a) => {
        const running = this.runsOf(a.id).find((r) => r.status === 'running' && r.version === query.version)
        return {
          anchorId: a.id,
          sessionId: a.sessionId,
          anchorKind: 'user_prompt',
          occurredAt: a.occurredAt,
          failures: this.heldFailures(a.id, query.version).length,
          runningRunId: running?.id ?? null,
          runningStartedAt: running?.startedAt ?? null,
        }
      })
  }

  async extractionWindow(anchorId: string): Promise<RawExtractionWindow | null> {
    this.calls.push(`window ${anchorId}`)
    const anchor = this.anchors.find((a) => a.id === anchorId)
    if (!anchor) return null
    return {
      anchor: {
        id: anchor.id,
        kind: 'user_prompt',
        session_id: anchor.sessionId,
        project_id: 'tst-repo',
        workspace_id: 'tst-ws',
        content: anchor.content,
        occurred_at: anchor.occurredAt.toISOString(),
        source: { event_key: `tst-key-${anchor.id}` },
      },
      anchor_event: { payload: {}, plan_dirs: [] },
      turn: null,
      observed: false,
      subjects: [],
      statements: [],
      observations: [],
      projects: [{ id: 'tst-repo', kind: 'project' }],
    }
  }

  async extractionBegin(run: ExtractionBegin): Promise<string | null> {
    this.calls.push(`begin ${run.anchorId}`)
    const blocking = this.runsOf(run.anchorId).some(
      (r) => r.version === run.version && (r.status === 'running' || r.status === 'succeeded'),
    )
    if (blocking) return null
    return this.addRun(run.anchorId, { version: run.version, model: run.model }).id
  }

  async extractionFail(runId: string, failure: ExtractionFailure): Promise<boolean> {
    this.calls.push(`fail ${runId} ${failure.failure}`)
    const run = this.runs.find((r) => r.id === runId)
    if (!run || run.status !== 'running') return false
    Object.assign(run, {
      status: 'failed',
      finishedAt: new Date(this.clock.now),
      failure: failure.failure,
      error: failure.error,
      stats: { ...failure.stats, failure: failure.failure },
    })
    return true
  }

  async extractionCommit(runId: string, commit: ExtractionCommit): Promise<ExtractionCommitResult> {
    this.calls.push(`commit ${runId}`)
    if (this.commitError) throw this.commitError
    const run = this.runs.find((r) => r.id === runId)!
    expect(run.status).toBe('running')
    Object.assign(run, { status: 'succeeded', finishedAt: new Date(this.clock.now), stats: commit.stats })
    this.commits.push({ anchorId: run.anchorId, commit })
    return { itemIds: commit.items.map((i) => i.id), subjectsCreated: commit.subjects.length, duplicates: 0 }
  }
}

const EMPTY_LISTS = '{"statements":[],"observations":[]}'

function statementReply(quote: string): string {
  return JSON.stringify({
    statements: [
      {
        utterance_id: 'utt-1',
        quote,
        question: null,
        kind: 'ruling',
        standing: false,
        scope: 'project',
        subject: { new: 'capture route' },
        applies_to: [],
        supersedes: [],
        restates: [],
        corrects: [],
      },
    ],
    observations: [],
  })
}

type Reply = Partial<CompleteJsonResult> | Error

function adapter(replies: Reply[], fallback: Reply = { text: EMPTY_LISTS }) {
  const requests: CompleteJsonRequest[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      requests.push(req)
      const next = replies.length > 0 ? replies.shift()! : fallback
      if (next instanceof Error) throw next
      return { text: '', finishReason: 'stop', model: 'tst-model', ...next }
    },
  }
  return { intelligence, requests }
}

function setup(replies: Reply[] = [], fallback?: Reply) {
  const clock = { now: T0 }
  const store = new FakeStore(clock)
  const { intelligence, requests } = adapter(replies, fallback)
  const logs: string[] = []
  const tick = (): Promise<ExtractionTickResult> =>
    runExtractionTick({
      store,
      intelligence,
      model: 'tst-chat-model',
      now: () => new Date(clock.now),
      log: (line) => logs.push(line),
    })
  return { clock, store, requests, logs, tick }
}

describe('runExtractionTick', () => {
  it('fails an empty reply as transient, counts nothing and stops the tick', async () => {
    const { store, requests, logs, tick } = setup([{ text: '  ' }])
    const first = store.addAnchor('tst-session-1', T0 - 2 * 60_000)
    store.addAnchor('tst-session-2', T0 - 60_000)

    const result = await tick()

    expect(requests).toHaveLength(1)
    expect(store.runsOf(first.id)).toMatchObject([{ status: 'failed', failure: 'transient', model: 'tst-chat-model' }])
    expect(store.heldFailures(first.id, EXTRACTOR_VERSION)).toHaveLength(0)
    expect(result).toEqual({ windows: 1, succeeded: 0, held: 0, transient: 1, full: false })
    expect((await store.extractionPending(pendingQuery(T0)))[0]!.failures).toBe(0)
    expect(logs.join('\n')).not.toContain(PRIVATE_TEXT)
  })

  it('holds an unparseable reply, exhausts the anchor at its third failure, then runs the next anchor', async () => {
    const { clock, store, requests, tick } = setup([
      { text: 'not json at all' },
      { text: 'still not json' },
      { text: '{"statements": [' },
      { text: statementReply('Use TST-77') },
    ])
    const stuck = store.addAnchor('tst-session-1', T0 - 2 * 60_000)
    const next = store.addAnchor('tst-session-1', T0 - 60_000)

    await tick()
    expect(store.heldFailures(stuck.id, EXTRACTOR_VERSION)).toHaveLength(1)
    expect(store.runsOf(next.id)).toHaveLength(0)

    clock.now += factExtractionBackoffMs(1)
    await tick()
    clock.now += factExtractionBackoffMs(2)
    const third = await tick()

    expect(store.heldFailures(stuck.id, EXTRACTOR_VERSION)).toHaveLength(3)
    expect(store.runsOf(stuck.id).every((r) => r.stats['failure'] === 'held')).toBe(true)
    expect(third).toMatchObject({ windows: 2, held: 1, succeeded: 1 })
    expect(store.commits.map((c) => c.anchorId)).toEqual([next.id])
    expect(requests).toHaveLength(4)
  })

  it('holds a reply cut off at its token cap and a refused commit', async () => {
    const { clock, store, tick } = setup([{ text: '{"statements":[', finishReason: 'length' }])
    const anchor = store.addAnchor('tst-session-1', T0 - 60_000)

    await tick()
    expect(store.runsOf(anchor.id)[0]).toMatchObject({ status: 'failed', failure: 'held' })
    expect(store.runsOf(anchor.id)[0]!.stats).toMatchObject({ finish_reason: 'length', anchor_kind: 'user_prompt' })

    store.commitError = new Error('refused')
    clock.now += factExtractionBackoffMs(1)
    await tick()
    expect(store.runsOf(anchor.id)[1]).toMatchObject({ status: 'failed', failure: 'held' })
    expect(store.heldFailures(anchor.id, EXTRACTOR_VERSION)).toHaveLength(2)
  })

  it('does not run a held anchor before its backoff has passed, and runs it after', async () => {
    const { clock, store, requests, tick } = setup([{ text: 'not json' }])
    const anchor = store.addAnchor('tst-session-1', T0 - 60_000)
    await tick()
    const failedAt = clock.now

    clock.now = failedAt + factExtractionBackoffMs(1) - 1000
    await tick()
    expect(requests).toHaveLength(1)

    clock.now = failedAt + factExtractionBackoffMs(1)
    await tick()
    expect(requests).toHaveLength(2)
    expect(store.commits.map((c) => c.anchorId)).toEqual([anchor.id])
  })

  it('commits the windows of one session in occurred_at order', async () => {
    const { store, tick } = setup()
    const third = store.addAnchor('tst-session-1', T0 - 60_000)
    const first = store.addAnchor('tst-session-1', T0 - 3 * 60_000)
    const second = store.addAnchor('tst-session-1', T0 - 2 * 60_000)

    await tick()

    expect(store.commits.map((c) => c.anchorId)).toEqual([first.id, second.id, third.id])
  })

  it('runs at most the per-tick budget of windows', async () => {
    const { store, tick } = setup()
    for (let i = 0; i < 25; i++) store.addAnchor(`tst-session-${i}`, T0 - (30 - i) * 60_000)

    const first = await tick()
    expect(first).toMatchObject({ windows: EXTRACTION_WINDOWS_PER_TICK, succeeded: 20, full: true })
    expect(store.commits).toHaveLength(20)

    const second = await tick()
    expect(second).toMatchObject({ windows: 5, succeeded: 5, full: false })
    expect(store.commits).toHaveLength(25)
  })

  it('closes a stale running run as transient and runs the anchor again; a live run is left alone', async () => {
    const { store, requests, tick } = setup()
    const stale = store.addAnchor('tst-session-1', T0 - 30 * 60_000)
    const live = store.addAnchor('tst-session-2', T0 - 20 * 60_000)
    const staleRun = store.addRun(stale.id, { startedAt: new Date(T0 - EXTRACTION_STALE_RUN_MS) })
    const liveRun = store.addRun(live.id, { startedAt: new Date(T0 - EXTRACTION_STALE_RUN_MS + 60_000) })

    const result = await tick()

    expect(staleRun).toMatchObject({ status: 'failed', failure: 'transient' })
    expect(store.heldFailures(stale.id, EXTRACTOR_VERSION)).toHaveLength(0)
    expect(store.commits.map((c) => c.anchorId)).toEqual([stale.id])
    expect(liveRun.status).toBe('running')
    expect(store.runsOf(live.id)).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect(result).toMatchObject({ windows: 1, succeeded: 1 })
  })

  it('stores the run with its rejection counts when the gate rejects every item', async () => {
    const reply = JSON.stringify({
      statements: [
        JSON.parse(statementReply('words MK never wrote')).statements[0],
        { utterance_id: 'utt-1' },
      ],
      observations: [
        {
          assistant_utterance_id: 'turn-1',
          claim: 'The route writes to Postgres.',
          kind: 'fact',
          subject: { new: 'capture route' },
          evidence: [],
          valid_at: null,
          supersedes: [],
        },
      ],
    })
    const { store, tick } = setup([{ text: reply }])
    const anchor = store.addAnchor('tst-session-1', T0 - 60_000)

    const result = await tick()

    expect(result).toMatchObject({ succeeded: 1 })
    expect(store.runsOf(anchor.id)).toMatchObject([{ status: 'succeeded' }])
    const { commit } = store.commits[0]!
    expect(commit.items).toEqual([])
    expect(commit.subjects).toEqual([])
    expect(commit.stats).toMatchObject({
      anchor_kind: 'user_prompt',
      finish_reason: 'stop',
      reply_model: 'tst-model',
      reply_chars: reply.length,
      statements: { proposed: 2, stored: 0, rejected: 2 },
      observations: { proposed: 1, stored: 0, rejected: 1, trust2: 0, trust3: 0 },
      rejected: [
        { item: 'statement', index: 0, rule: 'quote_not_found' },
        { item: 'statement', index: 1, rule: 'schema' },
        { item: 'observation', index: 0, rule: 'unknown_id' },
      ],
    })
    expect(typeof commit.stats['model_ms']).toBe('number')
    expect(commit.stats['prompt_chars']).toBeGreaterThan(0)
  })

  it('stores a ticket entity row for a statement naming TST-77', async () => {
    const { store, requests, logs, tick } = setup([{ text: statementReply('Use TST-77') }])
    store.addAnchor('tst-session-1', T0 - 60_000)

    await tick()

    const items = store.commits[0]!.commit.items
    expect(items).toHaveLength(1)
    expect(items[0]!.entities).toContainEqual({ entity: 'TST-77', entityType: 'ticket' })
    expect(requests[0]!.maxTokens).toBeGreaterThanOrEqual(800)
    expect(logs.some((l) => /status=succeeded statements=1 observations=0/.test(l))).toBe(true)
    expect(logs.join('\n')).not.toContain('TST-77')
  })

  it('fails a provider fault by its class: a 5xx is transient, a 400 is held', async () => {
    const serverError = Object.assign(new Error('upstream'), { status: 503 })
    const badRequest = Object.assign(new Error('bad request'), { status: 400 })
    const { clock, store, tick } = setup([serverError, badRequest])
    const anchor = store.addAnchor('tst-session-1', T0 - 60_000)

    await tick()
    clock.now += 1000
    await tick()

    expect(store.runsOf(anchor.id).map((r) => r.failure)).toEqual(['transient', 'held'])
  })

  it('logs once and does nothing when the adapter has no completeJson', async () => {
    const store = new FakeStore({ now: T0 })
    store.addAnchor('tst-session-1', T0 - 60_000)
    const logs: string[] = []
    const deps = { store, intelligence: {}, model: 'tst-chat-model', log: (l: string) => logs.push(l) }

    expect(await runExtractionTick(deps)).toMatchObject({ windows: 0 })
    await runExtractionTick(deps)

    expect(logs).toHaveLength(1)
    expect(store.calls).toEqual([])
  })
})

function pendingQuery(now: number): ExtractionPendingQuery {
  return { version: EXTRACTOR_VERSION, limit: 100, idleMs: SESSION_IDLE_MS, now: new Date(now) }
}
