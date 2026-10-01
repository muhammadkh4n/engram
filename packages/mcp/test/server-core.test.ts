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
import type { ForgetPreview, ForgetByIdsResult } from '@engram-mem/core'
import {
  maybeWithRecallEngine,
  formatRecallTimingLine,
  recallOptionsFromArgs,
  parseChatReasoningEnv,
  runMemoryForget,
  parseSalienceThresholdEnv,
  captureModelFromEnv,
  sharedInit,
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
})

describe('recallOptionsFromArgs', () => {
  it('trims the project id the way memory_ingest does', () => {
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
