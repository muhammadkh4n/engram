import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequestListener, loadHttpConfig, type HttpConfig } from '../src/http-app.js'
import type { CaptureRouteDeps } from '../src/capture-route.js'
import type { CaptureDeps } from '../src/ingest/capture.js'
import type { IngestedEvent, SecretRegistryStatus, StoredEvent } from '@engram-mem/core'
import { parseProjectRegistry, type ProjectRegistry } from '../src/capture-events/project-registry.js'
import type { CaptureEventsRouteDeps } from '../src/capture-events/route.js'
import type { DocumentsRouteDeps } from '../src/documents-route.js'
import { RECEIVED_AT, envelope, validEvent } from './capture-events/fixtures.js'

const TOKEN = 'test-bearer-token'
const CAPTURE_TOKEN = 'test-capture-token-0123456789abcdef'
const DOCUMENTS_TOKEN = 'test-documents-token-0123456789abcdef'
const BODY_CAP = 2048
const EVENTS_BODY_CAP = 4096
const DOCUMENTS_BODY_CAP = 4096

const REGISTRY: ProjectRegistry = parseProjectRegistry({
  version: 1,
  workspaces: { 'ws-test': { root: '~/work/ws-test', vault_folder: null, register_prefix: null } },
  projects: { 'sample-repo': { workspace: 'ws-test', vault_folder: null, register_prefix: 'TST' } },
})

interface Harness {
  url: string
  mcp: ReturnType<typeof vi.fn>
  captureDeps: ReturnType<typeof vi.fn>
  ingestEvents: ReturnType<typeof vi.fn>
  syncDocumentNote: ReturnType<typeof vi.fn>
  logError: ReturnType<typeof vi.fn>
  port: number
  close: () => Promise<void>
}

interface ServerOptions {
  captureToken?: string | null
  documentsToken?: string | null
  ready?: () => ProjectRegistry | null
  status?: () => SecretRegistryStatus
}

async function startServer(opts: ServerOptions = {}): Promise<Harness> {
  const captureToken = opts.captureToken === undefined ? CAPTURE_TOKEN : opts.captureToken
  const documentsToken = opts.documentsToken === undefined ? DOCUMENTS_TOKEN : opts.documentsToken
  const config: HttpConfig = {
    port: 0, host: '127.0.0.1', bearerToken: TOKEN, captureToken, documentsToken, allowedHosts: null,
  }
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
  const ingestEvents = vi.fn(async (events: readonly StoredEvent[]): Promise<IngestedEvent[]> =>
    events.map((_, i) => ({ eventId: String(i + 1), status: 'accepted' })),
  )
  const captureEvents: CaptureEventsRouteDeps = {
    store: { ingestEvents },
    ready: opts.ready ?? (() => REGISTRY),
    status: opts.status ?? (() => ({ configured: true, unreadable: [], values: 1 })),
    log: () => {},
    now: () => RECEIVED_AT,
  }
  const syncDocumentNote = vi.fn(async () => ({ status: 'unchanged' as const, sections: null, itemIds: [] }))
  const documents: DocumentsRouteDeps = {
    store: { syncDocumentNote },
    ready: opts.ready ?? (() => REGISTRY),
    status: opts.status ?? (() => ({ configured: true, unreadable: [], values: 1 })),
    log: () => {},
    now: () => RECEIVED_AT,
  }
  const logError = vi.fn()
  const server = http.createServer(
    createRequestListener(config, {
      mcp,
      capture,
      captureBodyMaxBytes: BODY_CAP,
      captureEvents,
      captureEventsBodyMaxBytes: EVENTS_BODY_CAP,
      documents,
      documentsBodyMaxBytes: DOCUMENTS_BODY_CAP,
      logError,
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    mcp,
    captureDeps,
    ingestEvents,
    syncDocumentNote,
    logError,
    port,
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

  it('answers 413 to a chunked body with no content-length once it crosses the cap', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: h.port, path: '/capture', method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } },
        (r) => {
          let data = ''
          r.on('data', (c: Buffer) => (data += c.toString()))
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: data }))
        },
      )
      req.on('error', reject)
      expect(req.getHeader('content-length')).toBeUndefined()
      for (let i = 0; i < 4; i++) req.write('a'.repeat(BODY_CAP / 2))
      req.end()
    })
    expect(res.status).toBe(413)
    expect(JSON.parse(res.body)).toMatchObject({ outcome: 'error', retryable: false })
    expect(h.captureDeps).not.toHaveBeenCalled()
  })

  it('rejects the read cleanly when the client aborts mid-body', async () => {
    const req = http.request({
      host: '127.0.0.1', port: h.port, path: '/capture', method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': '1000' },
    })
    req.on('error', () => {})
    req.write('{"source":"git",')
    await new Promise((r) => setTimeout(r, 50))
    req.destroy()
    await vi.waitFor(() => expect(h.logError).toHaveBeenCalledTimes(1))
    expect(h.logError.mock.calls[0]![0]).toContain('capture body read failed')
    expect(h.captureDeps).not.toHaveBeenCalled()
  })

  it('answers a failed body read with a retryable capture outcome, not a JSON-RPC body', async () => {
    const config: HttpConfig = { port: 0, host: '127.0.0.1', bearerToken: TOKEN, captureToken: null, documentsToken: null,
      allowedHosts: null }
    const capture: CaptureRouteDeps = { captureModel: 'test-chat-model', captureDeps: vi.fn() }
    const logError = vi.fn()
    const listener = createRequestListener(config, { mcp: vi.fn(), capture, logError })
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/capture',
      headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1' },
    })
    const sent: { status?: number; body?: string } = {}
    const res = {
      headersSent: false,
      destroyed: false,
      writeHead: (status: number) => {
        sent.status = status
      },
      end: (body?: string) => {
        sent.body = body
      },
    }

    listener(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse)
    req.emit('error', new Error('socket hang up'))

    await vi.waitFor(() => expect(sent.body).toBeDefined())
    expect(sent.status).toBe(500)
    expect(JSON.parse(sent.body!)).toEqual({
      outcome: 'error',
      model: 'test-chat-model',
      retryable: true,
      message: 'capture failed; retry later',
    })
    expect(logError.mock.calls[0]![0]).toContain('socket hang up')
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

  it('refuses the capture token on /mcp and /capture', async () => {
    const auth = { authorization: `Bearer ${CAPTURE_TOKEN}` }
    expect((await post(`${h.url}/mcp`, '{}', auth)).status).toBe(401)
    expect((await post(`${h.url}/capture`, '{}', auth)).status).toBe(401)
    expect(h.mcp).not.toHaveBeenCalled()
    expect(h.captureDeps).not.toHaveBeenCalled()
  })

  it('refuses the documents token on /mcp, /capture and /capture/events', async () => {
    const auth = { authorization: `Bearer ${DOCUMENTS_TOKEN}` }
    expect((await post(`${h.url}/mcp`, '{}', auth)).status).toBe(401)
    expect((await post(`${h.url}/capture`, '{}', auth)).status).toBe(401)
    expect((await post(`${h.url}/capture/events`, '{}', auth)).status).toBe(401)
    expect(h.mcp).not.toHaveBeenCalled()
    expect(h.captureDeps).not.toHaveBeenCalled()
    expect(h.ingestEvents).not.toHaveBeenCalled()
  })
})

describe('POST /documents/sync', () => {
  const docsUrl = (): string => `${h.url}/documents/sync`
  const postDocs = (body: string, token = DOCUMENTS_TOKEN): Promise<Response> =>
    post(docsUrl(), body, { authorization: `Bearer ${token}` })
  const request = (): string => JSON.stringify({
    source: 'vault',
    notes: [{
      path: 'Notes/inbox.md',
      note_version: 'v-1',
      seen_at: '2026-10-05T11:00:00Z',
      mtime: '2026-10-05T11:00:00Z',
      deleted: false,
      frontmatter: null,
      sections: [{ heading_path: [], index: 0, text: 'Buy milk.', kind_hint: 'note' }],
    }],
  })

  it('refuses no token, BEARER_TOKEN and the capture token', async () => {
    const bare = await fetch(docsUrl(), { method: 'POST', body: request() })
    expect(bare.status).toBe(401)
    expect(bare.headers.get('www-authenticate')).toContain('Bearer')
    expect((await postDocs(request(), TOKEN)).status).toBe(401)
    expect((await postDocs(request(), CAPTURE_TOKEN)).status).toBe(401)
    expect(h.syncDocumentNote).not.toHaveBeenCalled()
  })

  it('answers 405 to anything but POST', async () => {
    const res = await fetch(docsUrl(), { headers: { authorization: `Bearer ${DOCUMENTS_TOKEN}` } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('answers 413 above the body cap', async () => {
    const res = await postDocs(JSON.stringify({ source: 'vault', notes: [], pad: 'z'.repeat(DOCUMENTS_BODY_CAP) }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: `body exceeds ${DOCUMENTS_BODY_CAP} bytes`, retryable: false })
    expect(h.syncDocumentNote).not.toHaveBeenCalled()
  })

  it('answers 400, not retryable, to a body that is not JSON', async () => {
    const res = await postDocs('{"source":')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'the body is not valid JSON', retryable: false })
  })

  it('syncs a valid request through the server scrubber and answers results and totals', async () => {
    const res = await postDocs(request())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const json = await res.json() as { results: unknown[]; totals: Record<string, number> }
    expect(json.results).toEqual([{ path: 'Notes/inbox.md', status: 'unchanged' }])
    expect(json.totals).toMatchObject({ notes: 1, unchanged: 1 })
    expect(h.syncDocumentNote).toHaveBeenCalledTimes(1)
  })

  it('answers 503 with the documents token unset, draining the body', async () => {
    await h.close()
    h = await startServer({ documentsToken: null })
    const res = await postDocs(request())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ retryable: true })
    expect(h.syncDocumentNote).not.toHaveBeenCalled()
  })

  it('answers 503 while the secret registry is degraded', async () => {
    await h.close()
    h = await startServer({ status: () => ({ configured: false, unreadable: [], values: 0 }) })
    const res = await postDocs(request())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ retryable: true })
    expect(h.syncDocumentNote).not.toHaveBeenCalled()
  })
})

describe('POST /capture/events', () => {
  const eventsUrl = (): string => `${h.url}/capture/events`
  const postEvents = (body: string, token = CAPTURE_TOKEN): Promise<Response> =>
    post(eventsUrl(), body, { authorization: `Bearer ${token}` })
  const batch = (): string => JSON.stringify(envelope([validEvent('user_prompt'), validEvent('session_start')]))

  it('refuses a request without a token and one with BEARER_TOKEN', async () => {
    const bare = await fetch(eventsUrl(), { method: 'POST', body: batch() })
    expect(bare.status).toBe(401)
    expect(bare.headers.get('www-authenticate')).toContain('Bearer')
    expect((await postEvents(batch(), TOKEN)).status).toBe(401)
    expect(h.ingestEvents).not.toHaveBeenCalled()
  })

  it('answers 405 to anything but POST', async () => {
    const res = await fetch(eventsUrl(), { headers: { authorization: `Bearer ${CAPTURE_TOKEN}` } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('answers 413 above the body cap', async () => {
    const big = validEvent('user_prompt')
    big.payload.text = 'z'.repeat(EVENTS_BODY_CAP)
    const res = await postEvents(JSON.stringify(envelope([big])))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: `body exceeds ${EVENTS_BODY_CAP} bytes` })
    expect(h.ingestEvents).not.toHaveBeenCalled()
  })

  it('answers 400 to a body that is not JSON and to a bad envelope', async () => {
    expect((await postEvents('{"client":')).status).toBe(400)
    const res = await postEvents(JSON.stringify({ client: { name: 'sample-client', version: '1' }, events: [] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toHaveProperty('error')
    expect(h.ingestEvents).not.toHaveBeenCalled()
  })

  it('stores a valid batch and answers the counts', async () => {
    const res = await postEvents(batch())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 0, rejected: [] })
    expect(h.ingestEvents).toHaveBeenCalledTimes(1)
  })

  it('answers 503 with the capture token unset, draining the body', async () => {
    await h.close()
    h = await startServer({ captureToken: null })
    const res = await postEvents(batch())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ retryable: true })
    expect(h.ingestEvents).not.toHaveBeenCalled()
  })

  it('answers 503 before the project registry syncs', async () => {
    await h.close()
    h = await startServer({ ready: () => null })
    const res = await postEvents(batch())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ retryable: true })
    expect(h.ingestEvents).not.toHaveBeenCalled()
  })

  it('answers 503 while the secret registry lists an unreadable source', async () => {
    await h.close()
    h = await startServer({ status: () => ({ configured: true, unreadable: ['/etc/engram/sources/db.env'], values: 4 }) })
    const res = await postEvents(batch())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ retryable: true })
    expect(h.ingestEvents).not.toHaveBeenCalled()
  })
})

describe('loadHttpConfig', () => {
  it('requires BEARER_TOKEN', () => {
    expect(() => loadHttpConfig({})).toThrow(/BEARER_TOKEN/)
  })

  it('leaves the capture token null when ENGRAM_CAPTURE_TOKEN is unset', () => {
    expect(loadHttpConfig({ BEARER_TOKEN: 't' }).captureToken).toBeNull()
  })

  it('reads a capture token of 32 or more characters', () => {
    const token = 'c'.repeat(32)
    expect(loadHttpConfig({ BEARER_TOKEN: 't', ENGRAM_CAPTURE_TOKEN: token }).captureToken).toBe(token)
  })

  it('refuses a 31-char capture token and one equal to BEARER_TOKEN', () => {
    expect(() => loadHttpConfig({ BEARER_TOKEN: 't', ENGRAM_CAPTURE_TOKEN: 'c'.repeat(31) })).toThrow(
      /ENGRAM_CAPTURE_TOKEN must be at least 32 characters/,
    )
    const shared = 's'.repeat(40)
    expect(() => loadHttpConfig({ BEARER_TOKEN: shared, ENGRAM_CAPTURE_TOKEN: shared })).toThrow(
      /ENGRAM_CAPTURE_TOKEN must differ from BEARER_TOKEN/,
    )
  })

  it('leaves the documents token null when ENGRAM_DOCUMENTS_TOKEN is unset', () => {
    expect(loadHttpConfig({ BEARER_TOKEN: 't' }).documentsToken).toBeNull()
  })

  it('reads a documents token of 32 or more characters', () => {
    const token = 'd'.repeat(32)
    expect(loadHttpConfig({ BEARER_TOKEN: 't', ENGRAM_DOCUMENTS_TOKEN: token }).documentsToken).toBe(token)
  })

  it('refuses a 31-char documents token and one equal to BEARER_TOKEN or the capture token', () => {
    expect(() => loadHttpConfig({ BEARER_TOKEN: 't', ENGRAM_DOCUMENTS_TOKEN: 'd'.repeat(31) })).toThrow(
      /ENGRAM_DOCUMENTS_TOKEN must be at least 32 characters/,
    )
    const shared = 's'.repeat(40)
    expect(() => loadHttpConfig({ BEARER_TOKEN: shared, ENGRAM_DOCUMENTS_TOKEN: shared })).toThrow(
      /ENGRAM_DOCUMENTS_TOKEN must differ/,
    )
    expect(() => loadHttpConfig({ BEARER_TOKEN: 't', ENGRAM_CAPTURE_TOKEN: shared, ENGRAM_DOCUMENTS_TOKEN: shared })).toThrow(
      /ENGRAM_DOCUMENTS_TOKEN must differ/,
    )
  })

  it('reads port, host and allowed hosts', () => {
    const config = loadHttpConfig({ BEARER_TOKEN: 't', PORT: '3850', HOST: '127.0.0.1', ALLOWED_HOSTS: 'Rexvps, localhost' })
    expect(config).toMatchObject({ port: 3850, host: '127.0.0.1', bearerToken: 't' })
    expect([...(config.allowedHosts ?? [])]).toEqual(['rexvps', 'localhost'])
  })
})
