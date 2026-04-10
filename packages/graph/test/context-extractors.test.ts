import { describe, it, expect } from 'vitest'
import { extractPersons, classifyEmotion, classifyContentIntent } from '../src/context-extractors.js'

// Import INTENT_PATTERNS from core for classifyContentIntent tests
// NOTE: In CI, @engram-mem/core must be built first
import { INTENT_PATTERNS } from '@engram-mem/core'

describe('extractPersons', () => {
  it('extracts names from "tell X" pattern', () => {
    const result = extractPersons('Can you tell Muhammad about the update?')
    expect(result.find(p => p.name === 'Muhammad')).toBeDefined()
  })

  it('extracts names from "ask X" pattern', () => {
    const result = extractPersons('please ask Sarah about the deployment')
    expect(result.find(p => p.name === 'Sarah')).toBeDefined()
  })

  it('extracts @-mentioned names', () => {
    const result = extractPersons('Hey @Alice, can you review this?')
    expect(result.find(p => p.name === 'Alice')).toBeDefined()
  })

  it('does not extract blocklisted words', () => {
    const result = extractPersons('The First thing to Note is that This works')
    const names = result.map(p => p.name)
    expect(names).not.toContain('First')
    expect(names).not.toContain('Note')
    expect(names).not.toContain('This')
  })

  it('deduplicates same name from multiple patterns', () => {
    const result = extractPersons('Tell Muhammad, ask Muhammad, ping Muhammad')
    const muhammads = result.filter(p => p.name === 'Muhammad')
    expect(muhammads.length).toBe(1)
  })

  it('returns empty array for text with no names', () => {
    const result = extractPersons('the quick brown fox jumps over the lazy dog')
    expect(result.length).toBe(0)
  })
})

describe('classifyEmotion', () => {
  it('returns neutral for plain text', () => {
    const result = classifyEmotion('I need to update the database schema')
    expect(result.label).toBe('neutral')
  })

  it('requires 2+ matches for non-neutral (AUDIT FIX)', () => {
    const result = classifyEmotion('That works!!')
    expect(result.label).toBe('neutral')
  })

  it('classifies frustrated with 2+ pattern matches', () => {
    const result = classifyEmotion('I am frustrated, this is still broken and not working')
    expect(result.label).toBe('frustrated')
    expect(result.patternMatches).toBeGreaterThanOrEqual(2)
    expect(result.intensity).toBeGreaterThan(0.4)
  })

  it('classifies urgent with 2+ pattern matches', () => {
    const result = classifyEmotion('This is urgent, production is down, we need to fix immediately')
    expect(result.label).toBe('urgent')
    expect(result.patternMatches).toBeGreaterThanOrEqual(2)
  })

  it('classifies excited with 2+ pattern matches', () => {
    const result = classifyEmotion("I'm excited about this, it's amazing and I can't wait to try it!!")
    expect(result.label).toBe('excited')
    expect(result.patternMatches).toBeGreaterThanOrEqual(2)
  })

  it('intensity scales with match count', () => {
    const low = classifyEmotion('frustrated and stuck')
    const high = classifyEmotion('frustrated and stuck and broken, keeps failing, going in circles')
    expect(high.intensity).toBeGreaterThan(low.intensity)
  })
})

describe('classifyContentIntent', () => {
  it('classifies questions', () => {
    const result = classifyContentIntent('What is the architecture of this system?', INTENT_PATTERNS)
    expect(result).toBe('QUESTION')
  })

  it('classifies debugging', () => {
    const result = classifyContentIntent('There is a bug in the code, I need to debug and fix it', INTENT_PATTERNS)
    expect(result).toBe('DEBUGGING')
  })

  it('classifies recall requests', () => {
    const result = classifyContentIntent('Do you remember we discussed this last time, recall that conversation', INTENT_PATTERNS)
    expect(result).toBe('RECALL_EXPLICIT')
  })

  it('classifies social greetings', () => {
    const result = classifyContentIntent('hey!', INTENT_PATTERNS)
    expect(result).toBe('SOCIAL')
  })

  it('falls back to INFORMATIONAL for long unclassified text', () => {
    const result = classifyContentIntent(
      'The system processes data through multiple stages of transformation and validation',
      INTENT_PATTERNS,
    )
    expect(result).toBe('INFORMATIONAL')
  })
})
