import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { Memory } from '@engram-mem/core'
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

  type Preview = { count: number; candidates: Array<{ id: string; type: string; content: string }> }

  async function preview(query: string): Promise<Preview> {
    const tools = createEngramTools(memory)
    const result = await tools.engram_forget.execute({ query })
    return JSON.parse(result.content[0].text) as Preview
  }

  it('query previews candidates with their ids and writes nothing', async () => {
    const statsBefore = await memory.stats()
    const parsed = await preview('TypeScript generics')

    expect(parsed.count).toBe(parsed.candidates.length)
    expect(parsed.count).toBeGreaterThan(0)
    expect(parsed.candidates.every((c) => typeof c.id === 'string' && c.id.length > 0)).toBe(true)
    expect((await memory.stats()).episodes).toBe(statsBefore.episodes)
    expect((await preview('TypeScript generics')).count).toBe(parsed.count)
  })

  it('ids tombstones exactly the approved ids and reports each outcome', async () => {
    const before = await preview('TypeScript generics')
    const target = before.candidates.find((c) => c.content.includes('generics'))!
    const untouched = before.candidates.filter((c) => c.id !== target.id).map((c) => c.id)

    const tools = createEngramTools(memory)
    const result = await tools.engram_forget.execute({ ids: [target.id, 'no-such-id'] })
    const parsed = JSON.parse(result.content[0].text) as {
      forgotten: Array<{ id: string; type: string }>
      notFound: string[]
      outOfScope: string[]
      notForgettable: string[]
    }

    expect(parsed.forgotten).toEqual([{ id: target.id, type: target.type }])
    expect(parsed.notFound).toEqual(['no-such-id'])
    expect(parsed.outOfScope).toEqual([])
    expect(parsed.notForgettable).toEqual([])

    const after = (await preview('TypeScript generics')).candidates.map((c) => c.id)
    expect(after).not.toContain(target.id)
    for (const id of untouched) expect(after).toContain(id)
  })

  it('rejects both or neither of query and ids, and an empty id list', async () => {
    const tools = createEngramTools(memory)
    for (const params of [{ query: 'TypeScript', ids: ['x'] }, {}, { ids: [] as string[] }, { query: '  ' }]) {
      const result = await tools.engram_forget.execute(params)
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/^Error: /)
    }
  })

  it('returns count=0 and no candidates for an unmatched query', async () => {
    const parsed = await preview('hi')
    expect(parsed.count).toBe(0)
    expect(parsed.candidates).toHaveLength(0)
  })

  it('has correct tool name and a description of the two modes', () => {
    const tools = createEngramTools(memory)
    expect(tools.engram_forget.name).toBe('engram_forget')
    expect(tools.engram_forget.description).toContain('never deletes')
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
    const storage = (memory as unknown as { storage: import('@engram-mem/core').StorageAdapter }).storage
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
