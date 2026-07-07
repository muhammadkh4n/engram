/**
 * Phase 0 — requireGraph hard-fail guard.
 *
 * A graph matrix cell that runs without a real bench Neo4j would silently fall
 * back to SQL-only and report a SQL delta as a "graph" result — the exact
 * measurement trap Phase 0 exists to kill. requireGraph converts that silent
 * fallback into a loud throw. (The success path needs a live NeuralGraph and is
 * exercised by the matrix runner against a real bench Neo4j.)
 */
import { describe, it, expect } from 'vitest'
import { requireGraph, type BenchMemoryHandle } from '../src/bench-memory-handle.js'

const fakeMemory = {} as BenchMemoryHandle['memory']

describe('requireGraph', () => {
  it('throws when the graph was never wired (no silent SQL-only fallback)', () => {
    const handle: BenchMemoryHandle = {
      memory: fakeMemory,
      config: { graph: null, rerankerBackend: 'none' },
      graphActuallyWired: false,
      engineActuallyWired: false,
    }
    expect(() => requireGraph(handle)).toThrow(/Neo4j is not wired/)
  })

  it('throws defensively when graphActuallyWired is true but the handle is null', () => {
    const handle: BenchMemoryHandle = {
      memory: fakeMemory,
      config: { graph: null, rerankerBackend: 'openai' },
      graphActuallyWired: true,
      engineActuallyWired: false,
    }
    expect(() => requireGraph(handle)).toThrow()
  })
})
