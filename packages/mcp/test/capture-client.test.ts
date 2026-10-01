import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureEndpoint,
  postCapture,
  sendCapture,
  SPOOL_FLUSH_MAX,
  type CaptureEnv,
  type CapturePayload,
} from '../src/ingest/capture-client.js'

const TOKEN = 'stub-bearer-7f3a9c'
const MODEL = 'stub-chat-model'

interface Received {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: CapturePayload
}

type Reply = { status: number; body: unknown }
type Responder = (body: CapturePayload) => Reply

interface Stub {
  url: string
  received: Received[]
  respond: Responder
  delayMs: number
  close: () => Promise<void>
}

const stored: Responder = () => ({ status: 200, body: { outcome: 'stored', model: MODEL, category: 'decision' } })

async function startStub(): Promise<Stub> {
  const stub: Stub = { url: '', received: [], respond: stored, delayMs: 0, close: async () => {} }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturePayload
      stub.received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const reply = stub.respond(body)
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.body))
      }, stub.delayMs)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  stub.url = `http://127.0.0.1:${port}/mcp`
  stub.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return stub
}

async function closedPortUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}/mcp`
}

function turn(key: string, content = `Switched the ingest worker to a systemd timer (${key}).`): CapturePayload {
  return { content, source: 'git-commit', role: 'assistant', session_id: 'git-engram', project_id: 'engram', key }
}

let home: string
let engram: string
let stub: Stub

function envFor(url: string): CaptureEnv {
  return { HOME: home, ENGRAM_SERVER_URL: url, ENGRAM_SERVER_TOKEN_FILE: '~/.engram/server-token' }
}

async function readJsonl(name: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await fs.readFile(join(engram, name), 'utf8')
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

async function spoolKeys(): Promise<string[]> {
  return (await readJsonl('spool.jsonl')).map((e) => (e['payload'] as CapturePayload).key ?? '')
}

async function prefillSpool(keys: readonly string[]): Promise<void> {
  const base = Date.parse('2026-09-30T08:00:00.000Z')
  const lines = keys.map((k, i) => JSON.stringify({ v: 1, at: new Date(base + i * 1000).toISOString(), payload: turn(k) }))
  await fs.writeFile(join(engram, 'spool.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 })
}

async function claimFiles(): Promise<string[]> {
  return (await fs.readdir(engram)).filter((n) => n.startsWith('spool.flushing.'))
}

function sentKeys(): string[] {
  return stub.received.map((r) => r.body.key ?? '')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'engram-capture-client-'))
  engram = join(home, '.engram')
  await fs.mkdir(engram, { recursive: true })
  await fs.writeFile(join(engram, 'server-token'), `${TOKEN}\n`, { mode: 0o600 })
  stub = await startStub()
})

afterEach(async () => {
  await stub.close()
  await fs.rm(home, { recursive: true, force: true })
})

describe('captureEndpoint', () => {
  it('maps the MCP endpoint and bare origins to the capture route', () => {
    expect(captureEndpoint('http://rexvps:3850/mcp')).toBe('http://rexvps:3850/capture')
    expect(captureEndpoint('http://rexvps:3850/mcp/')).toBe('http://rexvps:3850/capture')
    expect(captureEndpoint('http://rexvps:3850')).toBe('http://rexvps:3850/capture')
    expect(captureEndpoint('https://host/engram/capture')).toBe('https://host/engram/capture')
  })
})

describe('postCapture', () => {
  it('posts the payload unchanged to /capture with the bearer from a ~/ token file', async () => {
    const payload: CapturePayload = {
      ...turn('k-shape'),
      gate: false,
      dedup: false,
      dry_run: true,
      meta: { capturedAt: '2026-09-30T08:00:00.000Z', cwd: '/srv/engram' },
    }
    const result = await postCapture(payload, envFor(stub.url))

    expect(result).toEqual({ ok: true, status: 200, outcome: { outcome: 'stored', model: MODEL, category: 'decision' } })
    expect(stub.received).toHaveLength(1)
    const [request] = stub.received
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/capture')
    expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.body).toEqual(payload)
  })

  it('falls back to ENGRAM_SERVER_TOKEN and prefers the token file when both are set', async () => {
    await postCapture(turn('k-env'), { HOME: home, ENGRAM_SERVER_URL: stub.url, ENGRAM_SERVER_TOKEN: ' env-token ' })
    await postCapture(turn('k-both'), { ...envFor(stub.url), ENGRAM_SERVER_TOKEN: 'env-token' })
    expect(stub.received.map((r) => r.headers['authorization'])).toEqual(['Bearer env-token', `Bearer ${TOKEN}`])
  })

  it('classifies 500 and 401 as retryable, 400/413/422 as permanent', async () => {
    const replies: Reply[] = [
      { status: 500, body: { outcome: 'error', model: MODEL, retryable: true, message: 'capture failed; retry later' } },
      { status: 401, body: 'Unauthorized' },
      { status: 400, body: { outcome: 'error', model: MODEL, retryable: false, message: 'unknown field(s): foo' } },
      { status: 413, body: { outcome: 'error', model: MODEL, retryable: false, message: 'body exceeds 1048576 bytes' } },
      { status: 422, body: { outcome: 'error', model: MODEL, retryable: false, reason: 'unclassifiable', message: 'x' } },
    ]
    const results = []
    for (const reply of replies) {
      stub.respond = () => reply
      results.push(await postCapture(turn('k'), envFor(stub.url)))
    }
    expect(results.map((r) => (r.ok ? 'ok' : r.retryable))).toEqual([true, true, false, false, false])
  })

  it('times out as a retryable failure', async () => {
    stub.delayMs = 300
    const result = await postCapture(turn('k-slow'), envFor(stub.url), { timeoutMs: 50 })
    expect(result).toMatchObject({ ok: false, retryable: true, message: 'timeout after 50 ms' })
  })
})

describe('sendCapture', () => {
  it('spools the capture and records the error when the server is down', async () => {
    const env = envFor(await closedPortUrl())
    const result = await sendCapture(turn('k-down'), env)

    expect(result.disposition).toBe('spooled')
    expect(result.spooled).toBe(1)
    expect(result.line).toMatch(/^\[engram-ingest\] mode=server source=git-commit outcome=spooled ms=\d+ spool=1 error=/)
    const spool = await readJsonl('spool.jsonl')
    expect(spool).toHaveLength(1)
    expect(spool[0]).toMatchObject({ v: 1, payload: turn('k-down') })
    expect(typeof spool[0]['at']).toBe('string')

    const state = JSON.parse(await fs.readFile(join(engram, 'capture-state.json'), 'utf8'))
    expect(state.v).toBe(1)
    expect(typeof state.createdAt).toBe('string')
    expect(state.sources['git-commit'].lastErrorAt).toEqual(expect.any(String))
    expect(state.sources['git-commit'].lastOkAt).toBeUndefined()
    for (const name of ['spool.jsonl', 'capture-state.json']) {
      expect((await fs.stat(join(engram, name))).mode & 0o777).toBe(0o600)
    }
  })

  it('posts its own capture first, then flushes the spool in order and empties it', async () => {
    const down = envFor(await closedPortUrl())
    await sendCapture(turn('k1'), down)
    await sendCapture(turn('k2'), down)
    await sendCapture(turn('k3'), down)
    const createdAt = JSON.parse(await fs.readFile(join(engram, 'capture-state.json'), 'utf8')).createdAt

    const result = await sendCapture(turn('k-own'), envFor(stub.url))

    expect(sentKeys()).toEqual(['k-own', 'k1', 'k2', 'k3'])
    expect(result).toMatchObject({ disposition: 'sent', flushed: 3, spooled: 0 })
    expect(result.line).toMatch(/outcome=stored ms=\d+ spool=0 flushed=3$/)
    expect(await spoolKeys()).toEqual([])
    expect(await claimFiles()).toEqual([])
    const state = JSON.parse(await fs.readFile(join(engram, 'capture-state.json'), 'utf8'))
    expect(state.createdAt).toBe(createdAt)
    expect(state.sources['git-commit']).toMatchObject({ lastOkAt: expect.any(String), lastStoredAt: expect.any(String) })
  })

  it('stops the flush at a 500 and keeps entries 2..n spooled in order', async () => {
    await prefillSpool(['s1', 's2', 's3', 's4'])
    stub.respond = (body) =>
      body.key === 's2'
        ? { status: 500, body: { outcome: 'error', model: MODEL, retryable: true, message: 'capture failed; retry later' } }
        : stored(body)

    const result = await sendCapture(turn('k-own'), envFor(stub.url))

    expect(sentKeys()).toEqual(['k-own', 's1', 's2'])
    expect(result).toMatchObject({ flushed: 1, spooled: 3 })
    expect(await spoolKeys()).toEqual(['s2', 's3', 's4'])
    expect(await claimFiles()).toEqual([])
  })

  it('dead-letters a retryable:false outcome with the server message', async () => {
    stub.respond = () => ({
      status: 422,
      body: { outcome: 'error', model: MODEL, retryable: false, reason: 'unclassifiable', message: 'reply was not JSON' },
    })
    const result = await sendCapture(turn('k-bad'), envFor(stub.url))

    expect(result).toMatchObject({ disposition: 'dead', dead: 1, spooled: 0 })
    expect(result.line).toMatch(/outcome=dead .* dead=1 error="reply was not JSON"$/)
    const dead = await readJsonl('spool.dead.jsonl')
    expect(dead).toEqual([expect.objectContaining({ status: 422, message: 'reply was not JSON', payload: turn('k-bad') })])
    expect(await spoolKeys()).toEqual([])
    expect((await fs.stat(join(engram, 'spool.dead.jsonl'))).mode & 0o777).toBe(0o600)
  })

  it('dead-letters a refused spooled entry and keeps flushing', async () => {
    await prefillSpool(['s1', 's2', 's3'])
    stub.respond = (body) =>
      body.key === 's2'
        ? { status: 400, body: { outcome: 'error', model: MODEL, retryable: false, message: 'meta.foo is not an accepted key' } }
        : stored(body)

    const result = await sendCapture(turn('k-own'), envFor(stub.url))

    expect(sentKeys()).toEqual(['k-own', 's1', 's2', 's3'])
    expect(result).toMatchObject({ flushed: 2, dead: 1, spooled: 0 })
    expect((await readJsonl('spool.dead.jsonl')).map((e) => (e['payload'] as CapturePayload).key)).toEqual(['s2'])
  })

  it('keeps the capture key across the spool and the re-flush', async () => {
    const payload = turn('sha256-0f1e2d3c', 'Pinned secretlint to 12.0.0, the last release that supports Node 20.')
    await sendCapture(payload, envFor(await closedPortUrl()))

    await sendCapture(turn('k-own'), envFor(stub.url))

    expect(stub.received[1].body).toEqual(payload)
    expect(stub.received[1].body.key).toBe('sha256-0f1e2d3c')
  })

  it('flushes at most the batch limit per run', async () => {
    const keys = Array.from({ length: SPOOL_FLUSH_MAX + 5 }, (_, i) => `s${String(i).padStart(2, '0')}`)
    await prefillSpool(keys)

    const result = await sendCapture(turn('k-own'), envFor(stub.url))

    expect(sentKeys()).toEqual(['k-own', ...keys.slice(0, SPOOL_FLUSH_MAX)])
    expect(result.spooled).toBe(5)
    expect(await spoolKeys()).toEqual(keys.slice(SPOOL_FLUSH_MAX))
  })

  it('sends each spooled entry exactly once when two runs flush at the same time', async () => {
    const keys = ['s1', 's2', 's3', 's4', 's5', 's6']
    await prefillSpool(keys)
    stub.delayMs = 15

    await Promise.all([sendCapture(turn('own-a'), envFor(stub.url)), sendCapture(turn('own-b'), envFor(stub.url))])

    const spooledSends = sentKeys().filter((k) => k.startsWith('s'))
    expect([...spooledSends].sort()).toEqual(keys)
    expect(await spoolKeys()).toEqual([])
    expect(await claimFiles()).toEqual([])
  })

  it('takes over a claim abandoned for more than ten minutes and leaves a live one alone', async () => {
    const line = (key: string, at: string) => JSON.stringify({ v: 1, at, payload: turn(key) })
    const stale = join(engram, 'spool.flushing.4242.jsonl')
    await fs.writeFile(stale, `${line('c1', '2026-09-30T07:00:00.000Z')}\n${line('c2', '2026-09-30T07:00:01.000Z')}\n`)
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000)
    await fs.utimes(stale, elevenMinutesAgo, elevenMinutesAgo)
    const live = join(engram, 'spool.flushing.4343.jsonl')
    await fs.writeFile(live, `${line('live', '2026-09-30T07:30:00.000Z')}\n`)
    await prefillSpool(['s1'])

    const result = await sendCapture(turn('k-own'), envFor(stub.url))

    expect(sentKeys()).toEqual(['k-own', 'c1', 'c2', 's1'])
    expect(result.flushed).toBe(3)
    expect(await claimFiles()).toEqual(['spool.flushing.4343.jsonl'])
  })

  it('leaves the spool alone when the flush budget is zero', async () => {
    await prefillSpool(['s1'])
    const result = await sendCapture(turn('k-own'), envFor(stub.url), { flushBudgetMs: 0, label: 'engram-pre-compact' })
    expect(sentKeys()).toEqual(['k-own'])
    expect(result.line).toMatch(/^\[engram-pre-compact\] .* spool=1$/)
  })
})
