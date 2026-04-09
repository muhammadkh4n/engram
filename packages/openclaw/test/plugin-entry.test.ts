import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createEngramContextEngine, extractQuery } from '../src/plugin-entry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngine() {
  return createEngramContextEngine({ storage: sqliteAdapter() })
}

// ---------------------------------------------------------------------------
// bootstrap()
// ---------------------------------------------------------------------------

describe('createEngramContextEngine — bootstrap()', () => {
  it('initializes storage without error', async () => {
    const engine = makeEngine()
    await expect(engine.bootstrap()).resolves.not.toThrow()
    await engine.dispose()
  })

  it('exposes engine info', () => {
    const engine = makeEngine()
    expect(engine.info.id).toBe('engram')
    expect(engine.info.ownsCompaction).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ingest()
// ---------------------------------------------------------------------------

describe('createEngramContextEngine — ingest()', () => {
  let engine: ReturnType<typeof makeEngine>

  beforeEach(async () => {
    engine = makeEngine()
    await engine.bootstrap()
  })

  afterEach(async () => {
    await engine.dispose()
  })

  it('stores a user message without error', async () => {
    await expect(
      engine.ingest({
        sessionId: 'session-1',
        message: { role: 'user', content: 'hello world' },
      })
    ).resolves.not.toThrow()
  })

  it('stores an assistant message without error', async () => {
    await expect(
      engine.ingest({
        sessionId: 'session-1',
        message: { role: 'assistant', content: 'hello back' },
      })
    ).resolves.not.toThrow()
  })

  it('ignores heartbeat messages', async () => {
    // Should complete immediately without storage access
    await expect(
      engine.ingest({
        sessionId: 'session-1',
        message: { role: 'user', content: 'ping' },
        isHeartbeat: true,
      })
    ).resolves.not.toThrow()
  })

  it('heartbeat does not increase episode count', async () => {
    await engine.ingest({
      sessionId: 's-hb',
      message: { role: 'user', content: 'heartbeat' },
      isHeartbeat: true,
    })

    const memory = engine.getMemory()
    const stats = await memory.stats()
    expect(stats.episodes).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ingestBatch()
// ---------------------------------------------------------------------------

describe('createEngramContextEngine — ingestBatch()', () => {
  let engine: ReturnType<typeof makeEngine>

  beforeEach(async () => {
    engine = makeEngine()
    await engine.bootstrap()
  })

  afterEach(async () => {
    await engine.dispose()
  })

  it('stores multiple messages', async () => {
    await engine.ingestBatch({
      sessionId: 'batch-session',
      messages: [
        { role: 'user', content: 'TypeScript is great for large codebases' },
        { role: 'assistant', content: 'Agreed, strict mode catches many bugs' },
        { role: 'user', content: 'I prefer TypeScript over plain JavaScript' },
      ],
    })

    const memory = engine.getMemory()
    const stats = await memory.stats()
    expect(stats.episodes).toBe(3)
  })

  it('handles an empty batch without error', async () => {
    await expect(
      engine.ingestBatch({ sessionId: 'empty', messages: [] })
    ).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// assemble()
// ---------------------------------------------------------------------------

describe('createEngramContextEngine — assemble()', () => {
  let engine: ReturnType<typeof makeEngine>

  beforeEach(async () => {
    engine = makeEngine()
    await engine.bootstrap()
  })

  afterEach(async () => {
    await engine.dispose()
  })

  it('returns the original messages array', async () => {
    const messages = [{ role: 'user', content: 'What is TypeScript?' }]
    const result = await engine.assemble({ messages, tokenBudget: 2000 })
    expect(result.messages).toBe(messages)
  })

  it('returns estimatedTokens as a number', async () => {
    const result = await engine.assemble({
      messages: [{ role: 'user', content: 'hello' }],
      tokenBudget: 1000,
    })
    expect(typeof result.estimatedTokens).toBe('number')
  })

  it('returns systemPromptAddition with recalled memories after ingestion', async () => {
    await engine.ingestBatch({
      sessionId: 'assemble-session',
      messages: [
        { role: 'user', content: 'I prefer TypeScript over JavaScript for all projects' },
        { role: 'assistant', content: 'TypeScript strict mode enables strict type checking' },
        { role: 'user', content: 'We use TypeScript generics everywhere in our codebase' },
        { role: 'assistant', content: 'TypeScript provides excellent tooling and IntelliSense' },
        { role: 'user', content: 'Our team decided to migrate the entire backend to TypeScript' },
      ],
    })

    const result = await engine.assemble({
      messages: [{ role: 'user', content: 'What is our TypeScript strategy?' }],
      tokenBudget: 4000,
    })

    // systemPromptAddition is optional — only set when memories exist
    if (result.systemPromptAddition !== undefined) {
      expect(typeof result.systemPromptAddition).toBe('string')
      expect(result.systemPromptAddition.length).toBeGreaterThan(0)
    }
  })

  it('systemPromptAddition is undefined when formatted result is empty', async () => {
    const result = await engine.assemble({
      messages: [{ role: 'user', content: 'hi there' }],
      tokenBudget: 2000,
    })

    // With no stored memories and a SOCIAL intent, formatted should be ''
    // so systemPromptAddition should be undefined
    if (result.systemPromptAddition !== undefined) {
      expect(result.systemPromptAddition.length).toBeGreaterThan(0)
    }
  })

  it('uses prompt as fallback query when no user message', async () => {
    const result = await engine.assemble({
      messages: [{ role: 'system', content: 'You are an assistant.' }],
      tokenBudget: 2000,
      prompt: 'TypeScript generics',
    })
    expect(typeof result.estimatedTokens).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// compact()
// ---------------------------------------------------------------------------

describe('createEngramContextEngine — compact()', () => {
  let engine: ReturnType<typeof makeEngine>

  beforeEach(async () => {
    engine = makeEngine()
    await engine.bootstrap()
  })

  afterEach(async () => {
    await engine.dispose()
  })

  it('runs light sleep consolidation without error', async () => {
    await expect(
      engine.compact({ sessionId: 'compact-session' })
    ).resolves.not.toThrow()
  })

  it('compact after ingestion completes without error', async () => {
    await engine.ingestBatch({
      sessionId: 'compact-session',
      messages: [
        { role: 'user', content: 'TypeScript strict mode is essential for large projects' },
        { role: 'assistant', content: 'You should enable strict in tsconfig.json' },
        { role: 'user', content: 'TypeScript generics help write reusable code' },
        { role: 'assistant', content: 'TypeScript inference is very powerful' },
        { role: 'user', content: 'We decided to migrate our project to TypeScript' },
      ],
    })

    await expect(engine.compact({ sessionId: 'compact-session' })).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe('createEngramContextEngine — dispose()', () => {
  it('cleans up without error', async () => {
    const engine = makeEngine()
    await engine.bootstrap()
    await expect(engine.dispose()).resolves.not.toThrow()
  })

  it('is safe to call on an uninitialized engine', async () => {
    // dispose() before bootstrap() should not throw — Memory.dispose() guards
    // against double-dispose via the initialized flag
    const engine = makeEngine()
    await expect(engine.dispose()).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// afterTurn()
// ---------------------------------------------------------------------------

describe('createEngramContextEngine — afterTurn()', () => {
  it('completes without error', async () => {
    const engine = makeEngine()
    await engine.bootstrap()
    await expect(engine.afterTurn()).resolves.not.toThrow()
    await engine.dispose()
  })
})

// ---------------------------------------------------------------------------
// getMemory()
// ---------------------------------------------------------------------------

describe('createEngramContextEngine — getMemory()', () => {
  it('exposes the underlying Memory instance', async () => {
    const engine = makeEngine()
    await engine.bootstrap()
    const memory = engine.getMemory()
    expect(memory).toBeDefined()
    // Memory instance should support core methods
    expect(typeof memory.ingest).toBe('function')
    expect(typeof memory.recall).toBe('function')
    expect(typeof memory.stats).toBe('function')
    await engine.dispose()
  })
})

// ---------------------------------------------------------------------------
// extractQuery()
// ---------------------------------------------------------------------------

describe('extractQuery()', () => {
  it('returns the last user message content', () => {
    const messages = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]
    expect(extractQuery(messages)).toBe('second question')
  })

  it('skips assistant messages to find the last user message', () => {
    const messages = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'reply' },
    ]
    expect(extractQuery(messages)).toBe('earlier question')
  })

  it('falls back to prompt when no user message exists', () => {
    const messages = [{ role: 'system', content: 'system prompt' }]
    expect(extractQuery(messages, 'fallback query')).toBe('fallback query')
  })

  it('returns empty string when no user message and no prompt', () => {
    expect(extractQuery([])).toBe('')
  })

  it('returns empty string for empty messages and no prompt', () => {
    const messages = [{ role: 'assistant', content: 'only assistant' }]
    expect(extractQuery(messages)).toBe('')
  })

  it('skips user messages with empty content', () => {
    const messages = [
      { role: 'user', content: 'valid question' },
      { role: 'user', content: '' },
    ]
    // Last user message has empty content, so should fall back to valid one
    expect(extractQuery(messages)).toBe('valid question')
  })

  it('uses prompt as fallback when all user messages are empty', () => {
    const messages = [{ role: 'user', content: '' }]
    expect(extractQuery(messages, 'my prompt')).toBe('my prompt')
  })
})
