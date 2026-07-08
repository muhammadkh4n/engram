import { describe, it, expect } from 'vitest'
import {
  goldFullyInGenContext,
  genIsAbstention,
  goldIsNumeric,
} from '../src/longmemeval/forensics/failure-anatomy-lib.js'

describe('deterministic failure labels', () => {
  it('gold_fully_in_gen_context: all gold ids within the first topSessions retrieved', () => {
    expect(goldFullyInGenContext(['s1', 's2'], ['s2', 's9', 's1', 's4'], 5)).toBe(true)
    expect(goldFullyInGenContext(['s1', 's7'], ['s2', 's9', 's1', 's4', 's5', 's7'], 5)).toBe(false) // s7 at rank 6
    expect(goldFullyInGenContext([], ['s1'], 5)).toBe(false) // no gold set → not attributable
  })
  it('gen_is_abstention: catches refusal phrasings, not substantive answers', () => {
    expect(genIsAbstention("I don't know.")).toBe(true)
    expect(genIsAbstention('There is no information available about that in the sessions.')).toBe(true)
    expect(genIsAbstention('It took 7 days, though I do not know the exact hour.')).toBe(false)
  })
  it('gold_is_numeric: leading-number golds', () => {
    expect(goldIsNumeric('3')).toBe(true)
    expect(goldIsNumeric('7 days. 8 days (including the last day) is also acceptable.')).toBe(true)
    expect(goldIsNumeric('The user prefers Premiere Pro.')).toBe(false)
  })
})
