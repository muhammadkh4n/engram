/**
 * `maybeWithRecallEngine` — opt-in recall-engine wiring for the MCP server.
 *
 * Mirrors the shape of `maybeWithLocalRerank` (env-gated, dynamic import,
 * warn-and-fallback), with one MCP-specific hardening: `exactRescore` is
 * ALWAYS forced true regardless of `ENGRAM_ENGINE_EXACT`, because
 * write-suppression thresholds compare similarity scores
 * against a fixed cutoff and must never see a tier-2 quantized estimate
 * instead of true float cosine. These tests exercise the wiring decision
 * itself via env manipulation — no Supabase/OpenAI network access, no real
 * corpus (the engine's cold-start rebuild is exercised in
 * `packages/recall-engine/test/decorator.test.ts` instead).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { StorageAdapter } from '@engram-mem/core'
import { recallEngineOf } from '@engram-mem/recall-engine'
import type { ForgetPreview, ForgetByIdsResult, RecallResult } from '@engram-mem/core'
import { vectorUnavailableNotice } from '@engram-mem/core'
import {
  maybeWithRecallEngine,
  formatRecallTimingLine,
  recallOptionsFromArgs,
  RECALL_CONVERSATION_ID_MAX,
  parseChatReasoningEnv,
  parseTimeZoneEnv,
  chatIntelligenceOptionsFromEnv,
  supersessionSettingsAtStartup,
  runMemoryForget,
  runMemoryRecall,
  RECALL_BUDGET_TOO_SMALL,
  parseSalienceThresholdEnv,
  parseExtractWindowsPerTickEnv,
  captureModelFromEnv,
  sharedInit,
  CONSOLIDATION_WORKER_CYCLES,
  recallOutputPolicyAtStartup,
  getMemory,
  RECALL_TOKEN_BUDGET_MIN,
  RECALL_TOKEN_BUDGET_MAX,
} from '../src/server-core.js'

const ENV_KEYS = ['ENGRAM_RECALL_ENGINE', 'ENGRAM_ENGINE_EXACT'] as const

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
}

function fakeStorage(): StorageAdapter {
  // Nothing in maybeWithRecallEngine / withRecallEngine's construction path
  // touches the adapter's members eagerly (episodes/digests/etc are lazy
  // getters, warm() is fire-and-forget from initialize()) — an empty stub is
  // enough to exercise the wrapping decision itself.
  return {} as StorageAdapter
}

describe('maybeWithRecallEngine', () => {
  const before = snapshotEnv()
  afterEach(() => restoreEnv(before))

  it('passes storage through unchanged when ENGRAM_RECALL_ENGINE is unset (null-config passthrough)', async () => {
    delete process.env['ENGRAM_RECALL_ENGINE']
    delete process.env['ENGRAM_ENGINE_EXACT']
    const storage = fakeStorage()

    const result = await maybeWithRecallEngine(storage, 'https://example.supabase.co')

    expect(result).toBe(storage)
    expect(recallEngineOf(result)).toBeUndefined()
  })

  it('passes storage through unchanged when ENGRAM_RECALL_ENGINE is any value other than "true"', async () => {
    process.env['ENGRAM_RECALL_ENGINE'] = 'false'
    const storage = fakeStorage()

    const result = await maybeWithRecallEngine(storage, 'https://example.supabase.co')

    expect(result).toBe(storage)
  })

  it('wraps storage with a real RecallEngine when ENGRAM_RECALL_ENGINE=true', async () => {
    process.env['ENGRAM_RECALL_ENGINE'] = 'true'
    const storage = fakeStorage()

    const result = await maybeWithRecallEngine(storage, 'https://example.supabase.co')

    expect(result).not.toBe(storage)
    expect(recallEngineOf(result)).toBeDefined()
  })

  it('forces exactRescore=true and warns when ENGRAM_ENGINE_EXACT=false is explicitly set', async () => {
    process.env['ENGRAM_RECALL_ENGINE'] = 'true'
    process.env['ENGRAM_ENGINE_EXACT'] = 'false'
    const warnSpy: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnSpy.push(args.map(String).join(' ')) }

    try {
      const result = await maybeWithRecallEngine(fakeStorage(), 'https://example.supabase.co')
      expect(recallEngineOf(result)).toBeDefined()
    } finally {
      console.warn = originalWarn
    }

    expect(warnSpy.some(msg => msg.includes('ENGRAM_ENGINE_EXACT=false is refused under MCP'))).toBe(true)
  })

  it('does not warn about forced-exact when ENGRAM_ENGINE_EXACT is unset (default already true)', async () => {
    process.env['ENGRAM_RECALL_ENGINE'] = 'true'
    delete process.env['ENGRAM_ENGINE_EXACT']
    const warnSpy: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnSpy.push(args.map(String).join(' ')) }

    try {
      await maybeWithRecallEngine(fakeStorage(), 'https://example.supabase.co')
    } finally {
      console.warn = originalWarn
    }

    expect(warnSpy.some(msg => msg.includes('refused under MCP'))).toBe(false)
  })
})

describe('formatRecallTimingLine', () => {
  it('prints stages in fixed order with integer ms and omits absent stages', () => {
    const line = formatRecallTimingLine(
      { format: 0.4, rerank: 812.6, search: 95.2, total: 1203.49, expand: 240.5, graph: 40.1 },
      12,
      4810,
    )

    expect(line).toBe('[recall] total=1203 expand=241 search=95 rerank=813 graph=40 items=12 chars=4810')
  })

  it('prints only total and counts when no optional stage ran', () => {
    expect(formatRecallTimingLine({ total: 3.2 }, 0, 0)).toBe('[recall] total=3 items=0 chars=0')
  })

  it('marks a failed lexical leg as lexical=error', () => {
    expect(formatRecallTimingLine({ total: 3.2, search: 1.1, lexicalError: 1 }, 2, 40)).toBe(
      '[recall] total=3 search=1 lexical=error items=2 chars=40',
    )
  })

  it('marks a recall without a query embedding as degraded=vector', () => {
    expect(formatRecallTimingLine({ total: 3.2, search: 1.1, vectorError: 1 }, 2, 40)).toBe(
      '[recall] total=3 search=1 degraded=vector items=2 chars=40',
    )
  })

  it('prints pattern and mmr in order, then graph sub-stages sorted', () => {
    const line = formatRecallTimingLine(
      { 'graph.walk': 7.2, mmr: 3.4, graph: 20, total: 100, 'graph.community': 9.6, pattern: 1.2, rerank: 50 },
      30,
      900,
    )

    expect(line).toBe(
      '[recall] total=100 pattern=1 mmr=3 rerank=50 graph=20 graph.community=10 graph.walk=7 items=30 chars=900',
    )
  })

  it('appends the emitted count and estimated tokens after the pool count', () => {
    const line = formatRecallTimingLine({ total: 10, mmr: 2 }, 30, 4000, { emitted: 12, tokens: 1000, truncated: false })

    expect(line).toBe('[recall] total=10 mmr=2 items=30 chars=4000 emitted=12 tokens=1000')
  })

  it('marks a payload cut by the token budget with truncated=1', () => {
    const line = formatRecallTimingLine({ total: 10 }, 30, 2000, { emitted: 5, tokens: 500, truncated: true })

    expect(line).toBe('[recall] total=10 items=30 chars=2000 emitted=5 tokens=500 truncated=1')
  })
})

describe('recallOptionsFromArgs', () => {
  it('passes conversation_id through as the priming key, trimmed', () => {
    expect(recallOptionsFromArgs({ query: 'q', conversation_id: '  conv-1  ' })).toEqual({ conversationKey: 'conv-1' })
  })

  it('accepts a conversation_id of exactly the maximum length', () => {
    const id = 'c'.repeat(RECALL_CONVERSATION_ID_MAX)
    expect(recallOptionsFromArgs({ query: 'q', conversation_id: id })).toEqual({ conversationKey: id })
  })

  it('never turns session_id into a priming key', () => {
    expect(recallOptionsFromArgs({ query: 'q', session_id: 'sess-1' })).toEqual({})
  })

  it.each(['', '   ', 42, null, 'c'.repeat(RECALL_CONVERSATION_ID_MAX + 1)])(
    'rejects conversation_id %j',
    (value) => {
      const opts = recallOptionsFromArgs({ query: 'q', conversation_id: value })

      expect(opts).toHaveProperty('error')
      expect((opts as { error: string }).error).toMatch(/conversation_id must be a non-blank string of at most 200 characters/)
    },
  )

  it('trims the project id the way stored project tags were written', () => {
    expect(recallOptionsFromArgs({ query: 'q', project_id: '  engram  ' })).toEqual({ projectId: 'engram' })
  })

  it('treats blank and shared aliases as no project', () => {
    for (const alias of ['', '   ', 'global', 'none', 'shared', 'GLOBAL']) {
      expect(recallOptionsFromArgs({ query: 'q', project_id: alias })).toEqual({})
    }
  })

  it('ignores a non-string project id and passes synthesize through', () => {
    expect(recallOptionsFromArgs({ query: 'q', project_id: 42, synthesize: true })).toEqual({ synthesize: true })
  })

  it('passes token_budget through as tokenBudget at both bounds', () => {
    expect(recallOptionsFromArgs({ query: 'q', token_budget: RECALL_TOKEN_BUDGET_MIN })).toEqual({ tokenBudget: 256 })
    expect(recallOptionsFromArgs({ query: 'q', token_budget: RECALL_TOKEN_BUDGET_MAX, project_id: 'engram' })).toEqual({
      projectId: 'engram',
      tokenBudget: 32000,
    })
  })

  it.each([255, 32001, 0, -1, 1000.5, '2000', null, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects token_budget %s',
    (value) => {
      const opts = recallOptionsFromArgs({ query: 'q', token_budget: value })

      expect(opts).toHaveProperty('error')
      expect((opts as { error: string }).error).toMatch(/token_budget must be an integer from 256 to 32000/)
    },
  )
})

describe('recallOutputPolicyAtStartup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves the unbounded policy when nothing is set and logs numbers only', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(recallOutputPolicyAtStartup({})).toEqual({ faint: true })
    expect(errorSpy).toHaveBeenCalledWith(
      '[engram-mcp] recall output policy: emitK=unbounded tokenBudget=unbounded faint=on ' +
        'relatedShare=0.3 itemMaxTokens=unbounded',
    )
  })

  it('resolves and logs a configured policy', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = { ENGRAM_RECALL_EMIT_K: '12', ENGRAM_RECALL_TOKEN_BUDGET: '4000', ENGRAM_RECALL_FAINT: 'off' }

    expect(recallOutputPolicyAtStartup(env)).toEqual({ emitK: 12, tokenBudget: 4000, faint: false })
    expect(errorSpy).toHaveBeenCalledWith(
      '[engram-mcp] recall output policy: emitK=12 tokenBudget=4000 faint=off relatedShare=0.3 itemMaxTokens=1000',
    )
  })

  it('logs a configured Related share and item cap', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = {
      ENGRAM_RECALL_TOKEN_BUDGET: '4000',
      ENGRAM_RECALL_RELATED_SHARE: '0.45',
      ENGRAM_RECALL_ITEM_MAX_TOKENS: '700',
    }

    expect(recallOutputPolicyAtStartup(env)).toEqual({
      tokenBudget: 4000,
      relatedShare: 0.45,
      itemMaxTokens: 700,
      faint: true,
    })
    expect(errorSpy).toHaveBeenCalledWith(
      '[engram-mcp] recall output policy: emitK=unbounded tokenBudget=4000 faint=on relatedShare=0.45 itemMaxTokens=700',
    )
  })

  it.each([
    ['ENGRAM_RECALL_RELATED_SHARE', '0.95'],
    ['ENGRAM_RECALL_ITEM_MAX_TOKENS', 'lots'],
  ])('throws at startup naming %s for %j', (name, value) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => recallOutputPolicyAtStartup({ [name]: value })).toThrow(name)
  })

  it('fails startup when the item cap is larger than the token budget', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = { ENGRAM_RECALL_TOKEN_BUDGET: '1000', ENGRAM_RECALL_ITEM_MAX_TOKENS: '1200' }

    expect(() => recallOutputPolicyAtStartup(env)).toThrow(
      'ENGRAM_RECALL_ITEM_MAX_TOKENS (1200) must not exceed ENGRAM_RECALL_TOKEN_BUDGET (1000)',
    )
    expect(() => recallOutputPolicyAtStartup({ ...env, ENGRAM_RECALL_ITEM_MAX_TOKENS: '1000' })).not.toThrow()
  })

  it('fails startup on a malformed budget before any backend is contacted', async () => {
    const saved = process.env['ENGRAM_RECALL_TOKEN_BUDGET']
    process.env['ENGRAM_RECALL_TOKEN_BUDGET'] = 'abc'
    try {
      await expect(getMemory()).rejects.toThrow(/ENGRAM_RECALL_TOKEN_BUDGET must be a positive integer, got "abc"/)
    } finally {
      if (saved === undefined) delete process.env['ENGRAM_RECALL_TOKEN_BUDGET']
      else process.env['ENGRAM_RECALL_TOKEN_BUDGET'] = saved
    }
  })
  it('fails startup on a malformed item cap before any backend is contacted', async () => {
    const saved = process.env['ENGRAM_RECALL_ITEM_MAX_TOKENS']
    process.env['ENGRAM_RECALL_ITEM_MAX_TOKENS'] = '-5'
    try {
      await expect(getMemory()).rejects.toThrow(/ENGRAM_RECALL_ITEM_MAX_TOKENS must be a positive integer, got "-5"/)
    } finally {
      if (saved === undefined) delete process.env['ENGRAM_RECALL_ITEM_MAX_TOKENS']
      else process.env['ENGRAM_RECALL_ITEM_MAX_TOKENS'] = saved
    }
  })
})

describe('supersessionSettingsAtStartup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves the regex default when nothing is set and logs it', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(supersessionSettingsAtStartup({})).toEqual({ mode: 'regex', minCosine: 0.6 })
    expect(errorSpy).toHaveBeenCalledWith('[engram-mcp] fact supersession: mode=regex minCosine=0.6')
  })

  it('resolves a configured mode and floor', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = { ENGRAM_SUPERSESSION: 'llm', ENGRAM_SUPERSESSION_MIN_COSINE: '0.7' }

    expect(supersessionSettingsAtStartup(env)).toEqual({ mode: 'llm', minCosine: 0.7 })
  })

  it.each([
    ['ENGRAM_SUPERSESSION', 'LLM', /ENGRAM_SUPERSESSION must be "regex", "llm" or "off", got "LLM"/],
    ['ENGRAM_SUPERSESSION_MIN_COSINE', 'high', /ENGRAM_SUPERSESSION_MIN_COSINE must be a number in \[-1, 1\], got "high"/],
  ])('fails startup on a malformed %s before any backend is contacted', async (name, value, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const saved = process.env[name]
    process.env[name] = value
    try {
      await expect(getMemory()).rejects.toThrow(message)
    } finally {
      if (saved === undefined) delete process.env[name]
      else process.env[name] = saved
    }
  })
})

describe('chatIntelligenceOptionsFromEnv', () => {
  it('maps the chat env to openaiIntelligence options, and nothing when unset', () => {
    expect(chatIntelligenceOptionsFromEnv({})).toEqual({})
    expect(
      chatIntelligenceOptionsFromEnv({
        ENGRAM_CHAT_MODEL: ' deepseek/deepseek-v4-flash ',
        ENGRAM_CHAT_BASE_URL: 'https://openrouter.ai/api/v1',
        ENGRAM_CHAT_API_KEY: 'k',
        ENGRAM_CHAT_PROVIDER_PREFS: '{"order":["a"]}',
        ENGRAM_CHAT_REASONING: 'off',
      }),
    ).toEqual({
      summarizationModel: 'deepseek/deepseek-v4-flash',
      chatBaseUrl: 'https://openrouter.ai/api/v1',
      chatApiKey: 'k',
      chatProviderPrefs: { order: ['a'] },
      chatReasoning: 'off',
    })
  })

  it('throws on provider prefs that are not a JSON object', () => {
    expect(() => chatIntelligenceOptionsFromEnv({ ENGRAM_CHAT_PROVIDER_PREFS: '[1]' })).toThrow(
      /ENGRAM_CHAT_PROVIDER_PREFS is not a valid JSON object/,
    )
  })
})

describe('parseChatReasoningEnv', () => {
  const HOST = { ENGRAM_CHAT_BASE_URL: 'https://openrouter.ai/api/v1' }

  it('refuses a reasoning mode without a chat base URL, naming both variables', () => {
    for (const env of [{ ENGRAM_CHAT_REASONING: 'off' }, { ENGRAM_CHAT_REASONING: 'default', ENGRAM_CHAT_BASE_URL: ' ' }]) {
      expect(() => parseChatReasoningEnv(env)).toThrow(/ENGRAM_CHAT_REASONING requires ENGRAM_CHAT_BASE_URL/)
    }
  })

  it('returns nothing when neither variable is set, so request bodies stay unchanged', () => {
    expect(parseChatReasoningEnv({})).toEqual({})
    expect(parseChatReasoningEnv({ ENGRAM_CHAT_REASONING: '  ' })).toEqual({})
  })

  it('accepts off and default', () => {
    expect(parseChatReasoningEnv({ ENGRAM_CHAT_REASONING: 'off', ...HOST })).toEqual({ chatReasoning: 'off' })
    expect(parseChatReasoningEnv({ ENGRAM_CHAT_REASONING: ' default ', ...HOST })).toEqual({ chatReasoning: 'default' })
  })

  it('accepts a positive integer headroom', () => {
    expect(parseChatReasoningEnv({ ENGRAM_CHAT_REASONING: 'default', ENGRAM_CHAT_REASONING_HEADROOM: '4096', ...HOST }))
      .toEqual({ chatReasoning: 'default', chatReasoningHeadroom: 4096 })
  })

  it('rejects any other reasoning value', () => {
    for (const v of ['low', 'high', 'none', 'OFFF', 'true']) {
      expect(() => parseChatReasoningEnv({ ENGRAM_CHAT_REASONING: v, ...HOST })).toThrow(/ENGRAM_CHAT_REASONING/)
    }
  })

  it('rejects a non-positive or non-integer headroom', () => {
    for (const v of ['0', '-5', '1.5', 'abc', '2048tokens']) {
      expect(() => parseChatReasoningEnv({ ENGRAM_CHAT_REASONING: 'default', ENGRAM_CHAT_REASONING_HEADROOM: v, ...HOST }))
        .toThrow(/ENGRAM_CHAT_REASONING_HEADROOM/)
    }
  })
})

describe('parseTimeZoneEnv', () => {
  it('defaults to UTC when unset or blank', () => {
    expect(parseTimeZoneEnv({})).toEqual({ timeZone: 'UTC' })
    expect(parseTimeZoneEnv({ ENGRAM_TIMEZONE: '  ' })).toEqual({ timeZone: 'UTC' })
  })

  it('accepts an IANA zone name', () => {
    expect(parseTimeZoneEnv({ ENGRAM_TIMEZONE: ' Asia/Karachi ' })).toEqual({ timeZone: 'Asia/Karachi' })
  })

  it('refuses a name Intl does not know, naming the variable and the value', () => {
    expect(() => parseTimeZoneEnv({ ENGRAM_TIMEZONE: 'Mars/Olympus_Mons' }))
      .toThrow(/ENGRAM_TIMEZONE must be an IANA time zone name.*got "Mars\/Olympus_Mons"/)
  })

  it('fails startup on an invalid zone before any backend is contacted', async () => {
    const saved = process.env['ENGRAM_TIMEZONE']
    process.env['ENGRAM_TIMEZONE'] = 'Asia/Lahore_City'
    try {
      await expect(getMemory()).rejects.toThrow(/ENGRAM_TIMEZONE must be an IANA time zone name.*got "Asia\/Lahore_City"/)
    } finally {
      if (saved === undefined) delete process.env['ENGRAM_TIMEZONE']
      else process.env['ENGRAM_TIMEZONE'] = saved
    }
  })
})

describe('runMemoryRecall', () => {
  const REASON = '429 You exceeded your current quota, please check your plan and billing details.'
  const NOTICE = vectorUnavailableNotice(REASON)
  const MEMORY = {
    id: 'ep-1', type: 'episode' as const, content: 'The deploy window is Thursday.', relevance: 0.4,
    source: 'recall' as const, metadata: {},
  }

  function result(partial: Partial<RecallResult>): RecallResult {
    return {
      memories: [], associations: [], primed: [], estimatedTokens: 0, formatted: '',
      intent: { type: 'QUESTION', confidence: 1, strategy: {} } as unknown as RecallResult['intent'],
      ...partial,
    }
  }

  function stubMemory(r: RecallResult) {
    return { recall: async () => r }
  }

  it('passes the request time as now and keeps the argument-derived options', async () => {
    const seen: unknown[] = []
    const mem = { recall: async (_q: string, opts?: unknown) => { seen.push(opts); return result({}) } }
    const before = Date.now()

    await runMemoryRecall(mem, { query: 'what did we ship last week', project_id: 'engram', synthesize: true })

    const after = Date.now()
    expect(seen).toHaveLength(1)
    const { now, ...rest } = seen[0] as { now: Date }
    expect(now).toBeInstanceOf(Date)
    expect(now.getTime()).toBeGreaterThanOrEqual(before)
    expect(now.getTime()).toBeLessThanOrEqual(after)
    expect(rest).toEqual({ projectId: 'engram', synthesize: true })
  })

  it('returns a degraded recall as normal content that leads with the notice', async () => {
    const formatted = `${NOTICE}\n## Engram — Recalled Conversation Memory\n\n- [episode] ${MEMORY.content}`
    const res = await runMemoryRecall(
      stubMemory(result({ memories: [MEMORY], formatted, degraded: { vector: REASON } })),
      { query: 'deploy window' },
    )

    expect(res.isError).toBeUndefined()
    expect(res.content[0]?.text).toBe(formatted)
    expect(res.content[0]?.text.split('\n')[0]).toBe(NOTICE)
  })

  it('says the keyword search found nothing when a degraded recall is empty', async () => {
    const res = await runMemoryRecall(stubMemory(result({ degraded: { vector: REASON } })), { query: 'deploy window' })

    expect(res.isError).toBeUndefined()
    expect(res.content[0]?.text).toBe(`${NOTICE}\nNo keyword matches.`)
  })

  it('says the text match found nothing, not the keyword search, when keyword search failed', async () => {
    const res = await runMemoryRecall(
      stubMemory(result({ degraded: { vector: REASON, lexical: 'canceling statement due to statement timeout' } })),
      { query: 'deploy window' },
    )
    const text = res.content[0]?.text ?? ''

    expect(res.isError).toBeUndefined()
    expect(text).not.toContain('No keyword matches.')
    expect(text).toBe(
      `> Semantic and keyword search unavailable (semantic: ${REASON}; keyword: canceling statement due to statement timeout); these results come from a plain text match only.\nNo text matches.`,
    )
  })

  it('keeps the plain empty answer for a healthy recall', async () => {
    const res = await runMemoryRecall(stubMemory(result({})), { query: 'deploy window' })

    expect(res).toEqual({ content: [{ type: 'text', text: 'No relevant memories found.' }] })
  })

  it('says the budget is too small, not that nothing matched, when memories matched but none fit', async () => {
    const res = await runMemoryRecall(stubMemory(result({ memories: [MEMORY], formatted: '' })), { query: 'deploy window' })

    expect(res).toEqual({ content: [{ type: 'text', text: RECALL_BUDGET_TOO_SMALL }] })
    expect(RECALL_BUDGET_TOO_SMALL).toContain('token budget is too small')
  })

  it('keeps the degraded notice ahead of the budget-too-small answer', async () => {
    const res = await runMemoryRecall(
      stubMemory(result({ memories: [MEMORY], formatted: '', degraded: { vector: REASON } })),
      { query: 'deploy window' },
    )

    expect(res.content[0]?.text).toBe(`${NOTICE}\n${RECALL_BUDGET_TOO_SMALL}`)
  })

  it('returns a healthy payload unchanged', async () => {
    const formatted = `## Engram — Recalled Conversation Memory\n\n- [episode] ${MEMORY.content}`
    const res = await runMemoryRecall(stubMemory(result({ memories: [MEMORY], formatted })), { query: 'deploy window' })

    expect(res).toEqual({ content: [{ type: 'text', text: formatted }] })
  })

  it('rejects an empty query as a tool error', async () => {
    const res = await runMemoryRecall(stubMemory(result({})), { query: '  ' })

    expect(res).toEqual({ content: [{ type: 'text', text: 'Error: query must be a non-empty string' }], isError: true })
  })

  function capturingMemory() {
    const calls: Array<{ query: string; opts: unknown }> = []
    return {
      calls,
      mem: {
        recall: async (query: string, opts?: unknown) => {
          calls.push({ query, opts })
          return result({})
        },
      },
    }
  }

  it('forwards conversation_id to the recall as conversationKey', async () => {
    const { calls, mem } = capturingMemory()

    await runMemoryRecall(mem, { query: 'deploy window', conversation_id: 'conv-1', project_id: 'engram' })

    expect(calls).toEqual([{ query: 'deploy window', opts: { projectId: 'engram', conversationKey: 'conv-1', now: expect.any(Date) } }])
  })

  it('sends no conversationKey without conversation_id, so the recall gets no priming', async () => {
    const { calls, mem } = capturingMemory()

    await runMemoryRecall(mem, { query: 'deploy window' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.opts).not.toHaveProperty('conversationKey')
  })

  it('leaves session_id out of the recall options, as before', async () => {
    const { calls, mem } = capturingMemory()

    await runMemoryRecall(mem, { query: 'deploy window', session_id: 'sess-1' })

    expect(calls).toEqual([{ query: 'deploy window', opts: { now: expect.any(Date) } }])
  })

  it('rejects a blank conversation_id as a tool error without recalling', async () => {
    const { calls, mem } = capturingMemory()

    const res = await runMemoryRecall(mem, { query: 'deploy window', conversation_id: '  ' })

    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toMatch(/^Error: conversation_id must be a non-blank string/)
    expect(calls).toHaveLength(0)
  })
})

describe('runMemoryForget', () => {
  const EMPTY_BY_IDS: ForgetByIdsResult = { forgotten: [], notFound: [], outOfScope: [], notForgettable: [] }

  function stubMemory(preview: ForgetPreview, byIds: ForgetByIdsResult = EMPTY_BY_IDS) {
    const calls = { forget: [] as unknown[][], forgetByIds: [] as unknown[][] }
    return {
      calls,
      mem: {
        forget: async (...a: unknown[]) => { calls.forget.push(a); return preview },
        forgetByIds: async (...a: unknown[]) => { calls.forgetByIds.push(a); return byIds },
      },
    }
  }

  const PREVIEW: ForgetPreview = {
    count: 2,
    candidates: [
      {
        id: 'ep-1', type: 'episode', relevance: 0.8234, projectId: null, date: '2026-09-28',
        content: 'the staging deploy key\nrotates every monday   ' + 'x'.repeat(300),
      },
      { id: 'sem-2', type: 'semantic', relevance: 0.4, projectId: 'engram', date: null, content: 'billing runs monthly' },
    ],
  }

  function textOf(r: { content: Array<{ text: string }> }): string {
    return r.content.map(c => c.text).join('\n')
  }

  it('previews a query with one line per candidate, ids included, and never calls forgetByIds', async () => {
    const { mem, calls } = stubMemory(PREVIEW)
    const r = await runMemoryForget(mem, { query: '  staging deploy key  ' })
    const text = textOf(r)

    expect(r.isError).toBeUndefined()
    expect(calls.forget).toEqual([['staging deploy key']])
    expect(calls.forgetByIds).toHaveLength(0)
    const lines = text.split('\n')
    const first = lines.find(l => l.includes('ep-1'))!
    expect(first.startsWith('- [episode · 2026-09-28] ep-1 · relevance 0.82 · the staging deploy key rotates every monday x')).toBe(true)
    expect(first.slice(first.indexOf('· the staging') + 2)).toHaveLength(160)
    expect(lines).toContain('- [semantic] sem-2 · relevance 0.40 · billing runs monthly')
    expect(lines[lines.length - 1]).toBe('To forget, call memory_forget again with ids set to the ones to remove.')
  })

  it('reports no candidates plainly', async () => {
    const { mem } = stubMemory({ count: 0, candidates: [] })
    expect(textOf(await runMemoryForget(mem, { query: 'nothing' }))).toBe('No matching memories found.')
  })

  it('forgets exactly the given ids and reports each outcome with its ids', async () => {
    const { mem, calls } = stubMemory(PREVIEW, {
      forgotten: [{ id: 'ep-1', type: 'episode' }, { id: 'sem-2', type: 'semantic' }],
      notFound: ['gone-3'],
      outOfScope: ['other-4'],
      notForgettable: ['dig-5'],
    })
    const r = await runMemoryForget(mem, { ids: ['ep-1', 'sem-2', 'gone-3', 'other-4', 'dig-5'] })
    const text = textOf(r)

    expect(r.isError).toBeUndefined()
    expect(calls.forget).toHaveLength(0)
    expect(calls.forgetByIds).toEqual([[['ep-1', 'sem-2', 'gone-3', 'other-4', 'dig-5']]])
    expect(text).toContain('Forgotten (2): ep-1 (episode), sem-2 (semantic)')
    expect(text).toContain('Not found (1): gone-3')
    expect(text).toContain('Out of scope (1): other-4')
    expect(text).toContain('Not forgettable (1): dig-5')
  })

  it('rejects both or neither of query and ids', async () => {
    for (const args of [{ query: 'q', ids: ['a'] }, {}, { confirm: true }]) {
      const { mem, calls } = stubMemory(PREVIEW)
      const r = await runMemoryForget(mem, args)
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/^Error: pass exactly one of query or ids/)
      expect(calls.forget).toHaveLength(0)
      expect(calls.forgetByIds).toHaveLength(0)
    }
  })

  it('rejects a blank query and empty or non-string ids', async () => {
    const bad: Array<Record<string, unknown>> = [
      { query: '   ' },
      { query: 42 },
      { ids: [] },
      { ids: 'ep-1' },
      { ids: ['ep-1', ''] },
      { ids: ['ep-1', 7] },
    ]
    for (const args of bad) {
      const { mem, calls } = stubMemory(PREVIEW)
      const r = await runMemoryForget(mem, args)
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/^Error: /)
      expect(calls.forgetByIds).toHaveLength(0)
    }
  })
})

describe('parseSalienceThresholdEnv', () => {
  it('defaults to 0.7 when unset or blank', () => {
    expect(parseSalienceThresholdEnv({})).toBe(0.7)
    expect(parseSalienceThresholdEnv({ ENGRAM_SALIENCE_THRESHOLD: '  ' })).toBe(0.7)
  })

  it.each([
    ['0', 0],
    ['1', 1],
    ['0.55', 0.55],
    ['.8', 0.8],
  ])('accepts %s', (raw, expected) => {
    expect(parseSalienceThresholdEnv({ ENGRAM_SALIENCE_THRESHOLD: raw })).toBe(expected)
  })

  it.each(['abc', '1.5', '-0.2', '0x1', '1e-1', 'NaN'])('throws on %s', (raw) => {
    expect(() => parseSalienceThresholdEnv({ ENGRAM_SALIENCE_THRESHOLD: raw })).toThrow(/ENGRAM_SALIENCE_THRESHOLD/)
  })
})

describe('parseExtractWindowsPerTickEnv', () => {
  it('defaults to 20 when unset or blank', () => {
    expect(parseExtractWindowsPerTickEnv({})).toBe(20)
    expect(parseExtractWindowsPerTickEnv({ ENGRAM_EXTRACT_WINDOWS_PER_TICK: '  ' })).toBe(20)
  })

  it('reads an integer from 1 to 200', () => {
    expect(parseExtractWindowsPerTickEnv({ ENGRAM_EXTRACT_WINDOWS_PER_TICK: '1' })).toBe(1)
    expect(parseExtractWindowsPerTickEnv({ ENGRAM_EXTRACT_WINDOWS_PER_TICK: ' 200 ' })).toBe(200)
  })

  it.each(['0', '201', '-3', '2.5', '1e2', 'twenty'])('fails startup on %s', (raw) => {
    expect(() => parseExtractWindowsPerTickEnv({ ENGRAM_EXTRACT_WINDOWS_PER_TICK: raw })).toThrow(
      `ENGRAM_EXTRACT_WINDOWS_PER_TICK must be an integer from 1 to 200, got "${raw}"`,
    )
  })
})

describe('captureModelFromEnv', () => {
  it('names the configured chat model', () => {
    expect(captureModelFromEnv({ ENGRAM_CHAT_MODEL: ' deepseek/deepseek-v4-flash ' })).toBe('deepseek/deepseek-v4-flash')
  })

  it('falls back to the default chat model', () => {
    expect(captureModelFromEnv({})).toBe('gpt-4o-mini')
  })
})

describe('sharedInit', () => {
  /** A builder that mimics createMemory + initialize: the instance is usable only after initialize resolves. */
  function deferredBuilder() {
    const pendingInits: Array<() => void> = []
    const build = vi.fn(async () => {
      const instance = { initialized: false }
      await new Promise<void>((resolve) => pendingInits.push(resolve))
      instance.initialized = true
      return instance
    })
    return { build, finishInit: () => pendingInits.forEach((resolve) => resolve()) }
  }

  it('builds one stack for two concurrent first callers, both resolving after initialize', async () => {
    const b = deferredBuilder()
    const get = sharedInit(b.build)
    const seen: boolean[] = []

    const first = get().then((m) => {
      seen.push(m.initialized)
      return m
    })
    const second = get().then((m) => {
      seen.push(m.initialized)
      return m
    })
    await Promise.resolve()
    expect(seen).toEqual([])
    b.finishInit()
    const [a, c] = await Promise.all([first, second])

    expect(b.build).toHaveBeenCalledOnce()
    expect(a).toBe(c)
    expect(seen).toEqual([true, true])
    expect(await get()).toBe(a)
    expect(b.build).toHaveBeenCalledOnce()
  })

  it('retries the build on the next call after a failed init', async () => {
    const build = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce('stack')
    const get = sharedInit(build)

    await expect(get()).rejects.toThrow('ECONNREFUSED')
    await expect(get()).resolves.toBe('stack')
    expect(build).toHaveBeenCalledTimes(2)
  })
})

describe('consolidation worker cycles', () => {
  it('schedules the dream cycle alongside the cheap cycles', () => {
    expect(CONSOLIDATION_WORKER_CYCLES).toEqual(['light', 'deep', 'dream', 'decay'])
  })

  it('passes the exported cycle list to the worker', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../src/server-core.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/startConsolidationWorker\([^)]*\{\s*cycles: \[\.\.\.CONSOLIDATION_WORKER_CYCLES\]/)
  })
})
