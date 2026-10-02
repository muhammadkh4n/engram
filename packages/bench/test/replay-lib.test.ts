import { describe, it, expect } from 'vitest'
import type { IntelligenceAdapter } from '@engram-mem/core'
import {
  NO_PINS_FILE_SHA,
  ReplayStopped,
  assertCopyMarker,
  assertTargetNotProd,
  conversationKeys,
  createPins,
  displayedIds,
  parsePins,
  parseReplayArgs,
  parseWindow,
  resumeStep,
  runReplay,
  sha256,
  withEnv,
  type EpisodeRow,
  type ReplayDeps,
  type ReplayIdentity,
  type ReplayRecallOptions,
  type ReplayRecallResult,
  type StepLine,
} from '../src/replay/replay-lib.js'

const episode = (id: string, createdAt: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'episode', id, session_id: 'sess-a', project_id: 'engram', role: 'user',
    content: `note ${id} about the reranker config`, embedding: [0.1, 0.2], metadata: { source: 'hook' },
    created_at: createdAt, ...extra,
  })
const recall = (query: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'recall', ts, query, project_id: 'engram', session_id: null, conversation_id: null, ...extra })

const emptyResult: ReplayRecallResult = { memories: [], associations: [] }

function fakeDeps(events: ReturnType<typeof parseWindow>, overrides: Partial<ReplayDeps> = {}) {
  const calls: string[] = []
  const recallOpts: ReplayRecallOptions[] = []
  const steps: StepLine[] = []
  const deps: ReplayDeps = {
    events,
    keys: new Map(),
    startStep: 0,
    insertEpisode: async (row: EpisodeRow) => {
      calls.push(`insert ${row.id}`)
      return 'inserted'
    },
    recall: async (query, opts) => {
      calls.push(`recall ${query}`)
      recallOpts.push(opts)
      return emptyResult
    },
    aroundRecall: (fn) => fn(),
    violations: () => [],
    pinsSha: () => 'pins-sha',
    writeStep: (line) => steps.push(line),
    clock: () => 0,
    ...overrides,
  }
  return { deps, calls, recallOpts, steps }
}

const identity: ReplayIdentity = {
  arm: 'control',
  target: 'http://127.0.0.1:3901/',
  engram_dist: '/opt/engram-control',
  env: {},
  conversation_key: 'none',
  window_sha256: 'w-sha',
  pins_path: '/tmp/pins.json',
  pins_mode: 'fill',
}

describe('parseWindow and runReplay', () => {
  it('replays events in created_at order, ties in file order', async () => {
    const text = [
      recall('what reranker do we use', '2026-09-30T10:05:00Z'),
      episode('ep-2', '2026-09-30T10:03:00Z'),
      episode('ep-1', '2026-09-30T10:01:00Z'),
      recall('bm25 b parameter', '2026-09-30T10:03:00Z'),
    ].join('\n')
    const events = parseWindow(text)
    expect(events.map((e) => e.step)).toEqual([0, 1, 2, 3])
    const { deps, calls } = fakeDeps(events)
    await runReplay(deps)
    expect(calls).toEqual(['insert ep-1', 'insert ep-2', 'recall bm25 b parameter', 'recall what reranker do we use'])
  })

  it('re-runs a logged recall with reconsolidation on and the logged project', async () => {
    const events = parseWindow(recall('  how is the recall log rotated  ', '2026-09-30T10:00:00Z'))
    const { deps, recallOpts, steps } = fakeDeps(events)
    await runReplay(deps)
    expect(recallOpts).toEqual([{ projectId: 'engram', reconsolidate: true }])
    expect(steps[0]).toMatchObject({ step: 0, kind: 'recall', query_id: 'r0', conversation_key: null, pins_sha256: 'pins-sha' })
  })

  it('sends the logged conversation id as the key in logged mode, none in none mode', async () => {
    const events = parseWindow(recall('q', '2026-09-30T10:00:00Z', { conversation_id: 'conv-7' }))
    const logged = fakeDeps(events, { keys: conversationKeys(events, 'logged') })
    await runReplay(logged.deps)
    expect(logged.recallOpts[0]).toEqual({ projectId: 'engram', conversationKey: 'conv-7', reconsolidate: true })
    expect(conversationKeys(events, 'none').size).toBe(0)
  })

  it('inserts a missing embedding as null and counts it', async () => {
    const events = parseWindow(episode('ep-1', '2026-09-30T10:00:00Z', { embedding: null }))
    const rows: EpisodeRow[] = []
    const { deps, steps } = fakeDeps(events, { insertEpisode: async (row) => (rows.push(row), 'inserted') })
    const counts = await runReplay(deps)
    expect(rows[0]).toMatchObject({ id: 'ep-1', embedding: null, created_at: '2026-09-30T10:00:00Z', project_id: 'engram' })
    expect(counts).toEqual({ episodesInserted: 1, episodesPresent: 0, nullEmbeddings: 1, recalls: 0 })
    expect(steps[0]).toMatchObject({ kind: 'episode', embedding: 'null', inserted: true })
  })

  it('skips steps before the resume point but keeps query ids stable', async () => {
    const events = parseWindow([recall('a', '2026-09-30T10:00:00Z'), recall('b', '2026-09-30T10:01:00Z')].join('\n'))
    const { deps, calls, steps } = fakeDeps(events, { startStep: 1 })
    await runReplay(deps)
    expect(calls).toEqual(['recall b'])
    expect(steps[0]).toMatchObject({ step: 1, query_id: 'r1' })
  })

  it('stops on a violation before writing the step', async () => {
    const events = parseWindow(recall('a', '2026-09-30T10:00:00Z'))
    const { deps, steps } = fakeDeps(events, { violations: () => ['strict pin misses'] })
    await expect(runReplay(deps)).rejects.toBeInstanceOf(ReplayStopped)
    expect(steps).toEqual([])
  })

  it('rejects malformed lines with their line number', () => {
    expect(() => parseWindow('{"kind":"recall","ts":"nope","query":"q"}')).toThrow(/line 1: ts is not a timestamp/)
    expect(() => parseWindow('\n{"kind":"other"}')).toThrow(/line 2: kind/)
  })
})

describe('conversation keys', () => {
  it('sessionize groups recalls per project with a 30-minute inactivity gap', () => {
    const events = parseWindow([
      recall('a', '2026-09-30T10:00:00Z'),
      recall('b', '2026-09-30T10:29:00Z'),
      recall('c', '2026-09-30T10:30:00Z', { project_id: 'aithentic-inc' }),
      recall('d', '2026-09-30T11:00:01Z'),
    ].join('\n'))
    const keys = conversationKeys(events, 'sessionize')
    expect([...keys.values()]).toEqual(['sessionize:engram:1', 'sessionize:engram:1', 'sessionize:aithentic-inc:1', 'sessionize:engram:2'])
  })
})

describe('copy guards', () => {
  it.each([
    'http://127.0.0.1:3001',
    'http://localhost:3001/',
    'http://[::1]:3001',
    'https://rexvps:8443',
    'http://rexvps.tail1234.ts.net:3901',
  ])('refuses the prod-like target %s', (target) => {
    expect(() => assertTargetNotProd(target)).toThrow()
  })

  it('accepts a local copy on another port', () => {
    expect(assertTargetNotProd('http://127.0.0.1:3901').port).toBe('3901')
  })

  it('refuses a target without the marker table, with a mismatched arm, or with several rows', () => {
    expect(() => assertCopyMarker({ error: 'relation "engram_replay_copy" does not exist' }, 'control')).toThrow(/no readable/)
    expect(() => assertCopyMarker({ rows: [{ arm: 'treatment' }] }, 'control')).toThrow(/each arm needs its own copy/)
    expect(() => assertCopyMarker({ rows: [] }, 'control')).toThrow(/exactly one row/)
    expect(() => assertCopyMarker({ rows: [{ arm: 'control' }, { arm: 'control' }] }, 'control')).toThrow(/exactly one row/)
    expect(() => assertCopyMarker({ rows: [{ arm: 'control' }] }, 'control')).not.toThrow()
  })
})

describe('pins', () => {
  const intel = (counter: { n: number }): IntelligenceAdapter => ({
    embed: async (t: string) => (counter.n++, [t.length]),
    expandQuery: async (q: string) => (counter.n++, [`${q} expanded`]),
    summarize: async () => ({ text: 'summary', topics: [], entities: [] }) as never,
    dimensions: () => 1,
  })

  it('strict pins throw on a miss without calling the model', async () => {
    const counter = { n: 0 }
    const pins = createPins(parsePins(JSON.stringify({ embed: { known: [1] } })), 'sha0', 'strict', () => {
      throw new Error('strict pins must not write')
    })
    const wrapped = pins.wrap(intel(counter))
    await expect(wrapped.embed!('known')).resolves.toEqual([1])
    await expect(wrapped.embed!('unknown')).rejects.toThrow(/strict pins/)
    await expect(wrapped.expandQuery!('q')).rejects.toThrow(/strict pins/)
    expect(counter.n).toBe(0)
    expect(pins.stats.misses.map((m) => m.bucket)).toEqual(['embed', 'expand'])
    expect(pins.flush()).toBe('sha0')
  })

  it('fill pins call once per text and flush writes the file the sha names', async () => {
    const counter = { n: 0 }
    let saved = ''
    const pins = createPins(parsePins(null), NO_PINS_FILE_SHA, 'fill', (json) => (saved = json))
    const wrapped = pins.wrap(intel(counter))
    await wrapped.embed!('abc')
    await wrapped.embed!('abc')
    expect(counter.n).toBe(1)
    const sha = pins.flush()
    expect(sha).toBe(sha256(saved))
    expect(parsePins(saved).embed).toEqual({ abc: [3] })
  })

  it('blocks and counts model calls that are not pinned recall calls', async () => {
    const pins = createPins(parsePins(null), NO_PINS_FILE_SHA, 'fill', () => {})
    const wrapped = pins.wrap(intel({ n: 0 }))
    expect(() => wrapped.summarize!('text', {} as never)).toThrow(/blocked/)
    expect(pins.stats.blocked).toEqual({ summarize: 1 })
    expect(wrapped.dimensions!()).toBe(1)
  })
})

describe('resume', () => {
  const steps = (n: number, pinsSha = 'p1') =>
    Array.from({ length: n }, (_, step) => JSON.stringify({ step, at: '', kind: 'recall', pins_sha256: pinsSha })).join('\n') + '\n'

  it('starts at 0 without a step log and at N + 1 after step N when arm and pins match', () => {
    expect(resumeStep({ stepsText: null, recorded: null, identity, pinsSha: 'p1' })).toBe(0)
    expect(resumeStep({ stepsText: steps(3), recorded: identity, identity, pinsSha: 'p1' })).toBe(3)
  })

  it('refuses a mismatched arm', () => {
    expect(() =>
      resumeStep({ stepsText: steps(3), recorded: identity, identity: { ...identity, arm: 'no-access-bonus' }, pinsSha: 'p1' }),
    ).toThrow(/differs from the logged one in arm/)
    expect(() =>
      resumeStep({ stepsText: steps(3), recorded: identity, identity: { ...identity, env: { ENGRAM_RECALL_FUSION: '{}' } }, pinsSha: 'p1' }),
    ).toThrow(/in env/)
  })

  it('refuses pins that changed since the last step', () => {
    expect(() => resumeStep({ stepsText: steps(2), recorded: identity, identity, pinsSha: 'p2' })).toThrow(/pins file changed/)
  })
})

describe('displayedIds', () => {
  it('lists recalled ids ranked in payload order and the rest as associated with their tier', () => {
    const result: ReplayRecallResult = {
      memories: [{ id: 'm1', type: 'semantic' }, { id: 'm2', type: 'episode' }],
      associations: [{ id: 'a1', type: 'digest' }],
      payload: { items: [{ section: 'recalled', id: 'm2' }, { section: 'recalled', id: 'm1' }, { section: 'associations', id: 'a1' }, { section: 'recalled' }] },
    }
    expect(displayedIds(result)).toEqual({
      emitted: [{ id: 'm2', tier: 'episode', rank: 1 }, { id: 'm1', tier: 'semantic', rank: 2 }],
      associated: [{ id: 'a1', tier: 'digest', section: 'associations' }],
    })
  })
})

describe('withEnv and arguments', () => {
  it('sets the arm env for the call and restores it afterwards, even on error', async () => {
    const env: NodeJS.ProcessEnv = { KEEP: 'old' }
    await expect(
      withEnv({ KEEP: 'new', ADDED: '1' }, async () => {
        expect(env).toEqual({ KEEP: 'new', ADDED: '1' })
        throw new Error('boom')
      }, env),
    ).rejects.toThrow('boom')
    expect(env).toEqual({ KEEP: 'old' })
  })

  it('parses the CLI flags with defaults and refuses unknown ones', () => {
    const args = parseReplayArgs([
      '--window', 'w.jsonl', '--target', 'http://127.0.0.1:3901', '--key-env', 'K', '--engram-dist', '/opt/e',
      '--arm', 'control', '--env', 'A=1', '--env', 'B=x=y', '--pins', 'p.json', '--out', 'out',
    ])
    expect(args).toMatchObject({ env: { A: '1', B: 'x=y' }, conversationKey: 'none', pinsMode: 'fill' })
    expect(() => parseReplayArgs(['--bogus', '1'])).toThrow(/unknown flag/)
    expect(() => parseReplayArgs(['--window', 'w'])).toThrow(/--target is required/)
  })
})
