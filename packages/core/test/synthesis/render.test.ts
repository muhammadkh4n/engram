import { describe, it, expect } from 'vitest'
import {
  BLOCK_HEADER, renderTemporalBlock, renderAggregationBlock,
  renderConstraintSection, renderTemporalGrounding, renderEvidenceIndex,
} from '../../src/synthesis/render.js'
import type { SelectedEvidence } from '../../src/synthesis/select-evidence.js'
import type { PreferenceHit } from '../../src/synthesis/preference.js'
import type { RetrievedMemory, SessionGroup } from '../../src/types.js'
import { parseEventDate } from '../../src/utils/event-date.js'

function mem(id: string, content: string, sessionId: string, occurredAt?: string): RetrievedMemory {
  return {
    id, type: 'episode', content, relevance: 0.5, source: 'recall',
    metadata: occurredAt ? { occurredAt } : {}, sessionId,
  }
}
function sel(m: RetrievedMemory, instance = 'inst', dateText: string | null = null): SelectedEvidence {
  return { memory: m, instance, dateText }
}
const NOW = parseEventDate('2023/06/07 (Wed) 10:00')!
/** Neutral-phrasing pin: degradation-tier output must never imply sufficiency. */
const SUFFICIENCY_RE = /\b(sufficient|the answer|answer is|confirms|proves)\b/i

describe('renderTemporalBlock', () => {
  const a = mem('m1', 'visited the MoMA with my cousin on a rainy afternoon', 'S3', '2023-05-14')
  const b = mem('m2', 'went to the Ancient Civilizations exhibit at the Met', 'S9', '2023-06-04')

  it('anchors each item to its ISO date and computes now-relative + inter-item deltas in code', () => {
    const r = renderTemporalBlock([sel(a), sel(b)], NOW)!
    expect(r.method).toBe('date-arithmetic')
    expect(r.llmSelectionUsed).toBe(true)
    expect(r.text).toContain('2023-05-14')
    expect(r.text).toContain('S3')
    expect(r.text).toContain('24 days (3 weeks, 3 days) before the question date') // 05-14 → 06-07
    expect(r.text).toContain('Question anchor date: 2023-06-07')
    expect(r.text).toContain('Elapsed from (1) to (2): 21 days (3 weeks)')          // 05-14 → 06-04
    expect(r.items.length).toBeGreaterThan(0)
    expect(r.items[0]!.citations[0]).toEqual({ memoryId: 'm1', sessionId: 'S3', date: '2023-05-14' })
  })
  it('renders dateText as a verbatim quote, never resolved', () => {
    const r = renderTemporalBlock([sel(a, 'inst', 'last Sunday')], NOW)!
    expect(r.text).toContain('mentions "last Sunday"')
  })
  it('omits now-relative lines without a now anchor; returns null when nothing is dated', () => {
    const undatedOnly = renderTemporalBlock([sel(mem('mx', 'no date here', 'S1'))], NOW)
    expect(undatedOnly).toBeNull()
    const noNow = renderTemporalBlock([sel(a)], null)!
    expect(noNow.text).not.toContain('Question anchor date')
    expect(noNow.text).not.toContain('before the question date')
  })
})

describe('renderAggregationBlock', () => {
  it('counts distinct labeled instances in code and states the basis', () => {
    const r = renderAggregationBlock([
      sel(mem('m1', 'went to a concert downtown', 'S3', '2023-01-10'), 'concert downtown'),
      sel(mem('m2', 'that concert downtown was great', 'S4', '2023-01-11'), 'Concert Downtown'),
      sel(mem('m3', 'attended a jazz festival', 'S5', '2023-02-02'), 'jazz festival'),
    ])!
    expect(r.method).toBe('count-enumerate')
    expect(r.text).toContain('Distinct instances found: 2')
    expect(r.text).toContain('(1) concert downtown (S3, 2023-01-10)')
    expect(r.text).toContain('Count basis: 2 distinct instances across 3 sessions, from 3 selected evidence lines.')
    expect(r.items[0]!.value).toBe('2')
  })
  it('returns null on empty selection', () => {
    expect(renderAggregationBlock([])).toBeNull()
  })
})

describe('renderConstraintSection', () => {
  it('renders the apply-imperative with session/date citation and verbatim quote', () => {
    const hit: PreferenceHit = {
      memoryId: 'm9', sessionId: 'S5', date: parseEventDate('2023-03-01'),
      content: "I'm vegetarian so no meat dishes please",
    }
    const r = renderConstraintSection([hit])
    expect(r.method).toBe('constraint-surface')
    expect(r.text).toContain('[constraint] Stated user preference (S5, 2023-03-01):')
    expect(r.text).toContain('"I\'m vegetarian so no meat dishes please"')
    expect(r.text).toContain('Apply this stated preference when answering — do not merely mention it.')
  })

  it('quote truncation must be codepoint-safe (no unpaired surrogates on emoji boundary)', () => {
    // Build exactly 78 ASCII chars + emoji to make length 80 (emoji is 2 UTF-16 units)
    // The original quote() function slices at QUOTE_MAX - 1 = 79, which splits the emoji's surrogate pair
    // The fixed version uses codepoint-safe truncation
    const ascii78 = 'a'.repeat(78)
    const contentWithEmoji = `${ascii78}😀 more text after emoji`
    const hit: PreferenceHit = {
      memoryId: 'm10', sessionId: 'S5', date: null,
      content: contentWithEmoji,
    }
    const r = renderConstraintSection([hit])
    const output = r.text

    // Assert no unpaired surrogates in the rendered output containing the quote
    const unpairedSurrogateRegex = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    expect(unpairedSurrogateRegex.test(output)).toBe(false)

    // Assert the quote is still under the 80-codepoint cap (with ellipsis)
    // Use Array.from to count codepoints, not UTF-16 units
    const quoteMatch = output.match(/"([^"]+)"/)?.[1]
    expect(quoteMatch).toBeDefined()
    expect(Array.from(quoteMatch!).length).toBeLessThanOrEqual(80)
  })
})

const SESSIONS: SessionGroup[] = [
  { sessionId: 'S9', score: 0.05, memoryIds: ['m2', 'm3'], earliest: '2023-06-04', latest: '2023-06-04' },
  { sessionId: 'S3', score: 0.03, memoryIds: ['m1'], earliest: '2023-05-14', latest: '2023-05-14' },
]

describe('degradation tier (A2/A3) — deterministic, neutral', () => {
  it('temporal grounding: chronological session lines with now-deltas and counts', () => {
    const r = renderTemporalGrounding(SESSIONS, NOW)!
    expect(r.method).toBe('temporal-grounding')
    expect(r.llmSelectionUsed).toBe(false)
    expect(r.text).toContain('Session S3: 2023-05-14')
    expect(r.text).toContain('24 days (3 weeks, 3 days) before the question date')
    expect(r.text).toMatch(/S3.*S9/s) // chronological: S3 (May) before S9 (June)
    expect(SUFFICIENCY_RE.test(r.text)).toBe(false)
  })
  it('evidence index: neutral session/memory counting scaffold', () => {
    const r = renderEvidenceIndex(SESSIONS)!
    expect(r.method).toBe('evidence-index')
    expect(r.text).toContain('Evidence index: 2 distinct sessions matched, spanning 2023-05-14 → 2023-06-04.')
    expect(r.text).toContain('(1) S3 (2023-05-14) — 1 matched memor')
    expect(SUFFICIENCY_RE.test(r.text)).toBe(false)
  })
  it('both return null when no session carries a usable shape', () => {
    expect(renderTemporalGrounding([], NOW)).toBeNull()
    expect(renderEvidenceIndex([])).toBeNull()
  })
})

describe('header', () => {
  it('is the single shared block header', () => {
    expect(BLOCK_HEADER).toBe('### Derived from memory (computed deterministically — verify against the memories above)')
  })
})
