/**
 * Wave 2: Neo4j Spreading Activation Stage
 *
 * Bridges the retrieval pipeline to the Neo4j spreading activation engine.
 * Given vector/BM25 search results as seeds, plus entity seeds extracted
 * from the query itself, runs Cypher variable-length path traversal to
 * find memories that are associatively connected — even when they score
 * low on cosine similarity.
 *
 * Returns null when the graph cannot help (mixed population: old episodes
 * predate Wave 2 and have no graph nodes). The caller falls back to the
 * legacy SQL association walk.
 */

import type { GraphPort, GraphActivatedNode } from '../adapters/graph.js'
import type { Episode, RetrievedMemory, RecallStrategy } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import { extractEntities } from '../ingestion/entity-extractor.js'
import { assembleContext } from './context-assembly.js'

// ---------------------------------------------------------------------------
// CompositeMemory
// ---------------------------------------------------------------------------

/**
 * The structured environmental context assembled from graph activation.
 * Returned alongside core memories and associations when Neo4j is available.
 *
 * `dominantIntent` (not `intent`) avoids collision with RecallResult.intent,
 * which holds the HeuristicIntentAnalyzer result.
 *
 * `temporalContext` is an array — a recall result may span multiple sessions.
 */
export interface CompositeMemory {
  /** The primary recalled memories (same as RecallResult.memories). */
  coreMemories: RetrievedMemory[]
  /** Named participants found via Person nodes. */
  speakers: Array<{ name: string; role: string }>
  /** Emotional tones found via Emotion nodes. */
  emotionalContext: Array<{ label: string; intensity: number }>
  /** Dominant content intent across activated Memory nodes. */
  dominantIntent: string
  /** Temporal contexts (session + time-of-day + date). */
  temporalContext: Array<{ session: string; timeOfDay: string; date: string }>
  /** Topic/entity nodes that appeared in activated memories. */
  relatedTopics: string[]
  /**
   * Low-activation memories (below primary threshold but above faint
   * threshold). Memories the graph connected to, with weak signal.
   */
  faintAssociations: RetrievedMemory[]
}

// ---------------------------------------------------------------------------
// Activation parameters
// ---------------------------------------------------------------------------

interface ActivationParams {
  maxHops: number
  decay: number
  /** Min activation for inclusion in primary associations. */
  threshold: number
  /** Min activation for inclusion in faint associations (below threshold). */
  faintThreshold: number
  /** Max nodes the Cypher traversal visits before stopping. */
  budget: number
  /** Edge types to filter traversal. Empty = all types allowed. */
  preferredEdges: string[]
}

const DEFAULT_PARAMS: ActivationParams = {
  maxHops: 2,
  decay: 0.6,
  threshold: 0.1,
  faintThreshold: 0.03,
  budget: 100,
  preferredEdges: [],
}

/**
 * Derive activation parameters from the recall strategy. Light mode gets
 * tighter params; deep mode gets broader defaults. Per-intent tuning is a
 * Wave 3 enhancement — the existing RecallStrategy carries mode, not
 * IntentType, so we use mode as a proxy for now.
 */
function getActivationParams(strategy: RecallStrategy): ActivationParams {
  if (strategy.mode === 'light') {
    return { ...DEFAULT_PARAMS, maxHops: 2, decay: 0.5, budget: 60 }
  }
  return DEFAULT_PARAMS
}

// ---------------------------------------------------------------------------
// Entity-based seed injection (independent graph retrieval path)
// ---------------------------------------------------------------------------

/**
 * Extract query entities and look them up in Neo4j to generate additional
 * seeds.
 *
 * Creates seeds from the QUERY, not from vector results. Without this, the
 * graph only amplifies what vector search already found — it adds no
 * independent signal. "What did Sarah say about X?" should surface memories
 * attached to Sarah's Person node even if none of them mention her name.
 */
async function getEntitySeeds(
  query: string,
  graph: GraphPort,
): Promise<Map<string, number>> {
  const seeds = new Map<string, number>()

  try {
    const entityNames = extractEntities(query)
    if (entityNames.length === 0) return seeds

    const found = await graph.lookupEntityNodes(entityNames)

    for (const result of found) {
      // Person nodes get the highest initial activation — person attribution
      // is the strongest contextual signal we have.
      const activation = result.nodeType === 'Person' ? 0.7 : 0.5
      seeds.set(result.nodeId, activation)
    }
  } catch (err) {
    console.warn('[engram] entity seed lookup failed:', err)
  }

  return seeds
}

// ---------------------------------------------------------------------------
// stageActivate
// ---------------------------------------------------------------------------

export interface ActivationResultSet {
  associations: RetrievedMemory[]
  context: CompositeMemory
}

/**
 * Run Neo4j spreading activation from vector search seeds + entity seeds.
 *
 * Returns null when no seeds map to graph nodes (mixed population scenario
 * where vector results are old episodes without graph nodes). The caller
 * then falls back to the legacy SQL association walk.
 *
 * Returning null (not empty results) signals "graph could not help" vs
 * "graph ran and found nothing". These have different implications.
 */
export async function stageActivate(
  recalled: RetrievedMemory[],
  query: string,
  graph: GraphPort,
  strategy: RecallStrategy,
  storage: StorageAdapter,
  project?: string,
): Promise<ActivationResultSet | null> {
  const params = getActivationParams(strategy)

  // --- Build seed map from vector results ---
  // Memory nodes in Neo4j have id = episode.id (same UUID as SQL).
  // A recalled memory may or may not have a graph node (mixed population).
  const seedActivations = new Map<string, number>()
  for (const m of recalled.slice(0, 8)) {
    seedActivations.set(m.id, m.relevance)
  }

  // --- Entity-based seeds (independent graph retrieval path) ---
  const entitySeeds = await getEntitySeeds(query, graph)
  for (const [nodeId, activation] of entitySeeds) {
    if (!seedActivations.has(nodeId)) {
      seedActivations.set(nodeId, activation)
    }
  }

  // --- Project seed (soft preference) ---
  // When a project is provided, add its node as an additional seed with
  // activation 0.6. Spreading activation from the project node naturally
  // pulls in all memories sharing the PROJECT edge, boosting same-project
  // associations without hard-filtering cross-project content.
  if (project && project !== 'global') {
    const projectNodeId = `project:${project.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')}`
    if (!seedActivations.has(projectNodeId)) {
      seedActivations.set(projectNodeId, 0.6)
    }
  }

  if (seedActivations.size === 0) {
    // No seeds at all — nothing to activate from
    return null
  }

  // --- Run spreading activation via Cypher ---
  let activatedNodes: GraphActivatedNode[]
  try {
    activatedNodes = await graph.spreadActivation({
      seedNodeIds: Array.from(seedActivations.keys()),
      seedActivations,
      maxHops: params.maxHops,
      decay: params.decay,
      // Use faint threshold so the full result set is returned; we filter
      // primary vs faint client-side.
      threshold: params.faintThreshold,
      budget: params.budget,
      edgeFilter: params.preferredEdges,
    })
  } catch (err) {
    console.warn('[engram] spreadActivation failed:', err)
    return null
  }

  // --- Mixed population check ---
  // If activatedNodes only contains context nodes (Person, Topic, etc.) but
  // no Memory nodes from the seeds, the graph has no records for these
  // episodes. Entity seeds may still keep us alive, though.
  const activatedMemoryNodes = activatedNodes.filter((n) => n.nodeType === 'Memory')
  if (activatedMemoryNodes.length === 0 && entitySeeds.size === 0) {
    return null
  }

  // --- Separate primary from faint associations ---
  const primaryNodes = activatedNodes.filter(
    (n) => n.nodeType === 'Memory' && n.activation >= params.threshold,
  )
  const faintNodes = activatedNodes.filter(
    (n) =>
      n.nodeType === 'Memory' &&
      n.activation >= params.faintThreshold &&
      n.activation < params.threshold,
  )

  // --- Batched content loading ---
  // Load full episode content from SQL using getByIds (one query for all IDs),
  // NOT sequential getById calls (N round-trips).
  const recalledIdSet = new Set(recalled.map((m) => m.id))

  const primaryIds = primaryNodes
    .map((n) => n.nodeId)
    .filter((id) => !recalledIdSet.has(id))

  const faintIds = faintNodes
    .map((n) => n.nodeId)
    .filter((id) => !recalledIdSet.has(id) && !primaryIds.includes(id))

  const [primaryEpisodes, faintEpisodes] = await Promise.all([
    primaryIds.length > 0
      ? storage.episodes.getByIds(primaryIds)
      : Promise.resolve([] as Episode[]),
    faintIds.length > 0
      ? storage.episodes.getByIds(faintIds)
      : Promise.resolve([] as Episode[]),
  ])

  // Build activation lookup for scoring
  const activationByNodeId = new Map(
    activatedNodes.map((n) => [n.nodeId, n.activation]),
  )

  function toRetrievedMemory(episode: Episode): RetrievedMemory {
    const activation = activationByNodeId.get(episode.id) ?? 0
    return {
      id: episode.id,
      type: 'episode' as const,
      content: episode.content,
      relevance: activation,
      source: 'association' as const,
      metadata: {
        ...episode.metadata,
        graphActivation: activation,
        activationSource: 'spreading_activation',
      },
    }
  }

  const associations = primaryEpisodes
    .map(toRetrievedMemory)
    .sort((a, b) => b.relevance - a.relevance)

  const faintAssociations = faintEpisodes
    .map(toRetrievedMemory)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 5) // cap faint associations at 5

  // --- Assemble context from non-Memory activated nodes ---
  const context = assembleContext(
    recalled,
    associations,
    faintAssociations,
    activatedNodes,
  )

  return { associations, context }
}
