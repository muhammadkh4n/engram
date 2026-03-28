import { describe, it, expect } from 'vitest'
import { extractSearchableContent } from '../../src/ingestion/content-cleaner.js'

// ---------------------------------------------------------------------------
// Timestamp stripping
// ---------------------------------------------------------------------------

describe('extractSearchableContent — timestamp stripping', () => {
  it('removes a day-stamped bracket timestamp from user content', () => {
    const raw = '[Sat 2026-03-28 05:56 GMT+5] I was working on the auth module'
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toMatch(/\[Sat 2026-03-28/)
    expect(result).toContain('I was working on the auth module')
  })

  it('removes timestamps for every day abbreviation', () => {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    for (const day of days) {
      const raw = `[${day} 2026-01-01 12:00 UTC] some real content`
      const result = extractSearchableContent(raw, 'assistant')
      expect(result).not.toMatch(new RegExp(`\\[${day}`))
      expect(result).toContain('some real content')
    }
  })

  it('removes timestamp with timezone offset in bracket', () => {
    const raw = '[Wed 2026-03-29 09:15 GMT+5:30] Deployed to production'
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toContain('[Wed')
    expect(result).toContain('Deployed to production')
  })

  it('removes multiple timestamps in a single message', () => {
    const raw =
      '[Mon 2026-03-01 08:00 UTC] First note [Fri 2026-03-05 17:30 UTC] Second note'
    const result = extractSearchableContent(raw, 'assistant')
    expect(result).not.toMatch(/\[Mon/)
    expect(result).not.toMatch(/\[Fri/)
    expect(result).toContain('First note')
    expect(result).toContain('Second note')
  })
})

// ---------------------------------------------------------------------------
// Tool call marker stripping
// ---------------------------------------------------------------------------

describe('extractSearchableContent — tool call marker stripping', () => {
  it('removes a [Tool call: X] marker', () => {
    const raw = '[Tool call: engram_search] find TypeScript notes'
    const result = extractSearchableContent(raw, 'assistant')
    expect(result).not.toContain('[Tool call:')
    expect(result).toContain('find TypeScript notes')
  })

  it('removes multiple tool call markers', () => {
    const raw =
      '[Tool call: engram_ingest] stored [Tool call: engram_recall] retrieved notes'
    const result = extractSearchableContent(raw, 'assistant')
    expect(result).not.toContain('[Tool call:')
    expect(result).toContain('stored')
    expect(result).toContain('retrieved notes')
  })

  it('handles tool call marker with trailing whitespace', () => {
    const raw = '[Tool call: engram_search]   The project uses React'
    const result = extractSearchableContent(raw, 'assistant')
    expect(result).not.toContain('[Tool call:')
    expect(result).toContain('The project uses React')
  })
})

// ---------------------------------------------------------------------------
// System metadata block stripping
// ---------------------------------------------------------------------------

describe('extractSearchableContent — system metadata stripping', () => {
  it('removes "Conversation info (untrusted metadata):" block ending with ```', () => {
    const raw = [
      'Conversation info (untrusted metadata):',
      '```',
      'session: abc123',
      '```',
      'The user asked about TypeScript.',
    ].join('\n')
    const result = extractSearchableContent(raw, 'system')
    expect(result).not.toContain('Conversation info')
    expect(result).not.toContain('session: abc123')
    expect(result).toContain('The user asked about TypeScript')
  })

  it('removes "System: [...]" lines', () => {
    const raw = 'System: [context_window_exceeded]\nFallback to summary mode.'
    const result = extractSearchableContent(raw, 'system')
    expect(result).not.toContain('System:')
    expect(result).toContain('Fallback to summary mode')
  })

  it('removes "Sender (untrusted metadata):" block', () => {
    const raw = [
      'Sender (untrusted metadata):',
      '```',
      'user_id: 42',
      '```',
      'Real message content here.',
    ].join('\n')
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toContain('Sender (untrusted')
    expect(result).not.toContain('user_id: 42')
    expect(result).toContain('Real message content here')
  })
})

// ---------------------------------------------------------------------------
// User tool invocation command stripping
// ---------------------------------------------------------------------------

describe('extractSearchableContent — user tool invocation command stripping', () => {
  it('removes "Use engram_search to find X" prefix for user role', () => {
    const raw = 'Use engram_search to find TypeScript architecture notes'
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toMatch(/^Use engram_search/i)
    expect(result).toContain('TypeScript architecture notes')
  })

  it('removes "Run the engram_recall tool to ..." prefix for user role', () => {
    const raw = 'Run the engram_recall tool to retrieve recent decisions'
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toMatch(/^Run the engram_recall/i)
    expect(result).toContain('retrieve recent decisions')
  })

  it('removes "Call engram_ingest ..." prefix for user role', () => {
    const raw = 'Call engram_ingest to store this preference'
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toMatch(/^Call engram_ingest/i)
    expect(result).toContain('store this preference')
  })

  it('removes "Execute engram_search ..." prefix for user role', () => {
    const raw = 'Execute engram_search to look up prior art'
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toMatch(/^Execute engram_search/i)
  })

  it('does NOT strip tool invocation commands from assistant messages', () => {
    const raw = 'Use engram_search to find relevant memories'
    const result = extractSearchableContent(raw, 'assistant')
    // assistant role should not have the user-specific stripping applied
    expect(result).toContain('Use engram_search')
  })
})

// ---------------------------------------------------------------------------
// Preservation of substantive content
// ---------------------------------------------------------------------------

describe('extractSearchableContent — preserves substantive content', () => {
  it('preserves a plain assistant message untouched', () => {
    const raw = 'The TypeScript strict mode is configured in tsconfig.json via strict: true.'
    const result = extractSearchableContent(raw, 'assistant')
    expect(result).toBe(raw)
  })

  it('preserves a plain user message untouched', () => {
    const raw = 'I prefer TypeScript over JavaScript for all new services.'
    const result = extractSearchableContent(raw, 'user')
    expect(result).toBe(raw)
  })

  it('preserves multi-paragraph content', () => {
    const raw = 'First paragraph about TypeScript.\n\nSecond paragraph about React.'
    const result = extractSearchableContent(raw, 'user')
    expect(result).toContain('First paragraph about TypeScript')
    expect(result).toContain('Second paragraph about React')
  })

  it('preserves code blocks in substantive content', () => {
    const raw =
      'Here is the tsconfig:\n```json\n{ "strict": true }\n```\nUse this for all projects.'
    const result = extractSearchableContent(raw, 'assistant')
    expect(result).toContain('tsconfig')
    expect(result).toContain('"strict": true')
  })
})

// ---------------------------------------------------------------------------
// Mixed content (real-world scenario)
// ---------------------------------------------------------------------------

describe('extractSearchableContent — mixed content', () => {
  it('strips timestamp + tool call but preserves the real content', () => {
    const raw =
      '[Thu 2026-03-27 14:22 UTC] [Tool call: engram_ingest] We deployed the new auth service to production.'
    const result = extractSearchableContent(raw, 'assistant')
    expect(result).not.toMatch(/\[Thu/)
    expect(result).not.toContain('[Tool call:')
    expect(result).toContain('We deployed the new auth service to production')
  })

  it('strips timestamp + user meta-query, leaving the actual search terms', () => {
    const raw =
      '[Sat 2026-03-28 05:56 GMT+5] Use engram_search to find notes about the GraphQL migration'
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toMatch(/\[Sat/)
    expect(result).not.toMatch(/Use engram_search/i)
    expect(result).toContain('GraphQL migration')
  })

  it('collapses excess blank lines introduced by stripping', () => {
    const raw = '[Mon 2026-01-01 00:00 UTC]\n\n\n\nReal content here.'
    const result = extractSearchableContent(raw, 'user')
    expect(result).not.toMatch(/\n{3,}/)
    expect(result).toContain('Real content here')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('extractSearchableContent — edge cases', () => {
  it('returns empty string for empty input', () => {
    const result = extractSearchableContent('', 'user')
    expect(result).toBe('')
  })

  it('returns empty string when content is only a timestamp', () => {
    const raw = '[Fri 2026-03-28 10:00 UTC]'
    const result = extractSearchableContent(raw, 'user')
    expect(result).toBe('')
  })

  it('returns empty string when content is only a tool call marker', () => {
    const raw = '[Tool call: engram_search]'
    const result = extractSearchableContent(raw, 'assistant')
    expect(result).toBe('')
  })

  it('handles whitespace-only content gracefully', () => {
    const result = extractSearchableContent('   \n\n   ', 'user')
    expect(result).toBe('')
  })

  it('handles a very long content string without errors', () => {
    const raw = 'TypeScript '.repeat(1000)
    const result = extractSearchableContent(raw, 'assistant')
    expect(result.length).toBeGreaterThan(0)
  })
})
