export interface GraphConfig {
  neo4jUri: string
  neo4jUser: string
  neo4jPassword: string
  enabled: boolean
}

export function parseGraphConfig(env: Record<string, string | undefined> = process.env): GraphConfig {
  return {
    neo4jUri: env.NEO4J_URI ?? 'bolt://localhost:7687',
    neo4jUser: env.NEO4J_USER ?? 'neo4j',
    neo4jPassword: env.NEO4J_PASSWORD ?? 'engram-dev',
    enabled: env.ENGRAM_GRAPH_ENABLED !== 'false',
  }
}

export function validateGraphConfig(config: GraphConfig): void {
  if (!config.neo4jUri) throw new Error('GraphConfig: neo4jUri is required')
  if (!config.neo4jUri.startsWith('bolt://') && !config.neo4jUri.startsWith('neo4j://')) {
    throw new Error(`GraphConfig: neo4jUri must start with bolt:// or neo4j://, got: ${config.neo4jUri}`)
  }
  if (!config.neo4jUser) throw new Error('GraphConfig: neo4jUser is required')
  if (!config.neo4jPassword) throw new Error('GraphConfig: neo4jPassword is required')
}
