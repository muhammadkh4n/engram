import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CompleteJsonRequest } from '@engram-mem/core'
import {
  gateSalvage,
  type LegacyRow,
  planSession,
  SALVAGE_ROW_MAX_CHARS,
  SALVAGE_WINDOW_MAX_CHARS,
  type SalvageObservationRow,
  salvageSession,
  salvageSessions,
  type SalvageStore,
  type SalvageSubjectRow,
} from '../../src/backfill/salvage.js'
import {
  parseSalvageReply,
  SALVAGE_REPLY_SCHEMA,
  SALVAGE_SYSTEM_PROMPT,
  SALVAGE_VERSION,
} from '../../src/backfill/salvage-prompt.js'

const OPEN = 'tst-salvage-open'
const COVERED = 'tst-salvage-covered'
const LATER = 'tst-salvage-later'

interface Recorded {
  rows: LegacyRow[]
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
  }
}

function fakeModel(reply: string) {
  const requests: CompleteJsonRequest[] = []
  return {
    requests,
    intelligence: {
      completeJson: async (req: CompleteJsonRequest) => {
        requests.push(req)
        return { text: reply, finishReason: 'stop', model: 'tst-model' }
      },
    },
  }
}

async function gatedRun(name: string) {
  const fixture = recorded(name)
  const model = fakeModel(fixture.reply)
  const result = await salvageSession(OPEN, { store: fakeStore({ rows: fixture.rows }), intelligence: model.intelligence })
  const window = result.windows[0]!
  if (window.status !== 'gated') throw new Error(`window not gated: ${window.status}`)
  return { fixture, window, model }
}

describe('legacy salvage gate on recorded replies', () => {
  it('rejects a decision put in our mouth and keeps the knowledge the same row states', async () => {
    const { fixture, window, model } = await gatedRun('salvage-we-decided')
    const assistant = fixture.rows[1]!

    expect(window.rejected).toEqual({ attributed: 1 })
    expect(window.observations).toHaveLength(1)
    expect(window.observations[0]).toMatchObject({
      claim: 'The store runs on Postgres only',
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
})

describe('legacy salvage rows', () => {
  it('skips a session the store holds a transcript utterance for', async () => {
    const rows = [row({ session_id: OPEN }), row({ session_id: COVERED })]
    const store = fakeStore({ rows, transcript: [COVERED] })
    const model = fakeModel('{"observations":[]}')

    expect((await salvageSessions(store)).map((s) => s.sessionId)).toEqual([OPEN])
    const covered = await salvageSession(COVERED, { store, intelligence: model.intelligence })
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
    const result = await salvageSession(OPEN, { store: fakeStore({ rows }), intelligence: model.intelligence })

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

  it('returns an unreadable window instead of gating a reply that is not the reply object', async () => {
    const model = fakeModel('I found nothing durable here.')
    const result = await salvageSession(OPEN, { store: fakeStore({ rows: [row({})] }), intelligence: model.intelligence })
    expect(result.windows[0]).toMatchObject({ status: 'unreadable', fault: 'parse' })
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

describe('legacy salvage prompt version', () => {
  // Editing the prompt or the reply schema without a new version fails this pin.
  const PINNED_SHA256: Record<string, string> = {
    'legacy-salvage-v1': '1d3fef35fc8f85281172a144d035eb409b5d672928c0157bb449657da05634db',
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
