import Database from 'better-sqlite3'
import type { MemoryType, TypedMemory, SensorySnapshot, SearchResult } from '@engram/core'
import type { StorageAdapter } from '@engram/core'
import { cosineSimilarity, blobToVector } from './vector-search.js'
import { runMigrations } from './migrations.js'
import { SqliteEpisodeStorage } from './episodes.js'
import { SqliteDigestStorage } from './digests.js'
import { SqliteSemanticStorage } from './semantic.js'
import { SqliteProceduralStorage } from './procedural.js'
import { SqliteAssociationStorage } from './associations.js'
import { julianToDate } from './search.js'

export class SqliteStorageAdapter implements StorageAdapter {
  private db: Database.Database | null = null
  private _episodes: SqliteEpisodeStorage | null = null
  private _digests: SqliteDigestStorage | null = null
  private _semantic: SqliteSemanticStorage | null = null
  private _procedural: SqliteProceduralStorage | null = null
  private _associations: SqliteAssociationStorage | null = null

  constructor(private readonly path?: string) {}

  async initialize(): Promise<void> {
    const dbPath = this.path ?? ':memory:'
    this.db = new Database(dbPath)

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('cache_size = -65536')
    this.db.pragma('temp_store = MEMORY')
    this.db.pragma('mmap_size = 268435456')
    this.db.pragma('wal_autocheckpoint = 1000')

    runMigrations(this.db)

    this._episodes = new SqliteEpisodeStorage(this.db)
    this._digests = new SqliteDigestStorage(this.db)
    this._semantic = new SqliteSemanticStorage(this.db)
    this._procedural = new SqliteProceduralStorage(this.db)
    this._associations = new SqliteAssociationStorage(this.db)
  }

  async dispose(): Promise<void> {
    this.db?.close()
    this.db = null
  }

  get episodes(): SqliteEpisodeStorage {
    if (!this._episodes) throw new Error('SqliteStorageAdapter not initialized. Call initialize() first.')
    return this._episodes
  }

  get digests(): SqliteDigestStorage {
    if (!this._digests) throw new Error('SqliteStorageAdapter not initialized. Call initialize() first.')
    return this._digests
  }

  get semantic(): SqliteSemanticStorage {
    if (!this._semantic) throw new Error('SqliteStorageAdapter not initialized. Call initialize() first.')
    return this._semantic
  }

  get procedural(): SqliteProceduralStorage {
    if (!this._procedural) throw new Error('SqliteStorageAdapter not initialized. Call initialize() first.')
    return this._procedural
  }

  get associations(): SqliteAssociationStorage {
    if (!this._associations) throw new Error('SqliteStorageAdapter not initialized. Call initialize() first.')
    return this._associations
  }

  private assertDb(): Database.Database {
    if (!this.db) throw new Error('SqliteStorageAdapter not initialized. Call initialize() first.')
    return this.db
  }

  async getById(id: string, type: MemoryType): Promise<TypedMemory | null> {
    const db = this.assertDb()

    switch (type) {
      case 'episode': {
        const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined
        if (!row) return null
        const episodes = await this._episodes!.getByIds([id])
        return episodes.length > 0 ? { type: 'episode', data: episodes[0] } : null
      }
      case 'digest': {
        const row = db.prepare('SELECT * FROM digests WHERE id = ?').get(id) as DigestRow | undefined
        if (!row) return null
        return { type: 'digest', data: rowToDigest(row) }
      }
      case 'semantic': {
        const row = db.prepare('SELECT * FROM semantic WHERE id = ?').get(id) as SemanticRow | undefined
        if (!row) return null
        return { type: 'semantic', data: rowToSemanticMemory(row) }
      }
      case 'procedural': {
        const row = db.prepare('SELECT * FROM procedural WHERE id = ?').get(id) as ProceduralRow | undefined
        if (!row) return null
        return { type: 'procedural', data: rowToProceduralMemory(row) }
      }
    }
  }

  async getByIds(ids: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]> {
    if (ids.length === 0) return []
    const db = this.assertDb()

    // Group by type for efficient batch queries
    const byType = new Map<MemoryType, string[]>()
    for (const { id, type } of ids) {
      const list = byType.get(type) ?? []
      list.push(id)
      byType.set(type, list)
    }

    const results: TypedMemory[] = []

    const episodeIds = byType.get('episode')
    if (episodeIds && episodeIds.length > 0) {
      const episodes = await this._episodes!.getByIds(episodeIds)
      for (const ep of episodes) results.push({ type: 'episode', data: ep })
    }

    const digestIds = byType.get('digest')
    if (digestIds && digestIds.length > 0) {
      const placeholders = digestIds.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT * FROM digests WHERE id IN (${placeholders})`)
        .all(...digestIds) as DigestRow[]
      for (const row of rows) results.push({ type: 'digest', data: rowToDigest(row) })
    }

    const semanticIds = byType.get('semantic')
    if (semanticIds && semanticIds.length > 0) {
      const placeholders = semanticIds.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT * FROM semantic WHERE id IN (${placeholders})`)
        .all(...semanticIds) as SemanticRow[]
      for (const row of rows) results.push({ type: 'semantic', data: rowToSemanticMemory(row) })
    }

    const proceduralIds = byType.get('procedural')
    if (proceduralIds && proceduralIds.length > 0) {
      const placeholders = proceduralIds.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT * FROM procedural WHERE id IN (${placeholders})`)
        .all(...proceduralIds) as ProceduralRow[]
      for (const row of rows) results.push({ type: 'procedural', data: rowToProceduralMemory(row) })
    }

    return results
  }

  async saveSensorySnapshot(sessionId: string, snapshot: SensorySnapshot): Promise<void> {
    const db = this.assertDb()
    db
      .prepare(
        `INSERT OR REPLACE INTO sensory_snapshots (session_id, snapshot, saved_at)
         VALUES (?, ?, julianday('now'))`
      )
      .run(sessionId, JSON.stringify(snapshot))
  }

  async loadSensorySnapshot(sessionId: string): Promise<SensorySnapshot | null> {
    const db = this.assertDb()
    const row = db
      .prepare('SELECT snapshot FROM sensory_snapshots WHERE session_id = ?')
      .get(sessionId) as { snapshot: string } | undefined
    if (!row) return null
    return JSON.parse(row.snapshot) as SensorySnapshot
  }

  // ---------------------------------------------------------------------------
  // Vector-first retrieval
  // ---------------------------------------------------------------------------

  async vectorSearch(embedding: number[], opts?: {
    limit?: number
    sessionId?: string
    tiers?: MemoryType[]
  }): Promise<SearchResult<TypedMemory>[]> {
    const db = this.assertDb()
    const limit = opts?.limit ?? 15
    const tiers = opts?.tiers ?? ['episode', 'digest', 'semantic', 'procedural']
    const scanLimit = limit * 3
    const results: Array<SearchResult<TypedMemory>> = []

    if (tiers.includes('episode')) {
      const sql = opts?.sessionId
        ? 'SELECT * FROM episodes WHERE embedding IS NOT NULL AND session_id = ? ORDER BY created_at DESC LIMIT ?'
        : 'SELECT * FROM episodes WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?'
      const params = opts?.sessionId ? [opts.sessionId, scanLimit] : [scanLimit]
      const rows = db.prepare(sql).all(...params) as EpisodeRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const stored = blobToVector(row.embedding)
        const sim = cosineSimilarity(embedding, stored)
        if (sim > 0) {
          const episodes = await this._episodes!.getByIds([row.id])
          if (episodes.length > 0) {
            results.push({ item: { type: 'episode', data: episodes[0] }, similarity: sim })
          }
        }
      }
    }

    if (tiers.includes('digest')) {
      const rows = db.prepare(
        'SELECT * FROM digests WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?'
      ).all(scanLimit) as DigestRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const stored = blobToVector(row.embedding)
        const sim = cosineSimilarity(embedding, stored)
        if (sim > 0) {
          results.push({ item: { type: 'digest', data: rowToDigest(row) }, similarity: sim })
        }
      }
    }

    if (tiers.includes('semantic')) {
      const rows = db.prepare(
        'SELECT * FROM semantic WHERE embedding IS NOT NULL AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ?'
      ).all(scanLimit) as SemanticRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const stored = blobToVector(row.embedding)
        const sim = cosineSimilarity(embedding, stored)
        if (sim > 0) {
          results.push({ item: { type: 'semantic', data: rowToSemanticMemory(row) }, similarity: sim })
        }
      }
    }

    if (tiers.includes('procedural')) {
      const rows = db.prepare(
        'SELECT * FROM procedural WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?'
      ).all(scanLimit) as ProceduralRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const stored = blobToVector(row.embedding)
        const sim = cosineSimilarity(embedding, stored)
        if (sim > 0) {
          results.push({ item: { type: 'procedural', data: rowToProceduralMemory(row) }, similarity: sim })
        }
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  }

  async textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>> {
    const db = this.assertDb()
    if (terms.length === 0) return []
    const limit = opts?.limit ?? 30

    // FTS5 OR join
    const ftsQuery = terms.join(' OR ')
    const allResults: Array<{ id: string; type: MemoryType; rankScore: number }> = []

    try {
      const epRows = db.prepare(
        'SELECT e.id, rank FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid WHERE episodes_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, limit) as Array<{ id: string; rank: number }>
      for (const r of epRows) allResults.push({ id: r.id, type: 'episode', rankScore: Math.abs(r.rank) })
    } catch { /* FTS5 table may not exist */ }

    try {
      const dgRows = db.prepare(
        'SELECT d.id, rank FROM digests_fts f JOIN digests d ON d.rowid = f.rowid WHERE digests_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, limit) as Array<{ id: string; rank: number }>
      for (const r of dgRows) allResults.push({ id: r.id, type: 'digest', rankScore: Math.abs(r.rank) })
    } catch { /* FTS5 table may not exist */ }

    try {
      const smRows = db.prepare(
        'SELECT s.id, rank FROM semantic_fts f JOIN semantic s ON s.rowid = f.rowid WHERE semantic_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, limit) as Array<{ id: string; rank: number }>
      for (const r of smRows) allResults.push({ id: r.id, type: 'semantic', rankScore: Math.abs(r.rank) })
    } catch { /* FTS5 table may not exist */ }

    try {
      const prRows = db.prepare(
        'SELECT p.id, rank FROM procedural_fts f JOIN procedural p ON p.rowid = f.rowid WHERE procedural_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, limit) as Array<{ id: string; rank: number }>
      for (const r of prRows) allResults.push({ id: r.id, type: 'procedural', rankScore: Math.abs(r.rank) })
    } catch { /* FTS5 table may not exist */ }

    const maxRank = allResults.length > 0 ? Math.max(...allResults.map(r => r.rankScore)) : 1
    return allResults
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        type: r.type,
        boost: maxRank > 0 ? r.rankScore / maxRank : 0,
      }))
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers — mirror the private methods in the sub-stores but
// scoped to the adapter so we can reconstruct TypedMemory without exposing
// internal sub-store methods.
// ---------------------------------------------------------------------------

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

import type { Digest, SemanticMemory, ProceduralMemory } from '@engram/core'

function rowToDigest(row: DigestRow): Digest {
  return {
    id: row.id,
    sessionId: row.session_id,
    summary: row.summary,
    keyTopics: JSON.parse(row.key_topics),
    sourceEpisodeIds: JSON.parse(row.source_episode_ids),
    sourceDigestIds: JSON.parse(row.source_digest_ids),
    level: row.level,
    embedding: row.embedding
      ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4))
      : null,
    metadata: JSON.parse(row.metadata),
    createdAt: julianToDate(row.created_at)!,
  }
}

function rowToSemanticMemory(row: SemanticRow): SemanticMemory {
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

function rowToProceduralMemory(row: ProceduralRow): ProceduralMemory {
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
      ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4))
      : null,
    metadata: JSON.parse(row.metadata),
    createdAt: julianToDate(row.created_at)!,
    updatedAt: julianToDate(row.updated_at)!,
  }
}
