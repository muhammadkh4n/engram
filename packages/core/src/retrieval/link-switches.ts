import type { EdgeType } from '../types.js'

/**
 * Switches for the links recall writes and follows because of what it
 * displayed.
 *
 * - `coRecall`: reconsolidation creates or strengthens `co_recalled` edges
 *   among the top emitted memories. A new edge starts at strength 0.2, the
 *   association walk's minimum, so it is walkable on the next recall.
 * - `graphReinforce`: reconsolidation adds weight to the graph relationships
 *   between consecutive emitted memories, whether or not recall traversed them.
 * - `walkExclude`: edge types the SQL association walk does not follow.
 *
 * The defaults are today's behaviour: both writes on, nothing excluded.
 */
export interface RecallLinkSwitches {
  coRecall: boolean
  graphReinforce: boolean
  walkExclude: readonly EdgeType[]
}

export const RECALL_LINK_DEFAULTS: RecallLinkSwitches = Object.freeze({
  coRecall: true,
  graphReinforce: true,
  walkExclude: Object.freeze([] as EdgeType[]),
})

// A Record keyed by the union fails to compile when a member is missing.
const EDGE_TYPE_KEYS: Record<EdgeType, true> = {
  temporal: true,
  causal: true,
  topical: true,
  supports: true,
  contradicts: true,
  elaborates: true,
  derives_from: true,
  co_recalled: true,
}

export const EDGE_TYPES: readonly EdgeType[] = Object.freeze(Object.keys(EDGE_TYPE_KEYS) as EdgeType[])

function isEdgeType(value: string): value is EdgeType {
  return Object.prototype.hasOwnProperty.call(EDGE_TYPE_KEYS, value)
}

export function onOffFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim()
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`${name} must be "on" or "off", got "${raw}"`)
}

/** Comma list of edge types; unset or blank excludes nothing. Each entry
 *  must name an edge type, so a typo fails instead of excluding nothing. */
function edgeTypesFromEnv(env: NodeJS.ProcessEnv, name: string): readonly EdgeType[] {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return RECALL_LINK_DEFAULTS.walkExclude
  const types = new Set<EdgeType>()
  for (const entry of raw.split(',')) {
    const value = entry.trim()
    if (!isEdgeType(value)) {
      throw new Error(`${name} must be a comma list of edge types (${EDGE_TYPES.join(', ')}), got "${raw}"`)
    }
    types.add(value)
  }
  return Object.freeze([...types])
}

/**
 * Read ENGRAM_RECALL_CORECALL and ENGRAM_RECALL_GRAPH_REINFORCE (on|off,
 * default on) and ENGRAM_RECALL_WALK_EXCLUDE (comma list of edge types,
 * default none). Any other value throws, naming the variable.
 */
export function recallLinkSwitchesFromEnv(env: NodeJS.ProcessEnv = process.env): RecallLinkSwitches {
  return {
    coRecall: onOffFromEnv(env, 'ENGRAM_RECALL_CORECALL', RECALL_LINK_DEFAULTS.coRecall),
    graphReinforce: onOffFromEnv(env, 'ENGRAM_RECALL_GRAPH_REINFORCE', RECALL_LINK_DEFAULTS.graphReinforce),
    walkExclude: edgeTypesFromEnv(env, 'ENGRAM_RECALL_WALK_EXCLUDE'),
  }
}

/**
 * Read ENGRAM_RECALL_FAN (on|off, default off): whether recall's graph stage
 * spreads activation with the fan effect and without the project seed. Any
 * other value throws, naming the variable.
 */
export function recallFanEffectFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return onOffFromEnv(env, 'ENGRAM_RECALL_FAN', false)
}
