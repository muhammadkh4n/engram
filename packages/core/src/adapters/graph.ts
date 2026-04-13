/**
 * GraphPort — the minimal interface core needs from a Wave 2 neural graph.
 *
 * This is a ports-and-adapters style contract. Core depends only on this
 * interface, never on the concrete Neo4j implementation in @engram-mem/graph.
 * NeuralGraph structurally satisfies this port; other graph backends can
 * do the same without requiring changes to core.
 *
 * Defining this here also breaks what would otherwise be a circular
 * dependency: core is the authoritative place for types that belong to
 * cognitive memory, and graph implementations are downstream.
 */

// ---------------------------------------------------------------------------
// Episode ingestion
// ---------------------------------------------------------------------------

/**
 * Simplified episode shape for graph decomposition. When `llmEntities` is
 * provided, graph implementations should prefer them over any internal
 * regex-based extraction.
 */
export interface GraphEpisodeInput {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  salience: number
  entities: string[]
  createdAt: string | Date
  previousEpisodeId?: string
  llmEntities?: Array<{
    name: string
    type: 'person' | 'org' | 'tech' | 'project' | 'concept'
    confidence: number
  }>
  /**
   * Optional project scope tag. When set, the graph should create a
   * :Project node and a Memory-[:PROJECT]->Project edge so memories
   * within the same project cluster together. Missing / empty means
   * the memory is not scoped to a project.
   */
  project?: string
}

// ---------------------------------------------------------------------------
// Spreading activation
// ---------------------------------------------------------------------------

export interface GraphSpreadActivationOpts {
  seedNodeIds: string[]
  seedActivations?: Map<string, number>
  maxHops?: number
  decay?: number
  threshold?: number
  budget?: number
  edgeFilter?: string[]
}

export interface GraphActivatedNode {
  nodeId: string
  nodeType: string
  activation: number
  depth: number
  properties: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Entity lookup
// ---------------------------------------------------------------------------

export interface GraphEntitySeedResult {
  nodeId: string
  nodeType: 'Person' | 'Entity' | 'Topic'
  name: string
}

// ---------------------------------------------------------------------------
// The port itself
// ---------------------------------------------------------------------------

/**
 * A neural graph backend that core can optionally use for Wave 2+
 * spreading activation, context assembly, and reconsolidation.
 *
 * All methods are optional at runtime in the sense that the entire port
 * may be absent (no graph configured). Implementations should provide
 * every method; core calls them only when the graph reference is non-null.
 */
/** Minimal shape of a Neo4j QueryResult for consolidation operations. */
export interface GraphQueryResult {
  records: Array<{ get(key: string): unknown; toObject(): Record<string, unknown> }>
  summary: {
    counters: {
      nodesCreated(): number
      relationshipsCreated(): number
      relationshipsDeleted(): number
      propertiesSet(): number
    }
  }
}

export interface GraphPort {
  isAvailable(): Promise<boolean>
  ingestEpisode(input: GraphEpisodeInput): Promise<void>
  lookupEntityNodes(names: string[]): Promise<GraphEntitySeedResult[]>
  spreadActivation(opts: GraphSpreadActivationOpts): Promise<GraphActivatedNode[]>
  strengthenTraversedEdges(pairs: Array<[string, string]>): Promise<void>
  // Wave 3: raw Cypher execution for consolidation operations
  // Returns the driver-native result type — consolidation code accesses
  // .records and .summary.counters via the GraphQueryResult shape, but
  // the actual neo4j-driver QueryResult is a structural superset.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runCypher?(query: string, params?: Record<string, unknown>): Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runCypherWrite?(query: string, params?: Record<string, unknown>): Promise<any>
  // Wave 3: check if Neo4j GDS plugin is available
  isGdsAvailable?(): Promise<boolean>
}
