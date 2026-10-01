/**
 * Caller text interpolated into a PostgREST `.or()` logic tree must be a
 * double-quoted operand: outside quotes `,` `(` `)` split the filter and a
 * backslash escapes nothing, so text with a comma answered 400 PGRST100.
 */
import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { orIlikeOperand, orOperand } from '../src/search.js'
import { PostgRestSemanticStorage } from '../src/semantic.js'
import { PostgRestProceduralStorage } from '../src/procedural.js'

type Call = [method: string, ...args: unknown[]]

function recordingClient(): { client: PostgrestClient; calls: Call[] } {
  const calls: Call[] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'or', 'is', 'ilike', 'eq', 'gte', 'lte', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve, reject)
  const client = {
    from: (table: string) => {
      calls.push(['from', table])
      return builder
    },
    rpc: () => {
      throw new Error('text path must not call an RPC')
    },
  }
  return { client: client as unknown as PostgrestClient, calls }
}

function orArgs(calls: Call[]): unknown[] {
  return calls.filter(([m]) => m === 'or').map(([, arg]) => arg)
}

describe('orOperand', () => {
  it('wraps plain text in double quotes', () => {
    expect(orOperand('deploy on fridays')).toBe('"deploy on fridays"')
  })

  it('leaves commas, parentheses and dots unescaped inside the quotes', () => {
    expect(orOperand('lint, then tests (always).')).toBe('"lint, then tests (always)."')
  })

  it('escapes a double quote', () => {
    expect(orOperand('use "strict" mode')).toBe('"use \\"strict\\" mode"')
  })

  it('escapes a backslash', () => {
    expect(orOperand('C:\\temp')).toBe('"C:\\\\temp"')
  })

  it('leaves % and _ alone, since eq is not a LIKE', () => {
    expect(orOperand('100%_done')).toBe('"100%_done"')
  })
})

describe('orIlikeOperand', () => {
  it('wraps the text in %…% and quotes it', () => {
    expect(orIlikeOperand('deploy')).toBe('"%deploy%"')
  })

  it('keeps a comma, parentheses and a dot literal inside the quotes', () => {
    expect(orIlikeOperand('a, (b).')).toBe('"%a, (b).%"')
  })

  it('escapes % and _ for LIKE, then quotes the escape backslash', () => {
    expect(orIlikeOperand('100%_done')).toBe('"%100\\\\%\\\\_done%"')
  })

  it('escapes a backslash for LIKE and again for the logic tree', () => {
    expect(orIlikeOperand('a\\b')).toBe('"%a\\\\\\\\b%"')
  })

  it('escapes a double quote for the logic tree only', () => {
    expect(orIlikeOperand('"x"')).toBe('"%\\"x\\"%"')
  })
})

describe('.or() call sites quote caller text', () => {
  const text = 'Run lint, then tests (always) "strict" 100%_done \\ ok.'

  it('procedural.search text path emits quoted ilike operands', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestProceduralStorage(client).search(text, { limit: 3 })

    const operand = orIlikeOperand(text)
    expect(orArgs(calls)).toEqual([`trigger_text.ilike.${operand},procedure.ilike.${operand}`])
  })

  it('procedural.search with only a comma keeps the comma inside quotes', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestProceduralStorage(client).search(',', { limit: 3 })

    expect(orArgs(calls)).toEqual(['trigger_text.ilike."%,%",procedure.ilike."%,%"'])
  })

  it('semantic.getTopicTimeline emits quoted eq and ilike operands', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestSemanticStorage(client).getTopicTimeline('deploy, rollback')

    expect(orArgs(calls)).toEqual(['topic.eq."deploy, rollback",topic.ilike."%deploy, rollback%"'])
  })
})
