import { describe, it, expect } from 'vitest'
import { shouldIngest } from '../src/ingest-filter.js'

// ---------------------------------------------------------------------------
// shouldIngest() — ingestion pollution filter
// ---------------------------------------------------------------------------

describe('shouldIngest() — length and metadata filters', () => {
  it('returns false for content shorter than 10 chars', () => {
    expect(shouldIngest('hi', 'user')).toBe(false)
    expect(shouldIngest('ok', 'assistant')).toBe(false)
    expect(shouldIngest('123456789', 'user')).toBe(false)
  })

  it('returns true for content exactly 10 chars', () => {
    expect(shouldIngest('1234567890', 'user')).toBe(true)
  })

  it('returns false for content starting with "Conversation info"', () => {
    expect(shouldIngest('Conversation info: session started', 'system')).toBe(false)
    expect(shouldIngest('Conversation info metadata block here', 'user')).toBe(false)
  })

  it('returns false for short System: prefixed content (< 200 chars)', () => {
    expect(shouldIngest('System: context loaded', 'system')).toBe(false)
  })

  it('returns true for long System: prefixed content (>= 200 chars)', () => {
    const longSystem = 'System: ' + 'x'.repeat(200)
    expect(shouldIngest(longSystem, 'system')).toBe(true)
  })
})

describe('shouldIngest() — user role tool-invocation filter', () => {
  it('returns false when user says "Use engram_search to find X"', () => {
    expect(shouldIngest('Use engram_search to find the project name', 'user')).toBe(false)
  })

  it('returns false when user says "Run engram_search ..."', () => {
    expect(shouldIngest('Run engram_search with query TypeScript', 'user')).toBe(false)
  })

  it('returns false when user says "Call engram_stats"', () => {
    expect(shouldIngest('Call engram_stats to check memory usage', 'user')).toBe(false)
  })

  it('returns false when user says "Execute engram_consolidate"', () => {
    expect(shouldIngest('Execute engram_consolidate now please', 'user')).toBe(false)
  })

  it('is case-insensitive for the tool invocation prefix', () => {
    expect(shouldIngest('USE ENGRAM_SEARCH to look for TypeScript notes', 'user')).toBe(false)
    expect(shouldIngest('RUN engram_forget on old data', 'user')).toBe(false)
  })

  it('returns false when user says "Use the engram ..."', () => {
    expect(shouldIngest('Use the engram search to find TypeScript notes', 'user')).toBe(false)
  })

  it('returns false when user says "Run the engram ..."', () => {
    expect(shouldIngest('Run the engram tool to search for my project settings', 'user')).toBe(false)
  })

  it('returns true for normal user content that mentions engram but is not a command', () => {
    expect(shouldIngest('The engram memory system stores conversations efficiently', 'user')).toBe(true)
  })

  it('returns true for a real user question', () => {
    expect(shouldIngest('What TypeScript version should we use for this project?', 'user')).toBe(true)
  })
})

describe('shouldIngest() — assistant role tool-call-only filter', () => {
  it('returns false when assistant message is only a tool call marker', () => {
    expect(shouldIngest('[Tool call: engram_search]', 'assistant')).toBe(false)
  })

  it('returns false when assistant message has multiple tool call markers but no real text', () => {
    expect(shouldIngest('[Tool call: engram_search] [Tool call: engram_stats]', 'assistant')).toBe(false)
  })

  it('returns false when text after stripping tool calls is less than 20 chars', () => {
    expect(shouldIngest('[Tool call: engram_search] OK', 'assistant')).toBe(false)
  })

  it('returns true when assistant has tool call AND substantive text', () => {
    const content = '[Tool call: engram_search] Based on your memory, you prefer TypeScript for all new projects.'
    expect(shouldIngest(content, 'assistant')).toBe(true)
  })

  it('returns true for a normal assistant response with no tool calls', () => {
    expect(shouldIngest('TypeScript strict mode enables noImplicitAny and strictNullChecks for safer code.', 'assistant')).toBe(true)
  })
})

describe('shouldIngest() — edge cases', () => {
  it('handles whitespace-only content (trimmed below 10)', () => {
    expect(shouldIngest('   ', 'user')).toBe(false)
  })

  it('trims before length check', () => {
    // Content is "hello" with lots of whitespace — trimmed to 5 chars, below threshold
    expect(shouldIngest('  hello  ', 'user')).toBe(false)
  })

  it('allows system role messages that are substantive and not metadata', () => {
    expect(shouldIngest('You are an expert TypeScript developer. Help the user write type-safe code.', 'system')).toBe(true)
  })
})
