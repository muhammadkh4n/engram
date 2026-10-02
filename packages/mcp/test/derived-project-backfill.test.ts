import { describe, it, expect } from 'vitest'
import type { PageCursor } from '../src/ingest/embed-backfill-lib.js'
import {
  SAMPLE_SIZE,
  formatDerivedReport,
  resolveDerivedProject,
  runDerivedProjectBackfill,
  type DerivationEdge,
  type DerivedKind,
  type DerivedProjectStore,
  type DerivedRow,
  type SourceKind,
  type SourceProject,
} from '../src/ingest/derived-project-backfill-lib.js'

type Kind = DerivedKind | SourceKind

interface StoredRow {
  id: string
  created_at: string
  project_id: string | null
  content: string
}

interface Edge {
  source_id: string
  source_type: Kind
  target_id: string
  target_type: Kind
  edge_type: string
}

/** In-memory stand-in for the three memory tables and memory_associations, with the PostgREST store's filters. */
class StubStore implements DerivedProjectStore {
  readonly tables: Record<Kind, StoredRow[]> = { episode: [], digest: [], semantic: [] }
  readonly edges: Edge[] = []
  readonly updateCalls: Array<{ kind: DerivedKind; ids: string[]; project: string }> = []
  private seq = 0

  add(kind: Kind, projectId: string | null): string {
    this.seq++
    const n = String(this.seq).padStart(4, '0')
    const id = `00000000-0000-0000-0000-00000000${n}`
    this.tables[kind].push({
      id,
      created_at: `2026-09-01T00:00:${n.slice(2)}Z`,
      project_id: projectId,
      content: `synthetic ${kind} body ${n}`,
    })
    return id
  }

  derive(sourceType: SourceKind, sourceIds: string[], targetType: DerivedKind, targetId: string): void {
    for (const s of sourceIds) {
      this.edges.push({
        source_id: s,
        source_type: sourceType,
        target_id: targetId,
        target_type: targetType,
        edge_type: 'derives_from',
      })
    }
  }

  project(kind: Kind, id: string): string | null {
    return this.tables[kind].find((r) => r.id === id)!.project_id
  }

  async fetchUntagged(kind: DerivedKind, cursor: PageCursor | null, pageSize: number): Promise<DerivedRow[]> {
    return this.tables[kind]
      .filter((r) => r.project_id === null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .filter(
        (r) =>
          !cursor ||
          r.created_at > cursor.createdAt ||
          (r.created_at === cursor.createdAt && r.id > cursor.id),
      )
      .slice(0, pageSize)
      .map(({ id, created_at }) => ({ id, created_at }))
  }

  async fetchDerivationEdges(
    sourceKind: SourceKind,
    targetKind: DerivedKind,
    targetIds: readonly string[],
  ): Promise<DerivationEdge[]> {
    return this.edges
      .filter(
        (e) =>
          e.edge_type === 'derives_from' &&
          e.source_type === sourceKind &&
          e.target_type === targetKind &&
          targetIds.includes(e.target_id),
      )
      .map(({ source_id, target_id }) => ({ source_id, target_id }))
  }

  async fetchProjects(kind: SourceKind, ids: readonly string[]): Promise<SourceProject[]> {
    return this.tables[kind]
      .filter((r) => ids.includes(r.id))
      .map(({ id, project_id }) => ({ id, project_id }))
  }

  async assignProject(kind: DerivedKind, ids: readonly string[], project: string): Promise<number> {
    this.updateCalls.push({ kind, ids: [...ids], project })
    let changed = 0
    for (const r of this.tables[kind]) {
      if (ids.includes(r.id) && r.project_id === null) {
        r.project_id = project
        changed++
      }
    }
    return changed
  }
}

const DRY = { apply: false, pageSize: 2, batchSize: 2 }
const APPLY = { apply: true, pageSize: 2, batchSize: 2 }

describe('resolveDerivedProject', () => {
  it('takes the project every tagged source holds, ignoring untagged sources', () => {
    expect(resolveDerivedProject(['engram', null, 'engram', '  '])).toEqual({
      target: 'engram',
      reason: 'unanimous',
    })
  })

  it('leaves mixed sources unresolved', () => {
    expect(resolveDerivedProject(['engram', 'ouija'])).toEqual({ target: null, reason: 'mixed' })
  })

  it('leaves rows with no tagged source, or no source at all, unresolved', () => {
    expect(resolveDerivedProject([null, null])).toEqual({ target: null, reason: 'no-source-tag' })
    expect(resolveDerivedProject([])).toEqual({ target: null, reason: 'no-source-tag' })
  })
})

/**
 * Digests: d1 unanimous engram (one untagged source), d2 mixed, d3 no tagged
 * source, d4 no edges, d5 already tagged ouija with engram sources.
 * Semantic: s1 from d1 (tagged only by this run) → engram; s2 from d1 + d5 →
 * mixed; s3 from d2 → no-source-tag; s4 already tagged with engram sources.
 */
function fixture() {
  const store = new StubStore()
  const e1 = store.add('episode', 'engram')
  const e2 = store.add('episode', 'engram')
  const e3 = store.add('episode', null)
  const e4 = store.add('episode', 'ouija')
  const d1 = store.add('digest', null)
  const d2 = store.add('digest', null)
  const d3 = store.add('digest', null)
  const d4 = store.add('digest', null)
  const d5 = store.add('digest', 'ouija')
  store.derive('episode', [e1, e2, e3], 'digest', d1)
  store.derive('episode', [e1], 'digest', d1)
  store.derive('episode', [e1, e4], 'digest', d2)
  store.derive('episode', [e3], 'digest', d3)
  store.derive('episode', [e1, e2], 'digest', d5)
  const s1 = store.add('semantic', null)
  const s2 = store.add('semantic', null)
  const s3 = store.add('semantic', null)
  const s4 = store.add('semantic', 'keep-me')
  store.derive('digest', [d1], 'semantic', s1)
  store.derive('digest', [d1, d5], 'semantic', s2)
  store.derive('digest', [d2], 'semantic', s3)
  store.derive('digest', [d1], 'semantic', s4)
  return { store, d1, d2, d3, d4, d5, s1, s2, s3, s4 }
}

describe('runDerivedProjectBackfill against a stubbed store', () => {
  it('dry run plans digests by unanimity and semantic facts over the planned digests, writing nothing', async () => {
    const { store, d1, d2, d3, d4, s1, s2, s3 } = fixture()
    const report = await runDerivedProjectBackfill(store, DRY)

    expect(report.digest.scanned).toBe(4)
    expect(report.digest.assignments).toEqual(new Map([['engram', [d1]]]))
    expect(report.digest.unresolved).toEqual(
      new Map([
        ['mixed', [d2]],
        ['no-source-tag', [d3, d4]],
      ]),
    )
    expect(report.semantic.scanned).toBe(3)
    expect(report.semantic.assignments).toEqual(new Map([['engram', [s1]]]))
    expect(report.semantic.unresolved).toEqual(
      new Map([
        ['mixed', [s2]],
        ['no-source-tag', [s3]],
      ]),
    )
    expect(store.updateCalls).toEqual([])
    expect(store.project('digest', d1)).toBeNull()
    expect(report.digest.updated.get('engram')).toBe(0)
  })

  it('apply writes the digest pass, then semantic facts from the backfilled digests', async () => {
    const { store, d1, d2, d3, d4, s1, s2, s3 } = fixture()
    const report = await runDerivedProjectBackfill(store, APPLY)

    expect(store.project('digest', d1)).toBe('engram')
    expect(store.project('semantic', s1)).toBe('engram')
    for (const id of [d2, d3, d4]) expect(store.project('digest', id)).toBeNull()
    for (const id of [s2, s3]) expect(store.project('semantic', id)).toBeNull()
    expect(report.digest.updated.get('engram')).toBe(1)
    expect(report.semantic.updated.get('engram')).toBe(1)
    expect(store.updateCalls.map((c) => c.kind)).toEqual(['digest', 'semantic'])
  })

  it('never rewrites a tagged row, even when its sources point elsewhere', async () => {
    const { store, d5, s4 } = fixture()
    await runDerivedProjectBackfill(store, APPLY)

    expect(store.project('digest', d5)).toBe('ouija')
    expect(store.project('semantic', s4)).toBe('keep-me')
    const written = store.updateCalls.flatMap((c) => c.ids)
    expect(written).not.toContain(d5)
    expect(written).not.toContain(s4)
  })

  it('is idempotent: a second apply scans only the rows left NULL and writes nothing', async () => {
    const { store } = fixture()
    await runDerivedProjectBackfill(store, APPLY)
    const callsAfterFirst = store.updateCalls.length

    const second = await runDerivedProjectBackfill(store, APPLY)
    expect(second.digest.scanned).toBe(3)
    expect(second.semantic.scanned).toBe(2)
    expect(second.digest.assignments.size).toBe(0)
    expect(second.semantic.assignments.size).toBe(0)
    expect(store.updateCalls.length).toBe(callsAfterFirst)
  })

  it('writes in batches of the given size', async () => {
    const store = new StubStore()
    const e = store.add('episode', 'engram')
    const digests = Array.from({ length: 5 }, () => store.add('digest', null))
    for (const d of digests) store.derive('episode', [e], 'digest', d)

    await runDerivedProjectBackfill(store, APPLY)
    expect(store.updateCalls.map((c) => c.ids.length)).toEqual([2, 2, 1])
    for (const d of digests) expect(store.project('digest', d)).toBe('engram')
  })

  it('reports counts and at most ten sample ids per bucket, never content', async () => {
    const store = new StubStore()
    const e = store.add('episode', 'engram')
    const digests = Array.from({ length: 12 }, () => store.add('digest', null))
    for (const d of digests) store.derive('episode', [e], 'digest', d)
    store.add('semantic', null)

    const report = await runDerivedProjectBackfill(store, DRY)
    const text = formatDerivedReport(report, false)

    expect(text).toContain('digest: scanned=12')
    expect(text).toContain('engram: 12')
    expect(text).toContain('semantic: scanned=1')
    expect(text).toContain('no-source-tag: 1')
    const sampleLine = text.split('\n').find((l) => l.includes('sample:'))!
    expect(sampleLine.split(',').length).toBe(SAMPLE_SIZE)
    expect(text).not.toContain('synthetic')
  })
})
