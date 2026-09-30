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
 */

import http from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  createEngramServer,
  getCaptureDeps,
  captureModelFromEnv,
  parseSalienceThresholdEnv,
} from './server-core.js'
import { createRequestListener, loadHttpConfig } from './http-app.js'

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

  const httpServer = http.createServer(
    createRequestListener(config, {
      mcp: handleMcp,
      capture: {
        captureModel,
        captureDeps: () => getCaptureDeps({ threshold, captureModel }),
        log: (line) => process.stderr.write(`[engram-mcp-http] ${line}\n`),
      },
    }),
  )

  httpServer.listen(config.port, config.host, () => {
    process.stdout.write(`[engram-mcp-http] listening on http://${config.host}:${config.port}/mcp\n`)
  })

  const shutdown = (signal: string): void => {
    process.stdout.write(`[engram-mcp-http] ${signal} — shutting down\n`)
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5_000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  process.stderr.write(`[engram-mcp-http] Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
