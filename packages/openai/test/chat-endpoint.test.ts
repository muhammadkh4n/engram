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
