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
 *   BEARER_TOKEN          — required for all /mcp requests
 *
 * Optional env:
 *   PORT                  — default 3849
 *   HOST                  — default 0.0.0.0
 *   ALLOWED_HOSTS         — comma-separated allowlist for Host header (DNS-rebind guard).
 *                           If unset, every host is allowed.
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import http from 'node:http'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createEngramServer } from './server-core.js'

interface Config {
  port: number
  host: string
  bearerToken: string
  allowedHosts: ReadonlySet<string> | null
}

function loadConfig(): Config {
  const bearerToken = process.env.BEARER_TOKEN
  if (!bearerToken) {
    throw new Error('Missing required environment variable: BEARER_TOKEN')
  }
  const port = Number(process.env.PORT ?? '3849')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`)
  }
  const host = process.env.HOST ?? '0.0.0.0'
  const allowedHostsEnv = process.env.ALLOWED_HOSTS
  const allowedHosts = allowedHostsEnv
    ? new Set(allowedHostsEnv.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
    : null
  return { port, host, bearerToken, allowedHosts }
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) {
    // Still compare against same-length buffer to avoid trivial timing leak,
    // but the result is always false.
    const filler = Buffer.alloc(aBuf.length)
    timingSafeEqual(aBuf, filler)
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

function checkAuth(req: http.IncomingMessage, expected: string): boolean {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const token = header.slice('Bearer '.length).trim()
  return constantTimeEqual(token, expected)
}

function checkHost(req: http.IncomingMessage, allowed: ReadonlySet<string> | null): boolean {
  if (!allowed) return true
  const host = (req.headers['host'] ?? '').toLowerCase()
  // Strip port for comparison
  const bareHost = host.includes(':') ? host.split(':')[0]! : host
  return allowed.has(host) || allowed.has(bareHost)
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

function logRequest(req: http.IncomingMessage): void {
  if (process.env.ENGRAM_HTTP_DEBUG === '1') {
    process.stdout.write(`[engram-mcp-http] ${req.method} ${req.url} accept="${req.headers['accept'] ?? ''}" ua="${req.headers['user-agent'] ?? ''}"\n`)
  }
}

async function main(): Promise<void> {
  const config = loadConfig()

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        logRequest(req)
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('ok\n')
          return
        }

        if (!checkHost(req, config.allowedHosts)) {
          res.writeHead(403, { 'content-type': 'text/plain' })
          res.end('Forbidden host\n')
          return
        }

        const url = req.url ?? ''
        const path = url.split('?')[0]
        if (path !== '/mcp') {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('Not found\n')
          return
        }

        if (!checkAuth(req, config.bearerToken)) {
          res.writeHead(401, {
            'content-type': 'text/plain',
            'www-authenticate': 'Bearer realm="engram-mcp"',
          })
          res.end('Unauthorized\n')
          return
        }

        // Probe-friendly GET: external health-checkers (Claude Code's
        // mcp-health-check hook, uptime probes, etc.) hit GET /mcp without an
        // SSE Accept header. The MCP SDK strictly returns 406 in that case,
        // which monitors don't recognize as healthy. Short-circuit those
        // probes with 200 OK before the SDK sees them. Real SSE clients
        // sending `Accept: text/event-stream` still pass through to the SDK.
        if (req.method === 'GET') {
          const accept = (req.headers['accept'] ?? '').toString()
          if (!accept.includes('text/event-stream')) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http' }))
            return
          }
        }

        await handleMcp(req, res)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[engram-mcp-http] Request error: ${msg}\n`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }))
        } else {
          res.end()
        }
      }
    })()
  })

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
