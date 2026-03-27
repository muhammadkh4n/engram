/**
 * Mock OpenClaw runtime that simulates the ContextEngine lifecycle.
 * This mimics what the real OpenClaw runtime does:
 * 1. bootstrap() — called once on startup
 * 2. For each user message:
 *    a. ingest() — store the message
 *    b. assemble() — build context for the model (calls recall)
 *    c. [model generates response]
 *    d. ingest() — store the assistant response
 *    e. afterTurn() — post-turn processing
 * 3. ingestBatch() — called at end of a run with all messages
 * 4. compact() — called when context overflows or manually
 * 5. dispose() — called on shutdown
 */
import type { StorageAdapter, IntelligenceAdapter } from '@engram/core'
import { createEngramContextEngine } from '../src/plugin-entry.js'
import { createEngramTools } from '../src/tools.js'

type ContextEngine = ReturnType<typeof createEngramContextEngine>
type EngramTools = ReturnType<typeof createEngramTools>

export interface ChatResult {
  systemPromptAddition: string | undefined
  conversationLength: number
  assembledTokens: number
}

export class MockOpenClawRuntime {
  private engine: ContextEngine
  private tools: EngramTools
  private conversationHistory: Array<{ role: string; content: string }> = []
  private sessionId: string
  private started = false

  constructor(config: {
    storage: StorageAdapter
    intelligence?: IntelligenceAdapter
    sessionId?: string
  }) {
    this.engine = createEngramContextEngine({
      storage: config.storage,
      intelligence: config.intelligence,
    })
    this.tools = createEngramTools(this.engine.getMemory())
    this.sessionId = config.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  /**
   * Initialize the runtime — calls engine.bootstrap().
   */
  async start(): Promise<void> {
    await this.engine.bootstrap()
    this.started = true
  }

  /**
   * Simulate a user sending a message and getting a response.
   * Runs the full OpenClaw ContextEngine lifecycle:
   *   1. ingest user message
   *   2. assemble context (calls recall)
   *   3. capture systemPromptAddition
   *   4. ingest assistant response
   *   5. afterTurn()
   */
  async chat(userMessage: string, assistantResponse?: string): Promise<ChatResult> {
    this.assertStarted()

    // 1. Ingest the user message
    await this.engine.ingest({
      sessionId: this.sessionId,
      message: { role: 'user', content: userMessage },
    })
    this.conversationHistory.push({ role: 'user', content: userMessage })

    // 2. Assemble context — this is what the runtime does before calling the LLM
    const currentMessages = this.conversationHistory.map(m => ({
      role: m.role,
      content: m.content,
    }))

    const assembled = await this.engine.assemble({
      messages: currentMessages,
      tokenBudget: 4000,
    })

    // 3. Simulate the LLM generating a response
    const response = assistantResponse ?? `Acknowledged: ${userMessage.slice(0, 60)}`

    // 4. Ingest the assistant response
    await this.engine.ingest({
      sessionId: this.sessionId,
      message: { role: 'assistant', content: response },
    })
    this.conversationHistory.push({ role: 'assistant', content: response })

    // 5. Post-turn hook
    await this.engine.afterTurn()

    return {
      systemPromptAddition: assembled.systemPromptAddition,
      conversationLength: this.conversationHistory.length,
      assembledTokens: assembled.estimatedTokens,
    }
  }

  /**
   * Call a registered Engram tool by name.
   */
  async callTool(name: keyof EngramTools, params: Record<string, unknown> = {}): Promise<unknown> {
    this.assertStarted()
    const tool = this.tools[name]
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }
    // Each tool's execute may have different signatures; cast broadly
    return (tool.execute as (p: Record<string, unknown>) => Promise<unknown>)(params)
  }

  /**
   * Trigger compaction — simulates context overflow handling.
   */
  async compact(): Promise<void> {
    this.assertStarted()
    await this.engine.compact({ sessionId: this.sessionId })
  }

  /**
   * Run ingestBatch with the full conversation history.
   * In a real OpenClaw run this is called at end-of-run to
   * guarantee all messages are durably stored.
   */
  async endRun(): Promise<void> {
    this.assertStarted()
    await this.engine.ingestBatch({
      sessionId: this.sessionId,
      messages: this.conversationHistory,
    })
  }

  /**
   * Shutdown — calls engine.dispose().
   */
  async stop(): Promise<void> {
    if (this.started) {
      await this.engine.dispose()
      this.started = false
    }
  }

  /**
   * Return a copy of the conversation history.
   */
  getHistory(): Array<{ role: string; content: string }> {
    return [...this.conversationHistory]
  }

  /**
   * Expose the underlying engine for advanced test assertions.
   */
  getEngine(): ContextEngine {
    return this.engine
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('MockOpenClawRuntime not started. Call start() first.')
    }
  }
}
