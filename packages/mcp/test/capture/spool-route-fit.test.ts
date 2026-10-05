import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPTURE_EVENTS_BODY_MAX_BYTES,
  CAPTURE_FREE_TEXT_MAX_CHARS,
  USER_PROMPT_TEXT_MAX_CHARS,
} from '../../src/capture-events/contract.js'
import { parseCaptureEventsRequest } from '../../src/capture-events/validate.js'
import { captureClientInfo, type CaptureEvent } from '../../src/capture/events.js'
import { captureLogPath } from '../../src/capture/log.js'
import { readyForRoute } from '../../src/capture/route-fit.js'
import { spoolRoot } from '../../src/capture/spool.js'
import { spoolTranscript } from '../../src/capture/spool-transcript.js'
import { cursorRoot } from '../../src/capture/transcript-cursor.js'
import {
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

const SESSION = '00000000-0000-4000-8000-000000009400'
// A short value under a long name: its placeholder is longer than the value it replaces.
const SECRET_NAME = 'FIXTURE_REGISTERED_VALUE_WITH_A_MUCH_LONGER_NAME_TOKEN'
const SECRET = 'kv-fixture-short'
const PLACEHOLDER = `[REDACTED:${SECRET_NAME}]`

// The secret registry is built once per process from process.env, on the
// first scrub, so its source must be in place before any test runs.
const registryDir = mkdtempSync(join(tmpdir(), 'engram-route-fit-registry-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(registryDir, 'secrets.json'), JSON.stringify({ [SECRET_NAME]: SECRET }))
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
  home = mkdtempSync(join(tmpdir(), 'engram-route-fit-'))
  transcripts = join(home, 'transcripts')
  mkdirSync(transcripts)
  env = { HOME: home }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function jsonLines(paths: string[]): unknown[] {
  return paths.flatMap((p) =>
    readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown),
  )
}

function spooled(): CaptureEvent[] {
  const files = filesUnder(spoolRoot(env)).filter((p) => p.endsWith('.jsonl') && !p.includes('/.dead/'))
  return jsonLines(files) as CaptureEvent[]
}

function deadLetters(): Array<{ reason: string; event: CaptureEvent }> {
  return jsonLines(filesUnder(join(spoolRoot(env), '.dead'))) as Array<{ reason: string; event: CaptureEvent }>
}

/** The bytes of a request carrying this event alone. */
function requestBytes(event: CaptureEvent): number {
  return Buffer.byteLength(JSON.stringify({ client: captureClientInfo(), events: [event] }))
}

function routeRejections(events: CaptureEvent[]): string[] {
  if (events.length === 0) return []
  const parsed = parseCaptureEventsRequest({ client: captureClientInfo(), events }, new Date(), () => {})
  if ('error' in parsed) return [parsed.error]
  return parsed.rejected.map((r) => r.reason)
}

const question = 'Which store should the worker read?'
const questions = [{ question, header: 'Store', options: [{ label: 'Primary' }, { label: 'Replica' }] }]

describe('spoolTranscript spools only events the route accepts', () => {
  it('clips a final text that scrubbing grew past the cap, never inside the placeholder', async () => {
    const text = `${'a'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS - SECRET.length)}${SECRET}`
    const path = writeTranscript(transcripts, SESSION, [
      humanPrompt(uuid(1), at(1), 'write the long reply'),
      assistantText(uuid(2), at(2), text),
      turnEnd(uuid(3), at(3)),
    ])

    const result = await spoolTranscript(path, { env })

    expect(result).toMatchObject({ events: 2, dead: 0 })
    const turn = spooled().find((e) => e.type === 'assistant_turn')!
    const spooledText = (turn.payload as { text: string }).text
    expect(spooledText.length).toBeLessThanOrEqual(CAPTURE_FREE_TEXT_MAX_CHARS)
    expect(spooledText).toBe('a'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS - SECRET.length))
    expect(spooledText).not.toContain('[REDACTED')
    expect(routeRejections(spooled())).toEqual([])
  })

  it('keeps a whole placeholder that ends inside the cap', async () => {
    const text = `${'a'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS - PLACEHOLDER.length - 10)}${SECRET}${'b'.repeat(PLACEHOLDER.length)}`
    const path = writeTranscript(transcripts, SESSION, [
      humanPrompt(uuid(1), at(1), 'write the long reply'),
      assistantText(uuid(2), at(2), text),
      turnEnd(uuid(3), at(3)),
    ])

    await spoolTranscript(path, { env })

    const turn = spooled().find((e) => e.type === 'assistant_turn')!
    const spooledText = (turn.payload as { text: string }).text
    expect(spooledText.length).toBe(CAPTURE_FREE_TEXT_MAX_CHARS)
    expect(spooledText).toContain(PLACEHOLDER)
    expect(spooledText).not.toContain(SECRET)
  })

  it('cuts a prompt over the cap after scrubbing, so a value straddling the cut is masked and no half placeholder is left', async () => {
    const prompt = `${'p'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 5)}${SECRET} and the rest`
    const path = writeTranscript(transcripts, SESSION, [humanPrompt(uuid(1), at(1), prompt)])

    await spoolTranscript(path, { env })

    const [event] = spooled()
    expect(event.payload).toEqual({ text: 'p'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 5), truncated: true, transcript_line: 1 })
  })

  it('never cuts a prompt inside a surrogate pair', async () => {
    const path = writeTranscript(transcripts, SESSION, [
      humanPrompt(uuid(1), at(1), `${'c'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 1)}\u{1F600}tail`),
    ])

    await spoolTranscript(path, { env })

    expect(spooled()[0].payload).toEqual({
      text: 'c'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 1),
      truncated: true,
      transcript_line: 1,
    })
  })

  it('cuts a 1,000,005-character dialog response at 1,000,000 and marks the answer truncated', async () => {
    const path = writeTranscript(transcripts, SESSION, [
      askCall(uuid(1), at(1), 'toolu_ask', questions),
      askResult(uuid(2), at(2), 'toolu_ask', questions, { answers: {}, response: 'r'.repeat(USER_PROMPT_TEXT_MAX_CHARS + 5) }),
    ])

    const result = await spoolTranscript(path, { env })

    expect(result).toMatchObject({ events: 1, dead: 0 })
    const [event] = spooled()
    const payload = event.payload as { response: string; truncated?: true }
    expect(payload.response).toBe('r'.repeat(USER_PROMPT_TEXT_MAX_CHARS))
    expect(payload.truncated).toBe(true)
    expect(routeRejections(spooled())).toEqual([])
  })

  it('dead-letters an event the route refuses, with its reason, and logs the count', async () => {
    const path = writeTranscript(transcripts, SESSION, [
      humanPrompt(uuid(1), '2019-06-01T00:00:00.000Z', 'a prompt from a clock set years back'),
      humanPrompt(uuid(2), at(2), 'a prompt the route accepts'),
    ])

    const result = await spoolTranscript(path, { env })

    expect(result).toMatchObject({ events: 1, dead: 1 })
    expect(spooled().map((e) => e.event_uuid)).toEqual([uuid(2)])
    const letters = deadLetters()
    expect(letters).toHaveLength(1)
    expect(letters[0].reason).toBe('occurred_at is before 2020-01-01T00:00:00Z')
    expect(letters[0].event.event_uuid).toBe(uuid(1))
    const log = readFileSync(captureLogPath(env), 'utf8')
    expect(log).toMatch(/dead-lettered 1 event\(s\) the capture route refuses: occurred_at is before/)
  })

  it(
    'spools a dialog with three 1,000,000-character CJK answers as one event within the body cap',
    async () => {
      const three = ['First?', 'Second?', 'Third?'].map((q) => ({ question: q, header: 'Pick', options: [{ label: 'One' }] }))
      const answers = Object.fromEntries(three.map((q, i) => [q.question, '\u4e2d\u6587'.repeat(USER_PROMPT_TEXT_MAX_CHARS / 2).slice(i)]))
      const path = writeTranscript(transcripts, SESSION, [
        askCall(uuid(1), at(1), 'toolu_ask', three),
        askResult(uuid(2), at(2), 'toolu_ask', three, { answers }),
      ])

      const result = await spoolTranscript(path, { env })

      expect(result).toMatchObject({ events: 1, files: 1, dead: 0 })
      const [event] = spooled()
      expect(requestBytes(event)).toBeLessThanOrEqual(CAPTURE_EVENTS_BODY_MAX_BYTES)
      const payload = event.payload as { answers: Record<string, string>; truncated?: true }
      expect(payload.truncated).toBe(true)
      expect(Object.keys(payload.answers)).toEqual(['First?', 'Second?', 'Third?'])
      for (const [q, text] of Object.entries(payload.answers)) expect(answers[q].startsWith(text)).toBe(true)
      expect(routeRejections(spooled())).toEqual([])
    },
    60_000,
  )

  it(
    'spools only events the route accepts from a corpus of hostile lines, and leaves no secret anywhere',
    async () => {
      const deep = JSON.stringify(Array.from({ length: 1000 }).reduce<unknown>((inner) => [inner], 'core'))
      const longQuestion = `${'q'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS + 50)}?`
      const hostileQuestions = [
        {
          question: longQuestion,
          header: 'h'.repeat(500),
          options: Array.from({ length: 25 }, (_, i) => ({ label: `${'l'.repeat(3000)}${i}`, description: 'd'.repeat(250_000) })),
        },
      ]
      const path = writeTranscript(transcripts, SESSION, [
        humanPrompt(uuid(1), at(1), `nul\u0000inside, lone \uD800 high, lone \uDC00 low, key ${SECRET}`),
        humanPrompt(uuid(2), at(2), `${'\u0000'.repeat(USER_PROMPT_TEXT_MAX_CHARS + 10)}${SECRET}`),
        humanPrompt(uuid(3), at(3), `${'x'.repeat(USER_PROMPT_TEXT_MAX_CHARS + 100)}`, { extra: { nested: JSON.parse(deep) } }),
        askCall(uuid(4), at(4), 'toolu_hostile', hostileQuestions),
        askResult(uuid(5), at(5), 'toolu_hostile', hostileQuestions, {
          answers: { [longQuestion]: `\uD83D${'a'.repeat(USER_PROMPT_TEXT_MAX_CHARS)}` },
          annotations: { [longQuestion]: { notes: `${'n'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 10)}${SECRET}` } },
        }),
        toolUse(uuid(6), at(6), 'toolu_write', 'Write', { file_path: `/tmp/${'w'.repeat(5000)}`, content: 'x' }),
        toolResult(uuid(7), at(7), 'toolu_write', 'File created'),
        toolUse(uuid(8), at(8), 'toolu_bash', 'Bash', { command: 'rm -rf scratch' }),
        toolResult(uuid(9), at(9), 'toolu_bash', 'denied', {
          isError: true,
          toolDenialKind: 'user-rejected',
          userFeedback: `no, ${SECRET} ${'f'.repeat(USER_PROMPT_TEXT_MAX_CHARS)}`,
        }),
        assistantText(uuid(10), at(10), `${'t'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS * 2)}${SECRET}`),
        turnEnd(uuid(11), at(11)),
      ])
      appendFileSync(path, `${deep}\n{"type":"user","uuid":\n\u0000\u0000\n`)

      const result = await spoolTranscript(path, { env })

      const events = spooled()
      expect(result.events).toBe(events.length)
      expect(events.map((e) => e.type)).toEqual(['user_prompt', 'user_prompt', 'user_prompt', 'user_answer', 'user_prompt', 'assistant_turn'])
      expect(routeRejections(events)).toEqual([])
      for (const event of events) expect(requestBytes(event)).toBeLessThanOrEqual(CAPTURE_EVENTS_BODY_MAX_BYTES)
      const written = [...filesUnder(spoolRoot(env)), ...filesUnder(cursorRoot(env)), captureLogPath(env)].filter(existsSync)
      for (const file of written) expect(readFileSync(file, 'utf8').includes(SECRET), file).toBe(false)
    },
    120_000,
  )
})

describe('readyForRoute', () => {
  const base = {
    session_id: SESSION,
    event_uuid: uuid(1),
    occurred_at: at(1),
    cwd: '/home/tester/work/sample-repo',
    project: { id: null, workspace: null, repo_root: null, branch: null, worktree: null },
    plan_dirs: [],
  }

  it('drops a half placeholder left at the end of a prompt the scrubber already cut', () => {
    const text = `${'p'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 12)}[REDACTED:FI`
    const event = { ...base, type: 'user_prompt', payload: { text, truncated: true, transcript_line: 1 } } as CaptureEvent

    const check = readyForRoute(event, { now: new Date(), log: () => {} })

    expect(check).toEqual({
      ok: true,
      event: { ...event, payload: { text: 'p'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 12), truncated: true, transcript_line: 1 } },
    })
  })

  it('drops a tool ref longer than the route allows instead of losing the turn', () => {
    const event = {
      ...base,
      type: 'assistant_turn',
      payload: { text: 'Done.', transcript_line: 2, tools: [{ name: 'Write', ref: `/${'w'.repeat(5000)}` }, { name: 'Edit', ref: '/a.ts' }] },
    } as CaptureEvent

    const check = readyForRoute(event, { now: new Date(), log: () => {} })

    expect(check.ok && check.event.payload).toEqual({ text: 'Done.', transcript_line: 2, tools: [{ name: 'Edit', ref: '/a.ts' }] })
  })

  it('refuses an event whose fixed fields alone exceed the body cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      question: `Question ${i}?`,
      header: 'Pick',
      options: Array.from({ length: 20 }, () => ({ label: 'One', description: '\u4e2d'.repeat(15_000) })),
      multiSelect: false,
    }))
    const event = {
      ...base,
      type: 'user_answer',
      payload: { questions: many, answers: { [many[0].question]: 'One' }, transcript_line: 3 },
    } as CaptureEvent

    const check = readyForRoute(event, { now: new Date(), log: () => {} })

    expect(check.ok).toBe(false)
    expect(!check.ok && check.reason).toMatch(/exceeds .* bytes/)
  })
})
