import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CompleteJsonRequest, ExtractionCommit, ExtractionFailure } from '@engram-mem/core'
import {
  gateSalvage,
  type LegacyRow,
  planSession,
  SALVAGE_ROW_MAX_CHARS,
  SALVAGE_WINDOW_MAX_CHARS,
  type SalvageObservationRow,
  type SalvageRunStore,
  salvageSession,
  salvageSessions,
  type SalvageStore,
  type SalvageSubjectRow,
} from '../../src/backfill/salvage.js'
import {
  parseSalvageReply,
  SALVAGE_QUOTE_MAX_CHARS,
  SALVAGE_REPLY_MAX_ITEMS,
  SALVAGE_REPLY_MAX_TOKENS,
  SALVAGE_REPLY_MIN_CHARS_PER_TOKEN,
  SALVAGE_REPLY_SCHEMA,
  SALVAGE_SYSTEM_PROMPT,
  SALVAGE_VERSION,
} from '../../src/backfill/salvage-prompt.js'

const OPEN = 'tst-salvage-open'
const COVERED = 'tst-salvage-covered'
const LATER = 'tst-salvage-later'

interface Recorded {
  rows: LegacyRow[]
  /** The current salvage observations the store lists, when the recording had any. */
  observations?: SalvageObservationRow[]
  reply: string
}

function recorded(name: string): Recorded {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Recorded
}

let nextId = 0x100
function row(over: Partial<LegacyRow>): LegacyRow {
  nextId += 1
  return {
    id: `00000000-0000-4000-8000-000000000${nextId.toString(16).padStart(3, '0')}`,
    kind: 'legacy_episode',
    session_id: OPEN,
    project_id: 'tst-app',
    workspace_id: 'tst-ws',
    content: 'The capture route answers on port 3850.',
    occurred_at: '2026-03-04T10:00:00Z',
    forgotten_at: null,
    retired_at: null,
    role: 'assistant',
    producer: 'claude-code-hook-stop',
    legacy_superseded_by: null,
    ...over,
  }
}

interface FakeStore extends SalvageStore {
  rowReads: string[]
}

function fakeStore(opts: {
  rows: LegacyRow[]
  transcript?: string[]
  subjects?: SalvageSubjectRow[]
  observations?: SalvageObservationRow[]
  completed?: string[]
}): FakeStore {
  const rowReads: string[] = []
  return {
    rowReads,
    legacySessions: async () => [...new Set(opts.rows.filter((r) => r.forgotten_at === null).map((r) => r.session_id))],
    transcriptSessions: async (ids) => new Set(ids.filter((id) => (opts.transcript ?? []).includes(id))),
    sessionRows: async (id) => {
      rowReads.push(id)
      return opts.rows.filter((r) => r.session_id === id)
    },
    activeSubjects: async (projects) => (opts.subjects ?? []).filter((s) => projects.includes(s.project_id)),
    salvageObservations: async (projects, limit) =>
      (opts.observations ?? []).filter((o) => projects.includes(o.project_id)).slice(0, limit),
    completedWindowKeys: async (keys) => new Set(keys.filter((k) => (opts.completed ?? []).includes(k))),
    projects: async () => [{ id: 'tst-app', kind: 'project' }],
  }
}

interface FakeRun {
  id: string
  windowKey: string
  model: string | null
  status: 'running' | 'succeeded' | 'failed'
  commits: ExtractionCommit[]
  failure: ExtractionFailure | null
}

/** Runs as the database keeps them: a succeeded key is not opened again, and a commit is one call. */
function fakeRuns(succeeded: string[] = []): SalvageRunStore & { runs: FakeRun[] } {
  const runs: FakeRun[] = []
  const byId = (id: string) => runs.find((r) => r.id === id)!
  return {
    runs,
    salvageBegin: async ({ windowKey, model }) => {
      if (succeeded.includes(windowKey) || runs.some((r) => r.windowKey === windowKey && r.status === 'succeeded')) return null
      const id = `00000000-0000-4000-8000-00000000f${runs.length.toString(16).padStart(3, '0')}`
      runs.push({ id, windowKey, model, status: 'running', commits: [], failure: null })
      return id
    },
    extractionCommit: async (runId, commit) => {
      const run = byId(runId)
      run.commits.push(commit)
      run.status = 'succeeded'
      return { itemIds: commit.items.map((i) => i.id), subjectsCreated: commit.subjects.length, duplicates: 0, restatements: 0 }
    },
    extractionFail: async (runId, failure) => {
      const run = byId(runId)
      run.failure = failure
      run.status = 'failed'
      return true
    },
  }
}

function deps(store: SalvageStore, intelligence: ReturnType<typeof fakeModel>['intelligence'], runs = fakeRuns()) {
  return { store, runs, intelligence, model: 'tst-model' }
}

/** Answers each call with the next reply, the last one repeated. */
function fakeModel(...replies: string[]) {
  const requests: CompleteJsonRequest[] = []
  return {
    requests,
    intelligence: {
      completeJson: async (req: CompleteJsonRequest) => {
        requests.push(req)
        return { text: replies[Math.min(requests.length, replies.length) - 1]!, finishReason: 'stop', model: 'tst-model' }
      },
    },
  }
}

async function gatedRun(name: string) {
  const fixture = recorded(name)
  const model = fakeModel(fixture.reply)
  const runs = fakeRuns()
  const result = await salvageSession(OPEN, deps(fakeStore({ rows: fixture.rows }), model.intelligence, runs))
  const window = result.windows[0]!
  if (window.status !== 'stored') throw new Error(`window not stored: ${window.status}`)
  return { fixture, window, model, runs }
}

describe('legacy salvage gate on recorded replies', () => {
  it('rejects a decision put in our mouth and keeps the knowledge the same row states', async () => {
    const { fixture, window, model } = await gatedRun('salvage-we-decided')
    const assistant = fixture.rows[1]!

    expect(window.rejected).toEqual({ attributed: 1 })
    expect(window.observations).toHaveLength(1)
    expect(window.observations[0]).toMatchObject({
      claim: 'The store runs on Postgres only',
      quote: 'the store runs on Postgres only',
      lineage: [assistant.id],
      occurredAt: '2026-03-02T09:01:30.000Z',
      projectId: 'tst-app',
      workspaceId: 'tst-ws',
      subject: { kind: 'new', label: 'Storage backend', projectId: 'tst-app' },
    })
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]!.system).toBe(SALVAGE_SYSTEM_PROMPT)
    expect(model.requests[0]!.user).toContain('[2] 2026-03-02 09:01 assistant: Done. We decided to drop SQLite')
  })

  it('rejects evidence that cites only user rows or a row outside the window', async () => {
    const { fixture, window } = await gatedRun('salvage-bad-evidence')

    expect(window.proposed).toBe(4)
    expect(window.rejected).toEqual({ evidence_context_only: 1, evidence_out_of_window: 1, schema: 1 })
    expect(window.observations.map((o) => o.lineage)).toEqual([[fixture.rows[0]!.id, fixture.rows[1]!.id]])
  })

  it('rejects a reply restating the listing from a one-row window: no quote is in the row, nothing is stored', async () => {
    const fixture = recorded('salvage-one-row-listing')
    const model = fakeModel(fixture.reply)
    const runs = fakeRuns()
    const store = fakeStore({ rows: fixture.rows, observations: fixture.observations })
    const result = await salvageSession(OPEN, deps(store, model.intelligence, runs))

    expect(fixture.rows).toHaveLength(1)
    expect(model.requests[0]!.user).toContain('obs-5 (project tst-app; subject Release flow; 2026-03-04)')
    expect(result.windows[0]).toMatchObject({
      status: 'stored',
      proposed: 5,
      rejected: { quote_not_found: 5 },
      observations: [],
      itemIds: [],
      restatements: 0,
    })
    const commit = runs.runs[0]!.commits[0]!
    expect(commit.items).toEqual([])
    expect(commit.stats).toMatchObject({ proposed: 5, stored: 0, rejected_by_reason: { quote_not_found: 5 } })
  })
})

describe('legacy salvage rows', () => {
  it('skips a session the store holds a transcript utterance for', async () => {
    const rows = [row({ session_id: OPEN }), row({ session_id: COVERED })]
    const store = fakeStore({ rows, transcript: [COVERED] })
    const model = fakeModel('{"observations":[]}')

    expect((await salvageSessions(store)).map((s) => s.sessionId)).toEqual([OPEN])
    const covered = await salvageSession(COVERED, deps(store, model.intelligence))
    expect(covered).toMatchObject({ covered: true, windows: [] })
    expect(model.requests).toHaveLength(0)
    expect(store.rowReads).not.toContain(COVERED)
  })

  it('never shows a forgotten row or a fact the old table had superseded', async () => {
    const rows = [
      row({ content: 'The worker drains the spool every 30 seconds.' }),
      row({ content: 'forgotten-row-text', forgotten_at: '2026-03-05T00:00:00Z' }),
      row({ kind: 'legacy_fact', role: null, content: 'superseded-fact-text', legacy_superseded_by: '00000000-0000-4000-8000-000000000cff' }),
      row({ kind: 'legacy_fact', role: null, content: 'Spool: drained every 30 seconds' }),
    ]
    const model = fakeModel('{"observations":[]}')
    const result = await salvageSession(OPEN, deps(fakeStore({ rows }), model.intelligence))

    expect(result.excluded).toEqual({ forgotten: 1, legacy_superseded: 1 })
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]!.user).not.toContain('forgotten-row-text')
    expect(model.requests[0]!.user).not.toContain('superseded-fact-text')
    expect(model.requests[0]!.user).toContain('fact: Spool: drained every 30 seconds')
  })

  it('counts every other producer, and shows digests only beside a shown episode', () => {
    const plan = planSession(OPEN, [
      row({ producer: 'git-commit', role: 'system' }),
      row({ producer: 'obsidian-vault', role: 'system' }),
      row({ producer: 'claude-code-hook', role: 'assistant' }),
      row({ kind: 'legacy_digest', role: null, producer: 'none' }),
    ])
    expect(plan.windows).toEqual([])
    expect(plan.excluded).toEqual({
      'producer:git-commit': 1,
      'producer:obsidian-vault': 1,
      'producer:claude-code-hook': 1,
      no_episode_in_session: 1,
    })
  })

  it('cuts windows at 24,000 rendered chars without splitting a row, and cuts a row at 6,000', () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ content: `${String(i).repeat(5000)}`, occurred_at: `2026-03-04T10:${String(i).padStart(2, '0')}:00Z` }),
    )
    rows.push(row({ content: 'y'.repeat(7000), occurred_at: '2026-03-04T11:00:00Z' }))
    const plan = planSession(OPEN, rows)

    expect(plan.windows.map((w) => w.rows.length)).toEqual([4, 4, 2])
    for (const window of plan.windows) {
      expect([...window.text].length).toBeLessThanOrEqual(SALVAGE_WINDOW_MAX_CHARS)
      const lines = window.text.split('\n')
      expect(lines.map((l) => l.slice(0, l.indexOf(']') + 1))).toEqual(window.rows.map((r) => `[${r.n}]`))
    }
    const shownIds = plan.windows.flatMap((w) => w.rows.map((r) => r.id))
    expect(shownIds).toEqual(rows.map((r) => r.id))
    const last = plan.windows[2]!.text.split('\n')[1]!
    expect(last).toBe(`[2] 2026-03-04 11:00 assistant: ${'y'.repeat(SALVAGE_ROW_MAX_CHARS)}`)
  })

  it('lists sessions by their first pending row and leaves out completed windows', async () => {
    const early = row({ session_id: OPEN, occurred_at: '2026-03-01T08:00:00Z' })
    const late = row({ session_id: LATER, occurred_at: '2026-02-01T08:00:00Z' })
    const store = fakeStore({ rows: [early, late] })
    expect(await salvageSessions(store)).toEqual([
      { sessionId: LATER, firstAt: '2026-02-01T08:00:00.000Z' },
      { sessionId: OPEN, firstAt: '2026-03-01T08:00:00.000Z' },
    ])

    const done = planSession(LATER, [late]).windows[0]!.key
    expect((await salvageSessions(fakeStore({ rows: [early, late], completed: [done] }))).map((s) => s.sessionId)).toEqual([OPEN])
  })

})

describe('legacy salvage runs', () => {
  it('stores the knowledge at trust 3 with the cited row as lineage and its time', async () => {
    const { fixture, window, runs, model } = await gatedRun('salvage-we-decided')
    const assistant = fixture.rows[1]!

    expect(model.requests[0]!.maxTokens).toBe(SALVAGE_REPLY_MAX_TOKENS)
    expect(runs.runs).toHaveLength(1)
    const run = runs.runs[0]!
    expect(run).toMatchObject({ windowKey: window.key, model: 'tst-model', status: 'succeeded' })
    expect(run.commits).toHaveLength(1)
    const commit = run.commits[0]!
    expect(commit.subjects).toEqual([{ key: 'new-1', projectId: 'tst-app', label: 'Storage backend' }])
    expect(commit.items).toHaveLength(1)
    expect(commit.items[0]).toMatchObject({
      class: 'observation',
      kind: 'fact',
      speaker: 'assistant',
      trust: 3,
      content: 'The store runs on Postgres only',
      searchText: 'Storage backend: The store runs on Postgres only',
      lineage: [assistant.id],
      occurredAt: new Date('2026-03-02T09:01:30Z'),
      sessionId: OPEN,
      projectId: 'tst-app',
      workspaceId: 'tst-ws',
      subjectKey: 'new-1',
      source: {
        type: 'extraction',
        extractor: 'legacy-salvage',
        run_id: run.id,
        window_key: window.key,
        time_basis: 'evidence',
        quote: 'the store runs on Postgres only',
      },
    })
    expect(commit.stats).toMatchObject({ rows_in: 2, proposed: 2, stored: 1, rejected_by_reason: { attributed: 1 }, attempts: 1 })
    expect(window.itemIds).toEqual([commit.items[0]!.id])
  })

  it('skips a window whose key a run already completed, without a model call', async () => {
    const rows = [row({})]
    const key = planSession(OPEN, rows).windows[0]!.key
    const model = fakeModel('{"observations":[]}')
    const result = await salvageSession(OPEN, deps(fakeStore({ rows }), model.intelligence, fakeRuns([key])))

    expect(result.windows).toEqual([{ key, status: 'skipped' }])
    expect(model.requests).toHaveLength(0)
  })

  it('asks once more after an unreadable reply and stores what the second reply gives', async () => {
    const fixture = recorded('salvage-we-decided')
    const model = fakeModel('I found nothing durable here.', fixture.reply)
    const runs = fakeRuns()
    const result = await salvageSession(OPEN, deps(fakeStore({ rows: fixture.rows }), model.intelligence, runs))

    expect(model.requests).toHaveLength(2)
    expect(result.windows[0]).toMatchObject({ status: 'stored', attempts: 2 })
    expect(runs.runs.map((r) => r.status)).toEqual(['succeeded'])
  })

  it('fails the run after a second unreadable reply and goes on to the next window', async () => {
    const long = 'x'.repeat(SALVAGE_ROW_MAX_CHARS)
    const rows = [0, 1, 2, 3, 4].map((i) => row({ content: long, occurred_at: `2026-03-04T10:0${i}:00Z` }))
    expect(planSession(OPEN, rows).windows).toHaveLength(2)
    const model = fakeModel('I found nothing durable here.', 'still not the reply object', '{"observations":[]}')
    const runs = fakeRuns()
    const result = await salvageSession(OPEN, deps(fakeStore({ rows }), model.intelligence, runs))

    expect(model.requests).toHaveLength(3)
    expect(result.windows.map((w) => w.status)).toEqual(['failed', 'stored'])
    expect(result.windows[0]).toMatchObject({ fault: 'parse', attempts: 2 })
    expect(runs.runs.map((r) => r.status)).toEqual(['failed', 'succeeded'])
    expect(runs.runs[0]!.failure).toMatchObject({ failure: 'held', counted: true, stats: { rows_in: 3, attempts: 2, fault: 'parse' } })
    expect(runs.runs[0]!.commits).toHaveLength(0)
  })

  it('fails the run as uncounted and stops when the model call itself fails', async () => {
    const runs = fakeRuns()
    const intelligence = {
      completeJson: async (): Promise<never> => {
        throw new Error('tst provider unreachable')
      },
    }
    await expect(salvageSession(OPEN, deps(fakeStore({ rows: [row({})] }), intelligence, runs))).rejects.toThrow(
      'tst provider unreachable',
    )
    expect(runs.runs[0]).toMatchObject({ status: 'failed', failure: { failure: 'transient', counted: false } })
  })
})

describe('legacy salvage gate rules', () => {
  const assistant = row({ occurred_at: '2026-03-04T10:00:00Z' })
  const window = planSession(OPEN, [assistant]).windows[0]!
  const subjects = [
    { alias: 'subj-1', id: '00000000-0000-4000-8000-000000000d01', label: 'Capture route', projectId: 'tst-app' },
    { alias: 'subj-2', id: '00000000-0000-4000-8000-000000000d02', label: 'Release flow', projectId: 'tst-other' },
  ]
  const observation = {
    alias: 'obs-1',
    id: '00000000-0000-4000-8000-000000000d11',
    kind: 'fact',
    subjectId: subjects[0]!.id,
    subjectLabel: 'Capture route',
    projectId: 'tst-app',
    workspaceId: 'tst-ws',
    content: 'The capture route answers on port 3000.',
    occurredAt: '2026-03-01T00:00:00.000Z',
  }
  const propose = (over: object) => ({
    index: 0,
    claim: 'The capture route answers on port 3850.',
    quote: 'answers on port 3850',
    kind: 'fact' as const,
    subject: { id: 'subj-1' },
    evidence: [1],
    supersedes: [],
    ...over,
  })

  it('supersedes an older observation on the same subject, and refuses a newer one', () => {
    const older = gateSalvage(window, { subjects, observations: [observation] }, [propose({ supersedes: ['obs-1'] })])
    expect(older.observations[0]!.supersedes).toEqual([observation.id])

    const newer = { ...observation, occurredAt: '2026-03-05T00:00:00.000Z' }
    const refused = gateSalvage(window, { subjects, observations: [newer] }, [propose({ supersedes: ['obs-1'] })])
    expect(refused.rejected).toEqual({ supersedes_target_newer: 1 })
  })

  it('refuses a subject of another project, an unlisted alias and a repeated claim', () => {
    const result = gateSalvage(window, { subjects, observations: [] }, [
      propose({ subject: { id: 'subj-2' } }),
      propose({ subject: { id: 'subj-9' } }),
      propose({ supersedes: ['obs-4'] }),
      propose({ index: 3 }),
      propose({ index: 4, claim: 'The capture route  answers on port 3850.' }),
    ])
    expect(result.rejected).toEqual({ subject_project: 1, unknown_subject: 1, unknown_observation: 1, duplicate: 1 })
    expect(result.observations).toHaveLength(1)
  })
})

describe('legacy salvage quote rule', () => {
  const asked = row({
    role: 'user',
    producer: 'claude-code-hook',
    content: 'Asked whether the capture route still answers on port 3000.',
    occurred_at: '2026-03-04T09:00:00Z',
  })
  const said = row({
    content: 'The capture route answers on port 3850; it moved off ‘port 3000’ in March and runs in "strict" mode.',
    occurred_at: '2026-03-04T09:01:00Z',
  })
  const window = planSession(OPEN, [asked, said]).windows[0]!
  const listing = { subjects: [], observations: [] }
  const propose = (quote: string, over: object = {}) => ({
    index: 0,
    claim: 'The capture route answers on port 3850.',
    quote,
    kind: 'fact' as const,
    subject: { new: 'Capture route' },
    evidence: [1, 2],
    supersedes: [],
    ...over,
  })

  it('passes a claim citing rows 1 and 2 whose quote is only in row 2, and keeps the quote', () => {
    const result = gateSalvage(window, listing, [propose('The capture route answers on port 3850')])

    expect(result.rejected).toEqual({})
    expect(result.observations[0]).toMatchObject({
      quote: 'The capture route answers on port 3850',
      lineage: [asked.id, said.id],
    })
  })

  it('rejects a quote found only in a context-only user row, and a quote found in no row', () => {
    const result = gateSalvage(window, listing, [
      propose('Asked whether the capture route still answers on port 3000'),
      propose('The capture route answers on port 4000', { index: 1, claim: 'The capture route answers on port 4000.' }),
    ])

    expect(result.rejected).toEqual({ quote_not_found: 2 })
    expect(result.observations).toEqual([])
  })

  it('finds a quote across curly quotes and whitespace runs', () => {
    const result = gateSalvage(window, listing, [
      propose("it moved off 'port 3000'  in\n March"),
      propose('runs in “strict”   mode', { index: 1, claim: 'The capture route runs in strict mode.' }),
    ])

    expect(result.rejected).toEqual({})
    expect(result.observations).toHaveLength(2)
  })

  it('reads a row as the window shows it, so words past the row cut are not found', () => {
    const long = row({ content: `${'x'.repeat(SALVAGE_ROW_MAX_CHARS)} tail words` })
    const cut = planSession(OPEN, [long]).windows[0]!

    expect(gateSalvage(cut, listing, [propose('tail words', { evidence: [1] })]).rejected).toEqual({ quote_not_found: 1 })
  })
})

describe('legacy salvage reply cap', () => {
  const item = SALVAGE_REPLY_SCHEMA.properties.observations.items.properties
  const longestKind = [...item.kind.enum].reduce((a, b) => (b.length > a.length ? b : a))
  /** One observation with every field at the bound the schema gives it. */
  const longestItem = () => ({
    claim: 'c'.repeat(item.claim.maxLength),
    quote: 'q'.repeat(item.quote.maxLength),
    kind: longestKind,
    subject: { new: 'l'.repeat(item.subject.oneOf[1].properties.new.maxLength) },
    evidence: Array.from({ length: item.evidence.maxItems }, () => item.evidence.items.maximum),
    supersedes: Array.from({ length: item.supersedes.maxItems }, () => 'o'.repeat(item.supersedes.items.maxLength)),
  })
  const valid = {
    claim: 'The capture route answers on port 3850.',
    quote: 'answers on port 3850',
    kind: 'fact',
    subject: { id: 'subj-1' },
    evidence: [1],
    supersedes: [],
  }

  it('covers a reply of the most items it may hold, every field at its maximum, at two chars per token', () => {
    const reply = JSON.stringify({ observations: Array.from({ length: SALVAGE_REPLY_MAX_ITEMS }, longestItem) })
    const parsed = parseSalvageReply(reply)

    expect(parsed).toMatchObject({ ok: true, schemaRejected: [] })
    expect(parsed.ok && parsed.observations).toHaveLength(SALVAGE_REPLY_MAX_ITEMS)
    expect(SALVAGE_REPLY_MIN_CHARS_PER_TOKEN).toBe(2)
    expect(SALVAGE_REPLY_MAX_TOKENS * SALVAGE_REPLY_MIN_CHARS_PER_TOKEN).toBeGreaterThanOrEqual(
      `\`\`\`json\n${reply}\n\`\`\``.length,
    )
  })

  it('asks every window for the same cap, whatever the size of its prompt', async () => {
    const small = row({})
    const large = row({ session_id: LATER, content: 'z'.repeat(SALVAGE_ROW_MAX_CHARS) })
    const model = fakeModel('{"observations":[]}')
    await salvageSession(OPEN, deps(fakeStore({ rows: [small, large] }), model.intelligence))
    await salvageSession(LATER, deps(fakeStore({ rows: [small, large] }), model.intelligence))

    expect(model.requests[1]!.user.length).toBeGreaterThan(model.requests[0]!.user.length + SALVAGE_ROW_MAX_CHARS / 2)
    expect(model.requests.map((r) => r.maxTokens)).toEqual([SALVAGE_REPLY_MAX_TOKENS, SALVAGE_REPLY_MAX_TOKENS])
  })

  it('counts the items past the most a reply may hold as schema rejections', async () => {
    const items = Array.from({ length: SALVAGE_REPLY_MAX_ITEMS + 1 }, (_, i) => ({
      ...valid,
      claim: `The capture route answers on port 3850, check ${i}.`,
      subject: { new: 'Capture route' },
    }))
    const reply = JSON.stringify({ observations: items })
    expect(parseSalvageReply(reply)).toMatchObject({ ok: true, schemaRejected: [SALVAGE_REPLY_MAX_ITEMS] })

    const model = fakeModel(reply)
    const result = await salvageSession(OPEN, deps(fakeStore({ rows: [row({})] }), model.intelligence))
    const window = result.windows[0]!
    expect(window).toMatchObject({ status: 'stored', proposed: SALVAGE_REPLY_MAX_ITEMS + 1, rejected: { schema: 1 } })
    expect(window.status === 'stored' && window.observations).toHaveLength(SALVAGE_REPLY_MAX_ITEMS)
  })

  it('rejects an item past any bound the cap counts on, or without a quote', () => {
    const over = [
      { ...valid, quote: 'q'.repeat(SALVAGE_QUOTE_MAX_CHARS + 1) },
      { ...valid, quote: '   ' },
      { ...valid, evidence: [0] },
      { ...valid, evidence: [item.evidence.items.maximum + 1] },
      { ...valid, subject: { new: 'l'.repeat(item.subject.oneOf[1].properties.new.maxLength + 1) } },
      { ...valid, subject: { id: 'subj-'.padEnd(item.subject.oneOf[0].properties.id.maxLength + 1, '9') } },
      { ...valid, supersedes: Array.from({ length: item.supersedes.maxItems + 1 }, (_, i) => `obs-${i + 1}`) },
      { claim: valid.claim, kind: 'fact', subject: valid.subject, evidence: [1], supersedes: [] },
    ]
    const parsed = parseSalvageReply(JSON.stringify({ observations: [valid, ...over] }))

    expect(parsed).toMatchObject({ ok: true, schemaRejected: over.map((_, i) => i + 1) })
    expect(parsed.ok && parsed.observations.map((o) => o.index)).toEqual([0])
  })
})

describe('legacy salvage prompt version', () => {
  // Editing the prompt or the reply schema without a new version fails this pin.
  const PINNED_SHA256: Record<string, string> = {
    'legacy-salvage-v1': '1d3fef35fc8f85281172a144d035eb409b5d672928c0157bb449657da05634db',
    'legacy-salvage-v2': '80c6dd3c9b560ea967833cc7a2fce5bdf6138b1b3ce31ff828d66b014ae7b9ef',
  }

  it('pins the prompt and reply schema of the current version', () => {
    const digest = createHash('sha256')
      .update(JSON.stringify([SALVAGE_SYSTEM_PROMPT, SALVAGE_REPLY_SCHEMA]), 'utf8')
      .digest('hex')
    expect(digest).toBe(PINNED_SHA256[SALVAGE_VERSION])
  })

  it('reads only the exact reply object', () => {
    expect(parseSalvageReply('{"observations":[],"extra":1}').ok).toBe(false)
    expect(SALVAGE_SYSTEM_PROMPT.endsWith('"evidence":[1],"supersedes":[]}]}')).toBe(true)
  })
})
