import { describe, it, expect } from 'vitest'
import { renderRecallPayload } from '../../src/retrieval/engine.js'
import {
  assemble,
  degradedRecallNotice,
  recallOutputPolicyFromEnv,
  resolveRecallOutputPolicy,
  vectorUnavailableNotice,
  capItemChars,
  capItemText,
  itemContentStart,
  CUT_BOUNDARY_WINDOW,
  DEFAULT_RECALL_OUTPUT_POLICY,
  MIN_CUT_CONTENT_CHARS,
  MIN_RECALL_TOKEN_BUDGET,
  MIN_SECTION_ROOM_CHARS,
  DEFAULT_RELATED_SHARE,
  ITEM_CUT_MARKER,
  PAYLOAD_HEADER_LINES,
  PAYLOAD_SECTION_HEADERS,
  type AssembledPayload,
  type RecallOutputPolicy,
  type RenderedItem,
  type RenderedPayload,
} from '../../src/retrieval/output-policy.js'
import { estimateTokens } from '../../src/utils/tokens.js'
import type { RetrievedMemory } from '../../src/types.js'
import type { CompositeMemory } from '../../src/retrieval/spreading-activation.js'

function mem(
  id: string,
  type: RetrievedMemory['type'],
  content: string,
  metadata: Record<string, unknown> = {},
  source: RetrievedMemory['source'] = 'recall',
): RetrievedMemory {
  return { id, type, content, relevance: 0.5, source, metadata }
}

const MEMORIES: RetrievedMemory[] = [
  mem('m1', 'episode', 'We moved the deploy window to Thursday after the pgvector reindex.', {
    role: 'user',
    createdAt: '2026-03-04T10:00:00Z',
    rawContent: [{ type: 'text', text: 'Node: Rexbox (laptop) via WhatsApp gateway' }],
  }),
  mem('m2', 'semantic', 'The staging database runs Postgres 16 with pgvector 0.8.'),
  mem('m3', 'digest', 'Session summary: reranker latency investigation, three candidate models.', {
    occurredAt: '2025-12-30T08:15:00Z',
  }),
]

const ASSOCIATIONS: RetrievedMemory[] = [
  mem('a1', 'procedural', 'Run the migration dry-run before every schema change.', {}, 'association'),
  mem('a2', 'episode', 'The Thursday deploy needs a fresh backup first.', { role: 'assistant' }, 'association'),
]

const COMMUNITIES = ['Deploy pipeline: windows, backups, migrations', 'Postgres tuning and extensions']

const CONTEXT: CompositeMemory = {
  coreMemories: [],
  speakers: [{ name: 'MK', role: 'user' }, { name: 'Rex', role: 'assistant' }],
  emotionalContext: [{ label: 'urgent', intensity: 0.8 }],
  dominantIntent: 'INFORMATIONAL',
  temporalContext: [{ session: 'session-7', timeOfDay: 'morning', date: '2026-03-04' }],
  relatedTopics: ['rexvps', 'pgvector'],
  faintAssociations: [
    mem('f1', 'episode', 'Someone mentioned a Friday freeze once.', {}, 'association'),
    mem('f2', 'semantic', 'Backups are kept for 14 days.', {}, 'association'),
  ],
}

// Physical lines of the five-section payload as rendered before the output
// policy existed; every default-policy assembly must reproduce them exactly.
const GOLDEN = [
  '## Engram — Recalled Conversation Memory',
  '',
  'IMPORTANT: The following are memories retrieved from past conversations. If the answer to the user\'s question is found below, USE IT directly. Do not say "I don\'t have this information" if it appears here.',
  'Context tags (type, role, device, date) are for your reference — do not include them in responses unless the user asks about when/where/who.',
  '',
  '### Recalled Memories',
  '',
  '- [episode · user · Rexbox/WhatsApp · 2026-03-04] We moved the deploy window to Thursday after the pgvector reindex.',
  '- [semantic] The staging database runs Postgres 16 with pgvector 0.8.',
  '- [digest · 2025-12-30] Session summary: reranker latency investigation, three candidate models.',
  '',
  '### Related Memories',
  '',
  '- [procedural] Run the migration dry-run before every schema change.',
  '- [episode · assistant] The Thursday deploy needs a fresh backup first.',
  '',
  '### Knowledge Domain Context',
  '',
  '- Deploy pipeline: windows, backups, migrations',
  '- Postgres tuning and extensions',
  '',
  '### Context',
  '',
  '- Speakers: MK, Rex',
  '- Tone: urgent',
  '- Related topics: rexvps, pgvector',
  '- Time: morning, session-7',
  '',
  '### Faint Associations',
  '',
  '- [episode] Someone mentioned a Friday freeze once.',
  '- [semantic] Backups are kept for 14 days.',
].join('\n')

const RENDERED = renderRecallPayload(MEMORIES, ASSOCIATIONS, CONTEXT, COMMUNITIES)
const HEADER = PAYLOAD_HEADER_LINES.join('\n')

// An item cap no test item reaches, for tests about whole-item fitting.
const UNCAPPED = 10_000

function rendered(partial: Partial<Record<keyof RenderedPayload, RenderedItem[]>>): RenderedPayload {
  return { recalled: [], related: [], domain: [], context: [], faint: [], ...partial }
}

function item(id: string, length: number): RenderedItem {
  return { id, text: `- [episode] ${id} ${'x'.repeat(length)}` }
}

function expectItemsIndexText(result: AssembledPayload, source: RenderedPayload): void {
  for (const it of result.payload.items) {
    const match = source[it.section].find((r) => r.text === result.text.slice(it.start, it.end))
    expect(match, `${it.section} item at ${it.start}`).toBeDefined()
    expect(match?.id).toBe(it.id)
  }
}

describe('assemble — byte identity', () => {
  it('reproduces the unbounded five-section payload with no policy', () => {
    const result = assemble(RENDERED)

    expect(result.text).toBe(GOLDEN)
    expect(result.payload).toMatchObject({
      emittedMemories: 3,
      emittedAssociations: 2,
      emittedFaint: 2,
      truncated: false,
    })
    expect(result.payload.items.map((i) => i.section)).toEqual([
      'recalled', 'recalled', 'recalled', 'related', 'related',
      'domain', 'domain', 'context', 'context', 'context', 'context', 'faint', 'faint',
    ])
    expect(result.payload.items.filter((i) => i.id !== undefined).map((i) => i.id)).toEqual([
      'm1', 'm2', 'm3', 'a1', 'a2', 'f1', 'f2',
    ])
    expectItemsIndexText(result, RENDERED)
  })

  it('renders nothing when there are no memories and no associations', () => {
    const result = assemble(renderRecallPayload([], [], CONTEXT, COMMUNITIES))

    expect(result.text).toBe('')
    expect(result.payload.items).toEqual([])
  })

  it('omits the Context heading when graph context has no lines', () => {
    const quiet = { ...CONTEXT, speakers: [], emotionalContext: [], relatedTopics: [], temporalContext: [] }
    const result = assemble(renderRecallPayload(MEMORIES, [], quiet))

    expect(result.text).not.toContain('### Context')
    expect(result.text).not.toContain('### Related Memories')
    expect(result.text).toContain('### Faint Associations')
  })
})

describe('assemble — notice line', () => {
  const NOTICE = vectorUnavailableNotice('429 insufficient_quota')

  it('reproduces the golden payload when no notice is given', () => {
    expect(assemble(RENDERED, DEFAULT_RECALL_OUTPUT_POLICY, undefined).text).toBe(GOLDEN)
  })

  it('puts the notice on the first line, ahead of the unchanged payload', () => {
    const result = assemble(RENDERED, DEFAULT_RECALL_OUTPUT_POLICY, NOTICE)

    expect(NOTICE).toBe(
      '> Semantic search unavailable (429 insufficient_quota); these results come from keyword search only.',
    )
    expect(result.text).toBe(`${NOTICE}\n${GOLDEN}`)
    expectItemsIndexText(result, RENDERED)
  })

  it('counts the notice against the token budget', () => {
    const withoutNotice = assemble(RENDERED, { tokenBudget: estimateTokens(GOLDEN), faint: true })
    const withNotice = assemble(RENDERED, { tokenBudget: estimateTokens(GOLDEN), faint: true }, NOTICE)

    expect(withoutNotice.payload.truncated).toBe(false)
    expect(withNotice.payload.truncated).toBe(true)
    expect(estimateTokens(withNotice.text)).toBeLessThanOrEqual(estimateTokens(GOLDEN))
    expectItemsIndexText(withNotice, RENDERED)
  })

  it('renders nothing when no item is emitted, notice or not', () => {
    expect(assemble(rendered({}), DEFAULT_RECALL_OUTPUT_POLICY, NOTICE).text).toBe('')
  })
})

describe('degradedRecallNotice', () => {
  it('keeps the semantic-only notice when the keyword search ran', () => {
    expect(degradedRecallNotice({ vector: '429 insufficient_quota' })).toBe(
      vectorUnavailableNotice('429 insufficient_quota'),
    )
  })

  it('names both failures when the keyword search failed too', () => {
    expect(degradedRecallNotice({ vector: '429 insufficient_quota', lexical: 'statement timeout' })).toBe(
      '> Semantic and keyword search unavailable (semantic: 429 insufficient_quota; keyword: statement timeout); these results come from a plain text match only.',
    )
  })
})

describe('assemble — emitK', () => {
  it('emits only the first emitK Recalled items and keeps the later sections', () => {
    const result = assemble(RENDERED, { emitK: 2, faint: true })

    expect(result.text).toBe(GOLDEN.replace(`\n${RENDERED.recalled[2]?.text}`, ''))
    expect(result.payload.emittedMemories).toBe(2)
    expect(result.payload.emittedAssociations).toBe(2)
    expect(result.payload.truncated).toBe(false)
    expectItemsIndexText(result, RENDERED)
  })
})

describe('assemble — token budget', () => {
  const small1 = item('r1', 20)
  // Words throughout, so the item cap cuts it near the cap and not back to its tag.
  const huge = { id: 'r2', text: `- [episode] r2 ${'word '.repeat(1000).trim()}` }
  const small3 = item('r3', 20)
  const throughFirst = `${HEADER}\n### Recalled Memories\n\n${small1.text}`

  it('stops a section at its first item that does not fit and tries nothing after it', () => {
    // Room for r3, not for r2: a skip-and-continue assembly would emit r3.
    const budget = estimateTokens(`${throughFirst}\n${small3.text}`) + 20
    const result = assemble(
      rendered({ recalled: [small1, huge, small3] }),
      { tokenBudget: budget, itemMaxTokens: UNCAPPED, faint: true },
    )

    expect(result.text).toBe(throughFirst)
    expect(result.payload.items.map((i) => i.id)).toEqual(['r1'])
    expect(result.payload.truncated).toBe(true)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget)
  })

  it('counts the headers against the budget', () => {
    const exact = estimateTokens(throughFirst)
    const withSecond = assemble(rendered({ recalled: [small1, small3] }), { tokenBudget: exact, faint: true })

    expect(withSecond.text).toBe(throughFirst)
    expect(withSecond.payload.truncated).toBe(true)
  })

  it('emits nothing when the budget does not cover the header', () => {
    const result = assemble(rendered({ recalled: [small1], related: [small3] }), { tokenBudget: 1, faint: true })

    expect(result.text).toBe('')
    expect(result.payload.items).toEqual([])
    expect(result.payload.truncated).toBe(true)
  })

  it('writes no heading for a section below the room floor whose first item does not fit', () => {
    const budget = estimateTokens(throughFirst) + 10
    const result = assemble(
      rendered({ recalled: [small1], related: [huge] }),
      { tokenBudget: budget, itemMaxTokens: UNCAPPED, faint: true },
    )

    expect(result.text).toBe(throughFirst)
    expect(result.text).not.toContain('### Related Memories')
    expect(result.payload.truncated).toBe(true)
  })

  it('is not truncated when everything fits', () => {
    const result = assemble(RENDERED, { tokenBudget: estimateTokens(GOLDEN), faint: true })

    expect(result.text).toBe(GOLDEN)
    expect(result.payload.truncated).toBe(false)
  })

  it('keeps item offsets exact in a cut payload', () => {
    const result = assemble(RENDERED, { tokenBudget: estimateTokens(GOLDEN) - 30, faint: true })

    expect(result.payload.truncated).toBe(true)
    expect(GOLDEN.startsWith(result.text)).toBe(true)
    expectItemsIndexText(result, RENDERED)
  })
})

// A line of exactly `length` chars, so section costs are known in advance.
function line(id: string, length: number): RenderedItem {
  const head = `- [episode] ${id} `
  return { id, text: `${head}${'x'.repeat(Math.max(0, length - head.length))}` }
}

function lines(prefix: string, count: number, length: number): RenderedItem[] {
  return Array.from({ length: count }, (_, i) => line(`${prefix}${i}`, length))
}

/** Chars that the first `count` items of a section add to the text. */
function sectionChars(section: keyof RenderedPayload, source: RenderedPayload, count: number): number {
  const heading = count > 0 ? 1 + PAYLOAD_SECTION_HEADERS[section].length : 0
  return heading + source[section].slice(0, count).reduce((sum, it) => sum + 1 + it.text.length, 0)
}

describe('assemble — Related share', () => {
  const BUDGET = 1000
  const ROOM = BUDGET * 4 - HEADER.length

  it('gives Related at least its share when the Recalled section overflows', () => {
    const source = rendered({ recalled: lines('r', 40, 100), related: lines('a', 40, 100) })

    const result = assemble(source, { tokenBudget: BUDGET, faint: true })

    const relatedRoom = Math.floor(ROOM * DEFAULT_RELATED_SHARE)
    const { emittedMemories: m, emittedAssociations: a } = result.payload
    expect(sectionChars('related', source, a)).toBeLessThanOrEqual(relatedRoom)
    expect(sectionChars('related', source, a + 1)).toBeGreaterThan(relatedRoom)
    expect(sectionChars('recalled', source, m + 1) + sectionChars('related', source, a)).toBeGreaterThan(ROOM)
    expect(a).toBeGreaterThan(0)
    expect(m).toBeGreaterThan(a)
    expect(result.payload.truncated).toBe(true)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(BUDGET)
    expectItemsIndexText(result, source)
  })

  it('honours a custom share', () => {
    const source = rendered({ recalled: lines('r', 40, 100), related: lines('a', 40, 100) })

    const none = assemble(source, { tokenBudget: BUDGET, relatedShare: 0, faint: true })
    const most = assemble(source, { tokenBudget: BUDGET, relatedShare: 0.9, faint: true })

    expect(none.payload.emittedAssociations).toBe(0)
    expect(sectionChars('related', source, most.payload.emittedAssociations + 1)).toBeGreaterThan(Math.floor(ROOM * 0.9))
    expect(most.payload.emittedMemories).toBeGreaterThan(0)
    expect(most.payload.emittedAssociations).toBeGreaterThan(most.payload.emittedMemories)
  })

  it('gives room the Recalled section leaves unused to Related', () => {
    const source = rendered({ recalled: lines('r', 2, 100), related: lines('a', 40, 100) })

    const result = assemble(source, { tokenBudget: BUDGET, faint: true })

    const { emittedMemories: m, emittedAssociations: a } = result.payload
    expect(m).toBe(2)
    expect(sectionChars('related', source, a)).toBeGreaterThan(Math.floor(ROOM * DEFAULT_RELATED_SHARE))
    expect(sectionChars('recalled', source, m) + sectionChars('related', source, a + 1)).toBeGreaterThan(ROOM)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(BUDGET)
  })

  it('gives room Related leaves unused to the Recalled section', () => {
    const source = rendered({ recalled: lines('r', 40, 100), related: lines('a', 1, 100) })

    const result = assemble(source, { tokenBudget: BUDGET, faint: true })

    const { emittedMemories: m, emittedAssociations: a } = result.payload
    expect(a).toBe(1)
    expect(sectionChars('recalled', source, m)).toBeGreaterThan(ROOM - Math.floor(ROOM * DEFAULT_RELATED_SHARE))
    expect(sectionChars('recalled', source, m + 1) + sectionChars('related', source, a)).toBeGreaterThan(ROOM)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(BUDGET)
  })

  it('fills the rest with Domain, Context and Faint in order and stops at the first that does not fit', () => {
    const source = rendered({
      recalled: lines('r', 2, 100),
      related: lines('a', 2, 100),
      domain: [{ text: '- tiny domain' }],
      context: [{ text: `- ${'c'.repeat(3500)}` }, { text: '- tiny context' }],
      faint: [line('f0', 20)],
    })

    const result = assemble(source, { tokenBudget: BUDGET, itemMaxTokens: UNCAPPED, faint: true })

    expect(result.payload.items.map((i) => i.section)).toEqual(['recalled', 'recalled', 'related', 'related', 'domain'])
    expect(result.payload.emittedFaint).toBe(0)
    expect(result.payload.truncated).toBe(true)
  })

  it.each([
    [{ relatedShare: -0.1 }, 'relatedShare'],
    [{ relatedShare: 0.95 }, 'relatedShare'],
    [{ relatedShare: Number.NaN }, 'relatedShare'],
    [{ itemMaxTokens: 0 }, 'itemMaxTokens'],
    [{ itemMaxTokens: 2.5 }, 'itemMaxTokens'],
  ])('rejects %j under a budget', (fields, name) => {
    expect(() => assemble(RENDERED, { tokenBudget: BUDGET, faint: true, ...fields })).toThrow(name)
  })
})

describe('assemble — item cap', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(' ')

  it('cuts a long first item at a word boundary so the text stays within the budget', () => {
    const long = { id: 'r1', text: `- [episode] ${words(20_000)}` }
    const source = rendered({ recalled: [long, line('r2', 80)], related: [line('a1', 80)] })

    const result = assemble(source, { tokenBudget: 2000, faint: true })

    const first = result.payload.items[0]!
    const cut = result.text.slice(first.start, first.end)
    expect(long.text.length).toBeGreaterThan(100_000)
    expect(cut.endsWith(ITEM_CUT_MARKER)).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(500 * 4)
    const kept = cut.slice(0, -ITEM_CUT_MARKER.length)
    expect(long.text.startsWith(kept)).toBe(true)
    expect(long.text[kept.length]).toBe(' ')
    expect(first.id).toBe('r1')
    expect(result.payload.emittedAssociations).toBe(1)
    expect(result.payload.truncated).toBe(true)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(2000)
  })

  it('keeps exact offsets for every cut item and uses an explicit cap', () => {
    const source = rendered({
      recalled: [{ id: 'r1', text: `- [episode] ${words(400)}` }, { id: 'r2', text: `- [episode] ${words(400)}` }],
      related: [{ id: 'a1', text: `- [semantic] ${words(400)}` }],
    })

    const result = assemble(source, { tokenBudget: 4000, itemMaxTokens: 100, faint: true })

    expect(result.payload.items.map((i) => i.id)).toEqual(['r1', 'r2', 'a1'])
    for (const it of result.payload.items) {
      const original = source[it.section].find((r) => r.id === it.id)!.text
      const emitted = result.text.slice(it.start, it.end)
      expect(emitted).toBe(capItemText(original, 100))
      expect(emitted.length).toBeLessThanOrEqual(400)
      expect(emitted.endsWith(ITEM_CUT_MARKER)).toBe(true)
    }
    expect(result.payload.truncated).toBe(true)
  })

  it('cuts text with no word boundary hard and never inside a surrogate pair', () => {
    expect(capItemText(`- [episode] ${'x'.repeat(200)}`, 20)).toBe(`- [episode] ${'x'.repeat(66)}${ITEM_CUT_MARKER}`)
    const emoji = capItemText(`- [episode] ${'\u{1F600}'.repeat(100)}`, 20)!
    expect(emoji.length).toBeLessThanOrEqual(80)
    expect(emoji.slice(0, -ITEM_CUT_MARKER.length)).toBe(`- [episode] ${'\u{1F600}'.repeat(33)}`)
  })

  it('leaves an item that fits untouched', () => {
    expect(capItemText('- [episode] short', 100)).toBe('- [episode] short')
  })
})

describe('capItemChars — a cut item shows content', () => {
  const TAG = '- [episode · user · 2026-10-01] '
  const contentAfterTag = (emitted: string) => emitted.slice(TAG.length, -ITEM_CUT_MARKER.length)

  it('finds the content after a memory tag and after the bullet of an untagged line', () => {
    expect(itemContentStart(`${TAG}body`)).toBe(TAG.length)
    expect(itemContentStart('- Speakers: Ana, Bo')).toBe(2)
    expect(itemContentStart('plain text')).toBe(0)
  })

  it.each([256, 1000, 4000])('keeps at least 40 content chars of an unbroken 2,000-char run at budget %i', (budget) => {
    const run = (unit: string) => `${TAG}${unit.repeat(500)}`
    const source = rendered({
      recalled: [{ id: 'r1', text: run('a1B2') }, item('r2', 80)],
      related: [{ id: 'a1', text: run('Zq9=') }],
    })

    const result = assemble(source, { tokenBudget: budget, faint: true })

    expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget)
    expect(result.payload.emittedMemories).toBeGreaterThanOrEqual(1)
    expect(result.payload.emittedAssociations).toBeGreaterThanOrEqual(1)
    for (const it of result.payload.items.filter((i) => i.id === 'r1' || i.id === 'a1')) {
      const original = source[it.section][0]!.text
      const emitted = result.text.slice(it.start, it.end)
      if (emitted === original) continue
      expect(contentAfterTag(emitted).length).toBeGreaterThanOrEqual(MIN_CUT_CONTENT_CHARS)
      expect(original.startsWith(emitted.slice(0, -ITEM_CUT_MARKER.length))).toBe(true)
    }
  })

  // Room 200 chars after the marker: the boundary search may back up to char 160.
  const MAX_CHARS = 200 + ITEM_CUT_MARKER.length
  const lowestBoundary = 200 - Math.floor(200 * CUT_BOUNDARY_WINDOW)

  it('cuts at a word boundary inside the search window', () => {
    const text = `${TAG}${'a'.repeat(lowestBoundary - TAG.length)} ${'b'.repeat(300)}`

    expect(text[lowestBoundary]).toBe(' ')
    expect(capItemChars(text, MAX_CHARS)).toBe(`${text.slice(0, lowestBoundary)}${ITEM_CUT_MARKER}`)
  })

  it('cuts hard at the room when the only boundary is just outside the window', () => {
    const text = `${TAG}${'a'.repeat(lowestBoundary - 1 - TAG.length)} ${'b'.repeat(300)}`

    expect(text[lowestBoundary - 1]).toBe(' ')
    expect(capItemChars(text, MAX_CHARS)).toBe(`${text.slice(0, 200)}${ITEM_CUT_MARKER}`)
  })

  it('does not split an emoji at the cut', () => {
    const text = `${TAG}${'\u{1F600}'.repeat(200)}`

    const cut = capItemChars(text, 101 + ITEM_CUT_MARKER.length)!

    expect(cut).toBe(`${TAG}${'\u{1F600}'.repeat(34)}${ITEM_CUT_MARKER}`)
    expect(cut.length).toBeLessThanOrEqual(101 + ITEM_CUT_MARKER.length)
  })

  it('never lands on the space inside the tag', () => {
    const text = `${TAG}${'{"k":"v"}'.repeat(300)}`

    const cut = capItemChars(text, 300)!

    expect(contentAfterTag(cut).length).toBeGreaterThanOrEqual(MIN_CUT_CONTENT_CHARS)
    expect(cut).toBe(`${text.slice(0, 298)}${ITEM_CUT_MARKER}`)
  })

  it('refuses a cut whose room cannot hold the tag and the minimum content', () => {
    const text = `${TAG}${'x'.repeat(500)}`

    expect(capItemChars(text, TAG.length + MIN_CUT_CONTENT_CHARS + ITEM_CUT_MARKER.length - 1)).toBeUndefined()
    expect(capItemChars(text, TAG.length + MIN_CUT_CONTENT_CHARS + ITEM_CUT_MARKER.length))
      .toBe(`${TAG}${'x'.repeat(MIN_CUT_CONTENT_CHARS)}${ITEM_CUT_MARKER}`)
    expect(capItemChars(`${TAG}short content that does not fit`, 50)).toBeUndefined()
  })

  it('leaves out an item no cut can show content for, and ends its section there', () => {
    const source = rendered({ recalled: [{ id: 'r1', text: `${TAG}${'x'.repeat(5000)}` }, item('r2', 10)] })

    const result = assemble(source, { tokenBudget: 1000, itemMaxTokens: 15, faint: true })

    expect(result.text).toBe('')
    expect(result.payload.emittedMemories).toBe(0)
    expect(result.payload.truncated).toBe(true)
  })
})

type BudgetPolicy = RecallOutputPolicy & { tokenBudget: number }

/** The item cap assembly applies: the policy's cap or a quarter of the
 *  budget, never more than the budget. */
function effectiveCap(policy: BudgetPolicy): number {
  return Math.min(policy.itemMaxTokens ?? Math.max(1, Math.floor(policy.tokenBudget / 4)), policy.tokenBudget)
}

/** An emitted item is whole, or a cut that keeps at least
 *  `MIN_CUT_CONTENT_CHARS` content chars after its tag (all of a shorter
 *  content): never the tag alone. */
function expectShowsContent(emitted: string, original: string): void {
  if (emitted === original) return
  const start = itemContentStart(original)
  const kept = emitted.slice(0, -ITEM_CUT_MARKER.length)
  expect(original.startsWith(kept)).toBe(true)
  expect(kept.length - start).toBeGreaterThanOrEqual(Math.min(original.length - start, MIN_CUT_CONTENT_CHARS))
}

/**
 * Every emitted item is the prefix of its section's ranking it claims to be
 * and `text.slice(start, end)` is exactly the emitted line. Items after the
 * first are cut to the item cap; the first Recalled or Related item may be
 * cut shorter, to its section's room, always at a boundary followed by the
 * marker and never past the cap.
 */
function expectExactCappedPrefixes(
  result: AssembledPayload,
  source: RenderedPayload,
  policy: BudgetPolicy,
): { position: Record<keyof RenderedPayload, number>; cut: boolean } {
  const cap = effectiveCap(policy)
  const position = { recalled: 0, related: 0, domain: 0, context: 0, faint: 0 }
  let cut = false
  for (const it of result.payload.items) {
    const index = position[it.section]++
    const original = source[it.section][index]!
    const emitted = result.text.slice(it.start, it.end)
    expect(it.id).toBe(original.id)
    if (index === 0 && (it.section === 'recalled' || it.section === 'related')) {
      expect(emitted.length).toBeLessThanOrEqual(cap * 4)
      if (emitted !== original.text) {
        expect(emitted.endsWith(ITEM_CUT_MARKER)).toBe(true)
        expect(original.text.startsWith(emitted.slice(0, -ITEM_CUT_MARKER.length))).toBe(true)
      }
    } else {
      expect(emitted).toBe(capItemText(original.text, cap))
    }
    expectShowsContent(emitted, original.text)
    cut ||= emitted !== original.text
  }
  return { position, cut }
}

// Deterministic PRNG so a failing case reproduces from its index.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('assemble — randomized budget invariants', () => {
  const rand = mulberry32(0x5eed)
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const SECTIONS = ['recalled', 'related', 'domain', 'context', 'faint'] as const

  function randomText(length: number): string {
    let text = '- [episode] '
    while (text.length < length) text += rand() < 0.15 ? ' ' : String.fromCharCode(97 + int(0, 25))
    return text.slice(0, length)
  }

  const cases = Array.from({ length: 200 }, (_, n) => {
    const source = rendered(Object.fromEntries(SECTIONS.map((section) => [
      section,
      Array.from({ length: int(0, 8) }, (_, i) => ({
        ...(section === 'domain' || section === 'context' ? {} : { id: `${section}-${i}` }),
        text: randomText(n === 0 && section === 'recalled' && i === 0 ? 100_000 : int(14, 3000)),
      })),
    ])))
    if (n === 0 && source.recalled.length === 0) (source.recalled as RenderedItem[]).push({ id: 'big', text: randomText(100_000) })
    const policy = {
      tokenBudget: int(1, 12_000),
      faint: rand() < 0.7,
      ...(rand() < 0.3 ? { emitK: int(1, 6) } : {}),
      ...(rand() < 0.5 ? { relatedShare: Math.round(rand() * 90) / 100 } : {}),
      ...(rand() < 0.3 ? { itemMaxTokens: int(1, 4000) } : {}),
    }
    const notice = rand() < 0.2 ? vectorUnavailableNotice('timeout') : undefined
    return [n, source, policy, notice] as const
  })

  it.each(cases)('case %i never exceeds the budget and emits exact capped prefixes', (_n, source, policy, notice) => {
    const result = assemble(source, policy, notice)

    expect(estimateTokens(result.text)).toBeLessThanOrEqual(policy.tokenBudget)
    const { position, cut } = expectExactCappedPrefixes(result, source, policy)
    const candidates = {
      ...position,
      recalled: Math.min(source.recalled.length, policy.emitK ?? Number.POSITIVE_INFINITY),
      related: source.related.length,
      domain: source.domain.length,
      context: source.context.length,
      faint: policy.faint ? source.faint.length : 0,
    }
    const leftOut = SECTIONS.some((s) => position[s] < candidates[s])
    expect(result.payload.truncated).toBe(leftOut || cut)
    expect(result.payload.emittedMemories).toBe(position.recalled)
    expect(result.payload.emittedAssociations).toBe(position.related)
    expect(result.payload.emittedFaint).toBe(position.faint)
    expect(result.text === '').toBe(result.payload.items.length === 0)
  })

  it('exercises cut items, partial payloads and the 100k-char first item', () => {
    const results = cases.map(([, source, policy, notice]) => assemble(source, policy, notice))
    const firstOfCaseZero = results[0]!.payload.items[0]!

    expect(results.filter((r) => r.payload.items.length > 0).length).toBeGreaterThan(150)
    expect(results.filter((r) => r.payload.truncated && r.payload.items.length > 0).length).toBeGreaterThan(50)
    expect(cases[0]![1].recalled[0]!.text.length).toBe(100_000)
    expect(results[0]!.text.slice(firstOfCaseZero.start, firstOfCaseZero.end).endsWith(ITEM_CUT_MARKER)).toBe(true)
  })
})

describe('assemble — first item of each budgeted section', () => {
  const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i % 89}`).join(' ')
  const longItems = (prefix: string, count: number, length: number): RenderedItem[] =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, text: `- [episode] ${words(length, prefix)}`.slice(0, length) }))

  it.each([256, 512, 700, 1000])('shows Recalled and Related at a per-call budget of %i with the default share', (budget) => {
    const source = rendered({ recalled: longItems('r', 10, 3000), related: longItems('a', 10, 3000) })
    const policy = resolveRecallOutputPolicy({}, budget) as BudgetPolicy

    const result = assemble(source, policy)

    expect(result.payload.emittedMemories).toBeGreaterThanOrEqual(1)
    expect(result.payload.emittedAssociations).toBeGreaterThanOrEqual(1)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget)
    expect(result.payload.truncated).toBe(true)
    expectExactCappedPrefixes(result, source, policy)
  })

  it('clamps an env item cap to a smaller per-call budget and still shows a memory', () => {
    const env = { ENGRAM_RECALL_TOKEN_BUDGET: '4000', ENGRAM_RECALL_ITEM_MAX_TOKENS: '1000' }
    const source = rendered({ recalled: longItems('r', 6, 6000), related: longItems('a', 6, 6000) })
    const policy = resolveRecallOutputPolicy(env, 1000) as BudgetPolicy

    const result = assemble(source, policy)

    expect(policy.itemMaxTokens).toBe(1000)
    expect(result.payload.emittedMemories).toBeGreaterThanOrEqual(1)
    expect(result.payload.emittedAssociations).toBeGreaterThanOrEqual(1)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(1000)
    expectExactCappedPrefixes(result, source, policy)
  })

  it('never cuts an item past the budget when the policy cap is larger than it', () => {
    const source = rendered({ recalled: [{ id: 'r0', text: `- [episode] ${words(4000, 'r')}` }] })
    const policy: BudgetPolicy = { tokenBudget: 300, itemMaxTokens: 5000, faint: true }

    const result = assemble(source, policy)

    expect(result.payload.emittedMemories).toBe(1)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(300)
    expectExactCappedPrefixes(result, source, policy)
  })

  it.each([0.8, 0.9])('keeps a Recalled memory beside the associations at share %s', (relatedShare) => {
    const source = rendered({ recalled: longItems('r', 10, 3000), related: longItems('a', 10, 3000) })
    const policy: BudgetPolicy = { tokenBudget: 1000, relatedShare, faint: true }

    const result = assemble(source, policy)

    expect(result.payload.emittedMemories).toBeGreaterThanOrEqual(1)
    expect(result.payload.emittedAssociations).toBeGreaterThanOrEqual(1)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(1000)
    expectExactCappedPrefixes(result, source, policy)
  })

  it('cuts a long first Related item to its room behind a short Recalled section', () => {
    const budget = 1000
    const longRelated = { id: 'a0', text: `- [semantic] ${words(5000, 'a')}` }
    const source = rendered({ recalled: lines('r', 2, 80), related: [longRelated, line('a1', 80)] })
    const policy: BudgetPolicy = { tokenBudget: budget, itemMaxTokens: budget, faint: true }

    const result = assemble(source, policy)

    const relatedRoom = Math.floor((budget * 4 - HEADER.length) * DEFAULT_RELATED_SHARE)
    const first = result.payload.items.find((i) => i.section === 'related')!
    const emitted = result.text.slice(first.start, first.end)
    expect(result.payload.emittedMemories).toBe(2)
    expect(first.id).toBe('a0')
    expect(emitted.endsWith(ITEM_CUT_MARKER)).toBe(true)
    expect(emitted.length).toBeLessThanOrEqual(relatedRoom - PAYLOAD_SECTION_HEADERS.related.length - 2)
    expect(emitted.length).toBeGreaterThan(relatedRoom - PAYLOAD_SECTION_HEADERS.related.length - 2 - 20)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget)
    expectExactCappedPrefixes(result, source, policy)
  })

  it('gives a section below the room floor nothing in the first pass and its room to the other', () => {
    // Room ≈ 4·180 − header: Related's 30% falls under the floor.
    const policy: BudgetPolicy = { tokenBudget: 180, faint: true }
    const room = policy.tokenBudget * 4 - HEADER.length
    const source = rendered({ recalled: longItems('r', 4, 3000), related: longItems('a', 4, 3000) })

    const result = assemble(source, policy)

    expect(Math.floor(room * DEFAULT_RELATED_SHARE)).toBeLessThan(MIN_SECTION_ROOM_CHARS)
    expect(result.payload.emittedMemories).toBeGreaterThanOrEqual(1)
    expect(result.payload.emittedAssociations).toBe(0)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(policy.tokenBudget)
  })

  describe('randomized', () => {
    const rand = mulberry32(0xf1257)
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
    const SECTIONS = ['recalled', 'related', 'domain', 'context', 'faint'] as const
    const RUN_TAG = '- [episode · user · 2026-10-01] '

    /** Words, or (three times in ten) a tagged unbroken run like minified
     *  JSON, base64 or a hash, where the only space is inside the tag. */
    function randomText(length: number): string {
      if (rand() < 0.3) {
        let run = RUN_TAG
        while (run.length < Math.max(length, RUN_TAG.length + 1)) run += String.fromCharCode(48 + int(0, 74))
        return run
      }
      let text = '- [episode] '
      while (text.length < length) text += rand() < 0.15 ? ' ' : String.fromCharCode(97 + int(0, 25))
      return text.slice(0, length)
    }

    /** Whether the first item of a section with `sectionRoom` pass-1 chars
     *  can be shown: whole, or cut to its room with its tag and minimum
     *  content. */
    function firstItemShowable(section: 'recalled' | 'related', text: string, sectionRoom: number, cap: number): boolean {
      const limit = Math.min(cap * 4, sectionRoom - PAYLOAD_SECTION_HEADERS[section].length - 2)
      if (text.length <= limit) return true
      const start = itemContentStart(text)
      return limit - ITEM_CUT_MARKER.length >= start + Math.min(text.length - start, MIN_CUT_CONTENT_CHARS)
    }

    const cases = Array.from({ length: 300 }, (_, n) => {
      const source = rendered(Object.fromEntries(SECTIONS.map((section) => [
        section,
        Array.from({ length: int(0, 10) }, (_, i) => ({
          ...(section === 'domain' || section === 'context' ? {} : { id: `${section}-${i}` }),
          text: randomText(int(14, 6000)),
        })),
      ])))
      const tokenBudget = int(256, 8000)
      const policy: BudgetPolicy = {
        tokenBudget,
        relatedShare: Math.round(rand() * 90) / 100,
        faint: rand() < 0.7,
        ...(rand() < 0.5 ? { itemMaxTokens: int(1, 2 * tokenBudget) } : {}),
        ...(rand() < 0.2 ? { emitK: int(1, 6) } : {}),
      }
      const notice = rand() < 0.2 ? vectorUnavailableNotice('timeout') : undefined
      return [n, source, policy, notice] as const
    })

    it.each(cases)('case %i fits the budget and shows the first memory of every section with room', (_n, source, policy, notice) => {
      const result = assemble(source, policy, notice)

      expect(estimateTokens(result.text)).toBeLessThanOrEqual(policy.tokenBudget)
      expectExactCappedPrefixes(result, source, policy)
      const header = (notice !== undefined ? [notice, ...PAYLOAD_HEADER_LINES] : PAYLOAD_HEADER_LINES).join('\n')
      const room = policy.tokenBudget * 4 - header.length
      const hasRecalled = source.recalled.length > 0
      const hasRelated = source.related.length > 0
      const relatedRoom = hasRecalled ? Math.floor(room * policy.relatedShare!) : room
      const recalledRoom = hasRelated ? room - Math.floor(room * policy.relatedShare!) : room
      const cap = effectiveCap(policy)
      if (hasRecalled && recalledRoom >= MIN_SECTION_ROOM_CHARS &&
        firstItemShowable('recalled', source.recalled[0]!.text, recalledRoom, cap)) {
        expect(result.payload.emittedMemories).toBeGreaterThanOrEqual(1)
      }
      if (hasRelated && relatedRoom >= MIN_SECTION_ROOM_CHARS &&
        firstItemShowable('related', source.related[0]!.text, relatedRoom, cap)) {
        expect(result.payload.emittedAssociations).toBeGreaterThanOrEqual(1)
      }
    })

    it('covers both sections with room, cut first items and caps above the budget', () => {
      const results = cases.map(([, source, policy, notice]) => assemble(source, policy, notice))
      const bothShown = results.filter((r) => r.payload.emittedMemories > 0 && r.payload.emittedAssociations > 0)
      const capAboveBudget = cases.filter(([, , policy]) => (policy.itemMaxTokens ?? 0) > policy.tokenBudget)
      const firstCut = results.filter((r) => r.payload.items.some(
        (it, i, all) => all.findIndex((o) => o.section === it.section) === i &&
          r.text.slice(it.start, it.end).endsWith(ITEM_CUT_MARKER),
      ))

      const runShown = results.filter((r, n) => r.payload.items.some((it) => {
        if (it.id === undefined) return false
        const original = cases[n]![1][it.section].find((o) => o.id === it.id)?.text ?? ''
        return original.startsWith(RUN_TAG) && r.text.slice(it.start, it.end) !== original
      }))

      expect(bothShown.length).toBeGreaterThan(150)
      expect(capAboveBudget.length).toBeGreaterThan(30)
      expect(firstCut.length).toBeGreaterThan(150)
      expect(runShown.length).toBeGreaterThan(50)
    })
  })
})

describe('assemble — faint switch', () => {
  it('drops the Faint Associations section when faint is off', () => {
    const result = assemble(RENDERED, { faint: false })

    expect(result.text).toBe(GOLDEN.slice(0, GOLDEN.indexOf('\n\n### Faint Associations')))
    expect(result.payload.emittedFaint).toBe(0)
    expect(result.payload.items.some((i) => i.section === 'faint')).toBe(false)
    expect(result.payload.truncated).toBe(false)
  })
})

describe('recallOutputPolicyFromEnv', () => {
  it('defaults to no limits with faint on', () => {
    expect(recallOutputPolicyFromEnv({})).toEqual({ faint: true })
    expect(recallOutputPolicyFromEnv({ ENGRAM_RECALL_EMIT_K: '', ENGRAM_RECALL_FAINT: '' })).toEqual({ faint: true })
  })

  it('reads all three variables', () => {
    expect(recallOutputPolicyFromEnv({
      ENGRAM_RECALL_EMIT_K: '8',
      ENGRAM_RECALL_TOKEN_BUDGET: '3000',
      ENGRAM_RECALL_FAINT: 'off',
    })).toEqual({ emitK: 8, tokenBudget: 3000, faint: false })
  })

  it.each([
    ['ENGRAM_RECALL_EMIT_K', '0'],
    ['ENGRAM_RECALL_EMIT_K', '-3'],
    ['ENGRAM_RECALL_EMIT_K', '2.5'],
    ['ENGRAM_RECALL_TOKEN_BUDGET', 'lots'],
    ['ENGRAM_RECALL_TOKEN_BUDGET', '1e4'],
    ['ENGRAM_RECALL_TOKEN_BUDGET', '99999999999999999999'],
    ['ENGRAM_RECALL_FAINT', 'false'],
    ['ENGRAM_RECALL_FAINT', 'OFF'],
    ['ENGRAM_RECALL_RELATED_SHARE', 'half'],
    ['ENGRAM_RECALL_RELATED_SHARE', '-0.1'],
    ['ENGRAM_RECALL_RELATED_SHARE', '0.95'],
    ['ENGRAM_RECALL_RELATED_SHARE', '1'],
    ['ENGRAM_RECALL_RELATED_SHARE', '3e-1'],
    ['ENGRAM_RECALL_RELATED_SHARE', '.'],
    ['ENGRAM_RECALL_ITEM_MAX_TOKENS', '0'],
    ['ENGRAM_RECALL_ITEM_MAX_TOKENS', '512.5'],
    ['ENGRAM_RECALL_ITEM_MAX_TOKENS', 'big'],
    ['ENGRAM_RECALL_ITEM_MAX_TOKENS', '99999999999999999999'],
  ])('throws naming %s for %j', (name, value) => {
    expect(() => recallOutputPolicyFromEnv({ [name]: value })).toThrow(name)
  })

  it('accepts a token budget at the floor and rejects one below it', () => {
    expect(MIN_RECALL_TOKEN_BUDGET).toBe(Math.ceil((HEADER.length + MIN_SECTION_ROOM_CHARS) / 4))
    expect(recallOutputPolicyFromEnv({ ENGRAM_RECALL_TOKEN_BUDGET: String(MIN_RECALL_TOKEN_BUDGET) }))
      .toEqual({ tokenBudget: MIN_RECALL_TOKEN_BUDGET, faint: true })
    expect(() => recallOutputPolicyFromEnv({ ENGRAM_RECALL_TOKEN_BUDGET: String(MIN_RECALL_TOKEN_BUDGET - 1) }))
      .toThrow(`ENGRAM_RECALL_TOKEN_BUDGET must be at least ${MIN_RECALL_TOKEN_BUDGET}`)
  })

  it('shows a memory at the floor budget', () => {
    const source = rendered({ recalled: [{ id: 'r1', text: `- [episode] ${'word '.repeat(12)}` }] })

    const result = assemble(source, { tokenBudget: MIN_RECALL_TOKEN_BUDGET, faint: true })

    expect(result.payload.emittedMemories).toBe(1)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(MIN_RECALL_TOKEN_BUDGET)
  })

  it('does not apply the env floor to a per-call budget', () => {
    expect(MIN_RECALL_TOKEN_BUDGET).toBeLessThan(256)
    expect(resolveRecallOutputPolicy({}, 256)).toEqual({ tokenBudget: 256, faint: true })
  })

  it('reads the Related share and the item cap', () => {
    expect(recallOutputPolicyFromEnv({
      ENGRAM_RECALL_TOKEN_BUDGET: '4000',
      ENGRAM_RECALL_RELATED_SHARE: '0.25',
      ENGRAM_RECALL_ITEM_MAX_TOKENS: '800',
    })).toEqual({ tokenBudget: 4000, relatedShare: 0.25, itemMaxTokens: 800, faint: true })
  })

  it.each([
    ['0', 0],
    ['0.9', 0.9],
    ['.5', 0.5],
    [' 0.30 ', 0.3],
  ])('accepts a Related share of %j', (raw, share) => {
    expect(recallOutputPolicyFromEnv({ ENGRAM_RECALL_RELATED_SHARE: raw })).toEqual({ relatedShare: share, faint: true })
  })

  it('rejects an item cap larger than the token budget when both are set', () => {
    expect(() => recallOutputPolicyFromEnv({ ENGRAM_RECALL_TOKEN_BUDGET: '1000', ENGRAM_RECALL_ITEM_MAX_TOKENS: '1001' }))
      .toThrow('ENGRAM_RECALL_ITEM_MAX_TOKENS (1001) must not exceed ENGRAM_RECALL_TOKEN_BUDGET (1000)')
    expect(recallOutputPolicyFromEnv({ ENGRAM_RECALL_TOKEN_BUDGET: '1000', ENGRAM_RECALL_ITEM_MAX_TOKENS: '1000' }))
      .toEqual({ tokenBudget: 1000, itemMaxTokens: 1000, faint: true })
    expect(recallOutputPolicyFromEnv({ ENGRAM_RECALL_ITEM_MAX_TOKENS: '5000' })).toEqual({ itemMaxTokens: 5000, faint: true })
  })

  it('treats an empty share or cap as unset', () => {
    expect(recallOutputPolicyFromEnv({ ENGRAM_RECALL_RELATED_SHARE: ' ', ENGRAM_RECALL_ITEM_MAX_TOKENS: '' })).toEqual({
      faint: true,
    })
  })
})

describe('resolveRecallOutputPolicy', () => {
  it('lets a per-call token budget beat the env budget', () => {
    const env = { ENGRAM_RECALL_TOKEN_BUDGET: '5000', ENGRAM_RECALL_EMIT_K: '4' }

    expect(resolveRecallOutputPolicy(env, 1200)).toEqual({ emitK: 4, tokenBudget: 1200, faint: true })
    expect(resolveRecallOutputPolicy(env)).toEqual({ emitK: 4, tokenBudget: 5000, faint: true })
  })

  it('keeps the env share and item cap when a per-call budget overrides the env budget', () => {
    const env = { ENGRAM_RECALL_TOKEN_BUDGET: '5000', ENGRAM_RECALL_RELATED_SHARE: '0.4', ENGRAM_RECALL_ITEM_MAX_TOKENS: '600' }

    expect(resolveRecallOutputPolicy(env, 1200)).toEqual({
      tokenBudget: 1200,
      relatedShare: 0.4,
      itemMaxTokens: 600,
      faint: true,
    })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects a per-call budget of %s', (budget) => {
    expect(() => resolveRecallOutputPolicy({}, budget)).toThrow('tokenBudget')
  })
})
