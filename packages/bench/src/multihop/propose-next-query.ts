import type { BenchScoredMemory } from '../merge-associations.js'
import type { IterativeRecallDeps } from '../retrieval/iterative.js'

/**
 * The A4 agentic step: an LLM looks at the multi-hop question plus the
 * evidence gathered so far and either names the next single-hop retrieval
 * query (typically the bridge entity surfaced by round 1) or stops.
 *
 * Deliberately dumb-agent-shaped: one cheap chat call, top evidence snippets
 * only, no tool use, temperature 0. The gate measures the retrieval walk, not
 * agent cleverness — a fancier prompt would just blur what changed between
 * `--vector-mode full` and `engine`.
 */

const SYSTEM_PROMPT = `You are the retrieval planner inside a question-answering agent.
You are given a multi-hop QUESTION and the EVIDENCE snippets retrieved so far.
Decide the single next search query that would surface the missing evidence
(usually: resolve the bridge entity the question hinges on, then query for it).
Reply with JSON: {"next_query": "<query>"} to search again, or
{"next_query": null} when the evidence already covers every hop of the question.`

const MAX_SNIPPETS = 8
const SNIPPET_CHARS = 400

export interface ProposeNextQueryOpts {
  apiKey: string
  /** Chat model for the planning step. Default gpt-4o-mini. */
  model?: string
}

export function makeLlmProposeNextQuery(
  opts: ProposeNextQueryOpts,
): IterativeRecallDeps['proposeNextQuery'] {
  const model = opts.model ?? 'gpt-4o-mini'

  return async (question, retrievedSoFar) => {
    const user = [
      `QUESTION: ${question}`,
      '',
      'EVIDENCE:',
      ...formatSnippets(retrievedSoFar),
    ].join('\n')

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) {
      // A failed planning call ends the walk (falls back to what round 1
      // found) instead of killing a multi-hour sweep. The trace records the
      // short walk, so affected items are visible in the output.
      console.error(`[multihop] proposeNextQuery ${model} HTTP ${res.status}: ${await res.text()}`)
      return null
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = body.choices?.[0]?.message?.content
    if (!content) return null
    try {
      const parsed = JSON.parse(content) as { next_query?: unknown }
      return typeof parsed.next_query === 'string' && parsed.next_query.trim()
        ? parsed.next_query.trim()
        : null
    } catch {
      return null
    }
  }
}

function formatSnippets(memories: readonly BenchScoredMemory[]): string[] {
  return [...memories]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_SNIPPETS)
    .map((m, i) => `[${i + 1}] ${m.content.slice(0, SNIPPET_CHARS)}`)
}
