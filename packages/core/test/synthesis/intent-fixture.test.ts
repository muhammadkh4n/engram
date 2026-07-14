/**
 * $0 pre-validation of the synthesis intent router against all 500 REAL
 * LongMemEval questions (from the committed judged baseline). Targets are
 * PRE-REGISTERED: these floors/ceilings were fixed from a dry-run measurement before any judged run; if an assertion
 * fails after a regex change, repair the router — do not move the target
 * without an explicit maintainer decision. Judged benchmark runs are blocked on this file
 * passing.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyComputeIntent, isPreferenceRequest } from '../../src/synthesis/intent.js'

const FIXTURE = fileURLToPath(
  new URL('../../../../results/longmemeval/judge-full-500-2026-07.json', import.meta.url),
)

interface Row { question_id: string; question_type: string; question: string }

const available = fs.existsSync(FIXTURE)

describe.skipIf(!available)('intent router — 500-question labeled fixture', () => {
  const rows: Row[] = available
    ? (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { rows: Row[] }).rows
    : []

  function rate(type: string, pred: (q: Row) => boolean): number {
    const bucket = rows.filter((r) => r.question_type === type)
    return bucket.filter(pred).length / Math.max(1, bucket.length)
  }
  const firesCompute = (r: Row) => classifyComputeIntent(r.question) !== 'none'
  const firesTemporal = (r: Row) => classifyComputeIntent(r.question) === 'temporal'
  const firesPref = (r: Row) => isPreferenceRequest(r.question)

  it('loads exactly 500 questions', () => {
    expect(rows).toHaveLength(500)
  })

  it('temporal fire rate on temporal-reasoning ≥ 0.85 (pre-registered)', () => {
    expect(rate('temporal-reasoning', firesTemporal)).toBeGreaterThanOrEqual(0.85)
  })
  it('any compute intent on multi-session ≥ 0.70 (pre-registered)', () => {
    expect(rate('multi-session', firesCompute)).toBeGreaterThanOrEqual(0.70)
  })
  it('preference fire rate on single-session-preference ≥ 0.80 (pre-registered)', () => {
    expect(rate('single-session-preference', firesPref)).toBeGreaterThanOrEqual(0.80)
  })
  it('preference fires ≤ 0.02 on every non-preference type (pre-registered)', () => {
    for (const t of ['temporal-reasoning', 'multi-session', 'knowledge-update', 'single-session-user', 'single-session-assistant']) {
      expect(rate(t, firesPref), t).toBeLessThanOrEqual(0.02)
    }
  })
  it('compute-intent spillover ceilings (pre-registered)', () => {
    expect(rate('single-session-user', firesCompute)).toBeLessThanOrEqual(0.45)
    expect(rate('single-session-assistant', firesCompute)).toBeLessThanOrEqual(0.25)
    expect(rate('knowledge-update', firesCompute)).toBeLessThanOrEqual(0.75)
  })

  it('reports (not asserts) the abstention-subset firings for hand review', () => {
    const abs = rows.filter((r) => r.question_id.endsWith('_abs'))
    const fired = abs.filter((r) => firesCompute(r) || firesPref(r))
    console.log(`[intent-fixture] abstention subset: ${fired.length}/${abs.length} fire`)
    for (const r of fired) console.log(`  [abs-fire] ${classifyComputeIntent(r.question)} ${r.question.slice(0, 100)}`)
    expect(abs.length).toBeGreaterThan(0)
  })
})
