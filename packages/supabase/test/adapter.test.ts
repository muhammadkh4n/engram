import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SupabaseStorageAdapter } from '../src/adapter.js'
import { SupabaseEpisodeStorage } from '../src/episodes.js'
import { SupabaseDigestStorage } from '../src/digests.js'
import { SupabaseSemanticStorage } from '../src/semantic.js'
import { SupabaseProceduralStorage } from '../src/procedural.js'
import { SupabaseAssociationStorage } from '../src/associations.js'
import { getMigrationSQL } from '../src/migrations.js'

// =============================================================================
// Mock Supabase client factory
//
// Returns a chainable builder that resolves with { data, error } when awaited.
// Every method (select, insert, update, delete, eq, in, is, gte, lt, ilike,
// or, neq, limit, order, single, maybeSingle, upsert) returns `this` for
// chaining, and the builder itself is a thenable that yields { data, error }.
// =============================================================================

type MockResult = { data: unknown; error: null | { message: string } }

function createChainable(result: MockResult) {
  const methods = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'in', 'is', 'ilike', 'or', 'gte', 'lt', 'lte', 'gt',
    'limit', 'order', 'single', 'maybeSingle',
  ]
  const obj: Record<string, unknown> = {}
  for (const m of methods) {
    obj[m] = vi.fn().mockReturnValue(obj)
  }
  // Make thenable so `await chain` works
  obj['then'] = (resolve: (v: MockResult) => void) => Promise.resolve(result).then(resolve)
  return obj
}

function makeMockClient() {
  const fromFn = vi.fn()
  const rpcFn = vi.fn()

  // Default: from() returns a chainable that resolves with empty data
  fromFn.mockImplementation(() => createChainable({ data: [], error: null }))
  // Default: rpc() resolves with empty data
  rpcFn.mockResolvedValue({ data: [], error: null })

  return { from: fromFn, rpc: rpcFn }
}

// =============================================================================
// Helper: build an initialized adapter with a mocked client
// =============================================================================

async function buildAdapter(overrides?: {
  fromResult?: MockResult
  rpcResult?: MockResult
}) {
  const mock = makeMockClient()

  if (overrides?.fromResult) {
    mock.from.mockImplementation(() => createChainable(overrides.fromResult!))
  }
  if (overrides?.rpcResult) {
    mock.rpc.mockResolvedValue(overrides.rpcResult)
  }

  // Patch createClient before importing adapter
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: vi.fn().mockReturnValue(mock),
  }))

  return { adapter: null as unknown as SupabaseStorageAdapter, mock }
}

// =============================================================================
// Unit tests — each sub-store tested in isolation with a mock client
// =============================================================================

describe('SupabaseEpisodeStorage', () => {
  let mock: ReturnType<typeof makeMockClient>
  let store: SupabaseEpisodeStorage

  beforeEach(() => {
    mock = makeMockClient()
    store = new SupabaseEpisodeStorage(mock as unknown as import('@supabase/supabase-js').SupabaseClient)
  })

  it('insert calls memories table then memory_episodes table', async () => {
    const memChain = createChainable({ data: null, error: null })
    const epChain = createChainable({
      data: {
        id: 'ep-1',
        session_id: 'sess-1',
        role: 'user',
        content: 'hello',
        salience: 0.5,
        access_count: 0,
        last_accessed: null,
        consolidated_at: null,
        embedding: null,
        entities: [],
        metadata: {},
        created_at: new Date().toISOString(),
      },
      error: null,
    })

    // First call (memories), second call (memory_episodes)
    mock.from
      .mockReturnValueOnce(memChain)
      .mockReturnValueOnce(epChain)

    await store.insert({
      sessionId: 'sess-1',
      role: 'user',
      content: 'hello',
      salience: 0.5,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null,
      entities: [],
      metadata: {},
    })

    // memories was called first
    expect(mock.from).toHaveBeenNthCalledWith(1, 'memories')
    // memory_episodes was called second
    expect(mock.from).toHaveBeenNthCalledWith(2, 'memory_episodes')
  })

  it('search with text + embedding calls engram_hybrid_recall RPC with p_include_episodes=true', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.search('test query', { embedding: [0.1, 0.2, 0.3] })

    expect(mock.rpc).toHaveBeenCalledWith('engram_hybrid_recall', expect.objectContaining({
      p_query_text: 'test query',
      p_include_episodes: true,
      p_include_digests: false,
      p_include_semantic: false,
      p_include_procedural: false,
    }))
  })

  it('search with embedding only (no query text) calls engram_recall RPC', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.search('', { embedding: [0.1, 0.2, 0.3] })

    expect(mock.rpc).toHaveBeenCalledWith('engram_recall', expect.objectContaining({
      p_include_episodes: true,
      p_include_digests: false,
      p_include_semantic: false,
      p_include_procedural: false,
    }))
  })

  it('search without embedding uses memory_episodes table (text fallback)', async () => {
    const chain = createChainable({ data: [], error: null })
    mock.from.mockReturnValue(chain)

    await store.search('test query')

    expect(mock.from).toHaveBeenCalledWith('memory_episodes')
    expect(mock.rpc).not.toHaveBeenCalled()
  })

  it('getByIds calls memory_episodes with .in()', async () => {
    const chain = createChainable({ data: [], error: null })
    mock.from.mockReturnValue(chain)

    await store.getByIds(['id-1', 'id-2'])

    expect(mock.from).toHaveBeenCalledWith('memory_episodes')
    expect(chain.in).toHaveBeenCalledWith('id', ['id-1', 'id-2'])
  })

  it('getByIds returns empty array for empty ids', async () => {
    const result = await store.getByIds([])
    expect(result).toEqual([])
    expect(mock.from).not.toHaveBeenCalled()
  })

  it('getBySession calls memory_episodes with .eq(session_id)', async () => {
    const chain = createChainable({ data: [], error: null })
    mock.from.mockReturnValue(chain)

    await store.getBySession('session-abc')

    expect(mock.from).toHaveBeenCalledWith('memory_episodes')
    expect(chain.eq).toHaveBeenCalledWith('session_id', 'session-abc')
  })

  it('getUnconsolidated calls .is(consolidated_at, null)', async () => {
    const chain = createChainable({ data: [], error: null })
    mock.from.mockReturnValue(chain)

    await store.getUnconsolidated('session-abc')

    expect(mock.from).toHaveBeenCalledWith('memory_episodes')
    expect(chain.is).toHaveBeenCalledWith('consolidated_at', null)
  })

  it('markConsolidated calls update with consolidated_at', async () => {
    const chain = createChainable({ data: null, error: null })
    mock.from.mockReturnValue(chain)

    await store.markConsolidated(['id-1', 'id-2'])

    expect(mock.from).toHaveBeenCalledWith('memory_episodes')
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ consolidated_at: expect.any(String) })
    )
    expect(chain.in).toHaveBeenCalledWith('id', ['id-1', 'id-2'])
  })

  it('markConsolidated is a no-op for empty array', async () => {
    await store.markConsolidated([])
    expect(mock.from).not.toHaveBeenCalled()
  })

  it('recordAccess calls engram_record_access RPC', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null })

    await store.recordAccess('ep-42')

    expect(mock.rpc).toHaveBeenCalledWith('engram_record_access', {
      p_id: 'ep-42',
      p_memory_type: 'episode',
    })
  })
})

describe('SupabaseDigestStorage', () => {
  let mock: ReturnType<typeof makeMockClient>
  let store: SupabaseDigestStorage

  beforeEach(() => {
    mock = makeMockClient()
    store = new SupabaseDigestStorage(mock as unknown as import('@supabase/supabase-js').SupabaseClient)
  })

  it('insert calls memories then memory_digests', async () => {
    const memChain = createChainable({ data: null, error: null })
    const digestChain = createChainable({
      data: {
        id: 'dig-1',
        session_id: 'sess-1',
        summary: 'summary text',
        key_topics: ['topic-a'],
        source_episode_ids: [],
        source_digest_ids: [],
        level: 0,
        embedding: null,
        metadata: {},
        created_at: new Date().toISOString(),
      },
      error: null,
    })

    mock.from
      .mockReturnValueOnce(memChain)
      .mockReturnValueOnce(digestChain)

    await store.insert({
      sessionId: 'sess-1',
      summary: 'summary text',
      keyTopics: ['topic-a'],
      sourceEpisodeIds: [],
      sourceDigestIds: [],
      level: 0,
      embedding: null,
      metadata: {},
    })

    expect(mock.from).toHaveBeenNthCalledWith(1, 'memories')
    expect(mock.from).toHaveBeenNthCalledWith(2, 'memory_digests')
  })

  it('search with text + embedding calls engram_hybrid_recall with p_include_digests=true', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.search('summary query', { embedding: [0.1, 0.2] })

    expect(mock.rpc).toHaveBeenCalledWith('engram_hybrid_recall', expect.objectContaining({
      p_query_text: 'summary query',
      p_include_episodes: false,
      p_include_digests: true,
      p_include_semantic: false,
      p_include_procedural: false,
    }))
  })

  it('search with embedding only (no query text) calls engram_recall with p_include_digests=true', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.search('', { embedding: [0.1, 0.2] })

    expect(mock.rpc).toHaveBeenCalledWith('engram_recall', expect.objectContaining({
      p_include_episodes: false,
      p_include_digests: true,
      p_include_semantic: false,
      p_include_procedural: false,
    }))
  })

  it('getBySession queries memory_digests', async () => {
    const chain = createChainable({ data: [], error: null })
    mock.from.mockReturnValue(chain)

    await store.getBySession('sess-x')

    expect(mock.from).toHaveBeenCalledWith('memory_digests')
    expect(chain.eq).toHaveBeenCalledWith('session_id', 'sess-x')
  })
})

describe('SupabaseSemanticStorage', () => {
  let mock: ReturnType<typeof makeMockClient>
  let store: SupabaseSemanticStorage

  beforeEach(() => {
    mock = makeMockClient()
    store = new SupabaseSemanticStorage(mock as unknown as import('@supabase/supabase-js').SupabaseClient)
  })

  it('insert calls memories then memory_semantic', async () => {
    const memChain = createChainable({ data: null, error: null })
    const semChain = createChainable({
      data: {
        id: 'sem-1',
        topic: 'topic',
        content: 'content',
        confidence: 0.8,
        source_digest_ids: [],
        source_episode_ids: [],
        access_count: 0,
        last_accessed: null,
        decay_rate: 0.02,
        supersedes: null,
        superseded_by: null,
        embedding: null,
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    })

    mock.from
      .mockReturnValueOnce(memChain)
      .mockReturnValueOnce(semChain)

    await store.insert({
      topic: 'topic',
      content: 'content',
      confidence: 0.8,
      sourceDigestIds: [],
      sourceEpisodeIds: [],
      decayRate: 0.02,
      supersedes: null,
      supersededBy: null,
      embedding: null,
      metadata: {},
    })

    expect(mock.from).toHaveBeenNthCalledWith(1, 'memories')
    expect(mock.from).toHaveBeenNthCalledWith(2, 'memory_semantic')
  })

  it('search with text + embedding calls engram_hybrid_recall with p_include_semantic=true', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.search('semantic query', { embedding: [0.5] })

    expect(mock.rpc).toHaveBeenCalledWith('engram_hybrid_recall', expect.objectContaining({
      p_query_text: 'semantic query',
      p_include_episodes: false,
      p_include_digests: false,
      p_include_semantic: true,
      p_include_procedural: false,
    }))
  })

  it('search with embedding only (no query text) calls engram_recall with p_include_semantic=true', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.search('', { embedding: [0.5] })

    expect(mock.rpc).toHaveBeenCalledWith('engram_recall', expect.objectContaining({
      p_include_episodes: false,
      p_include_digests: false,
      p_include_semantic: true,
      p_include_procedural: false,
    }))
  })

  it('recordAccessAndBoost calls engram_record_access with semantic type', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null })

    await store.recordAccessAndBoost('sem-1', 0.05)

    expect(mock.rpc).toHaveBeenCalledWith('engram_record_access', {
      p_id: 'sem-1',
      p_memory_type: 'semantic',
      p_conf_boost: 0.05,
    })
  })

  it('batchDecay calls engram_decay_pass and returns semantic_decayed', async () => {
    mock.rpc.mockResolvedValue({ data: [{ semantic_decayed: 7, procedural_decayed: 0, edges_pruned: 0 }], error: null })

    const count = await store.batchDecay({ daysThreshold: 30, decayRate: 0.02 })

    expect(mock.rpc).toHaveBeenCalledWith('engram_decay_pass', expect.objectContaining({
      p_semantic_decay_rate: 0.02,
      p_semantic_days: 30,
    }))
    expect(count).toBe(7)
  })

  it('markSuperseded updates both old and new memory records', async () => {
    const chain1 = createChainable({ data: null, error: null })
    const chain2 = createChainable({ data: null, error: null })
    mock.from
      .mockReturnValueOnce(chain1)
      .mockReturnValueOnce(chain2)

    await store.markSuperseded('old-id', 'new-id')

    expect(mock.from).toHaveBeenNthCalledWith(1, 'memory_semantic')
    expect(chain1.update).toHaveBeenCalledWith({ superseded_by: 'new-id' })
    expect(chain1.eq).toHaveBeenCalledWith('id', 'old-id')

    expect(mock.from).toHaveBeenNthCalledWith(2, 'memory_semantic')
    expect(chain2.update).toHaveBeenCalledWith({ supersedes: 'old-id' })
    expect(chain2.eq).toHaveBeenCalledWith('id', 'new-id')
  })
})

describe('SupabaseProceduralStorage', () => {
  let mock: ReturnType<typeof makeMockClient>
  let store: SupabaseProceduralStorage

  beforeEach(() => {
    mock = makeMockClient()
    store = new SupabaseProceduralStorage(mock as unknown as import('@supabase/supabase-js').SupabaseClient)
  })

  it('insert calls memories then memory_procedural', async () => {
    const memChain = createChainable({ data: null, error: null })
    const procChain = createChainable({
      data: {
        id: 'proc-1',
        category: 'workflow',
        trigger_text: 'trigger',
        procedure: 'steps',
        confidence: 0.7,
        observation_count: 1,
        last_observed: new Date().toISOString(),
        first_observed: new Date().toISOString(),
        access_count: 0,
        last_accessed: null,
        decay_rate: 0.01,
        source_episode_ids: [],
        embedding: null,
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    })

    mock.from
      .mockReturnValueOnce(memChain)
      .mockReturnValueOnce(procChain)

    await store.insert({
      category: 'workflow',
      trigger: 'trigger',
      procedure: 'steps',
      confidence: 0.7,
      observationCount: 1,
      lastObserved: new Date(),
      firstObserved: new Date(),
      decayRate: 0.01,
      sourceEpisodeIds: [],
      embedding: null,
      metadata: {},
    })

    expect(mock.from).toHaveBeenNthCalledWith(1, 'memories')
    expect(mock.from).toHaveBeenNthCalledWith(2, 'memory_procedural')
  })

  it('search with text + embedding calls engram_hybrid_recall with p_include_procedural=true', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.search('procedure query', { embedding: [0.3] })

    expect(mock.rpc).toHaveBeenCalledWith('engram_hybrid_recall', expect.objectContaining({
      p_query_text: 'procedure query',
      p_include_episodes: false,
      p_include_digests: false,
      p_include_semantic: false,
      p_include_procedural: true,
    }))
  })

  it('search with embedding only (no query text) calls engram_recall with p_include_procedural=true', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.search('', { embedding: [0.3] })

    expect(mock.rpc).toHaveBeenCalledWith('engram_recall', expect.objectContaining({
      p_include_episodes: false,
      p_include_digests: false,
      p_include_semantic: false,
      p_include_procedural: true,
    }))
  })

  it('recordAccess calls engram_record_access with procedural type', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null })

    await store.recordAccess('proc-42')

    expect(mock.rpc).toHaveBeenCalledWith('engram_record_access', {
      p_id: 'proc-42',
      p_memory_type: 'procedural',
    })
  })

  it('batchDecay calls engram_decay_pass and returns procedural_decayed', async () => {
    mock.rpc.mockResolvedValue({
      data: [{ semantic_decayed: 0, procedural_decayed: 3, edges_pruned: 0 }],
      error: null,
    })

    const count = await store.batchDecay({ daysThreshold: 60, decayRate: 0.01 })

    expect(mock.rpc).toHaveBeenCalledWith('engram_decay_pass', expect.objectContaining({
      p_procedural_decay_rate: 0.01,
      p_procedural_days: 60,
    }))
    expect(count).toBe(3)
  })
})

describe('SupabaseAssociationStorage', () => {
  let mock: ReturnType<typeof makeMockClient>
  let store: SupabaseAssociationStorage

  beforeEach(() => {
    mock = makeMockClient()
    store = new SupabaseAssociationStorage(mock as unknown as import('@supabase/supabase-js').SupabaseClient)
  })

  it('insert calls memory_associations table', async () => {
    const chain = createChainable({
      data: {
        id: 'assoc-1',
        source_id: 'ep-1',
        source_type: 'episode',
        target_id: 'sem-1',
        target_type: 'semantic',
        edge_type: 'derives_from',
        strength: 0.8,
        last_activated: null,
        metadata: {},
        created_at: new Date().toISOString(),
      },
      error: null,
    })
    mock.from.mockReturnValue(chain)

    await store.insert({
      sourceId: 'ep-1',
      sourceType: 'episode',
      targetId: 'sem-1',
      targetType: 'semantic',
      edgeType: 'derives_from',
      strength: 0.8,
      lastActivated: null,
      metadata: {},
    })

    expect(mock.from).toHaveBeenCalledWith('memory_associations')
  })

  it('walk calls engram_association_walk RPC', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.walk(['seed-1', 'seed-2'], { maxHops: 3, minStrength: 0.1 })

    expect(mock.rpc).toHaveBeenCalledWith('engram_association_walk', {
      p_seed_ids: ['seed-1', 'seed-2'],
      p_max_hops: 3,
      p_min_strength: 0.1,
      p_limit: 20,
    })
  })

  it('walk returns empty array for no seed ids', async () => {
    const result = await store.walk([])
    expect(result).toEqual([])
    expect(mock.rpc).not.toHaveBeenCalled()
  })

  it('walk maps RPC rows to WalkResult objects', async () => {
    mock.rpc.mockResolvedValue({
      data: [
        { memory_id: 'mem-1', memory_type: 'semantic', depth: 1, path_strength: 0.7 },
        { memory_id: 'mem-2', memory_type: 'episode', depth: 2, path_strength: 0.5 },
      ],
      error: null,
    })

    const results = await store.walk(['seed-1'])

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      memoryId: 'mem-1',
      memoryType: 'semantic',
      depth: 1,
      pathStrength: 0.7,
    })
    expect(results[1]).toEqual({
      memoryId: 'mem-2',
      memoryType: 'episode',
      depth: 2,
      pathStrength: 0.5,
    })
  })

  it('upsertCoRecalled calls engram_upsert_co_recalled RPC', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null })

    await store.upsertCoRecalled('ep-1', 'episode', 'sem-1', 'semantic')

    expect(mock.rpc).toHaveBeenCalledWith('engram_upsert_co_recalled', {
      p_source_id: 'ep-1',
      p_source_type: 'episode',
      p_target_id: 'sem-1',
      p_target_type: 'semantic',
    })
  })

  it('discoverTopicalEdges calls engram_dream_cycle RPC', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })

    await store.discoverTopicalEdges({ daysLookback: 30, maxNew: 50 })

    expect(mock.rpc).toHaveBeenCalledWith('engram_dream_cycle', {
      p_days_lookback: 30,
      p_max_new_associations: 50,
    })
  })

  it('discoverTopicalEdges maps dream cycle rows to DiscoveredEdge objects', async () => {
    mock.rpc.mockResolvedValue({
      data: [{
        source_id: 'ep-1',
        source_type: 'episode',
        target_id: 'ep-2',
        target_type: 'episode',
        shared_entity: 'TypeScript',
        entity_count: 3,
      }],
      error: null,
    })

    const edges = await store.discoverTopicalEdges({ daysLookback: 7, maxNew: 10 })

    expect(edges).toHaveLength(1)
    expect(edges[0]).toEqual({
      sourceId: 'ep-1',
      sourceType: 'episode',
      targetId: 'ep-2',
      targetType: 'episode',
      sharedEntity: 'TypeScript',
      entityCount: 3,
    })
  })

  it('pruneWeak deletes from memory_associations', async () => {
    const chain = createChainable({ data: [], error: null })
    mock.from.mockReturnValue(chain)

    const count = await store.pruneWeak({ maxStrength: 0.1, olderThanDays: 90 })

    expect(mock.from).toHaveBeenCalledWith('memory_associations')
    expect(chain.delete).toHaveBeenCalled()
    expect(chain.lt).toHaveBeenCalledWith('strength', 0.1)
    expect(chain.neq).toHaveBeenCalledWith('edge_type', 'derives_from')
    expect(count).toBe(0) // empty data array
  })
})

describe('SupabaseStorageAdapter', () => {
  it('exposes getMigrationSQL that returns a non-empty SQL string', () => {
    const sql = getMigrationSQL()
    expect(typeof sql).toBe('string')
    expect(sql.length).toBeGreaterThan(100)
    expect(sql).toContain('memory_episodes')
    expect(sql).toContain('memory_semantic')
    expect(sql).toContain('memory_procedural')
    expect(sql).toContain('memory_associations')
    expect(sql).toContain('engram_recall')
    expect(sql).toContain('engram_association_walk')
    expect(sql).toContain('engram_record_access')
    expect(sql).toContain('engram_decay_pass')
    expect(sql).toContain('engram_dream_cycle')
  })

  it('throws before initialize() is called', () => {
    // SupabaseStorageAdapter with a fake URL won't actually call Supabase in constructor
    const adapter = new SupabaseStorageAdapter({ url: 'https://fake.supabase.co', key: 'fake-key' })
    expect(() => adapter.episodes).toThrow(/not initialized/)
    expect(() => adapter.digests).toThrow(/not initialized/)
    expect(() => adapter.semantic).toThrow(/not initialized/)
    expect(() => adapter.procedural).toThrow(/not initialized/)
    expect(() => adapter.associations).toThrow(/not initialized/)
  })

  it('getById routes episode type to memory_episodes table', async () => {
    // Build a minimal mock client and inject directly to test routing
    const mock = makeMockClient()

    // First call is episodes.getByIds → memory_episodes
    const episodeRow = {
      id: 'ep-1',
      session_id: 'sess',
      role: 'user',
      content: 'test',
      salience: 0.5,
      access_count: 0,
      last_accessed: null,
      consolidated_at: null,
      embedding: null,
      entities: [],
      metadata: {},
      created_at: new Date().toISOString(),
    }
    const epChain = createChainable({ data: [episodeRow], error: null })
    mock.from.mockReturnValue(epChain)

    // Manually create a "pre-initialized" adapter by setting private fields
    const adapter = new SupabaseStorageAdapter({ url: 'https://fake.supabase.co', key: 'k' })
    // Inject mock client via the episodes store
    const episodeStore = new SupabaseEpisodeStorage(mock as unknown as import('@supabase/supabase-js').SupabaseClient)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any)._episodes = episodeStore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).client = mock

    const result = await adapter.getById('ep-1', 'episode')
    expect(result).not.toBeNull()
    expect(result?.type).toBe('episode')
    expect(mock.from).toHaveBeenCalledWith('memory_episodes')
  })

  it('getById routes semantic type to memory_semantic table', async () => {
    const mock = makeMockClient()

    const semRow = {
      id: 'sem-1',
      topic: 'TypeScript',
      content: 'typed superset',
      confidence: 0.9,
      source_digest_ids: [],
      source_episode_ids: [],
      access_count: 0,
      last_accessed: null,
      decay_rate: 0.02,
      supersedes: null,
      superseded_by: null,
      embedding: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const semChain = createChainable({ data: semRow, error: null })
    mock.from.mockReturnValue(semChain)

    const adapter = new SupabaseStorageAdapter({ url: 'https://fake.supabase.co', key: 'k' })
    const episodeStore = new SupabaseEpisodeStorage(mock as unknown as import('@supabase/supabase-js').SupabaseClient)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any)._episodes = episodeStore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).client = mock

    const result = await adapter.getById('sem-1', 'semantic')
    expect(result?.type).toBe('semantic')
    expect(mock.from).toHaveBeenCalledWith('memory_semantic')
  })
})
