/**
 * engram-ingest against a stub capture server: what server mode sends, what
 * it writes locally, and that it never loads the in-process pipeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The rejection log resolves ~/.engram when it is first imported, so HOME
// must point at a scratch directory before any module under test loads.
const h = await vi.hoisted(async () => {
  const { mkdtempSync: mkdtemp } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const savedHome = process.env['HOME']
  const home = mkdtemp(joinPath(tmpdir(), 'engram-ingest-cli-home-'))
  process.env['HOME'] = home
  return { home, savedHome, localImported: false, runLocalCapture: undefined as unknown }
})

vi.mock('../src/ingest/local-capture.js', () => {
  h.localImported = true
  const runLocalCapture = vi.fn(async () => ({ outcome: { outcome: 'stored', model: 'local-model' }, model: 'local-model' }))
  h.runLocalCapture = runLocalCapture
  return { runLocalCapture, MissingEnvError: class extends Error {} }
})

vi.mock('../src/ingest/project-detect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ingest/project-detect.js')>()),
  resolveProject: () => 'engram',
}))

const TOKEN = 'stub-bearer-41c9e2'
const SESSION = 'session-0b7d'
const MODEL = 'stub-chat-model'

interface Stub {
  url: string
  received: Array<Record<string, unknown>>
  reply: { status: number; body: unknown }
  close: () => Promise<void>
}

async function startStub(): Promise<Stub> {
  const stub: Stub = {
    url: '',
    received: [],
    reply: { status: 200, body: { outcome: 'stored', model: MODEL, category: 'decision', confidence: 0.9 } },
    close: async () => {},
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      stub.received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      res.writeHead(stub.reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(stub.reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  stub.url = `http://127.0.0.1:${port}/mcp`
  stub.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return stub
}

const ASSISTANT_TURN =
  'Moved the nightly consolidation to a systemd timer so it no longer competes with the backup window at 02:00.'

function writeTranscript(dir: string): string {
  const path = join(dir, 'transcript.jsonl')
  const lines = [
    { type: 'user', uuid: 'u-0001', message: { role: 'user', content: 'Why does consolidation overlap the backup?' } },
    { type: 'assistant', uuid: 'a-0002', message: { role: 'assistant', content: [{ type: 'text', text: ASSISTANT_TURN }] } },
  ]
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path
}

let stub: Stub
let stderr: string[]

function serverEnv(): Record<string, string> {
  return { HOME: h.home, ENGRAM_SERVER_URL: stub.url, ENGRAM_SERVER_TOKEN: TOKEN }
}

async function ingest(argv: string[], env: Record<string, string> = serverEnv()): Promise<number> {
  const { runIngestCli } = await import('../src/ingest/engram-ingest-cli.js')
  return runIngestCli(argv, env)
}

function rejectionLines(): Array<Record<string, unknown>> {
  const path = join(h.home, '.engram', 'rejected.jsonl')
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

afterAll(() => {
  rmSync(h.home, { recursive: true, force: true })
  if (h.savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = h.savedHome
})

describe('engram-ingest server mode', () => {
  it('posts the capture without importing the in-process pipeline', async () => {
    const code = await ingest(['--content', ASSISTANT_TURN, '--turn', 'assistant', '--source', 'cli'])

    expect(code).toBe(0)
    expect(stub.received).toHaveLength(1)
    expect(h.localImported).toBe(false)
    expect(stderr.join('')).toMatch(/\[engram-ingest\] mode=server source=cli outcome=stored ms=\d+ spool=0/)
  })

  it('runs the in-process pipeline only when no server URL is set', async () => {
    const code = await ingest(['--content', ASSISTANT_TURN, '--turn', 'assistant'], { HOME: h.home })

    expect(code).toBe(0)
    expect(h.localImported).toBe(true)
    expect(h.runLocalCapture).toHaveBeenCalledOnce()
    expect(stub.received).toHaveLength(0)
    expect(stderr.join('')).toContain('mode=local model=local-model')
  })

  it('sends the contract fields with a key stable across reruns of the same transcript line', async () => {
    const dir = mkdtempSync(join(h.home, 'transcript-'))
    const transcript = writeTranscript(dir)
    const argv = ['--transcript', transcript, '--turn', 'assistant', '--source', 'claude-code-hook-stop', '--session-id', SESSION]

    expect(await ingest(argv)).toBe(0)
    expect(await ingest(argv)).toBe(0)

    expect(stub.received).toHaveLength(2)
    const [first, second] = stub.received as [Record<string, unknown>, Record<string, unknown>]
    const expectedKey = createHash('sha256')
      .update(JSON.stringify(['claude-code-hook-stop', SESSION, 'a-0002']))
      .digest('hex')
    expect(first).toEqual({
      content: ASSISTANT_TURN,
      source: 'claude-code-hook-stop',
      role: 'assistant',
      session_id: SESSION,
      project_id: 'engram',
      gate: true,
      dedup: true,
      dry_run: false,
      key: expectedKey,
      meta: { capturedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), cwd: process.cwd() },
    })
    expect(second['key']).toBe(first['key'])
  })

  it('sends no key without a session id and cuts content to the route limit', async () => {
    const long = 'x'.repeat(100_050)

    expect(await ingest(['--content', long, '--source', 'cli'])).toBe(0)
    expect(await ingest(['--content', ASSISTANT_TURN, '--source', 'cli'])).toBe(0)

    const [cut, short] = stub.received as [Record<string, unknown>, Record<string, unknown>]
    expect((cut['content'] as string).length).toBe(100_000)
    expect(cut).not.toHaveProperty('session_id')
    expect(cut).not.toHaveProperty('key')
    expect(short).not.toHaveProperty('session_id')
    expect(short).not.toHaveProperty('key')
  })

  it('keys inline content by its text when a session id is given', async () => {
    expect(await ingest(['--content', ASSISTANT_TURN, '--source', 'cli', '--session-id', SESSION])).toBe(0)

    const [sent] = stub.received as [Record<string, unknown>]
    expect(sent['session_id']).toBe(SESSION)
    expect(sent['key']).toBe(createHash('sha256').update(JSON.stringify(['cli', SESSION, ASSISTANT_TURN])).digest('hex'))
  })

  it('writes one rejection-log entry with the server verdict for a rejected capture', async () => {
    stub.reply = {
      status: 200,
      body: { outcome: 'rejected', model: MODEL, category: 'noise', confidence: 0.22, reason: 'routine status update' },
    }

    expect(await ingest(['--content', ASSISTANT_TURN, '--turn', 'assistant', '--source', 'cli'])).toBe(0)

    const entries = rejectionLines()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      project: 'engram',
      role: 'assistant',
      source: 'cli',
      category: 'noise',
      confidence: 0.22,
      reason: 'routine status update',
      contentPreview: ASSISTANT_TURN,
    })
  })

  it.each([
    ['--threshold', ['--threshold', '0.5']],
    ['--classifier-model', ['--classifier-model', 'some-model']],
  ])('exits 2 on %s because the server decides', async (_flag, flags) => {
    const code = await ingest(['--content', ASSISTANT_TURN, ...flags])

    expect(code).toBe(2)
    expect(stub.received).toHaveLength(0)
    expect(stderr.join('')).toContain('the server decides')
  })

  it('maps --raw, --no-dedup and --dry-run onto gate, dedup and dry_run', async () => {
    stub.reply = { status: 200, body: { outcome: 'dry_run', model: 'raw', category: 'fact', confidence: 1 } }

    expect(await ingest(['--content', ASSISTANT_TURN, '--raw', '--no-dedup', '--dry-run'])).toBe(0)

    expect(stub.received[0]).toMatchObject({ gate: false, dedup: false, dry_run: true })
    expect(rejectionLines()).toHaveLength(0)
  })

  it('logs a gated dry-run rejection as local mode does', async () => {
    stub.reply = {
      status: 200,
      body: { outcome: 'rejected', model: MODEL, category: 'noise', confidence: 0.1, reason: 'routine status update' },
    }

    expect(await ingest(['--content', ASSISTANT_TURN, '--source', 'cli', '--dry-run'])).toBe(0)

    expect(stub.received[0]).toMatchObject({ gate: true, dry_run: true })
    expect(rejectionLines()).toHaveLength(1)
  })

  it('spools the capture and exits 0 when the server is down', async () => {
    await stub.close()

    expect(await ingest(['--content', ASSISTANT_TURN, '--source', 'cli'])).toBe(0)

    const spool = readFileSync(join(h.home, '.engram', 'spool.jsonl'), 'utf8').trim().split('\n')
    expect(spool).toHaveLength(1)
    expect(stderr.join('')).toMatch(/outcome=spooled .*spool=1/)
    stub = await startStub()
  })

  it('exits 1 when the server refuses the capture as invalid', async () => {
    stub.reply = { status: 400, body: { outcome: 'error', model: '', retryable: false, message: 'role is required' } }

    expect(await ingest(['--content', ASSISTANT_TURN, '--source', 'cli'])).toBe(1)
    expect(existsSync(join(h.home, '.engram', 'spool.dead.jsonl'))).toBe(true)
  })
})

describe('readTranscriptLastTurn', () => {
  it('returns the entry uuid with the text', async () => {
    const dir = mkdtempSync(join(h.home, 'transcript-'))
    const { readTranscriptLastTurn } = await import('../src/ingest/engram-ingest-cli.js')

    expect(readTranscriptLastTurn(writeTranscript(dir), 'assistant')).toEqual({ text: ASSISTANT_TURN, uuid: 'a-0002' })
  })
})
