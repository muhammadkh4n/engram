import type { NeuralGraph } from './neural-graph.js'
import type { ActivatedNode } from './neural-graph.js'

export interface PatternCompletionInput {
  entities: string[]
  emotions: string[]
  persons: string[]
  topics: string[]
}

export interface PatternCompletionResult {
  activationResults: ActivatedNode[]
  seedsUsed: number
  convergenceMap: Map<string, number>
}

/**
 * Given partial cue attributes, find matching context nodes in Neo4j,
 * run spreading activation from each attribute group independently,
 * and apply convergence bonuses to Memory nodes reached from multiple attributes.
 *
 * All graph operations use Cypher via NeuralGraph — no in-process iteration.
 */
export async function runPatternCompletion(
  graph: NeuralGraph,
  input: PatternCompletionInput,
  config?: { maxHops?: number; decay?: number; threshold?: number }
): Promise<PatternCompletionResult> {
  const threshold = config?.threshold ?? 0.01

  // Step 1: Find matching context nodes via Cypher
  const seedsByAttribute = await graph.findMatchingContextNodes(input)

  if (seedsByAttribute.length === 0) {
    return { activationResults: [], seedsUsed: 0, convergenceMap: new Map() }
  }

  // Step 2: Run spreading activation from EACH attribute group independently
  // This lets us measure how many independent attribute paths converge on a memory
  const perAttributeActivations: Array<Map<string, number>> = []

  for (const { nodeIds } of seedsByAttribute) {
    const seedActivations = new Map<string, number>()
    for (const nodeId of nodeIds) {
      seedActivations.set(nodeId, 0.8) // 0.8 multiplier for pattern-completion seeds
    }

    const results = await graph.spreadActivation({
      seedNodeIds: nodeIds,
      seedActivations,
      maxHops: config?.maxHops ?? 3,
      decay: config?.decay ?? 0.5,
      threshold,
    })

    const activationMap = new Map<string, number>()
    for (const r of results) {
      activationMap.set(r.nodeId, r.activation)
    }
    perAttributeActivations.push(activationMap)
  }

  // Step 3: Build convergence map — for each Memory node, count how many
  // attribute groups activated it above threshold
  const convergenceMap = new Map<string, number>()
  const mergedActivation = new Map<string, number>()

  for (const attributeMap of perAttributeActivations) {
    for (const [nodeId, activation] of attributeMap) {
      // Only count convergence on Memory nodes (they start with UUID or known prefix)
      // We need to check if it's a Memory node. Since we can't iterate nodeType
      // in-process, filter by node ID convention: Memory IDs are UUIDs,
      // context nodes have prefixes like 'person:', 'entity:', 'topic:', etc.
      if (nodeId.includes(':')) continue // skip context nodes
      convergenceMap.set(nodeId, (convergenceMap.get(nodeId) ?? 0) + 1)
      const existing = mergedActivation.get(nodeId) ?? 0
      mergedActivation.set(nodeId, Math.max(existing, activation))
    }
  }

  // Step 4: Apply convergence bonus — each additional attribute that confirms a memory
  // multiplies its activation by 1.2
  for (const [nodeId, convergenceCount] of convergenceMap) {
    if (convergenceCount < 2) continue
    const base = mergedActivation.get(nodeId) ?? 0
    const bonus = Math.pow(1.2, convergenceCount - 1)
    mergedActivation.set(nodeId, Math.min(1.0, base * bonus))
  }

  // Step 5: Convert to ActivatedNode array, sorted by activation DESC
  const activationResults: ActivatedNode[] = []
  for (const [nodeId, activation] of mergedActivation) {
    if (activation < threshold) continue
    activationResults.push({
      nodeId,
      nodeType: 'memory',
      activation,
      depth: 0,
      properties: {},
    })
  }
  activationResults.sort((a, b) => b.activation - a.activation)

  return {
    activationResults,
    seedsUsed: seedsByAttribute.length,
    convergenceMap,
  }
}
