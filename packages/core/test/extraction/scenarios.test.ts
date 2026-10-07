/**
 * Recorded replies: each fixture under ./replies holds a window as the window
 * RPC returns it and a raw model reply. The reply runs through the same path a
 * live run takes (render, JSON call, parse, gate, commit payload), so these
 * pin what the gate stores and rejects for replies a model actually writes:
 * a reworded quote or question, an assistant "we decided", a two-character
 * answer, a standing rule and an evidenced finding.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CompleteJsonRequest, IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type {
  ExtractionBegin,
  ExtractionCandidateQuery,
  ExtractionCandidateRead,
  ExtractionCommit,
  ExtractionCommitResult,
  ExtractionFailure,
  PendingAnchor,
} from '../../src/items/capture-store.js'
import { itemEventKey } from '../../src/extraction/links.js'
import { buildCommitPayload } from '../../src/extraction/persist.js'
import { extractWindow, runExtractionTick, type ExtractionStore } from '../../src/extraction/run.js'
import { buildWindow, renderUserMessage, type RawExtractionWindow } from '../../src/extraction/window.js'

interface RecordedScenario {
  window: RawExtractionWindow
  reply: string
}

const SCENARIOS = [
  '01-hallucinated-quote',
  '02-reworded-question',
  '03-assistant-we-decided',
  '04-dialog-two-char-answer',
  '05-short-reply-to-prompt',
  '06-standing-rule',
  '07-evidenced-observation',
] as const
type ScenarioName = (typeof SCENARIOS)[number]

const RUN_ID = '00000000-0000-4000-8000-000000000900'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[8-9a-b][0-9a-f]{3}-[0-9a-f]{12}$/

function load(name: ScenarioName): RecordedScenario {
  return JSON.parse(readFileSync(new URL(`./replies/${name}.json`, import.meta.url), 'utf8')) as RecordedScenario
}

function replying(reply: string) {
  const requests: CompleteJsonRequest[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      requests.push(req)
      return { text: reply, finishReason: 'stop', model: 'tst-model' }
    },
  }
  return { intelligence, requests }
}

async function run(name: ScenarioName) {
  const scenario = load(name)
  const window = buildWindow(scenario.window)
  const { intelligence, requests } = replying(scenario.reply)
  const result = await extractWindow(window, { intelligence })
  const payload = buildCommitPayload(window, result, RUN_ID)
  return { scenario, window, result, payload, requests }
}

/** Serves one recorded window to one tick and records how its run closed. */
class OneWindowStore implements ExtractionStore {
  readonly commits: ExtractionCommit[] = []
  readonly failures: ExtractionFailure[] = []
  private closed = false

  constructor(private readonly raw: RawExtractionWindow) {}

  async extractionPending(): Promise<PendingAnchor[]> {
    if (this.closed) return []
    const anchor = this.raw.anchor
    return [
      {
        anchorId: anchor.id,
        sessionId: anchor.session_id!,
        anchorKind: anchor.kind === 'assistant_turn' ? 'trailing' : anchor.kind,
        occurredAt: new Date(anchor.occurred_at),
        failures: 0,
        heldFailures: 0,
        transientFailures: 0,
        runningRunId: null,
        runningStartedAt: null,
      },
    ]
  }

  async extractionWindow(): Promise<RawExtractionWindow | null> {
    return this.raw
  }

  /** Nothing is stored on any subject, so no item has candidates. */
  async extractionCandidates(_anchorId: string, items: readonly ExtractionCandidateQuery[]): Promise<ExtractionCandidateRead[]> {
    return items.map(() => ({ stored: null, repeatOf: null, total: 0, read: [], candidates: [] }))
  }

  async extractionBegin(_run: ExtractionBegin): Promise<string | null> {
    return this.closed ? null : RUN_ID
  }

  async extractionFail(_runId: string, failure: ExtractionFailure): Promise<boolean> {
    this.closed = true
    this.failures.push(failure)
    return true
  }

  async extractionCommit(_runId: string, commit: ExtractionCommit): Promise<ExtractionCommitResult> {
    this.closed = true
    this.commits.push(commit)
    return { itemIds: commit.items.map((i) => i.id), subjectsCreated: commit.subjects.length, duplicates: 0, restatements: 0 }
  }
}

describe('recorded extraction replies', () => {
  it.each(SCENARIOS)('%s: one tick closes the run as succeeded with the gate payload', async (name) => {
    const { scenario, payload, requests } = await run(name)
    const store = new OneWindowStore(scenario.window)
    const { intelligence } = replying(scenario.reply)

    const tick = await runExtractionTick({ store, intelligence, model: 'tst-chat-model', log: () => {} })

    expect(tick).toEqual({ windows: 1, succeeded: 1, held: 0, transient: 0, full: false })
    expect(store.failures).toEqual([])
    expect(store.commits).toHaveLength(1)
    const commit = store.commits[0]!
    expect(commit.items.map((i) => [i.class, i.content])).toEqual(payload.items.map((i) => [i.class, i.content]))
    expect(commit.stats['rejected']).toEqual(payload.stats['rejected'])
    expect(requests[0]!.user).toBe(renderUserMessage(buildWindow(scenario.window)))
  })

  it('rejects a quote MK never said and stores nothing', async () => {
    const { result, payload } = await run('01-hallucinated-quote')

    expect(result.rejected).toEqual([{ item: 'statement', index: 0, rule: 'quote_not_found' }])
    expect(payload.items).toEqual([])
    expect(payload.subjects).toEqual([])
    expect(payload.stats).toMatchObject({
      statements: { proposed: 1, stored: 0, rejected: 1 },
      rejected: [{ item: 'statement', index: 0, rule: 'quote_not_found' }],
    })
  })

  it('rejects a question the assistant did not ask in those words', async () => {
    const { result, payload } = await run('02-reworded-question')

    expect(result.rejected).toEqual([{ item: 'statement', index: 0, rule: 'question_not_found' }])
    expect(payload.items).toEqual([])
  })

  it('rejects an observation that puts a decision in "we"', async () => {
    const { result, payload } = await run('03-assistant-we-decided')

    expect(result.rejected).toEqual([{ item: 'observation', index: 0, rule: 'attributed_to_user' }])
    expect(payload.items).toEqual([])
    expect(payload.stats).toMatchObject({ observations: { proposed: 1, stored: 0, rejected: 1 } })
  })

  it('stores a two-character dialog answer with the question it answered, verbatim', async () => {
    const { window, result, payload } = await run('04-dialog-two-char-answer')
    const question = 'Drop the old spool after the cutover?'
    const utteranceId = window.utterance!.id

    expect(window.utterance!.kind).toBe('user_answer')
    expect(result.rejected).toEqual([])
    expect(payload.subjects).toEqual([{ key: 'new-1', projectId: 'tst-repo', label: 'old spool' }])
    expect(payload.items).toEqual([
      {
        id: expect.stringMatching(UUID_V7),
        class: 'mk_statement',
        kind: 'ruling',
        speaker: 'mk',
        trust: 0,
        projectId: 'tst-repo',
        workspaceId: 'tst-ws',
        planSlug: null,
        sessionId: 'tst-session-1',
        subjectId: null,
        subjectKey: 'new-1',
        content: 'ok',
        searchText: `${question} — ok`,
        context: question,
        occurredAt: new Date('2026-10-01T09:01:00Z'),
        standing: false,
        registerStatus: null,
        source: {
          type: 'extraction',
          utterance_id: utteranceId,
          run_id: RUN_ID,
          event_key: itemEventKey('mk_statement', utteranceId, 'ok'),
          scope: 'project',
          applies_to: [],
        },
        lineage: [utteranceId],
        entities: [],
        links: [],
        linksRejected: [],
      },
    ])
  })

  it('stores a two-character reply to a prompt in the same shape', async () => {
    const { window, result, payload } = await run('05-short-reply-to-prompt')
    const utteranceId = window.utterance!.id

    expect(window.utterance!.kind).toBe('user_prompt')
    expect(result.rejected).toEqual([])
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      class: 'mk_statement',
      speaker: 'mk',
      trust: 0,
      content: 'ok',
      context: 'Ship it now?',
      searchText: 'Ship it now? — ok',
      occurredAt: new Date('2026-10-01T09:00:10Z'),
      standing: false,
      registerStatus: null,
      source: { type: 'extraction', utterance_id: utteranceId, scope: 'project' },
      lineage: [utteranceId],
    })
  })

  it('makes a standing ruling a register candidate at project scope', async () => {
    const { window, result, payload } = await run('06-standing-rule')

    expect(result.rejected).toEqual([])
    expect(payload.subjects).toEqual([])
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      class: 'mk_statement',
      kind: 'ruling',
      content: 'every schema change ships with its rollback script in the same PR',
      context: null,
      standing: true,
      registerStatus: 'candidate',
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      subjectId: window.subjects[0]!.id,
      subjectKey: null,
      source: { scope: 'project', applies_to: ['schema.sql'] },
    })
  })

  it('stores a finding backed by a commit the turn touched at trust 2 with its sha entity', async () => {
    const { window, result, payload } = await run('07-evidenced-observation')
    const turnId = window.turn!.id
    const claim =
      'The capture worker in tst-repo parks a capture event after three failed attempts instead of retrying it forever.'

    expect(result.rejected).toEqual([])
    expect(payload.subjects).toEqual([{ key: 'new-1', projectId: 'tst-repo', label: 'capture worker' }])
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      class: 'observation',
      kind: 'finding',
      speaker: 'assistant',
      trust: 2,
      content: claim,
      searchText: `capture worker: ${claim}`,
      subjectKey: 'new-1',
      occurredAt: new Date('2026-10-01T09:00:00Z'),
      source: { type: 'extraction', utterance_id: turnId, evidence: [{ type: 'commit', ref: 'c0ffee5d1e9a' }] },
      lineage: [turnId],
    })
    expect(payload.items[0]!.entities).toContainEqual({ entity: 'c0ffee5d1e9a', entityType: 'sha' })
    expect(payload.stats).toMatchObject({ observations: { stored: 1, trust2: 1, trust3: 0 } })
  })
})
