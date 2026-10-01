/**
 * Request routing for the Streamable HTTP server, kept apart from the
 * process entry point so the routes, auth and body limits are testable
 * without binding a port or building the memory stack.
 *
 * Routes:
 *   GET  /health, /healthz — liveness, no auth
 *   *    /mcp              — MCP Streamable HTTP, bearer auth
 *   POST /capture          — the capture pipeline (hooks and CLIs), bearer auth
 */

import type http from 'node:http'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import {
  failedCaptureResponse,
  invalidCaptureResponse,
  runCaptureRequest,
  type CaptureResponse,
  type CaptureRouteDeps,
} from './capture-route.js'

/**
 * A capture carries at most 100,000 content chars plus small metadata. JSON
 * escaping can take a char to six bytes, so 1 MiB holds any valid capture
 * while bounding what an authenticated client can make the server buffer.
 */
export const CAPTURE_BODY_MAX_BYTES = 1024 * 1024

export interface HttpConfig {
  port: number
  host: string
  bearerToken: string
  allowedHosts: ReadonlySet<string> | null
}

export interface HttpHandlers {
  mcp: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
  capture: CaptureRouteDeps
  captureBodyMaxBytes?: number
  logError?: (line: string) => void
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const bearerToken = env['BEARER_TOKEN']
  if (!bearerToken) {
    throw new Error('Missing required environment variable: BEARER_TOKEN')
  }
  const port = Number(env['PORT'] ?? '3849')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env['PORT']}`)
  }
  const host = env['HOST'] ?? '0.0.0.0'
  const allowedHostsEnv = env['ALLOWED_HOSTS']
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

export function checkAuth(req: http.IncomingMessage, expected: string): boolean {
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

function logRequest(req: http.IncomingMessage): void {
  if (process.env.ENGRAM_HTTP_DEBUG === '1') {
    process.stdout.write(`[engram-mcp-http] ${req.method} ${req.url} accept="${req.headers['accept'] ?? ''}" ua="${req.headers['user-agent'] ?? ''}"\n`)
  }
}

type BodyRead = { body: Buffer } | { tooLarge: true }

/**
 * Reads the request body up to maxBytes. An oversized body is drained rather
 * than cut off, so the client reads the 413 instead of a reset connection.
 */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<BodyRead> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    let tooLarge = Number.isFinite(declared) && declared > maxBytes
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBytes) tooLarge = true
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { body: Buffer.concat(chunks) }))
    req.on('error', reject)
  })
}

function sendCapture(res: http.ServerResponse, response: CaptureResponse): void {
  res.writeHead(response.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(response.body))
}

async function handleCapture(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlers: HttpHandlers,
  logError: (line: string) => void,
): Promise<void> {
  const model = handlers.capture.captureModel
  if (req.method !== 'POST') {
    req.resume()
    res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' })
    res.end('Method not allowed\n')
    return
  }
  const maxBytes = handlers.captureBodyMaxBytes ?? CAPTURE_BODY_MAX_BYTES
  let read: BodyRead
  try {
    read = await readBody(req, maxBytes)
  } catch (err) {
    // A capture client reads every answer as a capture outcome, so a broken
    // upload is a retryable outcome too, not the MCP route's JSON-RPC error.
    logError(`[engram-mcp-http] capture body read failed: ${err instanceof Error ? err.message : String(err)}`)
    if (!res.headersSent && !res.destroyed) sendCapture(res, failedCaptureResponse(model))
    return
  }
  if ('tooLarge' in read) {
    sendCapture(res, invalidCaptureResponse(model, `body exceeds ${maxBytes} bytes`, 413))
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.body.toString('utf8'))
  } catch {
    sendCapture(res, invalidCaptureResponse(model, 'the body is not valid JSON'))
    return
  }
  sendCapture(res, await runCaptureRequest(handlers.capture, parsed))
}

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: HttpConfig,
  handlers: HttpHandlers,
  logError: (line: string) => void,
): Promise<void> {
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
  if (path !== '/mcp' && path !== '/capture') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found\n')
    return
  }

  if (!checkAuth(req, config.bearerToken)) {
    req.resume()
    res.writeHead(401, {
      'content-type': 'text/plain',
      'www-authenticate': 'Bearer realm="engram-mcp"',
    })
    res.end('Unauthorized\n')
    return
  }

  if (path === '/capture') {
    await handleCapture(req, res, handlers, logError)
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

  await handlers.mcp(req, res)
}

export function createRequestListener(
  config: HttpConfig,
  handlers: HttpHandlers,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const logError = handlers.logError ?? ((line: string) => process.stderr.write(`${line}\n`))
  return (req, res) => {
    void (async () => {
      try {
        await route(req, res, config, handlers, logError)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logError(`[engram-mcp-http] Request error: ${msg}`)
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
  }
}
