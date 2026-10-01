/**
 * The laptop CLIs send hook text to models themselves (salience classifier,
 * session summariser, pre-compact extractor) before anything reaches
 * Memory.ingest. These tests import each CLI entry point with every network
 * dependency stubbed and assert that the model call, the rejection log and
 * the ingest call all receive scrubbed text.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Synthetic credential shapes: none of these is a real key.
const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop'
const FAKE_PASSWORD = 'c0rrect-h0rse-battery'
const TRANSCRIPT_PATH = '/tmp/engram-cli-scrub-test/transcript.jsonl'

const h = vi.hoisted(() => ({
  stdin: '',
  transcript: '',
  digestTranscript: vi.fn(),
  extractSalience: vi.fn(),
  memoryIngest: vi.fn(),
  memoryDispose: vi.fn(),
  logRejection: vi.fn(),
  findDuplicate: vi.fn(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (path === 0) return h.stdin
    if (path === TRANSCRIPT_PATH) return h.transcript
    return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

vi.mock('@engram-mem/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engram-mem/core')>()
  return {
    ...actual,
    createMemory: () => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      ingest: h.memoryIngest,
      flushPendingWrites: vi.fn().mockResolvedValue(undefined),
      dispose: h.memoryDispose,
    }),
  }
})

vi.mock('@engram-mem/postgrest', () => ({
  PostgRestStorageAdapter: class {
    initialize = vi.fn().mockResolvedValue(undefined)
    dispose = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('@engram-mem/openai', () => ({
  openaiIntelligence: () => ({ extractSalience: h.extractSalience, digestTranscript: h.digestTranscript, embed: vi.fn() }),
  DEFAULT_CHAT_MODEL: 'default-chat-model',
}))

vi.mock('../src/graph-helper.js', () => ({ tryCreateGraph: vi.fn().mockResolvedValue(null) }))
vi.mock('../src/ingest/project-detect.js', () => ({
  resolveProject: () => 'engram',
  resolveProjectScope: () => ({ id: undefined, source: 'unscoped' }),
  projectForCategory: (project: string | null) => project,
}))
vi.mock('../src/ingest/dedup.js', () => ({
  findDuplicate: h.findDuplicate,
  boostDuplicate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/ingest/rejection-log.js', () => ({ logRejection: h.logRejection }))

// Free text is masked by value: the CLIs see these as values kept in this
// machine's secret files.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-cli-scrub-registry-'))
writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({ OPENAI_API_KEY: FAKE_KEY, NEO4J_PASSWORD: FAKE_PASSWORD }))
writeFileSync(join(registryDir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
afterAll(() => rmSync(registryDir, { recursive: true, force: true }))

const ENV = {
  // The hooks append to ~/.engram/hook.log.
  HOME: registryDir,
  SUPABASE_URL: 'https://example.test',
  SUPABASE_KEY: 'test-key',
  OPENAI_API_KEY: 'test-openai',
  ENGRAM_SECRET_SOURCES_FILE: join(registryDir, 'sources.json'),
}

let stderrLines: string[] = []
let exitSpy: ReturnType<typeof vi.spyOn>
const cliTimers: Array<ReturnType<typeof setTimeout>> = []
const savedArgv = process.argv
const savedEnv = { ...process.env }

function transcriptLines(entries: Array<{ type: string; text: string }>): string {
  return entries
    .map((e) => JSON.stringify({ type: e.type, message: { content: [{ type: 'text', text: e.text }] } }))
    .join('\n')
}

const SECRET_TRANSCRIPT = transcriptLines([
  {
    type: 'user',
    text: `Here is the env block for the HTTP server, wire it into ecosystem.config.cjs:\nOPENAI_API_KEY=${FAKE_KEY}\nNEO4J_PASSWORD=${FAKE_PASSWORD}\nPORT=8787`,
  },
  {
    type: 'assistant',
    text: 'Added the env block to the pm2 app entry, restarted the process and confirmed the health endpoint answers on port 8787 again.',
  },
])

function allText(value: unknown): string {
  return JSON.stringify(value)
}

beforeEach(() => {
  vi.resetModules()
  for (const fn of [h.digestTranscript, h.extractSalience, h.memoryIngest, h.memoryDispose, h.logRejection, h.findDuplicate]) {
    fn.mockReset()
  }
  h.memoryIngest.mockResolvedValue(undefined)
  h.memoryDispose.mockResolvedValue(undefined)
  h.findDuplicate.mockResolvedValue({ duplicateId: null, similarity: 0 })
  Object.assign(process.env, ENV)
  // These cases exercise the in-process pipeline, which runs only without a server URL.
  delete process.env['ENGRAM_SERVER_URL']
  stderrLines = []
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit)
  const realSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const handle = realSetTimeout(fn, ms, ...rest)
    // The ingest CLI arms a process-exit watchdog on import; it must not
    // outlive the test.
    if (ms === 60_000) cliTimers.push(handle)
    return handle
  }) as typeof setTimeout)
})

afterEach(() => {
  for (const t of cliTimers.splice(0)) clearTimeout(t)
  vi.restoreAllMocks()
  process.argv = savedArgv
  process.env = { ...savedEnv }
})

async function runIngest(argv: string[]): Promise<number> {
  const { runIngestCli } = await import('../src/ingest/engram-ingest-cli.js')
  return runIngestCli(argv, process.env)
}

describe('engram-ingest CLI', () => {
  const turn = `Deploy note: API_KEY=${FAKE_KEY} lives in the staging .env from now on`

  it('scrubs content before the classifier, the ingest call and the hook log', async () => {
    h.extractSalience.mockImplementation(async (content: string) => ({
      store: true, category: 'fact', confidence: 0.9, distilled: content, reason: 'decision',
    }))
    const code = await runIngest(['--content', turn, '--turn', 'user', '--no-dedup', '--verbose'])
    expect(code).toBe(0)
    expect(h.memoryDispose).toHaveBeenCalled()

    expect(h.extractSalience).toHaveBeenCalledOnce()
    expect(h.extractSalience.mock.calls[0]![0]).toBe(
      'Deploy note: API_KEY=[REDACTED:OPENAI_API_KEY] lives in the staging .env from now on',
    )
    expect(h.memoryIngest).toHaveBeenCalledOnce()
    const ingested = h.memoryIngest.mock.calls[0]![0] as { content: string; metadata: Record<string, unknown> }
    expect(ingested.content).toContain('API_KEY=[REDACTED:OPENAI_API_KEY]')
    expect(String(ingested.metadata['rawTurn'])).toContain('API_KEY=[REDACTED:OPENAI_API_KEY]')
    expect(allText(h.memoryIngest.mock.calls)).not.toContain(FAKE_KEY)
    expect(stderrLines).toContain('[engram-ingest] redacted 1 secret value(s): known(1)\n')
    expect(stderrLines.join('')).not.toContain(FAKE_KEY)
  })

  it('writes only scrubbed text to the rejection log', async () => {
    h.extractSalience.mockResolvedValue({
      store: false, category: 'noise', confidence: 0.2, distilled: '', reason: 'routine',
    })
    const code = await runIngest(['--content', turn, '--turn', 'user', '--no-dedup'])
    expect(h.logRejection).toHaveBeenCalled()

    const entry = h.logRejection.mock.calls[0]![0] as { contentPreview: string }
    expect(entry.contentPreview).toContain('API_KEY=[REDACTED:OPENAI_API_KEY]')
    expect(entry.contentPreview).not.toContain(FAKE_KEY)
    expect(code).toBe(0)
  })

  it('exits non-zero with the message when the classifier fails, logging no rejection', async () => {
    h.extractSalience.mockRejectedValue(new Error('chat endpoint returned 502'))
    const code = await runIngest(['--content', turn, '--turn', 'user', '--no-dedup'])

    expect(code).toBe(1)
    expect(stderrLines.join('')).toContain('chat endpoint returned 502')
    expect(h.logRejection).not.toHaveBeenCalled()
    expect(h.memoryIngest).not.toHaveBeenCalled()
  })

  it('records the default chat model as the capture model', async () => {
    h.extractSalience.mockImplementation(async (content: string) => ({
      store: true, category: 'fact', confidence: 0.9, distilled: content, reason: 'decision',
    }))
    const code = await runIngest(['--content', turn, '--turn', 'user', '--no-dedup'])
    expect(code).toBe(0)
    expect(h.memoryDispose).toHaveBeenCalled()

    const ingested = h.memoryIngest.mock.calls[0]![0] as { metadata: Record<string, unknown> }
    expect(ingested.metadata['captureModel']).toBe('default-chat-model')
  })

  it('records a raw capture as seen by no model', async () => {
    const code = await runIngest(['--raw', '--content', 'feat: stream the transcript read', '--source', 'git-commit', '--no-dedup'])
    expect(code).toBe(0)
    expect(h.memoryDispose).toHaveBeenCalled()

    expect(h.extractSalience).not.toHaveBeenCalled()
    const ingested = h.memoryIngest.mock.calls[0]![0] as { metadata: Record<string, unknown> }
    expect(ingested.metadata['captureModel']).toBe('raw')
  })

  it('runs a raw dry run with no OpenAI key and no store credentials', async () => {
    delete process.env['OPENAI_API_KEY']
    delete process.env['SUPABASE_URL']
    delete process.env['SUPABASE_KEY']
    const code = await runIngest(['--raw', '--dry-run', '--content', 'feat: stream the transcript read', '--source', 'git-commit'])

    expect(code).toBe(0)
    expect(stderrLines.join('')).not.toContain('missing required env')
    expect(h.memoryIngest).not.toHaveBeenCalled()
  })

  it.each([
    ['a gated dry run', ['--dry-run']],
    ['a raw store', ['--raw']],
  ])('still requires OPENAI_API_KEY for %s', async (_label, flags) => {
    delete process.env['OPENAI_API_KEY']
    const code = await runIngest([...flags, '--content', 'feat: stream the transcript read', '--source', 'git-commit'])
    expect(code).toBe(1)
    expect(stderrLines.join('')).toContain('missing required env: OPENAI_API_KEY')
  })
})

describe('session-summary CLI', () => {
  it('sends the digest model a scrubbed transcript and logs the redaction kinds', async () => {
    h.transcript = SECRET_TRANSCRIPT
    h.digestTranscript.mockResolvedValue({
      memory: 'Session: pm2 env wiring\n- Added the env block and restarted the HTTP server.',
      context: '',
    })

    const { runSessionSummaryWorker } = await import('../src/session-summary.js')
    const code = await runSessionSummaryWorker(
      JSON.stringify({ session_id: 'sess-1', transcript_path: TRANSCRIPT_PATH }),
      process.env,
    )

    expect(code).toBe(0)
    expect(h.memoryIngest).toHaveBeenCalledOnce()
    expect(h.digestTranscript).toHaveBeenCalledOnce()
    const prompt = allText(h.digestTranscript.mock.calls[0])
    expect(prompt).toContain('OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]')
    expect(prompt).toContain('NEO4J_PASSWORD=[REDACTED:NEO4J_PASSWORD]')
    expect(prompt).not.toContain(FAKE_KEY)
    expect(prompt).not.toContain(FAKE_PASSWORD)
    expect(stderrLines).toContain('[engram-summary] redacted 2 secret value(s): known(2)\n')
  })
})

describe('pre-compact CLI', () => {
  it('sends the digest model a scrubbed transcript and prints its context', async () => {
    h.transcript = [SECRET_TRANSCRIPT, SECRET_TRANSCRIPT].join('\n')
    h.digestTranscript.mockResolvedValue({
      memory: '- Wired the pm2 env block for the HTTP server.',
      context: 'Wiring the HTTP server env block under pm2.',
    })
    const stdout: string[] = []

    const { runPreCompact } = await import('../src/pre-compact.js')
    const code = await runPreCompact(
      JSON.stringify({ session_id: 'sess-2', transcript_path: TRANSCRIPT_PATH, trigger: 'auto' }),
      process.env,
      (text) => stdout.push(text),
    )

    expect(code).toBe(0)
    expect(h.memoryIngest).toHaveBeenCalledOnce()
    expect(h.digestTranscript).toHaveBeenCalledOnce()
    const prompt = allText(h.digestTranscript.mock.calls[0])
    expect(prompt).toContain('OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]')
    expect(prompt).not.toContain(FAKE_KEY)
    expect(prompt).not.toContain(FAKE_PASSWORD)
    expect(stderrLines).toContain('[engram-compact] redacted 4 secret value(s): known(4)\n')
    expect(stdout).toEqual([
      JSON.stringify({
        additionalContext: '[Engram Memory — preserved before compaction]\nWiring the HTTP server env block under pm2.',
      }),
    ])
  })
})
