/**
 * The session-summary and pre-compact hooks: the transcript excerpt they
 * digest, the derive captures they post to a stub capture server, and the
 * detached session-summary worker.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const h = await vi.hoisted(async () => {
  const { mkdtempSync: mkdtemp } = await import('node:fs')
  const { tmpdir: tmp } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const savedHome = process.env['HOME']
  const home = mkdtemp(joinPath(tmp(), 'engram-transcript-capture-home-'))
  process.env['HOME'] = home
  return { home, savedHome, localImported: false }
})

vi.mock('../src/ingest/local-capture.js', () => {
  h.localImported = true
  return { runLocalDerivedCapture: vi.fn(), MissingEnvError: class extends Error {} }
})

vi.mock('../src/ingest/project-detect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ingest/project-detect.js')>()),
  resolveProject: () => 'engram',
}))

const TOKEN = 'stub-bearer-7d21aa'
const MODEL = 'stub-chat-model'
const PKG_DIR = resolve(import.meta.dirname, '..')
const fixtures = mkdtempSync(join(tmpdir(), 'engram-transcript-fixtures-'))

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true })
  rmSync(h.home, { recursive: true, force: true })
  if (h.savedHome !== undefined) process.env['HOME'] = h.savedHome
})

interface Stub {
  url: string
  received: Array<Record<string, unknown>>
  reply: { status: number; body: unknown }
  /** While set, requests are held until release() is called. */
  hold: boolean
  answered: number
  release: () => void
  close: () => Promise<void>
}

async function startStub(): Promise<Stub> {
  const held: Array<() => void> = []
  const stub: Stub = {
    url: '',
    received: [],
    reply: { status: 200, body: { outcome: 'stored', model: MODEL } },
    hold: false,
    answered: 0,
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
      stub.received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      const answer = () => {
        stub.answered++
        res.writeHead(stub.reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(stub.reply.body))
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

async function closedPortUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((done) => server.close(() => done()))
  return `http://127.0.0.1:${port}/mcp`
}

type Line = Record<string, unknown> | string

function writeLines(name: string, lines: Line[]): string {
  const path = join(fixtures, name)
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return path
}

const USER_ASK = 'Please move the nightly consolidation off the 02:00 backup window.'
const ASSISTANT_PLAN = 'I will check the systemd timer units before changing anything.'
const ASSISTANT_DONE = 'Moved consolidation to 03:30 with a systemd timer; the backup keeps 02:00.'
const USER_ACK = 'Good. Keep the backup at 02:00 and note the new timer in the runbook.'

/** Real Claude Code shapes: user turns are `type: "user"`, tool results ride on user entries. */
function conversationFixture(): string {
  return writeLines('conversation.jsonl', [
    { type: 'summary', summary: 'Earlier work on backups', leafUuid: 'l-0' },
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: USER_ASK } },
    {
      type: 'assistant',
      uuid: 'a-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: ASSISTANT_PLAN },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'systemctl list-timers' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u-2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'NEXT LEFT LAST PASSED UNIT' }] },
    },
    { type: 'attachment', uuid: 'x-1', attachment: { type: 'file', filename: 'backup.timer', content: 'OnCalendar=02:00' } },
    { type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: ASSISTANT_DONE }] } },
    '{"type":"user", not json',
    { type: 'user', uuid: 'u-3', message: { role: 'user', content: [{ type: 'text', text: USER_ACK }] } },
  ])
}

function longFixture(name: string, turns: number, chars: number): string {
  const lines: Line[] = []
  for (let i = 0; i < turns; i++) {
    const type = i % 2 === 0 ? 'user' : 'assistant'
    const text = `turn-${String(i).padStart(2, '0')} ` + 'x'.repeat(chars)
    lines.push({ type, uuid: `t-${i}`, message: { role: type, content: [{ type: 'text', text }] } })
  }
  return writeLines(name, lines)
}

function turnBodies(text: string): string[] {
  return text.split('\n\n').map((t) => t.replace(/^(User|Assistant): /, ''))
}

let stub: Stub
let stderr: string[]

function serverEnv(url = stub.url): Record<string, string> {
  return { HOME: h.home, ENGRAM_SERVER_URL: url, ENGRAM_SERVER_TOKEN: TOKEN }
}

function spoolLines(): Array<Record<string, unknown>> {
  const path = join(h.home, '.engram', 'spool.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
}

beforeEach(async () => {
  vi.resetModules()
  h.localImported = false
  rmSync(join(h.home, '.engram'), { recursive: true, force: true })
  stub = await startStub()
  stderr = []
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stub.close()
})

describe('readTranscriptExcerpt', () => {
  it('keeps user and assistant text turns in order and skips tool results and attachments', async () => {
    const { readTranscriptExcerpt } = await import('../src/ingest/transcript-excerpt.js')

    const excerpt = readTranscriptExcerpt(conversationFixture(), { maxChars: 30_000, perTurnChars: 2_000 })

    expect(excerpt.text).toBe(
      [`User: ${USER_ASK}`, `Assistant: ${ASSISTANT_PLAN}`, `Assistant: ${ASSISTANT_DONE}`, `User: ${USER_ACK}`].join('\n\n'),
    )
    expect(excerpt.turns).toBe(4)
    expect(excerpt.lastUuid).toBe('u-3')
  })

  it.each([
    { maxChars: 30_000, perTurnChars: 2_000 },
    { maxChars: 40_000, perTurnChars: 3_000 },
  ])('holds the $maxChars / $perTurnChars caps and keeps the newest turns', async (caps) => {
    const { readTranscriptExcerpt } = await import('../src/ingest/transcript-excerpt.js')

    const excerpt = readTranscriptExcerpt(longFixture(`long-${caps.maxChars}.jsonl`, 40, 5_000), caps)

    const bodies = turnBodies(excerpt.text)
    expect(bodies.every((b) => b.length <= caps.perTurnChars)).toBe(true)
    expect(bodies.reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(caps.maxChars)
    expect(bodies.at(-1)).toMatch(/^turn-39 /)
    expect(bodies[0]).not.toMatch(/^turn-00 /)
    expect(excerpt.turns).toBe(Math.ceil(caps.maxChars / caps.perTurnChars))
    expect(excerpt.lastUuid).toBe('t-39')
  })
})

describe('session-summary in server mode', () => {
  it('posts a session-summary derive capture under the summaries session', async () => {
    const transcript = conversationFixture()
    const { runSessionSummaryWorker } = await import('../src/session-summary.js')

    const code = await runSessionSummaryWorker(JSON.stringify({ session_id: 's-1', transcript_path: transcript }), serverEnv())
    await runSessionSummaryWorker(JSON.stringify({ session_id: 's-1', transcript_path: transcript }), serverEnv())

    expect(code).toBe(0)
    expect(h.localImported).toBe(false)
    expect(stub.received).toHaveLength(2)
    const body = stub.received[0]!
    expect(Object.keys(body).sort()).toEqual(
      ['content', 'derive', 'key', 'meta', 'project_id', 'role', 'session_id', 'source'].sort(),
    )
    expect(body).toMatchObject({
      source: 'claude-code',
      role: 'system',
      derive: 'session-summary',
      session_id: 'claude-code-summaries',
      project_id: 'engram',
      meta: { transcriptPath: transcript },
    })
    expect(body['content']).toContain(`User: ${USER_ASK}`)
    expect(Object.keys(body['meta'] as object).sort()).toEqual(['capturedAt', 'transcriptPath'])
    expect(body['key']).toMatch(/^[0-9a-f]{64}$/)
    expect(stub.received[1]!['key']).toBe(body['key'])
    expect(stderr.join('')).toContain('[engram-summary] mode=server source=claude-code outcome=stored')
  })

  it('scrubs credentials out of the excerpt before posting', async () => {
    const transcript = writeLines('secret.jsonl', [
      { type: 'user', uuid: 'u-1', message: { content: 'The staging database is postgres://admin:Tr1cky-Pa55w0rd@db.staging.internal:5432/app' } },
      { type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: ASSISTANT_DONE + ' ' + ASSISTANT_PLAN }] } },
    ])
    const { runSessionSummaryWorker } = await import('../src/session-summary.js')

    await runSessionSummaryWorker(JSON.stringify({ transcript_path: transcript }), serverEnv())

    expect(stub.received).toHaveLength(1)
    expect(String(stub.received[0]!['content'])).not.toContain('Tr1cky-Pa55w0rd')
  })
})

describe('pre-compact in server mode', () => {
  const hookJson = (transcript: string) =>
    JSON.stringify({ session_id: 'sess-42', transcript_path: transcript, cwd: '/work/engram', trigger: 'auto' })

  it('posts a pre-compact derive capture and prints the returned context', async () => {
    const transcript = longFixture('compact.jsonl', 6, 300)
    stub.reply = { status: 200, body: { outcome: 'stored', model: MODEL, context: 'Moving consolidation off the backup window.' } }
    const stdout: string[] = []
    const { runPreCompact } = await import('../src/pre-compact.js')

    const code = await runPreCompact(hookJson(transcript), serverEnv(), (t) => stdout.push(t))

    expect(code).toBe(0)
    expect(h.localImported).toBe(false)
    expect(stub.received).toHaveLength(1)
    const body = stub.received[0]!
    expect(body).toMatchObject({
      source: 'claude-code',
      role: 'system',
      derive: 'pre-compact',
      session_id: 'sess-42',
      project_id: 'engram',
      meta: { trigger: 'auto', cwd: '/work/engram' },
    })
    expect(Object.keys(body['meta'] as object).sort()).toEqual(['capturedAt', 'cwd', 'trigger'])
    expect(body['key']).toMatch(/^[0-9a-f]{64}$/)
    expect(stdout).toEqual([
      JSON.stringify({ additionalContext: '[Engram Memory — preserved before compaction]\nMoving consolidation off the backup window.' }),
    ])
    expect(readFileSync(join(h.home, '.engram', 'hook.log'), 'utf8')).toContain('[engram-compact] mode=server')
  })

  it('prints nothing when the server returns no context', async () => {
    const stdout: string[] = []
    const { runPreCompact } = await import('../src/pre-compact.js')

    await runPreCompact(hookJson(longFixture('compact-noctx.jsonl', 6, 300)), serverEnv(), (t) => stdout.push(t))

    expect(stub.received).toHaveLength(1)
    expect(stdout).toEqual([])
  })

  it('spools the capture and prints nothing when the server is down', async () => {
    const stdout: string[] = []
    const { runPreCompact } = await import('../src/pre-compact.js')

    const code = await runPreCompact(
      hookJson(longFixture('compact-down.jsonl', 6, 300)),
      serverEnv(await closedPortUrl()),
      (t) => stdout.push(t),
    )

    expect(code).toBe(0)
    expect(stdout).toEqual([])
    const spool = spoolLines()
    expect(spool).toHaveLength(1)
    expect(spool[0]!['payload']).toMatchObject({ derive: 'pre-compact', session_id: 'sess-42' })
  })
})

describe('session-summary hook process', () => {
  it('exits before the server answers; the detached worker delivers the capture', async () => {
    const home = mkdtempSync(join(tmpdir(), 'engram-summary-hook-home-'))
    try {
      stub.hold = true
      const transcript = conversationFixture()
      const child = spawn(process.execPath, ['--import', 'tsx', join(PKG_DIR, 'src', 'session-summary.ts')], {
        cwd: PKG_DIR,
        env: { ...process.env, HOME: home, ENGRAM_SERVER_URL: stub.url, ENGRAM_SERVER_TOKEN: TOKEN, ENGRAM_PROJECT_ID: 'engram' },
        stdio: ['pipe', 'ignore', 'pipe'],
      })
      child.stdin.end(JSON.stringify({ session_id: 's-9', transcript_path: transcript }))
      const exitCode = await new Promise<number | null>((done) => child.on('exit', done))

      expect(exitCode).toBe(0)
      expect(stub.answered).toBe(0)

      await vi.waitFor(() => expect(stub.received).toHaveLength(1), { timeout: 20_000, interval: 100 })
      expect(stub.received[0]).toMatchObject({ derive: 'session-summary', session_id: 'claude-code-summaries' })
      stub.release()
      const hookLog = join(home, '.engram', 'hook.log')
      await vi.waitFor(
        () => expect(readFileSync(hookLog, 'utf8')).toContain('[engram-summary] mode=server source=claude-code outcome=stored'),
        { timeout: 10_000, interval: 100 },
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 40_000)
})
