import type Database from 'better-sqlite3'
import type { Digest, SearchOptions, SearchResult } from '@engram/core'
import { generateId } from '@engram/core'
import type { DigestStorage } from '@engram/core'
import { sanitizeFtsQuery, julianToDate } from './search.js'

export class SqliteDigestStorage implements DigestStorage {
  constructor(private db: Database.Database) {}

  async insert(digest: Omit<Digest, 'id' | 'createdAt'>): Promise<Digest> {
    const id = generateId()

    const embeddingBlob = digest.embedding
      ? Buffer.from(new Float32Array(digest.embedding).buffer)
      : null

    this.db.transaction(() => {
      this.db.prepare('INSERT INTO memories (id, type) VALUES (?, ?)').run(id, 'digest')

      this.db
        .prepare(
          `INSERT INTO digests (id, session_id, summary, key_topics, source_episode_ids,
           source_digest_ids, level, embedding, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          digest.sessionId,
          digest.summary,
          JSON.stringify(digest.keyTopics),
          JSON.stringify(digest.sourceEpisodeIds),
          JSON.stringify(digest.sourceDigestIds),
          digest.level,
          embeddingBlob,
          JSON.stringify(digest.metadata)
        )
    })()

    return this.rowToDigest(
      this.db.prepare('SELECT * FROM digests WHERE id = ?').get(id) as DigestRow
    )
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<Digest>[]> {
    const ftsQuery = sanitizeFtsQuery(query)
    const limit = opts?.limit ?? 10

    const rows = this.db
      .prepare(
        `SELECT d.*, -digests_fts.rank AS bm25_score
         FROM digests_fts
         JOIN digests d ON digests_fts.rowid = d.rowid
         WHERE digests_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, limit) as (DigestRow & { bm25_score: number })[]

    const maxScore = rows.length > 0 ? Math.max(...rows.map((r) => r.bm25_score)) : 1
    return rows
      .filter((r) => r.bm25_score > 0)
      .map((r) => ({
        item: this.rowToDigest(r),
        similarity: maxScore > 0 ? r.bm25_score / maxScore : 0,
      }))
  }

  async getBySession(sessionId: string): Promise<Digest[]> {
    const rows = this.db
      .prepare('SELECT * FROM digests WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as DigestRow[]
    return rows.map((r) => this.rowToDigest(r))
  }

  async getRecent(days: number): Promise<Digest[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM digests WHERE created_at >= julianday('now') - ? ORDER BY created_at DESC`
      )
      .all(days) as DigestRow[]
    return rows.map((r) => this.rowToDigest(r))
  }

  async getCountBySession(): Promise<Record<string, number>> {
    const rows = this.db
      .prepare('SELECT session_id, COUNT(*) as cnt FROM digests GROUP BY session_id')
      .all() as Array<{ session_id: string; cnt: number }>
    const result: Record<string, number> = {}
    for (const row of rows) {
      result[row.session_id] = row.cnt
    }
    return result
  }

  private rowToDigest(row: DigestRow): Digest {
    return {
      id: row.id,
      sessionId: row.session_id,
      summary: row.summary,
      keyTopics: JSON.parse(row.key_topics),
      sourceEpisodeIds: JSON.parse(row.source_episode_ids),
      sourceDigestIds: JSON.parse(row.source_digest_ids),
      level: row.level,
      embedding: row.embedding
        ? Array.from(
            new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4)
          )
        : null,
      metadata: JSON.parse(row.metadata),
      createdAt: julianToDate(row.created_at)!,
    }
  }
}

interface DigestRow {
  id: string
  session_id: string
  summary: string
  key_topics: string
  source_episode_ids: string
  source_digest_ids: string
  level: number
  embedding: Buffer | null
  metadata: string
  created_at: number
}
