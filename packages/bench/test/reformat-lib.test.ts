import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  assemble,
  estimateTokens,
  renderRecallPayload,
  DEFAULT_RECALL_OUTPUT_POLICY,
  type RecallOutputPolicy,
  type RenderedPayload,
  type RetrievedMemory,
} from '@engram-mem/core'
import { goldIdsInContext, recordPayloadItems } from '../src/longmemeval/forensics/context-modes.js'
import {
  armPolicy,
  assertReformattableSweep,
  parseReformatArgs,
  rebuildRendered,
  reformatRow,
  reformatSweep,
  type ReformatRow,
  type ReformatSweep,
} from '../src/longmemeval/forensics/reformat-lib.js'

type GraphContext = NonNullable<Parameters<typeof renderRecallPayload>[2]>

function mem(id: string, session: string, content: string, role = 'user', type: RetrievedMemory['type'] = 'episode'): RetrievedMemory {
  return {
    id,
    type,
    content,
    relevance: 0.9,
    source: 'recall',
    metadata: { role, occurredAt: '2023-05-20T10:00:00Z', lmeSessionId: session },
  }
}

interface Stub {
  memories: RetrievedMemory[]
  associations: RetrievedMemory[]
  context: GraphContext | null
  summaries: string[]
}

const ALL_SECTIONS: Stub = {
  memories: [
    mem('m1', 's_a', 'I moved the herb planters to the balcony last weekend.'),
    mem('m2', 's_b', 'Basil needs six hours of sun; the balcony gets about five.', 'assistant'),
  ],
  associations: [mem('r1', 's_c', 'Gardening: balcony planters, basil, watering schedule.', 'user', 'digest')],
  context: {
    coreMemories: [],
    speakers: [{ name: 'Dana', role: 'user' }],
    emotionalContext: [{ label: 'curious', intensity: 0.6 }],
    dominantIntent: 'plan',
    temporalContext: [{ session: 'weekend', timeOfDay: 'morning', date: '2023-05-20' }],
    relatedTopics: ['gardening', 'balcony'],
    faintAssociations: [mem('f1', 's_d', 'The hardware store had terracotta pots on sale.')],
  } as unknown as GraphContext,
  summaries: ['Home gardening: container plants on a south-facing balcony.'],
}

const HUGE_FIRST: Stub = {
  memories: [
    mem('h1', 's_a', `Trip log: ${'we walked the old town and logged every stop, '.repeat(90)}end.`),
    mem('h2', 's_b', 'The second museum closes at five on Sundays.'),
  ],
  associations: [mem('h3', 's_c', 'Travel: museum hours and walking routes.', 'user', 'digest')],
  context: null,
  summaries: [],
}

const NO_RELATED: Stub = {
  memories: [
    mem('n1', 's_a', 'My sister is visiting on the 14th.'),
    mem('n2', 's_b', 'We booked the Italian place for her birthday dinner.'),
    mem('n3', 's_c', 'She is allergic to shellfish.'),
  ],
  associations: [],
  context: null,
  summaries: [],
}

function renderStub(stub: Stub): RenderedPayload {
  return renderRecallPayload(stub.memories, stub.associations, stub.context, stub.summaries)
}

/** A formatted sweep row as recall-sweep writes it for this stub recall. */
function fixtureRow(qid: string, stub: Stub, gold: string[]): ReformatRow {
  const { text, payload } = assemble(renderStub(stub))
  const result = {
    memories: stub.memories,
    associations: stub.associations,
    faintAssociations: stub.context?.faintAssociations ?? [],
    formatted: text,
    estimatedTokens: estimateTokens(text),
    payload,
  }
  return {
    question_id: qid,
    question_type: 'multi-session',
    question: 'What did I plan?',
    gold_session_ids: gold,
    retrieved_session_ids: ['s_b', 's_a', 's_c'],
    retrieved_count: 3,
    recall_at_k: { 1: false, 5: true },
    relevance_top: [0.93, 0.81, 0.4],
    formatted: text,
    context_chars: text.length,
    context_items: stub.memories.length,
    gold_ids_in_context: goldIdsInContext(result, gold),
    payload_items: recordPayloadItems(result, (t) => t),
    context_tokens: estimateTokens(text),
    truncated: payload.truncated,
  }
}

const FIXTURES: Array<[string, Stub, ReformatRow]> = [
  ['all sections', ALL_SECTIONS, fixtureRow('q-all', ALL_SECTIONS, ['s_d', 's_a'])],
  ['huge first item', HUGE_FIRST, fixtureRow('q-huge', HUGE_FIRST, ['s_c'])],
  ['no related items', NO_RELATED, fixtureRow('q-norel', NO_RELATED, ['s_c', 's_x'])],
]

const PAYLOAD_KEYS = new Set([
  'formatted', 'payload_items', 'context_chars', 'context_items', 'context_tokens', 'truncated', 'gold_ids_in_context',
])

function withoutPayloadFields(row: ReformatRow): string {
  return JSON.stringify(Object.entries(row).filter(([k]) => !PAYLOAD_KEYS.has(k)))
}

describe('reformatRow invariant', () => {
  it.each(FIXTURES)('reproduces the recorded row exactly under the empty policy (%s)', (_name, _stub, row) => {
    const out = reformatRow(row, DEFAULT_RECALL_OUTPUT_POLICY)
    expect(out.formatted).toBe(row.formatted)
    expect(JSON.stringify(out)).toBe(JSON.stringify(row))
  })

  it('fixtures cover every section, a lone oversized first item and a payload without Related', () => {
    const sections = (row: ReformatRow): Set<string> => new Set(row.payload_items!.map((i) => i.section))
    expect([...sections(FIXTURES[0]![2])].sort()).toEqual(['context', 'domain', 'faint', 'recalled', 'related'])
    expect(estimateTokens(FIXTURES[1]![2].formatted!.slice(FIXTURES[1]![2].payload_items![0]!.start, FIXTURES[1]![2].payload_items![0]!.end))).toBeGreaterThan(500)
    expect(sections(FIXTURES[2]![2]).has('related')).toBe(false)
  })
})

describe('reformatRow under a policy', () => {
  function policiesFor(row: ReformatRow): RecallOutputPolicy[] {
    const full = estimateTokens(row.formatted!)
    const budgets = [1, 80, 120, Math.floor(full / 2), full - 1, full]
    return [
      ...budgets.map((tokenBudget) => ({ tokenBudget, faint: true })),
      { emitK: 1, faint: true },
      { faint: false },
      { emitK: 2, tokenBudget: Math.floor(full * 0.8), faint: false },
    ]
  }

  it.each(FIXTURES)('cuts the same prefix as core assembling the original items (%s)', (_name, stub, row) => {
    let truncatedSeen = 0
    for (const policy of policiesFor(row)) {
      const core = assemble(renderStub(stub), policy)
      const out = reformatRow(row, policy)
      expect(out.formatted).toBe(core.text)
      expect(out.truncated).toBe(core.payload.truncated)
      expect(out.payload_items!.map(({ section, start, end }) => ({ section, start, end })))
        .toEqual(core.payload.items.map(({ section, start, end }) => ({ section, start, end })))
      expect(out.context_items).toBe(core.payload.emittedMemories)
      expect(out.context_chars).toBe(core.text.length)
      expect(out.context_tokens).toBe(estimateTokens(core.text))
      for (const item of out.payload_items!) expect(out.formatted!.slice(item.start, item.end).startsWith('- ')).toBe(true)
      if (core.payload.truncated) truncatedSeen++
    }
    expect(truncatedSeen).toBeGreaterThan(0)
  })

  it('emits an oversized first item whole and stops there', () => {
    const row = FIXTURES[1]![2]
    const out = reformatRow(row, { tokenBudget: 10, faint: true })
    expect(out.payload_items).toHaveLength(1)
    expect(out.truncated).toBe(true)
    expect(out.formatted).toBe(row.formatted!.slice(0, row.payload_items![0]!.end))
  })

  it('drops a gold session whose only item was cut', () => {
    const row = FIXTURES[0]![2]
    expect(row.gold_ids_in_context).toEqual(['s_d', 's_a'])
    expect(reformatRow(row, { faint: false }).gold_ids_in_context).toEqual(['s_a'])

    const norel = FIXTURES[2]![2]
    expect(norel.gold_ids_in_context).toEqual(['s_c'])
    expect(reformatRow(norel, { emitK: 2, faint: true }).gold_ids_in_context).toEqual([])
  })

  it('keeps every non-payload field byte-identical', () => {
    for (const [, , row] of FIXTURES) {
      const out = reformatRow(row, { tokenBudget: 120, faint: false })
      expect(withoutPayloadFields(out)).toBe(withoutPayloadFields(row))
      expect(Object.keys(out)).toEqual(Object.keys(row))
    }
  })
})

describe('refusals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reformat-'))
  const src = path.join(dir, 'sweep.json')
  fs.writeFileSync(src, '{}')

  it('requires at least one policy flag', () => {
    expect(() => parseReformatArgs(['--sweep', src, '--output', path.join(dir, 'o.json')])).toThrow(/at least one of/)
  })
  it('rejects --emit-k and --token-budget below 1', () => {
    const base = ['--sweep', src, '--output', path.join(dir, 'o.json')]
    expect(() => parseReformatArgs([...base, '--emit-k', '0'])).toThrow(/--emit-k must be an integer >= 1/)
    expect(() => parseReformatArgs([...base, '--token-budget', '0'])).toThrow(/--token-budget must be an integer >= 1/)
    expect(() => parseReformatArgs([...base, '--token-budget', '-5'])).toThrow(/--token-budget/)
  })
  it('rejects an output path equal to the input', () => {
    expect(() => parseReformatArgs(['--sweep', src, '--output', src, '--emit-k', '3'])).toThrow(/--output must differ/)
    const rel = path.relative(process.cwd(), src)
    expect(() => parseReformatArgs(['--sweep', rel, '--output', src, '--emit-k', '3'])).toThrow(/--output must differ/)
  })
  it('accepts only "off" for --faint and builds the arm policy', () => {
    expect(() => parseReformatArgs(['--sweep', src, '--output', path.join(dir, 'o.json'), '--faint', 'on'])).toThrow(/only "off"/)
    const args = parseReformatArgs(['--sweep', src, '--output', path.join(dir, 'o.json'), '--token-budget', '1500', '--faint', 'off'])
    expect(armPolicy(args)).toEqual({ tokenBudget: 1500, faint: false })
  })
  it('rejects a sessions-mode sweep', () => {
    const sweep: ReformatSweep = { meta: { args: { contextMode: 'sessions' }, output_policy: { emit_k: null, token_budget: null, faint: true } }, rows: [] }
    expect(() => assertReformattableSweep(sweep)).toThrow(/only a --context-mode formatted sweep/)
  })
  it('rejects a source recorded under a bounded policy', () => {
    const sweep: ReformatSweep = { meta: { args: { contextMode: 'formatted' }, output_policy: { emit_k: null, token_budget: 2000, faint: true } }, rows: [] }
    expect(() => assertReformattableSweep(sweep)).toThrow(/recorded under output policy/)
  })
  it('rejects a row without payload_items', () => {
    const { payload_items: _drop, ...row } = FIXTURES[0]![2]
    expect(() => reformatRow(row as ReformatRow, { faint: false })).toThrow(/q-all has no payload_items/)
  })
  it('rejects items that do not reassemble to the recorded text', () => {
    const row = FIXTURES[0]![2]
    expect(() => rebuildRendered({ ...row, formatted: row.formatted!.replace('### Related', '### Linked_')})).toThrow(/do not reassemble/)
  })
})

describe('reformatSweep', () => {
  it('records provenance and the arm policy and keeps retrieval aggregates', () => {
    const sourceMeta = { args: { contextMode: 'formatted' }, output_policy: { emit_k: null, token_budget: null, faint: true }, total_questions: 3 }
    const source = { meta: sourceMeta, recall_at_K: { 5: { hits: 3, total: 3, rate: 1 } }, rows: FIXTURES.map(([, , r]) => r) }
    const bytes = Buffer.from(JSON.stringify(source, null, 2))
    const out = reformatSweep({ path: 'results/src.json', bytes }, { tokenBudget: 120, faint: true })
    expect(out.meta!['derived_from']).toEqual({ path: 'results/src.json', sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(out.meta!['output_policy']).toEqual({ emit_k: null, token_budget: 120, faint: true })
    expect(out.meta!['retrieval_rerun']).toBe(false)
    expect(out.meta!['source_meta']).toEqual(sourceMeta)
    expect(out['recall_at_K']).toEqual(source.recall_at_K)
    expect(out.rows.map((r) => r.question_id)).toEqual(['q-all', 'q-huge', 'q-norel'])
  })
})
