/**
 * Shared judge invocation + verdict aggregation for judge.ts and rejudge.ts.
 * The judge prompt is part of the measurement instrument: a rejudged cell is
 * only comparable to a judged cell because both import this exact prompt.
 */
import OpenAI from 'openai'
import {
  withRetry, buildRequestBody, normalizeAnswerText, majorityVerdict, endpointCostUsd,
  type EndpointSpec, type JudgeVote, type Verdict,
} from './provider-lib.js'

export interface JudgeCallResult {
  verdict: Verdict
  reasoning: string
  tokensIn: number
  tokensOut: number
}

export async function judgeAnswer(
  openai: OpenAI,
  spec: EndpointSpec,
  question: string,
  goldAnswer: string,
  generated: string,
): Promise<JudgeCallResult> {
  // Conservative judge prompt: only "correct" when the generated answer
  // matches the gold answer semantically. "partial" when it gets some
  // facts right but misses others. "incorrect" otherwise.
  const system =
    'You are grading a question-answering system\'s output. ' +
    'Compare the generated answer to the gold answer for factual correctness. ' +
    'Output JSON {"verdict": "correct"|"incorrect"|"partial", "reasoning": "<1 sentence>"}. ' +
    '"correct" = matches the gold answer semantically (paraphrases are fine). ' +
    '"partial" = some facts right, others missing or wrong. ' +
    '"incorrect" = wrong or unsupported claim or "I don\'t know" when an answer exists.'
  const user =
    `Question: ${question}\n` +
    `Gold answer: ${goldAnswer}\n` +
    `Generated answer: ${generated}\n\n` +
    `Output JSON verdict:`

  const resp = await withRetry(`judge ${spec.model}`, () => openai.chat.completions.create(buildRequestBody({
    model: spec.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 150,
    temperature: 0,
    response_format: { type: 'json_object' },
  }, spec.extraBody) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming))

  let verdict: Verdict = 'incorrect'
  let reasoning = '(parse error)'
  try {
    const parsed = JSON.parse(normalizeAnswerText(resp.choices[0]?.message?.content) || '{}') as {
      verdict?: string
      reasoning?: string
    }
    if (parsed.verdict === 'correct' || parsed.verdict === 'partial' || parsed.verdict === 'incorrect') {
      verdict = parsed.verdict
    }
    if (typeof parsed.reasoning === 'string') reasoning = parsed.reasoning
  } catch {
    // leave defaults
  }

  return {
    verdict,
    reasoning,
    tokensIn: resp.usage?.prompt_tokens ?? 0,
    tokensOut: resp.usage?.completion_tokens ?? 0,
  }
}

export interface PanelResult {
  verdict: Verdict
  votes: JudgeVote[]
  tokensIn: number
  tokensOut: number
  costUsd: number
}

/** Every panel member votes; plurality with the strictest tie-break decides. */
export async function runJudgePanel(
  clientFor: (spec: EndpointSpec) => OpenAI,
  panel: readonly EndpointSpec[],
  question: string,
  goldAnswer: string,
  generated: string,
  fallbackPricing: (model: string) => { in: number; out: number } | undefined,
): Promise<PanelResult> {
  const votes: JudgeVote[] = []
  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0
  for (const spec of panel) {
    const vote = await judgeAnswer(clientFor(spec), spec, question, goldAnswer, generated)
    votes.push({ model: spec.model, verdict: vote.verdict, reasoning: vote.reasoning })
    tokensIn += vote.tokensIn
    tokensOut += vote.tokensOut
    costUsd += endpointCostUsd(spec, vote.tokensIn, vote.tokensOut, fallbackPricing(spec.model))
  }
  return { verdict: majorityVerdict(votes.map((v) => v.verdict)), votes, tokensIn, tokensOut, costUsd }
}

export interface VerdictAccuracy {
  correct: number
  partial: number
  total: number
  accuracy: number
  accuracy_lenient: number
}

export interface TypeAccuracy {
  correct: number
  partial: number
  total: number
  accuracy: number
}

export function aggregateVerdicts(
  rows: ReadonlyArray<{ question_type: string; judge_verdict: Verdict }>,
): { accuracy: VerdictAccuracy; by_question_type: Record<string, TypeAccuracy> } {
  const total = rows.length
  const correct = rows.filter((r) => r.judge_verdict === 'correct').length
  const partial = rows.filter((r) => r.judge_verdict === 'partial').length
  const by: Record<string, TypeAccuracy> = {}
  for (const r of rows) {
    const b = (by[r.question_type] ??= { correct: 0, partial: 0, total: 0, accuracy: 0 })
    b.total++
    if (r.judge_verdict === 'correct') b.correct++
    if (r.judge_verdict === 'partial') b.partial++
  }
  for (const t of Object.values(by)) t.accuracy = t.total > 0 ? t.correct / t.total : 0
  return {
    accuracy: {
      correct, partial, total,
      accuracy: total > 0 ? correct / total : 0,
      accuracy_lenient: total > 0 ? (correct + partial) / total : 0,
    },
    by_question_type: by,
  }
}
