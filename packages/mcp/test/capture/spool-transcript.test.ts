import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureEvent } from '../../src/capture/events.js'
import { captureLogPath } from '../../src/capture/log.js'
import { spoolRoot } from '../../src/capture/spool.js'
import { spoolTranscript } from '../../src/capture/spool-transcript.js'
import { cursorRoot, loadCursor } from '../../src/capture/transcript-cursor.js'
import {
  appendEntries,
  askCall,
  askResult,
  assistantText,
  at,
  humanPrompt,
  toolResult,
  toolUse,
  turnEnd,
  uuid,
  writeTranscript,
} from './transcripts.js'

const SESSION = '00000000-0000-4000-8000-000000009300'
const SECRET = 'qx7-fixture-secret-value-5531'

// The secret registry is built once per process from process.env, on the
// first scrub, so its source must be in place before any test runs.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-spool-transcript-registry-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET: SECRET }))
  writeFileSync(join(registryDir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
  process.env.ENGRAM_SECRET_SOURCES_FILE = join(registryDir, 'sources.json')
  process.env.XDG_CACHE_HOME = join(registryDir, 'cache')
})

afterAll(() => {
  if (savedEnv.SOURCES === undefined) delete process.env.ENGRAM_SECRET_SOURCES_FILE
  else process.env.ENGRAM_SECRET_SOURCES_FILE = savedEnv.SOURCES
  if (savedEnv.CACHE === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = savedEnv.CACHE
  rmSync(registryDir, { recursive: true, force: true })
})

let home: string
let env: Record<string, string>
let transcripts: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'engram-spool-transcript-'))
  transcripts = join(home, 'transcripts')
  mkdirSync(transcripts)
  env = { HOME: home }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function batchFiles(): string[] {
  return filesUnder(spoolRoot(env)).filter((p) => p.endsWith('.jsonl') && !p.includes('/.dead/'))
}

function batchEvents(): CaptureEvent[] {
  return batchFiles().flatMap((p) =>
    readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CaptureEvent),
  )
}

function closedTurn(first: number, text: string) {
  return [
    humanPrompt(uuid(first), at(first), text),
    assistantText(uuid(first + 1), at(first + 1), `reply to ${text}`),
    turnEnd(uuid(first + 2), at(first + 2)),
  ]
}

describe('spoolTranscript', () => {
  it('writes one batch, then moves the cursor; a second call writes nothing', async () => {
    const path = writeTranscript(transcripts, SESSION, closedTurn(1, 'first prompt'))

    const first = await spoolTranscript(path, { env })

    expect(first).toEqual({ events: 2, files: 1, redactions: 0, dead: 0 })
    expect(batchFiles()).toHaveLength(1)
    expect(batchEvents().map((e) => e.type)).toEqual(['user_prompt', 'assistant_turn'])
    const cursor = await loadCursor(cursorRoot(env), SESSION)
    expect(cursor?.offset).toBe(statSync(path).size)
    expect(cursor?.line).toBe(3)

    const second = await spoolTranscript(path, { env })

    expect(second).toEqual({ events: 0, files: 0, redactions: 0, dead: 0 })
    expect(batchFiles()).toHaveLength(1)
  })

  it('leaves the cursor where it was when the spool write fails', async () => {
    const path = writeTranscript(transcripts, SESSION, closedTurn(1, 'first prompt'))
    await spoolTranscript(path, { env })
    const before = await loadCursor(cursorRoot(env), SESSION)
    appendEntries(path, SESSION, closedTurn(10, 'second prompt'))
    rmSync(spoolRoot(env), { recursive: true, force: true })
    writeFileSync(spoolRoot(env), 'not a directory')

    await expect(spoolTranscript(path, { env })).rejects.toThrow()

    expect(await loadCursor(cursorRoot(env), SESSION)).toEqual(before)
  })

  it('closes a turn still open at EOF only when asked to', async () => {
    const path = writeTranscript(transcripts, SESSION, [
      humanPrompt(uuid(1), at(1), 'open prompt'),
      assistantText(uuid(2), at(2), 'partial reply'),
    ])

    expect(await spoolTranscript(path, { env })).toMatchObject({ events: 1 })
    expect(await spoolTranscript(path, { env, forceClose: true })).toMatchObject({ events: 1 })
    expect(batchEvents().map((e) => e.type)).toEqual(['user_prompt', 'assistant_turn'])
  })

  it('stamps each event with the project of its cwd', async () => {
    const repo = join(home, 'code', 'sample-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const path = writeTranscript(transcripts, SESSION, [
      humanPrompt(uuid(1), at(1), 'in a repository', { cwd: repo, gitBranch: 'topic' }),
      humanPrompt(uuid(2), at(2), 'outside', { cwd: home }),
    ])

    await spoolTranscript(path, { env })

    expect(batchEvents().map((e) => e.project)).toEqual([
      { id: 'sample-repo', workspace: null, repo_root: repo, branch: 'topic', worktree: null },
      { id: null, workspace: null, repo_root: null, branch: null, worktree: null },
    ])
  })

  it('masks a known secret in a prompt, an answer, a note and a tool ref, and leaves it in no file', async () => {
    const question = 'Which store should the worker read?'
    const questions = [{ question, header: 'Store', options: [{ label: 'Primary' }, { label: 'Replica' }] }]
    const filePath = `/home/tester/work/sample-repo/notes-${SECRET}.md`
    const path = writeTranscript(transcripts, SESSION, [
      humanPrompt(uuid(1), at(1), `use the key ${SECRET} for the replica`),
      askCall(uuid(2), at(2), 'toolu_ask', questions),
      askResult(uuid(3), at(3), 'toolu_ask', questions, {
        answers: { [question]: `Replica with ${SECRET}` },
        annotations: { [question]: { notes: `rotate ${SECRET} after` } },
      }),
      toolUse(uuid(4), at(4), 'toolu_write', 'Write', { file_path: filePath, content: 'body' }),
      toolResult(uuid(5), at(5), 'toolu_write', 'File created'),
      assistantText(uuid(6), at(6), 'Done.'),
      turnEnd(uuid(7), at(7)),
    ])

    const result = await spoolTranscript(path, { env })

    expect(result.events).toBe(3)
    expect(result.redactions).toBeGreaterThanOrEqual(4)
    const [prompt, answer, turn] = batchEvents()
    expect(prompt.type).toBe('user_prompt')
    expect(answer.type).toBe('user_answer')
    expect(turn.type).toBe('assistant_turn')
    const promptText = (prompt.payload as { text: string }).text
    const answerPayload = answer.payload as { answers: Record<string, string>; notes: Record<string, string> }
    const ref = (turn.payload as { tools: { name: string; ref: string }[] }).tools[0]
    expect(promptText.startsWith('use the key ')).toBe(true)
    expect(promptText).not.toContain(SECRET)
    expect(answerPayload.answers[question]).toMatch(/^Replica with /)
    expect(answerPayload.answers[question]).not.toContain(SECRET)
    expect(answerPayload.notes[question]).toMatch(/^rotate /)
    expect(answerPayload.notes[question]).not.toContain(SECRET)
    expect(ref.name).toBe('Write')
    expect(ref.ref).toMatch(/^\/home\/tester\/work\/sample-repo\/notes-/)
    expect(ref.ref).not.toContain(SECRET)

    const written = [...filesUnder(spoolRoot(env)), ...filesUnder(cursorRoot(env)), captureLogPath(env)].filter(existsSync)
    expect(written.length).toBeGreaterThan(0)
    for (const file of written) expect(readFileSync(file, 'utf8'), file).not.toContain(SECRET)
  })
})
