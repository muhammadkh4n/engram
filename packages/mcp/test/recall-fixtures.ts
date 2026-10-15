import type { FloorCalibration, RecallDeps, RecallItemRow, RecallStore } from '@engram-mem/core'

export const TST_FLOOR: FloorCalibration = {
  reranker: 'tst-reranker',
  floor: 0.3,
  strong: 0.7,
  calibratedAt: '2026-02-03T04:00:00Z',
  dataset: 'tst',
  neededInSlate: 0,
  neededBelowFloor: 0,
}

export const TST_ITEM_ID = '01970000-0000-7000-8000-0000000000a1'
export const TST_T0 = new Date('2026-02-03T04:00:00Z')

export function tstRow(overrides: Partial<RecallItemRow> = {}): RecallItemRow {
  return {
    id: TST_ITEM_ID,
    class: 'document_section',
    kind: 'note',
    speaker: 'artifact',
    trust: 1,
    projectId: 'tst-repo',
    workspaceId: null,
    planSlug: null,
    sessionId: null,
    subjectLabel: null,
    contentHead: 'The tst floor sits at 0.3 for the tst reranker.',
    contentLength: 47,
    question: null,
    searchHead: 'tst floor',
    occurredAt: TST_T0,
    supersededBy: null,
    retired: false,
    restated: 0,
    source: { type: 'vault', path: 'Tst/Floor.md', heading_path: ['Floor'] },
    requested: true,
    currentId: TST_ITEM_ID,
    chain: 'current',
    endExcluded: false,
    ...overrides,
  }
}

/** Recall deps on stubs: one candidate, read and scored above the floor; no model step reaches a network. */
export function stubRecallDeps(opts: { floor?: FloorCalibration | null; rows?: RecallItemRow[] } = {}): RecallDeps {
  const rows = opts.rows ?? [tstRow()]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const version = 1
  const store: RecallStore = {
    candidates: async () => rows.map((r, i) => ({ itemId: r.id, leg: 'bm25', rank: i + 1, rawScore: 1, path: null })),
    items: async (ids) => ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    associations: async () => [],
    registerTokens: async () => [],
    storeVersion: async () => version,
    itemStates: async () => [],
    projectWorkspace: async () => null,
    projects: async () => [{ id: 'tst-repo', kind: 'project' }],
    cacheGet: async () => [],
    cachePut: async (_step, key, v, output) => ({
      key,
      version: v,
      vector: output.vector ? [...output.vector] : null,
      phrases: output.phrases ? [...output.phrases] : null,
      passage: output.passage ?? null,
    }),
  }
  return {
    store,
    embed: async () => [1, 0, 0],
    rerank: { id: 'tst-reranker', rerank: async (_q, docs) => docs.map((d) => ({ id: d.id, score: 0.8 })) },
    referenceDate: (now) => now.toISOString().slice(0, 10),
    floor: opts.floor === undefined ? TST_FLOOR : opts.floor,
    versions: { embedding: 'openai:tst:3', chat: 'tst-chat:1' },
    now: () => TST_T0,
  }
}
