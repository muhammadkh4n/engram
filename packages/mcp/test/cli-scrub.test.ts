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
  createCompletion: vi.fn(),
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

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: h.createCompletion } }
  },
}))

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
  openaiIntelligence: () => ({ extractSalience: h.extractSalience, embed: vi.fn() }),
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
    type: 'human',
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
  for (const fn of [h.createCompletion, h.extractSalience, h.memoryIngest, h.memoryDispose, h.logRejection, h.findDuplicate]) {
    fn.mockReset()
  }
  h.memoryIngest.mockResolvedValue(undefined)
  h.memoryDispose.mockResolvedValue(undefined)
  h.findDuplicate.mockResolvedValue({ duplicateId: null, similarity: 0 })
  Object.assign(process.env, ENV)
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

describe('engram-ingest CLI', () => {
  const turn = `Deploy note: API_KEY=${FAKE_KEY} lives in the staging .env from now on`

  it('scrubs content before the classifier, the ingest call and the hook log', async () => {
    h.extractSalience.mockImplementation(async (content: string) => ({
      store: true, category: 'fact', confidence: 0.9, distilled: content, reason: 'decision',
    }))
    process.argv = ['node', 'engram-ingest', '--content', turn, '--turn', 'user', '--no-dedup', '--verbose']

    await import('../src/ingest/engram-ingest-cli.js')
    await vi.waitFor(() => expect(h.memoryDispose).toHaveBeenCalled())

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
    process.argv = ['node', 'engram-ingest', '--content', turn, '--turn', 'user', '--no-dedup']

    await import('../src/ingest/engram-ingest-cli.js')
    await vi.waitFor(() => expect(h.logRejection).toHaveBeenCalled())

    const entry = h.logRejection.mock.calls[0]![0] as { contentPreview: string }
    expect(entry.contentPreview).toContain('API_KEY=[REDACTED:OPENAI_API_KEY]')
    expect(entry.contentPreview).not.toContain(FAKE_KEY)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

describe('session-summary CLI', () => {
  it('sends the summariser a scrubbed transcript and logs the redaction kinds', async () => {
    h.stdin = JSON.stringify({ session_id: 'sess-1', transcript_path: TRANSCRIPT_PATH })
    h.transcript = SECRET_TRANSCRIPT
    h.createCompletion.mockResolvedValue({
      choices: [{ message: { content: 'Session: pm2 env wiring\n- Added the env block and restarted the HTTP server.' } }],
    })

    await import('../src/session-summary.js')
    await vi.waitFor(() => expect(h.memoryIngest).toHaveBeenCalled())

    expect(h.createCompletion).toHaveBeenCalledOnce()
    const prompt = allText(h.createCompletion.mock.calls[0]![0])
    expect(prompt).toContain('OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]')
    expect(prompt).toContain('NEO4J_PASSWORD=[REDACTED:NEO4J_PASSWORD]')
    expect(prompt).not.toContain(FAKE_KEY)
    expect(prompt).not.toContain(FAKE_PASSWORD)
    expect(stderrLines).toContain('[engram-summary] redacted 2 secret value(s): known(2)\n')
  })
})

describe('pre-compact CLI', () => {
  it('sends the extraction model a scrubbed transcript', async () => {
    h.stdin = JSON.stringify({ session_id: 'sess-2', transcript_path: TRANSCRIPT_PATH, trigger: 'auto' })
    h.transcript = [SECRET_TRANSCRIPT, SECRET_TRANSCRIPT].join('\n')
    h.createCompletion.mockResolvedValue({
      choices: [{ message: { content: 'MEMORY:\n- Wired the pm2 env block for the HTTP server.\n\nCONTEXT:\n' } }],
    })

    await import('../src/pre-compact.js')
    await vi.waitFor(() => expect(h.memoryIngest).toHaveBeenCalled())

    expect(h.createCompletion).toHaveBeenCalledOnce()
    const prompt = allText(h.createCompletion.mock.calls[0]![0])
    expect(prompt).toContain('OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]')
    expect(prompt).not.toContain(FAKE_KEY)
    expect(prompt).not.toContain(FAKE_PASSWORD)
    expect(stderrLines).toContain('[engram-compact] redacted 4 secret value(s): known(4)\n')
  })
})
