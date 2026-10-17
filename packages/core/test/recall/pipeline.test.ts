import { describe, expect, it, vi } from 'vitest'
import { CandidateQueryError, type Candidate, type CandidateRequest } from '../../src/items/item-store.js'
import type { FloorCalibration } from '../../src/recall/floor-calibration.js'
import type { RerankOptions } from '../../src/adapters/intelligence.js'
import {
  RecallAbortedError,
  RecallNotCalibratedError,
  RecallRequestError,
  runRecall,
  scoreSlate,
  type RecallAbortStage,
  type RecallDeps,
} from '../../src/recall/pipeline.js'
import type { AssociationLink, AssociationRequest, RecallItemRow, RecallRequest, RecallStore } from '../../src/recall/types.js'

const FLOOR: FloorCalibration = {
  reranker: 'tst-reranker',
  floor: 0.3,
  strong: 0.7,
  calibratedAt: '2026-02-03T04:00:00Z',
  dataset: 'tst',
  neededInSlate: 0,
  neededBelowFloor: 0,
}
const T0 = new Date('2026-02-03T04:00:00Z')

function row(id: string, overrides: Partial<RecallItemRow> = {}): RecallItemRow {
  return {
    id,
    class: 'document_section',
    kind: 'note',
    speaker: 'artifact',
    trust: 1,
    projectId: null,
    workspaceId: null,
    planSlug: null,
    sessionId: null,
    subjectLabel: null,
    contentHead: `text of ${id}`,
    contentLength: 10,
    question: null,
    searchHead: `search ${id}`,
    occurredAt: T0,
    supersededBy: null,
    retired: false,
    restated: 0,
    source: { type: 'vault' },
    requested: true,
    currentId: id,
    chain: 'current',
    endExcluded: false,
    ...overrides,
  }
}

interface Fixture {
  rows?: RecallItemRow[]
  /** Candidates per call, by call index; the last repeats. */
  candidates?: Candidate[][]
  scores?: Record<string, number>
  projects?: Array<{ id: string; kind: string }>
  workspaces?: Record<string, string>
  links?: AssociationLink[]
}

const cand = (itemId: string, leg: Candidate['leg'], rank: number): Candidate => ({ itemId, leg, rank, rawScore: 0, path: null })

function setup(fx: Fixture = {}, overrides: Partial<RecallDeps> = {}) {
  const rows = new Map((fx.rows ?? []).map((r) => [r.id, r]))
  const candidateCalls: CandidateRequest[] = []
  const itemCalls: string[][] = []
  const rerankCalls: string[][] = []
  const associationCalls: AssociationRequest[] = []
  let version = 7
  const store: RecallStore = {
    candidates: vi.fn(async (req: CandidateRequest) => {
      candidateCalls.push(req)
      const lists = fx.candidates ?? [[]]
      return lists[Math.min(candidateCalls.length - 1, lists.length - 1)]!
    }),
    items: vi.fn(async (ids: readonly string[]) => {
      itemCalls.push([...ids])
      return ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []))
    }),
    associations: vi.fn(async (a: AssociationRequest) => {
      associationCalls.push(a)
      return fx.links ?? []
    }),
    registerTokens: vi.fn(async () => []),
    storeVersion: vi.fn(async () => version++),
    itemStates: vi.fn(async () => []),
    projectWorkspace: vi.fn(async (id: string) => fx.workspaces?.[id] ?? null),
    projects: vi.fn(async () => fx.projects ?? []),
    cacheGet: vi.fn(async () => []),
    cachePut: vi.fn(async (_step, key, versionId, output) => ({
      key,
      version: versionId,
      vector: output.vector ? [...output.vector] : null,
      phrases: output.phrases ? [...output.phrases] : null,
      passage: output.passage ?? null,
    })),
  }
  const deps: RecallDeps = {
    store,
    embed: vi.fn(async () => [1, 0, 0]),
    rerank: {
      id: 'tst-reranker',
      rerank: vi.fn(async (_q: string, docs: ReadonlyArray<{ id: string; content: string }>) => {
        rerankCalls.push(docs.map((d) => d.id))
        return docs.map((d) => ({ id: d.id, score: fx.scores?.[d.id] ?? 0.5 }))
      }),
    },
    expand: vi.fn(async () => ['tst phrase']),
    hyde: vi.fn(async () => 'a tst passage'),
    referenceDate: (now: Date) => now.toISOString().slice(0, 10),
    floor: FLOOR,
    versions: { embedding: 'openai:tst:3', chat: 'tst-chat:1' },
    now: () => T0,
    ...overrides,
  }
  return { deps, store, candidateCalls, itemCalls, rerankCalls, associationCalls }
}

const req = (overrides: Partial<RecallRequest> = {}): RecallRequest => ({
  query: 'reranker floor value',
  channel: 'mcp',
  scope: {},
  ...overrides,
})

describe('runRecall', () => {
  it('refuses an uncalibrated reranker before any store call', async () => {
    const { deps, store } = setup({}, { floor: null })
    await expect(runRecall(deps, req())).rejects.toBeInstanceOf(RecallNotCalibratedError)
    await expect(runRecall(deps, req())).rejects.toThrow('recall is not calibrated for reranker tst-reranker')
    expect(store.storeVersion).not.toHaveBeenCalled()
    expect(store.candidates).not.toHaveBeenCalled()
  })

  it('refuses a floor measured for another reranker before any store call', async () => {
    const { deps, store } = setup({}, { floor: { ...FLOOR, reranker: 'tst-other-reranker' } })
    await expect(runRecall(deps, req())).rejects.toThrow('recall is not calibrated for reranker tst-reranker')
    expect(store.storeVersion).not.toHaveBeenCalled()
  })

  it('refuses a request its filters cannot answer before any store call', async () => {
    const { deps, store } = setup()
    await expect(runRecall(deps, req({ kinds: ['commit'] }))).rejects.toBeInstanceOf(RecallRequestError)
    expect(store.storeVersion).not.toHaveBeenCalled()
  })

  it('sends one candidate call with the effective filters and every input', async () => {
    const { deps, candidateCalls } = setup({ projects: [{ id: 'tst-repo', kind: 'project' }] })
    await runRecall(deps, req({ query: 'when did tst-repo pin src/index.ts?', scope: { projectId: 'tst-repo' }, excludeSessionId: 'tst-session', asOf: T0 }))
    expect(candidateCalls).toHaveLength(1)
    const call = candidateCalls[0]!
    expect(call.k).toBe(50)
    expect(call.includeHistory).toBe(false)
    expect(call.projectId).toBe('tst-repo')
    expect(call.excludeSessionId).toBe('tst-session')
    expect(call.asOf).toEqual(T0)
    expect(call.embedding).toEqual([1, 0, 0])
    expect(call.hydeEmbedding).toEqual([1, 0, 0])
    expect(call.query).toBe('when did tst-repo pin src/index.ts?')
    expect(call.terms).toEqual(['tst-repo', 'pin', 'src/index.ts', 'tst', 'phrase'])
    expect(call.entities).toEqual(['tst-repo', 'src/index.ts'])
    expect(call.classes).toEqual(['utterance', 'mk_statement', 'observation', 'artifact', 'document_section'])
  })

  it('runs expansion only for a temporal, multi-hop or lookup question, and HyDE only for temporal or multi-hop', async () => {
    // An item that passes, so the rescue does not run HyDE either.
    const passing = { rows: [row('ok')], candidates: [[cand('ok', 'bm25', 1)]] }
    const plain = setup(passing)
    await runRecall(plain.deps, req({ query: 'reranker floor value' }))
    expect(plain.deps.expand).not.toHaveBeenCalled()
    expect(plain.deps.hyde).not.toHaveBeenCalled()

    const lookup = setup(passing)
    await runRecall(lookup.deps, req({ query: 'which reranker floor?' }))
    expect(lookup.deps.expand).toHaveBeenCalledTimes(1)
    expect(lookup.deps.hyde).not.toHaveBeenCalled()

    const temporal = setup()
    await runRecall(temporal.deps, req({ query: 'what changed last week' }))
    expect(temporal.deps.expand).toHaveBeenCalledWith('what changed last week', { now: T0, temperature: 0 })
    expect(temporal.deps.hyde).toHaveBeenCalledWith('what changed last week', { temperature: 0 })
  })

  it('reranks a slate of 50 in fused order and keeps items at or above the floor', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`item-${String(i).padStart(2, '0')}`))
    const scores: Record<string, number> = {}
    rows.forEach((r, i) => (scores[r.id] = i % 2 === 0 ? 0.31 : 0.29))
    const { deps, itemCalls, rerankCalls } = setup({
      rows,
      candidates: [rows.map((r, i) => cand(r.id, 'bm25', i + 1))],
      scores,
    })
    const { response, trace } = await runRecall(deps, req({ limit: 30 }))
    expect(itemCalls[0]).toHaveLength(50)
    expect(rerankCalls[0]).toEqual(rows.slice(0, 50).map((r) => r.id))
    expect(response.items).toHaveLength(25)
    expect(response.items.every((i) => Number(i.id.slice(5)) % 2 === 0)).toBe(true)
    expect(trace.counts).toEqual({ candidates: 60, slate: 50, scored: 50, passed: 25, associations: 0 })
  })

  it('reranks the subject label and the search text', async () => {
    const { deps } = setup({ rows: [row('a', { subjectLabel: 'tst subject' })], candidates: [[cand('a', 'bm25', 1)]] })
    await runRecall(deps, req())
    expect(deps.rerank.rerank).toHaveBeenCalledWith(
      'reranker floor value',
      [{ id: 'a', content: 'tst subject\nsearch a' }],
      expect.objectContaining({ priority: expect.any(Number) }),
    )
  })

  it('orders band A before band B, then tier and trust, and applies the limit', async () => {
    const rows = [
      row('b-band', { trust: 0, projectId: 'tst-repo' }),
      row('far-mk', { trust: 0, projectId: 'tst-far' }),
      row('own-obs', { trust: 2, projectId: 'tst-repo', class: 'observation', kind: 'fact', speaker: 'assistant' }),
    ]
    const { deps } = setup({
      rows,
      candidates: [rows.map((r, i) => cand(r.id, 'bm25', i + 1))],
      scores: { 'b-band': 0.5, 'far-mk': 0.9, 'own-obs': 0.8 },
      projects: [{ id: 'tst-repo', kind: 'project' }],
    })
    const { response } = await runRecall(deps, req({ scope: { projectId: 'tst-repo' }, limit: 2 }))
    expect(response.items.map((i) => i.id)).toEqual(['own-obs', 'far-mk'])
    expect(response.omitted).toEqual({ limit: 1, budget: 0, uncuttable: 0 })
  })

  it('rescues with HyDE once, only when nothing passed and HyDE did not run', async () => {
    const first = [row('weak-1'), row('weak-2')]
    const found = row('found')
    const { deps, candidateCalls, rerankCalls } = setup({
      rows: [...first, found],
      candidates: [first.map((r, i) => cand(r.id, 'bm25', i + 1)), [cand('found', 'hyde', 1), cand('weak-1', 'hyde', 2)]],
      scores: { 'weak-1': 0.1, 'weak-2': 0.1, found: 0.9 },
    })
    const { response, trace } = await runRecall(deps, req())
    expect(candidateCalls).toHaveLength(2)
    const second = candidateCalls[1]!
    expect(second.hydeEmbedding).toEqual([1, 0, 0])
    expect(second.embedding).toBeUndefined()
    expect(second.terms).toBeUndefined()
    expect(second.query).toBeUndefined()
    expect(rerankCalls).toEqual([['weak-1', 'weak-2'], ['found']])
    expect(response.items.map((i) => i.id)).toEqual(['found'])
    expect(trace.steps).toEqual({ expansion: false, hyde: true, rescue: true })
  })

  it('does not rescue when an item passed or HyDE already ran', async () => {
    const passed = setup({ rows: [row('ok')], candidates: [[cand('ok', 'bm25', 1)]], scores: { ok: 0.5 } })
    await runRecall(passed.deps, req())
    expect(passed.candidateCalls).toHaveLength(1)

    const ran = setup({ rows: [row('weak')], candidates: [[cand('weak', 'bm25', 1)]], scores: { weak: 0.1 } })
    const { trace } = await runRecall(ran.deps, req({ query: 'what changed last week' }))
    expect(ran.candidateCalls).toHaveLength(1)
    expect(trace.steps.rescue).toBe(false)
  })

  it('searches without vectors when the embedding fails', async () => {
    const { deps, candidateCalls } = setup({}, { embed: vi.fn(async () => Promise.reject(new Error('tst embedder down'))) })
    const { response } = await runRecall(deps, req({ query: 'what changed last week' }))
    expect(response.degraded).toEqual({ vector: 'tst embedder down', hyde: 'tst embedder down' })
    expect(candidateCalls[0]!.embedding).toBeUndefined()
    expect(candidateCalls[0]!.hydeEmbedding).toBeUndefined()
    expect(candidateCalls).toHaveLength(1)
  })

  it('goes on without expansion or HyDE when they fail', async () => {
    const { deps, candidateCalls } = setup(
      {},
      { expand: vi.fn(async () => Promise.reject(new Error('tst expand down'))), hyde: vi.fn(async () => Promise.reject(new Error('tst hyde down'))) },
    )
    const { response } = await runRecall(deps, req({ query: 'what changed last week' }))
    expect(response.degraded).toEqual({ expansion: 'tst expand down', hyde: 'tst hyde down' })
    expect(candidateCalls[0]!.embedding).toEqual([1, 0, 0])
    expect(candidateCalls[0]!.hydeEmbedding).toBeUndefined()
  })

  it('keeps the fused order with no floor or bands when the reranker throws', async () => {
    const rows = [row('first'), row('second', { trust: 1 })]
    const { deps } = setup(
      { rows, candidates: [[cand('first', 'bm25', 1), cand('second', 'bm25', 2)]] },
      { rerank: { id: 'tst-reranker', rerank: vi.fn(async () => Promise.reject(new Error('tst rerank down'))) } },
    )
    const { response, trace } = await runRecall(deps, req())
    expect(response.degraded).toEqual({ rerank: 'tst rerank down' })
    expect(response.items.map((i) => i.id)).toEqual(['first', 'second'])
    expect(trace.steps.rescue).toBe(false)
  })

  it('calls the candidate statement once when it fails, and fails the recall', async () => {
    const { deps, store } = setup()
    vi.mocked(store.candidates).mockRejectedValue(new CandidateQueryError('engram_item_candidates', '22023', 'tst refusal'))
    await expect(runRecall(deps, req())).rejects.toBeInstanceOf(CandidateQueryError)
    expect(store.candidates).toHaveBeenCalledTimes(1)
  })

  it('sends no project from a workspace root and marks an unknown project', async () => {
    const root = setup()
    await runRecall(root.deps, req({ scope: { atRoot: true } }))
    expect(root.candidateCalls[0]!.projectId).toBeUndefined()
    expect(root.store.projectWorkspace).not.toHaveBeenCalled()

    const unknown = setup({ projects: [{ id: 'tst-repo', kind: 'project' }] })
    const { trace } = await runRecall(unknown.deps, req({ scope: { projectId: 'tst-unknown' } }))
    expect(trace.projectKnown).toBe(false)
  })

  it('reads the store version before and after, and records what ran', async () => {
    const { deps } = setup({ rows: [row('a')], candidates: [[cand('a', 'bm25', 1)]] })
    const { trace } = await runRecall(deps, req())
    expect(trace.storeVersion).toEqual([7, 8])
    expect(trace).toMatchObject({ reranker: 'tst-reranker', floor: 0.3, strong: 0.7, referenceDate: '2026-02-03', cacheFailures: 0 })
  })

  it('shows the current successor the store read for a replaced match, flagged, with the register tokens of its time', async () => {
    const a = row('a', { chain: 'superseded', currentId: 'b', supersededBy: 'b', contentHead: 'old tst-legacy-db note' })
    const b = row('b', { requested: false, occurredAt: new Date('2026-02-03T05:00:00Z'), contentHead: 'tst-legacy-db is gone' })
    const { deps, store } = setup({ rows: [a, b], candidates: [[cand('a', 'bm25', 1)]] })
    vi.mocked(store.items).mockResolvedValueOnce([a, b])
    vi.mocked(store.registerTokens).mockResolvedValueOnce([{ registerId: 'R-TST-0', token: 'tst-legacy-db' }])
    const { response } = await runRecall(deps, req({ asOf: T0 }))
    expect(response.items.map((i) => [i.id, i.status, i.flags])).toEqual([['b', 'current', ['contradicted_by:R-TST-0', 'supersedes:a']]])
    expect(store.registerTokens).toHaveBeenCalledWith(T0)
    expect(deps.rerank.rerank).toHaveBeenCalledWith(
      'reranker floor value',
      [{ id: 'a', content: 'search a' }],
      expect.objectContaining({ priority: expect.any(Number) }),
    )
  })

  it('reads no register tokens when no document section can be shown', async () => {
    const stmt = row('s', { class: 'mk_statement', kind: 'ruling', speaker: 'mk', trust: 0 })
    const { deps, store } = setup({ rows: [stmt], candidates: [[cand('s', 'bm25', 1)]] })
    await runRecall(deps, req())
    expect(store.registerTokens).not.toHaveBeenCalled()
  })

  it('shows the question only for an MK statement and returns verbatim text', async () => {
    const rows = [
      row('stmt', { class: 'mk_statement', kind: 'ruling', speaker: 'mk', trust: 0, question: 'tst question?' }),
      row('note', { question: 'tst context' }),
    ]
    const { deps } = setup({ rows, candidates: [rows.map((r, i) => cand(r.id, 'bm25', i + 1))] })
    const { response } = await runRecall(deps, req())
    const byId = new Map(response.items.map((i) => [i.id, i]))
    expect(byId.get('stmt')!.question).toBe('tst question?')
    expect(byId.get('note')!.question).toBeUndefined()
    expect(byId.get('note')!.text).toBe('text of note')
  })
})

describe('runRecall associations', () => {
  const link = (itemId: string, source: AssociationLink['source'], seedId: string, rank = 1): AssociationLink => ({ itemId, source, seedId, rank })
  const queryRows = ['q1', 'q2', 'q3', 'q4'].map((id) => row(id))

  it('follows the first three shown query items and shows new linked items at or above the floor after them', async () => {
    const assoc = [row('a1'), row('a2'), row('a3')]
    const { deps, associationCalls, itemCalls, rerankCalls } = setup({
      rows: [...queryRows, ...assoc],
      candidates: [queryRows.map((r, i) => cand(r.id, 'bm25', i + 1))],
      scores: { a1: 0.8, a2: 0.1, a3: 0.5 },
      links: [link('a2', 'subject', 'q1'), link('a1', 'entity', 'q1'), link('q2', 'lineage', 'q1'), link('a3', 'subject', 'q2')],
    })
    const { response, trace } = await runRecall(deps, req())
    expect(associationCalls).toEqual([
      {
        seedIds: ['q1', 'q2', 'q3'],
        classes: ['utterance', 'mk_statement', 'observation', 'artifact', 'document_section'],
        kinds: associationCalls[0]!.kinds,
        includeHistory: false,
        perSource: 2,
      },
    ])
    expect(itemCalls.at(-1)).toEqual(['a2', 'a1', 'a3'])
    expect(rerankCalls.at(-1)).toEqual(['a2', 'a1', 'a3'])
    expect(response.items.map((i) => [i.id, i.via])).toEqual([
      ['q1', 'query'],
      ['q2', 'query'],
      ['q3', 'query'],
      ['q4', 'query'],
      ['a1', 'association'],
      ['a3', 'association'],
    ])
    expect(trace.counts.associations).toBe(2)
  })

  it('gives the association call the same filters as the candidate call', async () => {
    const { deps, associationCalls, candidateCalls } = setup({ rows: queryRows, candidates: [queryRows.map((r, i) => cand(r.id, 'bm25', i + 1))] })
    await runRecall(deps, req({ channel: 'prompt', excludeSessionId: 'tst-session', asOf: T0, includeHistory: false }))
    const a = associationCalls[0]!
    const c = candidateCalls[0]!
    expect([a.classes, a.kinds, a.maxObservationTrust, a.excludeSessionId, a.asOf]).toEqual([c.classes, c.kinds, 2, 'tst-session', T0])
  })

  it('follows no link when the reranker failed on the query items', async () => {
    const { deps, store } = setup({ rows: queryRows, candidates: [queryRows.map((r, i) => cand(r.id, 'bm25', i + 1))] })
    vi.mocked(deps.rerank.rerank).mockRejectedValue(new Error('tst reranker down'))
    const { response } = await runRecall(deps, req())
    expect(store.associations).not.toHaveBeenCalled()
    expect(response.degraded?.rerank).toBeDefined()
  })

  it('drops the associations, keeping the query items, when their rerank fails', async () => {
    const { deps } = setup({
      rows: [...queryRows, row('a1')],
      candidates: [queryRows.map((r, i) => cand(r.id, 'bm25', i + 1))],
      links: [link('a1', 'subject', 'q1')],
    })
    const rerank = vi.mocked(deps.rerank.rerank)
    const first = rerank.getMockImplementation()!
    rerank.mockImplementationOnce(first).mockRejectedValueOnce(new Error('tst reranker down'))
    const { response } = await runRecall(deps, req())
    expect(response.items.map((i) => i.id)).toEqual(['q1', 'q2', 'q3', 'q4'])
    expect(response.degraded?.rerank).toBeDefined()
  })

  it('follows no link when the limit is already filled, and counts the rest as over the limit', async () => {
    const { deps, store } = setup({ rows: queryRows, candidates: [queryRows.map((r, i) => cand(r.id, 'bm25', i + 1))] })
    const { response } = await runRecall(deps, req({ limit: 2 }))
    expect(store.associations).not.toHaveBeenCalled()
    expect(response.omitted).toEqual({ limit: 2, budget: 0, uncuttable: 0 })
  })

  it('gives byte-identical JSON for the same inputs twice', async () => {
    const run = async () => {
      const { deps } = setup({
        rows: [...queryRows, row('a1'), row('a3')],
        candidates: [queryRows.map((r, i) => cand(r.id, 'bm25', i + 1))],
        scores: { a1: 0.8, a3: 0.5 },
        links: [link('a1', 'entity', 'q1'), link('a3', 'subject', 'q2')],
      })
      return JSON.stringify((await runRecall(deps, req())).response)
    }
    expect(await run()).toBe(await run())
  })
})

describe('scoreSlate', () => {
  it('scores the whole slate with no floor, below-floor items included, and runs no rescue', async () => {
    const rows = [row('a'), row('b')]
    const { deps, candidateCalls } = setup({ rows, candidates: [rows.map((r, i) => cand(r.id, 'bm25', i + 1))], scores: { a: 0.9, b: 0.01 } }, { floor: null })
    const { items } = await scoreSlate(deps, req())
    expect(items.map((s) => [s.row.id, s.score])).toEqual([
      ['a', 0.9],
      ['b', 0.01],
    ])
    expect(candidateCalls).toHaveLength(1)
  })

  it('fails when the reranker fails, since a slate with no scores measures nothing', async () => {
    const rows = [row('a')]
    const { deps } = setup({ rows, candidates: [[cand('a', 'bm25', 1)]] })
    vi.mocked(deps.rerank.rerank).mockRejectedValue(new Error('tst reranker down'))
    await expect(scoreSlate(deps, req())).rejects.toThrow(/^the reranker failed/)
  })
})

describe('runRecall when its caller leaves', () => {
  type Step = 'resolve' | 'abort-resolve' | 'abort-reject'
  type Docs = ReadonlyArray<{ id: string; content: string }>
  const link = (itemId: string, source: AssociationLink['source'], seedId: string): AssociationLink => ({ itemId, source, seedId, rank: 1 })
  const queryRows = ['q1', 'q2', 'q3', 'q4'].map((id) => row(id))
  const queryCandidates = [queryRows.map((r, i) => cand(r.id, 'bm25', i + 1))]

  /**
   * A reranker that behaves like the queueing one: it reports its wait through
   * onSettled before settling, and per call it resolves, aborts the caller's
   * controller and then resolves anyway, or aborts and rejects with the reason.
   */
  function scripted(ctrl: AbortController, steps: Step[], opts: { waits?: number[]; scores?: Record<string, number> } = {}) {
    let calls = 0
    return {
      id: 'tst-reranker',
      rerank: vi.fn(async (_q: string, docs: Docs, options?: RerankOptions) => {
        const i = calls++
        const step = steps[Math.min(i, steps.length - 1)]!
        options?.onSettled?.({ waitMs: opts.waits?.[i] ?? 0, runMs: 1, passes: docs.length })
        if (step !== 'resolve') ctrl.abort()
        if (step === 'abort-reject') throw options?.signal?.reason ?? new Error('tst no signal')
        return docs.map((d) => ({ id: d.id, score: opts.scores?.[d.id] ?? 0.5 }))
      }),
    }
  }

  async function abortedAt(promise: Promise<unknown>): Promise<RecallAbortedError> {
    const error = await promise.then(
      () => {
        throw new Error('the recall resolved')
      },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(RecallAbortedError)
    expect((error as Error).name).toBe('RecallAbortedError')
    return error as RecallAbortedError
  }

  const expectStage = (error: RecallAbortedError, stage: RecallAbortStage): void => {
    expect(error.stage).toBe(stage)
  }

  it('stops at entry on a signal aborted before the run, calling no model, store or reranker', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const { deps, store } = setup({ rows: [row('a')], candidates: [[cand('a', 'bm25', 1)]] })

    const error = await abortedAt(runRecall(deps, req({ query: 'what changed last week' }), { signal: ctrl.signal }))

    expectStage(error, 'entry')
    expect(error.queueMs).toBe(0)
    expect(deps.embed).not.toHaveBeenCalled()
    expect(deps.expand).not.toHaveBeenCalled()
    expect(deps.hyde).not.toHaveBeenCalled()
    expect(store.storeVersion).not.toHaveBeenCalled()
    expect(deps.rerank.rerank).not.toHaveBeenCalled()
  })

  it('stops after the inputs when the caller leaves during the model steps', async () => {
    const ctrl = new AbortController()
    const embed = vi.fn(async () => {
      ctrl.abort()
      return [1, 0, 0]
    })
    const { deps, store } = setup({ rows: [row('a')], candidates: [[cand('a', 'bm25', 1)]] }, { embed })

    expectStage(await abortedAt(runRecall(deps, req(), { signal: ctrl.signal })), 'inputs')
    expect(store.candidates).not.toHaveBeenCalled()
    expect(deps.rerank.rerank).not.toHaveBeenCalled()
  })

  it('stops after the first slate even when the reranker resolves, running no rescue', async () => {
    const ctrl = new AbortController()
    const { deps, store } = setup(
      { rows: [row('weak')], candidates: [[cand('weak', 'bm25', 1)]] },
      { rerank: scripted(ctrl, ['abort-resolve'], { scores: { weak: 0.1 } }) },
    )

    expectStage(await abortedAt(runRecall(deps, req(), { signal: ctrl.signal })), 'slate')
    expect(deps.hyde).not.toHaveBeenCalled()
    expect(store.candidates).toHaveBeenCalledTimes(1)
  })

  it('stops after the rescue even when its rerank resolves, resolving nothing', async () => {
    const ctrl = new AbortController()
    const first = [row('weak-1'), row('weak-2')]
    const { deps, store } = setup(
      {
        rows: [...first, row('found')],
        candidates: [first.map((r, i) => cand(r.id, 'bm25', i + 1)), [cand('found', 'hyde', 1)]],
      },
      { rerank: scripted(ctrl, ['resolve', 'abort-resolve'], { scores: { 'weak-1': 0.1, 'weak-2': 0.1, found: 0.9 } }) },
    )

    expectStage(await abortedAt(runRecall(deps, req(), { signal: ctrl.signal })), 'rescue')
    expect(store.candidates).toHaveBeenCalledTimes(2)
    expect(store.registerTokens).not.toHaveBeenCalled()
  })

  it('stops once the query items are resolved, following no link', async () => {
    const ctrl = new AbortController()
    const { deps, store } = setup({ rows: [...queryRows, row('a1')], candidates: queryCandidates, links: [link('a1', 'subject', 'q1')] })
    vi.mocked(store.registerTokens).mockImplementation(async () => {
      ctrl.abort()
      return []
    })

    expectStage(await abortedAt(runRecall(deps, req(), { signal: ctrl.signal })), 'resolved')
    expect(store.associations).not.toHaveBeenCalled()
  })

  it('stops after the associations even when their rerank resolves, reading no closing store version', async () => {
    const ctrl = new AbortController()
    const { deps, store } = setup(
      { rows: [...queryRows, row('a1')], candidates: queryCandidates, links: [link('a1', 'subject', 'q1')] },
      { rerank: scripted(ctrl, ['resolve', 'abort-resolve'], { scores: { a1: 0.8 } }) },
    )

    expectStage(await abortedAt(runRecall(deps, req(), { signal: ctrl.signal })), 'packed')
    expect(store.associations).toHaveBeenCalledTimes(1)
    expect(store.storeVersion).toHaveBeenCalledTimes(1)
  })

  it('rejects at slate-rerank instead of degrading when the slate rerank fails because the caller left', async () => {
    const ctrl = new AbortController()
    const { deps, store } = setup(
      { rows: [row('a')], candidates: [[cand('a', 'bm25', 1)]] },
      { rerank: scripted(ctrl, ['abort-reject'], { waits: [40] }) },
    )

    const error = await abortedAt(runRecall(deps, req(), { signal: ctrl.signal }))

    expectStage(error, 'slate-rerank')
    expect(error.queueMs).toBe(40)
    expect(store.registerTokens).not.toHaveBeenCalled()
  })

  it('rejects at rescue-rerank when the rescue rerank fails because the caller left', async () => {
    const ctrl = new AbortController()
    const first = [row('weak-1')]
    const { deps } = setup(
      { rows: [...first, row('found')], candidates: [[cand('weak-1', 'bm25', 1)], [cand('found', 'hyde', 1)]] },
      { rerank: scripted(ctrl, ['resolve', 'abort-reject'], { waits: [10, 30], scores: { 'weak-1': 0.1 } }) },
    )

    const error = await abortedAt(runRecall(deps, req(), { signal: ctrl.signal }))

    expectStage(error, 'rescue-rerank')
    expect(error.queueMs).toBe(40)
  })

  it('rejects at association-rerank when the association rerank fails because the caller left', async () => {
    const ctrl = new AbortController()
    const { deps, store } = setup(
      { rows: [...queryRows, row('a1')], candidates: queryCandidates, links: [link('a1', 'subject', 'q1')] },
      { rerank: scripted(ctrl, ['resolve', 'abort-reject'], { waits: [5, 6] }) },
    )

    const error = await abortedAt(runRecall(deps, req(), { signal: ctrl.signal }))

    expectStage(error, 'association-rerank')
    expect(error.queueMs).toBe(11)
    expect(store.storeVersion).toHaveBeenCalledTimes(1)
  })

  it('gives every rerank call of a run one priority and the caller signal', async () => {
    const ctrl = new AbortController()
    const { deps } = setup(
      { rows: [...queryRows, row('a1')], candidates: queryCandidates, links: [link('a1', 'subject', 'q1')] },
      { rerank: scripted(ctrl, ['resolve'], { scores: { a1: 0.8 } }) },
    )

    await runRecall(deps, req(), { signal: ctrl.signal })

    const options = vi.mocked(deps.rerank.rerank).mock.calls.map((call) => call[2]!)
    expect(options).toHaveLength(2)
    expect(typeof options[0]!.priority).toBe('number')
    expect(options.every((o) => o.priority === options[0]!.priority)).toBe(true)
    expect(options.every((o) => o.signal === ctrl.signal)).toBe(true)
  })

  it('gives each run its own priority, an earlier run a lower one', async () => {
    const earlier = setup({ rows: [row('a')], candidates: [[cand('a', 'bm25', 1)]] })
    const later = setup({ rows: [row('a')], candidates: [[cand('a', 'bm25', 1)]] })

    await runRecall(earlier.deps, req())
    await runRecall(later.deps, req())

    const priorityOf = (deps: RecallDeps): number => vi.mocked(deps.rerank.rerank).mock.calls[0]![2]!.priority!
    expect(priorityOf(earlier.deps)).toBeLessThan(priorityOf(later.deps))
  })

  it('sums the rerank calls reported waits into timings.queue', async () => {
    const ctrl = new AbortController()
    const { deps } = setup(
      { rows: [...queryRows, row('a1')], candidates: queryCandidates, links: [link('a1', 'subject', 'q1')] },
      { rerank: scripted(ctrl, ['resolve'], { waits: [7, 11], scores: { a1: 0.8 } }) },
    )

    const { trace } = await runRecall(deps, req())

    expect(trace.timings.queue).toBe(18)
  })

  it('still degrades a rerank failure when the caller is still there', async () => {
    const ctrl = new AbortController()
    const rows = [row('first'), row('second', { trust: 1 })]
    const { deps } = setup(
      { rows, candidates: [[cand('first', 'bm25', 1), cand('second', 'bm25', 2)]] },
      { rerank: { id: 'tst-reranker', rerank: vi.fn(async () => Promise.reject(new Error('tst rerank down'))) } },
    )

    const { response } = await runRecall(deps, req(), { signal: ctrl.signal })

    expect(response.degraded).toEqual({ rerank: 'tst rerank down' })
    expect(response.items.map((i) => i.id)).toEqual(['first', 'second'])
  })

  it('has scoreSlate pass a priority and no signal', async () => {
    const { deps } = setup({ rows: [row('a')], candidates: [[cand('a', 'bm25', 1)]] }, { floor: null })

    await scoreSlate(deps, req())

    const options = vi.mocked(deps.rerank.rerank).mock.calls[0]![2]!
    expect(typeof options.priority).toBe('number')
    expect('signal' in options).toBe(false)
  })
})
