import { describe, expect, it } from 'vitest'
import { GoldFormatError, parseGold, parseGoldLine } from '../../src/eval/gold.js'

const BASE = {
  id: 'q-001',
  class: 'identifier',
  query: 'which port does the reporting api listen on',
  gold_ids: ['mem-1'],
  gold_phrases: [['port', '3000']],
  stale_ids: [],
  stale_phrases: [],
  current_phrases: [],
  note: 'synthetic',
}

function line(overrides: Record<string, unknown> = {}, drop: string[] = []): string {
  const entry: Record<string, unknown> = { ...BASE, ...overrides }
  for (const key of drop) delete entry[key]
  return JSON.stringify(entry)
}

describe('parseGoldLine', () => {
  it('parses a complete line', () => {
    const entry = parseGoldLine(line({ project_id: 'engram' }), 1)
    expect(entry).toEqual({ ...BASE, project_id: 'engram' })
  })

  it('leaves project_id out when the line has none or null', () => {
    expect(parseGoldLine(line(), 1)).not.toHaveProperty('project_id')
    expect(parseGoldLine(line({ project_id: null }), 1)).not.toHaveProperty('project_id')
  })

  it('accepts a line whose gold is phrases only or ids only', () => {
    expect(parseGoldLine(line({ gold_ids: [] }), 1).gold_phrases).toEqual([['port', '3000']])
    expect(parseGoldLine(line({ gold_phrases: [] }), 1).gold_ids).toEqual(['mem-1'])
  })

  it.each([
    ['not json', '{id:', /line 7: not valid JSON/],
    ['an array', '[]', /line 7: expected a JSON object/],
    ['a missing id', line({}, ['id']), /line 7: id must be a non-empty string/],
    ['an unknown class', line({ class: 'fuzzy' }), /line 7: class must be one of identifier, current, recall, project/],
    ['an empty query', line({ query: '  ' }), /line 7: query must be a non-empty string/],
    ['a numeric project_id', line({ project_id: 4 }), /line 7: project_id must be a non-empty string/],
    ['a missing stale_ids', line({}, ['stale_ids']), /line 7: stale_ids must be an array of non-empty strings/],
    ['a flat phrase list', line({ gold_phrases: ['port'] }), /line 7: gold_phrases\[0\] must be a non-empty array of non-empty strings/],
    ['an empty phrase group', line({ current_phrases: [[]] }), /line 7: current_phrases\[0\] must be a non-empty array/],
    ['a blank phrase', line({ stale_phrases: [['old', ' ']] }), /line 7: stale_phrases\[0\] must be a non-empty array of non-empty strings/],
    ['a missing note', line({}, ['note']), /line 7: note must be a string/],
    ['an unknown key', line({ gold_id: ['x'] }), /line 7: unknown field gold_id/],
    ['no gold at all', line({ gold_ids: [], gold_phrases: [] }), /line 7: needs at least one gold_ids entry or gold_phrases group/],
  ])('rejects %s with the line number', (_name, text, message) => {
    expect(() => parseGoldLine(text, 7)).toThrow(GoldFormatError)
    expect(() => parseGoldLine(text, 7)).toThrow(message)
  })
})

describe('parseGold', () => {
  it('skips blank lines and keeps file order', () => {
    const text = `${line({ id: 'a' })}\n\n${line({ id: 'b' })}\n`
    expect(parseGold(text).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('reports the file line number of a malformed line', () => {
    const text = `${line({ id: 'a' })}\n\n${line({ id: 'b', class: 'x' })}`
    expect(() => parseGold(text)).toThrow(/line 3: class/)
  })

  it('rejects duplicate ids', () => {
    const text = `${line({ id: 'a' })}\n${line({ id: 'a' })}`
    expect(() => parseGold(text)).toThrow(/line 2: duplicate id a \(first on line 1\)/)
  })

  it('rejects an empty gold set', () => {
    expect(() => parseGold('\n  \n')).toThrow(/no gold lines/)
  })
})
