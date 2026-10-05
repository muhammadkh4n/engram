#!/usr/bin/env node
/**
 * Engram Memory MCP Server — Streamable HTTP transport.
 *
 * Shared deployment endpoint so multiple Claude / agent clients can hit one
 * server instance over the network instead of each spawning a local stdio
 * process. Designed to run on a private network (tailnet) with bearer auth.
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY
 *   BEARER_TOKEN          — required for all /mcp and /capture requests
 *
 * Optional env:
 *   PORT                  — default 3849
 *   HOST                  — default 0.0.0.0
 *   ALLOWED_HOSTS         — comma-separated allowlist for Host header (DNS-rebind guard).
 *                           If unset, every host is allowed.
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 *   ENGRAM_SALIENCE_THRESHOLD — capture classifier confidence cut, 0..1, default 0.7
 *   ENGRAM_CAPTURE_TOKEN  — enables POST /capture/events (at least 32 chars, not
 *                           BEARER_TOKEN). When set, ENGRAM_PROJECT_REGISTRY_FILE
 *                           (a valid registry) and ENGRAM_SECRET_SOURCES_FILE are
 *                           required too, or startup fails naming the variable.
 *                           The capture worker then materializes stored events
 *                           and embeds the new items.
 */

import http from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  createEngramServer,
  getCaptureDeps,
  recallOutputPolicyAtStartup,
  captureModelFromEnv,
  parseSalienceThresholdEnv,
} from './server-core.js'
import { defaultSecretRegistry, EMBED_TEXT_VERSION } from '@engram-mem/core'
import { OpenAIEmbeddingService } from '@engram-mem/openai'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { createRequestListener, loadHttpConfig } from './http-app.js'
import { loadProjectRegistry, startProjectSync, type ProjectRegistry, type ProjectSync } from './capture-events/project-registry.js'
import type { CaptureEventsRouteDeps } from './capture-events/route.js'
import { startCaptureWorker, type CaptureWorker } from './capture-events/worker.js'
import { isEntryPoint } from './ingest/entry-point.js'

export interface CaptureEventsConfig {
  registry: ProjectRegistry
  supabaseUrl: string
  supabaseKey: string
  openaiApiKey: string
}

/** How long a shutdown waits for the worker's tick and open connections before cutting them. */
export const SHUTDOWN_GRACE_MS = 10_000

export interface ShutdownDeps {
  worker: Pick<CaptureWorker, 'stop'> | null
  sync: Pick<ProjectSync, 'stop'> | null
  httpServer: Pick<http.Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>
  graceMs?: number
  log?: (line: string) => void
}

/**
 * Stops the worker, the project sync and the HTTP server side by side under
 * one grace, and resolves to the process exit code: 0, or 1 when a step
 * throws. The server stops accepting at once and drops idle keep-alive
 * connections; a connection still open at the grace is cut, as is a worker
 * tick still running. Nothing is lost by cutting: a materialize call commits
 * or rolls back whole, releasing its lock, and an unwritten embedding batch
 * stays pending.
 */
export async function shutdown(deps: ShutdownDeps): Promise<number> {
  const graceMs = deps.graceMs ?? SHUTDOWN_GRACE_MS
  const log = deps.log ?? (() => {})
  const fail = (step: string) => (err: unknown): boolean => {
    log(`shutdown: ${step} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }

  const stopWorker = (async () => {
    await deps.worker?.stop(graceMs)
    return true
  })().catch(fail('worker stop'))

  const stopSync = (async () => {
    deps.sync?.stop()
    return true
  })().catch(fail('project sync stop'))

  const closeServer = new Promise<boolean>((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    try {
      deps.httpServer.close((err) => {
        clearTimeout(forceTimer)
        if (err) reject(err)
        else resolve(true)
      })
      deps.httpServer.closeIdleConnections()
      forceTimer = setTimeout(() => deps.httpServer.closeAllConnections(), graceMs)
    } catch (err) {
      clearTimeout(forceTimer)
      reject(err)
    }
  }).catch(fail('http server close'))

  const results = await Promise.all([stopWorker, stopSync, closeServer])
  return results.every(Boolean) ? 0 : 1
}

/** Variables /capture/events needs beside its token: the registry, the scrubber's sources, the store and the embedder. */
const CAPTURE_EVENTS_REQUIRED_ENV = [
  'ENGRAM_PROJECT_REGISTRY_FILE',
  'ENGRAM_SECRET_SOURCES_FILE',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'OPENAI_API_KEY',
] as const

/**
 * The capture-events configuration, or null while ENGRAM_CAPTURE_TOKEN is
 * unset. With the token set, a missing variable or an invalid project
 * registry throws naming the variable, so the server never starts with a
 * route that could only answer 503.
 */
export function captureEventsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureEventsConfig | null {
  if (!env['ENGRAM_CAPTURE_TOKEN']) return null
  for (const name of CAPTURE_EVENTS_REQUIRED_ENV) {
    if (!env[name]) throw new Error(`ENGRAM_CAPTURE_TOKEN is set, so ${name} is required`)
  }
  let registry: ProjectRegistry
  try {
    registry = loadProjectRegistry(env['ENGRAM_PROJECT_REGISTRY_FILE']!)
  } catch (err) {
    throw new Error(`ENGRAM_PROJECT_REGISTRY_FILE: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    registry,
    supabaseUrl: env['SUPABASE_URL']!,
    supabaseKey: env['SUPABASE_KEY']!,
    openaiApiKey: env['OPENAI_API_KEY']!,
  }
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // MCP Streamable HTTP requires `Accept: application/json, text/event-stream`.
  // Some clients (notably Claude Code's HTTP MCP client) send only one of the two,
  // which the SDK rejects with 406. Normalize the header so the SDK sees both.
  const incomingAccept = (req.headers['accept'] ?? '').toString()
  if (req.method === 'POST') {
    const wantsJson = incomingAccept.includes('application/json') || incomingAccept.includes('*/*') || incomingAccept === ''
    const wantsSse = incomingAccept.includes('text/event-stream') || incomingAccept.includes('*/*') || incomingAccept === ''
    if (wantsJson && wantsSse) {
      req.headers['accept'] = 'application/json, text/event-stream'
    }
  }

  const server = createEngramServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode — Engram has no per-session state
    enableJsonResponse: true,
  })

  res.on('close', () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  })

  await server.connect(transport)
  await transport.handleRequest(req, res)
}

async function main(): Promise<void> {
  const config = loadHttpConfig()
  // Parsed before listening so a malformed threshold fails startup instead
  // of silently gating every capture at a value nobody chose.
  const threshold = parseSalienceThresholdEnv()
  const captureModel = captureModelFromEnv()
  recallOutputPolicyAtStartup()
  const log = (line: string): void => {
    process.stderr.write(`[engram-mcp-http] ${line}\n`)
  }

  const captureEventsConfig = captureEventsConfigFromEnv()
  let projectSync: ProjectSync | null = null
  let worker: CaptureWorker | null = null
  let captureEvents: CaptureEventsRouteDeps | undefined
  if (captureEventsConfig !== null) {
    const store = new PostgRestCaptureStore({ url: captureEventsConfig.supabaseUrl, key: captureEventsConfig.supabaseKey })
    projectSync = startProjectSync(store, captureEventsConfig.registry, log)
    captureEvents = {
      store,
      ready: projectSync.ready,
      status: () => defaultSecretRegistry().status(),
      log,
    }
    const embedder = new OpenAIEmbeddingService({
      apiKey: captureEventsConfig.openaiApiKey,
      model: 'text-embedding-3-small',
    })
    worker = startCaptureWorker({
      store,
      embedder,
      embeddingModel: `text-embedding-3-small:${embedder.dimensions()}:v${EMBED_TEXT_VERSION}`,
      log,
    })
  }

  const httpServer = http.createServer(
    createRequestListener(config, {
      mcp: handleMcp,
      capture: {
        captureModel,
        captureDeps: () => getCaptureDeps({ threshold, captureModel }),
        log,
      },
      captureEvents,
    }),
  )

  httpServer.listen(config.port, config.host, () => {
    process.stdout.write(`[engram-mcp-http] listening on http://${config.host}:${config.port}/mcp\n`)
  })

  let shuttingDown = false
  const onSignal = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write(`[engram-mcp-http] ${signal} — shutting down\n`)
    void shutdown({ worker, sync: projectSync, httpServer, log }).then((code) => process.exit(code))
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[engram-mcp-http] Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
