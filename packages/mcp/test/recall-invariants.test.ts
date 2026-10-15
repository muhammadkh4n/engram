import { describe, expect, it, vi } from 'vitest'
import type { RecallItemState } from '@engram-mem/core'
import { parseArgs, runInvariants, type InvariantsIo } from '../src/recall-invariants-cli.js'

const T = (minute: number) => new Date(Date.parse('2026-02-03T04:00:00Z') + minute * 60_000)

interface LineOpts {
  minute?: number
  items?: string[]
  includeHistory?: boolean
  requestFp?: string
  outputFp?: string
  storeVersion?: [number, number]
  degraded?: string[]
  totalChars?: number
  budgetChars?: number
}

function line(o: LineOpts = {}): string {
  return JSON.stringify({
    v: 2,
    ts: T(o.minute ?? 10).toISOString(),
    channel: 'mcp',
    request_fp: o.requestFp ?? 'fp-a',
    query: 'tst secret query text',
    include_history: o.includeHistory ?? false,
    budget_chars: o.budgetChars ?? 9000,
    store_version: o.storeVersion ?? [5, 5],
    items: (o.items ?? []).map((id, i) => ({ id, rank: i + 1, via: 'query', status: 'current', chars: 10 })),
    total_chars: o.totalChars ?? 100,
    degraded: o.degraded ?? [],
    output_fp: o.outputFp ?? 'out-1',
  })
}

function io(files: Record<string, string>, states: RecallItemState[] = []) {
  const out: string[] = []
  const err: string[] = []
  const itemStates = vi.fn(async (ids: readonly string[]) => states.filter((s) => ids.includes(s.id)))
  const value: InvariantsIo = {
    readText: async (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`)
      return files[path]!
    },
    store: () => ({ itemStates }),
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  }
  return { io: value, out, err, itemStates }
}

describe('engram-recall-invariants', () => {
  it('counts nothing and exits 0 on a clean log, skipping lines that are not v2', async () => {
    const t = io({ 'a.jsonl': [line({ items: ['i1'] }), '{"v":1,"query":"old"}', 'not json', ''].join('\n') })
    expect(await runInvariants(['--log', 'a.jsonl'], t.io)).toBe(0)
    const counts = JSON.parse(t.out.join(''))
    expect(counts).toEqual({
      forgotten_or_retired_shown: { count: 0, lines: [] },
      over_budget: { count: 0, lines: [] },
      nondeterministic_pairs: { count: 0, lines: [] },
      lines_read: 1,
    })
  })

  it('counts an item shown after it was forgotten, or retired without history, and not one forgotten later', async () => {
    const states: RecallItemState[] = [
      { id: 'forgotten', forgottenAt: T(5), retiredAt: null },
      { id: 'retired', forgottenAt: null, retiredAt: T(5) },
      { id: 'later', forgottenAt: T(50), retiredAt: T(50) },
    ]
    const log = [
      line({ items: ['forgotten', 'later'] }),
      line({ items: ['retired'] }),
      line({ items: ['retired'], includeHistory: true }),
    ].join('\n')
    const t = io({ 'a.jsonl': log }, states)
    expect(await runInvariants(['--log', 'a.jsonl'], t.io)).toBe(1)
    expect(JSON.parse(t.out.join('')).forgotten_or_retired_shown).toEqual({ count: 2, lines: ['a.jsonl:1', 'a.jsonl:2'] })
  })

  it('counts a line over its budget', async () => {
    const t = io({ 'a.jsonl': [line({ totalChars: 9001 }), line({ totalChars: 9000 })].join('\n') })
    expect(await runInvariants(['--log', 'a.jsonl'], t.io)).toBe(1)
    expect(JSON.parse(t.out.join('')).over_budget).toEqual({ count: 1, lines: ['a.jsonl:1'] })
  })

  it('counts one request on one unchanged store with two outputs, across files, and not one the store changed under', async () => {
    const t = io({
      'a.jsonl': [
        line({ outputFp: 'out-1' }),
        line({ requestFp: 'fp-b', storeVersion: [5, 6], outputFp: 'out-1' }),
        line({ requestFp: 'fp-c', degraded: ['rerank'], outputFp: 'out-1' }),
        line({ requestFp: 'fp-d', storeVersion: [5, 5], outputFp: 'out-1' }),
      ].join('\n'),
      'b.jsonl': [
        line({ outputFp: 'out-2' }),
        line({ requestFp: 'fp-b', storeVersion: [5, 6], outputFp: 'out-2' }),
        line({ requestFp: 'fp-c', degraded: ['rerank'], outputFp: 'out-2' }),
        line({ requestFp: 'fp-d', storeVersion: [7, 7], outputFp: 'out-2' }),
      ].join('\n'),
    })
    expect(await runInvariants(['--log', 'a.jsonl', '--log', 'b.jsonl'], t.io)).toBe(1)
    expect(JSON.parse(t.out.join('')).nondeterministic_pairs).toEqual({ count: 1, lines: ['a.jsonl:1', 'b.jsonl:1'] })
  })

  it('prints no query text', async () => {
    const t = io({ 'a.jsonl': line({ totalChars: 9001 }) })
    await runInvariants(['--log', 'a.jsonl'], t.io)
    expect(t.out.join('')).not.toContain('tst secret query text')
  })

  it('reads item states in batches of 500', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `item-${i}`)
    const t = io({ 'a.jsonl': line({ items: ids }) })
    await runInvariants(['--log', 'a.jsonl'], t.io)
    expect(t.itemStates.mock.calls.map((c) => c[0].length)).toEqual([500, 500, 201])
  })

  it('exits 2 on a usage error or an unreadable log', async () => {
    expect(parseArgs([])).toEqual({ error: 'name at least one --log <file>' })
    expect(parseArgs(['--log'])).toEqual({ error: 'unexpected argument: --log' })
    const t = io({})
    expect(await runInvariants(['--log', 'missing.jsonl'], t.io)).toBe(2)
    expect(t.err.join('')).toContain('missing.jsonl')
  })
})
