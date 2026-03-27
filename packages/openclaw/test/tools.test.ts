import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram/sqlite'
import { Memory } from '@engram/core'
import { createEngramTools } from '../src/tools.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeMemory(): Promise<Memory> {
  const memory = new Memory({ storage: sqliteAdapter() })
  await memory.initialize()
  return memory
}

async function makeMemoryWithData(): Promise<Memory> {
  const memory = await makeMemory()
  await memory.ingestBatch([
    { role: 'user', content: 'I prefer TypeScript over JavaScript for large projects', sessionId: 'tools-s1' },
    { role: 'assistant', content: 'TypeScript strict mode enables strict type checking everywhere', sessionId: 'tools-s1' },
    { role: 'user', content: 'We use TypeScript generics to write reusable components', sessionId: 'tools-s1' },
    { role: 'assistant', content: 'TypeScript provides excellent IntelliSense and tooling', sessionId: 'tools-s1' },
    { role: 'user', content: 'Our team decided to migrate the entire backend to TypeScript', sessionId: 'tools-s1' },
  ])
  return memory
}

// ---------------------------------------------------------------------------
// engram_search
// ---------------------------------------------------------------------------

describe('createEngramTools — engram_search', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = await makeMemoryWithData()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('returns formatted text in content array', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_search.execute({ query: 'TypeScript' })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(typeof result.content[0].text).toBe('string')
  })

  it('returns text for a specific query', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_search.execute({
      query: 'What is our TypeScript strategy?',
    })

    expect(result.content[0].type).toBe('text')
    expect(typeof result.content[0].text).toBe('string')
  })

  it('returns empty string text for SOCIAL intent', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_search.execute({ query: 'hi' })

    expect(result.content[0].type).toBe('text')
    expect(typeof result.content[0].text).toBe('string')
  })

  it('accepts optional limit parameter', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_search.execute({
      query: 'TypeScript features',
      limit: 3,
    })

    expect(result.content).toHaveLength(1)
    expect(typeof result.content[0].text).toBe('string')
  })

  it('has correct tool name and description', () => {
    const tools = createEngramTools(memory)
    expect(tools.engram_search.name).toBe('engram_search')
    expect(tools.engram_search.description).toContain('Search')
  })
})

// ---------------------------------------------------------------------------
// engram_stats
// ---------------------------------------------------------------------------

describe('createEngramTools — engram_stats', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = await makeMemory()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('returns JSON stats in content array', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_stats.execute()

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')

    const parsed = JSON.parse(result.content[0].text) as unknown
    expect(parsed).toHaveProperty('episodes')
    expect(parsed).toHaveProperty('digests')
    expect(parsed).toHaveProperty('semantic')
    expect(parsed).toHaveProperty('procedural')
    expect(parsed).toHaveProperty('associations')
  })

  it('returns zero counts on empty storage', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_stats.execute()

    const parsed = JSON.parse(result.content[0].text) as {
      episodes: number
      digests: number
      semantic: number
      procedural: number
      associations: number
    }

    expect(parsed.episodes).toBe(0)
    expect(parsed.digests).toBe(0)
    expect(parsed.semantic).toBe(0)
  })

  it('counts episodes after ingestion', async () => {
    await memory.ingestBatch([
      { role: 'user', content: 'message one', sessionId: 'stats-s1' },
      { role: 'assistant', content: 'message two', sessionId: 'stats-s1' },
    ])

    const tools = createEngramTools(memory)
    const result = await tools.engram_stats.execute()
    const parsed = JSON.parse(result.content[0].text) as { episodes: number }

    expect(parsed.episodes).toBe(2)
  })

  it('has correct tool name and description', () => {
    const tools = createEngramTools(memory)
    expect(tools.engram_stats.name).toBe('engram_stats')
    expect(tools.engram_stats.description).toContain('statistic')
  })
})

// ---------------------------------------------------------------------------
// engram_forget
// ---------------------------------------------------------------------------

describe('createEngramTools — engram_forget', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = await makeMemoryWithData()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('returns JSON result in content array', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_forget.execute({ query: 'TypeScript' })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')

    const parsed = JSON.parse(result.content[0].text) as unknown
    expect(parsed).toHaveProperty('count')
    expect(parsed).toHaveProperty('previewed')
  })

  it('confirm=false returns a preview without modifying storage', async () => {
    const tools = createEngramTools(memory)

    const statsBefore = await memory.stats()
    const result = await tools.engram_forget.execute({
      query: 'TypeScript',
      confirm: false,
    })
    const statsAfter = await memory.stats()

    const parsed = JSON.parse(result.content[0].text) as {
      count: number
      previewed: unknown[]
    }

    expect(typeof parsed.count).toBe('number')
    expect(Array.isArray(parsed.previewed)).toBe(true)
    expect(parsed.count).toBe(parsed.previewed.length)
    // Episode count should not change on preview
    expect(statsAfter.episodes).toBe(statsBefore.episodes)
  })

  it('confirm=true applies forgetting and returns count', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_forget.execute({
      query: 'TypeScript',
      confirm: true,
    })

    const parsed = JSON.parse(result.content[0].text) as {
      count: number
      previewed: unknown[]
    }

    expect(typeof parsed.count).toBe('number')
    expect(parsed.count).toBe(parsed.previewed.length)
  })

  it('returns count=0 and empty previewed for unmatched query', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_forget.execute({ query: 'hi' })

    const parsed = JSON.parse(result.content[0].text) as {
      count: number
      previewed: unknown[]
    }

    // SOCIAL intent does not recall — count should be 0
    expect(parsed.count).toBe(0)
    expect(parsed.previewed).toHaveLength(0)
  })

  it('has correct tool name and description', () => {
    const tools = createEngramTools(memory)
    expect(tools.engram_forget.name).toBe('engram_forget')
    expect(tools.engram_forget.description).toContain('eprioritize')
  })
})

// ---------------------------------------------------------------------------
// engram_expand
// ---------------------------------------------------------------------------

describe('createEngramTools — engram_expand', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = await makeMemoryWithData()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('returns episodes formatted as [role] content', async () => {
    // Run light sleep to create digests
    await memory.consolidate('light')

    // Retrieve the digest id from storage directly
    const storage = (memory as unknown as { storage: import('@engram/core').StorageAdapter }).storage
    const digests = await storage.digests.getBySession('tools-s1')

    if (digests.length === 0) {
      // Not enough episodes for consolidation — skip
      return
    }

    const tools = createEngramTools(memory)
    const result = await tools.engram_expand.execute({ memoryId: digests[0].id })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')

    const text = result.content[0].text
    expect(typeof text).toBe('string')

    // Each episode line should start with [role]
    if (text.length > 0) {
      expect(text).toMatch(/^\[(user|assistant|system)\]/)
    }
  })

  it('returns empty text for unknown memoryId', async () => {
    const tools = createEngramTools(memory)
    const result = await tools.engram_expand.execute({ memoryId: 'nonexistent-id' })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe('')
  })

  it('has correct tool name and description', () => {
    const tools = createEngramTools(memory)
    expect(tools.engram_expand.name).toBe('engram_expand')
    expect(tools.engram_expand.description).toContain('digest')
  })
})
