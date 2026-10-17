/**
 * The MCP tool dispatch hands the SDK's request signal to the recall tools.
 *
 * Its own file because the memory stack is built once per module (sharedInit),
 * so the mocks below must be in place before server-core first builds it. No
 * store, model or graph is reached: every adapter the stack builds is a stub,
 * and the two tools are spies. The client talks to the server over the SDK's
 * in-memory transport, which, like stdio, delivers a client's cancel to the
 * server running the call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }

/**
 * Each spy answers at once, or, while `hold` is set, records its signal and
 * answers only once that signal aborts.
 */
const tools = vi.hoisted(() => {
  const state = { hold: false, seen: [] as AbortSignal[], reached: () => {} }
  const spy = (text: string) =>
    vi.fn(async (_deps: unknown, _args: unknown, signal?: AbortSignal): Promise<ToolResult> => {
      if (signal) state.seen.push(signal)
      if (!state.hold || !signal) return { content: [{ type: 'text', text }] }
      state.reached()
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: `${text} stopped` }] }), { once: true })
      })
    })
  return { state, recall: spy('tst recall'), timeline: spy('tst timeline') }
})

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

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createEngramServer } from '../src/server-core.js'

async function connect(): Promise<Client> {
  const server = createEngramServer()
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'tst-client', version: '0.0.0' })
  await client.connect(clientSide)
  return client
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

  beforeEach(() => {
    tools.state.hold = false
    tools.state.seen.length = 0
    tools.recall.mockClear()
    tools.timeline.mockClear()
  })

  it.each([
    ['memory_recall', tools.recall, 'tst recall'],
    ['memory_timeline', tools.timeline, 'tst timeline'],
  ] as const)('answers %s with the tool result and hands the tool a live request signal', async (name, spy, text) => {
    const client = await connect()
    const args = { query: 'tst floor' }

    const result = await client.callTool({ name, arguments: args })

    expect(result).toEqual({ content: [{ type: 'text', text }] })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(expect.anything(), args, expect.any(AbortSignal))
    expect(tools.state.seen[0]!.aborted).toBe(false)
    await client.close()
  })

  it.each([
    ['memory_recall', tools.recall],
    ['memory_timeline', tools.timeline],
  ] as const)('aborts the signal %s holds when the client cancels the call', async (name, spy) => {
    const client = await connect()
    tools.state.hold = true
    const reached = new Promise<void>((resolve) => {
      tools.state.reached = resolve
    })
    const cancel = new AbortController()

    const call = client.callTool({ name, arguments: { query: 'tst floor' } }, undefined, { signal: cancel.signal }).catch((e: unknown) => e)
    await reached
    cancel.abort()
    await call

    expect(spy).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(tools.state.seen[0]!.aborted).toBe(true)
    })
    await client.close()
  })
})
