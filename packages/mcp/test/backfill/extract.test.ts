/**
 * The ordered extraction pass over fake stores with recorded model replies:
 * sessions from the history file, the old rows and a transcript, received
 * newest first, run oldest first; under the store's time rule (an item
 * supersedes only an older one) the newest statement then supersedes the
 * oldest on its subject, which the received order cannot achieve. Without
 * ENGRAM_EXTRACTION=hold, or with an unsettled store, the pass refuses. The
 * call cap exits 3 and a re-run finishes.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  CompleteJsonRequest,
  ExtractedBy,
  ExtractionCommit,
  ExtractionCommitResult,
  ExtractionFailure,
  ExtractionReplaceResult,
  ExtractionSession,
  IntelligenceAdapter,
  RawExtractionWindow,
  SessionAnchor,
} from '@engram-mem/core'
import { EXTRACT_EXIT_CAPPED, EXTRACT_EXIT_OK, ExtractRefused, runExtractPass, type ExtractPassDeps } from '../../src/backfill/extract.js'
import type { ExtractStore } from '../../src/ingest/extract-lib.js'
import { LegacyUtterancesRefused } from '../../src/backfill/legacy-utterances.js'
import type { LegacyRow, SalvageRunStore, SalvageStore } from '../../src/backfill/salvage.js'

const HELD = { ENGRAM_EXTRACTION: 'hold' }
const EMPTY_EXTRACTION_REPLY = JSON.stringify({ statements: [], observations: [] })
const SUBJECT = 'Deploy target'

interface Fixture {
  rows: LegacyRow[]
  reply: string
}
const SALVAGE = JSON.parse(readFileSync(new URL('./fixtures/salvage-we-decided.json', import.meta.url), 'utf8')) as Fixture
const SALVAGE_SESSION = SALVAGE.rows[0]!.session_id

interface Utterance {
  anchorId: string
  sessionId: string
  text: string
  at: Date
}

const HISTORY: Utterance = {
  anchorId: '00000000-0000-4000-8000-0000000e0001',
  sessionId: 'tst-history-session',
  text: 'deploy tst-app to the staging box',
  at: new Date('2026-02-20T08:00:00Z'),
}
const TRANSCRIPT: Utterance = {
  anchorId: '00000000-0000-4000-8000-0000000e0002',
  sessionId: 'tst-transcript-session',
  text: 'deploy tst-app to the sample cluster from now on',
  at: new Date('2026-03-09T08:00:00Z'),
}

interface Statement {
  anchorId: string
  at: number
  supersededBy: string | null
}

/**
 * The capture store as the database keeps it: a window succeeds when its run
 * commits, and the window's statement on the subject supersedes the current
 * one only when it is strictly later, as the item store's time rule allows.
 */
class FakeExtractionStore implements ExtractStore {
  readonly order: string[] = []
  readonly statements: Statement[] = []
  readonly done = new Set<string>()
  constructor(
    private readonly utterances: Utterance[],
    private readonly live: Set<string> = new Set(),
  ) {}

  async extractionSessions(q: { sessionId: string | null; since: Date | null }): Promise<ExtractionSession[]> {
    const rows = this.utterances
      .filter((u) => (q.sessionId === null ? u.at >= q.since! : u.sessionId === q.sessionId))
      .map((u) => ({ sessionId: u.sessionId, firstAt: u.at, due: !this.live.has(u.sessionId) }))
    return rows
  }
  async extractionSessionAnchors(_v: string, sessionId: string, _by: ExtractedBy): Promise<SessionAnchor[]> {
    return this.utterances
      .filter((u) => u.sessionId === sessionId)
      .map((u) => ({ anchorId: u.anchorId, anchorKind: 'user_prompt', occurredAt: u.at, succeeded: this.done.has(u.anchorId), runningRunId: null }))
  }
  async extractionWindow(anchorId: string): Promise<RawExtractionWindow | null> {
    const u = this.utterances.find((x) => x.anchorId === anchorId)!
    return {
      anchor: {
        id: u.anchorId,
        kind: 'user_prompt',
        session_id: u.sessionId,
        project_id: 'tst-app',
        workspace_id: 'tst-ws',
        content: u.text,
        occurred_at: u.at.toISOString(),
        source: { type: 'transcript', event_key: `tst-key-${u.anchorId.slice(-4)}` },
      },
      anchor_event: { payload: { text: u.text, transcript_line: 1 }, plan_dirs: [] },
      turns: [],
      subjects: [],
      statements: [],
      observations: [],
    } as unknown as RawExtractionWindow
  }
  async extractionCandidates(): Promise<never> {
    throw new Error('no candidate read expected')
  }
  async extractionBegin(run: { anchorId: string }): Promise<string> {
    return `run-${run.anchorId}`
  }
  async extractionFail(): Promise<boolean> {
    return true
  }
  async extractionCommit(runId: string, _commit: ExtractionCommit): Promise<ExtractionCommitResult> {
    const anchorId = runId.slice('run-'.length)
    const u = this.utterances.find((x) => x.anchorId === anchorId)!
    this.order.push(u.sessionId)
    this.done.add(anchorId)
    this.store({ anchorId, at: u.at.getTime(), supersededBy: null })
    return { itemIds: [], subjectsCreated: 0, duplicates: 0, restatements: 0, linksApplied: 0 }
  }
  async extractionReplace(): Promise<ExtractionReplaceResult> {
    throw new Error('the pass never replaces')
  }

  /** Stores a statement on the subject; it supersedes the current one only when strictly later. */
  store(s: Statement): void {
    const current = this.statements.find((x) => x.supersededBy === null)
    if (current !== undefined && current.at < s.at) current.supersededBy = s.anchorId
    this.statements.push(s)
  }
}

function salvageFakes(completed: Set<string> = new Set()) {
  const order: string[] = []
  const store: SalvageStore = {
    legacySessions: async () => [SALVAGE_SESSION],
    transcriptSessions: async () => new Set(),
    sessionRows: async () => SALVAGE.rows,
    activeSubjects: async () => [],
    salvageObservations: async () => [],
    completedWindowKeys: async (keys) => new Set(keys.filter((k) => completed.has(k))),
    projects: async () => [{ id: 'tst-app', kind: 'project' }],
  }
  const keys = new Map<string, string>()
  const runs: SalvageRunStore & { failures: ExtractionFailure[] } = {
    failures: [],
    salvageBegin: async ({ windowKey }) => {
      if (completed.has(windowKey)) return null
      const id = `00000000-0000-4000-8000-00000000f${keys.size.toString(16).padStart(3, '0')}`
      keys.set(id, windowKey)
      return id
    },
    extractionCommit: async (runId, commit) => {
      order.push(SALVAGE_SESSION)
      completed.add(keys.get(runId)!)
      return { itemIds: commit.items.map((i) => i.id), subjectsCreated: commit.subjects.length, duplicates: 0, restatements: 0 }
    },
    extractionFail: async (_runId, failure) => {
      runs.failures.push(failure)
      return true
    },
  }
  return { store, runs, order, completed }
}

/** Answers salvage prompts with the recorded salvage reply and extraction prompts with the recorded empty reply. */
function recordedModel(): { intelligence: IntelligenceAdapter; requests: CompleteJsonRequest[] } {
  const requests: CompleteJsonRequest[] = []
  return {
    requests,
    intelligence: {
      async completeJson(req: CompleteJsonRequest) {
        requests.push(req)
        const salvage = req.user.includes(SALVAGE.rows[1]!.content.slice(0, 40))
        return { text: salvage ? SALVAGE.reply : EMPTY_EXTRACTION_REPLY, finishReason: 'stop', model: 'tst-model' }
      },
    } as IntelligenceAdapter,
  }
}

function deps(over: Partial<ExtractPassDeps> & { extraction: FakeExtractionStore; salvage: ReturnType<typeof salvageFakes> }) {
  const logs: string[] = []
  const { extraction, salvage, ...rest } = over
  const d: ExtractPassDeps = {
    env: HELD,
    guards: { unsettledCaptureEvents: async () => 0, legacyStepWithWork: async () => null, unforgottenLegacyItems: async () => 0 },
    extraction,
    salvage: salvage.store,
    runs: salvage.runs,
    intelligence: recordedModel().intelligence,
    model: 'tst-model',
    now: () => new Date('2026-04-01T00:00:00Z'),
    log: (l) => logs.push(l),
    ...rest,
  }
  return { d, logs }
}

/** Received newest first, as the worker would take them. */
const RECEIVED = [TRANSCRIPT, HISTORY]

describe('extract: the ordered pass', () => {
  it('runs a history, a salvage and a transcript session oldest first, so the newest statement supersedes the oldest', async () => {
    const extraction = new FakeExtractionStore(RECEIVED)
    const salvage = salvageFakes()
    const model = recordedModel()
    const { d } = deps({ extraction, salvage, intelligence: model.intelligence })

    const { exitCode, summary } = await runExtractPass({ apply: true, maxCalls: 10 }, d)

    expect(exitCode).toBe(EXTRACT_EXIT_OK)
    expect(summary.sessions.map((s) => s.session)).toEqual([HISTORY.sessionId, SALVAGE_SESSION, TRANSCRIPT.sessionId])
    expect([...extraction.order.slice(0, 1), ...salvage.order, ...extraction.order.slice(1)]).toEqual([
      HISTORY.sessionId,
      SALVAGE_SESSION,
      TRANSCRIPT.sessionId,
    ])
    expect(summary.sessions[1]!.salvaged).toEqual({ stored: 1 })
    expect(summary.calls).toBe(3)
    expect(model.requests).toHaveLength(3)
    const oldest = extraction.statements.find((s) => s.anchorId === HISTORY.anchorId)!
    expect(oldest.supersededBy).toBe(TRANSCRIPT.anchorId)
    expect(extraction.statements.filter((s) => s.supersededBy === null).map((s) => s.anchorId)).toEqual([TRANSCRIPT.anchorId])
  })

  it('would leave both statements current in the received order, which is what the ordering prevents', () => {
    const store = new FakeExtractionStore(RECEIVED)
    for (const u of RECEIVED) store.store({ anchorId: u.anchorId, at: u.at.getTime(), supersededBy: null })
    expect(store.statements.every((s) => s.supersededBy === null)).toBe(true)
  })

  it('refuses unless ENGRAM_EXTRACTION is hold, and calls no model', async () => {
    const model = recordedModel()
    for (const env of [{}, { ENGRAM_EXTRACTION: 'on' }]) {
      const { d } = deps({ extraction: new FakeExtractionStore(RECEIVED), salvage: salvageFakes(), env, intelligence: model.intelligence })
      await expect(runExtractPass({ apply: true, maxCalls: 10 }, d)).rejects.toThrow(ExtractRefused)
    }
    expect(model.requests).toEqual([])
  })

  it('refuses while capture events are unsettled, as legacy-utterances does', async () => {
    const { d } = deps({
      extraction: new FakeExtractionStore(RECEIVED),
      salvage: salvageFakes(),
      guards: { unsettledCaptureEvents: async () => 2, legacyStepWithWork: async () => null, unforgottenLegacyItems: async () => 0 },
    })
    await expect(runExtractPass({ apply: false, maxCalls: null }, d)).rejects.toThrow(LegacyUtterancesRefused)
  })

  it('exits 3 at the call cap, and a re-run resumes and finishes in order', async () => {
    const extraction = new FakeExtractionStore(RECEIVED)
    const salvage = salvageFakes()
    const first = recordedModel()
    const capped = await runExtractPass({ apply: true, maxCalls: 2 }, deps({ extraction, salvage, intelligence: first.intelligence }).d)

    expect(capped.exitCode).toBe(EXTRACT_EXIT_CAPPED)
    expect(capped.summary).toMatchObject({ capped: true, calls: 2 })
    expect(first.requests).toHaveLength(2)
    expect(extraction.order).toEqual([HISTORY.sessionId])
    expect(salvage.order).toEqual([SALVAGE_SESSION])

    const second = recordedModel()
    const rerun = await runExtractPass({ apply: true, maxCalls: 2 }, deps({ extraction, salvage, intelligence: second.intelligence }).d)
    expect(rerun.exitCode).toBe(EXTRACT_EXIT_OK)
    expect(rerun.summary.sessions.map((s) => s.session)).toEqual([TRANSCRIPT.sessionId])
    expect(second.requests).toHaveLength(1)
    expect(extraction.statements.find((s) => s.anchorId === HISTORY.anchorId)!.supersededBy).toBe(TRANSCRIPT.anchorId)
  })

  it('a dry run lists the sessions in order with their windows by kind and chars, and calls no model', async () => {
    const model = recordedModel()
    const salvage = salvageFakes()
    const { d } = deps({ extraction: new FakeExtractionStore(RECEIVED), salvage, intelligence: model.intelligence })
    const { exitCode, summary } = await runExtractPass({ apply: false, maxCalls: null }, d)

    expect(exitCode).toBe(EXTRACT_EXIT_OK)
    expect(model.requests).toEqual([])
    expect(salvage.order).toEqual([])
    expect(summary.sessions.map((s) => [s.session, s.windows!.map((w) => w.kind)])).toEqual([
      [HISTORY.sessionId, ['user_prompt']],
      [SALVAGE_SESSION, ['salvage']],
      [TRANSCRIPT.sessionId, ['user_prompt']],
    ])
    expect(summary.sessions.flatMap((s) => s.windows!).every((w) => w.chars > 0)).toBe(true)
  })

  it('lists a live session and leaves it to the worker', async () => {
    const extraction = new FakeExtractionStore(RECEIVED, new Set([TRANSCRIPT.sessionId]))
    const { d } = deps({ extraction, salvage: salvageFakes() })
    const { summary } = await runExtractPass({ apply: true, maxCalls: 10 }, d)
    expect(summary.sessions.find((s) => s.session === TRANSCRIPT.sessionId)).toMatchObject({ leftToWorker: true })
    expect(extraction.order).toEqual([HISTORY.sessionId])
  })
})
