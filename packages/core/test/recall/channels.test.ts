import { describe, expect, it } from 'vitest'
import { ITEM_KINDS } from '../../src/items/types.js'
import {
  DEFAULT_RECALL_CLASSES,
  HISTORY_KINDS,
  PROMPT_OBSERVATION_MAX_TRUST,
  effectiveFilters,
  type EffectiveFilters,
} from '../../src/recall/channels.js'

function ok(result: ReturnType<typeof effectiveFilters>): EffectiveFilters {
  if ('error' in result) throw new Error(result.error)
  return result
}

describe('effectiveFilters', () => {
  it('searches the five default classes without history kinds', () => {
    const f = ok(effectiveFilters({ channel: 'mcp' }))
    expect(f.classes).toEqual([...DEFAULT_RECALL_CLASSES])
    for (const kind of HISTORY_KINDS) expect(f.kinds).not.toContain(kind)
    expect(f.kinds).toContain('user_prompt')
    expect(f.kinds).toContain('ruling_entry')
    expect(f.maxObservationTrust).toBeUndefined()
  })

  it('adds the history kinds and session_index with include_history', () => {
    const f = ok(effectiveFilters({ channel: 'mcp', includeHistory: true }))
    expect(f.classes).toEqual([...DEFAULT_RECALL_CLASSES, 'session_index'])
    for (const kind of HISTORY_KINDS) expect(f.kinds).toContain(kind)
  })

  it('adds legacy only when named', () => {
    expect(ok(effectiveFilters({ channel: 'mcp' })).classes).not.toContain('legacy')
    const f = ok(effectiveFilters({ channel: 'mcp', classes: ['legacy', 'mk_statement'] }))
    expect(f.classes).toEqual(['legacy', 'mk_statement'])
    expect(f.kinds).toEqual([...ITEM_KINDS.legacy, ...ITEM_KINDS.mk_statement])
  })

  it('refuses a history class or kind without include_history', () => {
    expect(effectiveFilters({ channel: 'mcp', classes: ['session_index'] })).toEqual({
      error: 'class session_index is history: set include_history',
    })
    expect(effectiveFilters({ channel: 'mcp', kinds: ['commit'] })).toEqual({ error: 'kind commit is history: set include_history' })
    expect(ok(effectiveFilters({ channel: 'mcp', kinds: ['commit'], includeHistory: true })).kinds).toEqual(['commit'])
  })

  it('on prompt, drops observations with the switch off and caps them at trust 2 with it on', () => {
    const off = ok(effectiveFilters({ channel: 'prompt' }, null))
    expect(off.classes).not.toContain('observation')
    expect(off.maxObservationTrust).toBeUndefined()
    const on = ok(effectiveFilters({ channel: 'prompt' }, 2))
    expect(on.classes).toContain('observation')
    expect(on.maxObservationTrust).toBe(2)
  })

  it('refuses prompt with only observations while the switch is off', () => {
    expect(effectiveFilters({ channel: 'prompt', classes: ['observation'] }, null)).toEqual({
      error: 'the prompt channel shows no observations',
    })
    expect(ok(effectiveFilters({ channel: 'prompt', classes: ['observation', 'mk_statement'] }, null)).classes).toEqual([
      'mk_statement',
    ])
  })

  it('takes observations of any trust on every other channel', () => {
    for (const channel of ['agent_dispatch', 'executor_start', 'hand_recall', 'session_start', 'mcp', 'replay', 'calibration'] as const) {
      const f = ok(effectiveFilters({ channel }, null))
      expect(f.classes).toContain('observation')
      expect(f.maxObservationTrust).toBeUndefined()
    }
  })

  it('admits verified observations on prompt: the switch is at 2', () => {
    expect(PROMPT_OBSERVATION_MAX_TRUST).toBe(2)
    expect(ok(effectiveFilters({ channel: 'prompt' })).maxObservationTrust).toBe(2)
  })

  it('applies a kind to every class that has it, as one flat list', () => {
    const f = ok(effectiveFilters({ channel: 'mcp', kinds: ['fact'] }))
    expect(f.classes).toEqual([...DEFAULT_RECALL_CLASSES])
    expect(f.kinds).toEqual(['fact'])
  })

  it('refuses a kind that no class searched has', () => {
    expect(effectiveFilters({ channel: 'mcp', classes: ['mk_statement'], kinds: ['note'] })).toEqual({
      error: 'kind note belongs to none of the classes searched',
    })
    expect(effectiveFilters({ channel: 'prompt', kinds: ['procedure'] }, null)).toEqual({
      error: 'kind procedure belongs to none of the classes searched',
    })
  })

  it('refuses empty and repeated filters', () => {
    expect(effectiveFilters({ channel: 'mcp', classes: [] })).toEqual({ error: 'classes must name at least one class' })
    expect(effectiveFilters({ channel: 'mcp', classes: ['utterance', 'utterance'] })).toEqual({ error: 'classes names a class twice' })
    expect(effectiveFilters({ channel: 'mcp', kinds: [] })).toEqual({ error: 'kinds must name at least one kind' })
    expect(effectiveFilters({ channel: 'mcp', kinds: ['note', 'note'] })).toEqual({ error: 'kinds names a kind twice' })
  })
})
