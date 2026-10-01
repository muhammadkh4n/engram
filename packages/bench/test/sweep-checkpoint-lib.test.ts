import { describe, it, expect } from 'vitest'
import { recallOutputPolicyFromEnv } from '@engram-mem/core'
import {
  assertRowsInSelection,
  diffRunIdentity,
  formatCheckpointText,
  formatHeaderLine,
  formatRowLine,
  idListSha256,
  orderRowsByDataset,
  outputPolicyRecord,
  parsePartial,
  parseQuestionIdList,
  pendingQuestions,
  selectQuestions,
  partialPathFor,
  type RunIdentity,
} from '../src/longmemeval/forensics/sweep-checkpoint-lib.js'

const identity: RunIdentity = {
  data: '/data/lme.json',
  context_mode: 'sessions',
  reranker_backend: 'onnx',
  reranker_model: 'mixedbread-ai/mxbai-rerank-large-v1',
  graph: true,
  consolidate: true,
  vector_mode: 'full',
  max_results: 30,
  synthesize: false,
  question_selection: 'all',
  output_emit_k: null,
  output_token_budget: null,
  output_faint: true,
}

// The identity fields a sweep derives from its ENGRAM_RECALL_* env.
function policyFields(env: NodeJS.ProcessEnv): Pick<RunIdentity, 'output_emit_k' | 'output_token_budget' | 'output_faint'> {
  const p = outputPolicyRecord(recallOutputPolicyFromEnv(env))
  return { output_emit_k: p.emit_k, output_token_budget: p.token_budget, output_faint: p.faint }
}

const qs = [
  { question_id: 'q1', question_type: 'multi-session' },
  { question_id: 'q2', question_type: 'temporal-reasoning' },
  { question_id: 'q3', question_type: 'multi-session' },
  { question_id: 'q4', question_type: 'single-session-user' },
]

describe('partialPathFor', () => {
  it('appends .partial.jsonl to the output path', () => {
    expect(partialPathFor('./results/x.json')).toBe('./results/x.json.partial.jsonl')
  })
})

describe('run identity header', () => {
  it('is equal to itself', () => {
    expect(diffRunIdentity(identity, { ...identity })).toBeNull()
  })

  it('names the first differing field', () => {
    expect(diffRunIdentity(identity, { ...identity, reranker_model: 'Alibaba-NLP/gte-reranker-modernbert-base' }))
      .toBe('reranker_model')
    expect(diffRunIdentity(identity, { ...identity, question_selection: 'limit:50' })).toBe('question_selection')
  })

  it('refuses a resume whose output token budget differs, naming the field', () => {
    const recorded = { ...identity, ...policyFields({ ENGRAM_RECALL_TOKEN_BUDGET: '1500' }) }
    const current = { ...identity, ...policyFields({}) }
    expect(diffRunIdentity(recorded, current)).toBe('output_token_budget')
    expect(diffRunIdentity(current, { ...identity, ...policyFields({ ENGRAM_RECALL_TOKEN_BUDGET: '' }) })).toBeNull()
  })

  it('refuses a resume whose emit cap or faint switch differs', () => {
    expect(diffRunIdentity(identity, { ...identity, ...policyFields({ ENGRAM_RECALL_EMIT_K: '5' }) })).toBe('output_emit_k')
    expect(diffRunIdentity(identity, { ...identity, ...policyFields({ ENGRAM_RECALL_FAINT: 'off' }) })).toBe('output_faint')
  })

  it('treats a field missing from an older header as a difference', () => {
    const { synthesize: _s, ...older } = identity
    expect(diffRunIdentity(older as unknown as RunIdentity, identity)).toBe('synthesize')
  })
})

describe('outputPolicyRecord', () => {
  it('records unset limits as null', () => {
    expect(outputPolicyRecord(recallOutputPolicyFromEnv({}))).toEqual({ emit_k: null, token_budget: null, faint: true })
  })

  it('records the resolved env policy', () => {
    const env = { ENGRAM_RECALL_EMIT_K: '8', ENGRAM_RECALL_TOKEN_BUDGET: '2000', ENGRAM_RECALL_FAINT: 'off' }
    expect(outputPolicyRecord(recallOutputPolicyFromEnv(env))).toEqual({ emit_k: 8, token_budget: 2000, faint: false })
  })
})

describe('parsePartial', () => {
  const text = [
    formatHeaderLine(identity),
    formatRowLine({ question_id: 'q2', recall: 1 }),
    formatRowLine({ question_id: 'q1', recall: 0 }),
  ].join('')

  it('reads the header and every row', () => {
    const p = parsePartial(text)
    expect(p.header).toEqual(identity)
    expect(p.rows.map((r) => r.question_id)).toEqual(['q2', 'q1'])
  })

  it('drops a truncated final line left by a killed process', () => {
    const p = parsePartial(text + '{"question_id":"q3","rec')
    expect(p.rows.map((r) => r.question_id)).toEqual(['q2', 'q1'])
  })

  it('refuses a corrupt line that is not the last', () => {
    expect(() => parsePartial(formatHeaderLine(identity) + 'garbage\n' + formatRowLine({ question_id: 'q1' })))
      .toThrow(/line 2/)
  })

  it('refuses a file without a header', () => {
    expect(() => parsePartial(formatRowLine({ question_id: 'q1' }))).toThrow(/header/)
    expect(() => parsePartial('')).toThrow(/header/)
  })

  it('refuses a row id recorded twice', () => {
    expect(() => parsePartial(text + formatRowLine({ question_id: 'q2' }))).toThrow(/q2/)
  })
})

describe('checkpoint rewrite on resume', () => {
  it('survives a second resume after a truncated last line', () => {
    const killed =
      formatHeaderLine(identity) + formatRowLine({ question_id: 'q1' }) + '{"question_id":"q2","rec'
    const first = parsePartial(killed)
    const rewritten = formatCheckpointText(first.header, first.rows)
    const appended = rewritten + formatRowLine({ question_id: 'q2' }) + formatRowLine({ question_id: 'q3' })
    const second = parsePartial(appended)
    expect(second.header).toEqual(identity)
    expect(second.rows.map((r) => r.question_id)).toEqual(['q1', 'q2', 'q3'])
  })

  it('writes a header-only file when no rows survive', () => {
    expect(formatCheckpointText(identity, [])).toBe(formatHeaderLine(identity))
  })
})

describe('resume filter and final order', () => {
  it('accepts checkpoint rows inside the selection and refuses others before any run', () => {
    expect(() => assertRowsInSelection(qs, [{ question_id: 'q2' }])).not.toThrow()
    expect(() => assertRowsInSelection(qs, [{ question_id: 'q9' }])).toThrow(/q9/)
  })

  it('skips questions whose ids are already done', () => {
    const pending = pendingQuestions(qs, new Set(['q1', 'q3']))
    expect(pending.map((q) => q.question_id)).toEqual(['q2', 'q4'])
  })

  it('orders resumed and new rows by dataset order', () => {
    const rows = [{ question_id: 'q3' }, { question_id: 'q1' }, { question_id: 'q4' }, { question_id: 'q2' }]
    expect(orderRowsByDataset(qs, rows).map((r) => r.question_id)).toEqual(['q1', 'q2', 'q3', 'q4'])
  })

  it('refuses a checkpoint row outside the selected questions', () => {
    expect(() => orderRowsByDataset(qs, [{ question_id: 'q9' }])).toThrow(/q9/)
  })
})

describe('question selection', () => {
  it('selects all questions by default', () => {
    expect(selectQuestions(qs, { limit: 0 }).map((q) => q.question_id)).toEqual(['q1', 'q2', 'q3', 'q4'])
  })

  it('keeps --limit as the first N', () => {
    expect(selectQuestions(qs, { limit: 2 }).map((q) => q.question_id)).toEqual(['q1', 'q2'])
  })

  it('selects listed ids in dataset order, not list order', () => {
    expect(selectQuestions(qs, { limit: 0, ids: ['q4', 'q1'] }).map((q) => q.question_id)).toEqual(['q1', 'q4'])
  })

  it('refuses an unknown id', () => {
    expect(() => selectQuestions(qs, { limit: 0, ids: ['q1', 'nope'] })).toThrow(/unknown question_id "nope"/)
  })

  it('refuses a duplicate id', () => {
    expect(() => selectQuestions(qs, { limit: 0, ids: ['q2', 'q2'] })).toThrow(/duplicate question_id "q2"/)
  })

  it('refuses --limit together with --question-ids', () => {
    expect(() => selectQuestions(qs, { limit: 2, ids: ['q1'] })).toThrow(/--limit/)
  })
})

describe('parseQuestionIdList', () => {
  it('accepts a JSON array of strings', () => {
    expect(parseQuestionIdList('["q1","q2"]')).toEqual(['q1', 'q2'])
  })

  it('refuses anything else', () => {
    expect(() => parseQuestionIdList('{"q1":1}')).toThrow(/JSON array/)
    expect(() => parseQuestionIdList('["q1",2]')).toThrow(/JSON array/)
    expect(() => parseQuestionIdList('[]')).toThrow(/empty/)
    expect(() => parseQuestionIdList('not json')).toThrow(/JSON/)
  })
})

describe('idListSha256', () => {
  it('hashes the sorted list, so order does not matter', () => {
    expect(idListSha256(['q2', 'q1'])).toBe(idListSha256(['q1', 'q2']))
    expect(idListSha256(['q1', 'q2'])).not.toBe(idListSha256(['q1', 'q3']))
    expect(idListSha256(['q1'])).toMatch(/^[0-9a-f]{64}$/)
  })
})
