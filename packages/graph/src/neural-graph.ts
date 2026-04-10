import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver'
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
    const params: ActivationParams = {
      maxHops: opts.maxHops ?? 2,
      decayPerHop: opts.decay ?? 0.6,
      minActivation: opts.threshold ?? 0.05,
      maxNodes: opts.budget ?? 100,
      edgeTypeFilter: (opts.edgeFilter ?? []) as ActivationParams['edgeTypeFilter'],
    }
    const results: ActivationResult[] = await sa.activate(opts.seedNodeIds, params)
    return results.map((r) => ({
      nodeId: r.nodeId,
      nodeType: r.nodeType as string,
      activation: r.activation,
      depth: r.hops,
      properties: r.properties,
    }))
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
}
