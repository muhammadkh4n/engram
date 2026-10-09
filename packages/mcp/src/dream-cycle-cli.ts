#!/usr/bin/env node
/**
 * engram-dream-cycle — one-shot CLI that runs a single dream cycle and exits.
 *
 * A manual one-shot run. The MCP server's consolidation worker schedules
 * dream itself when it is due; use this CLI only to force a run by hand.
 * It builds its intelligence from OPENAI_API_KEY with the default chat
 * model, not the server's chat settings (model, base URL, provider
 * preferences, reasoning), so its summaries can differ from scheduled runs.
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD     (dream cycle needs the graph
 *                                              — exits non-zero if absent)
 *
 * Optional env (cost ceilings — defaults from dream-cycle.ts):
 *   ENGRAM_DREAM_MAX_COMMUNITIES=200    hard cap on summaries per run
 *   ENGRAM_DREAM_MAX_USD=2.00           hard cap on estimated LLM spend
 *   ENGRAM_DREAM_MODEL=gpt-4o-mini      pricing model for the estimate
 *
 * Exit codes:
 *   0  ran to completion (possibly capped — see result JSON)
 *   1  fatal config or runtime error
 *
 * Output: single JSON object on stdout with the ConsolidateResult. Logs
 * to stderr.
 */

import { CliExit, exitOnError, exitWhenFlushed } from './cli-exit.js'
import { createMemory, dreamCycle } from '@engram-mem/core'
import type { StorageAdapter } from '@engram-mem/core'
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
import { openaiIntelligence } from '@engram-mem/openai'
import { tryCreateGraph } from './graph-helper.js'

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    throw new CliExit(1, `[engram-dream-cycle] Missing required environment variable: ${name}`)
  }
  return val
}

function readFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const supabaseKey = requireEnv('SUPABASE_KEY')
  const openaiApiKey = requireEnv('OPENAI_API_KEY')

  // Type as the abstract interface so optional fields like consolidationRuns
  // are visible — Supabase doesn't implement consolidation_runs persistence
  // yet (v0.3.13 work), but the interface guard `if (storage.consolidationRuns)`
  // must compile against the StorageAdapter shape.
  const storage: StorageAdapter = new PostgRestStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  const intelligence = openaiIntelligence({ apiKey: openaiApiKey })

  const graph = await tryCreateGraph('[engram-dream-cycle]')
  if (!graph) {
    throw new CliExit(1, '[engram-dream-cycle] Neo4j unavailable — dream cycle requires graph backing. Set NEO4J_URI/USER/PASSWORD.')
  }

  // Initialize a Memory just to run storage.initialize() — dreamCycle()
  // operates on storage + graph directly, so we don't actually need the
  // Memory instance itself afterwards.
  //
  // Wave 5: dream-cycle is intentionally GLOBAL — it runs on a systemd timer
  // and consolidates communities across every project. No projectId is set
  // here on purpose. If per-project dream cycles are ever needed, add a
  // --project flag and resolve it via resolveProjectScope(), then thread the
  // scope into dreamCycle()'s graph queries.
  const memory = createMemory({ storage, intelligence, graph })
  await memory.initialize()

  const maxCommunities = readIntEnv('ENGRAM_DREAM_MAX_COMMUNITIES', 200)
  const maxLlmCallsUsd = readFloatEnv('ENGRAM_DREAM_MAX_USD', 2.00)
  const llmCostModel = (process.env['ENGRAM_DREAM_MODEL'] as 'gpt-4o-mini' | 'gpt-4o') ?? 'gpt-4o-mini'

  const start = Date.now()
  console.error(`[engram-dream-cycle] starting (maxCommunities=${maxCommunities}, maxUsd=$${maxLlmCallsUsd.toFixed(2)}, model=${llmCostModel})`)

  const result = await dreamCycle(
    storage,
    { maxCommunities, maxLlmCallsUsd, llmCostModel },
    graph,
    intelligence,
  )

  // Snapshot episode count so the in-process Phase 2 delta gate can use it.
  if (storage.episodes.count) {
    try {
      result.episodeCount = await storage.episodes.count()
    } catch { /* non-fatal */ }
  }

  // Record into consolidation_runs so the in-process worker's
  // isDreamCycleDue() correctly sees this run on its next tick and skips
  // the time gate. Without this, the worker would try to re-fire on top
  // of us next time it ticks (cycles filter notwithstanding).
  if (storage.consolidationRuns) {
    try {
      const runId = await storage.consolidationRuns.recordStart('dream')
      await storage.consolidationRuns.recordComplete(runId, result, Date.now() - start)
    } catch (err) {
      console.error('[engram-dream-cycle] failed to record run in consolidation_runs:', (err as Error).message)
    }
  }

  const durationMs = Date.now() - start
  console.error(`[engram-dream-cycle] completed in ${durationMs}ms`)
  if (result.cappedAt) {
    console.error(`[engram-dream-cycle] WARNING: capped at ${result.cappedAt}`)
  }

  // JSON result on stdout for tooling (systemd journal will capture, plus
  // any downstream cron-style monitoring can parse it).
  process.stdout.write(JSON.stringify({ ...result, durationMs }, null, 2) + '\n')

  await memory.dispose()
  await exitWhenFlushed(0) // capping is non-fatal — exit 0 either way
}

main().catch((err: unknown) =>
  exitOnError(err, (e) => console.error('[engram-dream-cycle] fatal:', e instanceof Error ? e.stack : String(e))),
)
