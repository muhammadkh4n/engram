import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { resetDefaultSecretRegistry } from '@engram-mem/core'
import type { CaptureEvent } from '../../src/capture-events/contract.js'
import { USER_PROMPT_TEXT_MAX_CHARS } from '../../src/capture-events/contract.js'
import { scrubEvent } from '../../src/capture-events/scrub.js'
import { validEvent } from './fixtures.js'

const TOKEN = ('c4' + randomBytes(24).toString('hex')).slice(0, 40)
const PLACEHOLDER = '[REDACTED:ENGRAM_CAPTURE_TOKEN]'

function event(type: CaptureEvent['type'], patch: (e: Record<string, any>) => void = () => {}): CaptureEvent {
  const e = validEvent(type) as Record<string, any>
  patch(e)
  return e as unknown as CaptureEvent
}

beforeEach(() => {
  vi.stubEnv('ENGRAM_SECRET_SOURCES_FILE', '')
  vi.stubEnv('ENGRAM_CAPTURE_TOKEN', TOKEN)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetDefaultSecretRegistry()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetDefaultSecretRegistry()
})

describe('scrubEvent', () => {
  it('masks a registered value in a prompt text and cwd, listing each by path and name', async () => {
    const input = event('user_prompt', (e) => {
      e.payload.text = `call it with ${TOKEN} please`
      e.cwd = `/tmp/${TOKEN}`
    })
    const { event: out, masked } = await scrubEvent(input)
    expect(out.payload).toEqual({ text: `call it with ${PLACEHOLDER} please`, transcript_line: 12 })
    expect(out.cwd).toBe(`/tmp/${PLACEHOLDER}`)
    expect(masked).toEqual([
      { field: 'cwd', detector: 'known', secret_name: 'ENGRAM_CAPTURE_TOKEN' },
      { field: 'payload.text', detector: 'known', secret_name: 'ENGRAM_CAPTURE_TOKEN' },
    ])
    expect(JSON.stringify(masked)).not.toContain(TOKEN)
  })

  it('masks a value in a question and re-keys its answer and note to the scrubbed question', async () => {
    const question = `Rotate ${TOKEN} now?`
    const input = event('user_answer', (e) => {
      e.payload.questions[0].question = question
      e.payload.answers = { [question]: 'yes' }
      e.payload.notes = { [question]: `the old one was ${TOKEN}` }
    })
    const { event: out, masked } = await scrubEvent(input)
    const scrubbed = `Rotate ${PLACEHOLDER} now?`
    const payload = out.payload as { questions: Array<{ question: string }>; answers: object; notes: object }
    expect(payload.questions[0]!.question).toBe(scrubbed)
    expect(payload.answers).toEqual({ [scrubbed]: 'yes' })
    expect(payload.notes).toEqual({ [scrubbed]: `the old one was ${PLACEHOLDER}` })
    expect(masked).toEqual([
      { field: 'payload.questions[0].question', detector: 'known', secret_name: 'ENGRAM_CAPTURE_TOKEN' },
      { field: 'payload.notes[questions[0]]', detector: 'known', secret_name: 'ENGRAM_CAPTURE_TOKEN' },
    ])
    expect(JSON.stringify({ out, masked })).not.toContain(TOKEN)
  })

  it('keeps one answer per question when two questions scrub to the same text', async () => {
    const first = `Send Authorization: Bearer ${TOKEN.slice(0, 20)}a?`
    const second = `Send Authorization: Bearer ${TOKEN.slice(20)}b?`
    const base = validEvent('user_answer').payload.questions as Array<Record<string, unknown>>
    const input = event('user_answer', (e) => {
      e.payload.questions = [
        { ...base[0], question: first },
        { ...base[0], question: second },
      ]
      e.payload.answers = { [first]: 'first', [second]: 'second' }
      delete e.payload.notes
    })
    const { event: out } = await scrubEvent(input)
    const payload = out.payload as { questions: Array<{ question: string }>; answers: Record<string, string> }
    expect(payload.questions.map((q) => q.question)).toEqual([
      'Send Authorization: Bearer [REDACTED:authorization]?',
      'Send Authorization: Bearer [REDACTED:authorization]? (question 2)',
    ])
    expect(payload.answers).toEqual({
      'Send Authorization: Bearer [REDACTED:authorization]?': 'first',
      'Send Authorization: Bearer [REDACTED:authorization]? (question 2)': 'second',
    })
  })

  it('masks a value in a tool ref and keeps the tool name', async () => {
    const input = event('assistant_turn', (e) => {
      e.payload.tools[0] = { name: 'Bash', ref: `curl -H "X-Token: ${TOKEN}" localhost` }
    })
    const { event: out, masked } = await scrubEvent(input)
    const tools = (out.payload as { tools: Array<{ name: string; ref: string | null }> }).tools
    expect(tools[0]).toEqual({ name: 'Bash', ref: `curl -H "X-Token: ${PLACEHOLDER}" localhost` })
    expect(masked).toEqual([{ field: 'payload.tools[0].ref', detector: 'known', secret_name: 'ENGRAM_CAPTURE_TOKEN' }])
  })

  it('leaves identifiers untouched', async () => {
    const input = event('register_entry')
    const { event: out, masked } = await scrubEvent(input)
    expect(out).toEqual(input)
    expect(masked).toEqual([])
  })

  it('cuts a prompt over the limit to its first 1,000,000 characters and marks it truncated', async () => {
    const input = event('user_prompt', (e) => {
      e.payload.text = 'word '.repeat(200_000) + 'x'
    })
    const { event: out } = await scrubEvent(input)
    const payload = out.payload as { text: string; truncated?: boolean }
    expect(payload.text).toHaveLength(USER_PROMPT_TEXT_MAX_CHARS)
    expect(payload.truncated).toBe(true)
  }, 60_000)

  it('never cuts a surrogate pair in half', async () => {
    const input = event('user_prompt', (e) => {
      e.payload.text = 'a'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 1) + '😀tail'
    })
    const { event: out } = await scrubEvent(input)
    const payload = out.payload as { text: string; truncated?: boolean }
    expect(payload.text).toBe('a'.repeat(USER_PROMPT_TEXT_MAX_CHARS - 1))
    expect(payload.truncated).toBe(true)
  }, 60_000)

  it('masks a value straddling the cut whole before cutting', async () => {
    const input = event('user_prompt', (e) => {
      e.payload.text = 'a '.repeat((USER_PROMPT_TEXT_MAX_CHARS - 10) / 2) + TOKEN
    })
    const { event: out, masked } = await scrubEvent(input)
    const payload = out.payload as { text: string }
    expect(payload.text).not.toContain(TOKEN.slice(0, 10))
    expect(masked).toEqual([{ field: 'payload.text', detector: 'known', secret_name: 'ENGRAM_CAPTURE_TOKEN' }])
  }, 60_000)
})
