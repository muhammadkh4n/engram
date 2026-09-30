import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Memory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createEngramContextEngine } from '../src/plugin-entry.js'

// The OpenClaw SDK is a peer dependency that is not installed for tests;
// definePluginEntry only wraps the entry object.
vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: <T>(entry: T): T => entry,
}))

type Engine = {
  assemble(params: {
    sessionId: string
    messages: Array<{ role: string; content: unknown }>
    tokenBudget?: number
  }): Promise<unknown>
  dispose(): Promise<void>
}

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OPENAI_API_KEY'] as const

describe('per-turn auto-recall skips trivial turns', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]
    }
    vi.restoreAllMocks()
  })

  it('the OpenClaw plugin assemble() recalls with skipTrivial: true', async () => {
    const recallSpy = vi.spyOn(Memory.prototype, 'recall')
    const { default: entry } = await import('../src/openclaw-plugin.js')
    let factory: (() => unknown) | undefined
    ;(entry as unknown as { register(api: unknown): void }).register({
      pluginConfig: { storagePath: ':memory:' },
      registerContextEngine: (_id: string, f: () => unknown) => {
        factory = f
      },
      registerTool: () => {},
    })
    const engine = factory!() as Engine

    await engine.assemble({
      sessionId: 's1',
      messages: [{ role: 'user', content: 'continue the SAM migration' }],
      tokenBudget: 1000,
    })
    await engine.dispose()

    expect(recallSpy).toHaveBeenCalledWith(
      'continue the SAM migration',
      expect.objectContaining({ skipTrivial: true }),
    )
  })

  it('the context-engine entry assemble() recalls with skipTrivial: true', async () => {
    const recallSpy = vi.spyOn(Memory.prototype, 'recall')
    const engine = createEngramContextEngine({ storage: sqliteAdapter() })
    await engine.bootstrap()

    await engine.assemble({
      messages: [{ role: 'user', content: 'lgtm' }],
      tokenBudget: 1000,
    })
    await engine.dispose()

    expect(recallSpy).toHaveBeenCalledWith('lgtm', expect.objectContaining({ skipTrivial: true }))
  })
})
