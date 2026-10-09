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
import { ItemConstraintError } from '../../src/items/item-store.js'
import { EXTRACTOR_VERSION } from '../../src/extraction/prompt.js'
import {
  EXTRACTION_HELD_FAILURES_MAX,
  EXTRACTION_PROBE_LABEL,
  EXTRACTION_STALE_RUN_MS,
  EXTRACTION_TRANSIENT_FAILURES_MAX,
  EXTRACTION_WINDOWS_PER_TICK,
  runExtractionTick,
  SESSION_IDLE_MS,
  type ExtractionStore,
  type ExtractionTickResult,
} from '../../src/extraction/run.js'
import type { RawExtractionWindow } from '../../src/extraction/window.js'
import { FACT_EXTRACTION_BACKOFF_MAX_MS, factExtractionBackoffMs } from '../../src/utils/backoff.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T0 = Date.parse('2026-10-01T09:00:00Z')
const PRIVATE_TEXT = 'Use TST-77 for the capture route work.'
const MAX_HELD = 3
const MAX_TRANSIENT = 6

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
  counted: boolean | null
  error: string | null
  stats: Record<string, unknown>
}

/**
 * Holds anchors and runs and hands out pending anchors by the pending RPC's
 * rules: per session the earliest anchor with no succeeded run, fewer than
 * three counted held and fewer than six counted transient failures at the
 * version, only once the backoff for its failure count (every failure,
 * counted or not) has passed since its last failure; sessions oldest first.
 */
class FakeStore implements ExtractionStore {
  readonly anchors: FakeAnchor[] = []
  readonly runs: FakeRun[] = []
  readonly commits: Array<{ anchorId: string; commit: ExtractionCommit }> = []
  readonly calls: string[] = []
  /** The error the commit of an anchor's run throws, if any. */
  commitError: ((anchorId: string) => Error | null) | null = null
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
      counted: null,
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

  failedRuns(anchorId: string, version: string): FakeRun[] {
    return this.runs.filter((r) => r.anchorId === anchorId && r.version === version && r.status === 'failed')
  }

  heldFailures(anchorId: string, version: string): FakeRun[] {
    return this.failedRuns(anchorId, version).filter((r) => r.failure === 'held' && r.counted === true)
  }

  transientFailures(anchorId: string, version: string): FakeRun[] {
    return this.failedRuns(anchorId, version).filter((r) => r.failure === 'transient' && r.counted === true)
  }

  uncountedFailures(anchorId: string, version: string): FakeRun[] {
    return this.failedRuns(anchorId, version).filter((r) => r.counted !== true)
  }

  async extractionPending(query: ExtractionPendingQuery): Promise<PendingAnchor[]> {
    this.calls.push('pending')
    expect(query.version).toBe(EXTRACTOR_VERSION)
    expect(query.idleMs).toBe(SESSION_IDLE_MS)
    const open = this.anchors
      .filter((a) => {
        const runs = this.runsOf(a.id).filter((r) => r.version === query.version)
        return (
          !runs.some((r) => r.status === 'succeeded') &&
          this.heldFailures(a.id, query.version).length < MAX_HELD &&
          this.transientFailures(a.id, query.version).length < MAX_TRANSIENT
        )
      })
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
    const firstPerSession = new Map<string, FakeAnchor>()
    for (const anchor of open) if (!firstPerSession.has(anchor.sessionId)) firstPerSession.set(anchor.sessionId, anchor)
    const due = [...firstPerSession.values()].filter((a) => {
      const failed = this.failedRuns(a.id, query.version)
      if (failed.length === 0) return true
      const last = Math.max(...failed.map((r) => (r.finishedAt ?? r.startedAt).getTime()))
      return query.now.getTime() >= last + factExtractionBackoffMs(failed.length)
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
          failures: this.failedRuns(a.id, query.version).length,
          heldFailures: this.heldFailures(a.id, query.version).length,
          transientFailures: this.transientFailures(a.id, query.version).length,
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
    this.calls.push(`fail ${runId} ${failure.failure}${failure.counted ? ' counted' : ''}`)
    const run = this.runs.find((r) => r.id === runId)
    if (!run || run.status !== 'running') return false
    Object.assign(run, {
      status: 'failed',
      finishedAt: new Date(this.clock.now),
      failure: failure.failure,
      counted: failure.counted,
      error: failure.error,
      stats: { ...failure.stats, failure: failure.failure, counted: failure.counted },
    })
    return true
  }

  async extractionCommit(runId: string, commit: ExtractionCommit): Promise<ExtractionCommitResult> {
    this.calls.push(`commit ${runId}`)
    const run = this.runs.find((r) => r.id === runId)!
    const refused = this.commitError?.(run.anchorId)
    if (refused) throw refused
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
/** Answers each request by what it renders, e.g. by a marker in the anchor's text. */
type Responder = (req: CompleteJsonRequest) => Reply

const PROBE_ANSWER: Reply = { text: '{"ok":true}' }
const down = (): Error => Object.assign(new Error('upstream unavailable'), { status: 503 })
const badRequest = (): Error => Object.assign(new Error('bad request'), { status: 400 })

/**
 * A store error as the PostgREST store builds one: the SQLSTATE or PGRST code
 * rides as `code`, and a failure with no code (fetch failed) carries none.
 */
function storeError(operation: string, code: string, message: string): Error {
  const err = new Error(`${operation} failed (${code || 'unknown'}): ${message}`)
  return code ? Object.assign(err, { code }) : err
}

/** A refused item rule as the PostgREST store builds it for class 23. */
function ruleError(code: string, constraint: string): Error {
  return Object.assign(new ItemConstraintError(constraint, `violates constraint "${constraint}"`), { code })
}

/**
 * Window calls are answered by `replies` (a list consumed in order, then
 * EMPTY_LISTS); a probe is answered by `probe`, never from the list.
 */
function adapter(replies: Reply[] | Responder, probe: () => Reply) {
  const requests: CompleteJsonRequest[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      requests.push(req)
      const isProbe = req.label === EXTRACTION_PROBE_LABEL
      const next = isProbe
        ? probe()
        : typeof replies === 'function'
          ? replies(req)
          : replies.length > 0
            ? replies.shift()!
            : { text: EMPTY_LISTS }
      if (next instanceof Error) throw next
      return { text: '', finishReason: 'stop', model: 'tst-model', ...next }
    },
  }
  return { intelligence, requests }
}

const isProbeRequest = (req: CompleteJsonRequest): boolean => req.label === EXTRACTION_PROBE_LABEL
const windowRequests = (requests: CompleteJsonRequest[]): CompleteJsonRequest[] =>
  requests.filter((r) => !isProbeRequest(r))

function setup(replies: Reply[] | Responder = [], probe: () => Reply = () => PROBE_ANSWER) {
  const clock = { now: T0 }
  const store = new FakeStore(clock)
  const { intelligence, requests } = adapter(replies, probe)
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
  it('fails an empty reply as transient, backs its anchor off and goes on to the next session', async () => {
    const { clock, store, requests, logs, tick } = setup([{ text: '  ' }])
    const first = store.addAnchor('tst-session-1', T0 - 2 * 60_000)
    const second = store.addAnchor('tst-session-2', T0 - 60_000)

    const result = await tick()

    expect(requests).toHaveLength(2)
    expect(requests.filter(isProbeRequest)).toEqual([])
    expect(store.runsOf(first.id)).toMatchObject([
      { status: 'failed', failure: 'transient', counted: true, model: 'tst-chat-model' },
    ])
    expect(store.runsOf(first.id)[0]!.stats).toMatchObject({ failure: 'transient', counted: true })
    expect(store.heldFailures(first.id, EXTRACTOR_VERSION)).toHaveLength(0)
    expect(store.commits.map((c) => c.anchorId)).toEqual([second.id])
    expect(result).toEqual({ windows: 2, succeeded: 1, held: 0, transient: 1, full: false })
    expect(await store.extractionPending(pendingQuery(clock.now + factExtractionBackoffMs(1) - 1))).toEqual([])
    expect(await store.extractionPending(pendingQuery(clock.now + factExtractionBackoffMs(1)))).toMatchObject([
      { anchorId: first.id, failures: 1, heldFailures: 0, transientFailures: 1 },
    ])
    expect(logs.join('\n')).not.toContain(PRIVATE_TEXT)
  })

  it.each([
    ['a moderated reply with no content', (): Reply => ({ text: '', finishReason: 'content_filter' })],
    ['a 403 flagged refusal', (): Reply => Object.assign(new Error('flagged by moderation'), { status: 403 })],
  ])('extracts other sessions past an anchor answered with %s, which waits out its backoff', async (_name, refuse) => {
    const { clock, store, requests, tick } = setup((req) =>
      req.user.includes('MODERATED') ? refuse() : { text: statementReply('Use TST-77') },
    )
    const moderated = store.addAnchor('tst-session-1', T0 - 4 * 60_000, 'MODERATED: Use TST-77 here.')
    const behind = store.addAnchor('tst-session-1', T0 - 60_000)
    const other = store.addAnchor('tst-session-2', T0 - 3 * 60_000)
    const third = store.addAnchor('tst-session-3', T0 - 2 * 60_000)

    const first = await tick()
    expect(first).toMatchObject({ windows: 3, succeeded: 2, transient: 1 })
    expect(store.commits.map((c) => c.anchorId)).toEqual([other.id, third.id])
    expect(store.runsOf(moderated.id)).toMatchObject([{ failure: 'transient', counted: true }])
    const failedAt = clock.now

    // Inside the backoff nothing runs: the session's later anchor waits for it.
    clock.now = failedAt + factExtractionBackoffMs(1) - 1000
    await tick()
    expect(windowRequests(requests)).toHaveLength(3)
    expect(store.runsOf(behind.id)).toHaveLength(0)

    clock.now = failedAt + factExtractionBackoffMs(1)
    await tick()
    expect(windowRequests(requests)).toHaveLength(4)
    expect(store.transientFailures(moderated.id, EXTRACTOR_VERSION)).toHaveLength(2)
    expect(store.runsOf(behind.id)).toHaveLength(0)
  })

  it('ends the tick on an outage: an unanswered call whose probe goes unanswered too backs off uncounted', async () => {
    const { clock, store, requests, logs, tick } = setup(down, down)
    const anchors = Array.from({ length: 6 }, (_, i) => store.addAnchor(`tst-session-${i}`, T0 - (10 - i) * 60_000))
    const first = anchors[0]!

    const result = await tick()

    expect(requests.map(isProbeRequest)).toEqual([false, true])
    expect(requests[1]!.maxTokens).toBeLessThanOrEqual(16)
    expect(result).toEqual({ windows: 1, succeeded: 0, held: 0, transient: 1, full: false })
    expect(store.runsOf(first.id)).toMatchObject([{ status: 'failed', failure: 'transient', counted: false }])
    expect(logs.some((l) => /probe/.test(l) && /tick ends/.test(l))).toBe(true)
    expect(logs.some((l) => l.includes('exhausted'))).toBe(false)
    expect(await store.extractionPending(pendingQuery(clock.now + factExtractionBackoffMs(1)))).toContainEqual(
      expect.objectContaining({ anchorId: first.id, failures: 1, heldFailures: 0, transientFailures: 0 }),
    )
  })

  it('counts an unanswered call whose probe is answered as the window\'s own, and goes on', async () => {
    const { store, requests, tick } = setup((req) => (req.user.includes('FLAKY') ? down() : { text: EMPTY_LISTS }))
    const flaky = store.addAnchor('tst-session-1', T0 - 4 * 60_000, 'FLAKY one')
    store.addAnchor('tst-session-2', T0 - 3 * 60_000, 'steady one')
    const flakyTwo = store.addAnchor('tst-session-3', T0 - 2 * 60_000, 'FLAKY two')
    store.addAnchor('tst-session-4', T0 - 60_000, 'steady two')

    const result = await tick()

    expect(windowRequests(requests)).toHaveLength(4)
    expect(requests.filter(isProbeRequest)).toHaveLength(2)
    expect(result).toMatchObject({ windows: 4, succeeded: 2, transient: 2 })
    for (const anchor of [flaky, flakyTwo]) {
      expect(store.runsOf(anchor.id)).toMatchObject([{ failure: 'transient', counted: true }])
    }
  })

  it('exhausts no anchor over an 8-tick outage of calls and probes, then extracts every anchor', async () => {
    let outage = true
    const { clock, store, requests, logs, tick } = setup(
      () => (outage ? down() : { text: EMPTY_LISTS }),
      () => (outage ? down() : PROBE_ANSWER),
    )
    const anchors: string[] = []
    for (let s = 0; s < 3; s++) {
      for (let a = 0; a < 2; a++) anchors.push(store.addAnchor(`tst-session-${s}`, T0 - (10 - s - a * 3) * 60_000).id)
    }

    for (let i = 0; i < 8; i++) {
      clock.now += FACT_EXTRACTION_BACKOFF_MAX_MS + 1000
      const before = requests.length
      await tick()
      expect(requests.length - before, `outage tick ${i}`).toBeLessThanOrEqual(2)
    }
    expect(anchors.flatMap((id) => store.transientFailures(id, EXTRACTOR_VERSION))).toEqual([])
    expect(anchors.flatMap((id) => store.uncountedFailures(id, EXTRACTOR_VERSION))).toHaveLength(8)

    outage = false
    clock.now += FACT_EXTRACTION_BACKOFF_MAX_MS + 1000
    await tick()

    expect(new Set(store.commits.map((c) => c.anchorId))).toEqual(new Set(anchors))
    expect(logs.some((l) => l.includes('exhausted'))).toBe(false)
  })

  it.each([
    ['a 503', (): Reply => down()],
    ['a 403 flagged refusal', (): Reply => Object.assign(new Error('flagged by moderation'), { status: 403 })],
  ])('exhausts a window answered with %s on every call at its sixth counted failure while the probe is answered', async (_name, refuse) => {
    const { clock, store, requests, logs, tick } = setup((req) =>
      req.user.includes('REFUSED') ? refuse() : { text: EMPTY_LISTS },
    )
    const stuck = store.addAnchor('tst-session-1', T0 - 2 * 60_000, 'REFUSED: Use TST-77 here.')
    const next = store.addAnchor('tst-session-1', T0 - 60_000)

    for (let n = 1; n <= MAX_TRANSIENT; n++) {
      await tick()
      expect(store.transientFailures(stuck.id, EXTRACTOR_VERSION)).toHaveLength(n)
      if (n < MAX_TRANSIENT) expect(logs.filter((l) => l.includes('exhausted'))).toEqual([])
      clock.now += factExtractionBackoffMs(n)
    }

    expect(requests.filter(isProbeRequest)).toHaveLength(MAX_TRANSIENT)
    expect(store.commits.map((c) => c.anchorId)).toEqual([next.id])
    const exhausted = logs.filter((l) => l.includes('exhausted'))
    expect(exhausted).toEqual([expect.stringContaining(`anchor=${stuck.id.slice(0, 8)}`)])
    expect(exhausted[0]).toContain('transient=6')
  })

  it('names no anchor exhausted when the failure that would reach the limit is an uncounted outage', async () => {
    const { clock, store, logs, tick } = setup(down, down)
    const anchor = store.addAnchor('tst-session-1', T0 - 60 * 60_000)
    for (let i = 0; i < MAX_TRANSIENT - 1; i++) {
      store.addRun(anchor.id, {
        status: 'failed',
        failure: 'transient',
        counted: true,
        startedAt: new Date(T0 - 50 * 60_000),
        finishedAt: new Date(T0 - 50 * 60_000),
      })
    }
    clock.now = T0 + FACT_EXTRACTION_BACKOFF_MAX_MS

    await tick()

    expect(store.uncountedFailures(anchor.id, EXTRACTOR_VERSION)).toHaveLength(1)
    expect(store.transientFailures(anchor.id, EXTRACTOR_VERSION)).toHaveLength(MAX_TRANSIENT - 1)
    expect(logs.some((l) => l.includes('exhausted'))).toBe(false)
  })

  it.each([
    ['a fetch failure', storeError('extractionWindow', '', 'TypeError: fetch failed')],
    ['PGRST001', storeError('extractionWindow', 'PGRST001', 'Database client error. Retrying the connection.')],
    ['57014', storeError('extractionWindow', '57014', 'canceling statement due to statement timeout')],
  ])('counts nothing and ends the tick without a model call when the window read fails with %s, then extracts the anchor', async (_name, err) => {
    const { clock, store, requests, logs, tick } = setup()
    const first = store.addAnchor('tst-session-1', T0 - 2 * 60_000)
    const second = store.addAnchor('tst-session-2', T0 - 60_000)
    const read = store.extractionWindow.bind(store)
    let failing = true
    store.extractionWindow = async (anchorId: string) => {
      if (failing) throw err
      return read(anchorId)
    }

    const result = await tick()

    expect(requests).toEqual([])
    expect(store.runsOf(first.id)).toMatchObject([{ status: 'failed', failure: 'transient', counted: false }])
    expect(store.runsOf(second.id)).toEqual([])
    expect(result).toMatchObject({ windows: 1, succeeded: 0, held: 0 })
    expect(logs.some((l) => /store/.test(l) && /tick ends/.test(l))).toBe(true)

    failing = false
    clock.now += factExtractionBackoffMs(1)
    await tick()
    expect(store.commits.map((c) => c.anchorId)).toEqual([first.id, second.id])
  })

  it('holds and counts a window that cannot be built from what the store returned, without a model call', async () => {
    const { store, requests, tick } = setup()
    const broken = store.addAnchor('tst-session-1', T0 - 2 * 60_000)
    const other = store.addAnchor('tst-session-2', T0 - 60_000)
    const read = store.extractionWindow.bind(store)
    store.extractionWindow = async (anchorId: string) => {
      const raw = await read(anchorId)
      return anchorId === broken.id ? ({ ...raw, anchor: null } as unknown as RawExtractionWindow) : raw
    }

    const result = await tick()

    expect(store.runsOf(broken.id)).toMatchObject([{ status: 'failed', failure: 'held', counted: true }])
    expect(windowRequests(requests)).toHaveLength(1)
    expect(requests.filter(isProbeRequest)).toEqual([])
    expect(store.commits.map((c) => c.anchorId)).toEqual([other.id])
    expect(result).toMatchObject({ windows: 2, held: 1, succeeded: 1 })
  })

  it('counts nothing and ends the tick when the commit fails with 57014, then extracts the anchor', async () => {
    const { clock, store, requests, logs, tick } = setup()
    const first = store.addAnchor('tst-session-1', T0 - 2 * 60_000)
    const second = store.addAnchor('tst-session-2', T0 - 60_000)
    store.commitError = () => storeError('extractionCommit', '57014', 'canceling statement due to statement timeout')

    const result = await tick()

    expect(store.runsOf(first.id)).toMatchObject([{ status: 'failed', failure: 'transient', counted: false }])
    expect(store.runsOf(second.id)).toEqual([])
    expect(windowRequests(requests)).toHaveLength(1)
    expect(requests.filter(isProbeRequest)).toEqual([])
    expect(result).toMatchObject({ windows: 1, succeeded: 0, held: 0 })
    expect(logs.some((l) => /store/.test(l) && /tick ends/.test(l))).toBe(true)

    store.commitError = null
    clock.now += factExtractionBackoffMs(1)
    await tick()
    expect(store.commits.map((c) => c.anchorId)).toEqual([first.id, second.id])
  })

  it.each([
    ['22023', (): Error => storeError('extractionCommit', '22023', 'engram_extraction_commit: item 1 names no subject')],
    ['23505', (): Error => ruleError('23505', 'idx_items_event_key')],
  ])('holds a commit the store refused with %s, exhausts the anchor at its third, and runs the session\'s next anchor', async (_code, refuse) => {
    const { clock, store, requests, logs, tick } = setup()
    const stuck = store.addAnchor('tst-session-1', T0 - 2 * 60_000)
    const next = store.addAnchor('tst-session-1', T0 - 60_000)
    store.commitError = (anchorId) => (anchorId === stuck.id ? refuse() : null)

    for (let n = 1; n <= MAX_HELD; n++) {
      await tick()
      expect(store.heldFailures(stuck.id, EXTRACTOR_VERSION)).toHaveLength(n)
      if (n < MAX_HELD) {
        expect(store.commits).toEqual([])
        expect(logs.filter((l) => l.includes('exhausted'))).toEqual([])
      }
      clock.now += factExtractionBackoffMs(n)
    }

    expect(requests.filter(isProbeRequest)).toEqual([])
    expect(store.commits.map((c) => c.anchorId)).toEqual([next.id])
    const exhausted = logs.filter((l) => l.includes('exhausted'))
    expect(exhausted).toEqual([expect.stringContaining(`anchor=${stuck.id.slice(0, 8)}`)])
    expect(exhausted[0]).toContain('held=3')
  })

  it('counts a 503 whose probe is refused with a 400, and exhausts the window at its sixth failure', async () => {
    const { clock, store, requests, logs, tick } = setup(
      (req) => (req.user.includes('REFUSED') ? down() : { text: EMPTY_LISTS }),
      badRequest,
    )
    const stuck = store.addAnchor('tst-session-1', T0 - 2 * 60_000, 'REFUSED: Use TST-77 here.')
    const next = store.addAnchor('tst-session-1', T0 - 60_000)

    for (let n = 1; n <= MAX_TRANSIENT; n++) {
      await tick()
      expect(store.transientFailures(stuck.id, EXTRACTOR_VERSION)).toHaveLength(n)
      if (n < MAX_TRANSIENT) expect(logs.filter((l) => l.includes('exhausted'))).toEqual([])
      clock.now += factExtractionBackoffMs(n)
    }

    expect(requests.filter(isProbeRequest)).toHaveLength(MAX_TRANSIENT)
    expect(store.uncountedFailures(stuck.id, EXTRACTOR_VERSION)).toEqual([])
    expect(store.commits.map((c) => c.anchorId)).toEqual([next.id])
    const exhausted = logs.filter((l) => l.includes('exhausted'))
    expect(exhausted).toEqual([expect.stringContaining(`anchor=${stuck.id.slice(0, 8)}`)])
    expect(exhausted[0]).toContain('transient=6')
  })

  it.each([
    ['answered', (): Reply => PROBE_ANSWER, true],
    ['refused with a 400', badRequest, true],
    ['unanswered with a 503', down, false],
    ['failed with no status', (): Reply => new Error('socket hang up'), false],
  ])('lets the probe decide a window call that failed with no status: probe %s', async (_name, probe, counted) => {
    const { store, requests, tick } = setup(
      (req) => (req.user.includes('ODD') ? new Error('the adapter broke') : { text: EMPTY_LISTS }),
      probe,
    )
    const odd = store.addAnchor('tst-session-1', T0 - 2 * 60_000, 'ODD one')
    const other = store.addAnchor('tst-session-2', T0 - 60_000)

    await tick()

    expect(requests.map(isProbeRequest)).toEqual(counted ? [false, true, false] : [false, true])
    expect(store.runsOf(odd.id)).toMatchObject([{ status: 'failed', failure: 'held', counted }])
    expect(store.commits.map((c) => c.anchorId)).toEqual(counted ? [other.id] : [])
  })

  it.each([
    ['an unreadable reply', (): Reply[] => [{ text: 'not json' }]],
    [
      'a refused commit',
      (store: FakeStore): Reply[] => {
        store.commitError = () => ruleError('23514', 'memory_items_content_check')
        return []
      },
    ],
    [
      'a window that cannot be built',
      (store: FakeStore): Reply[] => {
        store.extractionWindow = async () => ({ anchor: null }) as unknown as RawExtractionWindow
        return []
      },
    ],
  ])('names no anchor exhausted when %s reaches the limit but closed no run', async (_name, arrange) => {
    const replies: Reply[] = []
    const { clock, store, logs, tick } = setup(replies)
    replies.push(...arrange(store))
    const anchor = store.addAnchor('tst-session-1', T0 - 60 * 60_000)
    for (let i = 0; i < MAX_HELD - 1; i++) {
      store.addRun(anchor.id, {
        status: 'failed',
        failure: 'held',
        counted: true,
        startedAt: new Date(T0 - 50 * 60_000),
        finishedAt: new Date(T0 - 50 * 60_000),
      })
    }
    // Another process closed the run first, so this close changed nothing.
    store.extractionFail = async () => false
    clock.now = T0 + FACT_EXTRACTION_BACKOFF_MAX_MS

    await tick()

    expect(logs.some((l) => l.includes('status=held'))).toBe(true)
    expect(logs.some((l) => l.includes('exhausted'))).toBe(false)
  })

  it('exhausts a lone session\'s moderated anchor at its sixth failure, logs it, and runs the session\'s next anchor', async () => {
    const { clock, store, requests, logs, tick } = setup((req) =>
      req.user.includes('MODERATED') ? { text: '', finishReason: 'content_filter' } : { text: EMPTY_LISTS },
    )
    const stuck = store.addAnchor('tst-session-1', T0 - 2 * 60_000, 'MODERATED: Use TST-77 here.')
    const next = store.addAnchor('tst-session-1', T0 - 60_000)

    for (let n = 1; n <= MAX_TRANSIENT; n++) {
      await tick()
      expect(store.transientFailures(stuck.id, EXTRACTOR_VERSION)).toHaveLength(n)
      if (n < MAX_TRANSIENT) expect(store.commits).toEqual([])
      clock.now += factExtractionBackoffMs(n)
    }
    // A moderated reply is the provider's answer, so no probe is needed.
    expect(requests.filter(isProbeRequest)).toEqual([])

    expect(store.commits.map((c) => c.anchorId)).toEqual([next.id])
    const exhausted = logs.filter((l) => l.includes('exhausted'))
    expect(exhausted).toEqual([expect.stringContaining(`anchor=${stuck.id.slice(0, 8)}`)])
    expect(exhausted[0]).toContain('transient=6')
    expect(EXTRACTION_TRANSIENT_FAILURES_MAX).toBe(MAX_TRANSIENT)
    expect(EXTRACTION_HELD_FAILURES_MAX).toBe(MAX_HELD)
  })

  it('holds an unparseable reply, exhausts the anchor at its third failure, then runs the next anchor', async () => {
    const { clock, store, requests, logs, tick } = setup([
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
    expect(store.runsOf(stuck.id).every((r) => r.stats['failure'] === 'held' && r.stats['counted'] === true)).toBe(true)
    expect(requests.filter(isProbeRequest)).toEqual([])
    expect(third).toMatchObject({ windows: 2, held: 1, succeeded: 1 })
    expect(store.commits.map((c) => c.anchorId)).toEqual([next.id])
    expect(requests).toHaveLength(4)
    const exhausted = logs.filter((l) => l.includes('exhausted'))
    expect(exhausted).toEqual([expect.stringContaining(`anchor=${stuck.id.slice(0, 8)}`)])
    expect(exhausted[0]).toContain('held=3')
  })

  it('holds a reply cut off at its token cap and a refused commit', async () => {
    const { clock, store, tick } = setup([{ text: '{"statements":[', finishReason: 'length' }])
    const anchor = store.addAnchor('tst-session-1', T0 - 60_000)

    await tick()
    expect(store.runsOf(anchor.id)[0]).toMatchObject({ status: 'failed', failure: 'held' })
    expect(store.runsOf(anchor.id)[0]!.stats).toMatchObject({ finish_reason: 'length', anchor_kind: 'user_prompt' })

    store.commitError = () => ruleError('23514', 'memory_items_content_check')
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

  it('closes a stale running run as transient and runs the anchor after its backoff; a live run is left alone', async () => {
    const { clock, store, requests, tick } = setup()
    const stale = store.addAnchor('tst-session-1', T0 - 30 * 60_000)
    const live = store.addAnchor('tst-session-2', T0 - 20 * 60_000)
    const staleRun = store.addRun(stale.id, { startedAt: new Date(T0 - EXTRACTION_STALE_RUN_MS) })
    const liveRun = store.addRun(live.id, { startedAt: new Date(T0 - EXTRACTION_STALE_RUN_MS + 60_000) })

    const result = await tick()

    expect(staleRun).toMatchObject({ status: 'failed', failure: 'transient', counted: true })
    expect(store.heldFailures(stale.id, EXTRACTOR_VERSION)).toHaveLength(0)
    expect(store.runsOf(stale.id)).toHaveLength(1)
    expect(liveRun.status).toBe('running')
    expect(store.runsOf(live.id)).toHaveLength(1)
    expect(requests).toHaveLength(0)
    expect(result).toMatchObject({ windows: 0 })

    clock.now += factExtractionBackoffMs(1)
    await tick()
    expect(store.commits.map((c) => c.anchorId)).toEqual([stale.id])
    expect(requests).toHaveLength(1)
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

  it('fails a provider fault by its class: a 5xx is transient after a probe, a 400 is held without one', async () => {
    const serverError = Object.assign(new Error('upstream'), { status: 503 })
    const badRequest = Object.assign(new Error('bad request'), { status: 400 })
    const { clock, store, requests, tick } = setup([serverError, badRequest])
    const anchor = store.addAnchor('tst-session-1', T0 - 60_000)

    await tick()
    clock.now += factExtractionBackoffMs(1)
    await tick()

    expect(store.runsOf(anchor.id).map((r) => [r.failure, r.counted])).toEqual([
      ['transient', true],
      ['held', true],
    ])
    expect(requests.map(isProbeRequest)).toEqual([false, true, false])
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

type Behavior = 'good' | 'moderated' | 'unanswered' | 'held'
const BEHAVIORS: Behavior[] = ['good', 'moderated', 'unanswered', 'held']
const PROPERTY_SEEDS = 50

/** A small deterministic PRNG, so each seed replays the same scenario. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function runSeededScenario(seed: number): Promise<void> {
  const random = mulberry32(seed)
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1))
  let outage = false
  const { clock, store, requests, tick } = setup(
    (req) => {
      if (outage) return down()
      if (req.user.includes('[moderated]')) return { text: '', finishReason: 'content_filter' }
      if (req.user.includes('[unanswered]')) return down()
      if (req.user.includes('[held]')) return { text: 'not json' }
      return { text: EMPTY_LISTS }
    },
    () => (outage ? down() : PROBE_ANSWER),
  )
  const behaviorOf = new Map<string, Behavior>()
  const sessions = int(1, 4)
  for (let s = 0; s < sessions; s++) {
    const anchors = int(1, 3)
    for (let a = 0; a < anchors; a++) {
      const behavior = BEHAVIORS[int(0, BEHAVIORS.length - 1)]!
      const anchor = store.addAnchor(`tst-session-${s}`, T0 - int(1, 600) * 60_000, `[${behavior}] request ${s}.${a}`)
      behaviorOf.set(anchor.id, behavior)
    }
  }
  const good = [...behaviorOf].filter(([, b]) => b === 'good').map(([id]) => id)
  const bad = behaviorOf.size - good.length
  const context = `seed ${seed}: ${sessions} sessions, ${behaviorOf.size} anchors, ${bad} bad`

  const outageTicks = int(0, 8)
  outage = true
  for (let i = 0; i < outageTicks; i++) {
    clock.now += FACT_EXTRACTION_BACKOFF_MAX_MS + 1000
    const before = requests.length
    await tick()
    expect(requests.length - before, `${context}, outage tick ${i}`).toBeLessThanOrEqual(2)
  }
  outage = false

  const tickLimit = bad * 7 + 2
  for (let i = 0; i < tickLimit; i++) {
    clock.now += FACT_EXTRACTION_BACKOFF_MAX_MS + 1000
    await tick()
  }
  const committed = new Set(store.commits.map((c) => c.anchorId))
  expect(good.filter((id) => !committed.has(id)), `${context}: good anchors left after ${tickLimit} ticks`).toEqual([])

  // A run begun on an anchor never starts inside the backoff its earlier
  // failures set.
  for (const anchorId of behaviorOf.keys()) {
    const runs = store.runsOf(anchorId)
    runs.forEach((run, i) => {
      const failed = runs.slice(0, i).filter((r) => r.status === 'failed')
      if (failed.length === 0) return
      const last = Math.max(...failed.map((r) => r.finishedAt!.getTime()))
      expect(run.startedAt.getTime(), `${context}: run ${i} of ${anchorId}`).toBeGreaterThanOrEqual(
        last + factExtractionBackoffMs(failed.length),
      )
    })
  }
}

describe('runExtractionTick over seeded failure mixes', () => {
  it('extracts every good anchor within bad × 7 + 2 ticks of an outage, with two calls per outage tick at most', async () => {
    for (let seed = 1; seed <= PROPERTY_SEEDS; seed++) await runSeededScenario(seed)
  })
})
