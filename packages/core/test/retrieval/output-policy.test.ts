import { describe, it, expect } from 'vitest'
import { renderRecallPayload } from '../../src/retrieval/engine.js'
import {
  assemble,
  degradedRecallNotice,
  recallOutputPolicyFromEnv,
  resolveRecallOutputPolicy,
  vectorUnavailableNotice,
  capItemText,
  DEFAULT_RECALL_OUTPUT_POLICY,
  DEFAULT_RELATED_SHARE,
  ITEM_CUT_MARKER,
  PAYLOAD_HEADER_LINES,
  PAYLOAD_SECTION_HEADERS,
  type AssembledPayload,
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
  const huge = item('r2', 4000)
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

  it('writes no heading for a section whose first item does not fit', () => {
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
      context: [{ text: `- ${'c'.repeat(5000)}` }, { text: '- tiny context' }],
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
    expect(capItemText('x'.repeat(50), 5)).toBe(`${'x'.repeat(18)}${ITEM_CUT_MARKER}`)
    const emoji = capItemText('\u{1F600}'.repeat(50), 5)
    expect(emoji.length).toBeLessThanOrEqual(20)
    expect(emoji.slice(0, -ITEM_CUT_MARKER.length)).toBe('\u{1F600}'.repeat(9))
  })

  it('leaves an item that fits untouched', () => {
    expect(capItemText('- [episode] short', 100)).toBe('- [episode] short')
  })
})

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
    const cap = policy.itemMaxTokens ?? Math.max(1, Math.floor(policy.tokenBudget / 4))
    const position = { recalled: 0, related: 0, domain: 0, context: 0, faint: 0 }
    let cut = false
    for (const it of result.payload.items) {
      const original = source[it.section][position[it.section]++]!
      const capped = capItemText(original.text, cap)
      expect(result.text.slice(it.start, it.end)).toBe(capped)
      expect(it.id).toBe(original.id)
      cut ||= capped !== original.text
    }
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
