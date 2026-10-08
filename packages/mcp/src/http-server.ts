/**
 * The Streamable HTTP server: configuration from the environment, startup and
 * a clean shutdown. index-http.ts is the entry that runs main(); this module
 * never starts anything on import, so tests can load it.
 */

import { exitWhenFlushed } from './cli-exit.js'
import http from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  createEngramServer,
  getCaptureDeps,
  recallOutputPolicyAtStartup,
  consolidationAtStartup,
  extractionHeldFromEnv,
  captureModelFromEnv,
  parseExtractWindowsPerTickEnv,
  chatIntelligenceOptionsFromEnv,
  parseSalienceThresholdEnv,
} from './server-core.js'
import { defaultSecretRegistry, EMBED_TEXT_VERSION } from '@engram-mem/core'
import { OpenAIEmbeddingService, openaiIntelligence } from '@engram-mem/openai'
import { PostgRestCaptureStore, PostgRestItemStore } from '@engram-mem/postgrest'
import { createRequestListener, loadHttpConfig } from './http-app.js'
import { loadProjectRegistry, startProjectSync, type ProjectRegistry, type ProjectSync } from './capture-events/project-registry.js'
import type { CaptureEventsRouteDeps } from './capture-events/route.js'
import type { DocumentsRouteDeps } from './documents-route.js'
import { startCaptureWorker, type CaptureWorker } from './capture-events/worker.js'
import { CAPTURE_SERVER_REQUIRED_ENV } from './capture-events/server-env.js'

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

/**
 * The capture-events configuration, or null while ENGRAM_CAPTURE_TOKEN is
 * unset. With the token set, a missing variable or an invalid project
 * registry throws naming the variable, so the server never starts with a
 * route that could only answer 503.
 */
export function captureEventsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureEventsConfig | null {
  if (!env['ENGRAM_CAPTURE_TOKEN']) return null
  for (const name of CAPTURE_SERVER_REQUIRED_ENV) {
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

export interface DocumentsConfig {
  registry: ProjectRegistry
  supabaseUrl: string
  supabaseKey: string
}

/**
 * What /documents/sync cannot run without: the registry that scopes a note,
 * the scrubber's sources (a server without them could only answer 503) and
 * the store.
 */
export const DOCUMENTS_SERVER_REQUIRED_ENV = [
  'ENGRAM_PROJECT_REGISTRY_FILE',
  'ENGRAM_SECRET_SOURCES_FILE',
  'SUPABASE_URL',
  'SUPABASE_KEY',
] as const

/**
 * The documents-sync configuration, or null while ENGRAM_DOCUMENTS_TOKEN is
 * unset. With the token set, a missing variable or an invalid project
 * registry throws naming the variable.
 */
export function documentsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DocumentsConfig | null {
  if (!env['ENGRAM_DOCUMENTS_TOKEN']) return null
  for (const name of DOCUMENTS_SERVER_REQUIRED_ENV) {
    if (!env[name]) throw new Error(`ENGRAM_DOCUMENTS_TOKEN is set, so ${name} is required`)
  }
  let registry: ProjectRegistry
  try {
    registry = loadProjectRegistry(env['ENGRAM_PROJECT_REGISTRY_FILE']!)
  } catch (err) {
    throw new Error(`ENGRAM_PROJECT_REGISTRY_FILE: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { registry, supabaseUrl: env['SUPABASE_URL']!, supabaseKey: env['SUPABASE_KEY']! }
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

export async function main(): Promise<void> {
  const config = loadHttpConfig()
  // Parsed before listening so a malformed threshold fails startup instead
  // of silently gating every capture at a value nobody chose.
  const threshold = parseSalienceThresholdEnv()
  const captureModel = captureModelFromEnv()
  const extractWindowsPerTick = parseExtractWindowsPerTickEnv()
  recallOutputPolicyAtStartup()
  consolidationAtStartup()
  const extractionHeld = extractionHeldFromEnv()
  const log = (line: string): void => {
    process.stderr.write(`[engram-mcp-http] ${line}\n`)
  }

  const captureEventsConfig = captureEventsConfigFromEnv()
  const documentsConfig = documentsConfigFromEnv()
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
      extraction: {
        store,
        intelligence: openaiIntelligence({
          apiKey: captureEventsConfig.openaiApiKey,
          ...chatIntelligenceOptionsFromEnv(),
        }),
        model: captureModel,
        windowsPerTick: extractWindowsPerTick,
      },
      sessionIndex: { store },
      extractionHeld,
      log,
    })
  }

  let documents: DocumentsRouteDeps | undefined
  if (documentsConfig !== null) {
    // Both routes read one registry file, so a server running both shares
    // the capture route's sync instead of writing the same rows twice.
    if (projectSync === null) {
      const syncStore = new PostgRestCaptureStore({ url: documentsConfig.supabaseUrl, key: documentsConfig.supabaseKey })
      projectSync = startProjectSync(syncStore, documentsConfig.registry, log)
    }
    documents = {
      store: new PostgRestItemStore({ url: documentsConfig.supabaseUrl, key: documentsConfig.supabaseKey }),
      ready: projectSync.ready,
      status: () => defaultSecretRegistry().status(),
      log,
    }
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
      documents,
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
    void shutdown({ worker, sync: projectSync, httpServer, log }).then((code) => exitWhenFlushed(code))
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
}
