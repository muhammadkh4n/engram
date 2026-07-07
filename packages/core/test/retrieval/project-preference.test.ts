/**
 * Project soft-preference end-to-end through Memory.recall:
 * RetrievedMemory.projectId is threaded from the storage row (unifiedSearch
 * reads typed.data.projectId), applyProjectPreference resolves the tag
 * column-first (metadata.project is the legacy fallback), and a per-call or
 * instance-level projectId activates the +0.1 boost — previously only an
 * explicit `project` option at construction did.
 */
import { describe, it, expect } from 'vitest'
import { createMemory } from '../../src/create-memory.js'
import type { Episode, SearchResult, TypedMemory, RecallResult } from '../../src/types.js'
import { createMockStorage } from './mock-storage.js'

const DUMMY_EMBEDDING = [0.1, 0.2, 0.3]
// Old enough that recency bias decays to near-zero, keeping base scores
// well below the 1.0 boost cap so the +0.1 delta is fully observable.
const SIXTY_DAYS_AGO = new Date(Date.now() - 60 * 24 * 3_600_000)

function makeEpisode(
  id: string,
  projectId: string | null,
  metadata: Record<string, unknown> = {},
): Episode {
  return {
    id,
    sessionId: 'sess-1',
    role: 'user',
    content: `Note ${id} about the deployment pipeline configuration`,
    salience: 0.5,
    accessCount: 0,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: null,
    entities: [],
    metadata,
    createdAt: SIXTY_DAYS_AGO,
    projectId,
  }
}

function vectorResults(episodes: Episode[]): SearchResult<TypedMemory>[] {
  // Identical similarity — only the project preference can break the tie.
  return episodes.map((e) => ({
    item: { type: 'episode' as const, data: e },
    similarity: 0.5,
  }))
}

async function recallOver(
  episodes: Episode[],
  recallOpts: { projectId?: string } = {},
  memoryOpts: {
    projectId?: string
    project?: string
    intelligence?: Parameters<typeof createMemory>[0]['intelligence']
  } = {},
): Promise<RecallResult> {
  const storage = createMockStorage({
    vectorSearchResults: vectorResults(episodes),
    textBoostResults: [],
  })
  const memory = createMemory({ storage, ...memoryOpts })
  await memory.initialize()
  // No '?' and no recall keywords → 'light' mode (no association expansion).
  const result = await memory.recall('summarize the deployment pipeline configuration', {
    embedding: DUMMY_EMBEDDING,
    ...recallOpts,
  })
  await memory.dispose()
  return result
}

function relevanceOf(result: RecallResult, id: string): number {
  const m = result.memories.find((x) => x.id === id)
  expect(m, `memory ${id} missing from results`).toBeDefined()
  return m!.relevance
}

describe('project soft boost via the project_id column', () => {
  it('per-call projectId boosts the same-project memory above an equal-relevance rival', async () => {
    // Non-matching memory listed FIRST so a stable sort without the boost
    // would keep it on top — the flip proves the boost, not input order.
    const episodes = [makeEpisode('ep-other', 'beta'), makeEpisode('ep-mine', 'alpha')]

    const result = await recallOver(episodes, { projectId: 'alpha' })

    expect(result.memories[0]!.id).toBe('ep-mine')
    expect(relevanceOf(result, 'ep-mine')).toBeCloseTo(
      relevanceOf(result, 'ep-other') + 0.1,
      5,
    )
  })

  it('instance-level projectId activates the boost without per-call opts', async () => {
    const episodes = [makeEpisode('ep-other', 'beta'), makeEpisode('ep-mine', 'alpha')]

    const result = await recallOver(episodes, {}, { projectId: 'alpha' })

    expect(result.memories[0]!.id).toBe('ep-mine')
  })

  it('metadata.project still works as a legacy fallback when the column is null', async () => {
    const episodes = [
      makeEpisode('ep-plain', null),
      makeEpisode('ep-meta', null, { project: 'gamma' }),
    ]

    const result = await recallOver(episodes, { projectId: 'gamma' })

    expect(result.memories[0]!.id).toBe('ep-meta')
    expect(relevanceOf(result, 'ep-meta')).toBeCloseTo(
      relevanceOf(result, 'ep-plain') + 0.1,
      5,
    )
  })

  it('the project_id column takes precedence over metadata.project', async () => {
    // Decoy claims 'alpha' in metadata but its column says 'beta'. If the
    // resolution still consulted metadata first, the decoy would also be
    // boosted and a stable sort would keep it first.
    const episodes = [
      makeEpisode('ep-decoy', 'beta', { project: 'alpha' }),
      makeEpisode('ep-true', 'alpha'),
    ]

    const result = await recallOver(episodes, { projectId: 'alpha' })

    expect(result.memories[0]!.id).toBe('ep-true')
    expect(relevanceOf(result, 'ep-true')).toBeGreaterThan(
      relevanceOf(result, 'ep-decoy'),
    )
  })

  it('the per-call projectId wins over the default project for the boost', async () => {
    // Mirrors the SQL filter's precedence: with a per-call scope of alpha,
    // the filter would exclude non-alpha/non-shared rows entirely, so
    // boosting toward the constructor default would target rows that
    // cannot appear in the results — the boost must follow the call scope.
    const episodes = [makeEpisode('ep-default', 'delta'), makeEpisode('ep-scoped', 'alpha')]

    const result = await recallOver(episodes, { projectId: 'alpha' }, { project: 'delta' })

    expect(result.memories[0]!.id).toBe('ep-scoped')
  })

  it('the default project activates the boost when no per-call scope is given', async () => {
    const episodes = [makeEpisode('ep-scoped', 'alpha'), makeEpisode('ep-default', 'delta')]

    const result = await recallOver(episodes, {}, { project: 'delta' })

    expect(result.memories[0]!.id).toBe('ep-default')
  })

  it('survives the rerank blend: a slightly higher rerank score cannot outrank the boost', async () => {
    // The reranker prefers the cross-project doc by 0.05. Blended at the
    // single-hop weight (0.7), that gap shrinks to 0.035 — the +0.1
    // preference applied to the blended scores must still flip the order.
    // Before the post-rerank re-application, only +0.1 * originalWeight
    // (= +0.03) of the early boost survived the blend and the
    // cross-project doc won.
    const episodes = [makeEpisode('ep-other', 'beta'), makeEpisode('ep-mine', 'alpha')]
    const rerank = async (
      _query: string,
      docs: Array<{ id: string; content: string }>,
    ) => docs.map(d => ({ id: d.id, score: d.id === 'ep-other' ? 0.6 : 0.55 }))

    const result = await recallOver(episodes, { projectId: 'alpha' }, { intelligence: { rerank } })

    expect(result.memories[0]!.id).toBe('ep-mine')
  })

  it('the rerank blend still outranks the boost when the semantic gap is large', async () => {
    // A soft preference must not override a decisively better rerank score:
    // 0.3 rerank gap * 0.7 weight = 0.21 blended, beyond the +0.1 boost.
    const episodes = [makeEpisode('ep-other', 'beta'), makeEpisode('ep-mine', 'alpha')]
    const rerank = async (
      _query: string,
      docs: Array<{ id: string; content: string }>,
    ) => docs.map(d => ({ id: d.id, score: d.id === 'ep-other' ? 0.85 : 0.55 }))

    const result = await recallOver(episodes, { projectId: 'alpha' }, { intelligence: { rerank } })

    expect(result.memories[0]!.id).toBe('ep-other')
  })
})
