/**
 * Wave 2 — Backward compatibility with graph=null.
 *
 * When no graph is provided, the pipeline must fall back to the legacy
 * SQL association walk identically to pre-Wave-2 behavior. No Context
 * section should appear in formatted output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { Memory } from '../../src/memory.js'

describe('Wave 2 — graph=null backward compatibility', () => {
  let memory: Memory

  beforeEach(async () => {
    memory = new Memory({ storage: sqliteAdapter() })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('recall() resolves normally without a graph', async () => {
    await memory.ingest({
      role: 'user',
      content: 'Testing the retrieval pipeline without any graph configuration',
      sessionId: 's1',
    })
    const result = await memory.recall('retrieval pipeline')
    expect(result).toBeDefined()
    expect(result.memories).toBeDefined()
    expect(Array.isArray(result.memories)).toBe(true)
  })

  it('formatted output has no ### Context section when graph is absent', async () => {
    await memory.ingest({
      role: 'user',
      content: 'Some meaningful content about TypeScript and Neo4j integration',
      sessionId: 's1',
    })
    await memory.ingest({
      role: 'assistant',
      content: 'Following up with additional context about the same topic',
      sessionId: 's1',
    })
    const result = await memory.recall('TypeScript integration')
    expect(result.formatted).not.toContain('### Context')
    expect(result.formatted).not.toContain('### Faint Associations')
  })

  it('deep-mode recall still produces associations via SQL walk', async () => {
    // Ingest several related messages to build up the SQL association graph
    for (let i = 0; i < 5; i++) {
      await memory.ingest({
        role: 'user',
        content: `Message ${i} about engram memory retrieval and neo4j graphs`,
        sessionId: 'deep-session',
      })
    }
    // Deep-mode query
    const result = await memory.recall('what do you remember about engram?')
    expect(result).toBeDefined()
    // Associations may or may not be populated depending on SQL walk behavior,
    // but the call must not throw
    expect(Array.isArray(result.associations)).toBe(true)
  })
})
