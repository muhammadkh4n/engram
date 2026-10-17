/**
 * The MCP tool dispatch hands the SDK's request signal to the recall tools.
 *
 * Its own file because the memory stack is built once per module (sharedInit),
 * so the mocks below must be in place before server-core first builds it. No
 * store, model or graph is reached: every adapter the stack builds is a stub,
 * and the two tools are spies.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const tools = vi.hoisted(() => ({
  recall: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'tst recall' }] })),
  timeline: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'tst timeline' }] })),
}))

vi.mock('../src/recall-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/recall-tools.js')>()),
  runMemoryRecall: tools.recall,
  runMemoryTimeline: tools.timeline,
}))

vi.mock('@engram-mem/postgrest', async (importOriginal) => {
  class StubStore {}
  return {
    ...(await importOriginal<typeof import('@engram-mem/postgrest')>()),
    PostgRestStorageAdapter: StubStore,
    PostgRestCaptureStore: StubStore,
    PostgRestItemStore: StubStore,
    PostgRestRecallStore: StubStore,
  }
})

vi.mock('@engram-mem/openai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@engram-mem/openai')>()),
  openaiIntelligence: () => ({}),
}))

vi.mock('../src/graph-helper.js', () => ({ tryCreateGraph: async () => null }))

vi.mock('@engram-mem/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@engram-mem/core')>()),
  createMemory: () => ({ initialize: async () => {} }),
}))

import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createEngramServer } from '../src/server-core.js'

type CallTool = (request: unknown, extra: { signal: AbortSignal }) => Promise<unknown>

/** The handler the server registered for tools/call, called the way the SDK calls it. */
function callToolHandler(): CallTool {
  const server = createEngramServer() as unknown as { _requestHandlers: Map<string, CallTool> }
  const method = CallToolRequestSchema.shape.method.value
  const handler = server._requestHandlers.get(method)
  if (!handler) throw new Error(`no handler registered for ${method}`)
  return handler
}

describe('the MCP tool dispatch', () => {
  beforeAll(() => {
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:1')
    vi.stubEnv('SUPABASE_KEY', 'tst-key')
    vi.stubEnv('OPENAI_API_KEY', 'tst-openai-key')
    vi.stubEnv('ENGRAM_RERANK_LOCAL', '')
    vi.stubEnv('ENGRAM_RECALL_ENGINE', '')
    vi.stubEnv('ENGRAM_CONSOLIDATION', 'off')
    vi.stubEnv('ENGRAM_RECALL_LOG', '')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('passes the request signal to memory_recall', async () => {
    const ctrl = new AbortController()
    const args = { query: 'tst floor' }

    await callToolHandler()({ method: 'tools/call', params: { name: 'memory_recall', arguments: args } }, { signal: ctrl.signal })

    expect(tools.recall).toHaveBeenCalledTimes(1)
    expect(tools.recall).toHaveBeenCalledWith(expect.anything(), args, ctrl.signal)
  })

  it('passes the request signal to memory_timeline', async () => {
    const ctrl = new AbortController()
    const args = { query: 'tst floor' }

    await callToolHandler()({ method: 'tools/call', params: { name: 'memory_timeline', arguments: args } }, { signal: ctrl.signal })

    expect(tools.timeline).toHaveBeenCalledTimes(1)
    expect(tools.timeline).toHaveBeenCalledWith(expect.anything(), args, ctrl.signal)
  })
})
