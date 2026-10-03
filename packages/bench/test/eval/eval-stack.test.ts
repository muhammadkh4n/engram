import { describe, expect, it } from 'vitest'
import {
  GraphCheckError,
  RecallEngineError,
  applyEvalEnv,
  buildEvalStack,
  parseSystemdEnvFile,
  type EvalModules,
  type EvalRecallOptions,
  type EvalRecallResult,
  type RecallArgOptions,
} from '../../src/eval/eval-stack.js'
import { engramEnvForMeta, isRunStop } from '../../src/eval/run.js'
import { BlockedWriteError, GraphCallError } from '../../src/eval/write-guards.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const HEADER = '## Engram\n\n### Recalled Memories\n'

type RelatedSource = 'graph' | 'walk'

/** A payload with one Recalled item and, optionally, one Related item from Neo4j or the SQL association walk. */
function result(withRelated: boolean, source: RelatedSource = 'graph'): EvalRecallResult {
  const recalled = '- [episode · user · 2026-09-01] the deploy script reads the service env file'
  const related = '- [semantic · 2026-08-20] the service env file lives under /etc'
  let formatted = `${HEADER}${recalled}`
  const items: EvalRecallResult['payload'] = { items: [{ section: 'recalled', id: 'ep-1', start: HEADER.length, end: formatted.length }] }
  if (withRelated) {
    const start = formatted.length + '\n\n### Related Memories\n'.length
    formatted = `${formatted}\n\n### Related Memories\n${related}`
    items.items.push({ section: 'related', id: 'sem-7', start, end: formatted.length })
  }
  // The engine tags spreading-activation associations; walk associations carry pathStrength/depth instead.
  const metadata = source === 'graph'
    ? { graphActivation: 0.4, activationSource: 'spreading_activation' }
    : { pathStrength: 0.6, depth: 1 }
  const associations = withRelated ? [{ id: 'sem-7', metadata }] : []
  return { formatted, estimatedTokens: 40, payload: items, associations }
}

/** Stands in for the server's recallOptionsFromArgs with a shape the test can recognise. */
function fakeRecallOptionsFromArgs(args: Record<string, unknown>): RecallArgOptions | { error: string } {
  if (args['token_budget'] === 1) return { error: 'token_budget must be an integer from 256 to 32000, got 1' }
  return {
    ...(typeof args['project_id'] === 'string' ? { projectId: args['project_id'].toLowerCase() } : {}),
    ...(args['synthesize'] === true ? { synthesize: true as const } : {}),
  }
}

interface Harness {
  mods: EvalModules
  recalls: Array<{ query: string; opts: EvalRecallOptions }>
  createOpts: Array<Record<string, unknown>>
  graphInitCalls: number
  sessionConfigs: Array<Record<string, unknown>>
  restores: number
  events: string[]
  client: { rpc(fn: string): unknown; from(rel: string): Record<string, unknown> }
  driver: { session(cfg?: Record<string, unknown>): Record<string, () => Promise<unknown>> }
  readFails: boolean
  engineWarms: number
}

function harness(opts: {
  related?: boolean
  relatedSource?: RelatedSource
  graphUnavailable?: boolean
  onRecall?: (h: Harness) => void | Promise<void>
  /** What the server's maybeWithRecallEngine does: wrap storage with an engine warming to `state`, or fail to import. */
  engine?: { state: string } | 'import-failure'
} = {}): Harness {
  const h = {
    recalls: [],
    createOpts: [],
    graphInitCalls: 0,
    sessionConfigs: [],
    restores: 0,
    events: [],
    readFails: false,
    engineWarms: 0,
  } as unknown as Harness
  const engine = {
    warm: async () => {
      h.engineWarms++
    },
    stats: () => ({ state: opts.engine !== undefined && opts.engine !== 'import-failure' ? opts.engine.state : 'cold' }),
  }
  const wrapped = new WeakSet<object>()

  class FakeStorage {
    client = {
      rpc: (_fn: string) => ({ data: [], error: null }),
      from: (_rel: string) => ({ insert: () => 'inserted', select: () => 'selected' }) as Record<string, unknown>,
    }
    constructor() {
      h.client = this.client
    }
  }

  class FakeGraph {
    driver = {
      session: (cfg: Record<string, unknown> = {}) => {
        h.sessionConfigs.push(cfg)
        const read = async () => {
          if (h.readFails) throw new Error('ServiceUnavailable: connection refused')
          return 'read'
        }
        // A neo4j Result is a thenable, not a native Promise; its query outcome arrives when it is awaited.
        const result = () => ({
          then: (ok?: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => read().then(ok, fail),
        })
        return {
          executeWrite: async () => 'written',
          executeRead: read,
          readTransaction: read,
          run: result,
          beginTransaction: () => ({ run: result, commit: read }),
        } as unknown as Record<string, () => Promise<unknown>>
      },
    }
    constructor() {
      h.driver = this.driver
    }
    async initialize(): Promise<void> {
      h.graphInitCalls++
    }
  }

  h.mods = {
    createMemory: (createOpts) => {
      h.createOpts.push(createOpts)
      const memory = {
        _graph: createOpts['graph'] ?? null,
        conversations: {
          snapshot: () => 'empty',
          restore: () => {
            h.restores++
            h.events.push('reset')
          },
        },
        async initialize() {
          if (opts.graphUnavailable) memory._graph = null
        },
        async recall(query: string, recallOpts: EvalRecallOptions) {
          h.events.push(`recall:${query}`)
          h.recalls.push({ query, opts: recallOpts })
          await opts.onRecall?.(h)
          return result(opts.related ?? true, opts.relatedSource)
        },
      }
      return memory
    },
    PostgRestStorageAdapter: FakeStorage as unknown as EvalModules['PostgRestStorageAdapter'],
    openaiIntelligence: (o) => ({ built: o }) as never,
    createOnnxReranker: () => ({ load: async () => undefined, rerank: async () => [] }),
    NeuralGraph: FakeGraph as unknown as EvalModules['NeuralGraph'],
    serverCore: {
      recallOptionsFromArgs: fakeRecallOptionsFromArgs,
      chatIntelligenceOptionsFromEnv: () => ({ summarizationModel: 'chat-model' }),
      parseTimeZoneEnv: () => ({ timeZone: 'UTC' }),
      supersessionSettingsAtStartup: () => ({ mode: 'off' }),
      recallOutputPolicyAtStartup: () => ({ faint: true }),
      maybeWithRecallEngine: async (storage) => {
        if (opts.engine === undefined || opts.engine === 'import-failure') return storage
        const decorated = Object.create(storage) as typeof storage
        wrapped.add(decorated)
        return decorated
      },
    },
    recallEngineOf: (storage) => (wrapped.has(storage) ? engine : undefined),
  }
  return h
}

const BASE_ENV = { SUPABASE_URL: 'http://127.0.0.1:3000', SUPABASE_KEY: 'k', OPENAI_API_KEY: 'sk-test' }
const GRAPH_ENV = { ...BASE_ENV, NEO4J_URI: 'bolt://127.0.0.1:7687' }

describe('parseSystemdEnvFile', () => {
  it('strips one pair of surrounding quotes, keeps unquoted JSON byte-exact and skips comments', () => {
    const text = [
      '# service settings',
      '',
      'SUPABASE_URL="http://127.0.0.1:3000"',
      "ENGRAM_CHAT_MODEL='deepseek/deepseek-v4-flash'",
      'ENGRAM_CHAT_PROVIDER_PREFS={"order":["a","b"],"allow_fallbacks":false}',
      'NESTED=""quoted""',
      'EQUALS=a=b',
    ].join('\n')
    expect(parseSystemdEnvFile(text)).toEqual({
      SUPABASE_URL: 'http://127.0.0.1:3000',
      ENGRAM_CHAT_MODEL: 'deepseek/deepseek-v4-flash',
      ENGRAM_CHAT_PROVIDER_PREFS: '{"order":["a","b"],"allow_fallbacks":false}',
      NESTED: '"quoted"',
      EQUALS: 'a=b',
    })
  })

  it('names the line of a malformed entry', () => {
    expect(() => parseSystemdEnvFile('A=1\nnot an assignment')).toThrow(/line 2/)
  })
})

describe('applyEvalEnv', () => {
  it('removes every inherited stack variable and sets the file values', () => {
    const env: NodeJS.ProcessEnv = {
      ENGRAM_RECALL_LOG: '/tmp/recall.jsonl',
      ENGRAM_RECALL_FUSION: 'rrf',
      OPENAI_BASE_URL: 'http://127.0.0.1:9999',
      SUPABASE_KEY: 'inherited',
      NEO4J_URI: 'bolt://elsewhere:7687',
      KEEP: '1',
    }
    applyEvalEnv({ ENGRAM_RECALL_CORECALL: 'off', SUPABASE_KEY: 'from-file' }, env)
    expect(env).toEqual({ KEEP: '1', ENGRAM_RECALL_CORECALL: 'off', SUPABASE_KEY: 'from-file' })
  })

  it('keeps an inherited ENGRAM_RECALL_FUSION out of the effective config and the meta', async () => {
    const env: NodeJS.ProcessEnv = { ENGRAM_RECALL_FUSION: 'rrf', PATH: '/usr/bin' }
    applyEvalEnv({ ...BASE_ENV, ENGRAM_CHAT_MODEL: 'chat-model', ENGRAM_CHAT_API_KEY: 'synthetic-chat-value' }, env)
    const stack = await buildEvalStack(harness().mods, { calibrationQuery: 'c', now: NOW, env })
    expect(stack.engramEnv).toEqual({ ENGRAM_CHAT_API_KEY: 'synthetic-chat-value', ENGRAM_CHAT_MODEL: 'chat-model' })
    expect(engramEnvForMeta(stack.engramEnv)).toEqual({ ENGRAM_CHAT_API_KEY: null, ENGRAM_CHAT_MODEL: 'chat-model' })
  })
})

describe('buildEvalStack', () => {
  it('passes recall the memory_recall options plus reconsolidate: false and the reference date', async () => {
    const h = harness()
    const stack = await buildEvalStack(h.mods, { calibrationQuery: 'calibration', now: NOW, env: { ...BASE_ENV } })
    const args = { project_id: 'Engram', synthesize: true }
    const out = await stack.recall('  where is the env file  ', args, NOW)
    const expected = { ...fakeRecallOptionsFromArgs({ ...args, query: '  where is the env file  ' }), reconsolidate: false, now: NOW }
    expect(h.recalls.at(-1)).toEqual({ query: 'where is the env file', opts: expected })
    expect(out.recallOpts).toEqual(expected)
    expect(out.formatted).toBe(result(true).formatted)
    expect(out.items.map(({ section, id, line }) => ({ section, id, line }))).toEqual([
      { section: 'recalled', id: 'ep-1', line: '- [episode · user · 2026-09-01] the deploy script reads the service env file' },
      { section: 'related', id: 'sem-7', line: '- [semantic · 2026-08-20] the service env file lives under /etc' },
    ])
    for (const item of out.items) expect(out.formatted.slice(item.start, item.end)).toBe(item.line)
  })

  it('rejects arguments memory_recall would reject', async () => {
    const h = harness()
    const stack = await buildEvalStack(h.mods, { calibrationQuery: 'c', now: NOW, env: { ...BASE_ENV } })
    await expect(stack.recall('q', { token_budget: 1 }, NOW)).rejects.toThrow(/token_budget/)
  })

  it('builds the memory as the server does, minus consolidation and graph DDL', async () => {
    const h = harness()
    const stack = await buildEvalStack(h.mods, {
      calibrationQuery: 'c',
      now: NOW,
      env: { ...GRAPH_ENV, ENGRAM_RERANK_LOCAL: 'true', ENGRAM_INGEST_CONTEXTUAL: 'true' },
    })
    const created = h.createOpts[0]!
    expect(created['autoConsolidate']).toBe(false)
    expect(created['contextualRetrieval']).toBe(true)
    expect(created['supersession']).toEqual({ mode: 'off' })
    expect(created['graph']).toBeDefined()
    expect(typeof (created['intelligence'] as { rerank?: unknown }).rerank).toBe('function')
    expect((created['intelligence'] as { built: unknown }).built).toEqual({
      apiKey: 'sk-test',
      summarizationModel: 'chat-model',
      timeZone: 'UTC',
    })
    expect(h.graphInitCalls).toBe(0)
    expect(stack.graph).toBe(true)
  })

  it('guards the storage client and the graph driver it builds', async () => {
    const h = harness()
    const stack = await buildEvalStack(h.mods, { calibrationQuery: 'c', now: NOW, env: { ...GRAPH_ENV } })
    expect(() => h.client.rpc('engram_record_shown')).toThrow(/blocked/)
    expect(() => (h.client.from('memories')['insert'] as () => unknown)()).toThrow(/blocked/)
    await expect(h.driver.session()['executeWrite']!()).rejects.toThrow(/blocked/)
    expect(h.sessionConfigs.at(-1)).toEqual({ defaultAccessMode: 'READ' })
    expect(stack.guards.rpc).toEqual({ engram_record_shown: 1 })
    expect(stack.guards.builder).toEqual({ 'insert:memories': 1 })
    expect(stack.guards.graph).toEqual({ executeWrite: 1 })
  })

  it('fails when the calibration query returns no Related memories while Neo4j is configured', async () => {
    const h = harness({ related: false })
    await expect(
      buildEvalStack(h.mods, { calibrationQuery: 'what links engram and neo4j', now: NOW, env: { ...GRAPH_ENV } }),
    ).rejects.toThrow(GraphCheckError)
    expect(h.recalls.map((r) => r.query)).toEqual(['what links engram and neo4j'])
  })

  it('refuses a calibration recall whose only Related memories came from the SQL association walk', async () => {
    const h = harness({ related: true, relatedSource: 'walk' })
    await expect(
      buildEvalStack(h.mods, { calibrationQuery: 'cal', now: NOW, env: { ...GRAPH_ENV } }),
    ).rejects.toThrow(/no Related memories from Neo4j \(1 Related from the SQL association walk\)/)
  })

  it('passes the graph check when the calibration query returns a Neo4j-sourced Related memory', async () => {
    const h = harness({ related: true, relatedSource: 'graph' })
    await expect(buildEvalStack(h.mods, { calibrationQuery: 'cal', now: NOW, env: { ...GRAPH_ENV } })).resolves.toBeDefined()
    expect(h.recalls[0]!.opts).toEqual({ reconsolidate: false, now: NOW })
  })

  it('skips the graph check when Neo4j is not configured', async () => {
    const h = harness({ related: false })
    const stack = await buildEvalStack(h.mods, { calibrationQuery: 'cal', now: NOW, env: { ...BASE_ENV } })
    expect(stack.graph).toBe(false)
    expect(h.recalls).toEqual([])
    expect(h.createOpts[0]!['graph']).toBeUndefined()
  })

  it('fails when Neo4j is configured but the memory dropped it as unavailable', async () => {
    const h = harness({ graphUnavailable: true })
    await expect(buildEvalStack(h.mods, { calibrationQuery: 'c', now: NOW, env: { ...GRAPH_ENV } })).rejects.toThrow(
      /Neo4j is unavailable/,
    )
  })

  it('fails the recall when it attempted a blocked write, even if the engine swallowed the error', async () => {
    const h = harness({
      onRecall: (self) => {
        try {
          self.client.rpc('engram_record_access')
        } catch {
          // the engine's fire-and-forget writes catch their own errors
        }
      },
    })
    const stack = await buildEvalStack(h.mods, { calibrationQuery: 'c', now: NOW, env: { ...BASE_ENV } })
    await expect(stack.recall('q', {}, NOW)).rejects.toThrow(BlockedWriteError)
  })

  it('resets the per-conversation state before every recall', async () => {
    const h = harness()
    const stack = await buildEvalStack(h.mods, { calibrationQuery: 'cal', now: NOW, env: { ...GRAPH_ENV } })
    await stack.recall('first', {}, NOW)
    await stack.recall('second', {}, NOW)
    expect(h.events).toEqual(['reset', 'recall:cal', 'reset', 'recall:first', 'reset', 'recall:second'])
  })

  it('requires the storage and model credentials the server requires', async () => {
    const h = harness()
    await expect(
      buildEvalStack(h.mods, { calibrationQuery: 'c', now: NOW, env: { SUPABASE_URL: 'http://127.0.0.1:3000' } }),
    ).rejects.toThrow(/SUPABASE_KEY/)
  })

  type GraphSession = Record<string, (() => PromiseLike<unknown>) | undefined> & {
    beginTransaction: () => Record<string, () => PromiseLike<unknown>>
  }
  const swallowedGraphCalls: Array<[string, (s: GraphSession) => PromiseLike<unknown>]> = [
    ['executeRead', (s) => s['executeRead']!()],
    ['readTransaction', (s) => s['readTransaction']!()],
    ['run', (s) => s['run']!()],
    ['beginTransaction.run', (s) => s.beginTransaction()['run']!()],
    ['beginTransaction.commit', (s) => s.beginTransaction()['commit']!()],
  ]

  it.each(swallowedGraphCalls)('stops a gold recall on a failed %s the engine awaited and swallowed', async (call, invoke) => {
    const h = harness({
      onRecall: async (self) => {
        // spreading activation awaits graph calls in try/catch and falls back to the SQL walk
        try {
          await invoke(self.driver.session() as unknown as GraphSession)
        } catch {
          // swallowed, as the engine does
        }
      },
    })
    const stack = await buildEvalStack(h.mods, { calibrationQuery: 'cal', now: NOW, env: { ...GRAPH_ENV } })
    h.readFails = true
    const err = await stack.recall('gold query', {}, NOW).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GraphCallError)
    expect((err as Error).message).toContain(call)
    expect(isRunStop(err)).toBe(true)
    expect(stack.guards.graphErrors).toEqual({ [call]: 1 })
  })

  it('stops when the recall engine is on but failed to import, leaving storage unwrapped', async () => {
    const h = harness({ engine: 'import-failure' })
    const err = await buildEvalStack(h.mods, {
      calibrationQuery: 'c',
      now: NOW,
      env: { ...BASE_ENV, ENGRAM_RECALL_ENGINE: 'true' },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecallEngineError)
    expect((err as Error).message).toMatch(/failed to import/)
    expect(isRunStop(err)).toBe(true)
    expect(h.createOpts).toEqual([])
  })

  it('stops when the recall engine does not warm to ready', async () => {
    const h = harness({ engine: { state: 'disabled' } })
    await expect(
      buildEvalStack(h.mods, { calibrationQuery: 'c', now: NOW, env: { ...BASE_ENV, ENGRAM_RECALL_ENGINE: 'true' } }),
    ).rejects.toThrow(/warmed to "disabled"/)
  })

  it('awaits the engine warm-up and reports the engine on', async () => {
    const h = harness({ engine: { state: 'ready' } })
    const stack = await buildEvalStack(h.mods, {
      calibrationQuery: 'c',
      now: NOW,
      env: { ...BASE_ENV, ENGRAM_RECALL_ENGINE: 'true' },
    })
    expect(stack.recallEngine).toBe(true)
    expect(h.engineWarms).toBe(1)
    const off = await buildEvalStack(harness().mods, { calibrationQuery: 'c', now: NOW, env: { ...BASE_ENV } })
    expect(off.recallEngine).toBe(false)
  })
})
