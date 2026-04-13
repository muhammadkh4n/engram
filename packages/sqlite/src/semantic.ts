import type Database from 'better-sqlite3'
import type { SemanticMemory, SearchOptions, SearchResult } from '@engram-mem/core'
import { generateId } from '@engram-mem/core'
import type { SemanticStorage } from '@engram-mem/core'
import { sanitizeFtsQuery, julianToDate } from './search.js'
import { hybridSearch } from './vector-search.js'

export class SqliteSemanticStorage implements SemanticStorage {
  constructor(private db: Database.Database) {}

  async insert(
    memory: Omit<SemanticMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<SemanticMemory> {
    const id = generateId()

    const embeddingBlob = memory.embedding
      ? Buffer.from(new Float32Array(memory.embedding).buffer)
      : null

    this.db.transaction(() => {
      this.db.prepare('INSERT INTO memories (id, type) VALUES (?, ?)').run(id, 'semantic')

      this.db
        .prepare(
          `INSERT INTO semantic (id, topic, content, confidence, source_digest_ids, source_episode_ids,
           decay_rate, supersedes, superseded_by, embedding, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          memory.topic,
          memory.content,
          memory.confidence,
          JSON.stringify(memory.sourceDigestIds),
          JSON.stringify(memory.sourceEpisodeIds),
          memory.decayRate,
          memory.supersedes,
          memory.supersededBy,
          embeddingBlob,
          JSON.stringify(memory.metadata)
        )
    })()

    return this.rowToSemantic(
      this.db.prepare('SELECT * FROM semantic WHERE id = ?').get(id) as SemanticRow
    )
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<SemanticMemory>[]> {
    const ftsQuery = sanitizeFtsQuery(query)
    const limit = opts?.limit ?? 10
    const embedding = opts?.embedding

    // Hybrid path when a query embedding is available
    if (embedding && embedding.length > 0) {
      const db = this.db
      const rowToS = (row: SemanticRow & { bm25_score: number }) => this.rowToSemantic(row)

      return hybridSearch<SemanticMemory, SemanticRow>(
        {
          db,
          runBm25: () =>
            db
              .prepare(
                `SELECT s.*, -semantic_fts.rank AS bm25_score
                 FROM semantic_fts
                 JOIN semantic s ON semantic_fts.rowid = s.rowid
                 WHERE semantic_fts MATCH ?
                   AND s.superseded_by IS NULL
                 ORDER BY rank LIMIT 50`
              )
              .all(ftsQuery) as Array<SemanticRow & { bm25_score: number }>,
          recentVectorSql: `
            SELECT id, embedding FROM semantic
            WHERE embedding IS NOT NULL
              AND superseded_by IS NULL
            ORDER BY created_at DESC
            LIMIT ?
          `,
          recentVectorLimit: 200,
          queryEmbedding: embedding,
          limit,
          getByIds: async (ids) => {
            if (ids.length === 0) return []
            const placeholders = ids.map(() => '?').join(',')
            const rows = db
              .prepare(`SELECT * FROM semantic WHERE id IN (${placeholders})`)
              .all(...ids) as SemanticRow[]
            return rows.map(r => this.rowToSemantic(r))
          },
        },
        rowToS,
        (item, score) => ({ item, similarity: score })
      )
    }

    // BM25-only path
    const rows = this.db
      .prepare(
        `SELECT s.*, -semantic_fts.rank AS bm25_score
         FROM semantic_fts
         JOIN semantic s ON semantic_fts.rowid = s.rowid
         WHERE semantic_fts MATCH ?
           AND s.superseded_by IS NULL
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, limit) as (SemanticRow & { bm25_score: number })[]

    const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.bm25_score)) : 1
    return rows
      .filter((r) => r.bm25_score > 0)
      .map((r) => ({
        item: this.rowToSemantic(r),
        similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
      }))
  }

  async getUnaccessed(days: number): Promise<SemanticMemory[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM semantic
         WHERE confidence > 0.05
           AND (last_accessed IS NULL OR last_accessed < julianday('now') - ?)`
      )
      .all(days) as SemanticRow[]
    return rows.map((r) => this.rowToSemantic(r))
  }

  async recordAccessAndBoost(id: string, confidenceBoost: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE semantic
         SET access_count = access_count + 1,
             last_accessed = julianday('now'),
             confidence = MAX(0.05, MIN(1.0, confidence + ?))
         WHERE id = ?`
      )
      .run(confidenceBoost, id)
  }

  async markSuperseded(id: string, supersededBy: string): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db.prepare('UPDATE semantic SET superseded_by = ? WHERE id = ?').run(supersededBy, id)
      this.db.prepare('UPDATE semantic SET supersedes = ? WHERE id = ?').run(id, supersededBy)
    })
    txn()
  }

  async batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE semantic
         SET confidence = MAX(0.05, confidence - ?)
         WHERE confidence > 0.05
           AND (last_accessed IS NULL OR last_accessed < julianday('now') - ?)`
      )
      .run(opts.decayRate, opts.daysThreshold)
    return result.changes
  }

  async batchDecayGradient(
    updates: Array<{ id: string; effectiveDecayRate: number; daysThreshold: number }>,
  ): Promise<number> {
    const stmt = this.db.prepare(`
      UPDATE semantic
      SET confidence = MAX(0.0, confidence - ?)
      WHERE id = ?
        AND (last_accessed IS NULL OR last_accessed < julianday('now') - ?)
        AND superseded_by IS NULL
    `)
    let total = 0
    const txn = this.db.transaction(() => {
      for (const u of updates) {
        const result = stmt.run(u.effectiveDecayRate, u.id, u.daysThreshold)
        total += result.changes
      }
    })
    txn()
    return total
  }

  private rowToSemantic(row: SemanticRow): SemanticMemory {
    return {
      id: row.id,
      topic: row.topic,
      content: row.content,
      confidence: row.confidence,
      sourceDigestIds: JSON.parse(row.source_digest_ids),
      sourceEpisodeIds: JSON.parse(row.source_episode_ids),
      accessCount: row.access_count,
      lastAccessed: julianToDate(row.last_accessed),
      decayRate: row.decay_rate,
      supersedes: row.supersedes,
      supersededBy: row.superseded_by,
      embedding: row.embedding
        ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4))
        : null,
      metadata: JSON.parse(row.metadata),
      createdAt: julianToDate(row.created_at)!,
      updatedAt: julianToDate(row.updated_at)!,
    }
  }
}

interface SemanticRow {
  id: string
  topic: string
  content: string
  confidence: number
  source_digest_ids: string
  source_episode_ids: string
  access_count: number
  last_accessed: number | null
  decay_rate: number
  supersedes: string | null
  superseded_by: string | null
  embedding: Buffer | null
  metadata: string
  created_at: number
  updated_at: number
}
