import { describe, it, expect } from 'vitest'
import { renderRecallPayload } from '../../src/retrieval/engine.js'
import {
  assemble,
  recallOutputPolicyFromEnv,
  resolveRecallOutputPolicy,
  vectorUnavailableNotice,
  DEFAULT_RECALL_OUTPUT_POLICY,
  PAYLOAD_HEADER_LINES,
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
  const source = rendered({ recalled: [small1, huge, small3], related: [item('a1', 20)] })
  const throughFirst = `${HEADER}\n### Recalled Memories\n\n${small1.text}`

  it('stops at the first item that does not fit and tries nothing after it', () => {
    // Room for r3 and the related item, not for r2: a skip-and-continue
    // assembly would emit r3.
    const budget = estimateTokens(`${throughFirst}\n${small3.text}\n\n### Related Memories\n\n- [episode] a1`) + 20
    const result = assemble(source, { tokenBudget: budget, faint: true })

    expect(result.text).toBe(throughFirst)
    expect(result.payload.items.map((i) => i.id)).toEqual(['r1'])
    expect(result.payload.truncated).toBe(true)
    expect(result.payload.emittedAssociations).toBe(0)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget)
  })

  it('counts the headers against the budget', () => {
    const exact = estimateTokens(throughFirst)
    const withSecond = assemble(rendered({ recalled: [small1, small3] }), { tokenBudget: exact, faint: true })

    expect(withSecond.text).toBe(throughFirst)
    expect(withSecond.payload.truncated).toBe(true)
  })

  it('emits the first Recalled item whole even when it alone exceeds the budget', () => {
    const result = assemble(rendered({ recalled: [huge, small1] }), { tokenBudget: 1, faint: true })

    expect(result.text).toBe(`${HEADER}\n### Recalled Memories\n\n${huge.text}`)
    expect(result.payload.items.map((i) => i.id)).toEqual(['r2'])
    expect(result.payload.truncated).toBe(true)
  })

  it('emits the first item whole when the payload starts at Related', () => {
    const result = assemble(rendered({ related: [huge] }), { tokenBudget: 1, faint: true })

    expect(result.text).toBe(`${HEADER}\n\n### Related Memories\n\n${huge.text}`)
    expect(result.payload.truncated).toBe(false)
  })

  it('writes no heading for a section whose first item does not fit', () => {
    const result = assemble(
      rendered({ recalled: [small1], related: [huge], domain: [{ text: '- tiny' }] }),
      { tokenBudget: estimateTokens(throughFirst) + 10, faint: true },
    )

    expect(result.text).toBe(throughFirst)
    expect(result.text).not.toContain('### Related Memories')
    expect(result.text).not.toContain('### Knowledge Domain Context')
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
  ])('throws naming %s for %j', (name, value) => {
    expect(() => recallOutputPolicyFromEnv({ [name]: value })).toThrow(name)
  })
})

describe('resolveRecallOutputPolicy', () => {
  it('lets a per-call token budget beat the env budget', () => {
    const env = { ENGRAM_RECALL_TOKEN_BUDGET: '5000', ENGRAM_RECALL_EMIT_K: '4' }

    expect(resolveRecallOutputPolicy(env, 1200)).toEqual({ emitK: 4, tokenBudget: 1200, faint: true })
    expect(resolveRecallOutputPolicy(env)).toEqual({ emitK: 4, tokenBudget: 5000, faint: true })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects a per-call budget of %s', (budget) => {
    expect(() => resolveRecallOutputPolicy({}, budget)).toThrow('tokenBudget')
  })
})
