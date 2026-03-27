import type Database from 'better-sqlite3'
import type {
  Association,
  MemoryType,
  WalkResult,
  DiscoveredEdge,
} from '@engram/core'
import { generateId } from '@engram/core'
import type { AssociationStorage } from '@engram/core'
import { julianToDate } from './search.js'

export class SqliteAssociationStorage implements AssociationStorage {
  constructor(private db: Database.Database) {}

  async insert(
    association: Omit<Association, 'id' | 'createdAt'>
  ): Promise<Association> {
    const id = generateId()

    this.db
      .prepare(
        `INSERT INTO associations
           (id, source_id, source_type, target_id, target_type,
            edge_type, strength, last_activated, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        association.sourceId,
        association.sourceType,
        association.targetId,
        association.targetType,
        association.edgeType,
        association.strength,
        association.lastActivated
          ? association.lastActivated.getTime() / 86400000 + 2440587.5
          : null,
        JSON.stringify(association.metadata)
      )

    return this.rowToAssociation(
      this.db
        .prepare('SELECT * FROM associations WHERE id = ?')
        .get(id) as AssociationRow
    )
  }

  async walk(
    seedIds: string[],
    opts?: { maxHops?: number; minStrength?: number; limit?: number }
  ): Promise<WalkResult[]> {
    if (seedIds.length === 0) return []

    const maxHops = opts?.maxHops ?? 2
    const minStrength = opts?.minStrength ?? 0.2
    const limit = opts?.limit ?? 20

    const seedJson = JSON.stringify(seedIds)

    // Recursive CTE graph walk — bidirectional, cycle-safe, bounded by maxHops.
    // The path column is a JSON array of visited memory IDs used for cycle detection.
    // The NOT EXISTS sub-select checks whether the candidate next node is already in
    // the current path, preventing infinite cycles.
    const sql = `
      WITH RECURSIVE
      walk(memory_id, memory_type, depth, path, min_strength) AS (
        -- Anchor: seed nodes at depth 0
        SELECT
          value               AS memory_id,
          NULL                AS memory_type,
          0                   AS depth,
          json_array(value)   AS path,
          1.0                 AS min_strength
        FROM json_each(?)

        UNION ALL

        -- Recursive step: traverse each edge in both directions
        SELECT
          CASE WHEN a.source_id = w.memory_id
               THEN a.target_id
               ELSE a.source_id END AS memory_id,
          CASE WHEN a.source_id = w.memory_id
               THEN a.target_type
               ELSE a.source_type END AS memory_type,
          w.depth + 1,
          json_insert(w.path, '$[#]',
            CASE WHEN a.source_id = w.memory_id
                 THEN a.target_id
                 ELSE a.source_id END),
          w.min_strength * a.strength AS min_strength
        FROM walk w
        JOIN associations a ON (
          a.source_id = w.memory_id OR a.target_id = w.memory_id
        )
        WHERE
          w.depth < ?
          AND a.strength >= ?
          AND NOT EXISTS (
            SELECT 1 FROM json_each(w.path)
            WHERE value = CASE WHEN a.source_id = w.memory_id
                               THEN a.target_id
                               ELSE a.source_id END
          )
      )
      SELECT DISTINCT
        memory_id,
        memory_type,
        depth,
        min_strength AS path_strength
      FROM walk
      WHERE depth > 0
      ORDER BY min_strength DESC, depth ASC
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(seedJson, maxHops, minStrength, limit) as WalkRow[]

    return rows.map((r) => ({
      memoryId: r.memory_id,
      memoryType: r.memory_type as MemoryType,
      depth: r.depth,
      pathStrength: r.path_strength,
    }))
  }

  async upsertCoRecalled(
    sourceId: string,
    sourceType: MemoryType,
    targetId: string,
    targetType: MemoryType
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO associations
           (id, source_id, source_type, target_id, target_type,
            edge_type, strength, last_activated, metadata)
         VALUES (?, ?, ?, ?, ?, 'co_recalled', 0.2, julianday('now'), '{}')
         ON CONFLICT (source_id, target_id, edge_type) DO UPDATE SET
           strength       = MIN(1.0, strength + 0.1),
           last_activated = julianday('now')`
      )
      .run(generateId(), sourceId, sourceType, targetId, targetType)
  }

  async pruneWeak(opts: { maxStrength: number; olderThanDays: number }): Promise<number> {
    const result = this.db
      .prepare(
        `DELETE FROM associations
         WHERE strength < ?
           AND (last_activated IS NULL OR last_activated < julianday('now') - ?)
           AND edge_type != 'derives_from'`
      )
      .run(opts.maxStrength, opts.olderThanDays)
    return result.changes
  }

  async discoverTopicalEdges(opts: {
    daysLookback: number
    maxNew: number
  }): Promise<DiscoveredEdge[]> {
    // Use a temp table scoped to this connection to map entities to memories.
    // The temp table avoids polluting the main schema and is efficient for
    // the pairwise JOIN that follows.
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS dream_entity_map (
        entity      TEXT NOT NULL,
        memory_id   TEXT NOT NULL,
        memory_type TEXT NOT NULL
      )
    `)

    this.db.exec('DELETE FROM dream_entity_map')

    this.db
      .prepare(
        `INSERT INTO dream_entity_map (entity, memory_id, memory_type)
         SELECT LOWER(je.value), e.id, 'episode'
         FROM episodes e, json_each(e.entities_json) je
         WHERE e.created_at > julianday('now') - ?
           AND je.value != ''`
      )
      .run(opts.daysLookback)

    const rows = this.db
      .prepare(
        `SELECT
           em1.memory_id   AS source_id,
           em1.memory_type AS source_type,
           em2.memory_id   AS target_id,
           em2.memory_type AS target_type,
           em1.entity      AS shared_entity,
           COUNT(*)        AS entity_count
         FROM dream_entity_map em1
         JOIN dream_entity_map em2
           ON em1.entity = em2.entity
          AND em1.memory_id < em2.memory_id
         WHERE NOT EXISTS (
           SELECT 1 FROM associations a
           WHERE (a.source_id = em1.memory_id AND a.target_id = em2.memory_id)
              OR (a.source_id = em2.memory_id AND a.target_id = em1.memory_id)
         )
         GROUP BY em1.memory_id, em1.memory_type, em2.memory_id, em2.memory_type
         ORDER BY entity_count DESC
         LIMIT ?`
      )
      .all(opts.maxNew) as DiscoveredEdgeRow[]

    return rows.map((r) => ({
      sourceId: r.source_id,
      sourceType: r.source_type as MemoryType,
      targetId: r.target_id,
      targetType: r.target_type as MemoryType,
      sharedEntity: r.shared_entity,
      entityCount: r.entity_count,
    }))
  }

  private rowToAssociation(row: AssociationRow): Association {
    return {
      id: row.id,
      sourceId: row.source_id,
      sourceType: row.source_type as MemoryType,
      targetId: row.target_id,
      targetType: row.target_type as MemoryType,
      edgeType: row.edge_type as Association['edgeType'],
      strength: row.strength,
      lastActivated: julianToDate(row.last_activated),
      metadata: JSON.parse(row.metadata),
      createdAt: julianToDate(row.created_at)!,
    }
  }
}

interface AssociationRow {
  id: string
  source_id: string
  source_type: string
  target_id: string
  target_type: string
  edge_type: string
  strength: number
  last_activated: number | null
  metadata: string
  created_at: number
}

interface WalkRow {
  memory_id: string
  memory_type: string
  depth: number
  path_strength: number
}

interface DiscoveredEdgeRow {
  source_id: string
  source_type: string
  target_id: string
  target_type: string
  shared_entity: string
  entity_count: number
}
