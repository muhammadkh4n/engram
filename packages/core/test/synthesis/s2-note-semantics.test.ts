import { describe, it, expect } from 'vitest'
import {
  BLOCK_HEADER, renderTemporalBlock, renderAggregationBlock, renderTemporalGrounding,
} from '../../src/synthesis/render.js'
import type { SelectedEvidence } from '../../src/synthesis/select-evidence.js'
import type { RetrievedMemory, SessionGroup } from '../../src/types.js'
import { parseEventDate } from '../../src/utils/event-date.js'

/**
 * Note-semantics regression suite. Each case reconstructs a judged regression
 * from the committed Gate S artifacts (results/longmemeval/judge-synthesis-
 * cell2-2026-07.json, LongMemEval question ids in test names) at the render
 * layer: the note asserted a session date as if it were an event date, kept
 * zero-information "0 days" clauses, rendered durations at the wrong
 * granularity, or stated counts authoritatively enough to override correct
 * in-context enumeration.
 */

function mem(id: string, content: string, sessionId: string, occurredAt?: string): RetrievedMemory {
  return {
    id, type: 'episode', content, relevance: 0.5, source: 'recall',
    metadata: occurredAt ? { occurredAt } : {}, sessionId,
  }
}
function sel(m: RetrievedMemory, instance = 'inst', dateText: string | null = null): SelectedEvidence {
  return { memory: m, instance, dateText }
}
const SUFFICIENCY_RE = /\b(sufficient|the answer|answer is|confirms|proves)\b/i

describe('T1 — date provenance: session dates are conversation dates, not event dates', () => {
  it('c8090214: undated-content evidence is labeled "conversation dated", never "…, dated D"', () => {
    // Content places the event relative to Black Friday; 2023-12-10 is only the
    // conversation's date. Gate S note said `…, dated 2023-12-10` and the answer
    // adopted it as the attendance date.
    const holidayMarket = mem(
      'm1',
      "I think I'll go back to the Holiday Market and take a closer look at the jewelry vendors.",
      'answer_70dc7d08_1',
      '2023-12-10',
    )
    const r = renderTemporalBlock([sel(holidayMarket)], parseEventDate('2023-12-10')!)!
    expect(r.text).toContain('conversation dated 2023-12-10')
    expect(r.text).not.toMatch(/", dated \d{4}/)
    expect(r.text).not.toContain('event dated')
  })

  it('asserts "event dated" only when dateText parses to the same calendar date (content-evidenced)', () => {
    const booked = mem('m1', '2023-04-16 is when we booked the flight to Lisbon', 'S1', '2023-04-16')
    const r = renderTemporalBlock([sel(booked, 'inst', '2023-04-16')], parseEventDate('2023-05-06')!)!
    expect(r.text).toContain('event dated 2023-04-16')
    expect(r.text).not.toContain('conversation dated')
  })

  it('a parseable dateText that mismatches the resolved date does NOT evidence it', () => {
    const m = mem('m1', '2023-05-10 was the gallery opening', 'S1', '2023-05-14')
    const r = renderTemporalBlock([sel(m, 'inst', '2023-05-10')], parseEventDate('2023-06-07')!)!
    expect(r.text).toContain('conversation dated 2023-05-14')
    expect(r.text).not.toContain('event dated')
  })

  it('a non-parseable dateText (relative phrase) stays a verbatim mention on a conversation-dated line', () => {
    const emma = mem('m1', 'My niece Emma just graduated from high school yesterday', 'answer_cf021b36_1', '2022-05-28')
    const r = renderTemporalBlock([sel(emma, 'emma', 'yesterday')], parseEventDate('2022-08-20')!)!
    expect(r.text).toContain('mentions "yesterday"')
    expect(r.text).toContain('conversation dated 2022-05-28')
  })

  it('gpt4_7ca326fa: ordering over conversation dates is labeled as such, not "Chronological order"', () => {
    // Gate S ordered graduations by session dates and the answer flipped
    // Rachel/Alex. Conversation-date ordering must not present as event order.
    const emma = mem('m1', 'My niece Emma just graduated from high school yesterday', 'answer_cf021b36_1', '2022-05-28')
    const alex = mem('m2', 'gift ideas for my cousin Alex, who graduated with a degree in physics', 'answer_cf021b36_3', '2022-07-15')
    const r = renderTemporalBlock([sel(emma, 'emma', 'yesterday'), sel(alex, 'alex')], parseEventDate('2022-08-20')!)!
    expect(r.text).not.toContain('- Chronological order:')
    expect(r.text).toMatch(/order by conversation date/i)
    expect(r.text).toMatch(/events may be earlier than their conversations/i)
    expect(r.text).toContain('Elapsed between conversations from (1) to (2):')
  })

  it('keeps the plain "Chronological order" label when every date is content-evidenced', () => {
    const a = mem('m1', '2023-05-14 we visited the MoMA', 'S3', '2023-05-14')
    const b = mem('m2', '2023-06-04 we saw the Met exhibit', 'S9', '2023-06-04')
    const r = renderTemporalBlock(
      [sel(a, 'a', '2023-05-14'), sel(b, 'b', '2023-06-04')],
      parseEventDate('2023-06-07')!,
    )!
    expect(r.text).toContain('- Chronological order:')
    expect(r.text).toContain('Elapsed from (1) to (2):')
  })
})

describe('T2 — zero-information "0 days" clauses are dropped', () => {
  it('gpt4_4cd9eba1: same-day evidence carries no "0 days before the question date" clause', () => {
    const m = mem('m1', "Congratulations on your acceptance to UC Berkeley's exchange program!", 'answer_5fcca8bc_1', '2023-04-19')
    const r = renderTemporalBlock([sel(m)], parseEventDate('2023-04-19')!)!
    expect(r.text).not.toContain('0 days')
    expect(r.text).toContain('conversation dated 2023-04-19')
  })

  it('degradation tier: same-day session line drops the zero delta too', () => {
    const sessions: SessionGroup[] = [
      { sessionId: 'S1', score: 0.05, memoryIds: ['m1'], earliest: '2023-04-19', latest: '2023-04-19' },
    ]
    const r = renderTemporalGrounding(sessions, parseEventDate('2023-04-19')!)!
    expect(r.text).not.toContain('0 days')
  })

  it('nonzero deltas are still rendered', () => {
    const m = mem('m1', 'planning the trip', 'S1', '2023-04-16')
    const r = renderTemporalBlock([sel(m)], parseEventDate('2023-05-06')!)!
    expect(r.text).toContain('before the question date')
  })
})

describe('T3 — duration granularity: weeks band rounds to colloquial weeks', () => {
  it("gpt4_e072b769: 20 days renders as ~3 weeks (gold convention), not '2 weeks, 6 days'", () => {
    const m = mem('m1', 'happy to help you plan your grocery trip and maximize your Ibotta earnings', 'answer_c19bd2bf_1', '2023-04-16')
    const r = renderTemporalBlock([sel(m)], parseEventDate('2023-05-06')!)!
    expect(r.text).toContain('20 days (~3 weeks)')
    expect(r.text).not.toContain('2 weeks, 6 days')
  })
})

describe('T4 — counts must not override in-context enumeration', () => {
  const selection = [
    sel(mem('m1', 'appointment for numbness in left hand', 'answer_39900a0a_1', '2023-03-27'), 'orthopedic appointment'),
  ]
  it('00ca467f: single-candidate selection is never an authoritative count', () => {
    const r = renderAggregationBlock(selection)!
    expect(r.text).not.toMatch(/Count basis: \d+ distinct instances across/)
    expect(r.text).toMatch(/candidate/i)
    expect(r.text).toMatch(/may be missing or duplicated/i)
  })
  it('46a3abf7: multi-candidate counts defer to the memories in both directions', () => {
    const r = renderAggregationBlock([
      sel(mem('m1', '1-gallon tank for my friend’s kid', 'S1', '2023-05-21'), 'friend kid tank'),
      sel(mem('m2', '20-gallon community tank', 'S2', '2023-05-23'), 'community tank'),
      sel(mem('m3', 'new tank, amazonia', 'S3', '2023-05-27'), 'amazonia tank'),
    ])!
    expect(r.text).toMatch(/may be missing or duplicated/i)
    expect(r.text).toMatch(/verify the final count against the memories above/i)
    expect(r.text).toContain('(1) friend kid tank')
    expect(r.items[0]!.value).toBe('3')
  })
})

describe('T5 — abstention safety: no sufficiency implication anywhere', () => {
  it('the shared header disclaims completeness/relevance (fe651585_abs)', () => {
    expect(BLOCK_HEADER).toContain('may be incomplete or irrelevant to the question')
  })
  it('temporal and aggregation sections stay free of sufficiency language', () => {
    const t = renderTemporalBlock(
      [sel(mem('m1', 'cousin Alex adopted a baby girl from China in January', 'S1', '2023-03-17'), 'alex', 'January')],
      parseEventDate('2023-03-17')!,
    )!
    const a = renderAggregationBlock([
      sel(mem('m2', 'first thing', 'S1', '2023-01-10'), 'one'),
      sel(mem('m3', 'second thing', 'S2', '2023-02-02'), 'two'),
    ])!
    expect(SUFFICIENCY_RE.test(BLOCK_HEADER)).toBe(false)
    expect(SUFFICIENCY_RE.test(t.text)).toBe(false)
    expect(SUFFICIENCY_RE.test(a.text)).toBe(false)
  })
})
