import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockChatCreate = vi.fn()
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockChatCreate } }
    },
  }
})

import { OpenAISummarizer } from '../src/summarizer.js'
import { openaiIntelligence } from '../src/index.js'

function makeChatResponse(content: string | null): { choices: { message: { content: string | null } }[] } {
  return { choices: [{ message: { content } }] }
}

const FACT = {
  topic: 'reranker',
  content: 'We switched the reranker to gte-reranker-modernbert-base.',
  statedAt: new Date('2026-09-28T08:15:00.000Z'),
}

const CANDIDATES = [
  {
    id: '0199a1b2-0000-7000-8000-000000000001',
    topic: 'reranker',
    content: 'The reranker is bge-reranker-v2-m3.',
    statedAt: new Date('2026-08-14T09:30:00.000Z'),
  },
  {
    id: '0199a1b2-0000-7000-8000-000000000002',
    topic: 'reranker',
    content: 'Reranker runs on gte-reranker-modernbert-base now.',
    statedAt: '2026-09-21T17:05:00.000Z',
  },
  {
    id: '0199a1b2-0000-7000-8000-000000000003',
    topic: 'embeddings',
    content: 'Embeddings use text-embedding-3-small at 1536 dimensions.',
    statedAt: new Date('2026-07-02T00:00:00.000Z'),
  },
]

const [OLD, DUP, OTHER] = CANDIDATES.map((c) => c.id) as [string, string, string]

type SentBody = {
  model: string
  temperature: number
  response_format?: { type: string }
  messages: Array<{ role: string; content: string }>
}

function sentBody(): SentBody {
  return mockChatCreate.mock.calls[0]![0] as SentBody
}

describe('OpenAISummarizer.judgeSupersession', () => {
  let stderr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => stderr.mockRestore())

  it('returns the same and conflicts lists and the kinds from a JSON verdict', async () => {
    mockChatCreate.mockResolvedValueOnce(
      makeChatResponse(
        JSON.stringify({
          conflicts: [OLD],
          same: [DUP],
          kinds: { new: 'event', [OLD]: 'state', [DUP]: 'event', [OTHER]: 'plan' },
        }),
      ),
    )
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    const verdict = await s.judgeSupersession(FACT, CANDIDATES)
    expect(verdict).toEqual({
      conflicts: [OLD],
      same: [DUP],
      kinds: { new: 'event', [OLD]: 'state', [DUP]: 'event', [OTHER]: 'plan' },
    })
    expect(stderr).not.toHaveBeenCalled()
  })

  it('reads a verdict wrapped in a fence with prose around it', async () => {
    mockChatCreate.mockResolvedValueOnce(
      makeChatResponse(`Here is the verdict:\n\`\`\`json\n{"conflicts": ["${OLD}"], "same": []}\n\`\`\`\nDone.`),
    )
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, CANDIDATES)).toEqual({ conflicts: [OLD], same: [], kinds: {} })
  })

  it('treats a missing list as empty', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify({ conflicts: [OLD] })))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, CANDIDATES)).toEqual({ conflicts: [OLD], same: [], kinds: {} })
  })

  it('drops ids that are not in the candidate set and non-string entries', async () => {
    mockChatCreate.mockResolvedValueOnce(
      makeChatResponse(
        JSON.stringify({
          conflicts: [OLD, '0199a1b2-0000-7000-8000-00000000dead', 7, null],
          same: ['candidate-2', DUP, { id: OTHER }],
        }),
      ),
    )
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, CANDIDATES)).toEqual({ conflicts: [OLD], same: [DUP], kinds: {} })
  })

  it('keeps only valid kinds of the new fact and known candidates', async () => {
    mockChatCreate.mockResolvedValueOnce(
      makeChatResponse(
        JSON.stringify({
          conflicts: [OLD],
          same: [],
          kinds: {
            new: 'State',
            [OLD]: 'state',
            [DUP]: 'current',
            [OTHER]: 7,
            '0199a1b2-0000-7000-8000-00000000dead': 'state',
          },
        }),
      ),
    )
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, CANDIDATES)).toEqual({ conflicts: [OLD], same: [], kinds: { [OLD]: 'state' } })
    expect(stderr).not.toHaveBeenCalled()
  })

  it.each([
    ['an array', ['state']],
    ['a string', 'state'],
    ['null', null],
  ])('keeps the lists and reads no kinds when kinds is %s', async (_label, kinds) => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify({ conflicts: [OLD], same: [], kinds })))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, CANDIDATES)).toEqual({ conflicts: [OLD], same: [], kinds: {} })
  })

  it('does not read inherited keys as kinds', async () => {
    mockChatCreate.mockResolvedValueOnce(
      makeChatResponse(`{"conflicts": ["${OLD}"], "same": [], "kinds": {"__proto__": {"new": "state"}}}`),
    )
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, CANDIDATES)).toEqual({ conflicts: [OLD], same: [], kinds: {} })
  })

  it('removes repeated ids and leaves an id named in both lists in neither', async () => {
    mockChatCreate.mockResolvedValueOnce(
      makeChatResponse(JSON.stringify({ conflicts: [OLD, OLD, DUP], same: [DUP, OTHER, OTHER] })),
    )
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, CANDIDATES)).toEqual({ conflicts: [OLD], same: [OTHER], kinds: {} })
  })

  it.each([
    ['prose without JSON', 'The first fact is replaced by the new one.'],
    ['truncated JSON', `{"conflicts": ["${OLD}"`],
    ['a list that is not an array', `{"conflicts": "${OLD}", "same": []}`],
    ['an object with neither list', '{"verdict": "conflicts"}'],
    ['a bare array', `["${OLD}"]`],
    ['an empty reply', ''],
    ['a null reply', null],
  ])('returns an empty verdict and warns once without content for %s', async (_label, reply) => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(reply))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, CANDIDATES)).toEqual({ conflicts: [], same: [], kinds: {} })
    expect(stderr).toHaveBeenCalledTimes(1)
    const line = String(stderr.mock.calls[0]![0])
    expect(line).toContain('judgeSupersession')
    for (const c of CANDIDATES) {
      expect(line).not.toContain(c.id)
      expect(line).not.toContain(c.content)
    }
    expect(line).not.toContain(FACT.content)
    if (reply) expect(line).not.toContain(reply)
  })

  it('makes no call when the candidate list is empty', async () => {
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    expect(await s.judgeSupersession(FACT, [])).toEqual({ conflicts: [], same: [], kinds: {} })
    expect(mockChatCreate).not.toHaveBeenCalled()
  })

  it('rejects when the model call fails', async () => {
    mockChatCreate.mockRejectedValueOnce(new Error('upstream 503'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await expect(s.judgeSupersession(FACT, CANDIDATES)).rejects.toThrow('upstream 503')
  })

  it('sends every candidate with its id and statement date, and the fact', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{"conflicts": [], "same": []}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await s.judgeSupersession(FACT, CANDIDATES)
    const user = sentBody().messages.find((m) => m.role === 'user')!.content
    expect(user).toContain(FACT.content)
    expect(user).toContain('2026-08-14T09:30:00.000Z')
    expect(user).toContain('2026-09-21T17:05:00.000Z')
    expect(user).toContain('2026-07-02T00:00:00.000Z')
    for (const c of CANDIDATES) {
      expect(user).toContain(c.id)
      expect(user).toContain(c.content)
      expect(user).toContain(c.topic)
    }
  })

  it('sends the fact with its statement date and makes no claim about which fact is newer', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{"same": [], "conflicts": []}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await s.judgeSupersession(FACT, CANDIDATES)
    const body = sentBody()
    const user = body.messages.find((m) => m.role === 'user')!.content
    const system = body.messages.find((m) => m.role === 'system')!.content
    expect(user).toContain('2026-09-28T08:15:00.000Z')
    for (const text of [user, system]) {
      expect(text).not.toMatch(/most recent|newest|newer|latest|replaces/i)
    }
  })

  it('marks an absent fact date as unknown', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{"same": [], "conflicts": []}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await s.judgeSupersession({ ...FACT, statedAt: null }, CANDIDATES)
    const user = sentBody().messages.find((m) => m.role === 'user')!.content
    expect(user).toContain('unknown date')
  })

  it('marks a candidate date that cannot be parsed as unknown', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{"conflicts": [], "same": []}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await s.judgeSupersession(FACT, [{ ...CANDIDATES[0]!, statedAt: 'not a date' }])
    const user = sentBody().messages.find((m) => m.role === 'user')!.content
    expect(user).toContain('unknown date')
    expect(user).not.toContain('Invalid Date')
  })

  it('uses the configured model, temperature 0, JSON output and a conservative prompt', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{"conflicts": [], "same": []}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key', model: 'deepseek/deepseek-v4-flash' })
    await s.judgeSupersession(FACT, CANDIDATES)
    const body = sentBody()
    expect(body.model).toBe('deepseek/deepseek-v4-flash')
    expect(body.temperature).toBe(0)
    expect(body.response_format).toEqual({ type: 'json_object' })
    const system = body.messages.find((m) => m.role === 'system')!.content
    expect(system).toContain('{"same": [], "conflicts": [], "kinds": {"new": "<kind>"')
    expect(system).toMatch(/unsure/i)
    expect(system).toMatch(/only JSON/i)
  })

  it('asks for a same-subject conflict and a state, event or plan label for every fact', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{"conflicts": [], "same": [], "kinds": {}}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await s.judgeSupersession(FACT, CANDIDATES)
    const system = sentBody().messages.find((m) => m.role === 'system')!.content
    expect(system).toContain('the current value of the same attribute of the same subject')
    expect(system).toMatch(/different review, run, release, PR aspect, workload or component is a different subject/)
    for (const kind of ['"state"', '"event"', '"plan"']) expect(system).toContain(kind)
    expect(system).toContain('the key "new"')
  })

  it('defines a decision in force as a state and lists no decision among events', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{"conflicts": [], "same": [], "kinds": {}}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await s.judgeSupersession(FACT, CANDIDATES)
    const system = sentBody().messages.find((m) => m.role === 'system')!.content
    const definition = (kind: string): string => system.split('\n').find((line) => line.startsWith(`- "${kind}":`))!

    expect(definition('state')).toContain('a decision or choice in force')
    expect(definition('state')).toContain('"Decided to use X" is a state.')
    expect(definition('event')).toContain('a one-off happening')
    expect(definition('event')).not.toMatch(/decid/i)
    expect(system).not.toContain('decided then')
  })
})

describe('openaiIntelligence.judgeSupersession', () => {
  beforeEach(() => vi.clearAllMocks())

  it('delegates to the summarizer', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify({ conflicts: [OLD], same: [] })))
    const adapter = openaiIntelligence({ apiKey: 'test-key' })
    expect(await adapter.judgeSupersession!(FACT, CANDIDATES)).toEqual({ conflicts: [OLD], same: [], kinds: {} })
    expect(mockChatCreate).toHaveBeenCalledTimes(1)
  })
})
