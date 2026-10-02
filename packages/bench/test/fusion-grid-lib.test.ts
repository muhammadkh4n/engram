import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IntelligenceAdapter } from '@engram-mem/core'
import {
  DEFAULT_CELL,
  aggregateRecall,
  appendCheckpointRow,
  gridIdentity,
  gridRunIdentity,
  memoizeIntelligence,
  openGridCheckpoints,
  parseGrid,
  parseGridArgs,
  recallCells,
  type GridCell,
  type GridQuestion,
  type GridRow,
} from '../src/longmemeval/forensics/fusion-grid-lib.js'
import {
  judgeReaderContext,
  sweepRecallOptions,
  type SweepMemory,
  type SweepRecallResult,
} from '../src/longmemeval/forensics/context-modes.js'
import { parsePartial, pendingQuestions, type RunIdentity } from '../src/longmemeval/forensics/sweep-checkpoint-lib.js'
import { createBenchMemory } from '../src/memory-factory.js'
import { sensoryResetter } from '../src/sensory-reset.js'

const QID = 'q-grid-1'
const QUESTION: GridQuestion = {
  question_id: QID,
  question_type: 'single-session-user',
  question: 'Where did I move the herb planters?',
  answer_session_ids: ['sess_a'],
}

const LINES = {
  m1: '- [episode · user · 2023-05-20] I moved the herb planters to the balcony last weekend.',
  m2: `- [episode · assistant · 2023-05-21] Noted for lme:${QID}:sess_b, basil needs six hours of sun.`,
}

// A stub recall whose ranking follows lexicalWeight: above 0.5 it puts m2
// first, as a heavier lexical leg could. Payload offsets are exact.
function stubRecall(order: Array<keyof typeof LINES>): SweepRecallResult {
  const header = '## Engram — Recalled Conversation Memory\n\n### Recalled Memories\n\n'
  let text = header
  const items: Array<{ section: string; id: string; start: number; end: number }> = []
  for (const id of order) {
    const start = text.length
    text += LINES[id]
    items.push({ section: 'recalled', id, start, end: text.length })
    text += '\n'
  }
  const session = { m1: 'sess_a', m2: 'sess_b' }
  return {
    memories: order.map((id, i) => ({ id, relevance: 0.9 - i * 0.25, metadata: { lmeSessionId: session[id] } })),
    formatted: text,
    payload: { truncated: false, items },
  }
}

function stubMemory(): SweepMemory & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    async recall(_query, opts) {
      calls.push(opts)
      const fusion = (opts['strategyOverride'] as { fusion?: { lexicalWeight?: number } } | undefined)?.fusion
      return stubRecall((fusion?.lexicalWeight ?? 0.15) > 0.5 ? ['m2', 'm1'] : ['m1', 'm2'])
    },
  }
}

const CELLS: GridCell[] = [
  { name: DEFAULT_CELL, fusion: {} },
  { name: 'lex-heavy', fusion: { lexicalWeight: 0.8 } },
]

describe('parseGrid', () => {
  it('accepts a grid with an empty default cell and validates each fusion', () => {
    const text = JSON.stringify([{ name: 'default', fusion: {} }, { name: 'lex-0.3', fusion: { lexicalWeight: 0.3 } }])
    expect(parseGrid(text)).toEqual([
      { name: 'default', fusion: {} },
      { name: 'lex-0.3', fusion: { lexicalWeight: 0.3 } },
    ])
  })

  it('requires a cell named default', () => {
    expect(() => parseGrid(JSON.stringify([{ name: 'a', fusion: { lexicalWeight: 0.2 } }]))).toThrow(/cell named "default"/)
  })

  it('requires the default cell to have an empty fusion', () => {
    expect(() => parseGrid(JSON.stringify([{ name: 'default', fusion: { rrfK: 30 } }]))).toThrow(/"default" must have an empty fusion/)
  })

  it('names the cell and key of an invalid fusion value', () => {
    const text = JSON.stringify([{ name: 'default', fusion: {} }, { name: 'bad', fusion: { lexicalWeight: 2 } }])
    expect(() => parseGrid(text)).toThrow(/cell "bad".*lexicalWeight/)
    const unknown = JSON.stringify([{ name: 'default', fusion: {} }, { name: 'typo', fusion: { lexicalWieght: 0.2 } }])
    expect(() => parseGrid(unknown)).toThrow(/unknown fusion key "lexicalWieght"/)
  })

  it('refuses duplicate names, path-like names and extra fields', () => {
    const dup = JSON.stringify([{ name: 'default', fusion: {} }, { name: 'default', fusion: {} }])
    expect(() => parseGrid(dup)).toThrow(/duplicate cell name/)
    expect(() => parseGrid(JSON.stringify([{ name: '../x', fusion: {} }]))).toThrow(/name must match/)
    expect(() => parseGrid(JSON.stringify([{ name: 'default', fusion: {}, weight: 1 }]))).toThrow(/unknown field "weight"/)
    expect(() => parseGrid('[]')).toThrow(/non-empty/)
  })
})

describe('parseGridArgs', () => {
  const base = ['--question-ids', 'ids.json', '--grid', 'grid.json', '--output-dir', 'out']

  it('requires --context-mode formatted', () => {
    expect(() => parseGridArgs(base)).toThrow(/--context-mode formatted is required/)
    expect(parseGridArgs([...base, '--context-mode', 'formatted', '--no-graph'])).toMatchObject({
      grid: 'grid.json',
      outputDir: 'out',
      contextMode: 'formatted',
      noGraph: true,
    })
  })

  it('refuses result-cap overrides and unknown flags', () => {
    expect(() => parseGridArgs([...base, '--context-mode', 'formatted', '--max-results', '10'])).toThrow(/--max-results/)
    expect(() => parseGridArgs([...base, '--context-mode', 'formatted', '--limit', '5'])).toThrow(/unknown flag --limit/)
  })

  it('accepts the recall sweep embed flags and leaves them unset when absent', () => {
    const plain = parseGridArgs([...base, '--context-mode', 'formatted'])
    expect('embedBackend' in plain || 'embedModel' in plain || 'embedDims' in plain).toBe(false)
    expect(
      parseGridArgs([...base, '--context-mode', 'formatted', '--embed-backend', 'onnx', '--embed-model', 'm/e', '--embed-dims', '1024']),
    ).toMatchObject({ embedBackend: 'onnx', embedModel: 'm/e', embedDims: 1024 })
    expect(() => parseGridArgs([...base, '--context-mode', 'formatted', '--embed-backend', 'cohere'])).toThrow(/--embed-backend/)
    expect(() => parseGridArgs([...base, '--context-mode', 'formatted', '--embed-dims', '0'])).toThrow(/--embed-dims/)
  })
})

describe('gridRunIdentity', () => {
  const args = parseGridArgs([
    '--data', '/data/lme.json', '--question-ids', 'ids.json', '--grid', 'grid.json', '--output-dir', 'out',
    '--context-mode', 'formatted', '--reranker', 'onnx', '--no-graph',
  ])
  const policy = { emit_k: null, token_budget: null, faint: true }

  it('records the embedder backend, model and the width the vectors are built at', () => {
    expect(gridRunIdentity(args, 'abc', policy, 1536)).toEqual({
      data: '/data/lme.json', context_mode: 'formatted', reranker_backend: 'onnx',
      reranker_model: 'mixedbread-ai/mxbai-rerank-large-v1', graph: false, consolidate: true, vector_mode: 'full',
      max_results: 30, synthesize: false, question_selection: 'ids:abc', output_emit_k: null,
      output_token_budget: null, output_faint: true,
      embed_backend: 'openai', embed_model: 'text-embedding-3-small', embed_dims: 1536,
    })
    expect(gridRunIdentity({ ...args, embedBackend: 'onnx' }, 'abc', policy, 1024)).toMatchObject({
      embed_backend: 'onnx', embed_model: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', embed_dims: 1024,
    })
  })
})

describe('sweepRecallOptions fusion override', () => {
  it('adds the fusion override and reconsolidate: false in formatted mode only', () => {
    expect(sweepRecallOptions({ contextMode: 'formatted', maxK: 30, synthesize: false })).toEqual({})
    expect(
      sweepRecallOptions({ contextMode: 'formatted', maxK: 30, synthesize: false, fusion: { rrfK: 30 }, reconsolidate: false }),
    ).toEqual({ strategyOverride: { fusion: { rrfK: 30 } }, reconsolidate: false })
    expect(() => sweepRecallOptions({ contextMode: 'sessions', maxK: 30, synthesize: false, fusion: {} })).toThrow(/formatted/)
  })
})

describe('memoizeIntelligence', () => {
  function countingBase(): { base: IntelligenceAdapter; counts: Record<string, number>; rerankBatches: string[][] } {
    const counts: Record<string, number> = { embed: 0, expandQuery: 0, generateHypotheticalDoc: 0, rerank: 0 }
    const rerankBatches: string[][] = []
    const base: IntelligenceAdapter = {
      async embed(text) { counts['embed']!++; return [text.length, 1] },
      async expandQuery(q) { counts['expandQuery']!++; return [`${q} variant`] },
      async generateHypotheticalDoc(q) { counts['generateHypotheticalDoc']!++; return `answer to ${q}` },
      async rerank(_q, docs) {
        counts['rerank']!++
        rerankBatches.push(docs.map((d) => d.id))
        // No score for "skip", as a capped adapter may drop rows.
        return docs.filter((d) => d.id !== 'skip').map((d) => ({ id: d.id, score: d.content.length / 100 }))
      },
    }
    return { base, counts, rerankBatches }
  }

  it('makes one underlying call per text for embed, expandQuery and generateHypotheticalDoc', async () => {
    const { base, counts } = countingBase()
    const memo = memoizeIntelligence(base)
    for (let i = 0; i < 3; i++) {
      expect(await memo.embed!('planters')).toEqual([8, 1])
      expect(await memo.expandQuery!('planters')).toEqual(['planters variant'])
      expect(await memo.generateHypotheticalDoc!('planters')).toBe('answer to planters')
    }
    await memo.embed!('basil')
    expect(counts).toMatchObject({ embed: 2, expandQuery: 1, generateHypotheticalDoc: 1 })
  })

  // Mirrors the real rerankers: a one-document call returns 1.0 without
  // scoring, only the first 50 documents are scored, and a score depends on
  // the batch it was computed in.
  function productionLikeReranker(): { rerank: NonNullable<IntelligenceAdapter['rerank']>; batches: string[][] } {
    const batches: string[][] = []
    return {
      batches,
      async rerank(_q, docs) {
        batches.push(docs.map((d) => d.id))
        if (docs.length === 1) return [{ id: docs[0]!.id, score: 1.0 }]
        const slate = docs.slice(0, 50)
        return slate.map((d) => ({ id: d.id, score: (d.content.length + slate.length) / 1000 }))
      },
    }
  }

  const doc = (n: number): { id: string; content: string } => ({ id: `d${n}`, content: 'x'.repeat(n + 1) })

  it('gives each cell the scores of a direct call when slates differ by one row', async () => {
    const small = [doc(0), doc(1), doc(2)]
    const large = Array.from({ length: 60 }, (_, n) => doc(n))
    const pairs: Array<[Array<{ id: string; content: string }>, Array<{ id: string; content: string }>]> = [
      [small, [...small, doc(3)]],
      [large, large.slice(1)],
    ]
    for (const [first, second] of pairs) {
      const memo = memoizeIntelligence({ rerank: productionLikeReranker().rerank })
      const direct = productionLikeReranker()
      expect(await memo.rerank!('q', first)).toEqual(await direct.rerank('q', first))
      expect(await memo.rerank!('q', second)).toEqual(await direct.rerank('q', second))
    }
  })

  it('reuses a repeated slate without a second call and keys on query and document order', async () => {
    const { base, counts, rerankBatches } = countingBase()
    const memo = memoizeIntelligence(base)
    const docs = [{ id: 'a', content: 'aaaa' }, { id: 'b', content: 'bb' }, { id: 'skip', content: 'x' }]
    const first = await memo.rerank!('q1', docs)
    const again = await memo.rerank!('q1', [...docs])
    await memo.rerank!('q1', [docs[1]!, docs[0]!, docs[2]!])
    await memo.rerank!('q2', docs)
    expect(rerankBatches).toEqual([['a', 'b', 'skip'], ['b', 'a', 'skip'], ['a', 'b', 'skip']])
    expect(counts['rerank']).toBe(3)
    expect(first).toEqual([{ id: 'a', score: 0.04 }, { id: 'b', score: 0.02 }])
    expect(again).toEqual(first)
  })

  it('memoises a failure and leaves absent methods absent', async () => {
    let calls = 0
    const memo = memoizeIntelligence({
      async expandQuery() { calls++; throw new Error('model down') },
    })
    await expect(memo.expandQuery!('q')).rejects.toThrow('model down')
    await expect(memo.expandQuery!('q')).rejects.toThrow('model down')
    expect(calls).toBe(1)
    expect(memo.rerank).toBeUndefined()
    expect(memo.generateHypotheticalDoc).toBeUndefined()
    expect('embed' in memo).toBe(false)
  })
})

describe('recallCells', () => {
  it('recalls once per cell with the cell fusion and reconsolidate: false', async () => {
    const memory = stubMemory()
    await recallCells(memory, QUESTION, CELLS, { episodes: 12, ingestMs: 40 })
    expect(memory.calls).toEqual([
      { strategyOverride: { fusion: {} }, reconsolidate: false },
      { strategyOverride: { fusion: { lexicalWeight: 0.8 } }, reconsolidate: false },
    ])
  })

  it('produces different rows for cells with different weights, sharing the ingest stats', async () => {
    const memory = stubMemory()
    const seen: string[] = []
    let resets = 0
    const rows = await recallCells(memory, QUESTION, CELLS, { episodes: 12, ingestMs: 40 }, {
      beforeCell: () => { resets++ },
      onRow: (cell) => seen.push(cell.name),
    })
    const def = rows.get(DEFAULT_CELL)!
    const lex = rows.get('lex-heavy')!
    expect(seen).toEqual([DEFAULT_CELL, 'lex-heavy'])
    expect(resets).toBe(2)
    expect(def.retrieved_session_ids).toEqual(['sess_a', 'sess_b'])
    expect(lex.retrieved_session_ids).toEqual(['sess_b', 'sess_a'])
    expect(def.formatted).not.toBe(lex.formatted)
    expect(def.formatted).not.toContain(`lme:${QID}:`)
    expect(def.recall_at_k).toEqual({ 5: true, 10: true, 20: true, 30: true })
    expect([def.episodes_ingested, def.ingest_ms, lex.episodes_ingested, lex.ingest_ms]).toEqual([12, 40, 12, 40])
  })

  it('emits rows the judge formatted-mode loader reads, with the recall-sweep formatted row keys', async () => {
    const rows = await recallCells(stubMemory(), QUESTION, CELLS, { episodes: 12, ingestMs: 40 })
    for (const row of rows.values()) {
      const onDisk = JSON.parse(JSON.stringify(row)) as GridRow
      expect(Object.keys(onDisk)).toEqual([
        'question_id', 'question_type', 'question', 'gold_session_ids', 'retrieved_session_ids', 'retrieved_count',
        'episodes_ingested', 'ingest_ms', 'eval_ms', 'recall_at_k', 'relevance_top',
        'formatted', 'context_chars', 'context_items', 'gold_ids_in_context', 'payload_items', 'context_tokens', 'truncated',
      ])
      const reader = judgeReaderContext(onDisk, { contextMode: 'formatted', topSessions: 5, includeSynthesis: false }, () => {
        throw new Error('formatted rows are never re-hydrated')
      })
      expect(reader.context).toBe(onDisk.formatted)
      expect(reader.rowFields).toEqual({ context_mode: 'formatted', context_chars: onDisk.formatted.length, gold_ids_in_context: ['sess_a'] })
    }
    expect(aggregateRecall([...rows.values()]).recall_at_K['5']).toEqual({ hits: 2, total: 2, rate: 1 })
  })
})

describe('sensoryResetter', () => {
  it('restores the captured buffer and intent before each cell', () => {
    const state = { primed: ['planters'], intent: 'recall' as unknown }
    const sensory = {
      snapshot: () => ({ primed: [...state.primed] }),
      restore: (snap: unknown) => { state.primed = [...(snap as { primed: string[] }).primed] },
      getIntent: () => state.intent,
      setIntent: (i: unknown) => { state.intent = i },
    }
    const reset = sensoryResetter({ sensory }, 'fusion-grid')
    state.primed.push('basil')
    state.intent = 'other'
    reset()
    expect(state).toEqual({ primed: ['planters'], intent: 'recall' })
  })

  it('resets the sensory buffer of a real Memory', async () => {
    const { memory } = await createBenchMemory({ graph: false, openaiApiKey: '' })
    try {
      const reset = sensoryResetter(memory, 'fusion-grid')
      const sensory = (memory as unknown as { sensory: { prime(t: string[], b: number, n: number): void; getPrimed(): unknown[] } }).sensory
      sensory.prime(['planters'], 0.2, 3)
      expect(sensory.getPrimed()).toHaveLength(1)
      reset()
      expect(sensory.getPrimed()).toEqual([])
    } finally {
      await memory.dispose()
    }
  })

  it('fails loudly when the memory has no sensory buffer', () => {
    expect(() => sensoryResetter({}, 'fusion-grid')).toThrow(/sensory buffer/)
  })
})

describe('openGridCheckpoints', () => {
  let dir: string
  const identity: RunIdentity = {
    data: '/data/lme.json', context_mode: 'formatted', reranker_backend: 'onnx', reranker_model: 'm',
    graph: false, consolidate: true, vector_mode: 'full', max_results: 30, synthesize: false,
    question_selection: 'ids:abc', output_emit_k: null, output_token_budget: null, output_faint: true,
    embed_backend: 'openai', embed_model: 'text-embedding-3-small', embed_dims: 1536,
  }
  const identityFor = (cell: GridCell) => gridIdentity(identity, 'gridsha', cell)
  const row = (id: string): GridRow => ({ question_id: id } as GridRow)

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-grid-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('resumes only questions finished in every cell and drops the rest from each checkpoint', () => {
    const fresh = openGridCheckpoints(dir, CELLS, identityFor, false)
    expect(fresh.completed.size).toBe(0)
    const [def, lex] = fresh.cells
    appendCheckpointRow(def!.partialPath, row('q1'))
    appendCheckpointRow(lex!.partialPath, row('q1'))
    appendCheckpointRow(def!.partialPath, row('q2'))
    // A stop mid-row leaves a truncated tail.
    fs.appendFileSync(lex!.partialPath, '{"question_id":"q2","ques')

    const resumed = openGridCheckpoints(dir, CELLS, identityFor, true)
    expect([...resumed.completed]).toEqual(['q1'])
    expect(resumed.cells.map((c) => c.rows.map((r) => r.question_id))).toEqual([['q1'], ['q1']])
    for (const c of resumed.cells) {
      const partial = parsePartial(fs.readFileSync(c.partialPath, 'utf8'))
      expect(partial.rows.map((r) => r.question_id)).toEqual(['q1'])
      expect(partial.header).toMatchObject({ cell: c.cell.name, grid_sha256: 'gridsha' })
    }
    const todo = pendingQuestions([{ question_id: 'q1' }, { question_id: 'q2' }, { question_id: 'q3' }], resumed.completed)
    expect(todo.map((q) => q.question_id)).toEqual(['q2', 'q3'])
  })

  it('refuses a fresh run over checkpoints, a changed grid and a missing cell checkpoint', () => {
    openGridCheckpoints(dir, CELLS, identityFor, false)
    expect(() => openGridCheckpoints(dir, CELLS, identityFor, false)).toThrow(/Pass --resume/)
    expect(() => openGridCheckpoints(dir, CELLS, (c) => gridIdentity(identity, 'othersha', c), true)).toThrow(/grid_sha256 differs/)
    const added = [...CELLS, { name: 'rrf-30', fusion: { rrfK: 30 } }]
    expect(() => openGridCheckpoints(dir, added, identityFor, true)).toThrow(/cell "rrf-30" has no checkpoint/)
  })

  it('refuses to resume a checkpoint recorded with openai at 1536 under different embed settings', () => {
    openGridCheckpoints(dir, CELLS, identityFor, false)
    const under = (embed: Partial<RunIdentity>) => (c: GridCell) => gridIdentity({ ...identity, ...embed }, 'gridsha', c)
    expect(() => openGridCheckpoints(dir, CELLS, under({ embed_dims: 512 }), true)).toThrow(/embed_dims differs \(checkpoint 1536, this run 512\)/)
    expect(() => openGridCheckpoints(dir, CELLS, under({ embed_model: 'text-embedding-3-large' }), true)).toThrow(/embed_model differs/)
    expect(() => openGridCheckpoints(dir, CELLS, under({
      embed_backend: 'onnx', embed_model: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', embed_dims: 1024,
    }), true)).toThrow(/embed_backend differs/)
    expect(openGridCheckpoints(dir, CELLS, identityFor, true).completed.size).toBe(0)
  })

  it('starts fresh under --resume when no checkpoint exists', () => {
    const res = openGridCheckpoints(dir, CELLS, identityFor, true)
    expect(res.completed.size).toBe(0)
    expect(fs.existsSync(path.join(dir, 'default.json.partial.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'lex-heavy.json.partial.jsonl'))).toBe(true)
  })
})

describe('createBenchMemory wrapIntelligence hook', () => {
  it('wraps the composed adapter, and is skipped when no adapter is configured', async () => {
    const wrapped: IntelligenceAdapter[] = []
    const wrap = (i: IntelligenceAdapter): IntelligenceAdapter => { wrapped.push(i); return memoizeIntelligence(i) }
    const none = await createBenchMemory({ graph: false, openaiApiKey: '' }, { wrapIntelligence: wrap })
    await none.memory.dispose()
    expect(wrapped).toHaveLength(0)
    // Constructing the OpenAI adapter makes no request; nothing here recalls.
    const handle = await createBenchMemory(
      { graph: false, openaiApiKey: 'sk-test-no-network', rerankerBackend: 'none' },
      { wrapIntelligence: wrap },
    )
    await handle.memory.dispose()
    expect(wrapped).toHaveLength(1)
    expect(wrapped[0]!.rerank).toBeUndefined()
    expect(typeof wrapped[0]!.embed).toBe('function')
  })
})
