import { describe, it, expect } from 'vitest'

import { extractJsonReply } from '../../src/utils/json-reply.js'

// A string value that carries a fenced JSON-looking snippet: cutting the reply
// at its fences yields `[1,2]`, a parseable value of the wrong shape.
const BACKTICKS = 'Run ```[1,2]``` through the formatter before every deploy.'
const BRACKETS = 'Close the } brace and the ] bracket before the next block.'
const PLAIN = 'The ingest worker runs from a systemd timer, not pm2 cron.'

/** Reply shapes seen from chat models, each built around the payload JSON `j`. */
const SHAPES: Array<[label: string, text: string, wrap: (j: string) => string]> = [
  ['plain JSON', PLAIN, (j) => j],
  ['plain JSON with ``` inside a string value', BACKTICKS, (j) => j],
  ['plain JSON with } and ] inside a string value', BRACKETS, (j) => j],
  ['a whole-reply ```json fence', PLAIN, (j) => `\n\`\`\`json\n${j}\n\`\`\`\n`],
  ['a bare fence', PLAIN, (j) => `\`\`\`\n${j}\n\`\`\``],
  ['a fence with prose before', PLAIN, (j) => `See note [1] below:\n\`\`\`json\n${j}\n\`\`\``],
  ['a fence with prose after', PLAIN, (j) => `\`\`\`json\n${j}\n\`\`\`\nAsk if you need more (see [2]).`],
  [
    'two fences where the first is not JSON',
    PLAIN,
    (j) => `First run:\n\`\`\`bash\necho [x]\n\`\`\`\nThen the result:\n\`\`\`json\n${j}\n\`\`\``,
  ],
  ['prose with a bare JSON value in the middle', BRACKETS, (j) => `Here is the result: ${j} and that is all.`],
  // A parseable bracket in the prose ahead of the payload must not shadow it.
  ['a citation [1] before the payload', PLAIN, (j) => `Per the rules [1], here is the verdict: ${j}`],
  ['an empty example [] before the payload', PLAIN, (j) => `Example [] then ${j}`],
]

const anyValue = (): boolean => true
const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)

describe('extractJsonReply', () => {
  it.each(SHAPES)('reads %s', (_label, text, wrap) => {
    const payload = { text, n: 1 }

    expect(extractJsonReply(wrap(JSON.stringify(payload)), isObject)).toEqual(payload)
  })

  it('skips escaped quotes inside a string when scanning for the span', () => {
    expect(extractJsonReply('Result: {"a": "say \\"}\\" now", "b": [1]} done', anyValue)).toEqual({
      a: 'say "}" now',
      b: [1],
    })
  })

  it('takes the first span that parses when earlier brackets do not', () => {
    expect(extractJsonReply('Options [a, b]: {"ok": true}', anyValue)).toEqual({ ok: true })
  })

  it('walks past parseable spans of the wrong shape to the first accepted one', () => {
    expect(extractJsonReply('See [1] and [] then {"ok": true} or {"ok": false}', isObject)).toEqual({ ok: true })
  })

  it('throws when values parse but none has the accepted shape', () => {
    expect(() => extractJsonReply('Per the rules [1] and [2].', isObject)).toThrow(/expected shape/)
  })

  it('passes over parsed values the caller does not accept', () => {
    const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.some((i) => typeof i === 'string')
    expect(extractJsonReply('{"terms": ["Alice", "Bob"]}', isStringArray)).toEqual(['Alice', 'Bob'])
  })

  it.each([
    ['an empty reply', '   '],
    ['prose only', 'nothing structured here'],
    ['an unclosed object', '{"a": 1'],
    ['mismatched brackets', '{"a": [1}'],
  ])('throws on %s', (_label, raw) => {
    expect(() => extractJsonReply(raw, anyValue)).toThrow(/JSON value/)
  })
})
