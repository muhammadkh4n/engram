import { describe, expect, it } from 'vitest'
import {
  GraphCheckError,
  applyEvalEnv,
  buildEvalStack,
  parseSystemdEnvFile,
  type EvalModules,
  type EvalRecallOptions,
  type EvalRecallResult,
  type RecallArgOptions,
} from '../../src/eval/eval-stack.js'
import { BlockedWriteError } from '../../src/eval/write-guards.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const HEADER = '## Engram\n\n### Recalled Memories\n'

/** A payload with one Recalled item and, optionally, one Related item. */
function result(withRelated: boolean): EvalRecallResult {
  const recalled = '- [episode · user · 2026-09-01] the deploy script reads the service env file'
  const related = '- [semantic · 2026-08-20] the service env file lives under /etc'
  let formatted = `${HEADER}${recalled}`
  const items: EvalRecallResult['payload'] = { items: [{ section: 'recalled', id: 'ep-1', start: HEADER.length, end: formatted.length }] }
  if (withRelated) {
    const start = formatted.length + '\n\n### Related Memories\n'.length
    formatted = `${formatted}\n\n### Related Memories\n${related}`
    items.items.push({ section: 'related', id: 'sem-7', start, end: formatted.length })
  }
  return { formatted, estimatedTokens: 40, payload: items }
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
}

function harness(opts: {
  related?: boolean
  graphUnavailable?: boolean
  onRecall?: (h: Harness) => void
} = {}): Harness {
  const h = {
    recalls: [],
    createOpts: [],
    graphInitCalls: 0,
    sessionConfigs: [],
    restores: 0,
    events: [],
  } as unknown as Harness

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
        return { executeWrite: async () => 'written', executeRead: async () => 'read' } as Record<string, () => Promise<unknown>>
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
          opts.onRecall?.(h)
          return result(opts.related ?? true)
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
      maybeWithRecallEngine: async (storage) => storage,
    },
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
  it('removes an inherited recall log variable and sets the file values', () => {
    const env: NodeJS.ProcessEnv = { ENGRAM_RECALL_LOG: '/tmp/recall.jsonl', KEEP: '1' }
    applyEvalEnv({ ENGRAM_RECALL_CORECALL: 'off' }, env)
    expect(env).toEqual({ KEEP: '1', ENGRAM_RECALL_CORECALL: 'off' })
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
    expect(out.items).toEqual([
      { section: 'recalled', id: 'ep-1', line: '- [episode · user · 2026-09-01] the deploy script reads the service env file' },
      { section: 'related', id: 'sem-7', line: '- [semantic · 2026-08-20] the service env file lives under /etc' },
    ])
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

  it('passes the graph check when the calibration query returns a Related memory', async () => {
    const h = harness({ related: true })
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
})
