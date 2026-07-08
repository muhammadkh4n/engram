import { describe, it, expect } from 'vitest'
import { buildSynthesisField } from '../src/longmemeval/forensics/synthesis-row.js'

describe('buildSynthesisField (sweep --synthesize row shape)', () => {
  it('omits the synthesis key entirely when the flag is off', () => {
    const field = buildSynthesisField(false, undefined)
    expect(field).toEqual({})
    expect('synthesis' in field).toBe(false)
  })

  it('omits the synthesis key even if a stray block is passed when the flag is off', () => {
    const field = buildSynthesisField(false, { intent: 'x', method: 'y', text: 'z' })
    expect('synthesis' in field).toBe(false)
  })

  it('sets synthesis to explicit null (present key, null value) when the flag is on but recall produced no block', () => {
    const field = buildSynthesisField(true, null)
    expect('synthesis' in field).toBe(true)
    expect(field.synthesis).toBeNull()
  })

  it('sets synthesis to explicit null when the flag is on and the row value is undefined', () => {
    const field = buildSynthesisField(true, undefined)
    expect('synthesis' in field).toBe(true)
    expect(field.synthesis).toBeNull()
  })

  it('carries the synthesis block through unchanged when the flag is on and a block is present', () => {
    const block = { intent: 'temporal-reasoning', method: 'llm-selected', text: 'Per session s1, the answer is X.' }
    const field = buildSynthesisField(true, block)
    expect(field).toEqual({ synthesis: block })
  })

  it('structurally pins: a PerQRow built without the flag has NO synthesis key', () => {
    const baseRow = {
      question_id: 'q1',
      question_type: 'single-session-user',
      question: 'What did I say?',
      gold_session_ids: ['s1'],
      retrieved_session_ids: ['s1'],
      retrieved_count: 1,
      episodes_ingested: 3,
      ingest_ms: 10,
      eval_ms: 20,
      recall_at_k: { 5: true },
    }
    const row = { ...baseRow, ...buildSynthesisField(false, undefined) }
    expect(Object.prototype.hasOwnProperty.call(row, 'synthesis')).toBe(false)
    expect(row).toEqual(baseRow)
  })

  it('structurally pins: a PerQRow built with the flag but a null block has synthesis: null (not absent)', () => {
    const baseRow = {
      question_id: 'q2',
      question_type: 'single-session-user',
      question: 'What did I say?',
      gold_session_ids: ['s1'],
      retrieved_session_ids: [],
      retrieved_count: 0,
      episodes_ingested: 3,
      ingest_ms: 10,
      eval_ms: 20,
      recall_at_k: { 5: false },
    }
    const row = { ...baseRow, ...buildSynthesisField(true, null) }
    expect(Object.prototype.hasOwnProperty.call(row, 'synthesis')).toBe(true)
    expect(row.synthesis).toBeNull()
  })
})
