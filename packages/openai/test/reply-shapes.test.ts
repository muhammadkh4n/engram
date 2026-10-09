import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockChatCreate = vi.fn()

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockChatCreate } }
  },
}))

import { OpenAISummarizer } from '../src/summarizer.js'

const TURN = 'We moved the ingest worker to a systemd timer and removed the pm2 cron entry.'

function reply(content: string): { choices: { message: { content: string } }[] } {
  return { choices: [{ message: { content } }] }
}

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

const PROSE_ONLY = 'I think this one should be stored because it records a decision.'

interface ParserCase {
  name: string
  payload: (text: string) => unknown
  run: (s: OpenAISummarizer) => Promise<unknown>
  expected: (text: string) => unknown
  proseOnly: (s: OpenAISummarizer) => Promise<void>
}

const PARSERS: ParserCase[] = [
  {
    name: 'parseSalience',
    payload: (text) => ({ store: true, category: 'decision', confidence: 0.8, distilled: text, reason: 'infra' }),
    run: (s) => s.extractSalience(TURN, { turnRole: 'user' }),
    expected: (text) => ({ store: true, category: 'decision', confidence: 0.8, distilled: text, reason: 'infra' }),
    proseOnly: async (s) => {
      await expect(s.extractSalience(TURN, { turnRole: 'user' })).rejects.toThrow(
        /extractSalience: unparseable classifier output/,
      )
    },
  },
  {
    name: 'parseSummaryResult',
    payload: (text) => ({ text, topics: ['ingest'], entities: ['pm2'], decisions: ['use systemd'] }),
    run: (s) => s.summarize('source content', { mode: 'preserve_details', targetTokens: 200 }),
    expected: (text) => ({ text, topics: ['ingest'], entities: ['pm2'], decisions: ['use systemd'] }),
    proseOnly: async (s) => {
      await expect(s.summarize('source content', { mode: 'preserve_details', targetTokens: 200 })).rejects.toThrow(
        /summarize: reply holds no JSON object/,
      )
    },
  },
]

describe.each(PARSERS)('$name reads every reply shape', (parser) => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it.each(SHAPES)('%s', async (_label, text, wrap) => {
    mockChatCreate.mockResolvedValueOnce(reply(wrap(JSON.stringify(parser.payload(text)))))

    await expect(parser.run(new OpenAISummarizer({ apiKey: 'k' }))).resolves.toEqual(parser.expected(text))
  })

  it('prose only fails the way the parser defines', async () => {
    mockChatCreate.mockResolvedValueOnce(reply(PROSE_ONLY))

    await parser.proseOnly(new OpenAISummarizer({ apiKey: 'k' }))
  })
})
