/**
 * Instrument pin. The baseline gen prompt (no synthesis) must be BYTE-
 * IDENTICAL to the template judge.ts has always used — this is what makes
 * the baseline cell a valid pairing partner for the archived judged
 * baseline, and Cell 1 vs Cell 2 an exact within-sweep pairing. If this test
 * ever needs its LEGACY string edited, the instrument changed: stop; paired
 * benchmark cells are only comparable while the baseline prompt is frozen — an edit here invalidates every archived judged run.
 */
import { describe, it, expect } from 'vitest'
import { buildGenUserPrompt } from '../src/longmemeval/forensics/gen-prompt.js'

const DATE = '2023/05/30 (Tue) 23:40'
const CTX = '=== Session answer_1 (2023/05/20 (Sat) 02:21) ===\nuser: hello\nassistant: hi'
const Q = 'How many days passed between my museum visits?'

const LEGACY =
  `Today's date is ${DATE}.\n\n` +
  `## Relevant past sessions\n${CTX}\n\n` +
  `## Question\n${Q}\n\n## Answer`

describe('buildGenUserPrompt', () => {
  it('is byte-identical to the legacy template when synthesisText is absent', () => {
    expect(buildGenUserPrompt(DATE, CTX, Q)).toBe(LEGACY)
  })
  it('is byte-identical when synthesisText is undefined or empty', () => {
    expect(buildGenUserPrompt(DATE, CTX, Q, undefined)).toBe(LEGACY)
    expect(buildGenUserPrompt(DATE, CTX, Q, '')).toBe(LEGACY)
  })
  it('inserts exactly one delimited section between sessions and question when present', () => {
    const withBlock = buildGenUserPrompt(DATE, CTX, Q, '### Derived from memory …\n- line')
    expect(withBlock).toContain(
      '## Derived notes from memory\n(computed deterministically from the sessions above — verify against them)\n### Derived from memory …\n- line\n\n## Question',
    )
    expect(withBlock.startsWith(`Today's date is ${DATE}.\n\n## Relevant past sessions\n${CTX}\n\n`)).toBe(true)
    expect(withBlock.endsWith(`## Question\n${Q}\n\n## Answer`)).toBe(true)
  })
})
