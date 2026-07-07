/**
 * In-memory fake `StorageAdapter` + deterministic fixture corpus for the
 * RecallEngine tests.
 *
 * The fake mirrors the SQLITE adapter's observable semantics precisely,
 * because those are the semantics the engine must reproduce:
 *   - `vectorSearch`: exhaustive exact-cosine scan; forgotten rows and
 *     superseded semantic rows excluded; `sessionId` constrains ONLY the
 *     episode tier; `projectId` matches `(project = X OR project IS NULL)`;
 *     candidates with sim <= 0 dropped; sort desc; slice(limit).
 *   - `getByIds`: returns rows found by id regardless of forgotten status
 *     (the sqlite implementation has no forgotten_at predicate there).
 *   - `scanEmbeddings`: live embedded rows only, (createdAt, id) ascending,
 *     strict `> afterCreatedAt`, batched.
 *   - `listTombstonesSince`: forget/supersede events with atMs >= since.
 *
 * `vectorSearch` doubles as the REFERENCE exact scan the engine's results
 * are compared against bit-for-bit — it scores with the same exported
 * `exactCosine` the engine uses at tier 3, so any score the engine returns
 * for a hydratable row must be float-identical.
 */
import type {
  Digest,
  Episode,
  MemoryType,
  ProceduralMemory,
  SearchResult,
  SemanticMemory,
  StorageAdapter,
  TypedMemory,
} from '@engram-mem/core'
import { exactCosine } from '../src/engine.js'
import { splitmix64 } from '../src/codec/rng.js'

const ALL_TIERS: readonly MemoryType[] = ['episode', 'digest', 'semantic', 'procedural']

export interface FixtureRow {
  id: string
  type: MemoryType
  createdAtMs: number
  projectId: string | null
  sessionId: string | null
  embedding: number[] | null
  forgottenAtMs: number | null
  supersededBy: string | null
}

export interface FakeAdapterOpts {
  batchSize?: number
  /** false omits scanEmbeddings/listTombstonesSince entirely (a legacy adapter without the optional port methods). */
  supportsScan?: boolean
}

/** Loud stub for the StorageAdapter members the engine never touches. */
function notUsed<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      return () => {
        throw new Error(`FakeStorageAdapter: ${name}.${String(prop)} is not implemented (RecallEngine must not call it)`)
      }
    },
  })
}

export class FakeStorageAdapter implements StorageAdapter {
  rows: FixtureRow[]
  tombstoneEvents: Array<{ id: string; type: MemoryType; atMs: number }> = []

  vectorSearchCalls = 0
  scanCalls = 0
  getByIdsCalls = 0

  /** Race-injection hook awaited inside getByIds before rows are returned. */
  onGetByIds: ((ids: Array<{ id: string; type: MemoryType }>) => void | Promise<void>) | null = null
  /** Per-id override of the embedding value the HYDRATED row carries (e.g. an unparseable string). */
  hydrationEmbeddingOverride = new Map<string, unknown>()

  private readonly batchSize: number

  episodes = notUsed<StorageAdapter['episodes']>('episodes')
  digests = notUsed<StorageAdapter['digests']>('digests')
  semantic = notUsed<StorageAdapter['semantic']>('semantic')
  procedural = notUsed<StorageAdapter['procedural']>('procedural')
  associations = notUsed<StorageAdapter['associations']>('associations')

  scanEmbeddings?: StorageAdapter['scanEmbeddings']
  listTombstonesSince?: StorageAdapter['listTombstonesSince']

  constructor(rows: FixtureRow[], opts: FakeAdapterOpts = {}) {
    this.rows = rows
    this.batchSize = opts.batchSize ?? 100

    if (opts.supportsScan !== false) {
      this.scanEmbeddings = scanOpts => {
        this.scanCalls++
        return this.scanBatches(scanOpts)
      }
      this.listTombstonesSince = async since =>
        this.tombstoneEvents.filter(e => e.atMs >= since.getTime()).map(({ id, type }) => ({ id, type }))
    }
  }

  // --- test fixture mutation helpers (foreign-writer simulation) ---

  addRow(row: FixtureRow): void {
    this.rows.push(row)
  }

  forget(id: string, atMs: number): void {
    const row = this.rows.find(r => r.id === id)
    if (!row) throw new Error(`forget: no fixture row ${id}`)
    row.forgottenAtMs = atMs
    this.tombstoneEvents.push({ id, type: row.type, atMs })
  }

  supersede(id: string, by: string, atMs: number): void {
    const row = this.rows.find(r => r.id === id)
    if (!row || row.type !== 'semantic') throw new Error(`supersede: no semantic fixture row ${id}`)
    row.supersededBy = by
    this.tombstoneEvents.push({ id, type: row.type, atMs })
  }

  // --- StorageAdapter surface used by the engine ---

  async initialize(): Promise<void> {}
  async dispose(): Promise<void> {}

  async vectorSearch(
    embedding: number[],
    opts?: { limit?: number; sessionId?: string; tiers?: MemoryType[]; projectId?: string },
  ): Promise<SearchResult<TypedMemory>[]> {
    this.vectorSearchCalls++
    return this.referenceScan(embedding, opts)
  }

  /** The exact-scan reference, without touching `vectorSearchCalls` — tests compare the engine against this. */
  async referenceScan(
    embedding: number[],
    opts?: { limit?: number; sessionId?: string; tiers?: MemoryType[]; projectId?: string },
  ): Promise<SearchResult<TypedMemory>[]> {
    const limit = opts?.limit ?? 15
    const tiers = opts?.tiers ?? [...ALL_TIERS]
    const scored: Array<{ row: FixtureRow; sim: number }> = []
    for (const row of this.rows) {
      if (!tiers.includes(row.type)) continue
      if (row.embedding === null || row.forgottenAtMs !== null) continue
      if (row.type === 'semantic' && row.supersededBy !== null) continue
      if (opts?.sessionId && row.type === 'episode' && row.sessionId !== opts.sessionId) continue
      if (opts?.projectId && row.projectId !== null && row.projectId !== opts.projectId) continue
      const sim = exactCosine(embedding, row.embedding)
      if (sim > 0) scored.push({ row, sim })
    }
    scored.sort((a, b) => b.sim - a.sim)
    return scored.slice(0, limit).map(({ row, sim }) => ({ item: this.toTypedMemory(row), similarity: sim }))
  }

  async textBoost(): Promise<Array<{ id: string; type: MemoryType; boost: number }>> {
    return []
  }

  async getById(id: string, type: MemoryType): Promise<TypedMemory | null> {
    const row = this.rows.find(r => r.id === id && r.type === type)
    return row ? this.toTypedMemory(row) : null
  }

  async getByIds(ids: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]> {
    this.getByIdsCalls++
    if (this.onGetByIds) await this.onGetByIds(ids)
    const out: TypedMemory[] = []
    for (const { id, type } of ids) {
      // No forgotten_at predicate here — mirrors sqlite getByIds, which
      // happily returns tombstoned rows when asked by id.
      const row = this.rows.find(r => r.id === id && r.type === type)
      if (row) out.push(this.toTypedMemory(row))
    }
    return out
  }

  async saveSensorySnapshot(): Promise<void> {
    throw new Error('FakeStorageAdapter: saveSensorySnapshot not implemented')
  }

  async loadSensorySnapshot(): Promise<null> {
    return null
  }

  // --- internals ---

  private async *scanBatches(opts: { tier: MemoryType; afterCreatedAt?: Date; batchSize?: number }): AsyncIterable<
    Array<{
      id: string
      type: MemoryType
      createdAt: Date
      projectId: string | null
      sessionId: string | null
      embedding: number[] | Float32Array
    }>
  > {
    const after = opts.afterCreatedAt?.getTime() ?? Number.NEGATIVE_INFINITY
    const batchSize = opts.batchSize ?? this.batchSize
    const live = this.rows
      .filter(
        r =>
          r.type === opts.tier &&
          r.embedding !== null &&
          r.forgottenAtMs === null &&
          !(r.type === 'semantic' && r.supersededBy !== null) &&
          r.createdAtMs > after,
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1))
    for (let i = 0; i < live.length; i += batchSize) {
      yield live.slice(i, i + batchSize).map(r => ({
        id: r.id,
        type: r.type,
        createdAt: new Date(r.createdAtMs),
        projectId: r.projectId,
        sessionId: r.sessionId,
        embedding: r.embedding as number[],
      }))
    }
  }

  private toTypedMemory(row: FixtureRow): TypedMemory {
    const createdAt = new Date(row.createdAtMs)
    const embedding = (
      this.hydrationEmbeddingOverride.has(row.id) ? this.hydrationEmbeddingOverride.get(row.id) : row.embedding
    ) as number[] | null

    switch (row.type) {
      case 'episode': {
        const data: Episode = {
          id: row.id,
          sessionId: row.sessionId ?? 'sess-none',
          role: 'user',
          content: `content of ${row.id}`,
          salience: 0.5,
          accessCount: 0,
          lastAccessed: null,
          consolidatedAt: null,
          embedding,
          entities: [],
          metadata: {},
          createdAt,
          projectId: row.projectId,
        }
        return { type: 'episode', data }
      }
      case 'digest': {
        const data: Digest = {
          id: row.id,
          sessionId: row.sessionId ?? 'sess-none',
          summary: `summary of ${row.id}`,
          keyTopics: [],
          sourceEpisodeIds: [],
          sourceDigestIds: [],
          level: 1,
          embedding,
          metadata: {},
          createdAt,
          projectId: row.projectId,
        }
        return { type: 'digest', data }
      }
      case 'semantic': {
        const data: SemanticMemory = {
          id: row.id,
          topic: `topic of ${row.id}`,
          content: `content of ${row.id}`,
          confidence: 0.9,
          sourceDigestIds: [],
          sourceEpisodeIds: [],
          accessCount: 0,
          lastAccessed: null,
          decayRate: 0.01,
          supersedes: null,
          supersededBy: row.supersededBy,
          embedding,
          metadata: {},
          createdAt,
          updatedAt: createdAt,
          projectId: row.projectId,
        }
        return { type: 'semantic', data }
      }
      case 'procedural': {
        const data: ProceduralMemory = {
          id: row.id,
          category: 'workflow',
          trigger: `trigger of ${row.id}`,
          procedure: `procedure of ${row.id}`,
          confidence: 0.9,
          observationCount: 1,
          lastObserved: createdAt,
          firstObserved: createdAt,
          accessCount: 0,
          lastAccessed: null,
          decayRate: 0.01,
          sourceEpisodeIds: [],
          embedding,
          metadata: {},
          createdAt,
          updatedAt: createdAt,
          projectId: row.projectId,
        }
        return { type: 'procedural', data }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic fixture corpus (seeded, clustered — realistic cosine
// structure rather than uniformly-random near-orthogonal noise).
// ---------------------------------------------------------------------------

export const DIMS = 1536
/** Fixed past epoch so foreign-writer rows added "now" always sort after the corpus. */
export const CORPUS_BASE_MS = 1_700_000_000_000

function gaussPair(rng: () => number): [number, number] {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  const r = Math.sqrt(-2 * Math.log(u))
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]
}

function randUnit(rng: () => number, len: number): number[] {
  const v = new Array<number>(len)
  for (let i = 0; i < len; i += 2) {
    const [a, b] = gaussPair(rng)
    v[i] = a
    if (i + 1 < len) v[i + 1] = b
  }
  return normalize(v)
}

function normalize(v: number[]): number[] {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  return v.map(x => x / n)
}

/** normalize(base + eps * noise) — a query "about" an existing row, or a cluster member. */
export function perturb(base: number[], rng: () => number, eps: number): number[] {
  const noise = randUnit(rng, base.length)
  return normalize(base.map((x, i) => x + eps * noise[i]))
}

export interface Corpus {
  rows: FixtureRow[]
  rng: () => number
}

/**
 * n mixed-tier rows over 12 clusters: episode-heavy tier cycle, projects
 * cycling (null, proj-a, proj-b), episode/digest sessions cycling
 * sess-1..3, semantic/procedural sessionless — deterministic per seed.
 */
export function buildCorpus(n: number, seed = 42n): Corpus {
  const rng = splitmix64(seed)
  const centers: number[][] = []
  for (let c = 0; c < 12; c++) centers.push(randUnit(rng, DIMS))

  const tierCycle: MemoryType[] = ['episode', 'episode', 'digest', 'semantic', 'procedural']
  const projectCycle: Array<string | null> = [null, 'proj-a', 'proj-b']
  // Cycle length 4 vs the project cycle's 3: coprime, so sessions and
  // projects decorrelate and combined session+project filters stay non-empty.
  const sessionCycle = ['sess-1', 'sess-2', 'sess-3', 'sess-4']

  const rows: FixtureRow[] = []
  for (let i = 0; i < n; i++) {
    const type = tierCycle[i % tierCycle.length]
    const center = centers[(rng() * centers.length) | 0]
    rows.push({
      id: `mem-${String(i).padStart(4, '0')}`,
      type,
      createdAtMs: CORPUS_BASE_MS + i * 1000,
      projectId: projectCycle[i % projectCycle.length],
      sessionId: type === 'episode' || type === 'digest' ? sessionCycle[i % sessionCycle.length] : null,
      // (semantic/procedural rows are sessionless, mirroring the real schema)
      embedding: perturb(center, rng, 0.35),
      forgottenAtMs: null,
      supersededBy: null,
    })
  }
  return { rows, rng }
}

/** Deep-copies the fixture rows so per-test mutation (forget/supersede/add) never leaks across tests. */
export function cloneRows(rows: FixtureRow[]): FixtureRow[] {
  return rows.map(r => ({ ...r }))
}
