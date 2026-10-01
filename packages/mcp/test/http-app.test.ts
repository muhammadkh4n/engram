import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequestListener, loadHttpConfig, type HttpConfig } from '../src/http-app.js'
import type { CaptureRouteDeps } from '../src/capture-route.js'
import type { CaptureDeps } from '../src/ingest/capture.js'

const TOKEN = 'test-bearer-token'
const BODY_CAP = 2048

interface Harness {
  url: string
  mcp: ReturnType<typeof vi.fn>
  captureDeps: ReturnType<typeof vi.fn>
  close: () => Promise<void>
}

async function startServer(): Promise<Harness> {
  const config: HttpConfig = { port: 0, host: '127.0.0.1', bearerToken: TOKEN, allowedHosts: null }
  const mcp = vi.fn(async (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"mcp":true}')
  })
  // Resolved only by a valid capture; the stub pipeline rejects every turn
  // as too short so no store or model is touched.
  const captureDeps = vi.fn(async () => ({
    getMemory: async () => {
      throw new Error('not used')
    },
    storage: { episodes: { getBySession: async () => [] } },
    intelligence: {},
    threshold: 0.7,
    captureModel: 'test-chat-model',
  }) as unknown as CaptureDeps)
  const capture: CaptureRouteDeps = { captureModel: 'test-chat-model', captureDeps }
  const server = http.createServer(
    createRequestListener(config, { mcp, capture, captureBodyMaxBytes: BODY_CAP, logError: () => {} }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    mcp,
    captureDeps,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body,
  })
}

let h: Harness
const savedSources = process.env['ENGRAM_SECRET_SOURCES_FILE']

beforeEach(async () => {
  // The scrubber reads this machine's secret registry when configured.
  delete process.env['ENGRAM_SECRET_SOURCES_FILE']
  h = await startServer()
})

afterEach(async () => {
  await h.close()
  if (savedSources !== undefined) process.env['ENGRAM_SECRET_SOURCES_FILE'] = savedSources
})

describe('POST /capture', () => {
  it('refuses a request without the bearer token', async () => {
    const res = await fetch(`${h.url}/capture`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    expect(h.captureDeps).not.toHaveBeenCalled()
  })

  it('refuses a wrong bearer token', async () => {
    const res = await post(`${h.url}/capture`, '{}', { authorization: 'Bearer not-the-token' })
    expect(res.status).toBe(401)
  })

  it('answers 405 to anything but POST', async () => {
    const res = await fetch(`${h.url}/capture`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('answers 413 with a permanent error above the body cap', async () => {
    const payload = JSON.stringify({ source: 'git', role: 'user', content: 'z'.repeat(BODY_CAP) })
    const res = await post(`${h.url}/capture`, payload)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ outcome: 'error', retryable: false, model: 'test-chat-model' })
    expect(h.captureDeps).not.toHaveBeenCalled()
  })

  it('answers 400 to a body that is not JSON', async () => {
    const res = await post(`${h.url}/capture`, '{"source": "git",')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ outcome: 'error', retryable: false })
  })

  it('answers 400 to a capture that fails validation', async () => {
    const res = await post(`${h.url}/capture`, JSON.stringify({ source: 'git', role: 'user', content: 'x', gate: 1 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ outcome: 'error', retryable: false, message: 'gate must be a boolean' })
  })

  it('runs a valid capture and returns the outcome JSON', async () => {
    const res = await post(`${h.url}/capture`, JSON.stringify({ source: 'git', role: 'user', content: 'k', gate: false }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({
      outcome: 'rejected',
      // gate:false never reaches a classifier, so no model saw the capture.
      model: 'raw',
      category: 'none',
      confidence: 0,
      reason: 'too_short',
    })
    expect(h.captureDeps).toHaveBeenCalledTimes(1)
  })
})

describe('other routes', () => {
  it('keeps /health open', async () => {
    const res = await fetch(`${h.url}/health`)
    expect(res.status).toBe(200)
  })

  it('answers 404 outside /mcp and /capture', async () => {
    const res = await post(`${h.url}/ingest`, '{}')
    expect(res.status).toBe(404)
  })

  it('still sends authenticated /mcp requests to the MCP handler', async () => {
    const res = await post(`${h.url}/mcp`, '{}')
    expect(res.status).toBe(200)
    expect(h.mcp).toHaveBeenCalledTimes(1)
  })
})

describe('loadHttpConfig', () => {
  it('requires BEARER_TOKEN', () => {
    expect(() => loadHttpConfig({})).toThrow(/BEARER_TOKEN/)
  })

  it('reads port, host and allowed hosts', () => {
    const config = loadHttpConfig({ BEARER_TOKEN: 't', PORT: '3850', HOST: '127.0.0.1', ALLOWED_HOSTS: 'Rexvps, localhost' })
    expect(config).toMatchObject({ port: 3850, host: '127.0.0.1', bearerToken: 't' })
    expect([...(config.allowedHosts ?? [])]).toEqual(['rexvps', 'localhost'])
  })
})
