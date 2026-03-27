import type Database from 'better-sqlite3'
import type { Episode, SearchOptions, SearchResult } from '@engram/core'
import { generateId } from '@engram/core'
import type { EpisodeStorage } from '@engram/core'
import { sanitizeFtsQuery, julianToDate } from './search.js'

export class SqliteEpisodeStorage implements EpisodeStorage {
  constructor(private db: Database.Database) {}

  async insert(
    episode: Omit<Episode, 'id' | 'createdAt'>
  ): Promise<Episode> {
    const id = generateId()

    // Insert into memories table first (FK requirement)
    this.db
      .prepare('INSERT INTO memories (id, type) VALUES (?, ?)')
      .run(id, 'episode')

    const entitiesJson = JSON.stringify(episode.entities)
    const metadataJson = JSON.stringify(episode.metadata)
    const embeddingBlob = episode.embedding
      ? Buffer.from(new Float32Array(episode.embedding).buffer)
      : null

    this.db
      .prepare(
        `INSERT INTO episodes (id, session_id, role, content, salience, access_count,
         last_accessed, consolidated_at, embedding, entities_json, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        episode.sessionId,
        episode.role,
        episode.content,
        episode.salience,
        episode.accessCount,
        episode.lastAccessed ? episode.lastAccessed.getTime() / 86400000 + 2440587.5 : null,
        episode.consolidatedAt ? episode.consolidatedAt.getTime() / 86400000 + 2440587.5 : null,
        embeddingBlob,
        entitiesJson,
        metadataJson
      )

    return this.rowToEpisode(
      this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow
    )
  }

  async search(
    query: string,
    opts?: SearchOptions
  ): Promise<SearchResult<Episode>[]> {
    const ftsQuery = sanitizeFtsQuery(query)
    const limit = opts?.limit ?? 10

    let sql = `
      SELECT e.*, -episodes_fts.rank AS bm25_score
      FROM episodes_fts
      JOIN episodes e ON episodes_fts.rowid = e.rowid
      WHERE episodes_fts MATCH ?
    `
    const params: unknown[] = [ftsQuery]

    if (opts?.sessionId) {
      sql += ' AND e.session_id = ?'
      params.push(opts.sessionId)
    }

    sql += ' ORDER BY rank LIMIT ?'
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as (EpisodeRow & { bm25_score: number })[]

    // Normalize BM25 scores to 0-1 range
    const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.bm25_score)) : 1
    return rows
      .filter((r) => r.bm25_score > 0)
      .map((r) => ({
        item: this.rowToEpisode(r),
        similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
      }))
  }

  async getByIds(ids: string[]): Promise<Episode[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM episodes WHERE id IN (${placeholders})`)
      .all(...ids) as EpisodeRow[]
    return rows.map((r) => this.rowToEpisode(r))
  }

  async getBySession(
    sessionId: string,
    opts?: { since?: Date }
  ): Promise<Episode[]> {
    let sql = 'SELECT * FROM episodes WHERE session_id = ?'
    const params: unknown[] = [sessionId]
    if (opts?.since) {
      sql += ' AND created_at >= ?'
      params.push(opts.since.getTime() / 86400000 + 2440587.5)
    }
    sql += ' ORDER BY created_at ASC'
    const rows = this.db.prepare(sql).all(...params) as EpisodeRow[]
    return rows.map((r) => this.rowToEpisode(r))
  }

  async getUnconsolidated(sessionId: string): Promise<Episode[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM episodes WHERE session_id = ? AND consolidated_at IS NULL ORDER BY salience DESC'
      )
      .all(sessionId) as EpisodeRow[]
    return rows.map((r) => this.rowToEpisode(r))
  }

  async getUnconsolidatedSessions(): Promise<string[]> {
    return this.db
      .prepare(
        'SELECT DISTINCT session_id FROM episodes WHERE consolidated_at IS NULL'
      )
      .pluck()
      .all() as string[]
  }

  async markConsolidated(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(
        `UPDATE episodes SET consolidated_at = julianday('now') WHERE id IN (${placeholders})`
      )
      .run(...ids)
  }

  async recordAccess(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE episodes SET access_count = access_count + 1, last_accessed = julianday('now') WHERE id = ?`
      )
      .run(id)
  }

  private rowToEpisode(row: EpisodeRow): Episode {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role as Episode['role'],
      content: row.content,
      salience: row.salience,
      accessCount: row.access_count,
      lastAccessed: julianToDate(row.last_accessed),
      consolidatedAt: julianToDate(row.consolidated_at),
      embedding: row.embedding
        ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4))
        : null,
      entities: JSON.parse(row.entities_json),
      metadata: JSON.parse(row.metadata),
      createdAt: julianToDate(row.created_at)!,
    }
  }
}

interface EpisodeRow {
  id: string
  session_id: string
  role: string
  content: string
  salience: number
  access_count: number
  last_accessed: number | null
  consolidated_at: number | null
  embedding: Buffer | null
  entities_json: string
  entities_fts: string
  metadata: string
  created_at: number
}
