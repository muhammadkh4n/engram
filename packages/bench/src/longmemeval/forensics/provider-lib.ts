/**
 * Provider-configurable LLM endpoints for the LongMemEval instrument.
 *
 * Any OpenAI-compatible API works: an endpoint is {model, baseUrl, apiKeyEnv,
 * extraBody, priceIn, priceOut}. API keys are referenced by ENV VAR NAME, so
 * specs are safe to log and to record in result metadata. `extraBody` is
 * spread into the request body after the defaults, letting vendor-specific
 * knobs (thinking budgets, provider pinning, a larger max_tokens for
 * reasoning models whose thinking bills as completion tokens) pass through
 * without this file naming any vendor.
 */

export interface EndpointSpec {
  model: string
  /** OpenAI-compatible API root; absent = the OpenAI default. */
  baseUrl?: string
  /** NAME of the env var holding the key (never the key itself). */
  apiKeyEnv?: string
  /** Spread into the request body after defaults — vendor passthrough. */
  extraBody?: Record<string, unknown>
  /** USD per 1M tokens; absent = caller's fallback pricing (or 0 + warn). */
  priceIn?: number
  priceOut?: number
}

export const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'

/** Accepts a bare model name, or a JSON object spec. */
export function parseEndpointSpec(raw: string): EndpointSpec {
  const s = raw.trim()
  if (s.length === 0) throw new Error('endpoint spec is empty')
  if (!s.startsWith('{')) return { model: s }
  const parsed = JSON.parse(s) as Record<string, unknown>
  if (typeof parsed['model'] !== 'string' || parsed['model'].length === 0) {
    throw new Error('endpoint spec JSON requires a non-empty "model"')
  }
  const spec: EndpointSpec = { model: parsed['model'] }
  if (typeof parsed['baseUrl'] === 'string') spec.baseUrl = parsed['baseUrl']
  if (typeof parsed['apiKeyEnv'] === 'string') spec.apiKeyEnv = parsed['apiKeyEnv']
  if (parsed['extraBody'] !== undefined) {
    if (typeof parsed['extraBody'] !== 'object' || parsed['extraBody'] === null || Array.isArray(parsed['extraBody'])) {
      throw new Error('endpoint spec "extraBody" must be a JSON object')
    }
    spec.extraBody = parsed['extraBody'] as Record<string, unknown>
  }
  if (typeof parsed['priceIn'] === 'number') spec.priceIn = parsed['priceIn']
  if (typeof parsed['priceOut'] === 'number') spec.priceOut = parsed['priceOut']
  return spec
}

/** Accepts a JSON array (of specs or model names) or a comma list of models. */
export function parsePanelSpec(raw: string): EndpointSpec[] {
  const s = raw.trim()
  if (s.startsWith('[')) {
    const arr = JSON.parse(s) as unknown[]
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error('judge panel must be a non-empty JSON array')
    }
    return arr.map((e) => {
      if (typeof e === 'string') return parseEndpointSpec(e)
      return parseEndpointSpec(JSON.stringify(e))
    })
  }
  const models = s.split(',').map((m) => m.trim()).filter((m) => m.length > 0)
  if (models.length === 0) throw new Error('judge panel spec is empty')
  return models.map((m) => ({ model: m }))
}

/**
 * Final answer text: message content minus inline <think> blocks. A separate
 * reasoning_content field is never part of the answer — the instrument
 * grades answers, not reasoning traces.
 */
export function normalizeAnswerText(content: string | null | undefined): string {
  return (content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

export type Verdict = 'correct' | 'partial' | 'incorrect'

export interface JudgeVote {
  model: string
  verdict: Verdict
  reasoning: string
}

const STRICTNESS_ORDER: readonly Verdict[] = ['incorrect', 'partial', 'correct']

/**
 * Plurality winner with a conservative tie-break: tied counts resolve to the
 * STRICTEST tied verdict, so a split panel can never manufacture credit
 * (e.g. a correct/partial/incorrect three-way split grades incorrect).
 */
export function majorityVerdict(votes: readonly Verdict[]): Verdict {
  if (votes.length === 0) throw new Error('majorityVerdict needs at least one vote')
  const counts = new Map<Verdict, number>()
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1)
  const max = Math.max(...counts.values())
  for (const v of STRICTNESS_ORDER) {
    if ((counts.get(v) ?? 0) === max) return v
  }
  return 'incorrect'
}

/** gpt-4o-mini and gpt-4o pricing per 1M tokens, May 2026 — the fallback
 *  for legacy model names; every other endpoint carries its own pricing. */
export const LEGACY_PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.150, out: 0.600 },
  'gpt-4o':      { in: 2.500, out: 10.000 },
}

export const MAX_ATTEMPTS = 3

/** Retry transient endpoint failures with linear backoff; rethrow after the
 *  last attempt so a dead endpoint fails the run loudly. */
export async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err
      console.warn(`  retry ${attempt} (${label}): ${err instanceof Error ? err.message : String(err)}`)
      await new Promise((res) => setTimeout(res, attempt * 2000))
    }
  }
}

/**
 * Defaults merged with extraBody, where an extraBody value of null DELETES
 * the key — some APIs reject default params instead of ignoring them (e.g.
 * reasoning-tier models that require max_completion_tokens and refuse
 * max_tokens / non-default temperature).
 */
export function buildRequestBody(
  defaults: Record<string, unknown>,
  extraBody: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...defaults, ...(extraBody ?? {}) }
  for (const [k, v] of Object.entries(body)) {
    if (v === null) delete body[k]
  }
  return body
}

/** Order-preserving concurrent map; at most `limit` calls in flight. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}

export function endpointCostUsd(
  spec: EndpointSpec,
  tokensIn: number,
  tokensOut: number,
  fallbackPerM?: { in: number; out: number },
): number {
  const priceIn = spec.priceIn ?? fallbackPerM?.in ?? 0
  const priceOut = spec.priceOut ?? fallbackPerM?.out ?? 0
  return (tokensIn * priceIn + tokensOut * priceOut) / 1_000_000
}
