import neo4j from 'neo4j-driver'
import { NeuralGraph } from '../../src/neural-graph.js'
import { SpreadingActivation } from '../../src/spreading-activation.js'
import type { GraphConfig } from '../../src/config.js'

export function getTestConfig(): GraphConfig {
  return {
    neo4jUri: process.env.NEO4J_TEST_URI ?? 'bolt://localhost:7687',
    neo4jUser: process.env.NEO4J_TEST_USER ?? 'neo4j',
    neo4jPassword: process.env.NEO4J_TEST_PASSWORD ?? 'engram-dev',
    enabled: true,
  }
}

export async function createTestGraph(): Promise<NeuralGraph> {
  const config = getTestConfig()
  const graph = new NeuralGraph(config)
  await graph.initialize()
  await graph.clearAll()
  return graph
}

export function createTestActivation(): SpreadingActivation {
  const config = getTestConfig()
  const driver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
  )
  return new SpreadingActivation(driver)
}
