/**
 * Tests for the pure logic behind the NULL-embedding backfill CLI:
 * per-tier text-to-embed selection, batching, cost estimation, and the
 * keyset-pagination cursor/filter builder.
 *
 * The text-to-embed choice per tier is NOT arbitrary — it must match what
 * each table's generated `fts` tsvector already indexes (packages/postgrest/
 * schema.sql:761 `trigger_text || ' ' || procedure`, :790 `topic || ' ' ||
 * content`, :692 `summary`), so the vector channel and the lexical channel
 * of engram_hybrid_recall agree on what a memory "is about". See git commit
 * for the schema line citations backing this decision.
 */
import { describe, it, expect } from 'vitest'
import {
  TIER_CONFIGS,
  buildTextToEmbed,
  textToEmbedForSemantic,
  textToEmbedForDigest,
  textToEmbedForProcedural,
  chunk,
  estimateTokens,
  estimateCostUsd,
  nextCursor,
  buildKeysetFilter,
  applyBatch,
  type SemanticEmbedRow,
  type DigestEmbedRow,
  type ProceduralEmbedRow,
} from '../src/ingest/embed-backfill-lib.js'

describe('textToEmbedForSemantic', () => {
  it('joins topic and content with a space, matching the fts generated column', () => {
    const row: SemanticEmbedRow = { id: '1', topic: 'deploy process', content: 'uses blue-green', created_at: 't' }
    expect(textToEmbedForSemantic(row)).toBe('deploy process uses blue-green')
  })

  it('trims when topic is empty so no leading space leaks in', () => {
    const row: SemanticEmbedRow = { id: '1', topic: '', content: 'uses blue-green', created_at: 't' }
    expect(textToEmbedForSemantic(row)).toBe('uses blue-green')
  })
})

describe('textToEmbedForDigest', () => {
  it('embeds the summary verbatim, matching the fts generated column', () => {
    const row: DigestEmbedRow = { id: '1', summary: 'Discussed vector path fixes.', created_at: 't' }
    expect(textToEmbedForDigest(row)).toBe('Discussed vector path fixes.')
  })
})

describe('textToEmbedForProcedural', () => {
  it('joins trigger_text and procedure with a space, matching the fts generated column', () => {
    const row: ProceduralEmbedRow = { id: '1', trigger_text: 'on deploy', procedure: 'run migrations first', created_at: 't' }
    expect(textToEmbedForProcedural(row)).toBe('on deploy run migrations first')
  })

  it('trims when trigger_text is empty', () => {
    const row: ProceduralEmbedRow = { id: '1', trigger_text: '', procedure: 'run migrations first', created_at: 't' }
    expect(textToEmbedForProcedural(row)).toBe('run migrations first')
  })
})

describe('buildTextToEmbed (tier dispatcher)', () => {
  it('dispatches semantic rows to textToEmbedForSemantic', () => {
    const row: SemanticEmbedRow = { id: '1', topic: 'topic', content: 'content', created_at: 't' }
    expect(buildTextToEmbed('semantic', row)).toBe('topic content')
  })

  it('dispatches digests rows to textToEmbedForDigest', () => {
    const row: DigestEmbedRow = { id: '1', summary: 'summary text', created_at: 't' }
    expect(buildTextToEmbed('digests', row)).toBe('summary text')
  })

  it('dispatches procedural rows to textToEmbedForProcedural', () => {
    const row: ProceduralEmbedRow = { id: '1', trigger_text: 'trigger', procedure: 'procedure', created_at: 't' }
    expect(buildTextToEmbed('procedural', row)).toBe('trigger procedure')
  })
})

describe('TIER_CONFIGS', () => {
  it('maps semantic and procedural to tables with forgotten_at support', () => {
    expect(TIER_CONFIGS.semantic).toEqual({ tier: 'semantic', table: 'memory_semantic', hasForgottenAt: true })
    expect(TIER_CONFIGS.procedural).toEqual({ tier: 'procedural', table: 'memory_procedural', hasForgottenAt: true })
  })

  it('maps digests to memory_digests WITHOUT forgotten_at (schema has no such column)', () => {
    expect(TIER_CONFIGS.digests).toEqual({ tier: 'digests', table: 'memory_digests', hasForgottenAt: false })
  })
})

describe('chunk', () => {
  it('splits an array into fixed-size groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns a single chunk when size >= length', () => {
    expect(chunk([1, 2, 3], 64)).toEqual([[1, 2, 3]])
  })

  it('returns an empty array for empty input', () => {
    expect(chunk([], 64)).toEqual([])
  })

  it('throws on a non-positive chunk size', () => {
    expect(() => chunk([1, 2], 0)).toThrow()
    expect(() => chunk([1, 2], -1)).toThrow()
  })
})

describe('estimateTokens / estimateCostUsd', () => {
  it('estimates tokens as chars / 4', () => {
    expect(estimateTokens(400)).toBe(100)
  })

  it('estimates cost at $0.02 per 1M tokens (text-embedding-3-small)', () => {
    // 1,000,000 tokens => 4,000,000 chars => $0.02
    expect(estimateCostUsd(4_000_000)).toBeCloseTo(0.02, 10)
  })

  it('returns 0 cost for 0 chars', () => {
    expect(estimateCostUsd(0)).toBe(0)
  })
})

describe('nextCursor', () => {
  it('returns null for an empty page (no more rows)', () => {
    expect(nextCursor([])).toBeNull()
  })

  it('returns the (created_at, id) of the last row in the page', () => {
    const rows = [
      { id: 'a', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', created_at: '2026-01-02T00:00:00Z' },
    ]
    expect(nextCursor(rows)).toEqual({ createdAt: '2026-01-02T00:00:00Z', id: 'b' })
  })
})

describe('buildKeysetFilter', () => {
  it('returns null for a null cursor (first page)', () => {
    expect(buildKeysetFilter(null)).toBeNull()
  })

  it('builds a PostgREST .or() filter that resumes strictly after the cursor', () => {
    const filter = buildKeysetFilter({ createdAt: '2026-01-02T00:00:00Z', id: 'b' })
    expect(filter).toBe(
      'created_at.gt.2026-01-02T00:00:00Z,and(created_at.eq.2026-01-02T00:00:00Z,id.gt.b)',
    )
  })
})

describe('applyBatch', () => {
  interface FakeRow {
    id: string
  }

  it('writes each embedding to its matching row by index and reports full success', async () => {
    const batch: FakeRow[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const embeddings = [[0.1], [0.2], [0.3]]
    const calls: Array<{ id: string; embedding: number[] }> = []
    const updateRow = async (id: string, embedding: number[]): Promise<void> => {
      calls.push({ id, embedding })
    }

    const result = await applyBatch(batch, embeddings, updateRow)

    expect(result).toEqual({ updated: 3, errors: 0 })
    expect(calls).toEqual([
      { id: 'a', embedding: [0.1] },
      { id: 'b', embedding: [0.2] },
      { id: 'c', embedding: [0.3] },
    ])
  })

  it('throws on a batch/embeddings length mismatch without writing any row', async () => {
    const batch: FakeRow[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const embeddings = [[0.1], [0.2]] // one short of batch.length
    const calls: string[] = []
    const updateRow = async (id: string): Promise<void> => {
      calls.push(id)
    }

    await expect(applyBatch(batch, embeddings, updateRow)).rejects.toThrow(/length/i)
    expect(calls).toEqual([])
  })

  it('keeps attempting remaining rows after a mid-batch update failure, counting only the failed row as an error', async () => {
    const batch: FakeRow[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const embeddings = [[0.1], [0.2], [0.3]]
    const calls: string[] = []
    const updateRow = async (id: string): Promise<void> => {
      calls.push(id)
      if (id === 'b') throw new Error('PATCH failed for b')
    }

    const result = await applyBatch(batch, embeddings, updateRow)

    // a and c must still be attempted (and counted as updated) even though b failed —
    // an already-paid embedding for a later row must not be discarded by an earlier
    // or later row's independent write failure. updated + errors === batch.length,
    // never double-counting the two rows that actually succeeded as errors too.
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(result).toEqual({ updated: 2, errors: 1 })
  })

  it('invokes onRowError with the failing id and the thrown error, without affecting other rows', async () => {
    const batch: FakeRow[] = [{ id: 'a' }, { id: 'b' }]
    const embeddings = [[0.1], [0.2]]
    const failure = new Error('boom')
    const updateRow = async (id: string): Promise<void> => {
      if (id === 'a') throw failure
    }
    const seenErrors: Array<{ id: string; err: unknown }> = []

    const result = await applyBatch(batch, embeddings, updateRow, (id, err) => {
      seenErrors.push({ id, err })
    })

    expect(result).toEqual({ updated: 1, errors: 1 })
    expect(seenErrors).toEqual([{ id: 'a', err: failure }])
  })

  it('returns all-zero for an empty batch', async () => {
    const updateRow = async (): Promise<void> => {
      throw new Error('should never be called')
    }
    const result = await applyBatch([] as FakeRow[], [], updateRow)
    expect(result).toEqual({ updated: 0, errors: 0 })
  })
})
