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
import type { MemoryType, RetrievedMemory, RecallStrategy, TypedMemory } from '../types.js'
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

export interface StageActivateOptions {
  /**
   * Spread with the fan effect (see GraphSpreadActivationOpts.fanEffect) and
   * without the project seed: the SQL stage already applies project scope and
   * boost, and from the Project node every member would tie.
   */
  fanEffect?: boolean
}

export interface ActivationResultSet {
  associations: RetrievedMemory[]
  context: CompositeMemory
  /**
   * Related candidates (primary and faint, before the faint cap) that did not
   * render: the node has no known memoryType, or its tier's store did not
   * return the row (missing, forgotten or superseded).
   */
  relatedUnhydrated: number
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
// Context reinstatement (Gap 4): seed weight for primed-topic context nodes.
// Below entity (0.5) / project (0.6) seeds — context nudges recall toward what
// is currently in focus; query relevance still dominates.
const CONTEXT_SEED_WEIGHT = 0.45

// Lateral inhibition (Gap 5): activation multiplier for high-betweenness hub
// nodes (flagged isBridge by the dream-cycle betweenness pass). < 1 suppresses
// generic connectors that would otherwise flood recall (the fan effect).
const HUB_INHIBITION_FACTOR = 0.5

export async function stageActivate(
  recalled: RetrievedMemory[],
  query: string,
  graph: GraphPort,
  strategy: RecallStrategy,
  storage: StorageAdapter,
  project?: string,
  projectId?: string,
  contextTopics?: string[],
  options: StageActivateOptions = {},
): Promise<ActivationResultSet | null> {
  const params = getActivationParams(strategy)
  const fanEffect = options.fanEffect === true

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
  // associations without hard-filtering cross-project content. Under the fan
  // effect it is left out: every member would tie from it, and the SQL stage
  // has already applied the project boost.
  if (!fanEffect && project && project !== 'global') {
    const projectNodeId = `project:${project.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')}`
    if (!seedActivations.has(projectNodeId)) {
      seedActivations.set(projectNodeId, 0.6)
    }
  }

  // --- Context reinstatement (Gap 4) ---
  // Seed from the active conversational context — topics primed by recent turns
  // (sensory buffer) — so the SAME query completes to different associations
  // depending on what is currently in focus (encoding specificity). Best-effort
  // and soft-weighted: query relevance dominates, context only nudges.
  if (contextTopics && contextTopics.length > 0) {
    try {
      const contextNodes = await graph.lookupEntityNodes(contextTopics)
      for (const node of contextNodes) {
        if (!seedActivations.has(node.nodeId)) {
          seedActivations.set(node.nodeId, CONTEXT_SEED_WEIGHT)
        }
      }
    } catch {
      // context reinstatement is enrichment only; never block recall
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
      // Set only for strict project scoping: confines activation to that
      // project's nodes instead of bridging through shared entity/person nodes.
      ...(projectId !== undefined ? { projectId } : {}),
      ...(fanEffect ? { fanEffect: true } : {}),
    })
  } catch (err) {
    console.warn('[engram] spreadActivation failed:', err)
    return null
  }

  // --- Lateral inhibition / fan effect (Gap 5) ---
  // Down-weight high-betweenness hub nodes (flagged isBridge by the dream-cycle
  // betweenness pass) so generic connectors don't dominate recall. Applied here,
  // before the threshold split, so a suppressed hub can fall out of the primary
  // set entirely. No-op when betweenness was never computed (no isBridge prop).
  activatedNodes = activatedNodes.map((n) =>
    n.properties?.['isBridge'] === true
      ? { ...n, activation: n.activation * HUB_INHIBITION_FACTOR }
      : n,
  )

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
  // Memory nodes of every tier relay activation, so each candidate is looked
  // up in its own tier's table, all of them in one batched call. The default
  // lookup skips forgotten and superseded rows: a retired fact can still sit
  // in the graph, and it must not render.
  const recalledIdSet = new Set(recalled.map((m) => m.id))
  const primaryCandidates = primaryNodes.filter((n) => !recalledIdSet.has(n.nodeId))
  const primaryIdSet = new Set(primaryCandidates.map((n) => n.nodeId))
  const faintCandidates = faintNodes.filter(
    (n) => !recalledIdSet.has(n.nodeId) && !primaryIdSet.has(n.nodeId),
  )

  const hydrated = await hydrateRelated([...primaryCandidates, ...faintCandidates], storage)
  if (hydrated.unhydrated > 0) {
    console.warn(
      `[engram] related: ${hydrated.unhydrated} activated memories not hydrated ` +
        `(${hydrated.untyped} without a known memoryType, ` +
        `${hydrated.unhydrated - hydrated.untyped} not returned by their tier)`,
    )
  }

  // Build activation lookup for scoring
  const activationByNodeId = new Map(
    activatedNodes.map((n) => [n.nodeId, n.activation]),
  )

  function toRetrievedMemory(typed: TypedMemory): RetrievedMemory {
    const activation = activationByNodeId.get(typed.data.id) ?? 0
    return {
      id: typed.data.id,
      type: typed.type,
      content: contentOf(typed),
      relevance: activation,
      source: 'association' as const,
      metadata: {
        ...typed.data.metadata,
        graphActivation: activation,
        activationSource: 'spreading_activation',
      },
    }
  }

  function hydratedFrom(candidates: GraphActivatedNode[]): RetrievedMemory[] {
    return candidates.flatMap((n) => {
      const row = hydrated.rows.get(n.nodeId)
      return row === undefined ? [] : [toRetrievedMemory(row)]
    })
  }

  // getByIds returns rows in no defined order, so activation ties must be
  // broken by the graph's own ranking (activation, newest createdAt, id) or
  // identical recalls render Related in a different order each time.
  const graphRankByNodeId = new Map(
    activatedNodes.map((n, index) => [n.nodeId, index]),
  )
  const byActivationThenGraphRank = (a: RetrievedMemory, b: RetrievedMemory): number =>
    b.relevance - a.relevance ||
    (graphRankByNodeId.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (graphRankByNodeId.get(b.id) ?? Number.MAX_SAFE_INTEGER)

  const associations = hydratedFrom(primaryCandidates).sort(byActivationThenGraphRank)

  const faintAssociations = hydratedFrom(faintCandidates)
    .sort(byActivationThenGraphRank)
    .slice(0, 5) // cap faint associations at 5

  // --- Assemble context from non-Memory activated nodes ---
  const context = assembleContext(
    recalled,
    associations,
    faintAssociations,
    activatedNodes,
  )

  return { associations, context, relatedUnhydrated: hydrated.unhydrated }
}

// ---------------------------------------------------------------------------
// Related hydration
// ---------------------------------------------------------------------------

const MEMORY_TYPES: ReadonlySet<string> = new Set<MemoryType>(['episode', 'digest', 'semantic', 'procedural'])

/** The tier a Memory node was written for; null when the node carries none. */
function memoryTypeOf(node: GraphActivatedNode): MemoryType | null {
  const value = node.properties?.['memoryType']
  return typeof value === 'string' && MEMORY_TYPES.has(value) ? (value as MemoryType) : null
}

function contentOf(typed: TypedMemory): string {
  switch (typed.type) {
    case 'episode': return typed.data.content
    case 'digest': return typed.data.summary
    case 'semantic': return typed.data.content
    case 'procedural': return typed.data.procedure
  }
}

interface RelatedHydration {
  /** Live rows by id, each from the tier its node names. */
  rows: Map<string, TypedMemory>
  /** Candidates whose node has no known memoryType. */
  untyped: number
  /** Every candidate without a row: untyped, or not returned by its tier. */
  unhydrated: number
}

async function hydrateRelated(
  candidates: GraphActivatedNode[],
  storage: StorageAdapter,
): Promise<RelatedHydration> {
  const refs: Array<{ id: string; type: MemoryType }> = []
  let untyped = 0
  for (const node of candidates) {
    const type = memoryTypeOf(node)
    if (type === null) untyped++
    else refs.push({ id: node.nodeId, type })
  }

  const found = refs.length > 0 ? await storage.getByIds(refs) : []
  const typeById = new Map(refs.map((ref) => [ref.id, ref.type]))
  const rows = new Map<string, TypedMemory>()
  for (const row of found) {
    if (typeById.get(row.data.id) === row.type) rows.set(row.data.id, row)
  }
  return { rows, untyped, unhydrated: untyped + typeById.size - rows.size }
}
