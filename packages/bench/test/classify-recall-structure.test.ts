/**
 * Phase 0 — recall-structure classifier (deterministic, no LLM).
 * Locks the dataset-signal precedence and the graph-relevant set.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyRecallStructure,
  GRAPH_RELEVANT,
  type QuestionContext,
} from '../src/classification/classify-recall-structure.js'

const base: QuestionContext = { question: 'q', goldAnswer: 'a', goldIds: ['x'] }

describe('classifyRecallStructure', () => {
  it('maps LoCoMo categories authoritatively', () => {
    expect(classifyRecallStructure({ ...base, category: 2 }).type).toBe('multi_hop')
    expect(classifyRecallStructure({ ...base, category: 3 }).type).toBe('temporal')
    expect(classifyRecallStructure({ ...base, category: 1 }).type).toBe('lookup')
    expect(classifyRecallStructure({ ...base, category: 4 }).type).toBe('lookup')
    expect(classifyRecallStructure({ ...base, category: 5 }).type).toBe('lookup')
  })

  it('maps LongMemEval abilities authoritatively', () => {
    expect(classifyRecallStructure({ ...base, ability: 'temporal_reasoning' }).type).toBe('temporal')
    expect(classifyRecallStructure({ ...base, ability: 'multi_session_reasoning' }).type).toBe('multi_hop')
    expect(classifyRecallStructure({ ...base, ability: 'knowledge_updates' }).type).toBe('multi_hop')
    expect(classifyRecallStructure({ ...base, ability: 'information_extraction' }).type).toBe('lookup')
    expect(classifyRecallStructure({ ...base, ability: 'abstention' }).type).toBe('lookup')
  })

  it('category wins over ability and heuristics', () => {
    const label = classifyRecallStructure({ ...base, category: 2, ability: 'temporal_reasoning', goldIds: ['1', '2', '3', '4'] })
    expect(label.type).toBe('multi_hop')
  })

  it('falls back to cardinality + temporal heuristics when no signal', () => {
    expect(classifyRecallStructure({ question: 'q', goldAnswer: 'a', goldIds: ['1', '2', '3', '4'] }).type).toBe('aggregation')
    expect(classifyRecallStructure({ question: 'when did X move', goldAnswer: 'in 2021', goldIds: ['1'] }).type).toBe('temporal')
    expect(classifyRecallStructure({ question: 'q', goldAnswer: 'a', goldIds: ['1', '2'] }).type).toBe('multi_hop')
    expect(classifyRecallStructure({ question: 'q', goldAnswer: 'a', goldIds: ['1'] }).type).toBe('lookup')
  })

  it('GRAPH_RELEVANT is exactly {multi_hop, temporal}', () => {
    expect([...GRAPH_RELEVANT].sort()).toEqual(['multi_hop', 'temporal'])
  })
})
