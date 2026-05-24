/**
 * Optional NeuralGraph factory for benchmarks.
 *
 * The bench harness creates a fresh in-memory SQLite Memory per conversation,
 * but Neo4j is a shared external process — we cannot trivially "fresh" it.
 *
 * To avoid accidentally polluting production graph data, this helper REQUIRES
 * a bench-specific env var (`ENGRAM_BENCH_NEO4J_URI`), NOT the production
 * `NEO4J_URI` that the MCP server uses. Operators wire bench against a
 * separate Neo4j container/database explicitly.
 *
 *   ENGRAM_BENCH_NEO4J_URI=bolt://localhost:7688    # different port from prod
 *   ENGRAM_BENCH_NEO4J_USER=neo4j
 *   ENGRAM_BENCH_NEO4J_PASSWORD=<password>
 *
 * Returns null when the bench env var is absent OR connection fails —
 * bench falls back to SQL-only mode (the prior behavior). The factory
 * also returns null when `opts.graph === false` (explicit opt-out).
 */

import { NeuralGraph } from '@engram-mem/graph'

export async function tryCreateBenchGraph(): Promise<NeuralGraph | null> {
  const uri = process.env['ENGRAM_BENCH_NEO4J_URI']
  if (!uri) return null

  const user = process.env['ENGRAM_BENCH_NEO4J_USER'] ?? 'neo4j'
  const password = process.env['ENGRAM_BENCH_NEO4J_PASSWORD'] ?? ''
  if (!password) {
    process.stderr.write(
      '[engram-bench] ENGRAM_BENCH_NEO4J_PASSWORD not set — graph disabled\n',
    )
    return null
  }

  try {
    const graph = new NeuralGraph({
      neo4jUri: uri,
      neo4jUser: user,
      neo4jPassword: password,
      enabled: true,
    })
    await graph.initialize()
    process.stderr.write(`[engram-bench] Neo4j graph enabled at ${uri}\n`)
    return graph
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[engram-bench] Neo4j unreachable (${message}) — falling back to SQL-only mode\n`,
    )
    return null
  }
}

/**
 * Wipe ALL nodes and edges from the bench Neo4j database. Destructive;
 * intended to be called between conversation runs in benchmarks so each
 * conv starts with a clean graph (matching the per-conv-fresh-SQLite
 * pattern used by createBenchMemory).
 *
 * Safe to call against the bench Neo4j only — never call this against a
 * production-pointed instance. Guard at the operator level by keeping
 * `ENGRAM_BENCH_NEO4J_URI` pointed at a separate container.
 */
export async function wipeBenchGraph(graph: NeuralGraph): Promise<void> {
  // Single-statement total wipe — DETACH ensures relationships drop with
  // their endpoints. Uses runCypherWrite (the mutating variant) so the
  // statement goes through the write path.
  await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
}
