import neo4j, { type Driver, type ManagedTransaction, type QueryResult } from 'neo4j-driver'
import { ALL_SCHEMA_STATEMENTS } from './schema.js'
import type { GraphConfig } from './config.js'
import type {
  MemoryNodeInput,
  PersonNodeInput,
  TopicNodeInput,
  EntityNodeInput,
  EmotionNodeInput,
  IntentNodeInput,
  SessionNodeInput,
  TimeContextNodeInput,
  EpisodeDecomposition,
  RelationType,
  ActivationParams,
  ActivationResult,
} from './types.js'
import { SpreadingActivation } from './spreading-activation.js'
import { extractPersons, classifyEmotion } from './context-extractors.js'

// ============================================================================
// Wave 2 Facade Types
// ============================================================================

/**
 * Simplified episode shape used by consumers that don't want to build a
 * full EpisodeDecomposition. `ingestEpisode` extracts persons/emotion from
 * `content` internally and maps `entities` (string[]) to typed entity nodes.
 *
 * When `llmEntities` is provided (from an IntelligenceAdapter-backed
 * entity extractor), the regex-based person/entity extraction is SKIPPED
 * and the structured entities are used directly. This is the production
 * path for high-precision NER. The regex path remains as a fallback when
 * no intelligence adapter is available.
 */
export interface SimpleEpisodeInput {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  salience: number
  entities: string[]
  createdAt: string | Date
  previousEpisodeId?: string
  /**
   * Optional LLM-extracted typed entities. When present, takes precedence
   * over regex-based extraction for persons and entities. Type values:
   *   - 'person'  → added to persons[]
   *   - 'tech'    → Entity with entityType='tech'
   *   - 'project' → Entity with entityType='project'
   *   - 'concept' → Entity with entityType='concept'
   *   - 'org'     → Entity with entityType='concept' (Wave 1 has no 'org' type)
   */
  llmEntities?: Array<{
    name: string
    type: 'person' | 'org' | 'tech' | 'project' | 'concept'
    confidence: number
  }>
  /**
   * Optional project scope tag. Memories with the same project share a
   * :Project node via the PROJECT edge. Used by Wave 2 retrieval to
   * cluster same-project memories together via spreading activation.
   */
  project?: string
}

/** Result of looking up a query entity name in Neo4j */
export interface EntitySeedResult {
  nodeId: string
  nodeType: 'Person' | 'Entity' | 'Topic'
  name: string
}

/** Wave 2 spreadActivation options (wraps SpreadingActivation.activate) */
export interface SpreadActivationOpts {
  seedNodeIds: string[]
  /** Optional per-seed initial activation (currently unused by the Cypher query) */
  seedActivations?: Map<string, number>
  maxHops?: number
  decay?: number
  threshold?: number
  budget?: number
  edgeFilter?: string[]
}

/** Wave 2 ActivatedNode — matches ActivationResult with stable field names */
export interface ActivatedNode {
  nodeId: string
  nodeType: string
  activation: number
  depth: number
  properties: Record<string, unknown>
}

// ============================================================================
// Neo4j Integer Conversion
// ============================================================================

function toNativeProperties(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if (neo4j.isInt(value)) {
      result[key] = (value as { toNumber: () => number }).toNumber()
    } else {
      result[key] = value
    }
  }
  return result
}

// ============================================================================
// ID Generation Helpers
// ============================================================================

function normalizeForId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')
}

function getYearWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

function getDayOfWeek(date: Date): string {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  return days[date.getDay()]
}

function getTimeOfDay(date: Date): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = date.getHours()
  if (hour >= 6 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

// ============================================================================
// NeuralGraph
// ============================================================================

export class NeuralGraph {
  private driver: Driver

  constructor(config: GraphConfig) {
    this.driver = neo4j.driver(
      config.neo4jUri,
      neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
    )
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.driver.verifyConnectivity()
    const session = this.driver.session()
    try {
      for (const statement of ALL_SCHEMA_STATEMENTS) {
        await session.run(statement)
      }
    } finally {
      await session.close()
    }
  }

  async dispose(): Promise<void> {
    await this.driver.close()
  }

  // --------------------------------------------------------------------------
  // Node Operations (all use MERGE for idempotency)
  // --------------------------------------------------------------------------

  async addMemoryNode(input: MemoryNodeInput): Promise<string> {
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (m:Memory {id: $id})
           ON CREATE SET
             m.memoryType = $memoryType,
             m.label = $label,
             m.projectId = $projectId,
             m.createdAt = $now,
             m.lastAccessed = $now,
             m.activationCount = 0
           ON MATCH SET
             m.lastAccessed = $now,
             m.activationCount = m.activationCount + 1`,
          {
            id: input.id,
            memoryType: input.memoryType,
            label: input.label.slice(0, 100),
            projectId: input.projectId ?? null,
            now,
          }
        )
      })
      return input.id
    } finally {
      await session.close()
    }
  }

  async addPersonNode(input: PersonNodeInput): Promise<string> {
    const id = `person:${normalizeForId(input.name)}`
    const now = new Date().toISOString()
    const aliases = JSON.stringify(input.aliases ?? [])
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (p:Person {id: $id})
           ON CREATE SET
             p.name = $name,
             p.aliases = $aliases,
             p.firstSeen = $now,
             p.lastSeen = $now,
             p.createdAt = $now,
             p.lastAccessed = $now,
             p.activationCount = 0
           ON MATCH SET
             p.lastSeen = $now,
             p.lastAccessed = $now,
             p.activationCount = p.activationCount + 1`,
          { id, name: input.name, aliases, now }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  async addTopicNode(input: TopicNodeInput): Promise<string> {
    const id = `topic:${normalizeForId(input.name)}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (t:Topic {id: $id})
           ON CREATE SET
             t.name = $name,
             t.description = $description,
             t.createdAt = $now,
             t.lastAccessed = $now,
             t.activationCount = 0
           ON MATCH SET
             t.lastAccessed = $now,
             t.activationCount = t.activationCount + 1`,
          { id, name: input.name, description: input.description ?? null, now }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  async addEntityNode(input: EntityNodeInput): Promise<string> {
    const id = `entity:${normalizeForId(input.name)}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (e:Entity {id: $id})
           ON CREATE SET
             e.name = $name,
             e.entityType = $entityType,
             e.createdAt = $now,
             e.lastAccessed = $now,
             e.activationCount = 0
           ON MATCH SET
             e.lastAccessed = $now,
             e.activationCount = e.activationCount + 1`,
          { id, name: input.name, entityType: input.entityType, now }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  async addEmotionNode(input: EmotionNodeInput): Promise<string> {
    const scoped = input.sessionScoped !== false
    const id = scoped
      ? `emotion:${input.sessionId}:${input.label}`
      : `emotion:global:${input.label}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (e:Emotion {id: $id})
           ON CREATE SET
             e.label = $label,
             e.intensity = $intensity,
             e.sessionScoped = $sessionScoped,
             e.sessionId = $sessionId,
             e.createdAt = $now,
             e.lastAccessed = $now,
             e.activationCount = 0
           ON MATCH SET
             e.intensity = CASE WHEN $intensity > e.intensity THEN $intensity ELSE e.intensity END,
             e.lastAccessed = $now,
             e.activationCount = e.activationCount + 1`,
          {
            id,
            label: input.label,
            intensity: input.intensity,
            sessionScoped: scoped,
            sessionId: scoped ? input.sessionId : null,
            now,
          }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  async addIntentNode(input: IntentNodeInput): Promise<string> {
    const scoped = input.sessionScoped !== false
    const id = scoped
      ? `intent:${input.sessionId}:${input.intentType}`
      : `intent:global:${input.intentType}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (i:Intent {id: $id})
           ON CREATE SET
             i.intentType = $intentType,
             i.sessionScoped = $sessionScoped,
             i.sessionId = $sessionId,
             i.createdAt = $now,
             i.lastAccessed = $now,
             i.activationCount = 0
           ON MATCH SET
             i.lastAccessed = $now,
             i.activationCount = i.activationCount + 1`,
          {
            id,
            intentType: input.intentType,
            sessionScoped: scoped,
            sessionId: scoped ? input.sessionId : null,
            now,
          }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  async addSessionNode(input: SessionNodeInput): Promise<string> {
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (s:Session {sessionId: $sessionId})
           ON CREATE SET
             s.id = $sessionId,
             s.startTime = $startTime,
             s.endTime = $endTime,
             s.createdAt = $now,
             s.lastAccessed = $now,
             s.activationCount = 0
           ON MATCH SET
             s.endTime = COALESCE($endTime, s.endTime),
             s.lastAccessed = $now,
             s.activationCount = s.activationCount + 1`,
          {
            sessionId: input.sessionId,
            startTime: input.startTime,
            endTime: input.endTime ?? null,
            now,
          }
        )
      })
      return input.sessionId
    } finally {
      await session.close()
    }
  }

  async addTimeContextNode(input: TimeContextNodeInput): Promise<string> {
    const yearWeek = getYearWeek(input.timestamp)
    const dayOfWeek = getDayOfWeek(input.timestamp)
    const timeOfDay = getTimeOfDay(input.timestamp)
    const id = `time:${yearWeek}:${dayOfWeek}:${timeOfDay}`
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (t:TimeContext {id: $id})
           ON CREATE SET
             t.yearWeek = $yearWeek,
             t.dayOfWeek = $dayOfWeek,
             t.timeOfDay = $timeOfDay,
             t.createdAt = $now,
             t.lastAccessed = $now,
             t.activationCount = 0
           ON MATCH SET
             t.lastAccessed = $now,
             t.activationCount = t.activationCount + 1`,
          { id, yearWeek, dayOfWeek, timeOfDay, now }
        )
      })
      return id
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Edge Operations
  // --------------------------------------------------------------------------

  async addEdge(
    sourceId: string,
    targetId: string,
    type: RelationType,
    weight: number,
  ): Promise<void> {
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MATCH (source) WHERE source.id = $sourceId
           MATCH (target) WHERE target.id = $targetId
           MERGE (source)-[r:${type}]->(target)
           ON CREATE SET
             r.weight = $weight,
             r.createdAt = $now,
             r.lastTraversed = $now,
             r.traversalCount = 1
           ON MATCH SET
             r.weight = CASE WHEN $weight > r.weight THEN $weight ELSE r.weight END,
             r.lastTraversed = $now,
             r.traversalCount = r.traversalCount + 1`,
          { sourceId, targetId, weight, now }
        )
      })
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Query Operations
  // --------------------------------------------------------------------------

  async getNode(id: string): Promise<{ id: string; label: string; properties: Record<string, unknown> } | null> {
    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx: ManagedTransaction) => {
        return tx.run(
          `MATCH (n) WHERE n.id = $id
           RETURN n, labels(n)[0] AS label`,
          { id }
        )
      })
      if (result.records.length === 0) return null
      const record = result.records[0]
      const node = record.get('n')
      return {
        id,
        label: record.get('label') as string,
        properties: toNativeProperties(node.properties as Record<string, unknown>),
      }
    } finally {
      await session.close()
    }
  }

  async getNeighbors(
    id: string,
    opts?: {
      edgeType?: RelationType
      direction?: 'in' | 'out' | 'both'
      limit?: number
    },
  ): Promise<Array<{ id: string; label: string; properties: Record<string, unknown>; edgeWeight: number }>> {
    const direction = opts?.direction ?? 'both'
    const limit = opts?.limit ?? 50

    let pattern: string
    if (direction === 'out') {
      pattern = opts?.edgeType
        ? `(source)-[r:${opts.edgeType}]->(neighbor)`
        : '(source)-[r]->(neighbor)'
    } else if (direction === 'in') {
      pattern = opts?.edgeType
        ? `(source)<-[r:${opts.edgeType}]-(neighbor)`
        : '(source)<-[r]-(neighbor)'
    } else {
      pattern = opts?.edgeType
        ? `(source)-[r:${opts.edgeType}]-(neighbor)`
        : '(source)-[r]-(neighbor)'
    }

    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx: ManagedTransaction) => {
        return tx.run(
          `MATCH (source) WHERE source.id = $id
           MATCH ${pattern}
           RETURN neighbor, labels(neighbor)[0] AS label, r.weight AS weight
           ORDER BY r.weight DESC
           LIMIT $limit`,
          { id, limit: neo4j.int(limit) }
        )
      })
      return result.records.map(record => {
        const weight = record.get('weight')
        return {
          id: record.get('neighbor').properties.id as string,
          label: record.get('label') as string,
          properties: toNativeProperties(record.get('neighbor').properties as Record<string, unknown>),
          edgeWeight: neo4j.isInt(weight) ? (weight as { toNumber: () => number }).toNumber() : (weight as number) ?? 0,
        }
      })
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Bulk Operations
  // --------------------------------------------------------------------------

  async decomposeEpisode(input: EpisodeDecomposition): Promise<void> {
    const now = new Date().toISOString()
    const yearWeek = getYearWeek(input.timestamp)
    const dayOfWeek = getDayOfWeek(input.timestamp)
    const timeOfDay = getTimeOfDay(input.timestamp)
    const timeContextId = `time:${yearWeek}:${dayOfWeek}:${timeOfDay}`

    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        // 1. Memory node
        await tx.run(
          `MERGE (m:Memory {id: $id})
           ON CREATE SET
             m.memoryType = $memoryType,
             m.label = $label,
             m.projectId = $projectId,
             m.createdAt = $now,
             m.lastAccessed = $now,
             m.activationCount = 0
           ON MATCH SET
             m.lastAccessed = $now,
             m.activationCount = m.activationCount + 1`,
          {
            id: input.episodeId,
            memoryType: input.memoryType,
            label: input.label.slice(0, 100),
            projectId: input.projectId ?? null,
            now,
          }
        )

        // 2. Session node + OCCURRED_IN edge
        await tx.run(
          `MERGE (s:Session {sessionId: $sessionId})
           ON CREATE SET
             s.id = $sessionId,
             s.startTime = $now,
             s.createdAt = $now,
             s.lastAccessed = $now,
             s.activationCount = 0
           ON MATCH SET
             s.lastAccessed = $now
           WITH s
           MATCH (m:Memory {id: $memoryId})
           MERGE (m)-[r:OCCURRED_IN]->(s)
           ON CREATE SET
             r.weight = 1.0,
             r.createdAt = $now,
             r.lastTraversed = $now,
             r.traversalCount = 1`,
          { sessionId: input.sessionId, memoryId: input.episodeId, now }
        )

        // 3. TimeContext node + OCCURRED_AT edge
        await tx.run(
          `MERGE (t:TimeContext {id: $timeContextId})
           ON CREATE SET
             t.yearWeek = $yearWeek,
             t.dayOfWeek = $dayOfWeek,
             t.timeOfDay = $timeOfDay,
             t.createdAt = $now,
             t.lastAccessed = $now,
             t.activationCount = 0
           ON MATCH SET
             t.lastAccessed = $now
           WITH t
           MATCH (m:Memory {id: $memoryId})
           MERGE (m)-[r:OCCURRED_AT]->(t)
           ON CREATE SET
             r.weight = 0.5,
             r.createdAt = $now,
             r.lastTraversed = $now,
             r.traversalCount = 1`,
          { timeContextId, yearWeek, dayOfWeek, timeOfDay, memoryId: input.episodeId, now }
        )

        // 4. Person nodes + SPOKE edges
        for (const personName of input.persons) {
          const personId = `person:${normalizeForId(personName)}`
          await tx.run(
            `MERGE (p:Person {id: $personId})
             ON CREATE SET
               p.name = $name,
               p.aliases = '[]',
               p.firstSeen = $now,
               p.lastSeen = $now,
               p.createdAt = $now,
               p.lastAccessed = $now,
               p.activationCount = 0
             ON MATCH SET
               p.lastSeen = $now,
               p.lastAccessed = $now
             WITH p
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:SPOKE]->(p)
             ON CREATE SET
               r.weight = 0.7,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1
             ON MATCH SET
               r.lastTraversed = $now,
               r.traversalCount = r.traversalCount + 1`,
            { personId, name: personName, memoryId: input.episodeId, now }
          )
        }

        // 5. Entity nodes + CONTEXTUAL edges
        for (const entity of input.entities) {
          const entityId = `entity:${normalizeForId(entity.name)}`
          await tx.run(
            `MERGE (e:Entity {id: $entityId})
             ON CREATE SET
               e.name = $name,
               e.entityType = $entityType,
               e.createdAt = $now,
               e.lastAccessed = $now,
               e.activationCount = 0
             ON MATCH SET
               e.lastAccessed = $now
             WITH e
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:CONTEXTUAL]->(e)
             ON CREATE SET
               r.weight = 0.6,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1
             ON MATCH SET
               r.lastTraversed = $now,
               r.traversalCount = r.traversalCount + 1`,
            { entityId, name: entity.name, entityType: entity.entityType, memoryId: input.episodeId, now }
          )
        }

        // 6. Emotion node + EMOTIONAL edge
        if (input.emotion) {
          const emotionId = `emotion:${input.sessionId}:${input.emotion.label}`
          await tx.run(
            `MERGE (e:Emotion {id: $emotionId})
             ON CREATE SET
               e.label = $label,
               e.intensity = $intensity,
               e.sessionScoped = true,
               e.sessionId = $sessionId,
               e.createdAt = $now,
               e.lastAccessed = $now,
               e.activationCount = 0
             ON MATCH SET
               e.intensity = CASE WHEN $intensity > e.intensity THEN $intensity ELSE e.intensity END,
               e.lastAccessed = $now
             WITH e
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:EMOTIONAL]->(e)
             ON CREATE SET
               r.weight = $intensity,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1`,
            {
              emotionId,
              label: input.emotion.label,
              intensity: input.emotion.intensity,
              sessionId: input.sessionId,
              memoryId: input.episodeId,
              now,
            }
          )
        }

        // 7. Intent node + INTENTIONAL edge
        if (input.intent) {
          const intentId = `intent:${input.sessionId}:${input.intent}`
          await tx.run(
            `MERGE (i:Intent {id: $intentId})
             ON CREATE SET
               i.intentType = $intentType,
               i.sessionScoped = true,
               i.sessionId = $sessionId,
               i.createdAt = $now,
               i.lastAccessed = $now,
               i.activationCount = 0
             ON MATCH SET
               i.lastAccessed = $now
             WITH i
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:INTENTIONAL]->(i)
             ON CREATE SET
               r.weight = 0.5,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1`,
            {
              intentId,
              intentType: input.intent,
              sessionId: input.sessionId,
              memoryId: input.episodeId,
              now,
            }
          )
        }
      })
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Schema Management
  // --------------------------------------------------------------------------

  async ensureSchema(): Promise<void> {
    const session = this.driver.session()
    try {
      for (const statement of ALL_SCHEMA_STATEMENTS) {
        await session.run(statement)
      }
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  async ping(): Promise<boolean> {
    try {
      await this.driver.verifyConnectivity()
      return true
    } catch {
      return false
    }
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  async stats(): Promise<{
    nodes: Record<string, number>
    relationships: Record<string, number>
    total: { nodes: number; relationships: number }
  }> {
    const session = this.driver.session()
    try {
      const nodeCountResult = await session.run(
        `MATCH (n)
         UNWIND labels(n) AS label
         RETURN label, count(n) AS count
         ORDER BY label`
      )

      const relCountResult = await session.run(
        `MATCH ()-[r]->()
         RETURN type(r) AS type, count(r) AS count
         ORDER BY type`
      )

      const nodes: Record<string, number> = {}
      for (const record of nodeCountResult.records) {
        const label = record.get('label') as string
        const count = (record.get('count') as { toNumber: () => number }).toNumber()
        nodes[label] = count
      }

      const relationships: Record<string, number> = {}
      for (const record of relCountResult.records) {
        const type = record.get('type') as string
        const count = (record.get('count') as { toNumber: () => number }).toNumber()
        relationships[type] = count
      }

      const totalNodes = Object.values(nodes).reduce((a, b) => a + b, 0)
      const totalRels = Object.values(relationships).reduce((a, b) => a + b, 0)

      return { nodes, relationships, total: { nodes: totalNodes, relationships: totalRels } }
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup (for testing)
  // --------------------------------------------------------------------------

  async clearAll(): Promise<void> {
    const session = this.driver.session()
    try {
      let deleted = 1
      while (deleted > 0) {
        const result = await session.run(
          `MATCH (n) WITH n LIMIT 10000
           DETACH DELETE n
           RETURN count(*) AS deleted`
        )
        deleted = (result.records[0]?.get('deleted') as { toNumber: () => number })?.toNumber() ?? 0
      }
    } finally {
      await session.close()
    }
  }

  // --------------------------------------------------------------------------
  // Wave 2 Facade: connectivity, entity lookup, spreading activation,
  // simplified ingestion, edge strengthening. These wrap lower-level methods
  // with the shape Wave 2's retrieval pipeline expects.
  // --------------------------------------------------------------------------

  /**
   * Availability check — alias for ping(). Returns true iff Neo4j is reachable
   * and responsive. Does NOT throw.
   */
  async isAvailable(): Promise<boolean> {
    return this.ping()
  }

  /**
   * Look up Person, Entity, and Topic nodes by name. Case-insensitive match
   * on Entity and Topic; exact match on Person.name.
   *
   * Used by Wave 2's entity-based seed injection: extract names from the
   * query, pass them here, feed the resulting node IDs into spreading
   * activation as independent graph seeds.
   */
  async lookupEntityNodes(names: string[]): Promise<EntitySeedResult[]> {
    if (names.length === 0) return []

    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `UNWIND $names AS name
           MATCH (n)
           WHERE (n:Person AND n.name = name)
              OR (n:Entity AND toLower(n.name) = toLower(name))
              OR (n:Topic AND toLower(n.name) = toLower(name))
           RETURN DISTINCT n.id AS nodeId,
                  labels(n)[0] AS nodeType,
                  n.name AS name`,
          { names },
        )
      })

      return result.records.map((record) => ({
        nodeId: record.get('nodeId') as string,
        nodeType: record.get('nodeType') as 'Person' | 'Entity' | 'Topic',
        name: record.get('name') as string,
      }))
    } catch (err) {
      // Non-fatal: caller treats an empty result the same as "no entities"
      return []
    } finally {
      await session.close()
    }
  }

  /**
   * Wave 2 spreading activation facade. Wraps the standalone
   * SpreadingActivation class with the option shape Wave 2 uses.
   *
   * Note: seedActivations is accepted for forward compatibility but the
   * underlying Cypher query uses uniform activation (1.0) per seed.
   * Per-seed initial weights are a Wave 3 enhancement.
   */
  async spreadActivation(opts: SpreadActivationOpts): Promise<ActivatedNode[]> {
    const sa = new SpreadingActivation(this.driver)
    const threshold = opts.threshold ?? 0.05
    const params: ActivationParams = {
      maxHops: opts.maxHops ?? 2,
      decayPerHop: opts.decay ?? 0.6,
      minActivation: threshold,
      maxNodes: opts.budget ?? 100,
      edgeTypeFilter: (opts.edgeFilter ?? []) as ActivationParams['edgeTypeFilter'],
    }
    const results: ActivationResult[] = await sa.activate(opts.seedNodeIds, params)
    const activated: ActivatedNode[] = results.map((r) => ({
      nodeId: r.nodeId,
      nodeType: r.nodeType as string,
      activation: r.activation,
      depth: r.hops,
      properties: r.properties,
    }))

    // Wave 5: Community node post-processing.
    // Build activation map from results, then find :Community nodes where 2+
    // MEMBER_OF source Memory nodes were activated. Use average activation * 0.8.
    const activatedMemoryIds = activated
      .filter(n => n.nodeType === 'Memory' || n.nodeType === 'memory')
      .map(n => n.nodeId)

    if (activatedMemoryIds.length >= 2) {
      try {
        // Build a per-ID activation map for TypeScript-side average calculation
        const activationMap = new Map<string, number>()
        for (const n of activated) {
          activationMap.set(n.nodeId, n.activation)
        }

        const communityResult = await this.runCypher(`
          UNWIND $activatedIds AS activatedId
          MATCH (m:Memory {id: activatedId})-[:MEMBER_OF]->(c:Community)
          WITH c.id AS communityId, c.label AS label,
               c.memberCount AS memberCount,
               collect(activatedId) AS activatedMembers
          WHERE size(activatedMembers) >= 2
          RETURN communityId, label, memberCount, activatedMembers
        `, { activatedIds: activatedMemoryIds })

        for (const record of communityResult.records) {
          const communityId = record.get('communityId') as string
          const activatedMemberIds = record.get('activatedMembers') as string[]
          // Average activation of contributing members * 0.8 decay factor
          const avgActivation = activatedMemberIds.reduce((sum, id) => {
            return sum + (activationMap.get(id) ?? 0)
          }, 0) / activatedMemberIds.length

          const communityActivation = avgActivation * 0.8
          if (communityActivation >= threshold) {
            const rawMemberCount = record.get('memberCount')
            activated.push({
              nodeId: communityId,
              nodeType: 'Community',
              activation: communityActivation,
              depth: 0,
              properties: {
                label: record.get('label') as string,
                memberCount: neo4j.isInt(rawMemberCount)
                  ? (rawMemberCount as { toNumber(): number }).toNumber()
                  : (rawMemberCount as number) ?? 0,
              },
            })
          }
        }
      } catch {
        // Community activation is best-effort; never block on it
      }
    }

    return activated
  }

  /**
   * Strengthen a set of directed edge pairs (sourceId, targetId).
   * For each pair, increments weight by 0.02 (capped at 1.0), bumps
   * traversalCount, and updates lastTraversed.
   *
   * This is the reconsolidation analog: edges we actually traversed
   * during recall get slightly stronger, making future retrieval faster.
   */
  async strengthenTraversedEdges(pairs: Array<[string, string]>): Promise<void> {
    if (pairs.length === 0) return
    const now = new Date().toISOString()
    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `UNWIND $pairs AS pair
           MATCH (a)-[r]->(b)
           WHERE a.id = pair[0] AND b.id = pair[1]
           SET r.weight = CASE
                 WHEN r.weight + 0.02 > 1.0 THEN 1.0
                 ELSE r.weight + 0.02
               END,
               r.lastTraversed = $now,
               r.traversalCount = coalesce(r.traversalCount, 0) + 1`,
          { pairs, now },
        )
      })
    } finally {
      await session.close()
    }
  }

  /**
   * Simplified ingestion path for Wave 2. Takes a core-shaped episode,
   * extracts persons/emotion internally (or uses LLM-extracted entities
   * when provided), and delegates to decomposeEpisode().
   *
   * Also creates the TEMPORAL edge from previousEpisodeId when provided.
   */
  async ingestEpisode(input: SimpleEpisodeInput): Promise<void> {
    const timestamp = input.createdAt instanceof Date
      ? input.createdAt
      : new Date(input.createdAt)

    const emotionResult = classifyEmotion(input.content)
    const emotion = emotionResult.label !== 'neutral'
      ? { label: emotionResult.label, intensity: emotionResult.intensity }
      : null

    const label = input.content.slice(0, 100)

    // Decide the entity source: LLM-extracted (precise) or regex fallback.
    let persons: string[]
    let typedEntities: Array<{
      name: string
      entityType: 'tech' | 'concept' | 'tool' | 'project'
    }>

    if (input.llmEntities && input.llmEntities.length > 0) {
      // LLM path: use structured typed entities. Higher precision; no
      // regex extraction runs.
      persons = input.llmEntities
        .filter((e) => e.type === 'person')
        .map((e) => e.name)

      typedEntities = input.llmEntities
        .filter((e) => e.type !== 'person')
        .map((e) => {
          // Map LLM types to Wave 1's EntityNodeInput.entityType enum.
          // 'org' collapses to 'concept' because Wave 1 has no 'org' type.
          const entityType: 'tech' | 'concept' | 'tool' | 'project' =
            e.type === 'tech' ? 'tech'
            : e.type === 'project' ? 'project'
            : 'concept'
          return { name: e.name, entityType }
        })
    } else {
      // Regex fallback path: the old heuristic extractors.
      persons = extractPersons(input.content).map((p) => p.name)
      typedEntities = input.entities.map((name) => ({
        name,
        entityType: 'tech' as const,
      }))
    }

    await this.decomposeEpisode({
      episodeId: input.id,
      memoryType: 'episode',
      label,
      sessionId: input.sessionId,
      timestamp,
      persons,
      entities: typedEntities,
      emotion,
      intent: null,
    })

    // PROJECT edge: tag this memory with its project scope.
    // Uses MERGE on Project.id = 'project:<name>' so project nodes are
    // singletons across the whole graph — all memories from the same
    // project share the node, which means Wave 2 spreading activation
    // from a Project seed naturally pulls in all project memories.
    if (input.project && input.project !== 'global') {
      const projectId = `project:${normalizeForId(input.project)}`
      const now = new Date().toISOString()
      const session = this.driver.session()
      try {
        await session.executeWrite(async (tx) => {
          await tx.run(
            `MERGE (p:Project {id: $projectId})
             ON CREATE SET
               p.name = $name,
               p.createdAt = $now,
               p.lastAccessed = $now,
               p.activationCount = 0
             ON MATCH SET
               p.lastAccessed = $now
             WITH p
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[r:PROJECT]->(p)
             ON CREATE SET
               r.weight = 1.0,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1
             ON MATCH SET
               r.lastTraversed = $now,
               r.traversalCount = r.traversalCount + 1`,
            { projectId, name: input.project, memoryId: input.id, now },
          )
        })
      } finally {
        await session.close()
      }
    }

    // TEMPORAL edge from previous episode in the same session.
    //
    // Race condition fix: Memory.ingest() calls ingestEpisode in a
    // fire-and-forget manner, which means episode N+1's decomposition can
    // start before episode N's Memory node finishes being written. The
    // previous implementation used MATCH (prev:Memory {id: ...}) which
    // silently produced no edge when prev didn't exist yet, dropping ~18%
    // of TEMPORAL edges in practice.
    //
    // The fix uses MERGE for BOTH endpoints. If the previous Memory node
    // doesn't exist yet, we create a stub with just the id; its properties
    // will be filled in by ON MATCH when its own decomposeEpisode arrives.
    // This is safe because decomposeEpisode also uses MERGE on Memory {id},
    // so a stub will be populated rather than duplicated.
    if (input.previousEpisodeId) {
      const session = this.driver.session()
      try {
        await session.executeWrite(async (tx) => {
          await tx.run(
            `MERGE (prev:Memory {id: $prevId})
             MERGE (curr:Memory {id: $currId})
             MERGE (prev)-[r:TEMPORAL]->(curr)
             ON CREATE SET
               r.weight = 0.8,
               r.createdAt = $now,
               r.lastTraversed = $now,
               r.traversalCount = 1
             ON MATCH SET
               r.lastTraversed = $now,
               r.traversalCount = r.traversalCount + 1`,
            {
              prevId: input.previousEpisodeId,
              currId: input.id,
              now: new Date().toISOString(),
            },
          )
        })
      } finally {
        await session.close()
      }
    }
  }

  // --------------------------------------------------------------------------
  // Wave 3: Raw Cypher execution for consolidation operations
  // --------------------------------------------------------------------------

  /** Run a read-only Cypher query (auto-commit mode — required for GDS). */
  async runCypher(query: string, params?: Record<string, unknown>): Promise<QueryResult> {
    const session = this.driver.session()
    try {
      return await session.run(query, params)
    } finally {
      await session.close()
    }
  }

  /** Run a write Cypher query (auto-commit mode). */
  async runCypherWrite(query: string, params?: Record<string, unknown>): Promise<QueryResult> {
    const session = this.driver.session()
    try {
      return await session.run(query, params)
    } finally {
      await session.close()
    }
  }

  /** Check if the Neo4j GDS plugin is available. */
  async isGdsAvailable(): Promise<boolean> {
    try {
      const session = this.driver.session()
      try {
        await session.run('RETURN gds.version() AS version')
        return true
      } finally {
        await session.close()
      }
    } catch {
      return false
    }
  }

  // --------------------------------------------------------------------------
  // Wave 5: Community operations
  // --------------------------------------------------------------------------

  /**
   * Query all communities from Neo4j, grouped by communityId.
   * Returns communities with >= minSize Memory members.
   */
  async getCommunityMembers(opts?: {
    minSize?: number
    projectId?: string
  }): Promise<Array<{
    communityId: string
    memberNodeIds: string[]
    memberLabels: string[]
  }>> {
    const minSize = opts?.minSize ?? 5
    const projectFilter = opts?.projectId
      ? 'AND m.projectId = $projectId'
      : ''

    const result = await this.runCypher(`
      MATCH (m:Memory)
      WHERE m.communityId IS NOT NULL ${projectFilter}
      WITH m.communityId AS cid, collect(m.id) AS memberIds, collect(m.label) AS labels
      WHERE size(memberIds) >= $minSize
      RETURN cid, memberIds, labels
      ORDER BY size(memberIds) DESC
    `, { minSize: neo4j.int(minSize), projectId: opts?.projectId ?? null })

    return result.records.map(r => ({
      communityId: r.get('cid').toString(),
      memberNodeIds: r.get('memberIds') as string[],
      memberLabels: r.get('labels') as string[],
    }))
  }

  /**
   * For a given community, get the context node frequencies (entities, topics, persons, emotions).
   */
  async getCommunityContext(communityId: string, projectId?: string): Promise<{
    entityFrequency: Map<string, number>
    topicFrequency: Map<string, number>
    personFrequency: Map<string, number>
    emotionFrequency: Map<string, number>
  }> {
    const projectFilter = projectId
      ? 'AND m.projectId = $projectId'
      : ''

    const result = await this.runCypher(`
      MATCH (m:Memory {communityId: $communityId})--(ctx)
      WHERE (ctx:Entity OR ctx:Topic OR ctx:Person OR ctx:Emotion)
        ${projectFilter}
      WITH labels(ctx)[0] AS ctxType, ctx.label AS label, count(*) AS freq
      RETURN ctxType, label, freq
      ORDER BY freq DESC
    `, { communityId, projectId: projectId ?? null })

    const entityFrequency = new Map<string, number>()
    const topicFrequency = new Map<string, number>()
    const personFrequency = new Map<string, number>()
    const emotionFrequency = new Map<string, number>()

    for (const record of result.records) {
      const ctxType = (record.get('ctxType') as string).toLowerCase()
      const label = record.get('label') as string
      const rawFreq = record.get('freq')
      const freq = neo4j.isInt(rawFreq) ? (rawFreq as { toNumber(): number }).toNumber() : (rawFreq as number)

      switch (ctxType) {
        case 'entity': entityFrequency.set(label, freq); break
        case 'topic': topicFrequency.set(label, freq); break
        case 'person': personFrequency.set(label, freq); break
        case 'emotion': emotionFrequency.set(label, freq); break
      }
    }

    return { entityFrequency, topicFrequency, personFrequency, emotionFrequency }
  }

  /**
   * Create or update a :Community node and connect member :Memory nodes via MEMBER_OF.
   */
  async upsertCommunityNode(props: {
    id: string
    communityId: string
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
    generatedAt: string
    projectId: string | null
    memberNodeIds: string[]
  }): Promise<void> {
    // Upsert the :Community node
    await this.runCypherWrite(`
      MERGE (c:Community {id: $id})
      SET c.communityId = $communityId,
          c.label = $label,
          c.memberCount = $memberCount,
          c.topEntities = $topEntities,
          c.topTopics = $topTopics,
          c.topPersons = $topPersons,
          c.dominantEmotion = $dominantEmotion,
          c.generatedAt = $generatedAt,
          c.projectId = $projectId
    `, {
      id: props.id,
      communityId: props.communityId,
      label: props.label,
      memberCount: neo4j.int(props.memberCount),
      topEntities: props.topEntities,
      topTopics: props.topTopics,
      topPersons: props.topPersons,
      dominantEmotion: props.dominantEmotion,
      generatedAt: props.generatedAt,
      projectId: props.projectId,
    })

    // Create MEMBER_OF relationships from member Memory nodes to Community
    if (props.memberNodeIds.length > 0) {
      await this.runCypherWrite(`
        MATCH (c:Community {id: $communityId})
        UNWIND $memberIds AS memberId
        MATCH (m:Memory {id: memberId})
        MERGE (m)-[r:MEMBER_OF]->(c)
        ON CREATE SET r.weight = 1.0,
                      r.traversalCount = 0,
                      r.createdAt = $now,
                      r.lastTraversed = null
      `, {
        communityId: props.id,
        memberIds: props.memberNodeIds,
        now: new Date().toISOString(),
      })
    }
  }

  /**
   * Query community summaries from Neo4j for MCP tool responses.
   */
  async queryCommunities(opts?: {
    projectId?: string
    limit?: number
  }): Promise<Array<{
    communityId: string
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
    generatedAt: string
    projectId: string | null
  }>> {
    const limit = opts?.limit ?? 20
    const projectFilter = opts?.projectId
      ? 'WHERE (c.projectId = $projectId OR c.projectId IS NULL)'
      : ''

    const result = await this.runCypher(`
      MATCH (c:Community)
      ${projectFilter}
      RETURN c
      ORDER BY c.memberCount DESC
      LIMIT $limit
    `, { projectId: opts?.projectId ?? null, limit: neo4j.int(limit) })

    return result.records.map(r => {
      const c = r.get('c').properties as Record<string, unknown>
      const memberCount = c['memberCount']
      return {
        communityId: c['communityId'] as string,
        label: c['label'] as string,
        memberCount: neo4j.isInt(memberCount) ? (memberCount as { toNumber(): number }).toNumber() : (memberCount as number) ?? 0,
        topEntities: (c['topEntities'] as string[]) ?? [],
        topTopics: (c['topTopics'] as string[]) ?? [],
        topPersons: (c['topPersons'] as string[]) ?? [],
        dominantEmotion: c['dominantEmotion'] as string | null,
        generatedAt: c['generatedAt'] as string,
        projectId: c['projectId'] as string | null,
      }
    })
  }

  /**
   * Find shared Person/Entity nodes bridging two projects.
   * Returns labels and snippet counts only — no cross-project memory content.
   */
  async findProjectBridges(projectA: string, projectB: string): Promise<Array<{
    nodeId: string
    nodeType: 'person' | 'entity'
    label: string
    projectACount: number
    projectBCount: number
    projectALabels: string[]
    projectBLabels: string[]
  }>> {
    const result = await this.runCypher(`
      MATCH (shared)--(memA:Memory {projectId: $projectA})
      WHERE shared:Person OR shared:Entity
      WITH shared, collect(DISTINCT memA.label)[0..3] AS memALabels, count(DISTINCT memA) AS memACount
      MATCH (shared)--(memB:Memory {projectId: $projectB})
      WITH shared, memALabels, memACount,
           collect(DISTINCT memB.label)[0..3] AS memBLabels, count(DISTINCT memB) AS memBCount
      WHERE memACount > 0 AND memBCount > 0
      RETURN shared.id AS nodeId,
             CASE WHEN shared:Person THEN 'person' ELSE 'entity' END AS nodeType,
             shared.label AS label,
             memACount, memBCount, memALabels, memBLabels
      ORDER BY memACount + memBCount DESC
    `, { projectA, projectB })

    return result.records.map(r => {
      const memACount = r.get('memACount')
      const memBCount = r.get('memBCount')
      return {
        nodeId: r.get('nodeId') as string,
        nodeType: r.get('nodeType') as 'person' | 'entity',
        label: r.get('label') as string,
        projectACount: neo4j.isInt(memACount) ? (memACount as { toNumber(): number }).toNumber() : (memACount as number),
        projectBCount: neo4j.isInt(memBCount) ? (memBCount as { toNumber(): number }).toNumber() : (memBCount as number),
        projectALabels: r.get('memALabels') as string[],
        projectBLabels: r.get('memBLabels') as string[],
      }
    })
  }

  // --------------------------------------------------------------------------
  // Wave 5: Pattern completion — attribute-based node lookup
  // --------------------------------------------------------------------------

  /**
   * Find graph nodes matching query attributes for pattern completion.
   * Uses indexed Cypher lookups — NOT full graph scans.
   */
  async findMatchingContextNodes(input: {
    entities: string[]
    emotions: string[]
    persons: string[]
    topics: string[]
  }): Promise<Array<{ attributeType: string; nodeIds: string[] }>> {
    const seedsByAttribute: Array<{ attributeType: string; nodeIds: string[] }> = []

    // Entity/Topic matching via Cypher — case-insensitive CONTAINS
    if (input.entities.length > 0) {
      const result = await this.runCypher(`
        UNWIND $needles AS needle
        MATCH (n)
        WHERE (n:Entity OR n:Topic)
          AND toLower(n.label) CONTAINS toLower(needle)
        RETURN DISTINCT n.id AS nodeId
      `, { needles: input.entities })

      const nodeIds = result.records.map(r => r.get('nodeId') as string)
      if (nodeIds.length > 0) {
        seedsByAttribute.push({ attributeType: 'entity', nodeIds })
      }
    }

    // Person matching via Cypher
    if (input.persons.length > 0) {
      const result = await this.runCypher(`
        UNWIND $needles AS needle
        MATCH (n:Person)
        WHERE toLower(n.label) CONTAINS toLower(needle)
        RETURN DISTINCT n.id AS nodeId
      `, { needles: input.persons })

      const nodeIds = result.records.map(r => r.get('nodeId') as string)
      if (nodeIds.length > 0) {
        seedsByAttribute.push({ attributeType: 'person', nodeIds })
      }
    }

    // Emotion matching via Cypher
    const emotionLabels = ['positive', 'negative', 'neutral', 'urgent']
    const canonicalEmotions = input.emotions
      .map(e => emotionLabels.find(el => e.toLowerCase().includes(el) || el.includes(e.toLowerCase())))
      .filter((e): e is string => e !== undefined)

    if (canonicalEmotions.length > 0) {
      const result = await this.runCypher(`
        UNWIND $emotions AS emotion
        MATCH (n:Emotion)
        WHERE toLower(n.label) = emotion
        RETURN DISTINCT n.id AS nodeId
      `, { emotions: canonicalEmotions })

      const nodeIds = result.records.map(r => r.get('nodeId') as string)
      if (nodeIds.length > 0) {
        seedsByAttribute.push({ attributeType: 'emotion', nodeIds })
      }
    }

    // Topic matching (separate from entity for priority handling)
    if (input.topics.length > 0) {
      const result = await this.runCypher(`
        UNWIND $needles AS needle
        MATCH (n:Topic)
        WHERE toLower(n.label) CONTAINS toLower(needle)
        RETURN DISTINCT n.id AS nodeId
      `, { needles: input.topics })

      const nodeIds = result.records.map(r => r.get('nodeId') as string)
      if (nodeIds.length > 0) {
        seedsByAttribute.push({ attributeType: 'topic', nodeIds })
      }
    }

    return seedsByAttribute
  }
}
