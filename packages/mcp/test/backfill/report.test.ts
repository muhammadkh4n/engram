import { describe, expect, it } from 'vitest'
import { parseBackfillCliArgs, UsageError } from '../../src/backfill/engram-backfill-cli.js'
import {
  buildReport,
  formatReport,
  rejectionReasons,
  sampleOf,
  sampleText,
  SAMPLE_TEXT_CHARS,
  type CaptureErrorRow,
  type ItemFacet,
  type OldRow,
  type OldTable,
  type ReportStore,
  type RunRow,
  type SamplePopulation,
  type SampleRow,
} from '../../src/backfill/report.js'

const NOW = new Date('2026-01-15T12:00:00Z')

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function facet(id: string, over: Partial<ItemFacet> = {}): ItemFacet {
  return {
    id,
    class: 'utterance',
    kind: 'user_prompt',
    speaker: 'mk',
    source_type: 'transcript',
    time_basis: null,
    project_id: 'tst-app',
    forgotten: false,
    ...over,
  }
}

function sample(id: string, over: Partial<SampleRow> = {}): SampleRow {
  return {
    id,
    content: `text of ${id}`,
    context: null,
    quote: null,
    occurred_at: '2026-01-02T00:00:00Z',
    project_id: 'tst-app',
    lineage: [],
    ...over,
  }
}

interface FakeData {
  facets: ItemFacet[]
  old: Record<OldTable, OldRow[]>
  procedural: number
  masked: string[]
  supersessions: Record<string, number>
  mk: Array<{ id: string; content: string }>
  invariants: Array<{ name: string; violations: number }>
  embedded: Record<string, number>
  runs: RunRow[]
  unprocessed: number
  errors: CaptureErrorRow[]
  populations: Record<SamplePopulation, string[]>
  rows: SampleRow[]
}

function emptyData(): FakeData {
  return {
    facets: [],
    old: { memory_episodes: [], memory_digests: [], memory_semantic: [] },
    procedural: 0,
    masked: [],
    supersessions: { linked: 0, not_later: 0, pending: 0, skipped: 0 },
    mk: [],
    invariants: [],
    embedded: {},
    runs: [],
    unprocessed: 0,
    errors: [],
    populations: { register_candidates: [], salvage_observations: [], legacy_utterances: [], history_utterances: [] },
    rows: [],
  }
}

async function* each<T>(rows: readonly T[]): AsyncIterable<T> {
  yield* rows
}

function fakeStore(data: FakeData): ReportStore & { reads: string[][] } {
  const reads: string[][] = []
  return {
    reads,
    itemFacets: () => each(data.facets),
    oldRows: (table) => each(data.old[table]),
    proceduralRows: async () => data.procedural,
    maskedItemIds: async () => new Set(data.masked),
    factSupersessions: async () => data.supersessions,
    mkUtterances: () => each(data.mk),
    invariantCounts: async () => data.invariants,
    embeddedByClass: async () => data.embedded,
    extractionRuns: () => each(data.runs),
    unprocessedEvents: async () => data.unprocessed,
    captureErrors: () => each(data.errors),
    sampleIds: async (p) => data.populations[p],
    itemsByIds: async (ids) => {
      reads.push([...ids])
      return data.rows.filter((r) => ids.includes(r.id))
    },
  }
}

describe('backfill report sections', () => {
  it('counts items by class, kind, source type and time basis, and per project', async () => {
    const data = emptyData()
    data.facets = [
      facet(uuid(1)),
      facet(uuid(2), { forgotten: true }),
      facet(uuid(3), { source_type: 'history' }),
      facet(uuid(4), { class: 'observation', kind: 'fact', speaker: 'assistant', source_type: 'extraction', time_basis: 'evidence', project_id: null }),
    ]
    const r = await buildReport(fakeStore(data), { seed: 1, now: NOW })
    expect(r.items).toEqual([
      { class: 'observation', kind: 'fact', source_type: 'extraction', time_basis: 'evidence', live: 1, forgotten: 0 },
      { class: 'utterance', kind: 'user_prompt', source_type: 'history', time_basis: null, live: 1, forgotten: 0 },
      { class: 'utterance', kind: 'user_prompt', source_type: 'transcript', time_basis: null, live: 1, forgotten: 1 },
    ])
    expect(r.projects).toEqual([
      { project_id: 'tst-app', live: 2, forgotten: 1 },
      { project_id: null, live: 1, forgotten: 0 },
    ])
    const md = formatReport(r)
    expect(md).toContain('| utterance | user_prompt | transcript | - | 1 | 1 |')
    expect(md).toContain('| (none) | 1 | 0 |')
  })

  it('reports legacy completeness per table, masked rows, unmapped raw values and fact supersessions', async () => {
    const data = emptyData()
    const legacy = (id: string, kind: string, over: Partial<ItemFacet> = {}): ItemFacet =>
      facet(id, { class: 'legacy', kind, speaker: 'system', source_type: 'legacy', time_basis: 'created_at', ...over })
    data.facets = [
      legacy(uuid(11), 'legacy_episode'),
      legacy(uuid(12), 'legacy_episode', { forgotten: true }),
      legacy(uuid(13), 'legacy_episode', { project_id: null }),
      legacy(uuid(21), 'legacy_digest'),
      legacy(uuid(31), 'legacy_fact', { project_id: null }),
    ]
    data.old = {
      memory_episodes: [
        { id: uuid(11), project_id: 'tst-app', forgotten: false },
        { id: uuid(12), project_id: 'tst-app', forgotten: true },
        { id: uuid(13), project_id: 'tst-gone', forgotten: false },
        { id: uuid(14), project_id: 'tst-app', forgotten: false },
      ],
      memory_digests: [{ id: uuid(21), project_id: null, forgotten: false }],
      memory_semantic: [{ id: uuid(31), project_id: 'tst-gone', forgotten: false }],
    }
    data.procedural = 0
    data.masked = [uuid(13), uuid(99)]
    data.supersessions = { linked: 3, not_later: 5, pending: 0, skipped: 1 }
    const r = await buildReport(fakeStore(data), { seed: 1, now: NOW })
    expect(r.legacy.tables).toEqual([
      { table: 'memory_episodes', kind: 'legacy_episode', old_rows: 4, old_forgotten: 1, items: 3, items_forgotten: 1, not_copied: 1, masked: 1 },
      { table: 'memory_digests', kind: 'legacy_digest', old_rows: 1, old_forgotten: 0, items: 1, items_forgotten: 0, not_copied: 0, masked: 0 },
      { table: 'memory_semantic', kind: 'legacy_fact', old_rows: 1, old_forgotten: 0, items: 1, items_forgotten: 0, not_copied: 0, masked: 0 },
    ])
    expect(r.unmapped).toEqual([{ raw: 'tst-gone', rows: 2 }])
    const md = formatReport(r)
    expect(md).toContain('| memory_episodes | legacy_episode | 4 | 1 | 3 | 1 | 1 | 1 |')
    expect(md).toContain('Fact supersessions: linked 3, not_later 5, pending 0, skipped 1')
    expect(md).toContain('| tst-gone | 2 |')
  })

  it('counts MK utterances the legacy text rule would exclude, with their reasons', async () => {
    const data = emptyData()
    data.mk = [
      { id: uuid(41), content: 'ship the fix after the tests pass' },
      { id: uuid(42), content: '<task-notification>\n<task-id>tst-task</task-id>\nstill running' },
      { id: uuid(43), content: 'Base directory for this skill: /home/tester/skills/tst' },
    ]
    const r = await buildReport(fakeStore(data), { seed: 1, now: NOW })
    expect(r.mk_words).toEqual({
      utterances: 3,
      excluded: 2,
      by_reason: { notification_cut: 1, skill_body: 1 },
      listed: [
        { id: uuid(42), reason: 'notification_cut' },
        { id: uuid(43), reason: 'skill_body' },
      ],
    })
    expect(formatReport(r)).toContain('2 of 3 MK utterances (must be 0).')

    const clean = emptyData()
    clean.mk = [{ id: uuid(41), content: 'ship it' }]
    expect(formatReport(await buildReport(fakeStore(clean), { seed: 1, now: NOW }))).toContain('0 of 1 MK utterances (must be 0).')
  })

  it('prints every invariant count and says whether all hold', async () => {
    const data = emptyData()
    data.invariants = [
      { name: 'quote_not_in_lineage', violations: 0 },
      { name: 'unregistered_project', violations: 2 },
    ]
    const md = formatReport(await buildReport(fakeStore(data), { seed: 1, now: NOW }))
    expect(md).toContain('1 invariant(s) violated.')
    expect(md).toContain('| unregistered_project | 2 |')
    data.invariants = [{ name: 'quote_not_in_lineage', violations: 0 }]
    expect(formatReport(await buildReport(fakeStore(data), { seed: 1, now: NOW }))).toContain('Every invariant holds.')
  })

  it('reports runs by version and status, rejection reasons of both run shapes, and embedded items', async () => {
    const data = emptyData()
    data.runs = [
      { extractor_version: 'tst-extract-v1', status: 'succeeded', stats: { rejected: [{ item: 'statement', index: 0, rule: 'quote_not_found' }] } },
      { extractor_version: 'tst-extract-v1', status: 'succeeded', stats: { rejected: [{ item: 'observation', index: 1, rule: 'quote_not_found' }] } },
      { extractor_version: 'tst-extract-v1', status: 'failed', stats: {} },
      { extractor_version: 'tst-salvage-v1', status: 'succeeded', stats: { rejected_by_reason: { duplicate: 2, schema: 1 } } },
    ]
    data.embedded = { utterance: 4, legacy: 0 }
    const r = await buildReport(fakeStore(data), { seed: 1, now: NOW })
    expect(r.extraction.runs).toEqual([
      { extractor_version: 'tst-extract-v1', status: 'failed', runs: 1 },
      { extractor_version: 'tst-extract-v1', status: 'succeeded', runs: 2 },
      { extractor_version: 'tst-salvage-v1', status: 'succeeded', runs: 1 },
    ])
    expect(r.extraction.rejected).toEqual([
      { extractor_version: 'tst-extract-v1', reason: 'quote_not_found', count: 2 },
      { extractor_version: 'tst-salvage-v1', reason: 'duplicate', count: 2 },
      { extractor_version: 'tst-salvage-v1', reason: 'schema', count: 1 },
    ])
    expect(formatReport(r)).toContain('| legacy | 0 |')
    expect(rejectionReasons(null)).toEqual({})
  })

  it('reports unprocessed capture events and errors grouped by type and their first 60 chars', async () => {
    const data = emptyData()
    const long = `materialize failed: ${'x'.repeat(80)}`
    data.unprocessed = 7
    data.errors = [
      { type: 'user_prompt', error: `${long}-one` },
      { type: 'user_prompt', error: `${long}-two` },
      { type: 'git_commit', error: 'repo | missing' },
    ]
    const r = await buildReport(fakeStore(data), { seed: 1, now: NOW })
    expect(r.capture).toEqual({
      unprocessed: 7,
      errors: [
        { type: 'user_prompt', error: long.slice(0, 60), count: 2 },
        { type: 'git_commit', error: 'repo | missing', count: 1 },
      ],
    })
    const md = formatReport(r)
    expect(md).toContain('Unprocessed: 7')
    expect(md).toContain('| git_commit | repo \\| missing | 1 |')
  })
})

describe('backfill report samples', () => {
  function sampled(): FakeData {
    const data = emptyData()
    const ids = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => uuid(from + i))
    data.populations = {
      register_candidates: ids(1000, 50),
      salvage_observations: ids(2000, 80),
      legacy_utterances: ids(3000, 5),
      history_utterances: [],
    }
    data.rows = [
      ...data.populations.register_candidates.map((id) => sample(id, { content: `quote ${id}`, context: `question ${id}` })),
      ...data.populations.salvage_observations.map((id, i) =>
        sample(id, { content: `claim ${id}`, quote: `quote of ${id}`, lineage: [uuid(9000 + i)] }),
      ),
      ...data.populations.salvage_observations.map((_, i) => sample(uuid(9000 + i), { content: `evidence ${i}` })),
      ...data.populations.legacy_utterances.map((id) => sample(id, { content: 'x'.repeat(SAMPLE_TEXT_CHARS + 10) })),
    ]
    return data
  }

  it('draws the sizes each population asks for, with quotes, questions and evidence lines', async () => {
    const r = await buildReport(fakeStore(sampled()), { seed: 7, now: NOW })
    expect(r.samples.register_candidates).toHaveLength(30)
    expect(r.samples.salvage_observations).toHaveLength(60)
    expect(r.samples.legacy_utterances).toHaveLength(5)
    expect(r.samples.history_utterances).toEqual([])
    expect(r.populations).toEqual({ register_candidates: 50, salvage_observations: 80, legacy_utterances: 5, history_utterances: 0 })
    for (const o of r.samples.salvage_observations) expect(o.evidence.map((e) => e.id)).toEqual(o.lineage)
    const md = formatReport(r)
    const candidate = r.samples.register_candidates[0]!
    expect(md).toContain(`   - quote: quote ${candidate.id}\n   - question: question ${candidate.id}\n`)
    expect(md).toContain('### Salvage observations (60 of 80)')
    expect(md).toMatch(/ {3}- evidence `[0-9a-f-]{36}` 2026-01-02: evidence \d+\n/)
    for (const o of r.samples.salvage_observations) {
      expect(md).toContain(`   - claim: claim ${o.id}\n   - quote: quote of ${o.id}\n   - evidence \``)
    }
    expect(md).toContain(`   - text: ${'x'.repeat(SAMPLE_TEXT_CHARS)} [cut]\n`)
    expect(md).toContain('### History utterances (0 of 0)\n\n_none_')
  })

  it('says plainly that no salvage observation is stored when there is none', async () => {
    const r = await buildReport(fakeStore(emptyData()), { seed: 7, now: NOW })
    expect(r.populations.salvage_observations).toBe(0)
    expect(formatReport(r)).toContain('### Salvage observations (0 of 0)\n\n_none_\n')
  })

  it('gives the same samples for the same seed, whatever order the store lists ids in', async () => {
    const a = await buildReport(fakeStore(sampled()), { seed: 7, now: NOW })
    const reversed = sampled()
    reversed.populations.register_candidates.reverse()
    reversed.populations.salvage_observations.reverse()
    const b = await buildReport(fakeStore(reversed), { seed: 7, now: NOW })
    expect(formatReport(b)).toBe(formatReport(a))
    const c = await buildReport(fakeStore(sampled()), { seed: 8, now: NOW })
    expect(c.samples.register_candidates.map((s) => s.id)).not.toEqual(a.samples.register_candidates.map((s) => s.id))
  })

  it('samples without replacement and never more than the population', () => {
    const ids = ['c', 'a', 'b', 'a']
    expect(sampleOf(ids, 10, 3).sort()).toEqual(['a', 'b', 'c'])
    expect(new Set(sampleOf(Array.from({ length: 100 }, (_, i) => `id-${i}`), 40, 3)).size).toBe(40)
    expect(sampleOf(ids, 2, 3)).toEqual(sampleOf([...ids].reverse(), 2, 3))
  })

  it('renders sample text on one line and cuts it at the sample length in code points', () => {
    expect(sampleText('a\n\n  b\tc')).toBe('a b c')
    expect(sampleText(null)).toBe('-')
    const emoji = '\u{1F600}'.repeat(SAMPLE_TEXT_CHARS + 1)
    expect(sampleText(emoji)).toBe(`${'\u{1F600}'.repeat(SAMPLE_TEXT_CHARS)} [cut]`)
  })
})

describe('report arguments', () => {
  it('needs --out and --sample-seed and takes no other command\'s flags', () => {
    expect(parseBackfillCliArgs(['report', '--out', '/tmp/r.md', '--sample-seed', '42'])).toMatchObject({
      command: 'report',
      out: '/tmp/r.md',
      sampleSeed: 42,
    })
    expect(() => parseBackfillCliArgs(['report', '--out', '/tmp/r.md'])).toThrow(UsageError)
    expect(() => parseBackfillCliArgs(['report', '--sample-seed', '1'])).toThrow(UsageError)
    expect(() => parseBackfillCliArgs(['report', '--out', '/tmp/r.md', '--sample-seed', '-1'])).toThrow(UsageError)
    expect(() => parseBackfillCliArgs(['report', '--out', '/tmp/r.md', '--sample-seed', '4294967296'])).toThrow(UsageError)
    expect(() => parseBackfillCliArgs(['report', '--out', '/tmp/r.md', '--sample-seed', '1', '--apply'])).toThrow('report does not take --apply')
    expect(() => parseBackfillCliArgs(['extract', '--sample-seed', '1'])).toThrow('extract does not take --sample-seed')
  })
})
