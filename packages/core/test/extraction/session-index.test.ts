import { describe, expect, it } from 'vitest'

import type { DueSession, SessionIndexItem, SessionIndexSource } from '../../src/items/capture-store.js'
import {
  buildSessionIndexItem,
  clipLine,
  renderSessionIndex,
  runSessionIndexTick,
  SESSION_INDEX_IDLE_MS,
  type SessionIndexStore,
} from '../../src/extraction/session-index.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = (minute: number): Date => new Date(Date.UTC(2026, 0, 12, 8, minute, 0, 250))

const PROMPT_ONE = uuid(1)
const ANSWER = uuid(2)
const PROMPT_TWO = uuid(3)
const STATEMENT = uuid(10)
const OBSERVATION = uuid(11)

/** Two prompts, one answer, one statement, one observation, a commit, a tool-ref sha, a PR URL, two plan dirs. */
function goldenSource(over: Partial<SessionIndexSource> = {}): SessionIndexSource {
  return {
    sessionId: 'sess-golden-alpha',
    firstEventId: 41,
    lastEventId: 57,
    firstAt: at(0),
    lastAt: at(42),
    history: false,
    projects: ['tst-repo'],
    workspaces: ['tst-ws'],
    plans: ['alpha-plan', 'beta-plan'],
    utterances: [
      { id: PROMPT_ONE, kind: 'user_prompt', occurredAt: at(1), text: 'Move the cache\n\n  to   the edge tier.' },
      {
        id: ANSWER,
        kind: 'user_answer',
        occurredAt: at(5),
        text: 'Q: Which region first?\nA: The western one',
      },
      { id: PROMPT_TWO, kind: 'user_prompt', occurredAt: at(30), text: 'Ship it.' },
    ],
    hasUtterance: true,
    statements: [STATEMENT],
    observations: [OBSERVATION],
    commits: [{ repo: 'tst-repo', sha: 'c0ffee1234567890abcdef1234567890abcdef12', occurredAt: at(20) }],
    toolRefs: [
      { repo: 'tst-repo', ref: 'c0ffee1', occurredAt: at(21) },
      { repo: 'tst-repo', ref: 'beefcafe9876', occurredAt: at(10) },
      { repo: 'tst-repo', ref: 'https://github.com/tester/tst-repo/pull/17', occurredAt: at(25) },
    ],
    ledger: [{ plan: 'alpha-plan', id: 'cache-tier' }],
    currentIndex: null,
    ...over,
  }
}

const GOLDEN = [
  'Session sess-golden-alpha',
  'Project: tst-repo',
  'Workspace: tst-ws',
  'From 2026-01-12T08:00:00Z to 2026-01-12T08:42:00Z',
  'Plans: alpha-plan, beta-plan',
  'MK (3):',
  '2026-01-12T08:01:00Z Move the cache to the edge tier.',
  '2026-01-12T08:05:00Z Q: Which region first? A: The western one',
  '2026-01-12T08:30:00Z Ship it.',
  `Statements (1): ${STATEMENT}`,
  `Observations (1): ${OBSERVATION}`,
  'Commits (2): tst-repo@beefcafe9876 tst-repo@c0ffee123456',
  'PRs (1): https://github.com/tester/tst-repo/pull/17',
  'Ledger (1): alpha-plan cache-tier',
].join('\n')

describe('renderSessionIndex', () => {
  it('renders the golden text: time order, collapsed whitespace, deduplicated commits', () => {
    expect(renderSessionIndex(goldenSource())).toBe(GOLDEN)
  })

  it('writes none for empty header lists and a bare count for empty item lists', () => {
    const text = renderSessionIndex(
      goldenSource({ projects: [], workspaces: [], plans: [], statements: [], observations: [], commits: [], toolRefs: [], ledger: [] }),
    )
    expect(text).toContain('Project: none\nWorkspace: none\n')
    expect(text).toContain('Plans: none\n')
    expect(text).toContain('\nStatements (0):\nObservations (0):\nCommits (0):\nPRs (0):\nLedger (0):')
  })

  it('names the repo of a tool-ref sha whose turn had no project as unknown', () => {
    const text = renderSessionIndex(goldenSource({ commits: [], toolRefs: [{ repo: null, ref: 'abcdef1', occurredAt: at(3) }] }))
    expect(text).toContain('Commits (1): unknown@abcdef1')
  })
})

describe('clipLine', () => {
  it('keeps an emoji that straddles code point 200 whole', () => {
    // 199 code points, then a two-unit emoji at code point 200, then more.
    const text = `${'a'.repeat(199)}\u{1F600}tail`
    const clipped = clipLine(text)
    expect(Array.from(clipped)).toHaveLength(200)
    expect(clipped.endsWith('\u{1F600}')).toBe(true)
    expect(clipped).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('never ends on a lone high surrogate when the emoji is the 201st code point', () => {
    const clipped = clipLine(`${'b'.repeat(200)}\u{1F680}`)
    expect(clipped).toBe('b'.repeat(200))
  })
})

describe('buildSessionIndexItem', () => {
  it('quotes the MK utterances as lineage and keys the text with the index it replaces', () => {
    const item = buildSessionIndexItem(goldenSource())!
    expect(item.content).toBe(GOLDEN)
    expect(item.lineage).toEqual([PROMPT_ONE, ANSWER, PROMPT_TWO])
    expect(item.listed).toEqual([STATEMENT, OBSERVATION])
    expect(item.occurredAt).toEqual(at(42))
    expect(item.projectId).toBe('tst-repo')
    expect(item.workspaceId).toBe('tst-ws')
    expect(item.replaces).toBeNull()
    expect(item.source).toMatchObject({
      type: 'transcript',
      session_id: 'sess-golden-alpha',
      first_event_id: '41',
      last_event_id: '57',
    })
    expect(item.source.event_key).toMatch(/^session_index:sess-golden-alpha:[a-f0-9]{64}$/)

    const again = buildSessionIndexItem(goldenSource())!
    expect(again.source.event_key).toBe(item.source.event_key)
    const replacing = buildSessionIndexItem(
      goldenSource({ currentIndex: { id: uuid(90), content: 'older', occurredAt: at(40) } }),
    )!
    expect(replacing.replaces).toBe(uuid(90))
    expect(replacing.source.event_key).not.toBe(item.source.event_key)
  })

  it('marks a session recovered from shell history', () => {
    expect(buildSessionIndexItem(goldenSource({ history: true }))!.source.type).toBe('history')
  })

  it('gives a session with no utterance no item', () => {
    expect(buildSessionIndexItem(goldenSource({ hasUtterance: false, utterances: [] }))).toBeNull()
  })
})

/** A store whose due rule is the RPC's idle rule, judged at the injected time. */
function fakeStore(lastReceived: Date) {
  const commits: Array<{ sessionId: string; item: SessionIndexItem | null; eventId: number }> = []
  const asked: Array<{ idleSeconds: number; now: Date }> = []
  const store: SessionIndexStore = {
    async dueSessions(idleSeconds: number, _limit: number, now: Date): Promise<DueSession[]> {
      asked.push({ idleSeconds, now })
      return lastReceived.getTime() < now.getTime() - idleSeconds * 1000
        ? [{ sessionId: 'sess-golden-alpha', lastEventId: 57 }]
        : []
    },
    async sessionIndexSource() {
      return goldenSource()
    },
    async sessionIndexCommit(sessionId, item, eventId) {
      commits.push({ sessionId, item, eventId })
      return { written: true, stale: false, itemId: uuid(91) }
    },
  }
  return { store, commits, asked }
}

describe('runSessionIndexTick', () => {
  it('builds an idle session only once 30 minutes have passed on the injected clock', async () => {
    const received = at(42)
    const { store, commits, asked } = fakeStore(received)
    const log: string[] = []

    const early = await runSessionIndexTick({
      store,
      now: () => new Date(received.getTime() + SESSION_INDEX_IDLE_MS - 1000),
      log: (l) => log.push(l),
    })
    expect(early).toMatchObject({ due: 0, written: 0 })
    expect(commits).toHaveLength(0)

    const late = await runSessionIndexTick({
      store,
      now: () => new Date(received.getTime() + SESSION_INDEX_IDLE_MS + 1000),
      log: (l) => log.push(l),
    })
    expect(late).toMatchObject({ due: 1, written: 1, failed: 0, full: false })
    expect(asked.map((a) => a.idleSeconds)).toEqual([30 * 60, 30 * 60])
    expect(commits).toEqual([{ sessionId: 'sess-golden-alpha', item: buildSessionIndexItem(goldenSource()), eventId: 57 }])
    expect(log).toEqual([])
  })

  it('logs a failed session without its text and moves on', async () => {
    const { store } = fakeStore(at(0))
    const failing: SessionIndexStore = {
      ...store,
      async sessionIndexSource() {
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      },
    }
    const log: string[] = []
    const result = await runSessionIndexTick({ store: failing, now: () => at(59), log: (l) => log.push(l) })
    expect(result).toMatchObject({ due: 1, failed: 1, written: 0 })
    expect(log).toEqual(["session index: building one session's index failed: ECONNRESET: connection reset"])
  })
})
