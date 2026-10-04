import Database from 'better-sqlite3'
import type { MemoryType, MemoryKind, TypedMemory, SensorySnapshot, SearchResult } from '@engram-mem/core'
import type { StorageAdapter, LookupOptions, AccessQuantileTier } from '@engram-mem/core'
import { assertAccessQuantileArgs } from '@engram-mem/core'
import { cosineF32, blobToF32 } from './vector-search.js'
import { runMigrations } from './migrations.js'
import { SqliteEpisodeStorage } from './episodes.js'
import { SqliteDigestStorage } from './digests.js'
import { SqliteSemanticStorage } from './semantic.js'
import { SqliteProceduralStorage } from './procedural.js'
import { SqliteAssociationStorage } from './associations.js'
import { SqliteConsolidationRunStorage } from './consolidation-runs.js'
import {
  julianToDate,
  dateToJulian,
  orOfFtsStrings,
  registerEpisodeKindFunction,
  kindSessionClause,
} from './search.js'

/**
 * SQL suffixes for id lookups. Unless `includeInactive` is set, a tombstoned
 * row is skipped in every tier that has `forgotten_at`, and a superseded
 * semantic row is skipped too. Digests have neither column.
 */
function lookupPredicates(opts?: LookupOptions): { notForgotten: string; live: string } {
  if (opts?.includeInactive) return { notForgotten: '', live: '' }
  return {
    notForgotten: ' AND forgotten_at IS NULL',
    live: ' AND forgotten_at IS NULL AND superseded_by IS NULL',
  }
}

export class SqliteStorageAdapter implements StorageAdapter {
  private db: Database.Database | null = null
  private _episodes: SqliteEpisodeStorage | null = null
  private _digests: SqliteDigestStorage | null = null
  private _semantic: SqliteSemanticStorage | null = null
  private _procedural: SqliteProceduralStorage | null = null
  private _associations: SqliteAssociationStorage | null = null
  private _consolidationRuns: SqliteConsolidationRunStorage | null = null

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
    registerEpisodeKindFunction(this.db)

    this._episodes = new SqliteEpisodeStorage(this.db)
    this._digests = new SqliteDigestStorage(this.db)
    this._semantic = new SqliteSemanticStorage(this.db)
    this._procedural = new SqliteProceduralStorage(this.db)
    this._associations = new SqliteAssociationStorage(this.db)
    this._consolidationRuns = new SqliteConsolidationRunStorage(this.db)
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

  get consolidationRuns(): SqliteConsolidationRunStorage {
    if (!this._consolidationRuns) throw new Error('SqliteStorageAdapter not initialized. Call initialize() first.')
    return this._consolidationRuns
  }

  private assertDb(): Database.Database {
    if (!this.db) throw new Error('SqliteStorageAdapter not initialized. Call initialize() first.')
    return this.db
  }

  async getById(id: string, type: MemoryType, opts?: LookupOptions): Promise<TypedMemory | null> {
    const db = this.assertDb()
    const { notForgotten, live } = lookupPredicates(opts)

    switch (type) {
      case 'episode': {
        const row = db.prepare(`SELECT * FROM episodes WHERE id = ?${notForgotten}`).get(id) as EpisodeRow | undefined
        if (!row) return null
        const episodes = await this._episodes!.getByIds([id], opts)
        return episodes.length > 0 ? { type: 'episode', data: episodes[0] } : null
      }
      case 'digest': {
        const row = db.prepare('SELECT * FROM digests WHERE id = ?').get(id) as DigestRow | undefined
        if (!row) return null
        return { type: 'digest', data: rowToDigest(row) }
      }
      case 'semantic': {
        const row = db.prepare(`SELECT * FROM semantic WHERE id = ?${live}`).get(id) as SemanticRow | undefined
        if (!row) return null
        return { type: 'semantic', data: rowToSemanticMemory(row) }
      }
      case 'procedural': {
        const row = db.prepare(`SELECT * FROM procedural WHERE id = ?${notForgotten}`).get(id) as ProceduralRow | undefined
        if (!row) return null
        return { type: 'procedural', data: rowToProceduralMemory(row) }
      }
    }
  }

  async getByIds(
    ids: Array<{ id: string; type: MemoryType }>,
    opts?: LookupOptions,
  ): Promise<TypedMemory[]> {
    if (ids.length === 0) return []
    const db = this.assertDb()
    const { notForgotten, live } = lookupPredicates(opts)

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
      const episodes = await this._episodes!.getByIds(episodeIds, opts)
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
        .prepare(`SELECT * FROM semantic WHERE id IN (${placeholders})${live}`)
        .all(...semanticIds) as SemanticRow[]
      for (const row of rows) results.push({ type: 'semantic', data: rowToSemanticMemory(row) })
    }

    const proceduralIds = byType.get('procedural')
    if (proceduralIds && proceduralIds.length > 0) {
      const placeholders = proceduralIds.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT * FROM procedural WHERE id IN (${placeholders})${notForgotten}`)
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
    projectId?: string
    kinds?: MemoryKind[]
    excludeSessionId?: string
  }): Promise<SearchResult<TypedMemory>[]> {
    const db = this.assertDb()
    const limit = opts?.limit ?? 15
    const tiers = opts?.tiers ?? ['episode', 'digest', 'semantic', 'procedural']
    // Exhaustive scan — every row with an embedding in each tier is scored.
    // No ORDER BY/LIMIT candidate pool to hide a better match outside it.
    // The scoring pass reads only (id, embedding) and decodes via a zero-copy
    // Float32Array view (blobToF32/cosineF32), so per-row cost is ~2.5-6us
    // regardless of table size; only the post-sort candidate set is hydrated
    // to full rows.
    const candidates: Array<{ id: string; type: MemoryType; sim: number }> = []
    // Parameterized project filter — SQL clause + params to append to each query
    const projectFilter = opts?.projectId ? ' AND (project_id = ? OR project_id IS NULL)' : ''
    const projectParams: unknown[] = opts?.projectId ? [opts.projectId] : []
    // Kind and session filters sit in each tier's WHERE clause, so the
    // candidate pool and the final limit only ever see matching rows.
    const filter = { kinds: opts?.kinds, excludeSessionId: opts?.excludeSessionId }
    const episodeFilter = kindSessionClause('episode', filter)
    const digestFilter = kindSessionClause('digest', filter)
    const semanticFilter = kindSessionClause('semantic', filter)
    const proceduralFilter = kindSessionClause('procedural', filter)

    if (tiers.includes('episode') && episodeFilter) {
      let sql: string
      let params: unknown[]
      if (opts?.sessionId) {
        sql = `SELECT id, embedding FROM episodes WHERE embedding IS NOT NULL AND forgotten_at IS NULL AND session_id = ?${projectFilter}${episodeFilter.sql}`
        params = [opts.sessionId, ...projectParams, ...episodeFilter.params]
      } else {
        sql = `SELECT id, embedding FROM episodes WHERE embedding IS NOT NULL AND forgotten_at IS NULL${projectFilter}${episodeFilter.sql}`
        params = [...projectParams, ...episodeFilter.params]
      }
      const rows = db.prepare(sql).all(...params) as ScoreRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const sim = cosineF32(embedding, blobToF32(row.embedding))
        if (sim > 0) candidates.push({ id: row.id, type: 'episode', sim })
      }
    }

    if (tiers.includes('digest') && digestFilter) {
      const rows = db.prepare(
        `SELECT id, embedding FROM digests WHERE embedding IS NOT NULL${projectFilter}${digestFilter.sql}`
      ).all(...projectParams, ...digestFilter.params) as ScoreRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const sim = cosineF32(embedding, blobToF32(row.embedding))
        if (sim > 0) candidates.push({ id: row.id, type: 'digest', sim })
      }
    }

    if (tiers.includes('semantic') && semanticFilter) {
      const rows = db.prepare(
        `SELECT id, embedding FROM semantic WHERE embedding IS NOT NULL AND superseded_by IS NULL AND forgotten_at IS NULL${projectFilter}${semanticFilter.sql}`
      ).all(...projectParams, ...semanticFilter.params) as ScoreRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const sim = cosineF32(embedding, blobToF32(row.embedding))
        if (sim > 0) candidates.push({ id: row.id, type: 'semantic', sim })
      }
    }

    if (tiers.includes('procedural') && proceduralFilter) {
      const rows = db.prepare(
        `SELECT id, embedding FROM procedural WHERE embedding IS NOT NULL AND forgotten_at IS NULL${projectFilter}${proceduralFilter.sql}`
      ).all(...projectParams, ...proceduralFilter.params) as ScoreRow[]
      for (const row of rows) {
        if (!row.embedding) continue
        const sim = cosineF32(embedding, blobToF32(row.embedding))
        if (sim > 0) candidates.push({ id: row.id, type: 'procedural', sim })
      }
    }

    // Global top candidates BEFORE hydration — hydration (full row + JSON
    // parse) is the expensive part; scoring above is not.
    const top = candidates
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit * 4)

    const idsByType = new Map<MemoryType, string[]>()
    for (const c of top) {
      const list = idsByType.get(c.type) ?? []
      list.push(c.id)
      idsByType.set(c.type, list)
    }

    const hydrated = new Map<string, TypedMemory>()

    const episodeIds = idsByType.get('episode')
    if (episodeIds && episodeIds.length > 0) {
      const episodes = await this._episodes!.getByIds(episodeIds)
      for (const ep of episodes) hydrated.set(`episode:${ep.id}`, { type: 'episode', data: ep })
    }

    const digestIds = idsByType.get('digest')
    if (digestIds && digestIds.length > 0) {
      const placeholders = digestIds.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT * FROM digests WHERE id IN (${placeholders})`)
        .all(...digestIds) as DigestRow[]
      for (const row of rows) hydrated.set(`digest:${row.id}`, { type: 'digest', data: rowToDigest(row) })
    }

    const semanticIds = idsByType.get('semantic')
    if (semanticIds && semanticIds.length > 0) {
      const placeholders = semanticIds.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT * FROM semantic WHERE id IN (${placeholders})`)
        .all(...semanticIds) as SemanticRow[]
      for (const row of rows) hydrated.set(`semantic:${row.id}`, { type: 'semantic', data: rowToSemanticMemory(row) })
    }

    const proceduralIds = idsByType.get('procedural')
    if (proceduralIds && proceduralIds.length > 0) {
      const placeholders = proceduralIds.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT * FROM procedural WHERE id IN (${placeholders})`)
        .all(...proceduralIds) as ProceduralRow[]
      for (const row of rows) hydrated.set(`procedural:${row.id}`, { type: 'procedural', data: rowToProceduralMemory(row) })
    }

    const results: Array<SearchResult<TypedMemory>> = []
    for (const c of top) {
      const item = hydrated.get(`${c.type}:${c.id}`)
      if (item) results.push({ item, similarity: c.sim })
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  }

  async textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
    projectId?: string
    kinds?: MemoryKind[]
    excludeSessionId?: string
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>> {
    const db = this.assertDb()
    if (terms.length === 0) return []
    const limit = opts?.limit ?? 30

    const ftsQuery = orOfFtsStrings(terms)
    if (!ftsQuery) return []
    const allResults: Array<{ id: string; type: MemoryType; rankScore: number }> = []
    const projectId = opts?.projectId

    const tiers: Array<{ type: MemoryType; fts: string; table: string; alive: string }> = [
      { type: 'episode', fts: 'episodes_fts', table: 'episodes', alive: 'AND t.forgotten_at IS NULL' },
      { type: 'digest', fts: 'digests_fts', table: 'digests', alive: '' },
      { type: 'semantic', fts: 'semantic_fts', table: 'semantic', alive: 'AND t.superseded_by IS NULL AND t.forgotten_at IS NULL' },
      { type: 'procedural', fts: 'procedural_fts', table: 'procedural', alive: 'AND t.forgotten_at IS NULL' },
    ]
    const filter = { kinds: opts?.kinds, excludeSessionId: opts?.excludeSessionId }
    for (const tier of tiers) {
      // The filters go in the WHERE clause so the per-tier LIMIT counts only matching rows.
      const kindSession = kindSessionClause(tier.type, filter, 't.')
      if (!kindSession) continue
      const scope = projectId ? 'AND (t.project_id = ? OR t.project_id IS NULL)' : ''
      const sql = `SELECT t.id, rank FROM ${tier.fts} f JOIN ${tier.table} t ON t.rowid = f.rowid WHERE ${tier.fts} MATCH ? ${tier.alive} ${scope}${kindSession.sql} ORDER BY rank LIMIT ?`
      const params: unknown[] = [ftsQuery, ...(projectId ? [projectId] : []), ...kindSession.params, limit]
      let rows: Array<{ id: string; rank: number }>
      try {
        rows = db.prepare(sql).all(...params) as Array<{ id: string; rank: number }>
      } catch (err) {
        // A missing FTS table means the tier has no lexical index yet; any
        // other failure is a broken query and must not read as "no matches".
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('no such table')) continue
        throw new Error(`textBoost ${tier.type} FTS query failed: ${message}`, { cause: err })
      }
      for (const r of rows) allResults.push({ id: r.id, type: tier.type, rankScore: Math.abs(r.rank) })
    }

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

  async saveCommunityCache(data: {
    communityId: string
    projectId: string | null
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
  }): Promise<void> {
    const db = this.assertDb()
    db.prepare(`
      INSERT INTO community_summaries
        (community_id, project_id, label, member_count, top_entities, top_topics,
         top_persons, dominant_emotion, generated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, julianday('now'), julianday('now'))
      ON CONFLICT(community_id) DO UPDATE SET
        label            = excluded.label,
        member_count     = excluded.member_count,
        top_entities     = excluded.top_entities,
        top_topics       = excluded.top_topics,
        top_persons      = excluded.top_persons,
        dominant_emotion = excluded.dominant_emotion,
        updated_at       = julianday('now')
    `).run(
      data.communityId,
      data.projectId ?? null,
      data.label,
      data.memberCount,
      JSON.stringify(data.topEntities),
      JSON.stringify(data.topTopics),
      JSON.stringify(data.topPersons),
      data.dominantEmotion ?? null,
    )
  }

  async getCommunitySummaries(opts?: {
    projectId?: string
    limit?: number
  }): Promise<Array<{
    communityId: string
    projectId: string | null
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
    generatedAt: string
  }>> {
    const db = this.assertDb()
    const limit = opts?.limit ?? 20

    let sql: string
    let params: unknown[]

    if (opts?.projectId !== undefined) {
      sql = `SELECT * FROM community_summaries WHERE (project_id = ? OR project_id IS NULL) ORDER BY member_count DESC LIMIT ?`
      params = [opts.projectId, limit]
    } else {
      sql = `SELECT * FROM community_summaries ORDER BY member_count DESC LIMIT ?`
      params = [limit]
    }

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map(r => ({
      communityId: r['community_id'] as string,
      projectId: r['project_id'] as string | null,
      label: r['label'] as string,
      memberCount: r['member_count'] as number,
      topEntities: JSON.parse(r['top_entities'] as string) as string[],
      topTopics: JSON.parse(r['top_topics'] as string) as string[],
      topPersons: JSON.parse(r['top_persons'] as string) as string[],
      dominantEmotion: r['dominant_emotion'] as string | null,
      generatedAt: String(r['generated_at']),
    }))
  }

  // ---------------------------------------------------------------------------
  // Recall-engine feed: scanEmbeddings / listTombstonesSince
  // ---------------------------------------------------------------------------

  async *scanEmbeddings(opts: {
    tier: MemoryType
    afterCreatedAt?: Date
    batchSize?: number
  }): AsyncIterable<Array<{
    id: string
    type: MemoryType
    createdAt: Date
    projectId: string | null
    sessionId: string | null
    embedding: number[] | Float32Array
  }>> {
    const db = this.assertDb()
    const config = SCAN_TIER_CONFIG[opts.tier]
    const batchSize = opts.batchSize ?? 1000
    // First page bounds on createdAt alone (the caller only has a Date to
    // resume from); every subsequent internal page bounds on the tie-safe
    // (createdAt, id) cursor recorded from the previous page's last row.
    const firstBound = opts.afterCreatedAt ? dateToJulian(opts.afterCreatedAt) : null
    let cursor: { createdAt: number; id: string } | null = null

    const sessionCol = config.hasSessionId ? ', session_id' : ''

    while (true) {
      let sql = `SELECT id, created_at, project_id${sessionCol}, embedding FROM ${config.table} WHERE embedding IS NOT NULL`
      const params: unknown[] = []

      if (config.hasForgottenAt) sql += ' AND forgotten_at IS NULL'
      if (config.hasSupersededBy) sql += ' AND superseded_by IS NULL'

      if (cursor) {
        sql += ' AND (created_at, id) > (?, ?)'
        params.push(cursor.createdAt, cursor.id)
      } else if (firstBound !== null) {
        sql += ' AND created_at > ?'
        params.push(firstBound)
      }

      sql += ' ORDER BY created_at, id LIMIT ?'
      params.push(batchSize)

      const rows = db.prepare(sql).all(...params) as ScanRow[]
      if (rows.length === 0) break

      yield rows.map(row => ({
        id: row.id,
        type: opts.tier,
        createdAt: julianToDate(row.created_at)!,
        projectId: row.project_id ?? null,
        sessionId: config.hasSessionId ? (row.session_id ?? null) : null,
        // WHERE embedding IS NOT NULL above guarantees a Buffer here.
        embedding: blobToF32(row.embedding as Buffer),
      }))

      const last = rows[rows.length - 1]!
      cursor = { createdAt: last.created_at, id: last.id }

      if (rows.length < batchSize) break
    }
  }

  async listTombstonesSince(since: Date): Promise<Array<{ id: string; type: MemoryType }>> {
    const db = this.assertDb()
    const sinceJulian = dateToJulian(since)
    const seen = new Set<string>()
    const results: Array<{ id: string; type: MemoryType }> = []

    const collect = (rows: Array<{ id: string }>, type: MemoryType): void => {
      for (const row of rows) {
        const key = `${type}:${row.id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ id: row.id, type })
      }
    }

    collect(
      db.prepare('SELECT id FROM episodes WHERE forgotten_at IS NOT NULL AND forgotten_at >= ?')
        .all(sinceJulian) as Array<{ id: string }>,
      'episode'
    )
    collect(
      db.prepare('SELECT id FROM semantic WHERE forgotten_at IS NOT NULL AND forgotten_at >= ?')
        .all(sinceJulian) as Array<{ id: string }>,
      'semantic'
    )
    // Semantic supersession is a distinct tombstone reason from forget() —
    // `collect`'s seen-set dedupes a row that happens to be both.
    collect(
      db.prepare('SELECT id FROM semantic WHERE superseded_by IS NOT NULL AND updated_at >= ?')
        .all(sinceJulian) as Array<{ id: string }>,
      'semantic'
    )
    collect(
      db.prepare('SELECT id FROM procedural WHERE forgotten_at IS NOT NULL AND forgotten_at >= ?')
        .all(sinceJulian) as Array<{ id: string }>,
      'procedural'
    )
    // digests: no forgotten_at column, never superseded — intentionally omitted.

    return results
  }

  /**
   * Nearest-rank quantile: the value at offset floor(q·(n−1)) in ascending
   * order. PostgreSQL's percentile_cont interpolates between the two ranks
   * around q·(n−1), so the two backends can differ by at most one rank.
   */
  async accessCountQuantile(tier: AccessQuantileTier, q: number): Promise<number> {
    assertAccessQuantileArgs(tier, q)
    const db = this.assertDb()
    const config = SCAN_TIER_CONFIG[tier]
    let where = 'WHERE 1 = 1'
    if (config.hasForgottenAt) where += ' AND forgotten_at IS NULL'
    if (config.hasSupersededBy) where += ' AND superseded_by IS NULL'
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${config.table} ${where}`).get() as { n: number }
    if (n === 0) return 0
    const offset = Math.floor(q * (n - 1))
    const row = db
      .prepare(`SELECT access_count FROM ${config.table} ${where} ORDER BY access_count LIMIT 1 OFFSET ?`)
      .get(offset) as { access_count: number } | undefined
    return row?.access_count ?? 0
  }
}

// ---------------------------------------------------------------------------
// scanEmbeddings per-tier table config
// ---------------------------------------------------------------------------

interface ScanTierConfig {
  table: string
  hasForgottenAt: boolean
  hasSupersededBy: boolean
  hasSessionId: boolean
}

const SCAN_TIER_CONFIG: Record<MemoryType, ScanTierConfig> = {
  episode: { table: 'episodes', hasForgottenAt: true, hasSupersededBy: false, hasSessionId: true },
  digest: { table: 'digests', hasForgottenAt: false, hasSupersededBy: false, hasSessionId: true },
  semantic: { table: 'semantic', hasForgottenAt: true, hasSupersededBy: true, hasSessionId: false },
  procedural: { table: 'procedural', hasForgottenAt: true, hasSupersededBy: false, hasSessionId: false },
}

/** Minimal projection used by scanEmbeddings — id/created_at/project_id/
 *  (session_id when the tier has one)/embedding. `embedding` is always a
 *  Buffer at runtime (the query filters embedding IS NOT NULL). */
interface ScanRow {
  id: string
  created_at: number
  project_id: string | null
  session_id?: string | null
  embedding: Buffer | null
}

// ---------------------------------------------------------------------------
// Row mapping helpers — mirror the private methods in the sub-stores but
// scoped to the adapter so we can reconstruct TypedMemory without exposing
// internal sub-store methods.
// ---------------------------------------------------------------------------

/** Minimal projection used by vectorSearch's scoring pass — id + embedding only. */
interface ScoreRow {
  id: string
  embedding: Buffer | null
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
  project_id: string | null
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
  project_id: string | null
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
  project_id: string | null
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
  project_id: string | null
}

import type { Digest, SemanticMemory, ProceduralMemory } from '@engram-mem/core'

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
    projectId: row.project_id ?? null,
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
    projectId: row.project_id ?? null,
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
    projectId: row.project_id ?? null,
  }
}
