import type { GraphPort } from '../adapters/graph.js'
import { extractCounters } from './graph-counters.js'
import { namedEntities } from './named-entities.js'

/**
 * Outcome of linking one consolidated memory to context nodes. `kept` and
 * `dropped` split the candidate context nodes of the memory's sources by
 * whether the memory's own text names them; a memory with zero kept links
 * is valid.
 */
export interface ContextLinkCounts {
  readonly kept: number
  readonly dropped: number
  readonly relationshipsCreated: number
}

interface ScoredCandidate {
  /** Neo4j element id: unique across labels and a direct seek in the write. */
  readonly id: string
  readonly name: string
  readonly score: number | null
}

interface CandidateRecord {
  get(key: string): unknown
}

const NO_LINKS: ContextLinkCounts = { kept: 0, dropped: 0, relationshipsCreated: 0 }

/** Fact links inherit the strongest digest link, damped by one more hop. */
const FACT_INHERITANCE = 0.7

/** Driver integers arrive as objects with toNumber(); stubs pass numbers. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber()
  }
  return null
}

function toCandidates(result: unknown, scoreKey: string): ScoredCandidate[] {
  const records = (result as { records?: CandidateRecord[] } | null)?.records ?? []
  return records.map(record => {
    const name = record.get('name')
    return {
      id: String(record.get('nodeId')),
      name: typeof name === 'string' ? name : '',
      score: toNumberOrNull(record.get(scoreKey)),
    }
  })
}

function keepNamed(text: string, candidates: ScoredCandidate[]): ScoredCandidate[] {
  const kept = new Set(namedEntities(text, candidates).ids)
  return candidates.filter(candidate => kept.has(candidate.id))
}

/**
 * Links a digest to the Person/Entity/Topic nodes of its source episodes
 * that its summary names. The union of every source episode's context would
 * give each digest of a session the same large entity set, and every fact
 * derived from it would inherit that set again, so sibling memories tie
 * under spreading activation. Weight is the share of source episodes that
 * link the node.
 */
export async function linkDigestContext(
  graph: GraphPort,
  input: {
    digestId: string
    summary: string
    sourceEpisodeIds: string[]
    totalSources: number
    now: string
  },
): Promise<ContextLinkCounts> {
  if (!graph.runCypher || !graph.runCypherWrite) return NO_LINKS

  const read = await graph.runCypher(`
    MATCH (ep:Memory)-[:SPOKE|CONTEXTUAL|TOPICAL]->(ctx)
    WHERE ep.id IN $sourceEpisodeIds
      AND (ctx:Person OR ctx:Entity OR ctx:Topic)
    WITH ctx, count(DISTINCT ep) AS frequency
    RETURN elementId(ctx) AS nodeId, ctx.name AS name, frequency
    ORDER BY nodeId
  `, { sourceEpisodeIds: input.sourceEpisodeIds })

  const candidates = toCandidates(read, 'frequency')
  const kept = keepNamed(input.summary, candidates)
  const dropped = candidates.length - kept.length
  if (kept.length === 0) return { kept: 0, dropped, relationshipsCreated: 0 }

  const links = kept.map(candidate => ({
    nodeId: candidate.id,
    weight: (candidate.score ?? 0) / input.totalSources,
  }))
  const write = await graph.runCypherWrite(`
    MATCH (d:Memory {id: $digestId})
    UNWIND $links AS link
    MATCH (ctx) WHERE elementId(ctx) = link.nodeId
    MERGE (d)-[rel:CONTEXTUAL]->(ctx)
    ON CREATE SET rel.weight = link.weight,
                  rel.createdAt = $now,
                  rel.lastTraversed = null,
                  rel.traversalCount = 0
    ON MATCH SET rel.weight = link.weight,
                 rel.lastTraversed = $now
  `, { digestId: input.digestId, links, now: input.now })

  return {
    kept: kept.length,
    dropped,
    relationshipsCreated: extractCounters(write).relationshipsCreated,
  }
}

/**
 * Links a fact to the context nodes of its source digests that the fact's
 * own topic and content name, with the strongest digest link damped by one
 * hop. An existing link only ever gains weight.
 */
export async function linkFactContext(
  graph: GraphPort,
  input: {
    semanticId: string
    text: string
    sourceDigestIds: string[]
    now: string
  },
): Promise<ContextLinkCounts> {
  if (!graph.runCypher || !graph.runCypherWrite) return NO_LINKS

  const read = await graph.runCypher(`
    MATCH (dig:Memory)-[r:CONTEXTUAL]->(ctx)
    WHERE dig.id IN $sourceDigestIds
      AND (ctx:Person OR ctx:Entity OR ctx:Topic)
    WITH ctx, max(r.weight) AS weight
    RETURN elementId(ctx) AS nodeId, ctx.name AS name, weight
    ORDER BY nodeId
  `, { sourceDigestIds: input.sourceDigestIds })

  const candidates = toCandidates(read, 'weight')
  const kept = keepNamed(input.text, candidates)
  const dropped = candidates.length - kept.length
  if (kept.length === 0) return { kept: 0, dropped, relationshipsCreated: 0 }

  const links = kept.map(candidate => ({ nodeId: candidate.id, weight: candidate.score }))
  const write = await graph.runCypherWrite(`
    MATCH (s:Memory {id: $semanticId})
    UNWIND $links AS link
    MATCH (ctx) WHERE elementId(ctx) = link.nodeId
    WITH s, ctx, link.weight * $inheritance AS inheritedWeight
    MERGE (s)-[rel:CONTEXTUAL]->(ctx)
    ON CREATE SET rel.weight = inheritedWeight,
                  rel.createdAt = $now,
                  rel.lastTraversed = null,
                  rel.traversalCount = 0
    ON MATCH SET rel.weight = CASE
                   WHEN rel.weight < inheritedWeight THEN inheritedWeight
                   ELSE rel.weight
                 END,
                 rel.lastTraversed = $now
  `, { semanticId: input.semanticId, links, inheritance: FACT_INHERITANCE, now: input.now })

  return {
    kept: kept.length,
    dropped,
    relationshipsCreated: extractCounters(write).relationshipsCreated,
  }
}
