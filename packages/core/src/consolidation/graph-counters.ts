/**
 * Extract counters from a graph query result in a driver-agnostic way.
 *
 * neo4j-driver v5: counters._stats.nodesCreated (or counters.updates().nodesCreated)
 * Mock/test:       counters.nodesCreated() as a function
 */

interface CounterResult {
  nodesCreated: number
  relationshipsCreated: number
  relationshipsDeleted: number
  propertiesSet: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractCounters(result: any): CounterResult {
  const counters = result?.summary?.counters
  if (!counters) return { nodesCreated: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0 }

  // neo4j-driver v5: _stats is a plain object with numeric properties
  if (counters._stats) {
    const s = counters._stats
    return {
      nodesCreated: s.nodesCreated ?? 0,
      relationshipsCreated: s.relationshipsCreated ?? 0,
      relationshipsDeleted: s.relationshipsDeleted ?? 0,
      propertiesSet: s.propertiesSet ?? 0,
    }
  }

  // neo4j-driver v5 alternative: updates() method
  if (typeof counters.updates === 'function') {
    const u = counters.updates()
    return {
      nodesCreated: u.nodesCreated ?? 0,
      relationshipsCreated: u.relationshipsCreated ?? 0,
      relationshipsDeleted: u.relationshipsDeleted ?? 0,
      propertiesSet: u.propertiesSet ?? 0,
    }
  }

  // Mock/test format: functions on counters directly
  if (typeof counters.nodesCreated === 'function') {
    return {
      nodesCreated: counters.nodesCreated(),
      relationshipsCreated: counters.relationshipsCreated(),
      relationshipsDeleted: counters.relationshipsDeleted(),
      propertiesSet: counters.propertiesSet(),
    }
  }

  return { nodesCreated: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0 }
}
