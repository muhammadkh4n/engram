import { describe, expect, it } from 'vitest'
import { cutAtSentence, cutQuestion, Packer, type PackOptions } from '../../src/recall/pack.js'
import type { ResolvedItem } from '../../src/recall/resolve.js'
import type { RecallItem, RecallItemRow } from '../../src/recall/types.js'

const T0 = new Date('2026-02-03T04:00:00Z')

function entry(id: string, text: string, overrides: { row?: Partial<RecallItemRow>; item?: Partial<RecallItem> } = {}): ResolvedItem {
  const row: RecallItemRow = {
    id,
    class: 'document_section',
    kind: 'note',
    speaker: 'artifact',
    trust: 1,
    projectId: null,
    workspaceId: null,
    planSlug: null,
    sessionId: null,
    subjectLabel: null,
    contentHead: text,
    contentLength: [...text].length,
    question: null,
    searchHead: text,
    occurredAt: T0,
    supersededBy: null,
    retired: false,
    restated: 0,
    source: { type: 'vault' },
    requested: true,
    currentId: id,
    chain: 'current',
    endExcluded: false,
    ...overrides.row,
  }
  const item: RecallItem = {
    id,
    class: row.class,
    kind: row.kind,
    speaker: row.speaker,
    trust: row.trust,
    occurredAt: T0,
    projectId: null,
    text,
    source: { type: 'vault', ref: 'Tst/Note.md' },
    status: 'current',
    flags: [],
    via: 'query',
    ...overrides.item,
  }
  return { row, item }
}

const opts = (o: Partial<PackOptions> = {}): PackOptions => ({ limit: 12, maxChars: 1500, budgetChars: 9000, ...o })

describe('cutAtSentence', () => {
  it('keeps text that fits whole and uncut', () => {
    expect(cutAtSentence('One. Two.', 20)).toEqual({ text: 'One. Two.', cut: false })
  })

  it('cuts at the last sentence end at or before the limit', () => {
    expect(cutAtSentence('First one. Second one! Third one? Fourth one.', 34)).toEqual({ text: 'First one. Second one! Third one?', cut: true })
  })

  it('cuts at a newline, without the newline', () => {
    expect(cutAtSentence('A heading line\nthen a long body that runs on and on', 20)).toEqual({ text: 'A heading line', cut: true })
  })

  it('never cuts inside a straight or curly quote', () => {
    expect(cutAtSentence('He said. "Stop. Go now. Then wait." And more text here.', 30)).toEqual({ text: 'He said.', cut: true })
    expect(cutAtSentence('He said. “Stop. Go now. Then wait.” And more text here.', 30)).toEqual({ text: 'He said.', cut: true })
  })

  it('needs whitespace after the mark, so a version number or path is no boundary', () => {
    expect(cutAtSentence('Use v1.2.3 and src/a.ts in the build always', 20)).toEqual({ text: 'Use v1.2.3 and src/a.ts in the build always', cut: false })
  })

  it('returns the text whole and uncut when no boundary lies outside a quote', () => {
    const text = '"One. Two. Three. Four. Five." and on'
    expect(cutAtSentence(text, 20)).toEqual({ text, cut: false })
  })
})

describe('cutQuestion', () => {
  it('keeps a question of 600 characters or fewer whole', () => {
    const q = 'x'.repeat(600)
    expect(cutQuestion(q)).toBe(q)
  })

  it('keeps the tail from the first boundary that leaves at most 600', () => {
    const q = `${'a'.repeat(300)}. ${'b'.repeat(300)}. ${'c'.repeat(200)}?`
    expect(cutQuestion(q)).toBe(`${'b'.repeat(300)}. ${'c'.repeat(200)}?`)
  })

  it('keeps the last 600 characters when no boundary leaves at most 600', () => {
    const q = 'y'.repeat(900)
    expect(cutQuestion(q)).toBe('y'.repeat(600))
  })
})

describe('Packer', () => {
  it('cuts long text at a sentence and flags it cut, keeping flags sorted', () => {
    const p = new Packer(opts({ maxChars: 200 }))
    const text = `${'Word '.repeat(30).trim()}. ${'More '.repeat(40).trim()}.`
    p.addQuery([entry('a', text, { item: { flags: ['verify_live', 'as_of:2026-02-03'] } })])
    const { items } = p.result()
    expect(items[0]!.text).toBe(`${'Word '.repeat(30).trim()}.`)
    expect(items[0]!.flags).toEqual(['as_of:2026-02-03', 'cut', 'verify_live'])
  })

  it('shows an MK statement, register entry or plan decision whole when it fits, else counts it uncuttable', () => {
    const long = `${'Said this. '.repeat(30)}`.trim()
    const p = new Packer(opts({ maxChars: 200, budgetChars: 1000 }))
    p.addQuery([
      entry('s', long, { row: { class: 'mk_statement', kind: 'ruling' } }),
      entry('r', long, { row: { class: 'artifact', kind: 'ruling_entry' } }),
      entry('d', long, { row: { class: 'artifact', kind: 'ledger_decision' } }),
      entry('big', 'z'.repeat(1200), { row: { class: 'mk_statement', kind: 'fact' } }),
    ])
    const { items, omitted } = p.result()
    expect(items.map((i) => [i.id, i.text.length, i.flags.includes('cut')])).toEqual([
      ['s', long.length, false],
      ['r', long.length, false],
      ['d', long.length, false],
    ])
    expect(omitted).toEqual({ limit: 0, budget: 0, uncuttable: 1 })
  })

  it('counts an uncuttable text whose content is longer than the head read as uncuttable', () => {
    const p = new Packer(opts({ maxChars: 200 }))
    p.addQuery([entry('s', 'q'.repeat(300), { row: { class: 'mk_statement', kind: 'fact', contentLength: 20000 } })])
    expect(p.result()).toMatchObject({ items: [], omitted: { uncuttable: 1 } })
  })

  it('counts content length in code points, so astral characters do not pass as a whole text', () => {
    const head = '\u{1F600}'.repeat(150)
    const p = new Packer(opts({ maxChars: 200 }))
    p.addQuery([entry('e', head, { row: { class: 'mk_statement', kind: 'fact', contentLength: 151 } })])
    expect(p.result().omitted.uncuttable).toBe(1)
  })

  it('skips an item that would pass the budget and packs the next', () => {
    const p = new Packer(opts({ budgetChars: 1000 }))
    p.addQuery([entry('a', 'a'.repeat(600)), entry('b', 'b'.repeat(500)), entry('c', 'c'.repeat(400))])
    const { items, omitted, totalChars } = p.result()
    expect(items.map((i) => i.id)).toEqual(['a', 'c'])
    expect(omitted).toEqual({ limit: 0, budget: 1, uncuttable: 0 })
    expect(totalChars).toBe(1000)
  })

  it('counts the question in the budget and keeps its tail', () => {
    const question = `${'a'.repeat(300)}. ${'b'.repeat(500)}?`
    const p = new Packer(opts({ budgetChars: 1000 }))
    p.addQuery([entry('s', 'x'.repeat(400), { row: { class: 'mk_statement', kind: 'fact' }, item: { question } })])
    const { items, totalChars } = p.result()
    expect(items[0]!.question).toBe(`${'b'.repeat(500)}?`)
    expect(totalChars).toBe(400 + 501)
  })

  it('keeps associations together within 30% of the budget', () => {
    const p = new Packer(opts({ budgetChars: 1000 }))
    p.addQuery([entry('q', 'q'.repeat(100))])
    p.addAssociations([
      entry('a1', 'a'.repeat(200), { item: { via: 'association' } }),
      entry('a2', 'b'.repeat(150), { item: { via: 'association' } }),
      entry('a3', 'c'.repeat(100), { item: { via: 'association' } }),
    ])
    const { items, omitted } = p.result()
    expect(items.map((i) => i.id)).toEqual(['q', 'a1', 'a3'])
    expect(omitted.budget).toBe(1)
  })

  it('counts every item past the limit, query and association alike', () => {
    const p = new Packer(opts({ limit: 2 }))
    p.addQuery([entry('a', 'a'), entry('b', 'b'), entry('c', 'c')])
    expect(p.hasRoomForAssociations()).toBe(false)
    p.addAssociations([entry('d', 'd', { item: { via: 'association' } })])
    expect(p.result().omitted).toEqual({ limit: 2, budget: 0, uncuttable: 0 })
  })

  it('names the first three shown query items as seeds', () => {
    const p = new Packer(opts({ budgetChars: 1000 }))
    p.addQuery([entry('a', 'a'), entry('too-big', 'x'.repeat(2000)), entry('b', 'b'), entry('c', 'c'), entry('d', 'd')])
    expect(p.seeds(3)).toEqual(['a', 'b', 'c'])
  })

  it('lists item keys in contract order and leaves absent optional fields out', () => {
    const p = new Packer(opts())
    p.addQuery([
      entry('a', 'text', { item: { flags: [], supersededBy: 'n', status: 'superseded', question: 'q?', subject: 'tst', sessionId: 'tst-session' } }),
      entry('b', 'text'),
    ])
    const [a, b] = p.result().items
    expect(Object.keys(a!)).toEqual([
      'id', 'class', 'kind', 'speaker', 'trust', 'occurredAt', 'projectId', 'sessionId', 'subject', 'text', 'question',
      'source', 'status', 'supersededBy', 'flags', 'via',
    ])
    expect(Object.keys(b!)).toEqual(['id', 'class', 'kind', 'speaker', 'trust', 'occurredAt', 'projectId', 'text', 'source', 'status', 'flags', 'via'])
  })

  it('never packs more than the budget, over random item sizes', () => {
    let seed = 20260203
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 300; round += 1) {
      const budgetChars = 1000 + Math.floor(next() * 11001)
      const maxChars = 200 + Math.floor(next() * 3801)
      const p = new Packer({ limit: 1 + Math.floor(next() * 30), maxChars, budgetChars })
      const make = (prefix: string, n: number, via: 'query' | 'association') =>
        Array.from({ length: n }, (_, i) => {
          const sentences = 1 + Math.floor(next() * 40)
          const text = Array.from({ length: sentences }, () => `${'w'.repeat(1 + Math.floor(next() * 200))}.`).join(' ')
          const statement = next() < 0.2
          const question = next() < 0.2 ? 'q'.repeat(Math.floor(next() * 1500)) : undefined
          return entry(`${prefix}${i}`, text, {
            row: statement ? { class: 'mk_statement', kind: 'fact' } : {},
            item: { via, ...(question !== undefined ? { question } : {}) },
          })
        })
      p.addQuery(make('q', Math.floor(next() * 30), 'query'))
      p.addAssociations(make('a', Math.floor(next() * 10), 'association'))
      const { items, totalChars } = p.result()
      const counted = items.reduce((n, i) => n + i.text.length + (i.question?.length ?? 0), 0)
      expect(counted).toBe(totalChars)
      expect(totalChars).toBeLessThanOrEqual(budgetChars)
      const associated = items.filter((i) => i.via === 'association').reduce((n, i) => n + i.text.length + (i.question?.length ?? 0), 0)
      expect(associated).toBeLessThanOrEqual(Math.floor(budgetChars * 0.3))
      for (const i of items) if (i.flags.includes('cut')) expect(i.text.length).toBeLessThanOrEqual(maxChars)
    }
  })
})
