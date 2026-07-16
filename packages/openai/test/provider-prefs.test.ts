import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the openai module before any imports that use it — captures request
// bodies so provider-preference injection is assertable per call site.
// ---------------------------------------------------------------------------

const mockChatCreate = vi.fn()
const mockEmbedCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockChatCreate } }
      embeddings = { create: mockEmbedCreate }
    },
  }
})

// Import after mocking
import { OpenAISummarizer } from '../src/summarizer.js'
import { openaiIntelligence } from '../src/index.js'

const PREFS = { order: ['baidu'], quantizations: ['fp8'] }

function chatResponse(content: string) {
  return { choices: [{ message: { content } }] }
}

describe('provider preferences pass-through', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('summarize() includes the provider object in the request body when configured', async () => {
    mockChatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({
      text: 't', topics: [], entities: [], decisions: [],
    })))
    const s = new OpenAISummarizer({ apiKey: 'k', providerPrefs: PREFS })
    await s.summarize('content', { mode: 'preserve_details', targetTokens: 100 })
    expect(mockChatCreate).toHaveBeenCalledTimes(1)
    expect(mockChatCreate.mock.calls[0]![0]).toMatchObject({ provider: PREFS })
  })

  it('selectEvidence() includes the provider object in the request body when configured', async () => {
    mockChatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ items: [] })))
    const s = new OpenAISummarizer({ apiKey: 'k', providerPrefs: PREFS })
    await s.selectEvidence('q', [{ index: 0, text: 'line' }], { mode: 'temporal' })
    expect(mockChatCreate).toHaveBeenCalledTimes(1)
    expect(mockChatCreate.mock.calls[0]![0]).toMatchObject({ provider: PREFS })
  })

  it('omits the provider key entirely when not configured', async () => {
    mockChatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({
      text: 't', topics: [], entities: [], decisions: [],
    })))
    const s = new OpenAISummarizer({ apiKey: 'k' })
    await s.summarize('content', { mode: 'preserve_details', targetTokens: 100 })
    expect('provider' in mockChatCreate.mock.calls[0]![0]).toBe(false)
  })

  it('openaiIntelligence forwards chatProviderPrefs to the summarizer', async () => {
    mockChatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({
      text: 't', topics: [], entities: [], decisions: [],
    })))
    const intel = openaiIntelligence({ apiKey: 'k', chatProviderPrefs: PREFS })
    await intel.summarize!('content', { mode: 'preserve_details', targetTokens: 100 })
    expect(mockChatCreate.mock.calls[0]![0]).toMatchObject({ provider: PREFS })
  })
})
