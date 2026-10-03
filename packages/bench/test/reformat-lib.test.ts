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
import { runSweepRecall, type SweepRecallResult } from '../src/longmemeval/forensics/context-modes.js'
import { stripBenchSessionNamespace } from '../src/longmemeval/forensics/project-sessions.js'
import { buildJudgeModelMeta } from '../src/longmemeval/forensics/reranker-meta-lib.js'
import {
  armPolicy,
  assertReformattableSweep,
  describeFirstDifference,
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
    // The bench stores sessions namespaced per question; the Context line renders that id.
    temporalContext: [{ session: 'lme:q-all:s_a', timeOfDay: 'morning', date: '2023-05-20' }],
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

function strippedRender(stub: Stub, qid: string): RenderedPayload {
  const r = renderStub(stub)
  const strip = (items: RenderedPayload['recalled']) => items.map((item) => ({ ...item, text: stripBenchSessionNamespace(item.text, qid) }))
  return { recalled: strip(r.recalled), related: strip(r.related), domain: strip(r.domain), context: strip(r.context), faint: strip(r.faint) }
}

/** The recall result Memory.recall returns for this stub under `policy`. */
function stubRecall(stub: Stub, policy: RecallOutputPolicy = DEFAULT_RECALL_OUTPUT_POLICY): SweepRecallResult {
  const { text, payload } = assemble(renderStub(stub), policy)
  return {
    memories: stub.memories,
    associations: stub.associations,
    faintAssociations: stub.context?.faintAssociations ?? [],
    formatted: text,
    estimatedTokens: estimateTokens(text),
    payload,
  }
}

/** The payload fields recall-sweep's formatted mode records for this stub under `policy`. */
async function directSweepFields(qid: string, stub: Stub, gold: string[], policy?: RecallOutputPolicy) {
  const memory = { recall: async () => stubRecall(stub, policy) }
  const question = { question_id: qid, question: 'What did I plan?', answer_session_ids: gold }
  const out = await runSweepRecall(memory, question, { contextMode: 'formatted', maxK: 30, synthesize: false })
  return out.formattedFields!
}

/** A formatted sweep row as recall-sweep writes it for this stub recall. */
async function fixtureRow(qid: string, stub: Stub, gold: string[]): Promise<ReformatRow> {
  const fields = await directSweepFields(qid, stub, gold)
  return {
    question_id: qid,
    question_type: 'multi-session',
    question: 'What did I plan?',
    gold_session_ids: gold,
    retrieved_session_ids: ['s_b', 's_a', 's_c'],
    retrieved_count: 3,
    recall_at_k: { 1: false, 5: true },
    relevance_top: [0.93, 0.81, 0.4],
    formatted: fields.formatted,
    context_chars: fields.context_chars,
    context_items: fields.context_items,
    gold_ids_in_context: fields.gold_ids_in_context,
    payload_items: fields.payload_items,
    context_tokens: fields.context_tokens,
    truncated: fields.truncated,
  }
}

const FIXTURES: Array<[string, Stub, ReformatRow]> = [
  ['all sections', ALL_SECTIONS, await fixtureRow('q-all', ALL_SECTIONS, ['s_d', 's_a'])],
  ['huge first item', HUGE_FIRST, await fixtureRow('q-huge', HUGE_FIRST, ['s_c'])],
  ['no related items', NO_RELATED, await fixtureRow('q-norel', NO_RELATED, ['s_c', 's_x'])],
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

  it('measures context_tokens on the namespace-stripped text, and reproduces it under the empty policy', () => {
    const row = FIXTURES[0]![2]
    const raw = assemble(renderStub(ALL_SECTIONS)).text
    expect(raw).toContain('lme:q-all:s_a')
    expect(row.formatted).toBe(stripBenchSessionNamespace(raw, 'q-all'))
    expect(row.context_tokens).toBe(estimateTokens(row.formatted!))
    expect(row.context_tokens).not.toBe(estimateTokens(raw))
    expect(reformatRow(row, DEFAULT_RECALL_OUTPUT_POLICY).context_tokens).toBe(row.context_tokens)
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
      // Core assembling the item lines the judge reads, so the budget measures the same text.
      const core = assemble(strippedRender(stub, row.question_id), policy)
      const coreText = core.text
      const out = reformatRow(row, policy)
      expect(out.formatted).toBe(coreText)
      expect(out.truncated).toBe(core.payload.truncated)
      expect(out.payload_items!.map(({ section }) => section)).toEqual(core.payload.items.map(({ section }) => section))
      expect(out.context_items).toBe(core.payload.emittedMemories)
      expect(out.context_chars).toBe(coreText.length)
      expect(out.context_tokens).toBe(estimateTokens(coreText))
      for (const item of out.payload_items!) expect(out.formatted!.slice(item.start, item.end).startsWith('- ')).toBe(true)
      if (core.payload.truncated) truncatedSeen++
    }
    expect(truncatedSeen).toBeGreaterThan(0)
  })

  it.each(FIXTURES)('records the same payload fields as a direct sweep under the same emit-K or faint policy (%s)', async (_name, stub, row) => {
    // A token budget is excluded: core measures the namespaced text, reformat the stripped text.
    for (const policy of [{ emitK: 1, faint: true }, { faint: false }, { emitK: 2, faint: false }]) {
      const direct = await directSweepFields(row.question_id, stub, row.gold_session_ids, policy)
      const { formatted, context_chars, context_items, gold_ids_in_context, payload_items, context_tokens, truncated } = reformatRow(row, policy)
      expect({ formatted, context_chars, context_items, gold_ids_in_context, payload_items, context_tokens, truncated }).toEqual(direct)
    }
  })

  it('agrees with a bounded direct sweep on gold ids when a gold session\'s only memory is cut by the budget', async () => {
    const row = FIXTURES[2]![2]
    expect(NO_RELATED.memories.map((m) => m.metadata['lmeSessionId'])).toContain('s_c')
    const full = estimateTokens(row.formatted!)
    const budgets = Array.from({ length: full }, (_, i) => i + 1)
    const tokenBudget = budgets.find((b) => assemble(renderStub(NO_RELATED), { tokenBudget: b, faint: true }).payload.emittedMemories === 2)!
    expect(tokenBudget).toBeDefined()
    const policy = { tokenBudget, faint: true }

    const direct = await directSweepFields(row.question_id, NO_RELATED, row.gold_session_ids, policy)
    const derived = reformatRow(row, policy)
    expect(direct.truncated).toBe(true)
    expect(direct.gold_ids_in_context).toEqual([])
    expect(derived.gold_ids_in_context).toEqual(direct.gold_ids_in_context)
    expect(derived.context_items).toBe(direct.context_items)
  })

  it('emits nothing under a budget smaller than the header', () => {
    const row = FIXTURES[1]![2]
    const out = reformatRow(row, { tokenBudget: 10, faint: true })
    expect(out.payload_items).toHaveLength(0)
    expect(out.truncated).toBe(true)
    expect(out.formatted).toBe('')
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
  it('rejects items that do not reassemble to the recorded text, naming the header line that differs', () => {
    const row = FIXTURES[0]![2]
    const formatted = row.formatted!.replace('### Related', '### Linked_')
    const line = formatted.split('\n').indexOf('### Linked_ Memories') + 1
    expect(line).toBeGreaterThan(0)
    expect(() => rebuildRendered({ ...row, formatted })).toThrow(/do not reassemble/)
    expect(() => rebuildRendered({ ...row, formatted })).toThrow(`header lines differ at line ${line}: recorded "### Linked_ Memories", reassembled "### Related Memories"`)
  })
  it('names the first differing item line when an item offset is wrong', () => {
    const row = FIXTURES[2]![2]
    const items = row.payload_items!.map((item, i) => (i === 1 ? { ...item, start: item.start + 2 } : item))
    const line = row.formatted!.slice(0, row.payload_items![1]!.start).split('\n').length
    expect(() => rebuildRendered({ ...row, payload_items: items })).toThrow(new RegExp(`item line ${line}: recorded "- `))
  })
  it('reports a text that ends early', () => {
    expect(describeFirstDifference('a\nb', 'a', [])).toBe('header lines differ at line 2: recorded "b", reassembled <end of text>')
  })
})

describe('reformatSweep', () => {
  it('records provenance and the arm policy and keeps retrieval aggregates', () => {
    const sourceMeta = {
      args: { contextMode: 'formatted' },
      rerankerBackend: 'onnx',
      rerankModel: 'mixedbread-ai/mxbai-rerank-large-v1',
      embedModel: 'text-embedding-3-small',
      output_policy: { emit_k: null, token_budget: null, faint: true },
      total_questions: 3,
    }
    const source = { meta: sourceMeta, recall_at_K: { 5: { hits: 3, total: 3, rate: 1 } }, rows: FIXTURES.map(([, , r]) => r) }
    const bytes = Buffer.from(JSON.stringify(source, null, 2))
    const out = reformatSweep({ path: 'results/src.json', bytes }, { tokenBudget: 120, faint: true })
    expect(out.meta!['derived_from']).toEqual({ path: 'results/src.json', sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(out.meta!['output_policy']).toEqual({
      emit_k: null, token_budget: 120, faint: true, related_share: null, item_max_tokens: null,
    })
    expect(out.meta!['retrieval_rerun']).toBe(false)
    expect(out.meta!['source_meta']).toEqual(sourceMeta)
    expect(buildJudgeModelMeta(out.meta, 'gen-model')).toEqual(buildJudgeModelMeta(sourceMeta, 'gen-model'))
    expect(buildJudgeModelMeta(out.meta, 'gen-model').rerankModel).toBe('mixedbread-ai/mxbai-rerank-large-v1')
    expect(out['recall_at_K']).toEqual(source.recall_at_K)
    expect(out.rows.map((r) => r.question_id)).toEqual(['q-all', 'q-huge', 'q-norel'])
  })
})
