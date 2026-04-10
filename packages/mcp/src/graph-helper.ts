/**
 * Shared helper to optionally construct a NeuralGraph from environment.
 *
 * Returns null when NEO4J_URI is absent or Neo4j is unreachable. Errors
 * are written to stderr only — stdout belongs to the MCP JSON-RPC
 * transport and any noise there corrupts the protocol.
 */

import { NeuralGraph } from '@engram-mem/graph'

export async function tryCreateGraph(logPrefix: string): Promise<NeuralGraph | null> {
  const neo4jUri = process.env['NEO4J_URI']
  if (!neo4jUri) return null

  const neo4jUser = process.env['NEO4J_USER'] ?? 'neo4j'
  const neo4jPassword = process.env['NEO4J_PASSWORD'] ?? 'engram-dev'

  try {
    const graph = new NeuralGraph({
      neo4jUri,
      neo4jUser,
      neo4jPassword,
      enabled: true,
    })
    await graph.initialize()
    process.stderr.write(`${logPrefix} Neo4j graph enabled at ${neo4jUri}\n`)
    return graph
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `${logPrefix} Neo4j unreachable (${message}) — running in SQL-only mode\n`,
    )
    return null
  }
}
