import { describe, it, expect } from 'vitest'
import { parseContent } from '../../src/ingestion/content-parser.js'

// ---------------------------------------------------------------------------
// String input
// ---------------------------------------------------------------------------

describe('parseContent — string input', () => {
  it('plain string → cleanText is the string, 1 text part', () => {
    const result = parseContent('I prefer TypeScript over JavaScript')
    expect(result.cleanText).toBe('I prefer TypeScript over JavaScript')
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe('text')
    expect(result.parts[0].ordinal).toBe(0)
    expect(result.parts[0].textContent).toBe('I prefer TypeScript over JavaScript')
  })

  it('string with timestamp → cleanText has timestamp stripped', () => {
    const result = parseContent('[Sat 2026-03-28 10:00 UTC] We deployed the auth service')
    expect(result.cleanText).not.toMatch(/\[Sat/)
    expect(result.cleanText).toContain('We deployed the auth service')
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe('text')
  })

  it('string with legacy [Tool call: name] marker → marker removed from cleanText', () => {
    const result = parseContent('[Tool call: engram_search] find GraphQL notes')
    expect(result.cleanText).not.toContain('[Tool call:')
    expect(result.cleanText).toContain('find GraphQL notes')
  })

  it('string with timestamp + legacy tool marker → both stripped', () => {
    const result = parseContent('[Thu 2026-03-27 14:22 UTC] [Tool call: engram_ingest] We deployed to production')
    expect(result.cleanText).not.toMatch(/\[Thu/)
    expect(result.cleanText).not.toContain('[Tool call:')
    expect(result.cleanText).toContain('We deployed to production')
  })

  it('empty string → empty cleanText, 1 text part with empty content', () => {
    const result = parseContent('')
    expect(result.cleanText).toBe('')
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].textContent).toBe('')
  })

  it('string with only noise → cleanText is empty', () => {
    const result = parseContent('[Fri 2026-03-28 10:00 UTC]')
    expect(result.cleanText).toBe('')
  })
})

// ---------------------------------------------------------------------------
// ContentPart[] — text only
// ---------------------------------------------------------------------------

describe('parseContent — ContentPart[] text parts', () => {
  it('single text part → cleanText equals part text, 1 text part', () => {
    const content = [{ type: 'text', text: 'TypeScript strict mode is essential' }]
    const result = parseContent(content)
    expect(result.cleanText).toBe('TypeScript strict mode is essential')
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe('text')
    expect(result.parts[0].textContent).toBe('TypeScript strict mode is essential')
    expect(result.parts[0].toolName).toBeNull()
    expect(result.parts[0].toolInput).toBeNull()
  })

  it('multiple text parts → cleanText joins them, N text parts', () => {
    const content = [
      { type: 'text', text: 'First paragraph about TypeScript.' },
      { type: 'text', text: 'Second paragraph about React.' },
    ]
    const result = parseContent(content)
    expect(result.cleanText).toContain('First paragraph about TypeScript.')
    expect(result.cleanText).toContain('Second paragraph about React.')
    expect(result.parts).toHaveLength(2)
    expect(result.parts[0].partType).toBe('text')
    expect(result.parts[1].partType).toBe('text')
  })

  it('text part with timestamp → timestamp stripped from cleanText', () => {
    const content = [{ type: 'text', text: '[Mon 2026-03-01 09:00 UTC] Important note' }]
    const result = parseContent(content)
    expect(result.cleanText).not.toMatch(/\[Mon/)
    expect(result.cleanText).toContain('Important note')
  })
})

// ---------------------------------------------------------------------------
// ContentPart[] — tool_call parts
// ---------------------------------------------------------------------------

describe('parseContent — tool_call parts', () => {
  it('tool_use part → NOT in cleanText, tool_call in parts', () => {
    const content = [
      { type: 'tool_use', name: 'engram_search', input: { query: 'TypeScript' } },
    ]
    const result = parseContent(content)
    expect(result.cleanText).toBe('')
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe('tool_call')
    expect(result.parts[0].toolName).toBe('engram_search')
    expect(result.parts[0].toolInput).toEqual({ query: 'TypeScript' })
    expect(result.parts[0].textContent).toBeNull()
  })

  it('tool_use name extracted from name field', () => {
    const content = [{ type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } }]
    const result = parseContent(content)
    expect(result.parts[0].toolName).toBe('Read')
  })

  it('toolCall variant type also produces tool_call part', () => {
    const content = [{ type: 'toolCall', name: 'Bash', input: { command: 'ls' } }]
    const result = parseContent(content)
    expect(result.parts[0].partType).toBe('tool_call')
    expect(result.parts[0].toolName).toBe('Bash')
  })

  it('mixed text + tool_call → cleanText has text, no tool JSON; parts has both', () => {
    const content = [
      { type: 'text', text: 'I will search for your notes.' },
      { type: 'tool_use', name: 'engram_search', input: { query: 'notes' } },
    ]
    const result = parseContent(content)
    expect(result.cleanText).toContain('I will search for your notes.')
    expect(result.cleanText).not.toContain('engram_search')
    expect(result.cleanText).not.toContain('query')
    expect(result.parts).toHaveLength(2)
    expect(result.parts[0].partType).toBe('text')
    expect(result.parts[1].partType).toBe('tool_call')
  })
})

// ---------------------------------------------------------------------------
// ContentPart[] — tool_result parts
// ---------------------------------------------------------------------------

describe('parseContent — tool_result parts', () => {
  it('string tool_result content → brief text in cleanText, full in parts', () => {
    const content = [
      {
        type: 'tool_result',
        tool_use_id: 'tu_123',
        content: 'Found 3 TypeScript notes about strict mode configuration.',
      },
    ]
    const result = parseContent(content)
    // result text > 50 chars so it gets added to cleanText
    expect(result.cleanText).toContain('Found 3 TypeScript notes')
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe('tool_result')
    expect(result.parts[0].toolName).toBe('tu_123')
    expect(result.parts[0].textContent).toContain('Found 3 TypeScript notes')
  })

  it('short tool_result content (< 50 chars) → NOT in cleanText', () => {
    const content = [{ type: 'tool_result', content: 'ok' }]
    const result = parseContent(content)
    expect(result.cleanText).toBe('')
    expect(result.parts[0].partType).toBe('tool_result')
    expect(result.parts[0].textContent).toBe('ok')
  })

  it('array tool_result content → text extracted from text sub-parts', () => {
    const content = [
      {
        type: 'tool_result',
        content: [
          { type: 'text', text: 'TypeScript configuration details from the file.' },
          { type: 'text', text: 'Second line of output.' },
        ],
      },
    ]
    const result = parseContent(content)
    expect(result.parts[0].textContent).toContain('TypeScript configuration details')
    expect(result.parts[0].textContent).toContain('Second line of output')
  })

  it('tool_result text is capped at 500 chars in cleanText', () => {
    const longText = 'A'.repeat(1000)
    const content = [{ type: 'tool_result', content: longText }]
    const result = parseContent(content)
    // 1000-char result → only first 500 added to cleanText
    expect(result.cleanText.length).toBeLessThanOrEqual(500)
  })
})

// ---------------------------------------------------------------------------
// ContentPart[] — reasoning / thinking parts
// ---------------------------------------------------------------------------

describe('parseContent — reasoning parts', () => {
  it('thinking part → NOT in cleanText, reasoning in parts', () => {
    const content = [
      { type: 'thinking', thinking: 'Let me reason about this carefully...' },
    ]
    const result = parseContent(content)
    expect(result.cleanText).toBe('')
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe('reasoning')
    expect(result.parts[0].textContent).toBe('Let me reason about this carefully...')
  })

  it('reasoning type variant also produces reasoning part', () => {
    const content = [{ type: 'reasoning', text: 'Chain of thought here.' }]
    const result = parseContent(content)
    expect(result.parts[0].partType).toBe('reasoning')
  })

  it('mixed text + thinking → cleanText has only text', () => {
    const content = [
      { type: 'thinking', thinking: 'Let me think...' },
      { type: 'text', text: 'Here is my answer.' },
    ]
    const result = parseContent(content)
    expect(result.cleanText).toBe('Here is my answer.')
    expect(result.cleanText).not.toContain('Let me think')
    expect(result.parts).toHaveLength(2)
    expect(result.parts[0].partType).toBe('reasoning')
    expect(result.parts[1].partType).toBe('text')
  })
})

// ---------------------------------------------------------------------------
// Mixed ContentPart[] — realistic scenarios
// ---------------------------------------------------------------------------

describe('parseContent — mixed ContentPart[] (realistic)', () => {
  it('text + tool_call + text → cleanText joins text parts, tool_call in parts only', () => {
    const content = [
      { type: 'text', text: 'I will read the file for you.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } },
      { type: 'text', text: 'Here is the content I found.' },
    ]
    const result = parseContent(content)
    expect(result.cleanText).toContain('I will read the file for you.')
    expect(result.cleanText).toContain('Here is the content I found.')
    expect(result.cleanText).not.toContain('Read')
    expect(result.cleanText).not.toContain('/src/index.ts')
    expect(result.parts).toHaveLength(3)
    expect(result.parts[0].partType).toBe('text')
    expect(result.parts[1].partType).toBe('tool_call')
    expect(result.parts[2].partType).toBe('text')
  })

  it('text + tool_call + tool_result → cleanText has text + result excerpt, full fidelity in parts', () => {
    const longResult = 'The TypeScript configuration shows strict mode is enabled and all checks pass. ' +
      'Additional linting rules are configured for maximum type safety.'
    const content = [
      { type: 'text', text: 'Running the config check now.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'cat tsconfig.json' } },
      { type: 'tool_result', tool_use_id: 'tu_1', content: longResult },
    ]
    const result = parseContent(content)
    expect(result.cleanText).toContain('Running the config check now.')
    expect(result.cleanText).toContain('TypeScript configuration')
    // No tool call JSON in cleanText
    expect(result.cleanText).not.toContain('cat tsconfig.json')
    expect(result.parts).toHaveLength(3)
    expect(result.parts[1].partType).toBe('tool_call')
    expect(result.parts[1].toolInput).toEqual({ command: 'cat tsconfig.json' })
    expect(result.parts[2].partType).toBe('tool_result')
    expect(result.parts[2].textContent).toContain('TypeScript configuration')
  })

  it('ordinal values track position in original array', () => {
    const content = [
      { type: 'thinking', thinking: 'thinking...' },
      { type: 'text', text: 'response text' },
      { type: 'tool_use', name: 'Bash', input: {} },
    ]
    const result = parseContent(content)
    expect(result.parts[0].ordinal).toBe(0)
    expect(result.parts[1].ordinal).toBe(1)
    expect(result.parts[2].ordinal).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseContent — edge cases', () => {
  it('empty array → empty cleanText, no parts', () => {
    const result = parseContent([])
    expect(result.cleanText).toBe('')
    expect(result.parts).toHaveLength(0)
  })

  it('non-array, non-string input → converted to string', () => {
    const result = parseContent(42 as unknown as string)
    expect(result.cleanText).toBe('42')
    expect(result.parts[0].partType).toBe('other')
  })

  it('unknown block type → partType is other', () => {
    const content = [{ type: 'image', source: { type: 'base64', data: 'abc' } }]
    const result = parseContent(content)
    expect(result.parts[0].partType).toBe('image')
    expect(result.cleanText).toBe('')
  })

  it('array with no text parts → cleanText is empty', () => {
    const content = [
      { type: 'tool_use', name: 'Read', input: {} },
      { type: 'thinking', thinking: 'reasoning...' },
    ]
    const result = parseContent(content)
    expect(result.cleanText).toBe('')
    expect(result.parts).toHaveLength(2)
  })

  it('system metadata blocks stripped from text part', () => {
    const content = [
      {
        type: 'text',
        text: 'Conversation info (untrusted metadata):\n```\nsession: abc\n```\nReal message here.',
      },
    ]
    const result = parseContent(content)
    expect(result.cleanText).not.toContain('Conversation info')
    expect(result.cleanText).not.toContain('session: abc')
    expect(result.cleanText).toContain('Real message here')
  })
})
