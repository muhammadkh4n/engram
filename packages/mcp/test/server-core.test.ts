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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { StorageAdapter } from '@engram-mem/core'
import { recallEngineOf } from '@engram-mem/recall-engine'
import {
  maybeWithLocalRerank,
  maybeWithRecallEngine,
  recallRerankerFrom,
  parseChatReasoningEnv,
  parseTimeZoneEnv,
  chatIntelligenceOptionsFromEnv,
  supersessionSettingsAtStartup,
  parseSalienceThresholdEnv,
  parseExtractWindowsPerTickEnv,
  captureModelFromEnv,
  sharedInit,
  CONSOLIDATION_WORKER_CYCLES,
  consolidationAtStartup,
  consolidationEnabledFromEnv,
  extractionHeldFromEnv,
  recallConfigAtStartup,
  rerankerIdFromEnv,
  getMemory,
  createEngramServer,
  INSTRUCTIONS,
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

describe('recallConfigAtStartup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const noLocalModel = async () => null
  const TST_FLOORS = [
    { reranker: 'onnx:tst-org/tst-reranker:q8', floor: 0.3, strong: 0.7, calibratedAt: '2026-02-03T04:00:00Z', dataset: 'tst', neededInSlate: 0, neededBelowFloor: 0 },
  ]

  it('passes the three keys recall reads and logs that recall refuses without a floor', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = { ENGRAM_RECALL_LOG: '/tmp/tst-recall.jsonl', ENGRAM_RECALL_LOG_MAX_MB: '5', ENGRAM_RECALL_ENGINE: 'false', ENGRAM_CHAT_MODEL: 'tst-chat-model' }
    expect(await recallConfigAtStartup(env, noLocalModel)).toEqual({ rerankerId: 'openai:tst-chat-model', calibration: null })
    expect(errorSpy).toHaveBeenCalledWith('[engram-mcp] recall: reranker=openai:tst-chat-model not calibrated; /recall and memory_recall refuse')
  })

  it('logs the floor and strong line of a calibrated reranker, and no secret', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = {
      ENGRAM_RERANK_LOCAL: 'true',
      ENGRAM_RERANK_LOCAL_MODEL: 'tst-org/tst-reranker',
      ENGRAM_CHAT_API_KEY: 'tst-secret-chat-key-value',
    }
    const config = await recallConfigAtStartup(env, async () => 'tst-org/tst-default', TST_FLOORS)
    expect(config.rerankerId).toBe('onnx:tst-org/tst-reranker:q8')
    expect(errorSpy).toHaveBeenCalledWith('[engram-mcp] recall: reranker=onnx:tst-org/tst-reranker:q8 floor=0.3 strong=0.7')
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('tst-secret-chat-key-value')
  })

  it('names the reranker the server will use: the local default model, or the chat model when the local package cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await recallConfigAtStartup({ ENGRAM_RERANK_LOCAL: 'true' }, async () => 'tst-org/tst-default')).rerankerId).toBe('onnx:tst-org/tst-default:q8')
    expect((await recallConfigAtStartup({ ENGRAM_RERANK_LOCAL: 'true', ENGRAM_CHAT_MODEL: 'tst-chat-model' }, noLocalModel)).rerankerId).toBe('openai:tst-chat-model')
    expect(rerankerIdFromEnv({ ENGRAM_RERANK_LOCAL: 'false' }, 'tst-chat-model', 'tst-org/tst-default')).toBe('openai:tst-chat-model')
  })

  it('fails on an ENGRAM_RECALL_* key nothing reads, naming it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recallConfigAtStartup({ ENGRAM_RECALL_FAN: 'on' }, noLocalModel)).rejects.toThrow(
      'ENGRAM_RECALL_FAN is set, and nothing reads it: remove it from the server environment',
    )
  })

  it('names every unread key in one message, an empty value included', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      recallConfigAtStartup({ ENGRAM_RECALL_TOKEN_BUDGET: '4000', ENGRAM_RECALL_TIMING: '', ENGRAM_RECALL_LOG: '/tmp/x' }, noLocalModel),
    ).rejects.toThrow(/^ENGRAM_RECALL_TIMING, ENGRAM_RECALL_TOKEN_BUDGET are set, and nothing reads them/)
  })

  it.each([
    [{ ENGRAM_TIMEZONE: 'Asia/Nowhere_City' }, /ENGRAM_TIMEZONE/],
    [{ ENGRAM_CHAT_PROVIDER_PREFS: '[1,2]' }, /ENGRAM_CHAT_PROVIDER_PREFS is not a valid JSON object/],
    [{ ENGRAM_RECALL_LOG: '/tmp/x.jsonl', ENGRAM_RECALL_LOG_MAX_MB: '0' }, /ENGRAM_RECALL_LOG_MAX_MB/],
  ])('fails on a bad value %j', async (env, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recallConfigAtStartup(env, noLocalModel)).rejects.toThrow(message)
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

  it('starts the worker and auto-consolidation only when the switch is on', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../src/server-core.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/const consolidation = consolidationEnabledFromEnv\(\)/)
    expect(src).toMatch(/autoConsolidate: consolidation,/)
    expect(src).toMatch(/if \(consolidation\) \{\s*const worker = startConsolidationWorker\(/)
    expect(src.match(/startConsolidationWorker\(/g)).toHaveLength(1)
  })
})

describe('consolidationEnabledFromEnv', () => {
  it.each([[undefined], [''], ['  '], ['on'], [' on ']])('is on for %j', (raw) => {
    expect(consolidationEnabledFromEnv(raw === undefined ? {} : { ENGRAM_CONSOLIDATION: raw })).toBe(true)
  })

  it('is off for off', () => {
    expect(consolidationEnabledFromEnv({ ENGRAM_CONSOLIDATION: 'off' })).toBe(false)
  })

  it.each(['no', 'OFF', 'false', 'hold'])('fails startup on %s, naming the variable', (raw) => {
    expect(() => consolidationEnabledFromEnv({ ENGRAM_CONSOLIDATION: raw })).toThrow(
      `ENGRAM_CONSOLIDATION must be "on" or "off", got "${raw}"`,
    )
  })
})

describe('extractionHeldFromEnv', () => {
  it.each([[undefined], [''], ['on'], [' on ']])('is not held for %j', (raw) => {
    expect(extractionHeldFromEnv(raw === undefined ? {} : { ENGRAM_EXTRACTION: raw })).toBe(false)
  })

  it('is held for hold', () => {
    expect(extractionHeldFromEnv({ ENGRAM_EXTRACTION: 'hold' })).toBe(true)
  })

  it.each(['no', 'off', 'HOLD', 'paused'])('fails startup on %s, naming the variable', (raw) => {
    expect(() => extractionHeldFromEnv({ ENGRAM_EXTRACTION: raw })).toThrow(
      `ENGRAM_EXTRACTION must be "on" or "hold", got "${raw}"`,
    )
  })
})

describe('consolidationAtStartup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs one line when the cycles are off', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(consolidationAtStartup({ ENGRAM_CONSOLIDATION: 'off' })).toBe(false)
    expect(errorSpy.mock.calls).toEqual([['[engram-mcp] consolidation: off']])
  })

  it('logs nothing when the cycles run', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(consolidationAtStartup({})).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('fails the memory stack on a malformed value before any backend is contacted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const saved = process.env.ENGRAM_CONSOLIDATION
    process.env.ENGRAM_CONSOLIDATION = 'no'
    try {
      await expect(getMemory()).rejects.toThrow('ENGRAM_CONSOLIDATION must be "on" or "off", got "no"')
    } finally {
      if (saved === undefined) delete process.env.ENGRAM_CONSOLIDATION
      else process.env.ENGRAM_CONSOLIDATION = saved
    }
  })
})

describe('the MCP server', () => {
  async function connect(): Promise<Client> {
    const server = createEngramServer()
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'tst-client', version: '0.0.0' })
    await client.connect(clientSide)
    return client
  }

  it('lists exactly the read tools over typed items and the four item-action tools', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'memory_capture_status',
      'memory_forget',
      'memory_get',
      'memory_ingest',
      'memory_overview',
      'memory_recall',
      'memory_retire',
      'memory_timeline',
      'memory_unretire',
    ])
    await client.close()
  })

  it('lists neither memory_bridges nor memory_consolidation_status, and answers them as unknown tools', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('memory_bridges')
    expect(names).not.toContain('memory_consolidation_status')
    for (const name of ['memory_bridges', 'memory_consolidation_status']) {
      expect(await client.callTool({ name, arguments: {} })).toEqual({
        content: [{ type: 'text', text: `Error: unknown tool "${name}"` }],
        isError: true,
      })
    }
    await client.close()
  })

  it('serves instructions that describe typed memory items, word for word', async () => {
    const expected = [
      "Engram is MK's memory store. It holds typed items, each with who said it, when, and where it came from:",
      "- MK's own words: utterances (speaker mk) and mk_statement items (an exact quote with the question it answered);",
      "- durable records: commits, plan decisions, register entries, vault document sections;",
      "- assistant observations, labelled with trust and date;",
      "- one record per session.",
      "",
      "Memory reaches a Claude Code session through hooks: standing rulings by scope, and a briefing on each prompt. Call memory_recall when a task needs memory the briefing did not cover. Its result lands in the caller's context, so call it from a subagent where you can. memory_get returns full records by id.",
      "",
      "Reading results:",
      "- trust 0 is MK's own words: quote them exactly; never restate them as a rule of your own.",
      "- An item with status superseded or retired is not current. A superseded item is shown only next to its successor.",
      "- An observation states what an assistant found on its date. Check live state before relying on it, above all when it is flagged verify_live.",
      "- Plan state lives in the plan's LEDGER.md, not in memory.",
      "",
      "Writing: memory_ingest stores one typed item. memory_retire and memory_forget take explicit ids and a reason; nothing is removed in bulk.",
    ].join('\n')
    expect(INSTRUCTIONS).toBe(expected)
    const client = await connect()
    expect(client.getInstructions()).toBe(expected)
    await client.close()
  })

  it('tells no client to always recall or check memory first, and names only registered tools', async () => {
    expect(INSTRUCTIONS).not.toMatch(/ALWAYS|CHECK MEMORY FIRST/)
    const client = await connect()
    const names = new Set((await client.listTools()).tools.map((t) => t.name))
    const mentioned = [...new Set(INSTRUCTIONS.match(/\bmemory_[a-z_]+\b/g) ?? [])]
    expect(mentioned.sort()).toEqual(['memory_forget', 'memory_get', 'memory_ingest', 'memory_recall', 'memory_retire'])
    for (const name of mentioned) expect(names.has(name), name).toBe(true)
    await client.close()
  })

  it('lists memory_forget with ids and reason required and no query', async () => {
    const client = await connect()
    const forget = (await client.listTools()).tools.find((t) => t.name === 'memory_forget')!
    expect(forget.inputSchema.required).toEqual(['ids', 'reason'])
    expect(Object.keys(forget.inputSchema.properties ?? {}).sort()).toEqual(['ids', 'reason'])
    await client.close()
  })
})

describe('rerank call options reach the reranker', () => {
  const docs = [{ id: 'tst-a', content: 'tst document' }]
  const rerankEnv = { local: process.env['ENGRAM_RERANK_LOCAL'], model: process.env['ENGRAM_RERANK_LOCAL_MODEL'] }

  afterEach(() => {
    vi.doUnmock('@engram-mem/rerank-onnx')
    if (rerankEnv.local === undefined) delete process.env['ENGRAM_RERANK_LOCAL']
    else process.env['ENGRAM_RERANK_LOCAL'] = rerankEnv.local
    if (rerankEnv.model === undefined) delete process.env['ENGRAM_RERANK_LOCAL_MODEL']
    else process.env['ENGRAM_RERANK_LOCAL_MODEL'] = rerankEnv.model
  })

  it('forwards the options through the local ONNX reranker wrapper', async () => {
    const rerank = vi.fn(async (_q: string, d: ReadonlyArray<{ id: string }>) => d.map((x) => ({ id: x.id, score: 0.5 })))
    vi.doMock('@engram-mem/rerank-onnx', () => ({
      DEFAULT_RERANK_MODEL: 'tst/reranker-model',
      createOnnxReranker: () => ({ rerank, load: async () => {} }),
    }))
    process.env['ENGRAM_RERANK_LOCAL'] = 'true'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { intelligence } = await maybeWithLocalRerank({}, 'tst-chat')
      const options = { priority: 3, onSettled: () => {} }

      await intelligence.rerank!('tst query', docs, options)

      expect(rerank).toHaveBeenCalledWith('tst query', docs, options)
    } finally {
      log.mockRestore()
    }
  })

  it('forwards the options through the recall reranker adapter, bound to its adapter', async () => {
    const calls: unknown[][] = []
    const intelligence = {
      marker: 'tst-adapter',
      async rerank(this: { marker: string }, ...args: unknown[]) {
        calls.push([this.marker, ...args])
        return [{ id: 'tst-a', score: 0.5 }]
      },
    }
    const options = { priority: 7 }

    const reranker = recallRerankerFrom(intelligence, 'tst-reranker')
    await reranker.rerank('tst query', docs, options)

    expect(reranker.id).toBe('tst-reranker')
    expect(calls).toEqual([['tst-adapter', 'tst query', docs, options]])
  })
})
