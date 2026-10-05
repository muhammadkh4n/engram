/**
 * A stand-in for the capture events route: records every request and
 * answers with `reply`, which by default accepts every event. Setting `hold`
 * parks the answers until `release()`.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CaptureStubRequest {
  method: string
  path: string
  authorization: string | undefined
  body: { client: { name: string; version: string }; events: Array<Record<string, unknown>> }
}

export interface CaptureStubReply {
  status: number
  body: unknown
}

export type CaptureStubResponder = CaptureStubReply | ((request: CaptureStubRequest) => CaptureStubReply)

export interface CaptureStub {
  /** The server's MCP-style URL, `http://127.0.0.1:<port>/mcp`, as ENGRAM_SERVER_URL holds it. */
  url: string
  received: CaptureStubRequest[]
  reply: CaptureStubResponder
  hold: boolean
  release: () => void
  close: () => Promise<void>
}

/** Accepts every event of the request. */
export function acceptAll(request: CaptureStubRequest): CaptureStubReply {
  return { status: 200, body: { accepted: request.body.events.length, duplicates: 0, rejected: [] } }
}

export async function startCaptureStub(): Promise<CaptureStub> {
  const held: Array<() => void> = []
  const stub: CaptureStub = {
    url: '',
    received: [],
    reply: acceptAll,
    hold: false,
    release: () => {
      stub.hold = false
      for (const answer of held.splice(0)) answer()
    },
    close: async () => {},
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const request: CaptureStubRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as CaptureStubRequest['body'],
      }
      stub.received.push(request)
      const answer = () => {
        const reply = typeof stub.reply === 'function' ? stub.reply(request) : stub.reply
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.body))
      }
      if (stub.hold) held.push(answer)
      else answer()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  stub.url = `http://127.0.0.1:${port}/mcp`
  stub.close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    })
  return stub
}
