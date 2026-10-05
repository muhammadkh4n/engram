import { describe, it, expect } from 'vitest'
import { CAPTURE_EVENT_TYPES } from '@engram-mem/core'
import { parseCaptureEventsRequest } from '../../src/capture-events/validate.js'
import {
  CAPTURE_EVENTS_MAX,
  CAPTURE_FREE_TEXT_MAX_CHARS,
  USER_PROMPT_TEXT_MAX_CHARS,
  type Rejection,
  type ValidEvent,
} from '../../src/capture-events/contract.js'
import {
  OCCURRED_AT_MS,
  RECEIVED_AT,
  SAMPLE_LEGACY_ITEM_ID,
  envelope,
  validEvent,
  type FixtureEvent,
} from './fixtures.js'

type Parsed = { events: ValidEvent[]; rejected: Rejection[] }

function parseBatch(events: unknown[]): Parsed {
  const result = parseCaptureEventsRequest(envelope(events), RECEIVED_AT)
  if ('error' in result) throw new Error(`unexpected envelope error: ${result.error}`)
  return result
}

function expectValid(event: unknown): ValidEvent {
  const { events, rejected } = parseBatch([event])
  expect(rejected).toEqual([])
  expect(events).toHaveLength(1)
  return events[0]!
}

function expectRejected(event: unknown): Rejection {
  const { events, rejected } = parseBatch([event])
  expect(events).toEqual([])
  expect(rejected).toHaveLength(1)
  return rejected[0]!
}

function withPayload(type: (typeof CAPTURE_EVENT_TYPES)[number], patch: Record<string, unknown>): FixtureEvent {
  const event = validEvent(type)
  return { ...event, payload: { ...event.payload, ...patch } }
}

function withoutPayloadKey(event: FixtureEvent, key: string): FixtureEvent {
  const payload = { ...event.payload }
  delete payload[key]
  return { ...event, payload }
}

describe('parseCaptureEventsRequest — fixtures', () => {
  it.each([...CAPTURE_EVENT_TYPES])('accepts the %s fixture unchanged', (type) => {
    const fixture = validEvent(type)
    const { event } = expectValid(fixture)
    expect(event).toEqual(fixture)
  })

  it('keeps each event at its index and reports rejections at theirs', () => {
    const bad = { ...validEvent('session_end', 2), role: 'user' }
    const { events, rejected } = parseBatch([validEvent('session_start'), bad, validEvent('pre_compact')])
    expect(events.map((e) => e.index)).toEqual([0, 2])
    expect(rejected).toEqual([
      { index: 1, session_id: 'sess-a1', event_uuid: 'evt-session_end-2', reason: 'unknown field(s): role' },
    ])
  })

  it('echoes ids only when they are strings of at most 256 chars', () => {
    const r = expectRejected({ ...validEvent('session_end'), session_id: 'x'.repeat(257), event_uuid: 7 })
    expect(r.session_id).toBeNull()
    expect(r.event_uuid).toBeNull()
  })
})

describe('parseCaptureEventsRequest — envelope', () => {
  const now = RECEIVED_AT
  it.each([
    ['no events', envelope([])],
    ['501 events', envelope(Array.from({ length: CAPTURE_EVENTS_MAX + 1 }, (_, i) => validEvent('session_start', i)))],
    ['a missing client', { events: [validEvent('session_start')] }],
    ['an extra key dry_run', { ...envelope([validEvent('session_start')]), dry_run: true }],
    ['a bad client name', { client: { name: 'Bad Name', version: '1' }, events: [validEvent('session_start')] }],
    ['a body that is not an object', [validEvent('session_start')]],
  ])('refuses %s', (_label, body) => {
    const result = parseCaptureEventsRequest(body, now)
    expect(result).toEqual({ error: expect.any(String) })
  })

  it('accepts exactly 500 events', () => {
    const events = Array.from({ length: CAPTURE_EVENTS_MAX }, (_, i) => validEvent('session_start', i))
    expect(parseBatch(events).events).toHaveLength(CAPTURE_EVENTS_MAX)
  })
})

describe('parseCaptureEventsRequest — event fields', () => {
  it('rejects an extra event key by name', () => {
    expect(expectRejected({ ...validEvent('user_prompt'), role: 'user' }).reason).toBe('unknown field(s): role')
  })

  it('rejects a missing event field', () => {
    const event: Record<string, unknown> = { ...validEvent('session_start') }
    delete event.plan_dirs
    expect(expectRejected(event).reason).toBe('missing field(s): plan_dirs')
  })

  it('rejects an assistant_turn text of 200,001 chars', () => {
    const r = expectRejected(withPayload('assistant_turn', { text: 'a'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS + 1) }))
    expect(r.reason).toBe('payload.text exceeds 200000 characters')
  })

  it.each([
    ['before 2020', '2019-12-31T23:59:59Z'],
    ['11 minutes after receipt', new Date(RECEIVED_AT.getTime() + 11 * 60_000).toISOString()],
    ['without an offset', '2026-10-05T10:00:00'],
    ['an impossible date', '2026-02-30T10:00:00Z'],
  ])('rejects occurred_at %s', (_label, occurredAt) => {
    expect(expectRejected({ ...validEvent('session_start'), occurred_at: occurredAt }).reason).toMatch(/^occurred_at /)
  })

  it('accepts occurred_at with a numeric offset and 9 minutes after receipt', () => {
    expectValid({ ...validEvent('session_start'), occurred_at: '2026-10-05T14:09:00.123456+02:00' })
  })

  it('rejects a control character in session_id and a bad event_uuid', () => {
    expect(expectRejected({ ...validEvent('session_start'), session_id: 'sess\u0007' }).reason).toMatch(/^session_id /)
    expect(expectRejected({ ...validEvent('session_start'), event_uuid: '-evt' }).reason).toMatch(/^event_uuid /)
  })

  it('rejects an extra project key and an unknown type', () => {
    const event = validEvent('session_start')
    const project = { ...(event.project as Record<string, unknown>), host: 'x' }
    expect(expectRejected({ ...event, project }).reason).toBe('project: unknown field(s): host')
    expect(expectRejected({ ...event, type: 'tool_call' }).reason).toMatch(/^type must be one of /)
  })

  it('rejects an unknown payload key', () => {
    expect(expectRejected(withPayload('session_end', { extra: 1 })).reason).toBe('payload: unknown field(s): extra')
  })

  it('does not echo an unknown key that is not a plain identifier', () => {
    const r = expectRejected(withPayload('session_end', { 'sk-live secret value': 1 }))
    expect(r.reason).toBe('payload: unknown field(s): 1 unprintable')
  })
})

describe('parseCaptureEventsRequest — user_prompt', () => {
  it('accepts a 1,000,001-char text', () => {
    const text = 'p'.repeat(USER_PROMPT_TEXT_MAX_CHARS + 1)
    const { event } = expectValid(withPayload('user_prompt', { text }))
    expect(event.type === 'user_prompt' && event.payload.text.length).toBe(USER_PROMPT_TEXT_MAX_CHARS + 1)
  })

  it('rejects a null transcript_line without an origin', () => {
    const r = expectRejected(withPayload('user_prompt', { transcript_line: null }))
    expect(r.reason).toBe('payload.transcript_line may be null only with an origin')
  })

  it('rejects an origin of an unknown type', () => {
    const r = expectRejected(withPayload('user_prompt', { origin: { type: 'web' } }))
    expect(r.reason).toBe('payload.origin.type must be one of history, legacy')
  })

  it('rejects a history origin whose timestamp_ms differs from occurred_at', () => {
    const origin = { type: 'history', timestamp_ms: OCCURRED_AT_MS + 1, line: 3, paste_missing: false }
    expect(expectRejected(withPayload('user_prompt', { origin })).reason).toMatch(/^payload\.origin\.timestamp_ms /)
  })

  it.each([
    ['history', { type: 'history', timestamp_ms: OCCURRED_AT_MS, line: 3, paste_missing: true }],
    ['legacy', { type: 'legacy', table: 'memory_episodes', id: SAMPLE_LEGACY_ITEM_ID, truncated: false }],
  ])('accepts a %s origin with null cwd and transcript_line', (_label, origin) => {
    const event = { ...withPayload('user_prompt', { origin, transcript_line: null }), cwd: null }
    const { event: parsed } = expectValid(event)
    expect(parsed.payload).toEqual({ text: 'move the ingest worker to a systemd timer', transcript_line: null, origin })
  })

  it('rejects a null cwd without an origin', () => {
    expect(expectRejected({ ...validEvent('user_prompt'), cwd: null }).reason).toMatch(/^cwd /)
  })

  it('accepts truncated: true and rejects truncated: false', () => {
    expectValid(withPayload('user_prompt', { truncated: true }))
    expect(expectRejected(withPayload('user_prompt', { truncated: false })).reason).toBe('payload.truncated may only be true')
  })
})

describe('parseCaptureEventsRequest — user_answer', () => {
  const question = 'Which store should the worker read?'

  it('rejects an answers key naming no question', () => {
    const r = expectRejected(withPayload('user_answer', { answers: { [question]: 'Postgres', 'Other?': 'x' } }))
    expect(r.reason).toBe('payload.answers has a key that names no question')
  })

  it('rejects duplicate question texts', () => {
    const first = (validEvent('user_answer').payload.questions as unknown[])[0]
    const r = expectRejected(withPayload('user_answer', { questions: [first, first] }))
    expect(r.reason).toBe('payload.questions[1].question duplicates an earlier question')
  })

  it('rejects an event with no answer, note or response that is not blank', () => {
    const event = withoutPayloadKey(
      withPayload('user_answer', { answers: { [question]: '  ' }, notes: { [question]: '' } }),
      'response',
    )
    expect(expectRejected(event).reason).toBe('payload has no answer, note or response that is not blank')
  })

  it('accepts empty answers with a response', () => {
    const event = withoutPayloadKey(withPayload('user_answer', { answers: {} }), 'notes')
    expectValid(event)
  })

  it('accepts the 2-char answer ok', () => {
    const event = withoutPayloadKey(withoutPayloadKey(withPayload('user_answer', { answers: { [question]: 'ok' } }), 'notes'), 'response')
    expectValid(event)
  })

  it('accepts a 1,000,000-char response marked truncated', () => {
    const { event } = expectValid(withPayload('user_answer', { response: 'r'.repeat(USER_PROMPT_TEXT_MAX_CHARS), truncated: true }))
    const payload = event.payload as { response: string; truncated?: boolean }
    expect(payload.response).toHaveLength(USER_PROMPT_TEXT_MAX_CHARS)
    expect(payload.truncated).toBe(true)
  })

  it('rejects a response, an answer or a note of 1,000,001 chars', () => {
    const over = 'x'.repeat(USER_PROMPT_TEXT_MAX_CHARS + 1)
    expect(expectRejected(withPayload('user_answer', { response: over })).reason).toBe(
      `payload.response exceeds ${USER_PROMPT_TEXT_MAX_CHARS} characters`,
    )
    expect(expectRejected(withPayload('user_answer', { answers: { [question]: over } })).reason).toBe(
      `payload.answers value 0 exceeds ${USER_PROMPT_TEXT_MAX_CHARS} characters`,
    )
    expect(expectRejected(withPayload('user_answer', { notes: { [question]: over } })).reason).toBe(
      `payload.notes value 0 exceeds ${USER_PROMPT_TEXT_MAX_CHARS} characters`,
    )
  })

  it('accepts an Other answer of 300,000 chars and a note over the free-text cap', () => {
    const answer = 'o'.repeat(300_000)
    const note = 'n'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS + 1)
    const { event } = expectValid(withPayload('user_answer', { answers: { [question]: answer }, notes: { [question]: note } }))
    const payload = event.payload as { answers: Record<string, string>; truncated?: boolean }
    expect(payload.answers[question]).toBe(answer)
    expect(payload).not.toHaveProperty('truncated')
  })

  it('rejects truncated: false', () => {
    expect(expectRejected(withPayload('user_answer', { truncated: false })).reason).toBe('payload.truncated may only be true')
  })

  it('keeps a __proto__ question key as an own answer', () => {
    const questions = [{ question: '__proto__', header: '', options: [], multiSelect: false }]
    const answers = JSON.parse('{"__proto__": "yes"}') as Record<string, unknown>
    const event = withoutPayloadKey(withoutPayloadKey(withPayload('user_answer', { questions, answers }), 'notes'), 'response')
    const { event: parsed } = expectValid(event)
    const payload = parsed.payload as { answers: Record<string, string> }
    expect(Object.hasOwn(payload.answers, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(payload.answers)).toBe(Object.prototype)
  })
})

describe('parseCaptureEventsRequest — ledger, register and candidate rules', () => {
  it('rejects a ledger_decision by mk without a quote', () => {
    const event = withoutPayloadKey(validEvent('ledger_decision'), 'quote')
    expect(expectRejected(event).reason).toBe('payload with by "mk" requires quote and source')
  })

  it('accepts a ledger_decision by the session without a quote or source', () => {
    expectValid(withoutPayloadKey(withoutPayloadKey(withPayload('ledger_decision', { by: 'session' }), 'quote'), 'source'))
  })

  it('rejects candidate_status recorded without register_id', () => {
    const r = expectRejected(withoutPayloadKey(validEvent('candidate_status'), 'register_id'))
    expect(r.reason).toBe('payload.register_id is required when status is recorded')
  })

  it('rejects candidate_status dismissed with a register_id', () => {
    const r = expectRejected(withPayload('candidate_status', { status: 'dismissed' }))
    expect(r.reason).toBe('payload.register_id must be absent when status is dismissed')
  })

  it('accepts candidate_status dismissed without a register_id', () => {
    expectValid(withoutPayloadKey(withPayload('candidate_status', { status: 'dismissed' }), 'register_id'))
  })

  it('rejects register_id plan:/x', () => {
    expect(expectRejected(withPayload('candidate_status', { register_id: 'plan:/x' })).reason).toMatch(/^payload\.register_id /)
  })

  it('accepts a plan ledger decision as register_id', () => {
    expectValid(withPayload('candidate_status', { register_id: 'plan:tst-plan/MK-1a2b3c4d' }))
  })

  it.each(['project:', 'workspace:', 'team:x', 'global '])('rejects register_entry scope %j', (scope) => {
    expect(expectRejected(withPayload('register_entry', { scope })).reason).toMatch(/^payload\.scope /)
  })

  it.each(['global', 'workspace:ws-test'])('accepts register_entry scope %s', (scope) => {
    expectValid(withPayload('register_entry', { scope }))
  })

  it('rejects an upper-case sha and a register id in supersedes that is not one', () => {
    expect(expectRejected(withPayload('git_commit', { sha: 'A'.repeat(40) })).reason).toMatch(/^payload\.sha /)
    expect(expectRejected(withPayload('register_entry', { supersedes: ['TST-1'] })).reason).toMatch(
      /^payload\.supersedes\[0\] /,
    )
  })
})

describe('parseCaptureEventsRequest — reasons never carry values', () => {
  const MARKER = 'ZQXMARKER-9f3e'

  it.each([
    ['an over-long text', withPayload('assistant_turn', { text: `${MARKER} ${'a'.repeat(CAPTURE_FREE_TEXT_MAX_CHARS)}` })],
    ['an unknown type', { ...validEvent('session_start'), type: MARKER }],
    ['a bad sha', withPayload('git_commit', { sha: MARKER })],
    ['an unknown answer key', withPayload('user_answer', { answers: { [MARKER]: 'x' } })],
    ['an unknown payload key', withPayload('session_end', { [MARKER]: 'x' })],
    ['a bad occurred_at', { ...validEvent('session_start'), occurred_at: MARKER }],
    ['a bad register scope', withPayload('register_entry', { scope: `project:${MARKER}\u0001` })],
  ])('omits the marker from the rejection of %s', (_label, event) => {
    const r = expectRejected({ ...event, event_uuid: 'evt-marker' })
    expect(JSON.stringify(r)).not.toContain(MARKER)
  })
})

describe('parseCaptureEventsRequest — text PostgreSQL cannot store', () => {
  const R = '�'

  it.each([
    ['U+0000', 'the worker\u0000 runs', `the worker${R} runs`],
    ['a lone high surrogate', 'abc\ud83d', `abc${R}`],
    ['a lone low surrogate', '\ude00 timer', `${R} timer`],
    ['a valid pair', 'ship it 😀', 'ship it 😀'],
  ])('accepts %s in assistant_turn text and validates the replaced text', (_label, text, stored) => {
    const { event } = expectValid(withPayload('assistant_turn', { text }))
    expect((event.payload as { text: string }).text).toBe(stored)
  })

  it('replaces an unsafe key and its question text alike, so the answer still names its question', () => {
    const question = 'Which store\u0000 should the worker read?'
    const { event } = expectValid(
      withPayload('user_answer', {
        questions: [{ question, header: '', options: [], multiSelect: false }],
        answers: { [question]: 'Postgres' },
        notes: undefined,
      }),
    )
    const payload = event.payload as { questions: Array<{ question: string }>; answers: Record<string, string> }
    expect(payload.questions[0]!.question).toBe(`Which store${R} should the worker read?`)
    expect(payload.answers).toEqual({ [`Which store${R} should the worker read?`]: 'Postgres' })
  })

  it('validates identifiers after the replacement, so U+0000 in session_id is stored as U+FFFD', () => {
    const { event } = expectValid({ ...validEvent('session_start'), session_id: 'sess\u0000a1' })
    expect(event.session_id).toBe(`sess${R}a1`)
  })

  it('rejects two keys that become equal, naming the object and not the key', () => {
    const question = 'ZQXMARKER question?'
    const r = expectRejected(
      withPayload('user_answer', {
        questions: [{ question: `${question}${R}`, header: '', options: [], multiSelect: false }],
        answers: { [`${question}\u0000`]: 'a', [`${question}${R}`]: 'b' },
        notes: undefined,
      }),
    )
    expect(r.reason).toMatch(/^payload\.answers has keys that are equal once/)
    expect(JSON.stringify(r)).not.toContain('ZQXMARKER')
  })

  it('replaces unsafe text in the client version', () => {
    const result = parseCaptureEventsRequest(
      { client: { name: 'sample-client', version: '1.0\u0000' }, events: [validEvent('session_start')] },
      RECEIVED_AT,
    )
    if ('error' in result) throw new Error(result.error)
    expect(result.client.version).toBe(`1.0${R}`)
  })
})

describe('parseCaptureEventsRequest — rules PostgreSQL applies to what capture writes', () => {
  it('rejects a ledger_decision by mk whose source is blank', () => {
    const r = expectRejected(withPayload('ledger_decision', { by: 'mk', quote: 'use a timer', source: ' ' }))
    expect(r.reason).toMatch(/^payload\.source must not be blank/)
  })

  it('accepts an offset of 15:59 and rejects 16:00, which PostgreSQL cannot read', () => {
    expectValid({ ...validEvent('session_start'), occurred_at: '2026-10-05T23:30:00+15:59' })
    expectValid({ ...validEvent('session_start'), occurred_at: '2026-10-04T19:00:00-15:59' })
    expect(expectRejected({ ...validEvent('session_start'), occurred_at: '2026-10-05T23:30:00+16:00' }).reason)
      .toMatch(/^occurred_at /)
  })

  it('rejects a register id over 64 chars, which would overflow the item event key', () => {
    const long = `R-TST-${'1'.repeat(59)}`
    expectValid(withPayload('register_entry', { id: `R-TST-${'1'.repeat(58)}` }))
    expect(expectRejected(withPayload('register_entry', { id: long })).reason).toMatch(/^payload\.id /)
    expect(expectRejected(withPayload('register_entry', { supersedes: [long] })).reason).toMatch(
      /^payload\.supersedes\[0\] /,
    )
  })

  it('rejects a prompt whose kept head of 1,000,000 chars is blank', () => {
    const text = `${' '.repeat(USER_PROMPT_TEXT_MAX_CHARS)}late words`
    // Counts and reasons only: a failed match on the 1,000,010-char event would diff it whole.
    const { events, rejected } = parseBatch([withPayload('user_prompt', { text })])
    expect(events.length).toBe(0)
    expect(rejected.map((r) => r.reason.slice(0, 13))).toEqual(['payload.text '])
  })
})

describe('parseCaptureEventsRequest — nesting bound', () => {
  function nestedUnder(levels: number): FixtureEvent {
    // The event object is level 1 and payload level 2; each array adds one.
    let inner: unknown = []
    for (let i = 3; i < levels; i++) inner = [inner]
    return withPayload('assistant_turn', { extra: inner })
  }

  it('lets an event of 64 levels past the bound, to be judged by the field rules', () => {
    const r = expectRejected(nestedUnder(64))
    expect(r.reason).toBe('payload: unknown field(s): extra')
  })

  it('rejects an event of 65 levels for its depth, naming the path', () => {
    const r = expectRejected(nestedUnder(65))
    expect(r.reason).toMatch(/^payload\.extra(\[0\]){62}: nested deeper than 64 levels$/)
  })

  it('names a key that is not an identifier by its position', () => {
    let inner: unknown = []
    for (let i = 0; i < 70; i++) inner = { 'ZQXMARKER key': inner }
    const r = expectRejected({ ...validEvent('session_start'), payload: inner })
    expect(r.reason).toMatch(/^payload(\[#0\])+: nested deeper than 64 levels$/)
    expect(JSON.stringify(r)).not.toContain('ZQXMARKER')
  })

  it('applies the same bound to the client', () => {
    const at = (levels: number): unknown => {
      let client: unknown = {}
      for (let i = 1; i < levels; i++) client = [client]
      return parseCaptureEventsRequest({ client, events: [validEvent('session_start')] }, RECEIVED_AT)
    }
    expect(at(64)).toEqual({ error: 'client must be an object' })
    expect(at(65)).toEqual({ error: expect.stringMatching(/^client(\[0\]){64}: nested deeper than 64 levels$/) })
  })
})
