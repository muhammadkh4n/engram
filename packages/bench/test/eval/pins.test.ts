import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IntelligenceAdapter } from '@engram-mem/core'
import { buildEvalStack, type EvalModules, type EvalRecallOptions, type EvalRecallResult } from '../../src/eval/eval-stack.js'
import {
  PinMissError,
  PinsViolationError,
  createPins,
  installFetchGuard,
  openPins,
  parsePinFile,
  pinKey,
  serializePinFile,
} from '../../src/eval/pins.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const STORAGE = 'http://127.0.0.1:3000'
const ENV = { SUPABASE_URL: STORAGE, SUPABASE_KEY: 'k', OPENAI_API_KEY: 'sk-test' }
const MODEL_URL = 'https://api.openai.com/v1/chat/completions'

interface FetchLog {
  urls: string[]
}

/** A fetch that answers every model request with a fresh random number, as a sampled model reply varies. */
function stubFetch(log: FetchLog): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    log.urls.push(String(input))
    return new Response(JSON.stringify({ value: Math.random() }), { status: 200 })
  }) as typeof fetch
}

/**
 * An adapter shaped like openaiIntelligence: it calls globalThis.fetch at call
 * time for every model method, and has a pure helper and an ingest method.
 */
function modelAdapter(): IntelligenceAdapter {
  const ask = async (): Promise<number> => {
    const res = await globalThis.fetch(MODEL_URL, { method: 'POST' })
    return ((await res.json()) as { value: number }).value
  }
  return {
    embedQuery: async (text: string) => [text.length, await ask()],
    embed: async (text: string) => [text.length, await ask()],
    expandQuery: async (query: string, opts?: { now?: Date }) => [`${query} ${opts?.now?.toISOString() ?? ''}`, String(await ask())],
    generateHypotheticalDoc: async (query: string) => `a note about ${query} ${await ask()}`,
    rerank: async (_query: string, docs: ReadonlyArray<{ id: string; content: string }>) =>
      Promise.all(docs.map(async (d) => ({ id: d.id, score: await ask() }))),
    dimensions: () => 2,
    expansionReferenceDate: (now: Date) => now.toISOString().slice(0, 10),
    summarize: async () => ({ text: 'never', topics: [], entities: [], decisions: [] }) as never,
  } as IntelligenceAdapter
}

/** A memory whose formatted output is built from every model reply recall gets. */
function stubMods(opts: { swallowErrors?: boolean } = {}): EvalModules {
  return {
    createMemory: (createOpts) => {
      const intel = createOpts['intelligence'] as Required<IntelligenceAdapter>
      return {
        conversations: { snapshot: () => 'empty', restore: () => undefined },
        async initialize() {},
        async recall(query: string, recallOpts: EvalRecallOptions): Promise<EvalRecallResult> {
          const step = async <T>(fn: () => Promise<T>): Promise<T | string> => {
            try {
              return await fn()
            } catch (err) {
              if (!opts.swallowErrors) throw err
              return 'skipped'
            }
          }
          const vector = await step(() => intel.embedQuery(query))
          const terms = await step(() => intel.expandQuery(query, { now: recallOpts.now }))
          const doc = await step(() => intel.generateHypotheticalDoc(query))
          const docVector = await step(() => intel.embed(String(doc)))
          const ranked = await step(() => intel.rerank(query, [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }]))
          const formatted = `## Engram\n\n${JSON.stringify({ vector, terms, doc, docVector, ranked, day: intel.expansionReferenceDate(recallOpts.now) })}`
          return { formatted, estimatedTokens: 10, payload: { items: [] } }
        },
      } as unknown as ReturnType<EvalModules['createMemory']>
    },
    PostgRestStorageAdapter: class {
      client = { rpc: () => ({ data: [], error: null }), from: () => ({}) }
    } as unknown as EvalModules['PostgRestStorageAdapter'],
    openaiIntelligence: () => modelAdapter(),
    createOnnxReranker: () => ({ load: async () => undefined, rerank: async () => [] }),
    NeuralGraph: class {} as unknown as EvalModules['NeuralGraph'],
    serverCore: {
      recallOptionsFromArgs: () => ({}),
      chatIntelligenceOptionsFromEnv: () => ({}),
      parseTimeZoneEnv: () => ({ timeZone: 'UTC' }),
      supersessionSettingsAtStartup: () => ({ mode: 'off' }),
      recallOutputPolicyAtStartup: () => ({}),
      maybeWithRecallEngine: async (storage) => storage,
    },
  }
}

let dir: string
let log: FetchLog
let realFetch: typeof fetch

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-pins-'))
  log = { urls: [] }
  realFetch = globalThis.fetch
  globalThis.fetch = stubFetch(log)
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

async function recallOnce(file: string, mode: 'fill' | 'strict', queries: string[], mods = stubMods()) {
  const pins = openPins(file, mode)
  const stack = await buildEvalStack(mods, { calibrationQuery: 'c', now: NOW, env: { ...ENV }, pins })
  try {
    const out: string[] = []
    for (const q of queries) out.push((await stack.recall(q, {}, NOW)).formatted)
    return { out, sha: pins.flush(), pins }
  } finally {
    await stack.close()
  }
}

describe('pins on the eval stack', () => {
  it('fill then strict give byte-identical formatted output, and strict makes no fetch', async () => {
    const file = path.join(dir, 'pins.json')
    const queries = ['where is the env file', 'who owns the deploy']
    const filled = await recallOnce(file, 'fill', queries)
    expect(log.urls.length).toBeGreaterThan(0)
    expect(filled.pins.stats.fills).toBeGreaterThan(0)

    log.urls = []
    const strict = await recallOnce(file, 'strict', queries)
    expect(log.urls).toEqual([])
    expect(strict.out).toEqual(filled.out)
    expect(strict.sha).toBe(filled.sha)
    expect(strict.pins.stats.fills).toBe(0)
  })

  it('a strict miss throws without calling the model', async () => {
    const file = path.join(dir, 'pins.json')
    await recallOnce(file, 'fill', ['known query'])
    log.urls = []
    await expect(recallOnce(file, 'strict', ['unknown query'])).rejects.toThrow(PinMissError)
    expect(log.urls).toEqual([])
  })

  it('a strict miss fails the recall even when the engine swallows the error', async () => {
    const file = path.join(dir, 'pins.json')
    await recallOnce(file, 'fill', ['known query'])
    log.urls = []
    await expect(recallOnce(file, 'strict', ['unknown query'], stubMods({ swallowErrors: true }))).rejects.toThrow(
      PinsViolationError,
    )
    expect(log.urls).toEqual([])
  })

  it('strict mode blocks a fetch to a model origin and restores fetch on close', async () => {
    const file = path.join(dir, 'pins.json')
    await recallOnce(file, 'fill', ['q'])
    const before = globalThis.fetch
    const pins = openPins(file, 'strict')
    const stack = await buildEvalStack(stubMods(), { calibrationQuery: 'c', now: NOW, env: { ...ENV }, pins })
    await expect(globalThis.fetch(MODEL_URL)).rejects.toThrow(/blocked/)
    expect(pins.stats.fetchBlocked).toEqual({ 'https://api.openai.com': 1 })
    await expect(globalThis.fetch(`${STORAGE}/rest/v1/memories`)).resolves.toBeDefined()
    await stack.close()
    expect(globalThis.fetch).toBe(before)
  })

  it('strict mode needs an existing pins file', () => {
    expect(() => openPins(path.join(dir, 'missing.json'), 'strict')).toThrow(/does not exist/)
  })
})

describe('createPins', () => {
  it('keys by method and exact input, so another reference date is a miss', async () => {
    let saved = ''
    const pins = createPins({}, 'fill', (text) => {
      saved = text
    })
    await pins.wrap(modelAdapter()).expandQuery!('q', { now: NOW })
    pins.flush()
    const strict = createPins(parsePinFile(saved).pins, 'strict')
    const replay = strict.wrap(modelAdapter())
    await expect(replay.expandQuery!('q', { now: NOW })).resolves.toHaveLength(2)
    await expect(replay.expandQuery!('q', { now: new Date('2026-09-16T10:00:00Z') })).rejects.toThrow(PinMissError)
    await expect(replay.embedQuery!('q')).rejects.toThrow(PinMissError)
    expect(strict.stats.misses.map((m) => m.method)).toEqual(['expandQuery', 'embedQuery'])
  })

  it('blocks and counts methods recall does not call, and passes pure helpers through', async () => {
    const pins = createPins({}, 'fill')
    const intel = pins.wrap(modelAdapter())
    expect(() => intel.summarize!('text', {} as never)).toThrow(/not a recall call/)
    expect(pins.stats.blocked).toEqual({ summarize: 1 })
    expect(intel.dimensions!()).toBe(2)
    expect(intel.expansionReferenceDate!(NOW)).toBe('2026-09-15')
    expect(log.urls).toEqual([])
  })

  it('pinKey drops trailing undefined arguments and sorts object keys', () => {
    expect(pinKey(['q', undefined])).toBe(pinKey(['q']))
    expect(pinKey([{ b: 1, a: NOW }])).toBe('[{"a":"2026-09-15T10:00:00.000Z","b":1}]')
  })
})

describe('the pins file', () => {
  it('carries a sha256 header that matches its body', () => {
    const { text, sha } = serializePinFile({ embed: { '["x"]': [1, 2] } })
    expect(JSON.parse(text).sha256).toBe(sha)
    expect(parsePinFile(text).sha).toBe(sha)
  })

  it('rejects a body edited after the header was written', () => {
    const { text } = serializePinFile({ embed: { '["x"]': [1, 2] } })
    expect(() => parsePinFile(text.replace('[1,2]', '[1,3]'))).toThrow(/edited or truncated/)
  })

  it('rejects a method that is not a pinned recall call', () => {
    const { text } = serializePinFile({ summarize: {} })
    expect(() => parsePinFile(text)).toThrow(/not a pinned recall call/)
  })
})

describe('installFetchGuard', () => {
  it('allows the listed origin and Hugging Face, counts and rejects the rest', async () => {
    const stats = { fetchBlocked: {} as Record<string, number> }
    const target = { fetch: stubFetch(log) }
    const restore = installFetchGuard([STORAGE], stats, target)
    await target.fetch(`${STORAGE}/rest/v1/rpc/x`)
    await target.fetch('https://huggingface.co/model/resolve/main/model_quantized.onnx')
    await expect(target.fetch('https://openrouter.ai/api/v1/chat/completions')).rejects.toThrow(/blocked/)
    await expect(target.fetch(new URL('https://api.openai.com/v1/embeddings'))).rejects.toThrow(/blocked/)
    expect(stats.fetchBlocked).toEqual({ 'https://openrouter.ai': 1, 'https://api.openai.com': 1 })
    expect(log.urls).toHaveLength(2)
    restore()
  })
})

