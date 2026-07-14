import { describe, it, expect, vi } from 'vitest'
import type OpenAI from 'openai'
import { judgeAnswer, runJudgePanel, aggregateVerdicts } from '../src/longmemeval/forensics/judge-call.js'
import { buildRequestBody, mapPool, type EndpointSpec, type Verdict } from '../src/longmemeval/forensics/provider-lib.js'

function clientReturning(contents: string[]): OpenAI {
  let call = 0
  return {
    chat: { completions: { create: vi.fn().mockImplementation(() => Promise.resolve({
      choices: [{ message: { content: contents[Math.min(call++, contents.length - 1)] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })) } },
  } as unknown as OpenAI
}

describe('judgeAnswer', () => {
  it('parses a JSON verdict and strips think blocks before parsing', async () => {
    const client = clientReturning(['<think>hmm</think>{"verdict": "partial", "reasoning": "some facts right"}'])
    const r = await judgeAnswer(client, { model: 'm' }, 'q', 'gold', 'gen')
    expect(r.verdict).toBe('partial')
    expect(r.reasoning).toBe('some facts right')
    expect(r.tokensIn).toBe(100)
  })
  it('grades incorrect on malformed output instead of throwing', async () => {
    const r = await judgeAnswer(clientReturning(['not json at all']), { model: 'm' }, 'q', 'gold', 'gen')
    expect(r.verdict).toBe('incorrect')
    expect(r.reasoning).toBe('(parse error)')
  })
})

describe('runJudgePanel', () => {
  it('collects one vote per member and applies the strict-tie-break majority', async () => {
    const answers = new Map<string, string>([
      ['a', '{"verdict": "correct", "reasoning": "ok"}'],
      ['b', '{"verdict": "incorrect", "reasoning": "no"}'],
      ['c', '{"verdict": "partial", "reasoning": "half"}'],
    ])
    const clientFor = (spec: EndpointSpec): OpenAI => clientReturning([answers.get(spec.model)!])
    const panel: EndpointSpec[] = [{ model: 'a' }, { model: 'b' }, { model: 'c' }]
    const r = await runJudgePanel(clientFor, panel, 'q', 'gold', 'gen', () => undefined)
    expect(r.votes.map((v) => `${v.model}:${v.verdict}`)).toEqual(['a:correct', 'b:incorrect', 'c:partial'])
    expect(r.verdict).toBe('incorrect') // three-way split grades strictest
    expect(r.tokensIn).toBe(300)
  })
})

describe('aggregateVerdicts', () => {
  it('computes strict/lenient accuracy and per-type buckets', () => {
    const rows = [
      { question_type: 't', judge_verdict: 'correct' as Verdict },
      { question_type: 't', judge_verdict: 'partial' as Verdict },
      { question_type: 'u', judge_verdict: 'incorrect' as Verdict },
    ]
    const { accuracy, by_question_type } = aggregateVerdicts(rows)
    expect(accuracy).toEqual({ correct: 1, partial: 1, total: 3, accuracy: 1 / 3, accuracy_lenient: 2 / 3 })
    expect(by_question_type['t']).toEqual({ correct: 1, partial: 1, total: 2, accuracy: 0.5 })
  })
})

describe('buildRequestBody', () => {
  it('merges extraBody after defaults and deletes null-valued keys', () => {
    const body = buildRequestBody(
      { model: 'm', max_tokens: 250, temperature: 0 },
      { max_tokens: null, max_completion_tokens: 4000, temperature: null },
    )
    expect(body).toEqual({ model: 'm', max_completion_tokens: 4000 })
  })
  it('without extraBody returns the defaults untouched', () => {
    expect(buildRequestBody({ a: 1 }, undefined)).toEqual({ a: 1 })
  })
})

describe('withRetry', () => {
  it('rate-limit errors get extended attempts before rethrowing', async () => {
    const { withRetry, RATE_LIMIT_ATTEMPTS } = await import('../src/longmemeval/forensics/provider-lib.js')
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValue(new Error('429 Rate limit reached on tokens per min (TPM)'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = withRetry('x', fn).catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    expect(await p).toBeInstanceOf(Error)
    expect(fn).toHaveBeenCalledTimes(RATE_LIMIT_ATTEMPTS)
    warn.mockRestore()
    vi.useRealTimers()
  })
  it('non-rate-limit errors keep the short retry budget and can recover', async () => {
    const { withRetry, MAX_ATTEMPTS } = await import('../src/longmemeval/forensics/provider-lib.js')
    vi.useFakeTimers()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce('ok')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = withRetry('x', fn)
    await vi.runAllTimersAsync()
    expect(await p).toBe('ok')
    expect(fn.mock.calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS)
    warn.mockRestore()
    vi.useRealTimers()
  })
})

describe('mapPool', () => {
  it('preserves order and bounds concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapPool([10, 20, 30, 40, 50], 2, async (x) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return x * 2
    })
    expect(out).toEqual([20, 40, 60, 80, 100])
    expect(peak).toBeLessThanOrEqual(2)
  })
})
