import { SqliteStorageAdapter } from '@engram-mem/sqlite'
import { openaiIntelligence } from '@engram-mem/openai'
import { createMemory } from '@engram-mem/core'
import type { Memory } from '@engram-mem/core'
import type { BenchmarkOpts } from './types.js'

/**
 * Create an in-memory SQLite-backed Memory instance for benchmark use.
 * Each call returns a fresh database — benchmarks start with clean slate.
 *
 * graph option controls Neo4j: when false, Memory.graph is null and all
 * graph codepaths are skipped via null-checks (Wave 2 pattern).
 */
export async function createBenchMemory(opts?: BenchmarkOpts): Promise<Memory> {
  const storage = new SqliteStorageAdapter(':memory:')

  const apiKey = opts?.openaiApiKey ?? process.env['OPENAI_API_KEY']
  const intelligence = apiKey ? openaiIntelligence({ apiKey }) : undefined

  const memory = createMemory({
    storage,
    intelligence,
  })

  await memory.initialize()
  return memory
}
