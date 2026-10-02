import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the openai module before any imports that use it — this variant
// captures constructor options so endpoint routing is assertable.
// ---------------------------------------------------------------------------

const ctorOpts: Array<Record<string, unknown>> = []
const mockChatCreate = vi.fn()
const mockEmbedCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockChatCreate } }
      embeddings = { create: mockEmbedCreate }
      constructor(opts: Record<string, unknown>) {
        ctorOpts.push(opts)
      }
    },
  }
})

// Import after mocking
import { OpenAISummarizer } from '../src/summarizer.js'
import { openaiIntelligence } from '../src/index.js'

describe('chat endpoint override', () => {
  beforeEach(() => {
    ctorOpts.length = 0
    vi.clearAllMocks()
  })

  it('OpenAISummarizer passes baseURL through to the OpenAI client', () => {
    void new OpenAISummarizer({ apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1' })
    expect(ctorOpts).toHaveLength(1)
    expect(ctorOpts[0]).toEqual({ apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1' })
  })

  it('OpenAISummarizer omits baseURL entirely when not set (SDK default endpoint)', () => {
    void new OpenAISummarizer({ apiKey: 'k' })
    expect(ctorOpts).toHaveLength(1)
    expect('baseURL' in ctorOpts[0]!).toBe(false)
  })

  it('openaiIntelligence routes chatApiKey/chatBaseUrl to the summarizer only; embeddings stay on the default endpoint', () => {
    void openaiIntelligence({
      apiKey: 'openai-key',
      chatApiKey: 'router-key',
      chatBaseUrl: 'https://openrouter.ai/api/v1',
      summarizationModel: 'deepseek/deepseek-v4-flash',
    })
    // The factory constructs the embedder first, then the summarizer.
    expect(ctorOpts).toHaveLength(2)
    expect(ctorOpts[0]).toEqual({ apiKey: 'openai-key' })
    expect(ctorOpts[1]).toEqual({ apiKey: 'router-key', baseURL: 'https://openrouter.ai/api/v1' })
  })

  it('openaiIntelligence defaults the chat key to apiKey when chatApiKey is absent', () => {
    void openaiIntelligence({ apiKey: 'shared-key', chatBaseUrl: 'https://openrouter.ai/api/v1' })
    expect(ctorOpts).toHaveLength(2)
    expect(ctorOpts[1]).toEqual({ apiKey: 'shared-key', baseURL: 'https://openrouter.ai/api/v1' })
  })
})

// ---------------------------------------------------------------------------
// Reasoning control. Reasoning models count reasoning tokens against
// max_tokens, so small caps can leave the visible reply empty; the summarizer
// can switch reasoning off or add headroom to every cap.
// ---------------------------------------------------------------------------

function chatReply(content: string | null, extra: Record<string, unknown> = {}) {
  return { choices: [{ message: { content }, finish_reason: 'stop', ...extra }] }
}

const SUMMARY_JSON = JSON.stringify({ text: 't', topics: [], entities: [], decisions: [] })

async function callEverySite(s: OpenAISummarizer): Promise<Array<Record<string, unknown>>> {
  mockChatCreate.mockResolvedValueOnce(chatReply('["a"]'))
  await s.expandQuery('what did Alice say')
  mockChatCreate.mockResolvedValueOnce(chatReply('Alice said hi'))
  await s.generateHypotheticalDoc('what did Alice say')
  mockChatCreate.mockResolvedValueOnce(chatReply('Alice is speaking.'))
  await s.contextualizeChunk('chunk text', { conversationContext: 'prior turns' })
  mockChatCreate.mockResolvedValueOnce(chatReply('{"store":false,"category":"none"}'))
  await s.extractSalience('a turn that is long enough to classify for salience', { turnRole: 'user' })
  mockChatCreate.mockResolvedValueOnce(chatReply(SUMMARY_JSON))
  await s.summarize('content', { mode: 'preserve_details', targetTokens: 100 })
  mockChatCreate.mockResolvedValueOnce(chatReply('{"items":[]}'))
  await s.selectEvidence('when did Alice call', [{ index: 0, text: 'Alice called on Monday' }], { mode: 'temporal' })
  mockChatCreate.mockResolvedValueOnce(chatReply('{"scores":[{"id":"a","score":0.9},{"id":"b","score":0.1}]}'))
  await s.rerank('Alice', [{ id: 'a', content: 'Alice note' }, { id: 'b', content: 'Bob note' }])
  mockChatCreate.mockResolvedValueOnce(chatReply('{"entities":[]}'))
  await s.extractEntities('Alice met Bob at the Lisbon office on Monday morning.')
  mockChatCreate.mockResolvedValueOnce(chatReply('[]'))
  await s.extractKnowledge('Alice prefers tea over coffee.')
  return mockChatCreate.mock.calls.map((c) => c[0] as Record<string, unknown>)
}

describe('chat reasoning control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChatCreate.mockReset()
  })

  it('unset: no reasoning key and the historical caps', async () => {
    const bodies = await callEverySite(new OpenAISummarizer({ apiKey: 'k' }))
    expect(bodies).toHaveLength(9)
    for (const b of bodies) expect('reasoning' in b).toBe(false)
    expect(bodies.map((b) => b['max_tokens'])).toEqual([100, 180, 80, 400, 500, 400, 400, 500, 1000])
  })

  it("'off': sends reasoning effort none on every call site, caps unchanged, provider still merged", async () => {
    const prefs = { order: ['baidu'] }
    const bodies = await callEverySite(
      new OpenAISummarizer({ apiKey: 'k', reasoning: 'off', providerPrefs: prefs }),
    )
    expect(bodies).toHaveLength(9)
    for (const b of bodies) {
      expect(b['reasoning']).toEqual({ effort: 'none' })
      expect(b['provider']).toEqual(prefs)
    }
    expect(bodies.map((b) => b['max_tokens'])).toEqual([100, 180, 80, 400, 500, 400, 400, 500, 1000])
  })

  it("'default': every cap raised by the default 2048-token headroom, no reasoning key", async () => {
    const bodies = await callEverySite(new OpenAISummarizer({ apiKey: 'k', reasoning: 'default' }))
    for (const b of bodies) expect('reasoning' in b).toBe(false)
    expect(bodies.map((b) => b['max_tokens'])).toEqual([2148, 2228, 2128, 2448, 2548, 2448, 2448, 2548, 3048])
  })

  it("'default': honours a configured headroom", async () => {
    const bodies = await callEverySite(
      new OpenAISummarizer({ apiKey: 'k', reasoning: 'default', reasoningHeadroom: 1000 }),
    )
    expect(bodies[0]!['max_tokens']).toBe(1100)
    expect(bodies[2]!['max_tokens']).toBe(1080)
  })

  it('rejects a headroom that is not a non-negative integer, accepts 0', () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new OpenAISummarizer({ apiKey: 'k', reasoning: 'default', reasoningHeadroom: bad })).toThrow(
        /reasoningHeadroom must be a non-negative integer/,
      )
    }
    expect(() => new OpenAISummarizer({ apiKey: 'k', reasoning: 'default', reasoningHeadroom: 0 })).not.toThrow()
  })

  it('openaiIntelligence forwards chatReasoning and chatReasoningHeadroom', async () => {
    mockChatCreate.mockResolvedValueOnce(chatReply('["a"]'))
    const intel = openaiIntelligence({ apiKey: 'k', chatReasoning: 'default', chatReasoningHeadroom: 10 })
    await intel.expandQuery!('q')
    expect(mockChatCreate.mock.calls[0]![0]).toMatchObject({ max_tokens: 110 })
    mockChatCreate.mockResolvedValueOnce(chatReply('["a"]'))
    const off = openaiIntelligence({ apiKey: 'k', chatReasoning: 'off' })
    await off.expandQuery!('q')
    expect(mockChatCreate.mock.calls[1]![0]).toMatchObject({ reasoning: { effort: 'none' } })
  })

  it('openaiIntelligence forwards timeZone and the expansion reference date', async () => {
    mockChatCreate.mockResolvedValueOnce(chatReply('["a"]'))
    const intel = openaiIntelligence({ apiKey: 'k', timeZone: 'Asia/Karachi' })
    await intel.expandQuery!('q', { now: new Date('2026-10-01T22:00:00Z') })
    const body = mockChatCreate.mock.calls[0]![0] as { messages: Array<{ content: string }> }
    expect(body.messages[0]!.content.split('\n')[0]).toBe("Today's date is Friday, 2026-10-02.")
    expect(() => openaiIntelligence({ apiKey: 'k', timeZone: 'Not/AZone' })).toThrow(/not a valid IANA time zone name/)
  })

  it("finish_reason 'length' writes exactly one stderr line with the label and reasoning count, no content", async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      mockChatCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'SECRET-ish partial hypothetical' }, finish_reason: 'length' }],
        usage: { completion_tokens: 180, completion_tokens_details: { reasoning_tokens: 170 } },
      })
      await new OpenAISummarizer({ apiKey: 'k' }).generateHypotheticalDoc('q')
      const lines = write.mock.calls.map((c) => String(c[0]))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toBe(
        '[openai] generateHypotheticalDoc output hit max_tokens (visible_chars=31, reasoning_tokens=170)\n',
      )
      expect(lines[0]).not.toContain('SECRET')
    } finally {
      write.mockRestore()
    }
  })

  it("finish_reason 'length' without usage details reports reasoning_tokens=n/a", async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      mockChatCreate.mockResolvedValueOnce({
        choices: [{ message: { content: null }, finish_reason: 'length' }],
      })
      await new OpenAISummarizer({ apiKey: 'k' }).expandQuery('q')
      const lines = write.mock.calls.map((c) => String(c[0]))
      expect(lines).toEqual(['[openai] expandQuery output hit max_tokens (visible_chars=0, reasoning_tokens=n/a)\n'])
    } finally {
      write.mockRestore()
    }
  })

  it('a normal finish writes nothing to stderr', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      mockChatCreate.mockResolvedValueOnce(chatReply('["a"]'))
      await new OpenAISummarizer({ apiKey: 'k' }).expandQuery('q')
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })
})
