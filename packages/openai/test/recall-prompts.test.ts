/**
 * Recall caches what the HyDE and expansion prompts return under a key that
 * includes RECALL_STEP_PROMPT_VERSION, so the prompt texts are pinned here: a
 * change to either one fails this test until the version is raised and the
 * pins are updated. The summarizer's own callers, which pass no temperature,
 * still send the temperatures they always did.
 */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockChatCreate = vi.fn()

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockChatCreate } }
  },
}))

import {
  DEFAULT_EMBEDDING_MODEL,
  HYDE_SYSTEM_PROMPT,
  OpenAISummarizer,
  RECALL_STEP_PROMPT_VERSION,
  expansionSystemPrompt,
  openaiIntelligence,
} from '../src/index.js'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const BUMP = `a recall prompt changed: raise RECALL_STEP_PROMPT_VERSION (now ${RECALL_STEP_PROMPT_VERSION}) and update this pin`

function reply(content: string) {
  return { choices: [{ message: { content } }] }
}

describe('recall prompt pins', () => {
  it('pins the HyDE prompt', () => {
    expect(sha256(HYDE_SYSTEM_PROMPT), BUMP).toBe('1e958f9d0b08c6be9e61fcc00556a293ad8be9177be41538c019e9222cba20be')
  })

  it('pins the expansion prompt for a fixed instant and zone', () => {
    expect(sha256(expansionSystemPrompt(new Date('2026-01-05T12:00:00Z'), 'UTC')), BUMP).toBe(
      '6a493a1b4d8ec9c8a8127ade8c3c9866ecef7081b3ff51d1057ab4f843be1fd8',
    )
  })

  it('names the version and the default embedding model', () => {
    expect(RECALL_STEP_PROMPT_VERSION).toBe(1)
    expect(DEFAULT_EMBEDDING_MODEL).toBe('text-embedding-3-small')
  })
})

describe('temperatures', () => {
  beforeEach(() => {
    mockChatCreate.mockReset()
  })

  it('sends 0.7 for HyDE and 0.5 for expansion when no temperature is given', async () => {
    mockChatCreate.mockResolvedValueOnce(reply('A passage about the deploy.'))
    mockChatCreate.mockResolvedValueOnce(reply('["deploy"]'))
    const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
    await summarizer.generateHypotheticalDoc('how do we deploy?')
    await summarizer.expandQuery('how do we deploy?')
    expect(mockChatCreate.mock.calls.map((c) => (c[0] as { temperature: number }).temperature)).toEqual([0.7, 0.5])
  })

  it('sends the given temperature and the same HyDE messages', async () => {
    mockChatCreate.mockResolvedValueOnce(reply('A passage about the deploy.'))
    mockChatCreate.mockResolvedValueOnce(reply('["deploy"]'))
    const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
    await summarizer.generateHypotheticalDoc('how do we deploy?', { temperature: 0 })
    await summarizer.expandQuery('how do we deploy?', { temperature: 0 })
    const [hyde, expand] = mockChatCreate.mock.calls.map((c) => c[0] as { temperature: number; messages: unknown[] })
    expect(hyde!.temperature).toBe(0)
    expect(expand!.temperature).toBe(0)
    expect(hyde!.messages).toEqual([
      { role: 'system', content: HYDE_SYSTEM_PROMPT },
      { role: 'user', content: 'how do we deploy?' },
    ])
  })

  it('forwards the HyDE options through the intelligence adapter', async () => {
    mockChatCreate.mockResolvedValueOnce(reply('A passage about the deploy.'))
    const intelligence = openaiIntelligence({ apiKey: 'test-key' })
    await intelligence.generateHypotheticalDoc!('how do we deploy?', { temperature: 0 })
    expect((mockChatCreate.mock.calls[0]![0] as { temperature: number }).temperature).toBe(0)
  })
})
