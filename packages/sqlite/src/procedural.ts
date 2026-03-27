import type Database from 'better-sqlite3'
import type { ProceduralMemory, SearchOptions, SearchResult } from '@engram/core'
import { generateId } from '@engram/core'
import type { ProceduralStorage } from '@engram/core'
import { sanitizeFtsQuery, julianToDate } from './search.js'

export class SqliteProceduralStorage implements ProceduralStorage {
  constructor(private db: Database.Database) {}

  async insert(
    memory: Omit<ProceduralMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<ProceduralMemory> {
    const id = generateId()
    this.db.prepare('INSERT INTO memories (id, type) VALUES (?, ?)').run(id, 'procedural')

    const embeddingBlob = memory.embedding
      ? Buffer.from(new Float32Array(memory.embedding).buffer)
      : null

    this.db
      .prepare(
        `INSERT INTO procedural (
           id, category, trigger_text, procedure, confidence,
           observation_count, last_observed, first_observed,
           decay_rate, source_episode_ids, embedding, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        memory.category,
        memory.trigger,
        memory.procedure,
        memory.confidence,
        memory.observationCount,
        julianFromDate(memory.lastObserved),
        julianFromDate(memory.firstObserved),
        memory.decayRate,
        JSON.stringify(memory.sourceEpisodeIds),
        embeddingBlob,
        JSON.stringify(memory.metadata)
      )

    return this.rowToProcedural(
      this.db.prepare('SELECT * FROM procedural WHERE id = ?').get(id) as ProceduralRow
    )
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]> {
    const ftsQuery = sanitizeFtsQuery(query)
    const limit = opts?.limit ?? 10

    const rows = this.db
      .prepare(
        `SELECT p.*, -procedural_fts.rank AS bm25_score
         FROM procedural_fts
         JOIN procedural p ON procedural_fts.rowid = p.rowid
         WHERE procedural_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, limit) as (ProceduralRow & { bm25_score: number })[]

    const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.bm25_score)) : 1
    return rows
      .filter((r) => r.bm25_score > 0)
      .map((r) => ({
        item: this.rowToProcedural(r),
        similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
      }))
  }

  async searchByTrigger(
    activity: string,
    opts?: SearchOptions
  ): Promise<SearchResult<ProceduralMemory>[]> {
    const ftsQuery = sanitizeFtsQuery(activity)
    const limit = opts?.limit ?? 10

    // Use FTS5 column filter syntax: trigger_text:<query>
    const columnQuery = `trigger_text:${ftsQuery}`

    const rows = this.db
      .prepare(
        `SELECT p.*, -procedural_fts.rank AS bm25_score
         FROM procedural_fts
         JOIN procedural p ON procedural_fts.rowid = p.rowid
         WHERE procedural_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(columnQuery, limit) as (ProceduralRow & { bm25_score: number })[]

    const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.bm25_score)) : 1
    return rows
      .filter((r) => r.bm25_score > 0)
      .map((r) => ({
        item: this.rowToProcedural(r),
        similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
      }))
  }

  async recordAccess(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE procedural
         SET access_count = access_count + 1,
             last_accessed = julianday('now')
         WHERE id = ?`
      )
      .run(id)
  }

  async incrementObservation(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE procedural
         SET observation_count = observation_count + 1,
             last_observed = julianday('now')
         WHERE id = ?`
      )
      .run(id)
  }

  async batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE procedural
         SET confidence = MAX(0.05, confidence - ?)
         WHERE confidence > 0.05
           AND (last_accessed IS NULL OR last_accessed < julianday('now') - ?)`
      )
      .run(opts.decayRate, opts.daysThreshold)
    return result.changes
  }

  private rowToProcedural(row: ProceduralRow): ProceduralMemory {
    return {
      id: row.id,
      category: row.category,
      trigger: row.trigger_text,
      procedure: row.procedure,
      confidence: row.confidence,
      observationCount: row.observation_count,
      lastObserved: julianToDate(row.last_observed) ?? new Date(),
      firstObserved: julianToDate(row.first_observed) ?? new Date(),
      accessCount: row.access_count,
      lastAccessed: julianToDate(row.last_accessed),
      decayRate: row.decay_rate,
      sourceEpisodeIds: JSON.parse(row.source_episode_ids),
      embedding: row.embedding
        ? Array.from(
            new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4)
          )
        : null,
      metadata: JSON.parse(row.metadata),
      createdAt: julianToDate(row.created_at)!,
      updatedAt: julianToDate(row.updated_at)!,
    }
  }
}

/** Convert JS Date to Julian Day number. */
function julianFromDate(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}

interface ProceduralRow {
  id: string
  category: 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention'
  trigger_text: string
  procedure: string
  confidence: number
  observation_count: number
  last_observed: number
  first_observed: number
  access_count: number
  last_accessed: number | null
  decay_rate: number
  source_episode_ids: string
  embedding: Buffer | null
  metadata: string
  created_at: number
  updated_at: number
}
