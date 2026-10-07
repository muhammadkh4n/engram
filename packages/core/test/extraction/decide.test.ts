/**
 * The decision pass from recorded replies: each fixture under ./decisions
 * holds a window, the window reply, what the candidate read returns for each
 * new item, and the decision reply. One tick runs them through the live path
 * (window call, gate, candidate read, decision call, link rules, commit
 * payload), so these pin which links a decision becomes and how many calls a
 * window makes. No paid call is made.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CompleteJsonRequest, IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type {
  ExtractionBegin,
  ExtractionCandidate,
  ExtractionCandidateQuery,
  ExtractionCandidateRead,
  ExtractionCommit,
  ExtractionCommitResult,
  ExtractionFailure,
  PendingAnchor,
} from '../../src/items/capture-store.js'
import {
  candidateQueries,
  DECISION_CANDIDATES_MAX,
  DECISION_LABEL,
  decisionsOf,
  parseDecisionReply,
  planDecisions,
  renderDecisionMessage,
} from '../../src/extraction/decide.js'
import { draftCommit, finishCommit } from '../../src/extraction/persist.js'
import { extractWindow, runExtractionTick, type ExtractionStore } from '../../src/extraction/run.js'
import { buildWindow, type RawExtractionWindow } from '../../src/extraction/window.js'

interface DecisionFixture {
  window: RawExtractionWindow
  reply: string
  reads: ExtractionCandidateRead[]
  decision_reply: string
}

const RUN_ID = '00000000-0000-4000-8000-0000000d0900'

function load(name: string): DecisionFixture {
  return JSON.parse(readFileSync(new URL(`./decisions/${name}.json`, import.meta.url), 'utf8')) as DecisionFixture
}

/** Replies in order, one per call, and records every request. */
function replying(...replies: string[]) {
  const requests: CompleteJsonRequest[] = []
  const intelligence: IntelligenceAdapter = {
    async completeJson(req) {
      requests.push(req)
      const text = replies[requests.length - 1]
      if (text === undefined) throw new Error(`unexpected call ${requests.length}: ${req.label}`)
      return { text, finishReason: 'stop', model: 'tst-model' }
    },
  }
  return { intelligence, requests }
}

/** Serves one window and its candidate reads to one tick. */
class FixtureStore implements ExtractionStore {
  readonly commits: ExtractionCommit[] = []
  readonly failures: ExtractionFailure[] = []
  readonly candidateCalls: { items: ExtractionCandidateQuery[]; limit: number }[] = []
  private closed = false

  constructor(
    private readonly raw: RawExtractionWindow,
    private readonly reads: ExtractionCandidateRead[],
  ) {}

  async extractionPending(): Promise<PendingAnchor[]> {
    if (this.closed) return []
    const anchor = this.raw.anchor
    return [
      {
        anchorId: anchor.id,
        sessionId: anchor.session_id!,
        anchorKind: 'user_prompt',
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

  async extractionCandidates(
    _anchorId: string,
    items: readonly ExtractionCandidateQuery[],
    limit: number,
  ): Promise<ExtractionCandidateRead[]> {
    this.candidateCalls.push({ items: [...items], limit })
    return this.reads.map((r) => ({ ...r, candidates: r.candidates.slice(0, limit) }))
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

async function tick(fixture: DecisionFixture) {
  const store = new FixtureStore(fixture.window, fixture.reads)
  const { intelligence, requests } = replying(fixture.reply, fixture.decision_reply)
  const result = await runExtractionTick({ store, intelligence, model: 'tst-chat-model', log: () => {} })
  expect(store.failures).toEqual([])
  expect(result).toMatchObject({ windows: 1, succeeded: 1 })
  return { store, requests, commit: store.commits[0]! }
}

function candidate(n: number, at: string): ExtractionCandidate {
  return {
    id: `00000000-0000-4000-8000-0000000d${String(5000 + n).padStart(4, '0')}`,
    class: 'mk_statement',
    kind: 'ruling',
    subjectId: '00000000-0000-4000-8000-0000000d0010',
    subjectLabel: 'storage backend',
    projectId: 'tst-repo',
    workspaceId: 'tst-ws',
    content: `storage rule number ${n}`,
    occurredAt: at,
  }
}

describe('the decision pass', () => {
  it('lists every current statement pass 1 did not link in one call and applies the recorded supersedes', async () => {
    const fixture = load('01-older-ruling-superseded')
    const [older, newer] = ['00000000-0000-4000-8000-0000000d0011', '00000000-0000-4000-8000-0000000d0012']

    const { store, requests, commit } = await tick(fixture)

    expect(requests.map((r) => r.label)).toEqual(['extraction', DECISION_LABEL])
    expect(requests[1]!.user).toContain('Postgres and SQLite both')
    expect(requests[1]!.user).toContain('the embeddings live in pgvector')
    expect(store.candidateCalls).toHaveLength(1)
    expect(store.candidateCalls[0]!.limit).toBe(DECISION_CANDIDATES_MAX)
    expect(store.candidateCalls[0]!.items).toMatchObject([
      { subjectId: '00000000-0000-4000-8000-0000000d0010', class: 'mk_statement', exclude: [] },
    ])
    expect(commit.items).toHaveLength(1)
    expect(commit.items[0]!.links).toEqual([{ rel: 'supersedes', target: older }])
    expect(commit.items[0]!.linksRejected).toEqual([])
    expect([...commit.items[0]!.candidatesRead!].sort()).toEqual([older, newer])
    expect(commit.stats).toMatchObject({ model_calls: 2, decision_calls: 1, candidates_truncated: 0 })
    expect(commit.stats.decisions).toMatchObject({ items: 1, supersedes: 1, missing: 0, invalid: 0 })
  })

  it('drops a recorded target that is not a candidate of its item as not_a_candidate', async () => {
    const fixture = load('02-target-of-another-item')
    const [deploys, cache] = ['00000000-0000-4000-8000-0000000d0021', '00000000-0000-4000-8000-0000000d0031']

    const { requests, commit } = await tick(fixture)

    expect(requests).toHaveLength(2)
    expect(commit.items[0]!.links).toEqual([{ rel: 'supersedes', target: deploys }])
    expect(commit.items[0]!.linksRejected).toEqual([{ target: cache, reason: 'not_a_candidate' }])
    expect(commit.items[1]!.links).toEqual([{ rel: 'supersedes', target: cache }])
  })

  it('turns a recorded correction of a current observation into one corrects link and retires nothing', async () => {
    const fixture = load('03-port-correction')
    const observation = '00000000-0000-4000-8000-0000000d0041'

    const { commit } = await tick(fixture)

    expect(commit.items[0]!.kind).toBe('correction')
    expect(commit.items[0]!.links).toEqual([{ rel: 'corrects', target: observation }])
    expect(commit.items[0]!.links!.some((l) => l.rel === 'supersedes')).toBe(false)
    expect(commit.stats.decisions).toMatchObject({ independent: 1 })
  })

  it('makes no candidate read and no decision call for an item on a new subject', async () => {
    const fixture = load('01-older-ruling-superseded')
    const reply = fixture.reply.replace('{"id":"subj-1"}', '{"new":"database engines"}')
    const store = new FixtureStore(fixture.window, fixture.reads)
    const { intelligence, requests } = replying(reply)

    await runExtractionTick({ store, intelligence, model: 'tst-chat-model', log: () => {} })

    expect(requests.map((r) => r.label)).toEqual(['extraction'])
    expect(store.candidateCalls).toEqual([])
    expect(store.commits[0]!.items[0]!.candidatesRead).toBeUndefined()
    expect(store.commits[0]!.stats).toMatchObject({ model_calls: 1, decision_calls: 0, candidates_truncated: 0 })
  })

  it('makes no decision call when the read finds nothing current on the subject, and still records the read', async () => {
    const fixture = load('01-older-ruling-superseded')
    const store = new FixtureStore(fixture.window, [{ stored: null, repeatOf: null, total: 0, read: [], candidates: [] }])
    const { intelligence, requests } = replying(fixture.reply)

    await runExtractionTick({ store, intelligence, model: 'tst-chat-model', log: () => {} })

    expect(requests).toHaveLength(1)
    expect(store.commits[0]!.items[0]!.candidatesRead).toEqual([])
  })

  it('sends the newest 20 of 25 current items and counts 5 as truncated', async () => {
    const fixture = load('01-older-ruling-superseded')
    const window = buildWindow(fixture.window)
    const gated = await extractWindow(window, replying(fixture.reply))
    const draft = draftCommit(window, gated, RUN_ID)
    const queries = candidateQueries(draft)
    const all = Array.from({ length: 25 }, (_, n) => candidate(n, new Date(Date.UTC(2026, 8, 25 - n, 10)).toISOString()))
    const read: ExtractionCandidateRead = {
      stored: null,
      repeatOf: null,
      total: 25,
      read: all.map((c) => c.id),
      candidates: all.slice(0, DECISION_CANDIDATES_MAX),
    }

    const plan = planDecisions(draft, queries, [read])
    const message = renderDecisionMessage(plan)
    const decisions = decisionsOf(plan, null, 0)

    expect(plan.asked[0]!.candidates).toHaveLength(20)
    expect(message.match(/^c-\d+ /gm)).toHaveLength(20)
    expect(message).toContain('storage rule number 0')
    expect(message).not.toContain('storage rule number 20')
    expect(decisions.stats).toMatchObject({ candidates_truncated: 5 })
    expect(decisions.reads.get(0)).toHaveLength(25)
  })

  it('needs no decision for an item whose words are stored already', async () => {
    const fixture = load('01-older-ruling-superseded')
    const window = buildWindow(fixture.window)
    const draft = draftCommit(window, await extractWindow(window, replying(fixture.reply)), RUN_ID)
    const queries = candidateQueries(draft)

    const plan = planDecisions(draft, queries, [
      { stored: null, repeatOf: '00000000-0000-4000-8000-0000000d0011', total: 0, read: [], candidates: [] },
    ])

    expect(plan.asked).toEqual([])
    expect(plan.repeats).toBe(1)
    expect(plan.reads.size).toBe(0)
  })

  it('excludes the targets of pass-1 links from the read and leaves a pass-1 restatement undecided', async () => {
    const fixture = load('01-older-ruling-superseded')
    const listed = {
      id: '00000000-0000-4000-8000-0000000d0011',
      kind: 'ruling',
      subject_id: '00000000-0000-4000-8000-0000000d0010',
      subject_label: 'storage backend',
      content: 'Postgres and SQLite both',
      occurred_at: '2026-09-10T10:00:00Z',
    }
    const window = buildWindow({ ...fixture.window, statements: [listed] })
    const superseding = fixture.reply.replace('"supersedes":[]', '"supersedes":["stmt-1"]')
    const restating = fixture.reply.replace('"restates":[]', '"restates":["stmt-1"]')

    const supersedes = candidateQueries(draftCommit(window, await extractWindow(window, replying(superseding)), RUN_ID))
    const restates = candidateQueries(draftCommit(window, await extractWindow(window, replying(restating)), RUN_ID))

    expect(supersedes.queries[0]!.exclude).toEqual([listed.id])
    expect(restates.queries).toEqual([])
  })

  it('rejects a supersedes and a restates decided for one item across the reply and the decision', async () => {
    const fixture = load('01-older-ruling-superseded')
    const listed = {
      id: '00000000-0000-4000-8000-0000000d0012',
      kind: 'ruling',
      subject_id: '00000000-0000-4000-8000-0000000d0010',
      subject_label: 'storage backend',
      content: 'the embeddings live in pgvector',
      occurred_at: '2026-09-20T10:00:00Z',
    }
    const window = buildWindow({ ...fixture.window, statements: [listed] })
    const draft = draftCommit(
      window,
      await extractWindow(window, replying(fixture.reply.replace('"supersedes":[]', '"supersedes":["stmt-1"]'))),
      RUN_ID,
    )
    const older = fixture.reads[0]!.candidates[1]!
    const plan = planDecisions(draft, candidateQueries(draft), [
      { stored: null, repeatOf: null, total: 1, read: [older.id], candidates: [older] },
    ])
    const parsed = parseDecisionReply('{"decisions":[{"item":0,"relation":"restates","targets":["c-1"],"corrects":[]}]}')

    const commit = finishCommit(draft, decisionsOf(plan, parsed, 1))

    expect(commit.items[0]!.links).toEqual([])
    expect(commit.items[0]!.linksRejected).toEqual([
      { target: listed.id, reason: 'link_conflict' },
      { target: older.id, reason: 'link_conflict' },
    ])
  })

  it('maps a supersedes on a register entry to a changes link', () => {
    const entry: ExtractionCandidate = {
      id: '00000000-0000-4000-8000-0000000d0071',
      class: 'artifact',
      kind: 'ruling_entry',
      subjectId: null,
      subjectLabel: 'Storage Backend',
      projectId: null,
      workspaceId: null,
      content: 'Postgres is the only store.',
      occurredAt: '2026-09-01T10:00:00.000Z',
    }
    const plan = {
      asked: [
        {
          index: 0,
          class: 'mk_statement' as const,
          kind: 'ruling',
          content: 'SQLite comes back for the laptop build',
          context: null,
          subjectLabel: 'storage backend',
          occurredAt: '2026-10-04T09:00:00.000Z',
          candidates: [{ alias: 'c-1', candidate: entry }],
        },
      ],
      reads: new Map([[0, [entry.id]]]),
      truncated: 0,
      repeats: 0,
    }
    const parsed = parseDecisionReply('{"decisions":[{"item":0,"relation":"supersedes","targets":["c-1"],"corrects":[]}]}')

    const decisions = decisionsOf(plan, parsed, 1)

    expect(decisions.proposals).toEqual([{ item: 0, rel: 'changes', target: entry.id, candidates: [entry.id] }])
    expect(renderDecisionMessage(plan)).toContain('c-1 [register entry, ruling_entry, 2026-09-01]')
  })

  describe('parseDecisionReply', () => {
    it('fails a reply that is not the decisions object', () => {
      expect(parseDecisionReply('{"statements":[]}').ok).toBe(false)
      expect(parseDecisionReply('not json').ok).toBe(false)
    })

    it('counts a malformed decision as invalid and keeps the rest', () => {
      const parsed = parseDecisionReply(
        '{"decisions":[{"item":0,"relation":"replaces","targets":[],"corrects":[]},' +
          '{"item":1,"relation":"independent","targets":[],"corrects":[]},' +
          '{"item":2,"relation":"independent","targets":["c-1"],"corrects":[]}]}',
      )

      expect(parsed).toEqual({
        ok: true,
        invalid: 2,
        decisions: [{ item: 1, relation: 'independent', targets: [], corrects: [] }],
      })
    })

    it('treats a second decision for an item, and an unknown alias, as invalid input that links nothing', () => {
      const entry = candidate(1, '2026-09-01T10:00:00.000Z')
      const plan = {
        asked: [
          {
            index: 0,
            class: 'mk_statement' as const,
            kind: 'ruling',
            content: 'Postgres only',
            context: null,
            subjectLabel: 'storage backend',
            occurredAt: '2026-10-04T09:00:00.000Z',
            candidates: [{ alias: 'c-1', candidate: entry }],
          },
        ],
        reads: new Map([[0, [entry.id]]]),
        truncated: 0,
        repeats: 0,
      }
      const parsed = parseDecisionReply(
        '{"decisions":[{"item":0,"relation":"supersedes","targets":["c-9"],"corrects":[]},' +
          '{"item":0,"relation":"supersedes","targets":["c-1"],"corrects":[]}]}',
      )

      const decisions = decisionsOf(plan, parsed, 1)

      expect(decisions.proposals).toEqual([])
      expect(decisions.stats.decisions).toMatchObject({ supersedes: 1, invalid: 1, unknown_targets: 1, missing: 0 })
    })
  })
})
