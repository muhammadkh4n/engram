import { describe, expect, it } from 'vitest'

import { isRetraction, scanRetractions, splitSentences } from '../../src/extraction/retractions.js'
import { buildWindow, type RawExtractionWindow, type RawWindowTurnRef } from '../../src/extraction/window.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const TURN_ID = uuid(900)

function ref(n: number, over: Partial<RawWindowTurnRef> = {}): RawWindowTurnRef {
  return {
    id: uuid(n),
    class: 'observation',
    kind: 'fact',
    subject_id: uuid(800),
    project_id: 'tst-repo',
    workspace_id: 'tst-ws',
    occurred_at: '2026-10-01T10:00:00Z',
    superseded_by: null,
    retired_at: null,
    forgotten_at: null,
    ...over,
  }
}

/** A trailing assistant turn, which is its own turn-1, with the items its text names. */
function trailing(text: string, refs: RawWindowTurnRef[], observed = false): RawExtractionWindow {
  return {
    anchor: {
      id: TURN_ID,
      kind: 'assistant_turn',
      session_id: 'tst-session-r',
      project_id: 'tst-repo',
      workspace_id: 'tst-ws',
      content: text,
      occurred_at: '2026-10-06T12:00:00Z',
      source: { event_key: 'tst-key-900', tools: [] },
    },
    observed,
    turn_refs: refs,
  }
}

const scan = (raw: RawExtractionWindow) => scanRetractions(buildWindow(raw))

describe('splitSentences', () => {
  it('splits after sentence punctuation followed by whitespace and at line breaks, never inside v1.2', () => {
    expect(splitSentences('The v1.2 cap is stale. It is 50!\nSee the log?  Done')).toEqual([
      'The v1.2 cap is stale.',
      'It is 50!',
      'See the log?',
      'Done',
    ])
  })
})

describe('isRetraction', () => {
  it.each([
    'That figure is out of date.',
    'The listing is outdated.',
    'The cache note is STALE.',
    'It is no longer accurate.',
    'I misread the config.',
    'My earlier claim about the importer and its nightly window was wrong.',
    'My previous answer is incorrect.',
  ])('matches %j', (sentence) => {
    expect(isRetraction(sentence)).toBe(true)
  })

  it.each([
    'The item is not stale.',
    "That note isn't outdated at all.",
    'It was never out of date.',
    'Nothing here is relevant.',
    'My earlier claim was right.',
    `My earlier claim ${'x'.repeat(130)} was wrong.`,
  ])('does not match %j', (sentence) => {
    expect(isRetraction(sentence)).toBe(false)
  })
})

describe('scanRetractions', () => {
  it('links the turn to an item it says was wrong', () => {
    const result = scan(trailing(`My earlier claim in ${uuid(1)} was wrong: the cap is 50.`, [ref(1)]))
    expect(result).toEqual({ retractions: { from: TURN_ID, targets: [uuid(1)], rejected: [] }, unresolved: 0 })
  })

  it('matches ids in any case and names each target once', () => {
    const upper = uuid(1).toUpperCase()
    const result = scan(trailing(`${upper} is stale. So is ${uuid(1)}, which is outdated.`, [ref(1)]))
    expect(result.retractions!.targets).toEqual([uuid(1)])
  })

  it('makes no link when the phrase is negated', () => {
    expect(scan(trailing(`item ${uuid(1)} is not stale`, [ref(1)]))).toEqual({ retractions: null, unresolved: 0 })
  })

  it('counts a retraction whose id names no item as unresolved', () => {
    expect(scan(trailing(`The note ${uuid(2)} is out of date.`, []))).toEqual({ retractions: null, unresolved: 1 })
  })

  it('resolves no forgotten item, no session index and nothing outside the turn scope', () => {
    const result = scan(
      trailing(`${uuid(3)} is stale. ${uuid(4)} is stale. ${uuid(5)} is stale.`, [
        ref(3, { forgotten_at: '2026-10-02T10:00:00Z' }),
        ref(4, { class: 'session_index', kind: 'session' }),
        ref(5, { project_id: 'tst-far', workspace_id: 'tst-far-ws' }),
      ]),
    )
    expect(result).toEqual({ retractions: null, unresolved: 3 })
  })

  it('records a retraction of an item that is no longer current as not_current', () => {
    const result = scan(trailing(`${uuid(6)} is outdated.`, [ref(6, { superseded_by: uuid(7) })]))
    expect(result.retractions).toEqual({
      from: TURN_ID,
      targets: [],
      rejected: [{ target: uuid(6), reason: 'not_current' }],
    })
  })

  it('scans nothing when an earlier run already observed the turn', () => {
    const turn = trailing(`${uuid(1)} is stale.`, [ref(1)]).anchor
    const prompt: RawExtractionWindow = {
      anchor: { ...turn, id: uuid(901), kind: 'user_prompt', content: 'ok', occurred_at: '2026-10-06T12:05:00Z' },
      turn,
      observed: true,
      turn_refs: [ref(1)],
    }
    expect(scan(prompt)).toEqual({ retractions: null, unresolved: 0 })
  })
})
