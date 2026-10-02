import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PageCursor } from '../src/ingest/embed-backfill-lib.js'
import {
  MERGE_SIM_FLOOR,
  ROLLBACK_CSV_HEADER,
  compareCanonical,
  contentReport,
  dedupJson,
  dedupSummary,
  neighbourPairs,
  openRollbackCsv,
  parseEmbedding,
  postgrestDedupStore,
  runSemanticDedup,
  unionFind,
  unitVector,
  type CanonicalCandidate,
  type DerivationEdge,
  type LiveSemanticRow,
  type RollbackEntry,
  type SemanticContent,
  type SemanticDedupOptions,
  type SemanticDedupStore,
} from '../src/ingest/semantic-dedup-lib.js'
import { fakePostgrest } from './fake-postgrest.js'

interface StoredRow extends LiveSemanticRow {
  topic: string
  content: string
  superseded_by: string | null
  forgotten_at: string | null
}

/** In-memory stand-in for memory_semantic and memory_associations, with the PostgREST store's filters. */
class StubStore implements SemanticDedupStore {
  readonly rows: StoredRow[] = []
  readonly edges: Array<DerivationEdge & { edge_type: string; target_type: string }> = []
  readonly calls: string[] = []
  /** rows returned per fetchLive at most, as a server max-rows cap would */
  cap = Infinity
  private seq = 0

  add(embedding: number[] | null, over: Partial<StoredRow> = {}): string {
    this.seq++
    const n = String(this.seq).padStart(4, '0')
    const id = `00000000-0000-0000-0000-00000000${n}`
    this.rows.push({
      id,
      project_id: null,
      confidence: 0.8,
      access_count: 47,
      shown_count: 3,
      created_at: `2026-09-01T00:00:${n.slice(2)}Z`,
      embedding,
      topic: 'decision',
      content: `synthetic fact body ${n}`,
      superseded_by: null,
      forgotten_at: null,
      ...over,
    })
    return id
  }

  derive(target: string, count: number): void {
    for (let i = 0; i < count; i++) {
      this.edges.push({ source_id: `${target}-src-${i}`, target_id: target, edge_type: 'derives_from', target_type: 'semantic' })
    }
  }

  row(id: string): StoredRow {
    return this.rows.find((r) => r.id === id)!
  }

  async fetchLive(cursor: PageCursor | null, pageSize: number): Promise<LiveSemanticRow[]> {
    this.calls.push('fetchLive')
    return this.rows
      .filter((r) => r.forgotten_at === null && r.superseded_by === null && r.embedding !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .filter((r) => !cursor || r.created_at > cursor.createdAt || (r.created_at === cursor.createdAt && r.id > cursor.id))
      .slice(0, Math.min(pageSize, this.cap))
      .map(({ id, project_id, confidence, access_count, shown_count, created_at, embedding }) => ({
        id,
        project_id,
        confidence,
        access_count,
        shown_count,
        created_at,
        embedding,
      }))
  }

  async fetchDerivationEdges(targetIds: readonly string[]): Promise<DerivationEdge[]> {
    this.calls.push('fetchDerivationEdges')
    return this.edges
      .filter((e) => e.edge_type === 'derives_from' && e.target_type === 'semantic' && targetIds.includes(e.target_id))
      .map(({ source_id, target_id }) => ({ source_id, target_id }))
  }

  async fetchContent(ids: readonly string[]): Promise<SemanticContent[]> {
    this.calls.push('fetchContent')
    return this.rows.filter((r) => ids.includes(r.id)).map(({ id, topic, content }) => ({ id, topic, content }))
  }

  async markSuperseded(ids: readonly string[], canonical: string): Promise<string[]> {
    this.calls.push('markSuperseded')
    const changed: string[] = []
    for (const r of this.rows) {
      if (ids.includes(r.id) && r.id !== canonical && r.superseded_by === null && r.forgotten_at === null) {
        r.superseded_by = canonical
        changed.push(r.id)
      }
    }
    return changed
  }
}

/** A unit vector at cosine `sim` to [1, 0, 0], on the +y (sign 1) or -y (sign -1) side. */
function at(sim: number, sign = 1): number[] {
  return [sim, sign * Math.sqrt(1 - sim * sim), 0]
}

const E1 = [1, 0, 0]
const E3 = [0, 0, 1]

function opts(over: Partial<SemanticDedupOptions> = {}): SemanticDedupOptions {
  return { reportSim: 0.88, topK: 10, mergeSim: null, apply: false, pageSize: 2, batchSize: 2, ...over }
}

function clusterIds(report: Awaited<ReturnType<typeof runSemanticDedup>>): string[][] {
  return report.clusters.map((c) => c.members.map((m) => m.id).sort()).sort((a, b) => a[0]!.localeCompare(b[0]!))
}

describe('clustering', () => {
  it('joins rows at or above the report similarity transitively and leaves distant rows out', async () => {
    const store = new StubStore()
    const a = store.add(E1)
    const b = store.add(at(0.97))
    const c = store.add(at(0.97, -1)) // 0.8818 to b, 0.97 to a
    const far = store.add(E3)
    const d = store.add([0, 0.6, 0.8])
    const e = store.add([0, 0.5, 0.866])

    const report = await runSemanticDedup(store, opts())

    expect(report.scanned).toBe(6)
    expect(clusterIds(report)).toEqual([[a, b, c].sort(), [d, e].sort()])
    expect(report.clusters.flatMap((cl) => cl.members.map((m) => m.id))).not.toContain(far)
    const abc = report.clusters.find((cl) => cl.members.length === 3)!
    expect(abc.min_pair_sim).toBeCloseTo(0.8818, 3)
    expect(abc.members.every((m) => m.access_count === 47 && m.shown_count === 3)).toBe(true)
  })

  it('keeps only each row\'s top-k neighbours, as undirected pairs', () => {
    const deg = (d: number) => [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180), 0]
    const units = [deg(0), deg(5), deg(15), deg(40)].map((v) => unitVector(v)!)
    const pairs = neighbourPairs(units, 1, 0.88).map(([x, y]) => `${x}-${y}`).sort()
    // 0 and 1 are each other's nearest; 2's nearest is 1, 3's is 2. 0-2 (cos 0.966)
    // clears the threshold but is in neither row's top 1.
    expect(pairs).toEqual(['0-1', '1-2', '2-3'])
  })

  it('union-find groups chained pairs and drops singletons', () => {
    expect(unionFind(6, [[0, 1], [1, 2], [4, 5]])).toEqual([[0, 1, 2], [4, 5]])
  })

  it('skips rows with an unusable vector and pages through every live row', async () => {
    const store = new StubStore()
    store.add(E1)
    store.add(E1)
    store.add([0, 0, 0])
    store.add(E1, { superseded_by: 'x' })
    store.add(E1, { forgotten_at: '2026-09-02T00:00:00Z' })
    store.add(null)

    const report = await runSemanticDedup(store, opts({ pageSize: 1 }))

    expect(report.scanned).toBe(3)
    expect(report.skipped_no_vector).toBe(1)
    expect(report.clusters).toHaveLength(1)
  })
})

describe('canonical choice', () => {
  const base: CanonicalCandidate = { id: 'b', confidence: 0.8, created_at: '2026-09-01T00:00:00Z', derives_from_sources: 1 }

  it('orders by confidence, then derives_from sources, then newest, then id', () => {
    const sortIds = (rows: CanonicalCandidate[]) => [...rows].sort(compareCanonical).map((r) => r.id)
    expect(sortIds([base, { ...base, id: 'c', confidence: 0.9 }])).toEqual(['c', 'b'])
    expect(sortIds([base, { ...base, id: 'c', derives_from_sources: 3 }])).toEqual(['c', 'b'])
    expect(sortIds([base, { ...base, id: 'c', created_at: '2026-09-05T00:00:00Z' }])).toEqual(['c', 'b'])
    expect(sortIds([{ ...base, id: 'c' }, base])).toEqual(['b', 'c'])
    expect(sortIds([{ ...base, confidence: null }, { ...base, id: 'c', confidence: 0.1 }])).toEqual(['c', 'b'])
  })

  it('reads the source counts from derives_from edges and puts the canonical row first', async () => {
    const store = new StubStore()
    const older = store.add(E1, { confidence: 0.9 })
    const most = store.add(at(0.99), { confidence: 0.9 })
    const newest = store.add(at(0.98), { confidence: 0.9 })
    const lowConf = store.add(at(0.995), { confidence: 0.5 })
    store.derive(most, 3)
    store.derive(most, 0)
    store.derive(newest, 1)
    store.derive(older, 1)
    store.derive(lowConf, 9)

    const report = await runSemanticDedup(store, opts())

    const [cluster] = report.clusters
    expect(cluster!.canonical).toBe(most)
    expect(cluster!.members[0]!.id).toBe(most)
    expect(cluster!.members[0]!.derives_from_sources).toBe(3)
    expect(cluster!.members[0]!.sim_to_canonical).toBe(1)
    expect([...cluster!.members].slice(1).map((m) => m.id).sort()).toEqual([older, newest, lowConf].sort())
  })
})

describe('project isolation', () => {
  it('pairs rows only within one project, and NULL only with NULL', async () => {
    const store = new StubStore()
    const a1 = store.add(E1, { project_id: 'engram' })
    const a2 = store.add(E1, { project_id: 'engram' })
    store.add(E1, { project_id: 'ouija' })
    const n1 = store.add(E1)
    const n2 = store.add(E1)

    const report = await runSemanticDedup(store, opts())

    expect(clusterIds(report)).toEqual([[a1, a2], [n1, n2]])
    expect(report.clusters.map((c) => c.project_id).sort()).toEqual(['engram', null].sort())
  })
})

describe('merge similarity floor', () => {
  it('refuses a merge similarity below the floor before touching the store', async () => {
    const store = new StubStore()
    store.add(E1)
    store.add(E1)
    const rollback = { write: () => undefined }

    await expect(runSemanticDedup(store, opts({ apply: true, mergeSim: 0.94, rollback }))).rejects.toThrow(RangeError)
    await expect(runSemanticDedup(store, opts({ mergeSim: 0.949 }))).rejects.toThrow(/merge similarity/)
    await expect(runSemanticDedup(store, opts({ mergeSim: 1.01 }))).rejects.toThrow(RangeError)
    expect(store.calls).toEqual([])
    expect(MERGE_SIM_FLOOR).toBe(0.95)
  })

  it('refuses apply without a merge similarity or a rollback sink', async () => {
    const store = new StubStore()
    await expect(runSemanticDedup(store, opts({ apply: true, rollback: { write: () => undefined } }))).rejects.toThrow(
      /requires a merge similarity/,
    )
    await expect(runSemanticDedup(store, opts({ apply: true, mergeSim: 0.97 }))).rejects.toThrow(/rollback/)
    expect(store.calls).toEqual([])
  })
})

describe('dry run', () => {
  it('flags mergeable clusters but writes nothing', async () => {
    const store = new StubStore()
    store.add(E1)
    store.add(at(0.99))
    store.add(E3)
    store.add([0, 0.3, 0.954]) // 0.954 to E3 after normalising: below a 0.97 merge

    const report = await runSemanticDedup(store, opts({ mergeSim: 0.97 }))

    expect(report.clusters.map((c) => c.mergeable).sort()).toEqual([false, true])
    expect(report.superseded).toEqual([])
    expect(store.calls).not.toContain('markSuperseded')
    expect(store.rows.every((r) => r.superseded_by === null)).toBe(true)
    expect(dedupSummary(report)).toContain('mergeable at 0.97: clusters=1 rows_to_supersede=1')
  })

  it('keeps content out of the stdout document and puts it only in the content report', async () => {
    const store = new StubStore()
    const a = store.add(E1)
    store.add(at(0.99))

    const report = await runSemanticDedup(store, opts())
    const stdout = JSON.stringify(dedupJson(report))
    const contents = await store.fetchContent(report.clusters[0]!.members.map((m) => m.id))
    const file = JSON.stringify(contentReport(report, contents))

    expect(stdout).not.toContain('synthetic fact body')
    expect(stdout).toContain(a)
    expect(file).toContain(store.row(a).content)
  })
})

describe('apply and rollback CSV', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'semantic-dedup-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function readCsv(path: string): { header: string; entries: RollbackEntry[] } {
    const [header, ...lines] = readFileSync(path, 'utf8').trimEnd().split('\n')
    return {
      header: header!,
      entries: lines.map((l) => {
        const [row, canonical, sim] = l.split(',')
        return { row: row!, canonical: canonical!, sim: Number(sim) }
      }),
    }
  }

  it('supersedes only clusters whose every pair clears S, deletes nothing, and records every written row', async () => {
    const store = new StubStore()
    const canon = store.add(E1, { confidence: 0.95 })
    const dupIds = [store.add(at(0.99)), store.add(at(0.985, -1)), store.add([0.98, 0, Math.sqrt(1 - 0.98 * 0.98)])]
    // A loose cluster: l2 and l3 are 0.97 to l1 but only 0.8818 to each other.
    const l1 = store.add([0, 1, 0], { project_id: 'loose' })
    const l2 = store.add([0, 0.97, Math.sqrt(1 - 0.97 * 0.97)], { project_id: 'loose' })
    const l3 = store.add([0, 0.97, -Math.sqrt(1 - 0.97 * 0.97)], { project_id: 'loose' })
    const before = store.rows.length
    const path = join(dir, 'rollback.csv')
    const sink = openRollbackCsv(path)

    const report = await runSemanticDedup(store, opts({ apply: true, mergeSim: 0.95, rollback: sink, batchSize: 2 }))
    sink.close()

    expect(store.rows).toHaveLength(before)
    const superseded = store.rows.filter((r) => r.superseded_by !== null)
    expect(superseded.map((r) => r.id).sort()).toEqual([...dupIds].sort())
    expect(superseded.every((r) => r.superseded_by === canon)).toBe(true)
    expect([l1, l2, l3].every((id) => store.row(id).superseded_by === null)).toBe(true)

    const csv = readCsv(path)
    expect(csv.header).toBe(ROLLBACK_CSV_HEADER)
    expect(csv.entries.map((e) => e.row).sort()).toEqual(superseded.map((r) => r.id).sort())
    expect(csv.entries.every((e) => e.canonical === store.row(e.row).superseded_by)).toBe(true)
    for (const e of csv.entries) {
      const cos = unitVector(store.row(e.row).embedding)!.reduce((s, x, i) => s + x * unitVector(E1)![i]!, 0)
      expect(e.sim).toBeCloseTo(cos, 10)
      expect(e.sim).toBeGreaterThanOrEqual(0.95)
    }
    expect(report.superseded).toHaveLength(3)

    // Rolling back from the CSV restores every row.
    for (const e of csv.entries) store.row(e.row).superseded_by = null
    expect(store.rows.every((r) => r.superseded_by === null)).toBe(true)
  })

  it('records only rows the store actually changed', async () => {
    const store = new StubStore()
    store.add(E1, { confidence: 0.9 })
    const raced = store.add(at(0.99))
    const kept = store.add(at(0.99, -1))
    const original = store.markSuperseded.bind(store)
    store.markSuperseded = async (ids, canonical) => {
      store.row(raced).forgotten_at = '2026-09-03T00:00:00Z'
      return original(ids, canonical)
    }
    const entries: RollbackEntry[] = []

    await runSemanticDedup(store, opts({ apply: true, mergeSim: 0.95, rollback: { write: (e) => entries.push(...e) } }))

    expect(entries.map((e) => e.row)).toEqual([kept])
  })

  it('never overwrites an existing rollback file', () => {
    const path = join(dir, 'rollback.csv')
    openRollbackCsv(path).close()
    expect(() => openRollbackCsv(path)).toThrow(/EEXIST/)
  })

  it('a repeat run finds nothing left to merge', async () => {
    const store = new StubStore()
    store.add(E1)
    store.add(at(0.99))
    const sink = { write: () => undefined }

    await runSemanticDedup(store, opts({ apply: true, mergeSim: 0.95, rollback: sink }))
    const again = await runSemanticDedup(store, opts({ apply: true, mergeSim: 0.95, rollback: sink }))

    expect(again.clusters).toEqual([])
    expect(again.superseded).toEqual([])
  })
})

describe('parseEmbedding', () => {
  it('reads the pgvector text form and rejects anything else', () => {
    expect(parseEmbedding('[0.5,-1,2e-3]')).toEqual([0.5, -1, 0.002])
    expect(parseEmbedding([1, 2])).toEqual([1, 2])
    expect(parseEmbedding('[1,"x"]')).toBeNull()
    expect(parseEmbedding('not a vector')).toBeNull()
    expect(parseEmbedding(null)).toBeNull()
  })
})

describe('paging under a server row cap', () => {
  it('a store capped below the page size still yields every live row', async () => {
    const store = new StubStore()
    for (let i = 0; i < 7; i++) store.add(E1)
    store.cap = 2

    const report = await runSemanticDedup(store, opts({ pageSize: 5 }))

    expect(report.scanned).toBe(7)
    expect(report.clusters).toHaveLength(1)
    expect(report.clusters[0]!.members).toHaveLength(7)
  })

  it('the PostgREST store reads every derives_from edge when the server caps responses below the page size', async () => {
    const target = '00000000-0000-0000-0000-0000000000aa'
    const edges = Array.from({ length: 7 }, (_, i) => ({
      id: `e${i}`,
      source_id: `digest-${i}`,
      target_id: target,
      edge_type: 'derives_from',
      target_type: 'semantic',
    }))
    const { client } = fakePostgrest({ memory_associations: edges }, 2)

    const read = await postgrestDedupStore(client, 5).fetchDerivationEdges([target])

    expect(read.map((e) => e.source_id).sort()).toEqual(edges.map((e) => e.source_id).sort())
  })
})

describe('supersession reaches tombstone readers', () => {
  it('every markSuperseded update payload carries updated_at as an ISO timestamp', async () => {
    const canonical = '00000000-0000-0000-0000-000000000001'
    const others = ['00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003']
    const rows = [canonical, ...others].map((id) => ({ id, superseded_by: null, forgotten_at: null, updated_at: '2026-01-01T00:00:00.000Z' }))
    const { client, requests } = fakePostgrest({ memory_semantic: rows }, 1000)
    const store = postgrestDedupStore(client, 500)

    const changed = [...(await store.markSuperseded([others[0]!], canonical)), ...(await store.markSuperseded([others[1]!], canonical))]

    const patches = requests.filter((r) => r.method === 'PATCH')
    expect(changed.sort()).toEqual([...others].sort())
    expect(patches).toHaveLength(2)
    for (const p of patches) {
      const body = p.body as { superseded_by: string; updated_at: string }
      expect(body.superseded_by).toBe(canonical)
      expect(new Date(body.updated_at).toISOString()).toBe(body.updated_at)
      expect(Date.parse(body.updated_at)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'))
    }
  })
})

describe('newest tie-break', () => {
  it('compares instants, so a fractional second later in the same second is newer', () => {
    const whole: CanonicalCandidate = { id: 'a', confidence: 0.8, created_at: '2026-09-01T00:00:01Z', derives_from_sources: 1 }
    const fractional: CanonicalCandidate = { ...whole, id: 'b', created_at: '2026-09-01T00:00:01.5Z' }

    expect([whole, fractional].sort(compareCanonical).map((r) => r.id)).toEqual(['b', 'a'])
    expect([fractional, whole].sort(compareCanonical).map((r) => r.id)).toEqual(['b', 'a'])
  })
})
