import { describe, expect, it } from 'vitest'
import {
  EXTRACTOR_VERSION,
  type CompleteJsonRequest,
  type ExtractionCommit,
  type ExtractionCommitResult,
  type ExtractionReplaceResult,
  type ExtractionSession,
  type IntelligenceAdapter,
  type RawExtractionWindow,
  type SessionAnchor,
} from '@engram-mem/core'
import {
  EXIT_CAPPED,
  EXIT_OK,
  EXIT_VERSION,
  UsageError,
  parseExtractArgs,
  runExtract,
  versionMismatch,
  type ExtractOptions,
  type ExtractStore,
} from '../src/ingest/extract-lib.js'
import { main } from '../src/ingest/engram-extract-cli.js'

const SESSION = 'tst-extract-session'
const EMPTY_REPLY = JSON.stringify({ statements: [], observations: [] })
const ANCHOR_A = '00000000-0000-4000-8000-00000000a001'
const ANCHOR_B = '00000000-0000-4000-8000-00000000a002'
const RETIRED = '00000000-0000-4000-8000-00000000a101'
const RESTORED = '00000000-0000-4000-8000-00000000a102'

function anchor(id: string, minute: number, succeeded = false): SessionAnchor {
  return { anchorId: id, anchorKind: 'user_prompt', occurredAt: new Date(Date.UTC(2026, 2, 2, 10, minute)), succeeded, runningRunId: null }
}

function rawWindow(id: string): RawExtractionWindow {
  return {
    anchor: {
      id,
      kind: 'user_prompt',
      session_id: SESSION,
      project_id: 'tst-repo',
      workspace_id: 'tst-ws',
      content: 'keep the cache on postgres',
      occurred_at: '2026-03-02T10:00:00Z',
      source: { type: 'transcript', event_key: `tst-key-${id.slice(-4)}` },
    },
    anchor_event: { payload: { text: 'keep the cache on postgres', transcript_line: 1 }, plan_dirs: [] },
    turns: [],
    subjects: [],
    statements: [],
    observations: [],
  } as unknown as RawExtractionWindow
}

/** Records every write; windows succeed in order as their commits land. */
class FakeStore implements ExtractStore {
  readonly writes: string[] = []
  readonly windowsRead: string[] = []
  private runs = 0

  constructor(
    private readonly sessions: ExtractionSession[],
    private readonly anchors: SessionAnchor[],
  ) {}

  async extractionSessions(): Promise<ExtractionSession[]> {
    return this.sessions
  }

  async extractionSessionAnchors(): Promise<SessionAnchor[]> {
    return this.anchors.map((a) => ({ ...a }))
  }

  async extractionWindow(anchorId: string): Promise<RawExtractionWindow | null> {
    this.windowsRead.push(anchorId)
    return rawWindow(anchorId)
  }

  async extractionCandidates(): Promise<never> {
    throw new Error('no item is proposed, so no candidate is read')
  }

  async extractionBegin(run: { anchorId: string }): Promise<string> {
    this.writes.push(`begin ${run.anchorId}`)
    this.runs += 1
    return `00000000-0000-4000-8000-0000000b000${this.runs}`
  }

  async extractionFail(runId: string): Promise<boolean> {
    this.writes.push(`fail ${runId}`)
    return true
  }

  async extractionCommit(runId: string, _commit: ExtractionCommit): Promise<ExtractionCommitResult> {
    this.writes.push(`commit ${runId}`)
    this.succeed(runId)
    return { itemIds: [], subjectsCreated: 0, duplicates: 0, restatements: 0, linksApplied: 0 }
  }

  async extractionReplace(runId: string, _commit: ExtractionCommit): Promise<ExtractionReplaceResult> {
    this.writes.push(`replace ${runId}`)
    this.succeed(runId)
    return {
      itemIds: [],
      subjectsCreated: 0,
      duplicates: 0,
      restatements: 0,
      linksApplied: 0,
      retired: [RETIRED],
      restored: [{ item: RESTORED, from: RETIRED, to: null }],
      keptRecorded: [],
      unrestated: 0,
    }
  }

  /** The run committed on the earliest window not yet succeeded, as the CLI runs them in order. */
  private succeed(_runId: string): void {
    const target = this.anchors.find((a) => !a.succeeded)
    if (target !== undefined) target.succeeded = true
  }
}

function intelligence(): { adapter: IntelligenceAdapter; requests: CompleteJsonRequest[] } {
  const requests: CompleteJsonRequest[] = []
  return {
    requests,
    adapter: {
      async completeJson(req) {
        requests.push(req)
        return { text: EMPTY_REPLY, finishReason: 'stop', model: 'tst-model' }
      },
    } as IntelligenceAdapter,
  }
}

function options(over: Partial<ExtractOptions> = {}): ExtractOptions {
  return { sessionId: SESSION, since: null, maxCalls: 10, version: null, dryRun: false, replace: false, reportPath: null, ...over }
}

async function run(store: FakeStore, opts: ExtractOptions) {
  const { adapter, requests } = intelligence()
  const emitted: Record<string, unknown>[] = []
  const logged: string[] = []
  const reported: Record<string, unknown>[] = []
  const outcome = await runExtract(opts, {
    store,
    intelligence: adapter,
    model: 'tst-model',
    now: () => new Date(Date.UTC(2026, 2, 3)),
    emit: (s) => emitted.push(s),
    log: (l) => logged.push(l),
    report: (e) => reported.push(e),
  })
  return { outcome, emitted, logged, reported, requests }
}

const due: ExtractionSession = { sessionId: SESSION, firstAt: new Date(Date.UTC(2026, 2, 2, 10)), due: true }

describe('engram-extract arguments', () => {
  it('takes exactly one of --session and --since', () => {
    expect(() => parseExtractArgs(['--max-calls', '5'])).toThrow(UsageError)
    expect(() => parseExtractArgs(['--session', SESSION, '--since', '2026-03-01T00:00:00Z', '--max-calls', '5'])).toThrow(
      /exactly one of --session and --since/,
    )
    expect(parseExtractArgs(['--since', '2026-03-01T00:00:00Z', '--max-calls', '5']).since?.toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    )
  })

  it('requires --max-calls', () => {
    expect(() => parseExtractArgs(['--session', SESSION])).toThrow(/--max-calls is required/)
    expect(() => parseExtractArgs(['--session', SESSION, '--max-calls', '0'])).toThrow(/at least 1/)
    expect(parseExtractArgs(['--session', SESSION, '--max-calls', '3', '--dry-run', '--replace'])).toMatchObject({
      maxCalls: 3,
      dryRun: true,
      replace: true,
    })
  })

  it('exits 2 when --version is not this build\'s extractor version', async () => {
    expect(versionMismatch(EXTRACTOR_VERSION)).toBeNull()
    expect(versionMismatch('extract-v0')).toBe(`this build runs extractor ${EXTRACTOR_VERSION}`)
    const stderr: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => stderr.push(chunk) > 0) as typeof process.stderr.write
    try {
      expect(await main(['--session', SESSION, '--max-calls', '1', '--version', 'extract-v0'])).toBe(EXIT_VERSION)
    } finally {
      process.stderr.write = write
    }
    expect(stderr.join('')).toContain(`this build runs extractor ${EXTRACTOR_VERSION}`)
  })
})

describe('engram-extract runs', () => {
  it('makes no write on a dry run, run rows included', async () => {
    const store = new FakeStore([due], [anchor(ANCHOR_A, 0), anchor(ANCHOR_B, 5)])
    const { outcome, emitted, requests } = await run(store, options({ dryRun: true, replace: true }))
    expect(store.writes).toEqual([])
    expect(store.windowsRead).toEqual([ANCHOR_A, ANCHOR_B])
    expect(requests).toHaveLength(2)
    expect(emitted.map((e) => e.status)).toEqual(['dry_run', 'dry_run'])
    expect(emitted[0]).toMatchObject({ stored: null, retired: null, calls: 1 })
    expect(outcome.exitCode).toBe(EXIT_OK)
  })

  it('skips windows that already have a successful run at this version', async () => {
    const store = new FakeStore([due], [anchor(ANCHOR_A, 0, true), anchor(ANCHOR_B, 5)])
    const { emitted } = await run(store, options())
    expect(store.windowsRead).toEqual([ANCHOR_B])
    expect(store.writes).toEqual([`begin ${ANCHOR_B}`, 'commit 00000000-0000-4000-8000-0000000b0001'])
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ anchor: ANCHOR_B, status: 'succeeded', stored: 0, linked: 0, retired: null })
  })

  it('commits through the replace and reports what it retired and restored', async () => {
    const store = new FakeStore([due], [anchor(ANCHOR_A, 0)])
    const { emitted, reported } = await run(store, options({ replace: true }))
    expect(store.writes).toEqual([`begin ${ANCHOR_A}`, 'replace 00000000-0000-4000-8000-0000000b0001'])
    expect(emitted[0]).toMatchObject({ status: 'succeeded', retired: [RETIRED], restored: [{ item: RESTORED, from: RETIRED, to: null }] })
    expect(reported).toHaveLength(1)
    expect(JSON.stringify(emitted)).not.toContain('keep the cache on postgres')
  })

  it('skips a live session with a line', async () => {
    const store = new FakeStore([{ ...due, due: false }], [anchor(ANCHOR_A, 0)])
    const { emitted, outcome } = await run(store, options())
    expect(store.windowsRead).toEqual([])
    expect(store.writes).toEqual([])
    expect(emitted).toEqual([{ session: SESSION, skipped: expect.stringMatching(/^live/) }])
    expect(outcome.exitCode).toBe(EXIT_OK)
  })

  it('stops at the call cap with exit code 3', async () => {
    const store = new FakeStore([due], [anchor(ANCHOR_A, 0), anchor(ANCHOR_B, 5)])
    const { outcome, logged, requests } = await run(store, options({ maxCalls: 1 }))
    expect(requests).toHaveLength(1)
    expect(store.windowsRead).toEqual([ANCHOR_A])
    expect(outcome).toMatchObject({ exitCode: EXIT_CAPPED, capped: true, calls: 1 })
    expect(logged.join('\n')).toContain('stopped at --max-calls 1')
  })
})
