import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteStorageAdapter } from '../src/adapter.js'

describe('Project namespace isolation', () => {
  let storage: SqliteStorageAdapter

  beforeEach(async () => {
    storage = new SqliteStorageAdapter(':memory:')
    await storage.initialize()
  })

  afterEach(async () => {
    await storage.dispose()
  })

  it('vectorSearch with projectId only returns matching project memories', async () => {
    // Create a simple embedding: alpha uses [1,0,0,...], beta uses [0,1,0,...]
    // Without a real embedding model these are stubs — we test the SQL filter
    const alphaEmbedding = new Array(1536).fill(0)
    alphaEmbedding[0] = 1.0

    const betaEmbedding = new Array(1536).fill(0)
    betaEmbedding[1] = 1.0

    // Insert alpha episode
    await storage.episodes.insert({
      sessionId: 'test',
      role: 'user',
      content: 'Alpha project: PostgreSQL decision',
      salience: 0.8,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: alphaEmbedding,
      entities: [],
      metadata: {},
      projectId: 'alpha',
    })

    // Insert beta episode
    await storage.episodes.insert({
      sessionId: 'test',
      role: 'user',
      content: 'Beta project: MongoDB decision',
      salience: 0.8,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: betaEmbedding,
      entities: [],
      metadata: {},
      projectId: 'beta',
    })

    // Query for alpha project — search with alpha-like vector
    const alphaResults = await storage.vectorSearch(alphaEmbedding, {
      limit: 10,
      projectId: 'alpha',
    })

    const alphaIds = alphaResults.map(r => r.item.data.id)
    // Alpha result content should be the alpha episode
    const alphaContents = alphaResults.map(r => {
      const data = r.item.data
      if (r.item.type === 'episode') return (data as { content: string }).content
      return ''
    })

    expect(alphaContents.every(c => !c.includes('MongoDB'))).toBe(true)

    // Query for beta project
    const betaResults = await storage.vectorSearch(betaEmbedding, {
      limit: 10,
      projectId: 'beta',
    })

    const betaContents = betaResults.map(r => {
      if (r.item.type === 'episode') return (r.item.data as { content: string }).content
      return ''
    })

    expect(betaContents.every(c => !c.includes('PostgreSQL'))).toBe(true)
  })

  it('vectorSearch without projectId returns ALL memories (backward compat)', async () => {
    const embedding = new Array(1536).fill(0)
    embedding[0] = 1.0

    await storage.episodes.insert({
      sessionId: 'test',
      role: 'user',
      content: 'Alpha memory',
      salience: 0.8,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding,
      entities: [],
      metadata: {},
      projectId: 'alpha',
    })

    await storage.episodes.insert({
      sessionId: 'test',
      role: 'user',
      content: 'Beta memory',
      salience: 0.8,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding,
      entities: [],
      metadata: {},
      projectId: 'beta',
    })

    // No projectId filter → returns all
    const allResults = await storage.vectorSearch(embedding, { limit: 10 })
    expect(allResults.length).toBeGreaterThanOrEqual(2)
  })

  it('memories with project_id IS NULL are always returned when projectId filter active', async () => {
    const embedding = new Array(1536).fill(0)
    embedding[0] = 1.0

    // Legacy row (no project)
    await storage.episodes.insert({
      sessionId: 'test',
      role: 'user',
      content: 'Legacy memory without project',
      salience: 0.8,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding,
      entities: [],
      metadata: {},
      projectId: null,
    })

    // Alpha-scoped row
    await storage.episodes.insert({
      sessionId: 'test',
      role: 'user',
      content: 'Alpha scoped memory',
      salience: 0.8,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding,
      entities: [],
      metadata: {},
      projectId: 'alpha',
    })

    // Query scoped to 'beta': NULL row is accessible, 'alpha' row is NOT
    const betaResults = await storage.vectorSearch(embedding, {
      limit: 10,
      projectId: 'beta',
    })

    const betaContents = betaResults.map(r => {
      if (r.item.type === 'episode') return (r.item.data as { content: string }).content
      return ''
    })

    // Legacy (NULL) row should be returned
    expect(betaContents.some(c => c.includes('Legacy'))).toBe(true)
    // Alpha-scoped row should NOT be returned
    expect(betaContents.every(c => !c.includes('Alpha scoped'))).toBe(true)
  })

  it('community cache can store and retrieve summaries by project', async () => {
    if (!storage.saveCommunityCache || !storage.getCommunitySummaries) return

    await storage.saveCommunityCache({
      communityId: 'community:alpha:1',
      projectId: 'alpha',
      label: 'Auth cluster',
      memberCount: 10,
      topEntities: ['JWT'],
      topTopics: ['authentication'],
      topPersons: [],
      dominantEmotion: null,
    })

    await storage.saveCommunityCache({
      communityId: 'community:beta:1',
      projectId: 'beta',
      label: 'DB cluster',
      memberCount: 5,
      topEntities: ['PostgreSQL'],
      topTopics: ['database'],
      topPersons: [],
      dominantEmotion: null,
    })

    const alphaSummaries = await storage.getCommunitySummaries({ projectId: 'alpha' })
    expect(alphaSummaries.length).toBe(1)
    expect(alphaSummaries[0].label).toBe('Auth cluster')

    const betaSummaries = await storage.getCommunitySummaries({ projectId: 'beta' })
    expect(betaSummaries.length).toBe(1)
    expect(betaSummaries[0].label).toBe('DB cluster')
  })
})
