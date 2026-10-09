import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockChatCreate = vi.fn()

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockChatCreate } }
    embeddings = { create: vi.fn() }
  },
}))

import { OpenAISummarizer } from '../src/summarizer.js'
import { openaiIntelligence } from '../src/index.js'

const REQ = { label: 'extract', system: 'the system prompt', user: 'the user message', maxTokens: 1160 }
const PREFS = { order: ['tst-host'], quantizations: ['fp8'] }

function chatResponse(content: string | null, finishReason: string | null = 'stop', model = 'tst-model-v1') {
  return { model, choices: [{ message: { content }, finish_reason: finishReason }] }
}

describe('completeJson', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('sends both messages at temperature 0 in JSON mode with the given max_tokens', async () => {
    mockChatCreate.mockResolvedValueOnce(chatResponse('{"statements":[],"observations":[]}'))
    const s = new OpenAISummarizer({ apiKey: 'k', model: 'tst-chat-model' })

    await s.completeJson(REQ)

    expect(mockChatCreate).toHaveBeenCalledTimes(1)
    expect(mockChatCreate.mock.calls[0]![0]).toEqual({
      model: 'tst-chat-model',
      messages: [
        { role: 'system', content: 'the system prompt' },
        { role: 'user', content: 'the user message' },
      ],
      max_tokens: 1160,
      temperature: 0,
      response_format: { type: 'json_object' },
    })
  })

  it('returns the reply text unparsed, with its finish reason and the answering model', async () => {
    const text = '```json\n{"statements": [], "observations": []}\n```'
    mockChatCreate.mockResolvedValueOnce(chatResponse(text, 'length', 'tst-provider/model'))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.completeJson(REQ)).resolves.toEqual({
      text,
      finishReason: 'length',
      model: 'tst-provider/model',
    })
  })

  it('returns an empty text and a null finish reason when the reply carries neither', async () => {
    mockChatCreate.mockResolvedValueOnce({ model: '', choices: [{ message: { content: null } }] })
    const s = new OpenAISummarizer({ apiKey: 'k', model: 'tst-chat-model' })

    await expect(s.completeJson(REQ)).resolves.toEqual({ text: '', finishReason: null, model: 'tst-chat-model' })
  })

  it('lets an SDK error propagate unchanged', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 })
    mockChatCreate.mockRejectedValueOnce(err)
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.completeJson(REQ)).rejects.toBe(err)
  })

  it('carries the provider preferences and reasoning off into the request body', async () => {
    mockChatCreate.mockResolvedValueOnce(chatResponse('{}'))
    const s = new OpenAISummarizer({ apiKey: 'k', providerPrefs: PREFS, reasoning: 'off' })

    await s.completeJson(REQ)

    expect(mockChatCreate.mock.calls[0]![0]).toMatchObject({
      provider: PREFS,
      reasoning: { effort: 'none' },
      max_tokens: 1160,
    })
  })

  it('is wired through openaiIntelligence with the chat options', async () => {
    mockChatCreate.mockResolvedValueOnce(chatResponse('{}'))
    const intel = openaiIntelligence({ apiKey: 'k', chatProviderPrefs: PREFS, chatReasoning: 'off' })

    await expect(intel.completeJson!(REQ)).resolves.toMatchObject({ text: '{}', finishReason: 'stop' })
    expect(mockChatCreate.mock.calls[0]![0]).toMatchObject({
      provider: PREFS,
      reasoning: { effort: 'none' },
      temperature: 0,
      response_format: { type: 'json_object' },
    })
  })
})
